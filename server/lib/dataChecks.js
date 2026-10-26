// 데이터 점검 — 등록된 데이터에서 눈으로 찾기 어려운 문제를 목록으로 뽑는다(읽기 전용, 아무것도 고치지 않는다).
//   1) 중복 노선: 같은 노선인데 이름만 다르게 등록된 경우, 이름은 같은데 노선번호가 다른 경우, 같은 구간이 두 번 등록된 경우
//   2) 노선에서 벗어난 시설물: 시설물 위치가 자기 구간의 선(road_sections.geom)에서 기준 거리(기본 200m) 넘게 떨어진 것
//   3) 시설물 ID 문제: 같은 ID가 여러 테이블에 있는 경우, ID에 들어 있는 노선 정보(도로종류/노선번호/구간)가 행의 값과 다른 경우
const pool = require('../db');
const { GOV_LAYER_MAP } = require('./govLayerMap');

const LAYERS = Object.values(GOV_LAYER_MAP).filter((l) => l.pkColumn === 'rdid');
const KIND = new Map(LAYERS.map((l) => [l.table, l.koreanName.replace(/^\d+\./, '')]));
// 위치가 "노선 위"가 아니라 면/구역이거나 노선 전체를 대표하는 레이어는 거리 점검에서 뺀다.
const OFF_ROUTE_SKIP = new Set([
    'gov_section', 'gov_realnth', 'gov_landuse', 'gov_road_area', 'gov_occupy_pg', 'gov_occupy_pl', 'gov_occupy_pt',
    'gov_detour_road', 'gov_pay_road', 'gov_interchange',
]);
const MAX_ITEMS = 300;
const yieldLoop = () => new Promise((r) => setImmediate(r));

function normName(name) {
    return String(name || '').toLowerCase().replace(/[\s\-_·.,()[\]]/g, '');
}

function scope(user, params, col = 'sigungu_code') {
    if (!user.sigunguCode) return '';
    params.push(user.sigunguCode);
    return ` AND (${col} = $${params.length} OR ${col} IS NULL)`;
}

// ---------- 1) 중복 노선 ----------
async function checkDuplicateRoutes(user) {
    const params = [];
    const { rows } = await pool.query(
        `SELECT rdid, sigungu_code, road_rank_code, road_rank_name, route_no, route_name, sect, length_m
         FROM road_sections WHERE true${scope(user, params)} ORDER BY road_rank_code, route_no, sect`, params
    );
    const brief = (r) => ({ rdid: r.rdid, rank: r.road_rank_name, routeNo: r.route_no, routeName: r.route_name, sect: r.sect, lengthM: r.length_m == null ? null : Number(r.length_m) });
    const groups = [];

    const byNo = new Map();
    const byName = new Map();
    const bySect = new Map();
    for (const r of rows) {
        const sg = r.sigungu_code || '';
        const kNo = `${sg}|${r.road_rank_code}|${r.route_no || ''}`;
        if (!byNo.has(kNo)) byNo.set(kNo, []);
        byNo.get(kNo).push(r);
        const kName = `${sg}|${r.road_rank_code}|${normName(r.route_name)}`;
        if (normName(r.route_name)) { if (!byName.has(kName)) byName.set(kName, []); byName.get(kName).push(r); }
        const kSect = `${sg}|${r.road_rank_code}|${r.route_no || ''}|${r.sect || ''}`;
        if (!bySect.has(kSect)) bySect.set(kSect, []);
        bySect.get(kSect).push(r);
    }
    for (const list of byNo.values()) {
        const names = new Set(list.map((r) => String(r.route_name || '').trim()));
        if (names.size > 1) groups.push({ reason: '같은 노선번호인데 노선명이 다릅니다', sections: list.map(brief), sigungu: list[0].sigungu_code });
    }
    for (const list of byName.values()) {
        const nos = new Set(list.map((r) => r.route_no || ''));
        if (nos.size > 1) groups.push({ reason: '노선명은 같은데 노선번호가 다릅니다', sections: list.map(brief), sigungu: list[0].sigungu_code });
    }
    for (const list of bySect.values()) {
        if (list.length > 1) groups.push({ reason: '같은 구간이 두 번 이상 등록돼 있습니다', sections: list.map(brief), sigungu: list[0].sigungu_code });
    }
    return { total: groups.length, items: groups.slice(0, MAX_ITEMS) };
}

// ---------- 2) 노선에서 벗어난 시설물 ----------
function lineParts(geom) {
    if (!geom) return [];
    if (geom.type === 'LineString') return [geom.coordinates];
    if (geom.type === 'MultiLineString') return geom.coordinates;
    return [];
}

