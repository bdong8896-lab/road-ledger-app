// 현황 통계 엑셀 — 시설물 종류별·노선별·시군구별 개수/연장/폭원 합계와, 제출 전에 한눈에 보는 체크리스트를 한 파일에 담는다.
// 로그인 계정의 관할(시군구) 범위 안의 데이터만 집계한다.
const ExcelJS = require('exceljs');
const pool = require('../db');
const { GOV_LAYER_MAP } = require('./govLayerMap');
const SIGUNGU_CODES = require('./sigunguCodes.json');

const LAYERS = Object.values(GOV_LAYER_MAP).filter((l) => l.pkColumn === 'rdid');
const KIND = new Map(LAYERS.map((l) => [l.table, l.koreanName.replace(/^\d+\./, '')]));
const KIND_ORDER = LAYERS.map((l) => l.table);

// 테이블별 "연장"과 "폭원"으로 쓰는 컬럼(표준 정의서의 대표 항목). 없는 테이블은 건수만 센다.
// 터널은 상행+하행, 지하차도 폭원은 차도+보도를 더한다.
const LEN_EXPR = {
    gov_section: 'lenth', gov_bridge: 'brdg_len', gov_tunnel: 'COALESCE(len_u,0) + COALESCE(len_d,0)', gov_overpass: 'len',
    gov_under_road: 'len', gov_high_road: 'road_len', gov_under_sidewalk: 'len', gov_xrail: 'len', gov_median_strip: 'len',
    gov_stone: 'eqp_len', gov_wall: 'eqp_len', gov_cut_slope: 'eqp_len', gov_land_fill: 'eqp_len', gov_climbing_lane: 'len',
    gov_slope: 'slp_len', gov_stopbay: 'eqp_len', gov_side: 'eqp_len', gov_box_pipe: 'eqp_len', gov_nori: 'eqp_len',
    gov_defence: 'eqp_len', gov_pipe_conduit: 'eqp_len', gov_pathway: 'eqp_len', gov_eco_corridor: 'len', gov_emerg_escape: 'eqp_len',
    gov_speed_hump: 'len', gov_sleepy_restarea: 'eqp_len', gov_dip_eqp: 'eqp_len', gov_detour_road: 'len',
};
const WID_EXPR = {
    gov_section: 'wid_all', gov_bridge: 'width_sum', gov_tunnel: 'wid_au', gov_overpass: 'gu_wid',
    gov_under_road: 'COALESCE(wid_car,0) + COALESCE(wid_walk,0)', gov_high_road: 'road_wid', gov_under_sidewalk: 'wid', gov_xrail: 'wid',
    gov_median_strip: 'wid', gov_stone: 'width', gov_wall: 'width', gov_climbing_lane: 'wid', gov_stopbay: 'wid', gov_side: 'wid',
    gov_pipe_conduit: 'wid', gov_speed_hump: 'wid', gov_detour_road: 'wid',
};

function sigunguName(code) {
    if (!code) return '(관할 없음)';
    const hit = SIGUNGU_CODES.find((s) => s.code5 === code);
    return hit ? hit.full || hit.sgg : code;
}
function scopeSql(user, params, col = 'sigungu_code') {
    if (!user.sigunguCode) return '';
    params.push(user.sigunguCode);
    return ` AND (${col} = $${params.length} OR ${col} IS NULL)`;
}

