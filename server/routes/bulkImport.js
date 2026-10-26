// 일괄등록(SHP/DBF 표준 데이터 업로드) API. 미리보기(검수) → 확정의 2단계
// 흐름이다: /preview는 zip을 풀어서 파싱 결과만 보여주고 DB는 건드리지
// 않으며, /confirm이 같은 staging 폴더를 다시 파싱해서 실제로 저장한다.
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { requireAdminReauth } = require('../middleware/requireAuth');
const { parseDelivery, krrisDefectRows } = require('../lib/bulkImportParse');
const { runBulkConfirm } = require('../lib/bulkImportConfirm');
const importBatch = require('../lib/importBatch');
const {
    createEmptyStaging, extractZip, getExtractDir, cleanup, sweepOldStagingDirs,
    resolveIncomingDir, mergeIncomingDir, stageFromIncomingDir, listIncomingFolders,
} = require('../lib/bulkImportStaging');
const { findFacilityAttachments, findDrawingFiles, findLooseDrawingFiles } = require('../lib/bulkImportAttachments');
const { detectRankNameHints } = require('../lib/bulkImportRank');
const { parseSectorShpFiles } = require('../lib/bulkImportSectors');

const router = express.Router();
router.use(requireAdminReauth); // 이 기능 전체가 관리자 전용 + 관리 콘솔 재인증 필요(15분)

sweepOldStagingDirs();
setInterval(sweepOldStagingDirs, 60 * 60 * 1000).unref();

