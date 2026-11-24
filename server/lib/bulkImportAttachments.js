// 일괄등록 납품 폴더에서 시설물 사진/보고서(LAYER/통합)와 구간 도면(ETC)을
// 찾아내는 헬퍼. SHP/DBF와 달리 이 파일들은 정해진 포맷이 없어(사진/PDF/DXF
// 등 그냥 파일), 폴더를 재귀로 훑어서 파일 목록만 반환한다 — 실제 매칭(파일명
// ↔ 시설물 RDID)은 호출하는 쪽(bulkImport.js)에서 한다.
//
// zip에 납품(노선) 폴더가 여러 개 있을 수 있어(bulkImportParse.js 참고),
// "LAYER/통합"과 "ETC"가 extractDir 바로 밑에 있다고 가정하지 않고 전체를
// 재귀로 훑어서 그 이름의 폴더를 몇 단계 아래에 있든 전부 찾는다.
const fs = require('fs');
const path = require('path');

function walkFiles(dir) {
    const out = [];
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, name.name);
        if (name.isDirectory()) out.push(...walkFiles(full));
        else out.push(full);
    }
    return out;
}

// dir 이하를 재귀로 훑어서, 이름이 targetName이고 상위 폴더 이름이
// parentName인 디렉터리를 전부 찾는다(예: 어디에 있든 "LAYER/통합").
function findDirsMatching(dir, parentName, targetName) {
    const out = [];
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!name.isDirectory()) continue;
        const full = path.join(dir, name.name);
        if (name.name === targetName && path.basename(dir) === parentName) out.push(full);
        out.push(...findDirsMatching(full, parentName, targetName));
    }
    return out;
}

// LAYER/통합/ 바로 아래에는 신규+기존을 합친 SHP/DBF 전체 세트도 같이 들어있어
// (실제 샘플로 확인함), 통합 폴더 전체를 훑으면 그 SHP/DBF까지 "매칭 실패
// 첨부파일"로 잡혀 검수 화면에 노이즈가 낀다. 사진/보고서는 항상 그 아래
// PHOTO/STR 하위 폴더에 있으므로(두 실제 납품 샘플에서 동일하게 확인) 그
// 하위 폴더만 훑는다. 둘 다 없으면 빈 배열.
function findFacilityAttachments(extractDir) {
    const out = [];
    for (const base of findDirsMatching(extractDir, 'LAYER', '통합')) {
        for (const sub of ['PHOTO', 'STR']) {
            const dir = path.join(base, sub);
            if (fs.existsSync(dir)) out.push(...walkFiles(dir));
        }
    }
    return out.filter((f) => !/^(thumbs\.db|desktop\.ini)$/i.test(path.basename(f)));
}

// extractDir 이하 어디에 있든 ETC 폴더를 전부 찾아 그 밑의 도면(DXF/DWG)만 수집.
// (특정 ETC 폴더 하나만 보고 싶으면 root에 그 폴더의 부모를 넘기면 된다 — 예:
// bulkImport.js가 구간별로 도면을 연결할 때 그 구간의 납품 루트를 넘겨서 씀.)
function findDrawingFiles(root) {
    const out = [];
    const walk = (dir) => {
        for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, name.name);
            if (!name.isDirectory()) continue;
            if (name.name === 'ETC') out.push(...walkFiles(full).filter((f) => /\.(dxf|dwg)$/i.test(f)));
            else walk(full);
        }
    };
    if (fs.existsSync(root)) walk(root);
    return out;
}

// 납품 폴더(관리번호 폴더) 밖/옆에 놓이는 도면 폴더 — 500m 단위 구간도면(500_P/500_Y/500_U)과 구간 전체 도면(CONT).
// 예: 58950/500_P, 58950/CONT, 41590/500_Y. ETC 안의 도면은 findDrawingFiles가 따로 다루므로 ETC/LAYER는 건너뛴다.
// 이 파일들은 어느 노선 것인지 파일명(노선번호+구간번호)으로 알아내야 해서 lib/routeDrawingsBulk.js의 자동 인식으로 붙인다.
const LOOSE_DRAWING_DIR_RE = /^(500_[A-Za-z]|CONT)$/i;
function findLooseDrawingFiles(root) {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const full = path.join(dir, e.name);
            if (/^(ETC|LAYER)$/i.test(e.name)) continue;
            if (LOOSE_DRAWING_DIR_RE.test(e.name)) out.push(...walkFiles(full).filter((f) => /\.(dxf|dwg)$/i.test(f)));
            else walk(full);
        }
    };
    if (fs.existsSync(root)) walk(root);
    return out;
}