async function collect(user, getBlankMeta) {
    const sp = [];
    const { rows: sections } = await pool.query(
        `SELECT rdid, sigungu_code, road_rank_code, road_rank_name, route_no, route_name, sect, length_m, (geom IS NOT NULL) AS has_geom
         FROM road_sections WHERE true${scopeSql(user, sp)} ORDER BY sigungu_code NULLS LAST, road_rank_code, route_no, sect`, sp
    );
    const secByKey = new Map();
    const secByKeyNoSg = new Map();
    const routes = new Map();
    for (const s of sections) {
        const routeKey = `${s.sigungu_code || ''}|${s.road_rank_code}|${s.route_no}|${s.route_name}`;
        if (!routes.has(routeKey)) {
            routes.set(routeKey, {
                sigungu: s.sigungu_code, rank: s.road_rank_name, routeNo: s.route_no, routeName: s.route_name,
                sections: 0, lengthM: 0, noGeom: 0, drawings: 0, photos: 0, reports: 0, blanks: 0, facilityTotal: 0, kinds: new Map(),
            });
        }
        const route = routes.get(routeKey);
        route.sections++;
        route.lengthM += s.length_m == null ? 0 : Number(s.length_m);
        if (!s.has_geom) route.noGeom++;
        s.route = route;
        secByKey.set(`${s.sigungu_code || ''}|${s.road_rank_code}|${s.route_no}|${s.sect}`, s);
        const k2 = `${s.road_rank_code}|${s.route_no}|${s.sect}`;
        secByKeyNoSg.set(k2, secByKeyNoSg.has(k2) ? null : s); // 둘 이상이면 모호 → null
    }
    const findSection = (sg, rr, rn, sect) => secByKey.get(`${sg || ''}|${rr}|${rn}|${sect}`) || secByKeyNoSg.get(`${rr}|${rn}|${sect}`) || null;

    // 도면(route_files)
    const dp = [];
    const { rows: drawRows } = await pool.query(
        `SELECT section_rdid, COUNT(*)::int AS n FROM route_files WHERE section_rdid IS NOT NULL${scopeSql(user, dp)} GROUP BY section_rdid`, dp
    );
    const secByRdid = new Map(sections.map((s) => [s.rdid, s]));
    for (const r of drawRows) { const s = secByRdid.get(r.section_rdid); if (s) s.route.drawings += r.n; }

    const kindTotals = new Map(); // table -> {n,len,wid,widN}
    const sigunguKind = new Map(); // `${sg}|${table}` -> {n,len,wid,widN}
    const routeKind = []; // 긴 형식 행
    let unlinked = 0;
    const blankMeta = getBlankMeta ? await getBlankMeta() : new Map();

    for (const table of KIND_ORDER) {
        const len = LEN_EXPR[table] || 'NULL::numeric';
        const wid = WID_EXPR[table] || 'NULL::numeric';
        const p = [];
        const sc = scopeSql(user, p);
        let rows;
        try {
            ({ rows } = await pool.query(
                `SELECT sigungu_code AS sg, road_rank AS rr, road_no AS rn, sect, COUNT(*)::int AS n,
                        COALESCE(SUM(${len}), 0)::float8 AS len, COALESCE(SUM(${wid}), 0)::float8 AS wid,
                        COUNT(*) FILTER (WHERE (${wid}) > 0)::int AS wid_n
                 FROM ${table} WHERE true${sc} GROUP BY 1, 2, 3, 4`, p
            ));
        } catch (e) { continue; }

        const acc = (map, key, r) => {
            const a = map.get(key) || { n: 0, len: 0, wid: 0, widN: 0 };
            a.n += r.n; a.len += r.len; a.wid += r.wid; a.widN += r.wid_n;
            map.set(key, a);
        };
        for (const r of rows) {
            acc(kindTotals, table, r);
            acc(sigunguKind, `${r.sg || ''}|${table}`, r);
            const sec = findSection(r.sg, r.rr, r.rn, r.sect);
            if (!sec) { unlinked += r.n; continue; }
            acc(sec.route.kinds, table, r);
            sec.route.facilityTotal += r.n;
        }

        // 첨부 사진/보고서 건수
        const fp = [table];
        try {
            const { rows: fr } = await pool.query(
                `SELECT f.sigungu_code AS sg, f.road_rank AS rr, f.road_no AS rn, f.sect, ff.file_kind, COUNT(*)::int AS n
                 FROM ${table} f JOIN gov_facility_files ff ON ff.facility_table = $1 AND ff.facility_rdid = f.rdid
                 WHERE true${scopeSql(user, fp, 'f.sigungu_code')} GROUP BY 1, 2, 3, 4, 5`, fp
            );
            for (const r of fr) {
                const sec = findSection(r.sg, r.rr, r.rn, r.sect);
                if (!sec) continue;
                if (r.file_kind === '사진') sec.route.photos += r.n; else sec.route.reports += r.n;
            }
        } catch (e) { /* 건너뜀 */ }

        // 필수 항목 빈 값(KRRIS M-1) 칸 수
        const cols = blankMeta.get(table);
        if (cols && cols.size) {
            const expr = [...cols.keys()].map((c) => `(btrim(${c}) = '')::int`).join(' + ');
            const bp = [];
            try {
                const { rows: br } = await pool.query(
                    `SELECT sigungu_code AS sg, road_rank AS rr, road_no AS rn, sect, SUM(${expr})::int AS blanks
                     FROM ${table} WHERE true${scopeSql(user, bp)} GROUP BY 1, 2, 3, 4`, bp
                );
                for (const r of br) {
                    if (!r.blanks) continue;
                    const sec = findSection(r.sg, r.rr, r.rn, r.sect);
                    if (sec) sec.route.blanks += r.blanks;
                }
            } catch (e) { /* 건너뜀 */ }
        }
    }
    return { routes: [...routes.values()], kindTotals, sigunguKind, unlinked, sectionCount: sections.length };
}

