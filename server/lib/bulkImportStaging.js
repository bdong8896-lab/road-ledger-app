// 일괄등록 업로드 ZIP의 압축 해제/보관/정리. 미리보기(preview)와 확정
// (confirm)이 서로 다른 HTTP 요청이라, 압축 해제한 폴더를 uploadId로 구분해
// 디스크에 남겨두고 두 단계 모두 같은 폴더를 다시 파싱한다(파싱 결과를
// 메모리에 캐싱하지 않음 — 서버 재시작에도 안전하고, 납품 1건 용량이
// 작아서(수백 KB~수 MB) 다시 파싱하는 비용이 무시할 만하다).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const config = require('../config');

const STAGING_ROOT = path.join(config.uploadDir, 'bulk-import');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24시간 지난 staging 폴더는 정리 대상

// 사진/보고서/도면처럼 용량이 큰 파일을 SFTP 등으로 미리 서버에 올려두는
// 곳. 웹 업로드(ZIP)는 DBF/SHP(수 MB)만 담고, 이 폴더 밑에 관리자가 만든
// 하위 폴더(예: 관리번호)에 LAYER/통합, ETC 구조로 미리 올려둔 대용량 파일을
// extractZip 결과에 병합해서 기존 파싱/매칭 로직을 그대로 재사용한다.
const INCOMING_ROOT = path.join(config.uploadDir, 'bulk-import-incoming');
fs.mkdirSync(INCOMING_ROOT, { recursive: true });
// 관리자가 웹 폼에 입력한 폴더명을 그대로 파일시스템 경로에 쓰지 않고,
// 안전한 문자만 허용 + resolve한 경로가 INCOMING_ROOT를 벗어나지 못하게
// 이중으로 검증한다(admin 전용 기능이라도 경로 조작 방지).
const SAFE_INCOMING_NAME_RE = /^[A-Za-z0-9._\- 가-힣]+$/;

function stagingDir(uploadId) {
    if (!UUID_RE.test(uploadId)) throw new Error('잘못된 uploadId입니다.');
    return path.join(STAGING_ROOT, uploadId);
}

// 빈 staging 폴더(extracted/)를 새 uploadId로 만든다. zip 압축해제/폴더
// 업로드 재구성 둘 다 여기서 시작한다.
function createEmptyStaging() {
    fs.mkdirSync(STAGING_ROOT, { recursive: true });
    const uploadId = crypto.randomUUID();
    const extractDir = path.join(stagingDir(uploadId), 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    return { uploadId, extractDir };
}

// zipPath(디스크에 업로드된 zip 파일 경로)를 새 uploadId 폴더에 풀고
// { uploadId, extractDir }를 반환한다. 사진 등이 포함된 실제 납품 폴더를
// 통째로 zip 하면 수백 MB가 될 수 있어, 메모리 버퍼가 아니라 파일 경로를
// 받아 AdmZip이 디스크에서 직접 읽게 한다.
function extractZip(zipPath) {
    const { uploadId, extractDir } = createEmptyStaging();
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);
    return { uploadId, extractDir };
}

// uploadId가 stageFromIncomingDir로 만들어졌으면(zip을 아예 안 거친 경우)
// 그 표시 파일(incoming-source.txt)에 원본 경로가 적혀있다.
function incomingSourceMarker(uploadId) {
    return path.join(stagingDir(uploadId), 'incoming-source.txt');
}

function getExtractDir(uploadId) {
    const extracted = path.join(stagingDir(uploadId), 'extracted');
    if (fs.existsSync(extracted)) return extracted;
    const marker = incomingSourceMarker(uploadId);
    if (fs.existsSync(marker)) {
        const incomingDir = fs.readFileSync(marker, 'utf8').trim();
        // marker 파일 내용이 조작되지 않았어도, INCOMING_ROOT 밖을 가리키면
        // 안전하게 거부한다(방어적 재검증).
        if (path.relative(INCOMING_ROOT, incomingDir).startsWith('..') || !fs.existsSync(incomingDir)) {
            throw new Error('업로드를 찾을 수 없습니다(만료되었거나 취소됨).');
        }
        return incomingDir;
    }
    throw new Error('업로드를 찾을 수 없습니다(만료되었거나 취소됨).');
}