// ---- 파일 자체가 온전한지 점검 (0바이트 · 확장자와 내용 불일치 · 중간에 끊긴 파일) ----
// 파일을 통째로 읽지 않고 앞 16바이트와 뒤 일부만 본다 — 수천 장의 사진이 있어도 빠르다.
// 열리지 않는 사진/PDF/도면이 등록된 뒤에야 발견되는 일을 막는 것이 목적이라, 형식별로 "확실히 이상한 경우"만 잡는다.
const SIGNATURES = {
    '.jpg': { magic: [0xff, 0xd8, 0xff], tail: (t) => t.includes(Buffer.from([0xff, 0xd9])), tailBytes: 2048, kind: 'JPEG 이미지', image: true },
    '.jpeg': { magic: [0xff, 0xd8, 0xff], tail: (t) => t.includes(Buffer.from([0xff, 0xd9])), tailBytes: 2048, kind: 'JPEG 이미지', image: true },
    '.png': { magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], tail: (t) => t.includes(Buffer.from('IEND')), tailBytes: 16, kind: 'PNG 이미지', image: true },
    '.gif': { magic: [0x47, 0x49, 0x46, 0x38], tail: (t) => t.includes(0x3b), tailBytes: 4, kind: 'GIF 이미지', image: true },
    '.bmp': { magic: [0x42, 0x4d], kind: 'BMP 이미지', image: true },
    '.pdf': { magic: [0x25, 0x50, 0x44, 0x46], tail: (t) => t.includes(Buffer.from('%%EOF')), tailBytes: 1100, kind: 'PDF 문서' },
    '.dwg': { magic: [0x41, 0x43], kind: 'DWG 도면' }, // "AC10xx"
};
const ATTACHMENT_CHECK_LIMIT = 300; // 목록에 담는 개수 상한(건수 집계는 상한과 무관)

function checkOneFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    let fd;
    try {
        const size = fs.statSync(filePath).size;
        if (size === 0) return '0바이트(빈 파일)';
        const sig = SIGNATURES[ext];
        if (!sig) return null;
        fd = fs.openSync(filePath, 'r');
        const head = Buffer.alloc(Math.min(16, size));
        fs.readSync(fd, head, 0, head.length, 0);
        let real = sig; // 내용으로 본 실제 형식
        if (!sig.magic.every((b, i) => head[i] === b)) {
            // 다른 형식의 파일이 확장자만 바뀐 경우 — 어떤 형식으로 보이는지 찾는다
            const as = Object.values(SIGNATURES).find((s) => s.magic.every((b, i) => head[i] === b));
            // 사진끼리의 확장자 불일치(PNG를 .jpg로 저장 등)는 브라우저·뷰어가 내용을 보고 열기 때문에 문제로 보지 않는다 — 실제 형식으로 끝 부분만 확인한다.
            if (as && as.image && sig.image) real = as;
            else return as ? `확장자는 ${ext}인데 내용은 ${as.kind}입니다` : `${sig.kind}가 아닙니다(파일 내용이 손상됐거나 다른 형식입니다)`;
        }
        if (real.tail) {
            const n = Math.min(real.tailBytes, size);
            const tail = Buffer.alloc(n);
            fs.readSync(fd, tail, 0, n, size - n);
            if (!real.tail(tail)) return `${real.kind} 끝부분이 없습니다(전송·복사 중 잘린 파일일 수 있습니다 — 직접 열어 확인하세요)`;
        }
        return null;
    } catch (e) {
        return `읽을 수 없습니다(${e.code || e.message})`;
    } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* 무시 */ }
    }
}

// files: 경로 배열. 반환: { checked, brokenTotal, broken: [{ name, reason }] }
function checkFileIntegrity(files) {
    const broken = [];
    let brokenTotal = 0;
    for (const f of files) {
        const reason = checkOneFile(f);
        if (!reason) continue;
        brokenTotal++;
        if (broken.length < ATTACHMENT_CHECK_LIMIT) broken.push({ name: path.basename(f), reason });
    }
    return { checked: files.length, brokenTotal, broken };
}

module.exports = { findFacilityAttachments, findDrawingFiles, findLooseDrawingFiles, checkFileIntegrity };