const tmpUploadDir = path.join(config.uploadDir, 'bulk-import-tmp');
fs.mkdirSync(tmpUploadDir, { recursive: true });
const upload = multer({
    storage: multer.diskStorage({
        destination: tmpUploadDir,
        filename: (req, file, cb) => cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}.zip`),
    }),
    limits: { fileSize: 500 * 1024 * 1024 }, // 사진 등이 포함된 실제 납품은 수백 MB일 수 있음
});

// "폴더 선택(ZIP 없이)" 업로드용 — 브라우저의 webkitdirectory로 고른 폴더를
// 파일 여러 개로 그대로 올린다(각 파일명에 상대경로가 "관리번호/LAYER/신규/x.dbf"
// 식으로 슬래시 포함해서 들어옴). LAYER/신규(DBF/SHP)만 담는 게 전제라 개별
// 파일은 작지만, 레이어 수만큼 파일 개수는 많을 수 있어 files 제한을 넉넉히 둔다.
const uploadFolder = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024, files: 3000 },
});

function summarizeForPreview(parsed) {
    return {
        deliveryCode: parsed.deliveryCode,
        deliveryCodes: parsed.deliveryCodes,
        dbfMcoCode: parsed.dbfMcoCode,
        unknownLayerCodes: parsed.unknownLayerCodes,
        blockingWarnings: parsed.blockingWarnings,
        layers: parsed.layers.map((l) => ({
            code: l.code, table: l.table, koreanName: l.koreanName,
            newCount: l.newRecords.length, deleteCount: l.deleteRecords.length,
            crs: l.crs, geomType: l.geomType, fieldMatch: l.fieldMatch, warnings: l.warnings,
        })),
        totalNew: parsed.layers.reduce((s, l) => s + l.newRecords.length, 0),
        totalDelete: parsed.layers.reduce((s, l) => s + l.deleteRecords.length, 0),
        krris: parsed.krris,
        // 500m 구간 SHP 파일명(면도0101.shp 등)에서 알아낸 도로종류 이름 — 코드가 1599(기타)인 노선만
        rankNameHints: detectRankNameHints(parsed.sectionRecords),
    };
}

// extractDir이 이미 채워진 뒤(zip 압축해제든, 폴더 업로드 재구성이든, 서버
// incoming 폴더 참조든) 공통으로 하는 일 — 사전 업로드 폴더 병합 + 파싱 +
// 요약. /preview, /preview-folder-upload, /preview-from-folder가 공유한다.
async function buildPreviewPayload(extractDir, incomingFolderName, sessionUser) {
    let mergedLargeFiles = false;
    if (incomingFolderName) {
        const incomingDir = resolveIncomingDir(incomingFolderName);
        if (!incomingDir) {
            throw new Error(`서버(bulk-import-incoming)에서 "${incomingFolderName}" 폴더를 찾을 수 없습니다. SFTP로 먼저 올렸는지 확인하세요.`);
        }
        mergeIncomingDir(incomingDir, extractDir);
        mergedLargeFiles = true;
    }
    const parsed = await parseDelivery(extractDir);
    const largeFileCount = mergedLargeFiles
        ? findFacilityAttachments(extractDir).length + findDrawingFiles(extractDir).length + findLooseDrawingFiles(extractDir).length
        : 0;
    const sectors = parseSectorShpFiles(extractDir);
    return {
        suggestedSigunguCode: sessionUser.sigunguCode || null,
        mergedLargeFiles,
        largeFileCount,
        sectorCount: sectors.records.length,
        sectorWarnings: sectors.warnings,
        ...summarizeForPreview(parsed),
    };
}

router.post('/preview', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'zip 파일이 없습니다.' });
    let uploadId;
    try {
        const extracted = await extractZip(req.file.path);
        uploadId = extracted.uploadId;
        // 사진/보고서/도면처럼 용량이 큰 파일은 SFTP로 미리 서버에 올려둔
        // 폴더(bulk-import-incoming/<incomingFolderName>)가 있으면 병합한다 —
        // 그러면 웹으로 올리는 zip은 DBF/SHP(수 MB)만 담으면 되고, 큰 파일은
        // HTTP 업로드(IIS 용량 제한)를 거치지 않는다. /confirm은 같은
        // extractDir을 다시 파싱하므로 별도 처리가 필요 없다.
        const payload = await buildPreviewPayload(extracted.extractDir, (req.body.incomingFolderName || '').trim(), req.session.user);
        res.json({ uploadId, ...payload });
    } catch (e) {
        console.error('[bulk-import/preview]', e);
        if (uploadId) cleanup(uploadId);
        res.status(400).json({ error: '파일을 처리하는 중 오류가 발생했습니다.' });
    } finally {
        fs.unlink(req.file.path, () => {});
    }
});

// "폴더 선택(ZIP 없이)" 업로드 — 브라우저에서 폴더를 통째로 골라 개별 파일로
// 올리면(각 파일명이 "관리번호/LAYER/신규/x.dbf" 식으로 상대경로 포함) 여기서
// 그 구조를 그대로 재구성한 뒤 /preview와 동일하게 처리한다. zip을 만드는
// 번거로움 없이도 사전 업로드 폴더(incomingFolderName)와 병합할 수 있다.
router.post('/preview-folder-upload', uploadFolder.array('files'), async (req, res) => {
    if (!req.files || !req.files.length) return res.status(400).json({ error: '폴더 안에 파일이 없습니다.' });
    let uploadId;
    try {
        const staged = createEmptyStaging();
        uploadId = staged.uploadId;
        for (const file of req.files) {
            // originalname은 브라우저가 webkitRelativePath를 그대로 파일명으로
            // 보낸 것("관리번호/LAYER/신규/x.dbf") — 맨 앞 폴더명(관리번호 등,
            // 선택한 폴더 자체)은 extractDir이 이미 그 역할이라 제거하고 나머지만
            // 재구성한다. '..' 세그먼트나 빈 경로는 안전을 위해 건너뛴다.
            const parts = String(file.originalname).split('/').filter(Boolean);
            const relParts = parts.length > 1 ? parts.slice(1) : parts;
            if (!relParts.length || relParts.includes('..')) continue;
            const dest = path.join(staged.extractDir, ...relParts);
            if (path.relative(staged.extractDir, dest).startsWith('..')) continue; // 방어적 재검증
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, file.buffer);
        }
        const payload = await buildPreviewPayload(staged.extractDir, (req.body.incomingFolderName || '').trim(), req.session.user);
        res.json({ uploadId, ...payload });
    } catch (e) {
        console.error('[bulk-import/preview-folder-upload]', e);
        if (uploadId) cleanup(uploadId);
        res.status(400).json({ error: '파일을 처리하는 중 오류가 발생했습니다.' });
    }
});

// bulk-import-incoming 밑에 SFTP로 미리 올려둔 폴더 목록 — "서버 폴더에서
// 검수" 모드에서 관리자가 고를 수 있는 후보를 보여주는 용도.
router.get('/incoming', (req, res) => {
    res.json({ folders: listIncomingFolders() });
});

// zip 업로드 없이, bulk-import-incoming/<folderName>을 그대로 미리보기
// 대상으로 쓴다. LAYER/신규(DBF/SHP)까지 포함해 납품 폴더 전체를 SFTP로
// 미리 올려둔 경우용 — /preview(zip 업로드)의 대안 경로다. 이후 /confirm은
// uploadId만 있으면 되므로 이 경로로 만든 uploadId도 그대로 동작한다.
router.post('/preview-from-folder', async (req, res) => {
    const folderName = (req.body.folderName || '').trim();
    if (!folderName) return res.status(400).json({ error: '폴더를 선택하세요.' });
    let uploadId;
    try {
        const staged = await stageFromIncomingDir(folderName);
        uploadId = staged.uploadId;
        const parsed = await parseDelivery(staged.extractDir);
        const largeFileCount = findFacilityAttachments(staged.extractDir).length + findDrawingFiles(staged.extractDir).length
            + findLooseDrawingFiles(staged.extractDir).length;
        const sectors = parseSectorShpFiles(staged.extractDir);
        res.json({
            uploadId,
            suggestedSigunguCode: req.session.user.sigunguCode || null,
            mergedLargeFiles: true,
            largeFileCount,
            sectorCount: sectors.records.length,
            sectorWarnings: sectors.warnings,
            ...summarizeForPreview(parsed),
        });
    } catch (e) {
        console.error('[bulk-import/preview-from-folder]', e);
        if (uploadId) cleanup(uploadId);
        res.status(400).json({ error: '폴더를 처리하는 중 오류가 발생했습니다.' });
    }
});

// KRRIS 사전검사 결함 목록(CSV) — 미리보기와 같은 업로드를 다시 파싱해서 만든다(따로
// 저장해두지 않음). 납품 업체에 그대로 보내 보완을 요청할 수 있는 형식.
function csvCell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 엑셀 수식 실행 방지
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

router.get('/:uploadId/krris-report', async (req, res) => {
    let extractDir;
    try {
        extractDir = getExtractDir(req.params.uploadId);
    } catch (e) {
        return res.status(404).json({ error: '업로드 정보를 찾을 수 없습니다. 다시 검수하세요.' });
    }
    const parsed = await parseDelivery(extractDir);
    const lines = [['검사항목', '레이어코드', '레이어', '대상ID', '파일', '행', '필드', '필드명', '내용'].map(csvCell).join(',')];
    for (const r of krrisDefectRows(parsed)) {
        lines.push([r.check, r.code, r.layer, r.pk, r.file, r.row, r.field, r.label, r.detail].map(csvCell).join(','));
    }
    const code = (parsed.deliveryCodes || []).join('_') || 'delivery';
    const filename = `KRRIS사전검사_${code}_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send('﻿' + lines.join('\r\n') + '\r\n'); // BOM — 한국어 엑셀에서 한글이 안 깨지게
});

// ---- 확정(저장)은 백그라운드 작업이다 ----
// 요청은 바로 202와 jobId를 돌려주고, 화면은 /jobs/:jobId로 진행 상황(노선 n/N)을 조회한다. 노선 수가 많아도 요청이
// 프록시 응답 대기 시간에 걸리지 않고, 노선마다 따로 저장해서 한 노선이 실패해도 나머지는 저장된다(lib/bulkImportConfirm.js).
// 서버를 다시 시작하면 진행 중이던 작업 정보는 사라지고(이미 저장된 노선은 그대로), 같은 납품을 다시 확정하면 이어서 저장된다.
const bulkJobs = new Map(); // jobId -> job
const JOB_KEEP_MS = 60 * 60 * 1000;
function pruneJobs() {
    const now = Date.now();
    for (const [id, j] of bulkJobs) if (j.finishedAt && now - j.finishedAt > JOB_KEEP_MS) bulkJobs.delete(id);
}
function runningJob() {
    // 6시간 넘게 "진행 중"인 작업은 멈춘 것으로 보고 무시한다(서버가 어딘가에서 응답 없는 상태로 잠금이 영원히 남는 것을 막는다).
    for (const j of bulkJobs.values()) if (j.status === 'running' && Date.now() - j.startedAt < 6 * 60 * 60 * 1000) return j;
    return null;
}
function jobView(j) {
    return {
        id: j.id, status: j.status, stage: j.stage, done: j.done, total: j.total, currentRoute: j.currentRoute,
        results: j.results, result: j.status === 'done' ? j.result : undefined,
        error: j.status === 'error' ? j.error : undefined, blockingWarnings: j.blockingWarnings,
    };
}

router.post('/:uploadId/confirm', async (req, res) => {
    const { uploadId } = req.params;
    let targetSigunguCode = (req.body.sigunguCode || '').trim() || null;
    // 관할이 제한된 관리자는 자기 시군구로만 등록할 수 있다(요청 값을 믿지 않는다).
    const userSigungu = req.session.user.sigunguCode;
    if (userSigungu) {
        if (targetSigunguCode && targetSigunguCode !== userSigungu) {
            return res.status(403).json({ error: '관할 시군구 밖으로는 등록할 수 없습니다.' });
        }
        targetSigunguCode = userSigungu;
    }

    let extractDir;
    try {
        extractDir = getExtractDir(uploadId);
    } catch (e) {
        console.error('[bulk-import/confirm/getExtractDir]', e);
        return res.status(404).json({ error: '업로드 정보를 찾을 수 없습니다.' });
    }

    // 한 번에 하나만 — 서버와 DB를 오래 붙잡는 작업이라 겹치면 서로 느려진다.
    pruneJobs();
    const busy = runningJob();
    if (busy) {
        return res.status(409).json({
            error: '다른 일괄등록이 진행 중입니다. 끝난 뒤에 다시 시도하세요.',
            jobId: busy.id, stage: busy.stage, done: busy.done, total: busy.total,
        });
    }

    // 이력(되돌리기용) 시작. 이력 테이블이 아직 없는 서버(schema.sql 재적용 전)에서도 등록은 되도록, 실패하면 이력 없이 진행한다.
    let batchId = null;
    try {
        batchId = await importBatch.createBatch({
            user: req.session.user, sigunguCode: targetSigunguCode, sourceLabel: String(req.body.sourceLabel || '').trim(),
        });
    } catch (e) {
        console.error('[bulk-import] 등록 이력을 시작하지 못했습니다(이력 없이 진행 — schema.sql 재적용 필요):', e.message);
    }

    const job = {
        id: require('crypto').randomUUID(), uploadId, status: 'running', stage: '시작', done: 0, total: 0,
        currentRoute: '', results: [], startedAt: Date.now(), userId: req.session.user.id,
    };
    bulkJobs.set(job.id, job);
    runBulkConfirm(job, {
        uploadId, extractDir, targetSigunguCode, batchId,
        requestedRankName: (req.body.roadRankDisplayName || '').trim(),
        acknowledgeUnrecognizedCrs: !!req.body.acknowledgeUnrecognizedCrs,
        user: req.session.user,
    });
    res.status(202).json({ jobId: job.id, status: job.status });
});

router.get('/jobs/:jobId', (req, res) => {
    const job = bulkJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: '작업 정보를 찾을 수 없습니다(서버가 다시 시작됐거나 오래되어 지워졌습니다).' });
    res.json(jobView(job));
});

router.delete('/:uploadId', (req, res) => {
    // 이 업로드를 저장하는 작업이 진행 중이면 임시 폴더를 지울 수 없다(저장하던 파일이 사라져 작업이 실패한다).
    for (const j of bulkJobs.values()) {
        if (j.status === 'running' && j.uploadId === req.params.uploadId) {
            return res.status(409).json({ error: '이 업로드를 저장하는 중이라 취소할 수 없습니다. 끝난 뒤에 다시 시도하세요.' });
        }
    }
    try {
        cleanup(req.params.uploadId);
    } catch (e) { /* 이미 없어도 무시 */ }
    res.json({ ok: true });
});

router.getRunningJob = runningJob; // 관리 콘솔 현황판이 진행 중인 작업을 보여줄 때 쓴다
module.exports = router;