// uploadId가 stageFromIncomingDir로 만들어졌으면 그 원본 bulk-import-incoming
// 폴더 경로를, 아니면(zip 업로드) null을 반환한다 — 확정 성공 후 원본 폴더를
// 자동으로 지울지 판단하는 데 쓴다(cleanup으로 staging marker가 지워지기
// 전에 먼저 호출해야 함).
function getIncomingSourceOfUpload(uploadId) {
    const marker = incomingSourceMarker(uploadId);
    if (!fs.existsSync(marker)) return null;
    const dir = fs.readFileSync(marker, 'utf8').trim();
    return fs.existsSync(dir) ? dir : null;
}

function cleanup(uploadId) {
    fs.rmSync(stagingDir(uploadId), { recursive: true, force: true });
}

// 오래된 staging 폴더 정리(서버가 오래 떠 있을 때 디스크 누수 방지용, 필수는
// 아니지만 관리자가 미리보기 후 확정/취소를 안 누르는 경우를 대비).
function sweepOldStagingDirs() {
    if (!fs.existsSync(STAGING_ROOT)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(STAGING_ROOT)) {
        if (!UUID_RE.test(name)) continue;
        const dir = path.join(STAGING_ROOT, name);
        try {
            const stat = fs.statSync(dir);
            if (now - stat.mtimeMs > MAX_AGE_MS) fs.rmSync(dir, { recursive: true, force: true });
        } catch (e) { /* 이미 지워졌으면 무시 */ }
    }
}

// name(관리자가 입력한 사전 업로드 폴더명)에 해당하는 INCOMING_ROOT 하위
// 폴더가 실제로 존재하면 그 절대경로를, 없으면(또는 name이 비어있으면) null을
// 반환한다.
function resolveIncomingDir(name) {
    if (!name) return null;
    if (!SAFE_INCOMING_NAME_RE.test(name)) throw new Error('폴더명에 사용할 수 없는 문자가 있습니다.');
    const dir = path.join(INCOMING_ROOT, name);
    if (path.relative(INCOMING_ROOT, dir).startsWith('..')) throw new Error('잘못된 폴더명입니다.');
    return fs.existsSync(dir) ? dir : null;
}

// incomingDir 이하 전체를 destDir로 복사(병합)한다. destDir은 방금 zip을 푼
// extractDir이라 보통 LAYER/신규만 있고 LAYER/통합·ETC는 없으므로 이름이
// 겹칠 일이 없다 — 그래도 겹치면 incomingDir 쪽 파일로 덮어쓴다.
function mergeIncomingDir(incomingDir, destDir) {
    for (const entry of fs.readdirSync(incomingDir, { withFileTypes: true })) {
        const src = path.join(incomingDir, entry.name);
        const dest = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
            fs.mkdirSync(dest, { recursive: true });
            mergeIncomingDir(src, dest);
        } else {
            fs.copyFileSync(src, dest);
        }
    }
}

// bulk-import-incoming/<folderName>을 zip 업로드 없이 곧바로 미리보기/확정
// 대상으로 쓴다. 사진·보고서·도면뿐 아니라 LAYER/신규(DBF/SHP)까지 통째로
// SFTP로 미리 올려둔 경우용 — 웹으로는 아무 파일도 안 올리고 폴더명만
// 선택한다. 실제 파일은 복사하지 않고 경로만 marker 파일에 남긴다(대용량
// 복사 비용 회피) — 확정 단계의 첨부 로직은 원본에서 목적지로
// copyFileSync만 하고 원본을 지우지 않으므로 이렇게 참조만 남겨도 안전하다.
function stageFromIncomingDir(folderName) {
    const incomingDir = resolveIncomingDir(folderName);
    if (!incomingDir) {
        throw new Error(`서버(bulk-import-incoming)에서 "${folderName}" 폴더를 찾을 수 없습니다.`);
    }
    fs.mkdirSync(STAGING_ROOT, { recursive: true });
    const uploadId = crypto.randomUUID();
    fs.mkdirSync(stagingDir(uploadId), { recursive: true });
    fs.writeFileSync(incomingSourceMarker(uploadId), incomingDir, 'utf8');
    return { uploadId, extractDir: incomingDir };
}

// bulk-import-incoming 바로 아래의 폴더 목록(관리자가 고를 수 있는 후보).
function listIncomingFolders() {
    fs.mkdirSync(INCOMING_ROOT, { recursive: true });
    return fs.readdirSync(INCOMING_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
            const dir = path.join(INCOMING_ROOT, e.name);
            return { name: e.name, mtimeMs: fs.statSync(dir).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

module.exports = {
    createEmptyStaging, extractZip, getExtractDir, cleanup, sweepOldStagingDirs,
    resolveIncomingDir, mergeIncomingDir, stageFromIncomingDir, listIncomingFolders,
    getIncomingSourceOfUpload, INCOMING_ROOT,
};
