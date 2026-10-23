// 도로의종류(ROAD_RANK) 코드.
//
// 코드정의서 v2.6 「03. 도로의종류」에는 1501~1508, 1599 외에 1509 면도 / 1510 리도 / 1511 농도 /
// 1512 도시계획도로가 "신규추가(KRRIS규격외)"로 올라 있다. 방침:
//   - 올리는 파일(DBF)의 코드는 원본 그대로 저장한다(1509~1512도 그대로 — RDID와 시설물 키가 이 코드를 품고 있다).
//   - KRRIS에 내는 파일은 규격에 없는 이 4개 코드를 쓸 수 없으므로, 내려받을 때만 1599(기타)로 바꾼다
//     (normalizeRankForExport / rankInName — ROAD_RANK 값과 "R02" + 코드 꼴의 RDID, 그 RDID가 든 파일명).
const ROAD_RANK_CODES = {
    '고속국도': '1501', '일반국도': '1502', '특별시도': '1503', '광역시도': '1504',
    '지방도': '1505', '시도': '1506', '군도': '1507', '구도': '1508',
    '면도': '1509', '리도': '1510', '농도': '1511', '도시계획도로': '1512',
    '기타': '1599',
};

// 코드 → 이름
const ROAD_RANK_NAME_BY_CODE = Object.fromEntries(
    Object.entries(ROAD_RANK_CODES).map(([name, code]) => [code, name])
);

// 납품 코드가 1599(기타)인 노선을 화면에서 어떤 이름으로 부를지 고를 수 있는 이름들(첫 번째가 기본).
// 이름만 바꾸고 저장 코드는 1599 그대로다 — 1599 노선을 면도 등으로 보고 싶을 때 쓴다.
const RANK_NAMES_FOR_1599 = ['기타', '면도', '리도', '농도', '도시계획도로'];

// KRRIS 규격 밖 코드(내려받을 때 1599로 바꾼다)
const NON_KRRIS_RANK_CODES = ['1509', '1510', '1511', '1512'];

const RANK_IN_ID_RE = /^(R\d{2})(1509|1510|1511|1512)/;

// RDID처럼 "R02" + 도로종류 4자리로 시작하는 문자열(파일명 포함)의 코드를 1599로 바꾼다.
function rankInName(text) {
    return typeof text === 'string' ? text.replace(RANK_IN_ID_RE, (m, head) => head + '1599') : text;
}

// 내려받기용: DBF 행들의 ROAD_RANK 값과 RDID류 값을 1599 기준으로 바꾼다. rows는 건드리지 않고 복사해 돌려준다.
function normalizeRankForExport(rows) {
    return rows.map((row) => {
        let changed = null;
        for (const [k, v] of Object.entries(row)) {
            if (typeof v !== 'string') continue;
            let nv = v;
            if (k === 'road_rank' && NON_KRRIS_RANK_CODES.includes(v)) nv = '1599';
            else nv = rankInName(v);
            if (nv !== v) { if (!changed) changed = { ...row }; changed[k] = nv; }
        }
        return changed || row;
    });
}

module.exports = { ROAD_RANK_CODES, ROAD_RANK_NAME_BY_CODE, RANK_NAMES_FOR_1599, NON_KRRIS_RANK_CODES, normalizeRankForExport, rankInName };