function buildRoute(geom) {
    const parts = lineParts(geom).filter((p) => p.length >= 2);
    if (!parts.length) return null;
    let lat0 = 0; let n = 0;
    for (const p of parts) for (const c of p) { lat0 += c[1]; n++; }
    lat0 /= n;
    const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const ky = 110574;
    const segs = [];
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const p of parts) {
        for (let i = 0; i < p.length; i++) {
            const x = p[i][0] * kx; const y = p[i][1] * ky;
            minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
            if (i > 0) segs.push([p[i - 1][0] * kx, p[i - 1][1] * ky, x, y]);
        }
    }
    return { kx, ky, segs, bbox: [minX, minY, maxX, maxY] };
}

function distToRoute(route, lon, lat, stopBelow) {
    const px = lon * route.kx; const py = lat * route.ky;
    let best = Infinity;
    for (const s of route.segs) {
        const dx = s[2] - s[0]; const dy = s[3] - s[1];
        const len2 = dx * dx + dy * dy;
        let t = len2 ? ((px - s[0]) * dx + (py - s[1]) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const ex = s[0] + t * dx - px; const ey = s[1] + t * dy - py;
        const d2 = ex * ex + ey * ey;
        if (d2 < best) { best = d2; if (stopBelow && best < stopBelow * stopBelow) return Math.sqrt(best); }
    }
    return Math.sqrt(best);
}

// 시설물 하나를 대표하는 점들(점이면 그 점, 선/면이면 처음·끝·가운데 몇 개)
function samplePoints(geom) {
    if (!geom || !geom.coordinates) return [];
    let coords = geom.coordinates;
    switch (geom.type) {
        case 'Point': return [coords];
        case 'MultiPoint': return coords.slice(0, 3);
        case 'Polygon': coords = coords[0] || []; break;
        case 'MultiPolygon': coords = (coords[0] && coords[0][0]) || []; break;
        case 'MultiLineString': coords = coords.flat(); break;
        default: break;
    }
    if (!Array.isArray(coords) || !coords.length || typeof coords[0][0] !== 'number') return [];
    if (coords.length <= 5) return coords;
    const out = [];
    for (let i = 0; i < 5; i++) out.push(coords[Math.round((i * (coords.length - 1)) / 4)]);
    return out;
}

async function checkOffRoute(user, thresholdM, onProgress) {
    const params = [];
    const { rows: sections } = await pool.query(
        `SELECT rdid, sigungu_code, road_rank_code, route_no, route_name, road_rank_name, sect, geom
         FROM road_sections WHERE true${scope(user, params)}`, params
    );
    const routes = new Map(); // "sg|rank|no|sect" -> {route, label}
    const noGeom = [];
    for (const s of sections) {
        const route = buildRoute(s.geom);
        const label = `${s.road_rank_name || ''} ${s.route_no ? s.route_no + ' ' : ''}${s.route_name || ''} ${s.sect || ''}구간`.replace(/\s+/g, ' ').trim();
        if (!route) { noGeom.push({ rdid: s.rdid, label }); continue; }
        routes.set(`${s.sigungu_code || ''}|${s.road_rank_code}|${s.route_no}|${s.sect}`, { route, label, rdid: s.rdid });
    }
    const tables = LAYERS.filter((l) => !OFF_ROUTE_SKIP.has(l.table));
    const items = [];
    let total = 0; let checked = 0; let unmatched = 0;

    for (let ti = 0; ti < tables.length; ti++) {
        const { table } = tables[ti];
        if (onProgress) onProgress(`위치 점검: ${KIND.get(table)}`, ti, tables.length);
        let last = '';
        for (;;) {
            const p = [last];
            const sc = scope(user, p);
            let rows;
            try {
                ({ rows } = await pool.query(
                    `SELECT rdid, geom, sigungu_code, road_rank, road_no, sect FROM ${table}
                     WHERE rdid > $1 AND geom IS NOT NULL${sc} ORDER BY rdid LIMIT 3000`, p
                ));
            } catch (e) { rows = []; }
            if (!rows.length) break;
            last = rows[rows.length - 1].rdid;
            for (const r of rows) {
                const hit = routes.get(`${r.sigungu_code || ''}|${r.road_rank}|${r.road_no}|${r.sect}`);
                if (!hit) { unmatched++; continue; }
                const pts = samplePoints(r.geom);
                if (!pts.length) continue;
                checked++;
                const { route } = hit;
                // 구간 선의 범위(bbox)에서 기준 거리 넘게 떨어져 있으면 선과의 거리를 계산하지 않아도 벗어난 것
                let minD = Infinity;
                for (const c of pts) {
                    const x = c[0] * route.kx; const y = c[1] * route.ky;
                    const [bx0, by0, bx1, by1] = route.bbox;
                    const dxb = Math.max(bx0 - x, 0, x - bx1); const dyb = Math.max(by0 - y, 0, y - by1);
                    const dBox = Math.hypot(dxb, dyb);
                    const d = dBox > thresholdM ? dBox : distToRoute(route, c[0], c[1], thresholdM);
                    if (d < minD) minD = d;
                    if (minD <= thresholdM) break;
                }
                if (minD > thresholdM) {
                    minD = Math.min(...pts.map((c) => distToRoute(route, c[0], c[1]))); // 실제 거리(상자 바깥은 근사값이었으므로)
                    total++;
                    items.push({ table, kind: KIND.get(table), rdid: r.rdid, routeLabel: hit.label, sectionRdid: hit.rdid, distanceM: Math.round(minD) });
                }
            }
            await yieldLoop();
        }
    }
    items.sort((a, b) => b.distanceM - a.distanceM);
    return { total, checked, unmatched, thresholdM, noGeomSections: noGeom.length, noGeom: noGeom.slice(0, 50), items: items.slice(0, MAX_ITEMS) };
}

// ---------- 3) 시설물 ID ----------
async function checkIds(user) {
    // (a) 같은 ID가 둘 이상의 테이블에 있는 경우
    const parts = LAYERS.map((l) => {
        const sc = user.sigunguCode ? ` WHERE (sigungu_code = $1 OR sigungu_code IS NULL)` : '';
        return `SELECT rdid, '${l.table}' AS t FROM ${l.table}${sc}`;
    });
    const p = user.sigunguCode ? [user.sigunguCode] : [];
    const dup = await pool.query(
        `SELECT rdid, array_agg(t ORDER BY t) AS tables FROM (${parts.join(' UNION ALL ')}) u GROUP BY rdid HAVING COUNT(*) > 1 ORDER BY rdid LIMIT ${MAX_ITEMS + 1}`, p
    );
    const crossTable = dup.rows.slice(0, MAX_ITEMS).map((r) => ({ rdid: r.rdid, kinds: r.tables.map((t) => KIND.get(t) || t) }));

    // (b) ID 안의 도로종류(4~7번째)/노선번호(13~16)/구간(17~19)이 행의 값과 다른 경우
    const mismatch = [];
    let mismatchTotal = 0;
    for (const l of LAYERS) {
        const params = [];
        const sc = scope(user, params);
        try {
            const { rows } = await pool.query(
                `SELECT rdid, road_rank, road_no, sect, COUNT(*) OVER () AS n FROM ${l.table}
                 WHERE (substr(rdid, 4, 4) <> road_rank OR substr(rdid, 13, 4) <> road_no OR substr(rdid, 17, 3) <> sect)${sc}
                 ORDER BY rdid LIMIT 50`, params
            );
            if (rows.length) mismatchTotal += Number(rows[0].n);
            for (const r of rows) {
                if (mismatch.length < MAX_ITEMS) mismatch.push({ table: l.table, kind: KIND.get(l.table), rdid: r.rdid, rowKey: `${r.road_rank}/${r.road_no}/${r.sect}`, idKey: `${r.rdid.substr(3, 4)}/${r.rdid.substr(12, 4)}/${r.rdid.substr(16, 3)}` });
            }
        } catch (e) { /* 컬럼이 다른 테이블은 건너뜀 */ }
    }
    // 구간(road_sections) 자신의 ID도 같은 방식으로 본다
    const sp = [];
    const { rows: secRows } = await pool.query(
        `SELECT rdid, road_rank_code, route_no, sect FROM road_sections
         WHERE (substr(rdid, 4, 4) <> road_rank_code OR substr(rdid, 13, 4) <> route_no OR substr(rdid, 17, 3) <> sect)${scope(user, sp)} ORDER BY rdid LIMIT 50`, sp
    );
    for (const r of secRows) {
        mismatchTotal++;
        if (mismatch.length < MAX_ITEMS) mismatch.push({ table: 'road_sections', kind: '구간(대장)', rdid: r.rdid, rowKey: `${r.road_rank_code}/${r.route_no}/${r.sect}`, idKey: `${r.rdid.substr(3, 4)}/${r.rdid.substr(12, 4)}/${r.rdid.substr(16, 3)}` });
    }
    return { crossTable: { total: dup.rows.length, items: crossTable, capped: dup.rows.length > MAX_ITEMS }, mismatch: { total: mismatchTotal, items: mismatch } };
}

async function runChecks({ user, thresholdM, onProgress }) {
    const startedAt = Date.now();
    if (onProgress) onProgress('중복 노선 점검', 0, 3);
    const duplicateRoutes = await checkDuplicateRoutes(user);
    if (onProgress) onProgress('시설물 ID 점검', 1, 3);
    const ids = await checkIds(user);
    const offRoute = await checkOffRoute(user, thresholdM, onProgress);
    return { generatedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, duplicateRoutes, offRoute, ids };
}

module.exports = { runChecks, checkDuplicateRoutes, checkOffRoute, checkIds, KIND };
