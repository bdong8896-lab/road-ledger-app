// 시설물 검색 — 시설물 ID(RDID 일부 포함), "종류 번호"(예: 표지 12, 가로등 3), 시설물 이름/노선명으로 찾는다.
//   · 시설물 ID: R23150758950000800120260001 처럼 전체 또는 일부(6자 이상, 숫자 포함)
//   · 종류 + 번호: RDID 끝 4자리가 일련번호이므로 "표지 12"는 일련번호 0012인 표지를 모두 찾는다(노선/구간이 다르면 여러 건)
//   · 종류만: 그 종류 시설물 목록(상한 있음)
//   · 이름: 교량명·터널명 같은 이름 컬럼, 또는 노선명(종류와 함께 쓸 때)
// 검색 대상은 gov_* 시설물 테이블 전체(차도부경계 제외 — RDID가 없다).
const pool = require('../db');
const { GOV_LAYER_MAP } = require('./govLayerMap');

const PER_TABLE_LIMIT = 30;
const TOTAL_LIMIT = 60;

// 사람이 읽는 "명칭" 컬럼이 있는 테이블(routes/sections.js의 FACILITY_NAME_FIELD와 같은 것)
const NAME_FIELD = {
    gov_bridge: 'brdg_name', gov_tunnel: 'tun_name', gov_overpass: 'op_name', gov_under_road: 'ur_name',
    gov_high_road: 'hr_name', gov_interchange: 'ic_name', gov_under_sidewalk: 'us_name', gov_xrail: 'x_name',
    gov_defence: 'product', gov_impact: 'product', gov_pipe_conduit: 'pip_name',
};

// 테이블 -> 종류 이름들(예: gov_bridge -> ['교량']). "02.교량" 같은 정의서 이름에서 앞 번호를 뗀 것.
const KIND_NAMES = new Map();
for (const l of Object.values(GOV_LAYER_MAP)) {
    if (l.pkColumn !== 'rdid') continue;
    KIND_NAMES.set(l.table, { label: l.koreanName.replace(/^\d+\./, ''), names: new Set([l.koreanName.replace(/^\d+\./, '')]) });
}
// 화면에서 쓰는 짧은 이름(차량방호안전시설 등)도 같이 인식하도록 별칭을 추가한다.
const ALIASES = {
    gov_defence: ['차량방호안전시설', '방호울타리', '가드레일'],
    gov_box_pipe: ['배수암거', '배수관', '암거'],
    gov_cut_slope: ['도로절개면', '절개면'],
    gov_land_fill: ['도로성토면', '성토면'],
    gov_sign: ['표지판', '안전표지'],
    gov_street_light: ['가로등', '보안등'],
    gov_speed_hump: ['과속방지턱', '방지턱'],
    gov_station: ['측점'],
    gov_km_post: ['거리표', '이정표'],
};
for (const [table, list] of Object.entries(ALIASES)) {
    const k = KIND_NAMES.get(table);
    if (k) list.forEach((n) => k.names.add(n));
}

function kindsFor(token) {
    const exact = [];
    const partial = [];
    for (const [table, k] of KIND_NAMES) {
        for (const n of k.names) {
            if (n === token) { exact.push(table); break; }
            if (token.length >= 2 && n.includes(token)) { partial.push(table); break; }
        }
    }
    return exact.length ? exact : partial;
}

// R로 시작하고 숫자가 섞인 6자 이상의 영숫자 덩어리, 또는 숫자 10자리 이상 — 시설물 ID(의 일부)로 본다.
function looksLikeRdid(token) {
    return /^[A-Za-z0-9]{6,27}$/.test(token) && /\d/.test(token) && (/^[Rr]/.test(token) || /^\d{10,}$/.test(token));
}

function parseQuery(q) {
    const tokens = String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
    const out = { rdid: null, tables: new Set(), serials: [], terms: [] };
    for (const t of tokens) {
        if (!out.rdid && looksLikeRdid(t)) { out.rdid = t.toUpperCase(); continue; }
        const kinds = kindsFor(t);
        if (kinds.length) { kinds.forEach((k) => out.tables.add(k)); continue; }
        // "12번", "#12", "0012" 모두 일련번호로 본다(4자리 이하)
        const m = /^#?(\d{1,4})번?$/.exec(t);
        if (m) { out.serials.push(m[1].padStart(4, '0')); continue; }
        out.terms.push(t);
    }
    return out;
}

// 반환: { items, total, truncated }
async function searchFacilities(q, user) {
    const p = parseQuery(q);
    const hasKind = p.tables.size > 0;
    // 종류도 ID도 이름도 없이 번호만 있는 검색은 너무 넓어서 하지 않는다.
    if (!p.rdid && !hasKind && !p.terms.length) return { items: [], total: 0, truncated: false };
    if (!p.rdid && !hasKind && p.serials.length) return { items: [], total: 0, truncated: false };

    let tables = hasKind ? [...p.tables] : (p.rdid ? [...KIND_NAMES.keys()] : Object.keys(NAME_FIELD));
    const results = [];
    let truncated = false;

    await Promise.all(tables.map(async (table) => {
        const kind = KIND_NAMES.get(table);
        const nameCol = NAME_FIELD[table];
        const conds = [];
        const params = [];
        const add = (v) => { params.push(v); return `$${params.length}`; };
        if (user.sigunguCode) conds.push(`(sigungu_code = ${add(user.sigunguCode)} OR sigungu_code IS NULL)`);
        const nameOnly = !hasKind && !p.rdid; // 이름 검색만 할 땐 이름 컬럼이 있는 테이블에서 이름으로만 찾는다
        if (p.rdid) conds.push(`rdid LIKE ${add('%' + p.rdid.replace(/[%_]/g, '') + '%')}`);
        for (const s of p.serials) conds.push(`right(rdid, 4) = ${add(s)}`);
        for (const term of p.terms) {
            const like = add('%' + term.replace(/[%_\\]/g, '\\$&') + '%');
            conds.push(nameOnly ? `${nameCol} ILIKE ${like}` : nameCol ? `(road_name ILIKE ${like} OR ${nameCol} ILIKE ${like})` : `road_name ILIKE ${like}`);
        }
        const sql = `SELECT rdid, ${nameCol ? `${nameCol} AS fname,` : 'NULL AS fname,'} road_name, road_no, sect, (geom IS NOT NULL) AS has_geom,
                            COUNT(*) OVER () AS n
                     FROM ${table} ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY rdid LIMIT ${PER_TABLE_LIMIT}`;
        try {
            const { rows } = await pool.query(sql, params);
            if (rows.length && Number(rows[0].n) > PER_TABLE_LIMIT) truncated = true;
            for (const r of rows) {
                results.push({
                    table, kind: kind.label, rdid: r.rdid, name: r.fname || null, roadName: r.road_name || null,
                    roadNo: r.road_no, sect: r.sect, serial: String(r.rdid).slice(-4), hasGeom: r.has_geom,
                });
            }
        } catch (e) { /* 컬럼 구성이 다른 테이블은 건너뜀 */ }
    }));

    results.sort((a, b) => (a.kind === b.kind ? a.rdid.localeCompare(b.rdid) : a.kind.localeCompare(b.kind)));
    if (results.length > TOTAL_LIMIT) truncated = true;
    return { items: results.slice(0, TOTAL_LIMIT), total: results.length, truncated };
}

module.exports = { searchFacilities, parseQuery };