// ---------- 엑셀 ----------
const FONT = 'Malgun Gothic';
const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
const NUM = '#,##0';
const DEC = '#,##0.00';

function styleHeader(ws, rowNo = 1) {
    const row = ws.getRow(rowNo);
    row.height = 22;
    row.eachCell((c) => {
        c.font = { name: FONT, bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
        c.fill = HEAD_FILL;
        c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
}
function baseFont(ws) {
    ws.eachRow((row, i) => { if (i > 1) row.eachCell((c) => { if (!c.font || !c.font.bold) c.font = { name: FONT, size: 10 }; }); });
}
function widths(ws, list) { list.forEach((w, i) => { ws.getColumn(i + 1).width = w; }); }

async function buildStatsWorkbook(user, getBlankMeta) {
    const d = await collect(user, getBlankMeta);
    const wb = new ExcelJS.Workbook();
    wb.creator = '도로대장 시스템';
    wb.created = new Date();
    const scopeLabel = user.sigunguCode ? sigunguName(user.sigunguCode) : '전체';
    const wsSum = wb.addWorksheet('요약'); // 맨 앞 시트 — 내용은 나머지 시트를 만든 뒤 채운다

    // 1) 시설물 종류별 합계
    const wsKind = wb.addWorksheet('시설물 종류별');
    wsKind.addRow(['시설물 종류', '건수', '연장 합계(m)', '폭원 합계(m)', '폭원 입력 건수', '폭원 평균(m)']);
    styleHeader(wsKind);
    let r = 2;
    let kN = 0; let kL = 0;
    for (const table of KIND_ORDER) {
        const t = d.kindTotals.get(table);
        if (!t || !t.n) continue;
        wsKind.addRow([KIND.get(table), t.n, Math.round(t.len * 1000) / 1000, Math.round(t.wid * 1000) / 1000, t.widN, null]);
        wsKind.getCell(`F${r}`).value = { formula: `IF(E${r}=0,"",D${r}/E${r})`, result: t.widN ? t.wid / t.widN : '' };
        kN += t.n; kL += t.len;
        r++;
    }
    const kindLast = r - 1;
    wsKind.addRow(['합계', null, null, null, null, null]);
    wsKind.getCell(`B${r}`).value = { formula: `SUM(B2:B${kindLast})`, result: kN };
    wsKind.getCell(`C${r}`).value = { formula: `SUM(C2:C${kindLast})`, result: Math.round(kL * 1000) / 1000 };
    wsKind.getRow(r).font = { name: FONT, bold: true, size: 10 };
    for (let i = 2; i <= kindLast; i++) {
        wsKind.getCell(`B${i}`).numFmt = NUM; wsKind.getCell(`C${i}`).numFmt = DEC; wsKind.getCell(`D${i}`).numFmt = DEC;
        wsKind.getCell(`E${i}`).numFmt = NUM; wsKind.getCell(`F${i}`).numFmt = DEC;
    }
    wsKind.getCell(`B${r}`).numFmt = NUM; wsKind.getCell(`C${r}`).numFmt = DEC;
    wsKind.addRow([]);
    const noteRow = wsKind.addRow(['※ 연장·폭원은 각 시설물 표준 정의서의 대표 항목(예: 교량=교량연장/총폭원, 터널=상행+하행 연장, 측구=연장/폭)을 합한 값이며, 해당 항목이 없는 종류는 건수만 집계합니다. 폭원 합계는 종류 안에서만 의미가 있어 합계 행에는 넣지 않았습니다.']);
    noteRow.getCell(1).font = { name: FONT, italic: true, size: 9, color: { argb: 'FF666666' } };
    wsKind.mergeCells(noteRow.number, 1, noteRow.number, 6);
    noteRow.getCell(1).alignment = { wrapText: true, vertical: 'top' };
    noteRow.height = 42;
    widths(wsKind, [22, 12, 16, 16, 14, 14]);
    wsKind.views = [{ state: 'frozen', ySplit: 1 }];
    baseFont(wsKind);

    // 2) 노선별 시설물(긴 형식)
    const wsRoute = wb.addWorksheet('노선별 시설물');
    wsRoute.addRow(['시군구', '도로종류', '노선번호', '노선명', '시설물 종류', '건수', '연장 합계(m)', '폭원 합계(m)', '폭원 입력 건수', '폭원 평균(m)']);
    styleHeader(wsRoute);
    let rr = 2;
    const allKindsUsed = new Set();
    for (const route of d.routes) {
        for (const table of KIND_ORDER) {
            const t = route.kinds.get(table);
            if (!t || !t.n) continue;
            allKindsUsed.add(table);
            wsRoute.addRow([sigunguName(route.sigungu), route.rank, route.routeNo, route.routeName, KIND.get(table), t.n,
                Math.round(t.len * 1000) / 1000, Math.round(t.wid * 1000) / 1000, t.widN, null]);
            wsRoute.getCell(`J${rr}`).value = { formula: `IF(I${rr}=0,"",H${rr}/I${rr})`, result: t.widN ? t.wid / t.widN : '' };
            ['F', 'I'].forEach((c) => { wsRoute.getCell(`${c}${rr}`).numFmt = NUM; });
            ['G', 'H', 'J'].forEach((c) => { wsRoute.getCell(`${c}${rr}`).numFmt = DEC; });
            rr++;
        }
    }
    widths(wsRoute, [18, 12, 10, 24, 18, 10, 16, 16, 14, 14]);
    wsRoute.autoFilter = { from: 'A1', to: `J${Math.max(rr - 1, 1)}` };
    wsRoute.views = [{ state: 'frozen', ySplit: 1 }];
    baseFont(wsRoute);

    // 3) 시군구별 시설물
    const wsSg = wb.addWorksheet('시군구별 시설물');
    wsSg.addRow(['시군구', '시설물 종류', '건수', '연장 합계(m)', '폭원 합계(m)', '폭원 입력 건수', '폭원 평균(m)']);
    styleHeader(wsSg);
    let sr = 2;
    const sgKeys = [...d.sigunguKind.keys()].sort();
    for (const key of sgKeys) {
        const [sg, table] = key.split('|');
        const t = d.sigunguKind.get(key);
        if (!t.n) continue;
        wsSg.addRow([sigunguName(sg), KIND.get(table), t.n, Math.round(t.len * 1000) / 1000, Math.round(t.wid * 1000) / 1000, t.widN, null]);
        wsSg.getCell(`G${sr}`).value = { formula: `IF(F${sr}=0,"",E${sr}/F${sr})`, result: t.widN ? t.wid / t.widN : '' };
        ['C', 'F'].forEach((c) => { wsSg.getCell(`${c}${sr}`).numFmt = NUM; });
        ['D', 'E', 'G'].forEach((c) => { wsSg.getCell(`${c}${sr}`).numFmt = DEC; });
        sr++;
    }
    widths(wsSg, [20, 20, 10, 16, 16, 14, 14]);
    wsSg.autoFilter = { from: 'A1', to: `G${Math.max(sr - 1, 1)}` };
    wsSg.views = [{ state: 'frozen', ySplit: 1 }];
    baseFont(wsSg);

    // 4) 노선 × 종류 개수 표
    const kindCols = KIND_ORDER.filter((t) => allKindsUsed.has(t));
    const wsMat = wb.addWorksheet('노선별 개수표');
    wsMat.addRow(['시군구', '도로종류', '노선번호', '노선명', ...kindCols.map((t) => KIND.get(t)), '합계']);
    styleHeader(wsMat);
    let mr = 2;
    for (const route of d.routes) {
        wsMat.addRow([sigunguName(route.sigungu), route.rank, route.routeNo, route.routeName,
            ...kindCols.map((t) => (route.kinds.get(t) ? route.kinds.get(t).n : 0)), null]);
        const first = wsMat.getCell(mr, 5).address; const last = wsMat.getCell(mr, 4 + kindCols.length).address;
        wsMat.getCell(mr, 5 + kindCols.length).value = { formula: `SUM(${first}:${last})`, result: kindCols.reduce((n, t) => n + (route.kinds.get(t) ? route.kinds.get(t).n : 0), 0) };
        for (let c = 5; c <= 5 + kindCols.length; c++) wsMat.getCell(mr, c).numFmt = NUM;
        mr++;
    }
    widths(wsMat, [18, 12, 10, 24, ...kindCols.map(() => 11), 11]);
    wsMat.getRow(1).alignment = { wrapText: true, horizontal: 'center', vertical: 'middle' };
    wsMat.getRow(1).height = 34;
    wsMat.views = [{ state: 'frozen', xSplit: 4, ySplit: 1 }];
    baseFont(wsMat);

    // 5) 제출 체크리스트
    const wsChk = wb.addWorksheet('제출 체크리스트');
    wsChk.addRow(['시군구', '도로종류', '노선번호', '노선명', '구간 수', '연장(km)', '시설물 종류 수', '시설물 건수', '도면', '사진', '보고서', '필수항목 빈 값(칸)', '선형(지도 선) 없는 구간', '확인 결과', '확인할 내용']);
    styleHeader(wsChk);
    let cr = 2;
    let needCheck = 0;
    for (const route of d.routes) {
        const reasons = [];
        if (!route.facilityTotal) reasons.push('시설물이 없습니다');
        if (!route.drawings) reasons.push('도면이 없습니다');
        if (route.blanks) reasons.push(`필수항목 빈 값 ${route.blanks.toLocaleString()}칸(데이터 품질 화면에서 채우기)`);
        if (route.noGeom) reasons.push(`지도 선이 없는 구간 ${route.noGeom}개`);
        wsChk.addRow([sigunguName(route.sigungu), route.rank, route.routeNo, route.routeName, route.sections,
            Math.round(route.lengthM) / 1000, route.kinds.size, route.facilityTotal, route.drawings, route.photos, route.reports, route.blanks, route.noGeom, null,
            reasons.join(' / ')]);
        const ok = route.facilityTotal > 0 && route.drawings > 0 && route.blanks === 0 && route.noGeom === 0;
        if (!ok) needCheck++;
        wsChk.getCell(`N${cr}`).value = { formula: `IF(AND(H${cr}>0,I${cr}>0,L${cr}=0,M${cr}=0),"정상","확인 필요")`, result: ok ? '정상' : '확인 필요' };
        wsChk.getCell(`F${cr}`).numFmt = DEC;
        ['E', 'G', 'H', 'I', 'J', 'K', 'L', 'M'].forEach((c) => { wsChk.getCell(`${c}${cr}`).numFmt = NUM; });
        wsChk.getCell(`N${cr}`).alignment = { horizontal: 'center' };
        cr++;
    }
    const chkLast = cr - 1;
    if (chkLast >= 2) {
        wsChk.addConditionalFormatting({
            ref: `N2:N${chkLast}`,
            rules: [
                { type: 'cellIs', operator: 'equal', formulae: ['"확인 필요"'], style: { font: { color: { argb: 'FF9C0006' }, bold: true }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFC7CE' } } } },
                { type: 'cellIs', operator: 'equal', formulae: ['"정상"'], style: { font: { color: { argb: 'FF006100' } }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFC6EFCE' } } } },
            ],
        });
    }
    wsChk.addRow([]);
    const tot = wsChk.addRow(['합계']);
    const totRow = tot.number;
    const sums = {
        E: d.routes.reduce((n, x) => n + x.sections, 0), F: d.routes.reduce((n, x) => n + Math.round(x.lengthM) / 1000, 0),
        H: d.routes.reduce((n, x) => n + x.facilityTotal, 0), I: d.routes.reduce((n, x) => n + x.drawings, 0),
        J: d.routes.reduce((n, x) => n + x.photos, 0), K: d.routes.reduce((n, x) => n + x.reports, 0),
        L: d.routes.reduce((n, x) => n + x.blanks, 0), M: d.routes.reduce((n, x) => n + x.noGeom, 0),
    };
    for (const c of ['E', 'F', 'H', 'I', 'J', 'K', 'L', 'M']) {
        wsChk.getCell(`${c}${totRow}`).value = { formula: `SUM(${c}2:${c}${Math.max(chkLast, 2)})`, result: sums[c] };
        wsChk.getCell(`${c}${totRow}`).numFmt = c === 'F' ? DEC : NUM;
    }
    wsChk.getCell(`N${totRow}`).value = { formula: `COUNTIF(N2:N${Math.max(chkLast, 2)},"확인 필요")&"개 노선 확인 필요"`, result: `${needCheck}개 노선 확인 필요` };
    tot.font = { name: FONT, bold: true, size: 10 };
    const n2 = wsChk.addRow(['※ 정상 기준: 시설물과 도면이 있고, 필수항목 빈 값이 0칸이며, 모든 구간에 지도 선이 있음. 위치 이탈·중복 노선·시설물 ID 문제는 관리 콘솔 > 데이터 점검에서 따로 확인합니다.']);
    n2.getCell(1).font = { name: FONT, italic: true, size: 9, color: { argb: 'FF666666' } };
    widths(wsChk, [18, 12, 10, 24, 8, 11, 12, 12, 8, 8, 8, 14, 14, 14, 60]);
    wsChk.getRow(1).height = 34;
    wsChk.autoFilter = { from: 'A1', to: `O${Math.max(chkLast, 1)}` };
    wsChk.views = [{ state: 'frozen', xSplit: 4, ySplit: 1 }];
    baseFont(wsChk);

    // 0) 요약(맨 앞) — 나머지 시트의 합계를 참조
    const lines = [
        ['도로대장 현황 통계'],
        ['범위', scopeLabel],
        ['작성 일시', new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })],
        [],
        ['항목', '값'],
        ['노선 수', { formula: `COUNTA('제출 체크리스트'!D2:D${Math.max(chkLast, 2)})`, result: d.routes.length }],
        ['구간 수', { formula: `'제출 체크리스트'!E${totRow}`, result: sums.E }],
        ['총 연장(km)', { formula: `'제출 체크리스트'!F${totRow}`, result: sums.F }],
        ['시설물 건수', { formula: `'시설물 종류별'!B${kindLast + 1}`, result: kN }],
        ['도면 건수', { formula: `'제출 체크리스트'!I${totRow}`, result: sums.I }],
        ['사진 건수', { formula: `'제출 체크리스트'!J${totRow}`, result: sums.J }],
        ['보고서 건수', { formula: `'제출 체크리스트'!K${totRow}`, result: sums.K }],
        ['필수항목 빈 값(칸)', { formula: `'제출 체크리스트'!L${totRow}`, result: sums.L }],
        ['확인 필요 노선 수', { formula: `COUNTIF('제출 체크리스트'!N2:N${Math.max(chkLast, 2)},"확인 필요")`, result: needCheck }],
        ['구간과 연결되지 않은 시설물', d.unlinked],
    ];
    lines.forEach((l) => wsSum.addRow(l));
    wsSum.getCell('A1').font = { name: FONT, bold: true, size: 14 };
    styleHeader(wsSum, 5);
    for (let i = 6; i <= lines.length; i++) { wsSum.getCell(`B${i}`).numFmt = i === 8 ? DEC : NUM; wsSum.getCell(`B${i}`).alignment = { horizontal: 'right' }; }
    widths(wsSum, [30, 22]);
    wsSum.eachRow((row, i) => { if (i !== 1 && i !== 5) row.eachCell((c) => { c.font = { name: FONT, size: 10 }; }); });
    return wb;
}

module.exports = { buildStatsWorkbook };
