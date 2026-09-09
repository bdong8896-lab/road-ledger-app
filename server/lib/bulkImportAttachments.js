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

module.exports = { findFacilityAttachments, findDrawingFiles };
