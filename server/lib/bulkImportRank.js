// 납품 폴더(관리번호 폴더)에서 노선의 도로종류 이름(면도/리도/농도/도시계획도로)을 알아낸다.
// 납품 DBF의 ROAD_RANK는 이 종류들을 모두 1599(기타)로 보내지만, 500m 구간 SHP의 파일명에는
// 종류가 들어 있다 — 예: 415902026101001/면도0101.shp, 415902026201001/리도0201.shp,
// 415902026303001/농도0303.shp (화성 납품). 일괄등록에서 노선마다 올바른 이름을 붙이는 데 쓴다.
const fs = require('fs');

const KIND_SHP_RE = /^(면도|리도|농도|도시계획도로)\d*\.shp$/i;

// deliveryRoot 바로 아래의 .shp 파일명에서 종류를 읽는다. 서로 다른 종류가 섞여 있으면 판단하지 않는다(null).
function detectRankNameInRoot(deliveryRoot) {
    if (!deliveryRoot || !fs.existsSync(deliveryRoot)) return null;
    const names = new Set();
    for (const f of fs.readdirSync(deliveryRoot)) {
        const m = KIND_SHP_RE.exec(f);
        if (m) names.add(m[1]);
    }
    return names.size === 1 ? [...names][0] : null;
}

// 검수 화면용: 납품 폴더별로 알아낸 이름 [{ deliveryCode, name }] (코드가 1599인 노선만).
function detectRankNameHints(sectionRecords) {
    const out = [];
    const seen = new Set();
    for (const rec of sectionRecords || []) {
        if (!rec.row || rec.row.road_rank !== '1599') continue;
        const name = detectRankNameInRoot(rec.deliveryRoot);
        if (!name || seen.has(rec.deliveryCode)) continue;
        seen.add(rec.deliveryCode);
        out.push({ deliveryCode: rec.deliveryCode, name });
    }
    return out;
}

module.exports = { detectRankNameInRoot, detectRankNameHints };
