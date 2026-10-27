// 관리기관(MCO) 코드 → 이름 표(managing_agencies.json). 화면 폴더(public)에 같이 들어 있는 데이터 파일이다.
// 운영·포터블 배포는 원본 public 이 아니라 난독화본 public-dist 만 올리므로, 화면 폴더를 하나로 못 박지 않고
// 설정된 SERVE_DIR → public-dist → public 순서로 찾는다. (예전엔 public 만 찾아서 public 이 없는 배포에서는
// 일괄등록 저장이 "no such file or directory"로 통째로 실패했다.)
// 이 표는 이름을 풀어 보여주는 용도뿐이라, 파일을 못 찾아도 저장·조회는 계속 되도록 빈 표로 처리하고 한 번만 로그를 남긴다.
const path = require('path');
const fs = require('fs');
const config = require('../config');

let cache = null;
function loadManagingAgencies() {
    if (cache) return cache;
    const root = path.join(__dirname, '..', '..');
    const dirs = [...new Set([config.serveDir, 'public-dist', 'public'])];
    for (const d of dirs) {
        const p = path.join(root, d, 'data', 'managing_agencies.json');
        if (!fs.existsSync(p)) continue;
        try { cache = JSON.parse(fs.readFileSync(p, 'utf8')); return cache; } catch (e) { console.error('[managingAgencies] 읽기 실패:', p, e.message); }
    }
    console.error(`[managingAgencies] managing_agencies.json 을 찾지 못했습니다(찾은 폴더: ${dirs.join(', ')}) — 관리기관 이름은 비워 둡니다.`);
    cache = [];
    return cache;
}

function getMcoNameByCode(code) {
    const found = loadManagingAgencies().find((a) => a.code === code);
    return found ? found.name : null;
}

module.exports = { loadManagingAgencies, getMcoNameByCode };
