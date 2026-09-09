// 국토교통부 도로대장 표준서식의 나머지 부속시설/구조조서 시트를 남양203.xlsx에서
// 실측한 좌표·병합 그대로 그린다. officialLedgerFacilitySheets.js(표지/가로등/신호등/
// 방음시설/가로수)와 같은 방식이고, 여기 15종을 더 추가한다:
// 도로중심선교점, 교차시설, 종단경사, 정차대, 측구, 석축, 옹벽, 배수암거및배수관,
// 중앙분리대, 낙석방지시설, 방호울타리, 지하매설물, 통로박스, 실연장, 도로구역.
// 교량/터널은 항목 하나가 전체 페이지인 완전히 다른 레이아웃이라 여기 포함하지
// 않고 다음 단계로 남겨둔다.
//
// 코드값 해석: govCodebook.js(국토교통부 공통입력코드정의서 v2.6)로 direction/
// x_type/wait/side_kind/st_type/method/eqp_met/eqp_met1/type/grade/eqp_kind/
// dip_kind/dip_met/met/pump/purpose/own_dit를 실제 한글 명칭으로 바꾼다.
// "구분"류 필드(sd_dev/st_dev/wall_dev/df_dev/nr_dev)는 DB에 이미 실제 한글
// 텍스트가 들어있어("측구","석축","옹벽" 등 — 시설 유형과 동일한 상수) 그대로 쓴다.
const {
    LABEL_FONT, VALUE_FONT, CENTER_WRAP,
    applyCells, label, data, applyRowHeights, formatRouteNoLabel,
} = require('./officialLedgerForm');
const { THIN, BOX_BORDER } = require('./officialLedgerForm');
const { decodeCode } = require('./govCodebook');

function noCodebook(fieldIdent, code) {
    if (code === null || code === undefined || code === '') return '';
    const name = decodeCode(fieldIdent, code);
    return name !== null ? name : `${code} (코드북 없음)`;
}
function real(v) {
    return v === null || v === undefined ? '' : v;
}
function numOrBlank(v) {
    return v === null || v === undefined || v === '' ? '' : Number(v);
}

function drawDataRows(ws, startRow, rows, columns) {
    const count = Math.max(rows.length, 1);
    for (let i = 0; i < count; i++) {
        const r = startRow + i;
        const rec = rows[i] || null;
        columns.forEach(({ colStart, colEnd, get }) => {
            if (colEnd) ws.mergeCells(`${colStart}${r}:${colEnd}${r}`);
            const cell = ws.getCell(`${colStart}${r}`);
            cell.value = rec ? get(rec) : '';
            cell.font = VALUE_FONT;
            cell.alignment = CENTER_WRAP;
            cell.border = BOX_BORDER;
        });
        ws.getRow(r).height = 23.1;
    }
    return startRow + count - 1;
}

function setColWidths(ws, widths) {
    Object.entries(widths).forEach(([letter, w]) => {
        ws.getColumn(letter).width = w;
    });
}

function infoLineCells(section) {
    return {
        roadRank: section.road_rank_name || '',
        routeName: section.route_name || '',
        routeNo: formatRouteNoLabel(section.route_no),
        sect: section.sect ? Number(section.sect) : '',
        mco: section.mco_name || '',
    };
}

// ── 3-1. 도로중심선교점 (gov_xpoint) ─────────────────────────────────
function buildXpointSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('도로중심선교점', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 16.16, B: 12.66, C: 3.33, D: 2.16, E: 4.66, F: 2.16, G: 4.66, H: 3.33,
        I: 4.66, J: 6.83, K: 11.5, L: 3.33, M: 14, N: 11.5, O: 6.83, P: 4.66,
        R: 4.66, S: 11.5, T: 12.66, U: 1.16, V: 12.66, W: 16.16, X: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '3. 기하구조조서', { font: LABEL_FONT }],
        ['A2', 'A2:E2', '3-1. 도로중심선교점', { font: LABEL_FONT }],
        label('A3', null, '1)도로의 종류'), data('B3', 'B3:D3', v.roadRank),
        label('E3', 'E3:I3', '2)노선명'), data('J3', 'J3:K3', v.routeName),
        label('L3', 'L3:M3', '3)노선번호'), data('N3', 'N3:O3', v.routeNo),
        label('P3', 'P3:Q3', '4)구간'), data('R3', 'R3:S3', v.sect),
        label('T3', null, '5)관리기관'), data('U3', 'U3:W3', v.mco),

        label('A4', null, '6)관리번호'),
        label('B4', null, '7)IP번호'),
        label('C4', 'C4:H4', '8)교각'),
        label('I4', 'I4:J4', '9)곡선\n반경(m)'),
        label('K4', 'K4:L4', '10)접선장\n(m)'),
        label('M4', null, '11)곡선장\n(m)'),
        label('N4', null, '12)곡선\n시점(km)'),
        label('O4', 'O4:P4', '13)곡선\n종점(km)'),
        label('Q4', 'Q4:R4', '14)중앙\n종거(m)'),
        label('S4', null, '15)경사\n(%)'),
        label('T4', 'T4:U4', '16)확폭\n(m)'),
        label('V4', null, '17)직선장\n(m)'),
        label('W4', null, '18)비고'),
    ]);
    applyRowHeights(ws, 4, { 1: 19.5, 2: 27 });

    drawDataRows(ws, 5, rows, [
        { colStart: 'B', get: (r) => numOrBlank(r.ip_no) },
        { colStart: 'C', get: (r) => numOrBlank(r.ia_deg) },
        { colStart: 'D', get: () => '°' },
        { colStart: 'E', get: (r) => numOrBlank(r.ia_min) },
        { colStart: 'F', get: () => "'" },
        { colStart: 'G', get: (r) => numOrBlank(r.ia_sec) },
        { colStart: 'H', get: () => "''" },
        { colStart: 'I', colEnd: 'J', get: (r) => numOrBlank(r.r) },
        { colStart: 'K', colEnd: 'L', get: (r) => numOrBlank(r.tl) },
        { colStart: 'M', get: (r) => numOrBlank(r.cl) },
        { colStart: 'N', get: (r) => numOrBlank(r.sect_st_km) },
        { colStart: 'O', colEnd: 'P', get: (r) => numOrBlank(r.sect_ed_km) },
        { colStart: 'Q', colEnd: 'R', get: (r) => numOrBlank(r.sl) },
        { colStart: 'S', get: (r) => numOrBlank(r.slope) },
        { colStart: 'T', colEnd: 'U', get: (r) => numOrBlank(r.wid) },
        { colStart: 'V', get: (r) => numOrBlank(r.line) },
        { colStart: 'W', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 3-2. 교차시설 (gov_xrail) ────────────────────────────────────────
function buildXrailSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('교차시설', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 14, B: 16.16, C: 14, D: 6.83, E: 16.16, F: 14, G: 3.33, H: 12.66,
        J: 4.66, L: 4.66, M: 15.16, N: 42, O: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '3-2. 교차시설', { font: LABEL_FONT }],
        label('A2', null, '1)도로종류'), data('B2', null, v.roadRank),
        label('C2', null, '2)노선명'), data('D2', 'D2:E2', v.routeName),
        label('F2', null, '3)노선번호'), data('G2', 'G2:H2', v.routeNo),
        label('I2', 'I2:J2', '4)구간'), data('K2', 'K2:L2', v.sect),
        label('M2', null, '5)관리기관'), data('N2', null, v.mco),

        label('A3', null, '6)관리번호'),
        label('B3', null, '7)위치(km)'),
        label('C3', 'C3:D3', '8)교차시설명'),
        label('E3', null, '9)교차방식'),
        label('F3', 'F3:G3', '10)교차연장(m)'),
        label('H3', 'H3:I3', '11)교차시설의폭원(m)'),
        label('J3', 'J3:K3', '12)유효높이(m)'),
        label('L3', 'L3:M3', '13)교차각도 (°)'),
        label('N3', null, '14)비고'),
    ]);
    applyRowHeights(ws, 3, { 1: 27 });

    drawDataRows(ws, 4, rows, [
        { colStart: 'B', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'C', colEnd: 'D', get: (r) => real(r.x_name) },
        { colStart: 'E', get: (r) => noCodebook('X_TYPE', r.x_type) },
        { colStart: 'F', colEnd: 'G', get: (r) => numOrBlank(r.len) },
        { colStart: 'H', colEnd: 'I', get: (r) => numOrBlank(r.wid) },
        { colStart: 'J', colEnd: 'K', get: (r) => numOrBlank(r.hit) },
        { colStart: 'L', colEnd: 'M', get: (r) => numOrBlank(r.x_ang) },
        { colStart: 'N', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 3-4. 종단경사 (gov_slope) ────────────────────────────────────────
function buildSlopeSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('종단경사', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 18.66, C: 6.83, E: 16.16, F: 20.83, G: 16.16, H: 10.5, I: 4.66,
        J: 10.5, K: 4.66, L: 6.83, M: 12.66, N: 26.66, O: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '3-4. 종단경사', { font: LABEL_FONT }],
        label('A2', null, '1)도로의 종류'), data('B2', null, v.roadRank),
        label('C2', 'C2:D2', '2)노선명'), data('E2', 'E2:F2', v.routeName),
        label('G2', null, '3)노선번호'), data('H2', 'H2:I2', v.routeNo),
        label('J2', null, '4)구간'), data('K2', 'K2:L2', v.sect),
        label('M2', null, '5)관리기관'), data('N2', null, v.mco),

        label('A3', 'A3:A4', '6)관리번호'),
        label('B3', 'B3:E3', '위치'),
        label('F3', 'F3:F4', '9)경사(%)'),
        label('G3', 'G3:H4', '10)시점지반고(m)'),
        label('I3', 'I3:K4', '11)경사연장(m)'),
        label('L3', 'L3:N4', '12)비고'),
        label('B4', 'B4:C4', '7)시점(km)'),
        label('D4', 'D4:E4', '8)종점(km)'),
    ]);
    applyRowHeights(ws, 4, { 1: 27 });

    drawDataRows(ws, 5, rows, [
        { colStart: 'B', colEnd: 'C', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'D', colEnd: 'E', get: (r) => numOrBlank(r.sect_ed) },
        { colStart: 'F', get: (r) => numOrBlank(r.slope) },
        { colStart: 'G', colEnd: 'H', get: (r) => numOrBlank(r.st_hit) },
        { colStart: 'I', colEnd: 'K', get: (r) => numOrBlank(r.slp_len) },
        { colStart: 'L', colEnd: 'N', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 3-5. 정차대 (gov_stopbay) ────────────────────────────────────────
function buildStopbaySheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('정차대', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 14, B: 12.66, C: 14, D: 15.16, E: 16.16, F: 6.83, H: 15.16, I: 3.33,
        K: 16.16, L: 15.16, M: 8, N: 30.16, O: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '3-5. 정차대', { font: LABEL_FONT }],
        label('A2', null, '1)도로종류'), data('B2', null, v.roadRank),
        label('C2', null, '2)노선명'), data('D2', 'D2:E2', v.routeName),
        label('F2', 'F2:G2', '3)노선번호'), data('H2', null, v.routeNo),
        label('I2', 'I2:J2', '4)구간'), data('K2', null, v.sect),
        label('L2', null, '5)관리기관'), data('M2', 'M2:N2', v.mco),

        label('A3', null, '6)관리번호'),
        label('B3', 'B3:D3', '7)위치(km)'),
        label('E3', 'E3:F3', '8)방향'),
        label('G3', 'G3:I3', '9)연장(m)'),
        label('J3', 'J3:K3', '10)폭(m)'),
        label('L3', 'L3:M3', '11)대기소'),
        label('N3', null, '12)비고'),
    ]);
    applyRowHeights(ws, 3, { 1: 27 });

    drawDataRows(ws, 4, rows, [
        { colStart: 'B', colEnd: 'D', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'E', colEnd: 'F', get: (r) => noCodebook('DIRECTION', r.direction) },
        { colStart: 'G', colEnd: 'I', get: (r) => numOrBlank(r.eqp_len) },
        { colStart: 'J', colEnd: 'K', get: (r) => numOrBlank(r.wid) },
        { colStart: 'L', colEnd: 'M', get: (r) => noCodebook('WAIT', r.wait) },
        { colStart: 'N', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 4-1. 측구(길도랑) (gov_side) ─────────────────────────────────────
function buildSideSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('측구', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 15.16, B: 14, C: 2.16, D: 12.66, E: 16.16, F: 10.5, G: 8, H: 5.83,
        I: 14, J: 2.16, K: 4.66, L: 12.66, M: 16.16, O: 12.66, P: 18.66, Q: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '4. 토공 및 배수조서', { font: LABEL_FONT }],
        ['A2', 'A2:E2', '4-1. 측구(길도랑)', { font: LABEL_FONT }],
        label('A3', null, '1)도로종류'), data('B3', 'B3:C3', v.roadRank),
        label('D3', null, '2)노선명'), data('E3', 'E3:F3', v.routeName),
        label('G3', 'G3:H3', '3)노선번호'), data('I3', 'I3:K3', v.routeNo),
        label('L3', null, '4)구간'), data('M3', null, v.sect),
        label('N3', null, '5)관리기관'), data('O3', 'O3:P3', v.mco),

        label('A4', 'A4:A5', '6)관리번호'),
        label('B4', 'B4:E4', '위치'),
        label('F4', 'F4:G5', '10)구분'),
        label('H4', 'H4:I5', '11)종류'),
        label('J4', 'J4:L5', '12)연장(m)'),
        label('M4', 'M4:N4', '높이'),
        label('O4', 'O4:O5', '15)폭(m)'),
        label('P4', 'P4:P5', '16)비고'),
        label('B5', null, '7)시점(km)'),
        label('C5', 'C5:D5', '8)종점(km)'),
        label('E5', null, '9)방향'),
        label('M5', null, '13)최대(m)'),
        label('N5', null, '14)최소(m)'),
    ]);
    applyRowHeights(ws, 5, { 1: 19.5, 2: 25.5 });

    drawDataRows(ws, 6, rows, [
        { colStart: 'B', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'C', colEnd: 'D', get: (r) => numOrBlank(r.sect_ed) },
        { colStart: 'E', get: (r) => noCodebook('DIRECTION', r.direction) },
        { colStart: 'F', colEnd: 'G', get: (r) => real(r.sd_dev) },
        { colStart: 'H', colEnd: 'I', get: (r) => noCodebook('SIDE_KIND', r.side_kind) },
        { colStart: 'J', colEnd: 'L', get: (r) => numOrBlank(r.eqp_len) },
        { colStart: 'M', get: (r) => numOrBlank(r.hit_max) },
        { colStart: 'N', get: (r) => numOrBlank(r.hit_min) },
        { colStart: 'O', get: (r) => numOrBlank(r.wid) },
        { colStart: 'P', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 4-1. 석축 (gov_stone) ────────────────────────────────────────────
function buildStoneSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('석축', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 14, C: 2.16, D: 12.66, E: 14, F: 10.5, G: 6.83, H: 8, I: 12.66, J: 2.16,
        K: 3.33, L: 4.66, M: 5.83, N: 6.83, O: 11.5, P: 5.83, Q: 12.66, R: 11.5, S: 22, T: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '4-1. 석축', { font: LABEL_FONT }],
        label('A2', null, '1)도로종류'), data('B2', 'B2:C2', v.roadRank),
        label('D2', null, '2)노선명'), data('E2', 'E2:F2', v.routeName),
        label('G2', 'G2:H2', '3)노선번호'), data('I2', null, v.routeNo),
        label('J2', 'J2:L2', '4)구간'), data('M2', 'M2:N2', v.sect),
        label('O2', 'O2:P2', '5)관리기관'), data('Q2', 'Q2:S2', v.mco),

        label('A3', 'A3:A4', '6)관리번호'),
        label('B3', 'B3:E3', '위치'),
        label('F3', 'F3:G4', '10)구분'),
        label('H3', 'H3:J4', '11)종류'),
        label('K3', 'K3:M4', '12)연장(m)'),
        label('N3', 'N3:Q3', '높이'),
        label('R3', 'R3:R4', '15)폭(m)'),
        label('S3', 'S3:S4', '16)비고'),
        label('B4', null, '7)시점(km)'),
        label('C4', 'C4:D4', '8)종점(km)'),
        label('E4', null, '9)방향'),
        label('N4', 'N4:O4', '13)최대(m)'),
        label('P4', 'P4:Q4', '14)최소(m)'),
    ]);
    applyRowHeights(ws, 4, { 1: 27 });

    drawDataRows(ws, 5, rows, [
        { colStart: 'B', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'C', colEnd: 'D', get: (r) => numOrBlank(r.sect_ed) },
        { colStart: 'E', get: (r) => noCodebook('DIRECTION', r.direction) },
        { colStart: 'F', colEnd: 'G', get: (r) => real(r.st_dev) },
        { colStart: 'H', colEnd: 'J', get: (r) => noCodebook('ST_TYPE', r.st_type) },
        { colStart: 'K', colEnd: 'M', get: (r) => numOrBlank(r.eqp_len) },
        { colStart: 'N', colEnd: 'O', get: (r) => numOrBlank(r.hit_max) },
        { colStart: 'P', colEnd: 'Q', get: (r) => numOrBlank(r.hit_min) },
        { colStart: 'R', get: (r) => numOrBlank(r.width) },
        { colStart: 'S', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 4-1. 옹벽 (gov_wall) ─────────────────────────────────────────────
function buildWallSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('옹벽', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 12.66, B: 14, C: 3.33, D: 12.66, E: 11.5, F: 12.66, G: 15.16, H: 5.83,
        J: 6.83, K: 3.33, L: 12.66, M: 15.16, N: 2.16, O: 14, P: 30.16, Q: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '4-1. 옹벽', { font: LABEL_FONT }],
        label('A2', null, '1)도로종류'), data('B2', 'B2:C2', v.roadRank),
        label('D2', null, '2)노선명'), data('E2', 'E2:F2', v.routeName),
        label('G2', null, '3)노선번호'), data('H2', 'H2:I2', v.routeNo),
        label('J2', 'J2:K2', '4)구간'), data('L2', null, v.sect),
        label('M2', 'M2:N2', '5)관리기관'), data('O2', 'O2:P2', v.mco),

        label('A3', 'A3:A4', '6)관리번호'),
        label('B3', 'B3:E3', '위치'),
        label('F3', 'F3:F4', '10)구분'),
        label('G3', 'G3:H4', '11)종류'),
        label('I3', 'I3:J4', '12)연장(m)'),
        label('K3', 'K3:M3', '높이'),
        label('N3', 'N3:O4', '15)폭(m)'),
        label('P3', 'P3:P4', '16)비고'),
        label('B4', null, '7)시점(km)'),
        label('C4', 'C4:D4', '8)종점(km)'),
        label('E4', null, '9)방향'),
        label('K4', 'K4:L4', '13)최대(m)'),
        label('M4', null, '14)최소(m)'),
    ]);
    applyRowHeights(ws, 4, { 1: 27 });

    drawDataRows(ws, 5, rows, [
        { colStart: 'B', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'C', colEnd: 'D', get: (r) => numOrBlank(r.sect_ed) },
        { colStart: 'E', get: (r) => noCodebook('DIRECTION', r.direction) },
        { colStart: 'F', get: (r) => real(r.wall_dev) },
        { colStart: 'G', colEnd: 'H', get: (r) => noCodebook('METHOD', r.method) },
        { colStart: 'I', colEnd: 'J', get: (r) => numOrBlank(r.eqp_len) },
        { colStart: 'K', colEnd: 'L', get: (r) => numOrBlank(r.hit_max) },
        { colStart: 'M', get: (r) => numOrBlank(r.hit_min) },
        { colStart: 'N', colEnd: 'O', get: (r) => numOrBlank(r.width) },
        { colStart: 'P', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 4-2. 배수암거 및 배수관 (gov_box_pipe) ───────────────────────────
function buildBoxPipeSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('배수암거및배수관', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 16.16, C: 2.16, D: 11.5, E: 4.66, F: 10.5, G: 11.5, H: 3.33, I: 11.5,
        J: 2.16, K: 12.66, L: 5.83, N: 8, O: 1.16, P: 10.5, Q: 5.83, U: 20.83, V: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '4-2. 배수암거 및 배수관', { font: LABEL_FONT }],
        label('A2', null, '1)도로종류'), data('B2', 'B2:C2', v.roadRank),
        label('D2', 'D2:E2', '2)노선명'), data('F2', 'F2:G2', v.routeName),
        label('H2', 'H2:J2', '3)노선번호'), data('K2', 'K2:L2', v.routeNo),
        label('M2', 'M2:N2', '4)구간'), data('O2', 'O2:Q2', v.sect),
        label('R2', 'R2:S2', '5)관리기관'), data('T2', 'T2:U2', v.mco),

        label('A3', 'A3:A4', '6)관리번호'),
        label('B3', 'B3:B4', '7)위치(km)'),
        label('C3', 'C3:H3', '규격'),
        label('I3', 'I3:I4', '11)연장(m)'),
        label('J3', 'J3:M3', '재질'),
        label('N3', 'N3:P3', '날개벽'),
        label('Q3', 'Q3:T3', '집수정'),
        label('U3', 'U3:U4', '18)비고'),
        label('C4', 'C4:D4', '8)가로(m)'),
        label('E4', 'E4:F4', '9)세로(m)'),
        label('G4', 'G4:H4', '10)직경(cm)'),
        label('J4', 'J4:K4', '12)관'),
        label('L4', 'L4:M4', '13)면벽'),
        label('N4', 'N4:O4', '14)좌'),
        label('P4', null, '15)우'),
        label('Q4', 'Q4:R4', '16)좌'),
        label('S4', 'S4:T4', '17)우'),
    ]);
    applyRowHeights(ws, 4, { 1: 27 });

    drawDataRows(ws, 5, rows, [
        { colStart: 'B', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'C', colEnd: 'D', get: (r) => numOrBlank(r.hor) },
        { colStart: 'E', colEnd: 'F', get: (r) => numOrBlank(r.ver) },
        { colStart: 'G', colEnd: 'H', get: (r) => numOrBlank(r.dia) },
        { colStart: 'I', get: (r) => numOrBlank(r.eqp_len) },
        { colStart: 'J', colEnd: 'K', get: (r) => noCodebook('EQP_MET', r.eqp_met) },
        { colStart: 'L', colEnd: 'M', get: (r) => noCodebook('EQP_MET1', r.eqp_met1) },
        { colStart: 'N', colEnd: 'O', get: (r) => numOrBlank(r.nal_l) },
        { colStart: 'P', get: (r) => numOrBlank(r.nal_r) },
        { colStart: 'Q', colEnd: 'R', get: (r) => numOrBlank(r.jip_l) },
        { colStart: 'S', colEnd: 'T', get: (r) => numOrBlank(r.jip_r) },
        { colStart: 'U', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 5-1. 중앙분리대 (gov_median_strip) ──────────────────────────────
function buildMedianStripSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('중앙분리대', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 12.66, B: 14, C: 3.33, D: 11.5, E: 2.16, F: 20.83, G: 2.16, H: 14, I: 3.33,
        J: 12.66, K: 4.66, L: 10.5, M: 4.66, N: 10.5, O: 3.33, P: 12.66, Q: 1.16, R: 37.33, S: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '5. 안전신설조서', { font: LABEL_FONT }],
        ['A2', 'A2:E2', '5-1. 중앙분리대', { font: LABEL_FONT }],
        label('A3', null, '1)도로종류'), data('B3', 'B3:C3', v.roadRank),
        label('D3', 'D3:E3', '2)노선명'), data('F3', null, v.routeName),
        label('G3', 'G3:H3', '3)노선번호'), data('I3', 'I3:J3', v.routeNo),
        label('K3', 'K3:L3', '4)구간'), data('M3', 'M3:N3', v.sect),
        label('O3', 'O3:P3', '5)관리기관'), data('Q3', 'Q3:R3', v.mco),

        label('A4', 'A4:A5', '6)관리번호'),
        label('B4', 'B4:D4', '위치'),
        label('E4', 'E4:G5', '9)종류'),
        label('H4', 'H4:I5', '10)연장\n(m)'),
        label('J4', 'J4:K5', '11)분리대폭(cm)'),
        label('L4', 'L4:M5', '12)높이\n(cm)'),
        label('N4', 'N4:O5', '13)등급'),
        label('P4', 'P4:Q5', '14)설치일'),
        label('R4', 'R4:R5', '15)비고'),
        label('B5', null, '7)시점(km)'),
        label('C5', 'C5:D5', '8)종점(km)'),
    ]);
    applyRowHeights(ws, 5, { 1: 19.5, 2: 25.5 });

    drawDataRows(ws, 6, rows, [
        { colStart: 'B', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'C', colEnd: 'D', get: (r) => numOrBlank(r.sect_ed) },
        { colStart: 'E', colEnd: 'G', get: (r) => noCodebook('CEN_TYPE', r.type) },
        { colStart: 'H', colEnd: 'I', get: (r) => numOrBlank(r.len) },
        { colStart: 'J', colEnd: 'K', get: (r) => numOrBlank(r.wid) },
        { colStart: 'L', colEnd: 'M', get: (r) => numOrBlank(r.hit) },
        { colStart: 'N', colEnd: 'O', get: (r) => noCodebook('GRADE', r.grade) },
        { colStart: 'P', colEnd: 'Q', get: (r) => real(r.ins_day) },
        { colStart: 'R', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 5-2. 낙석방지시설 (gov_nori) ─────────────────────────────────────
function buildNoriSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('낙석방지시설', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 15.16, B: 14, C: 1.16, D: 12.66, E: 3.33, G: 12.66, H: 4.66, I: 8, J: 11.5,
        K: 4.66, L: 14, M: 5.83, N: 19.83, O: 14, P: 3.33, Q: 28, R: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '5-2. 낙석방지시설', { font: LABEL_FONT }],
        label('A2', null, '1)도로종류'), data('B2', 'B2:C2', v.roadRank),
        label('D2', 'D2:E2', '2)노선명'), data('F2', 'F2:G2', v.routeName),
        label('H2', 'H2:I2', '3)노선번호'), data('J2', 'J2:K2', v.routeNo),
        label('L2', null, '4)구간'), data('M2', 'M2:N2', v.sect),
        label('O2', null, '5)관리기관'), data('P2', 'P2:Q2', v.mco),

        label('A3', 'A3:A4', '6)관리번호'),
        label('B3', 'B3:F3', '위치'),
        label('G3', 'G3:H4', '10)구분'),
        label('I3', 'I3:J4', '11)종류'),
        label('K3', 'K3:M4', '12)연장(m)'),
        label('N3', 'N3:N4', '13)높이(m)'),
        label('O3', 'O3:P4', '14)설치일'),
        label('Q3', 'Q3:Q4', '15)비고'),
        label('B4', null, '7)시점(km)'),
        label('C4', 'C4:D4', '8)종점(km)'),
        label('E4', 'E4:F4', '9)방향'),
    ]);
    applyRowHeights(ws, 4, { 1: 27 });

    drawDataRows(ws, 5, rows, [
        { colStart: 'B', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'C', colEnd: 'D', get: (r) => numOrBlank(r.sect_ed) },
        { colStart: 'E', colEnd: 'F', get: (r) => noCodebook('DIRECTION', r.direction) },
        { colStart: 'G', colEnd: 'H', get: (r) => real(r.nr_dev) },
        { colStart: 'I', colEnd: 'J', get: (r) => noCodebook('TYPE', r.type) },
        { colStart: 'K', colEnd: 'M', get: (r) => numOrBlank(r.eqp_len) },
        { colStart: 'N', get: (r) => numOrBlank(r.hit) },
        { colStart: 'O', colEnd: 'P', get: (r) => real(r.ins_day) },
        { colStart: 'Q', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 5-7. 방호울타리 (gov_defence) ────────────────────────────────────
function buildDefenceSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('방호울타리', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 12.66, C: 5.83, E: 10.5, F: 2.16, G: 14, H: 4.66, I: 12.66, J: 10.5,
        K: 6.83, L: 3.33, M: 11.5, N: 3.33, P: 6.83, S: 10.5, T: 15.16, U: 16.16, V: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '5-7. 방호울타리', { font: LABEL_FONT }],
        label('A2', null, '1)도로종류'), data('B2', 'B2:C2', v.roadRank),
        label('D2', 'D2:E2', '2)노선명'), data('F2', 'F2:G2', v.routeName),
        label('H2', 'H2:I2', '3)노선번호'), data('J2', 'J2:K2', v.routeNo),
        label('L2', 'L2:N2', '4)구간'), data('O2', 'O2:Q2', v.sect),
        label('R2', 'R2:S2', '5)관리기관'), data('T2', 'T2:U2', v.mco),

        label('A3', 'A3:A4', '6)관리번호'),
        label('B3', 'B3:F3', '위치'),
        label('G3', 'G3:H4', '10)구분'),
        label('I3', 'I3:J4', '11)종류'),
        label('K3', 'K3:L4', '12)연장(m)'),
        label('M3', 'M3:M4', '13)높이(m)'),
        label('N3', 'N3:P4', '14)설치일'),
        label('Q3', 'Q3:R4', '15)등급'),
        label('S3', 'S3:U4', '16)비고'),
        label('B4', null, '7)시점(km)'),
        label('C4', 'C4:D4', '8)종점(km)'),
        label('E4', 'E4:F4', '9)방향'),
    ]);
    applyRowHeights(ws, 4, { 1: 27 });

    drawDataRows(ws, 5, rows, [
        { colStart: 'B', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'C', colEnd: 'D', get: (r) => numOrBlank(r.sect_ed) },
        { colStart: 'E', colEnd: 'F', get: (r) => noCodebook('DIRECTION', r.direction) },
        { colStart: 'G', colEnd: 'H', get: (r) => real(r.df_dev) },
        { colStart: 'I', colEnd: 'J', get: (r) => noCodebook('EQP_KIND', r.eqp_kind) },
        { colStart: 'K', colEnd: 'L', get: (r) => numOrBlank(r.eqp_len) },
        { colStart: 'M', get: (r) => numOrBlank(r.hit) },
        { colStart: 'N', colEnd: 'P', get: (r) => real(r.ins_day) },
        { colStart: 'Q', colEnd: 'R', get: (r) => noCodebook('GRADE', r.grade) },
        { colStart: 'S', colEnd: 'U', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 6-2. 지하매설물 (gov_dip_eqp) ────────────────────────────────────
function buildDipEqpSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('지하매설물', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 12.66, B: 17.33, C: 12.66, D: 6.83, E: 17.33, F: 14, G: 16.16, H: 2.16,
        I: 8, J: 3.33, K: 13.5, L: 15.16, M: 10.5, N: 14, O: 20.83, P: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '6-2. 지하매설물', { font: LABEL_FONT }],
        label('A2', null, '1)도로종류'), data('B2', null, v.roadRank),
        label('C2', null, '2)노선명'), data('D2', 'D2:E2', v.routeName),
        label('F2', null, '3)노선번호'), data('G2', null, v.routeNo),
        label('H2', 'H2:I2', '4)구간'), data('J2', 'J2:K2', v.sect),
        label('L2', null, '5)관리기관'), data('M2', 'M2:O2', v.mco),

        label('A3', 'A3:A4', '6)관리번호'),
        label('B3', 'B3:E3', '위치'),
        label('F3', 'F3:F4', '10)매설물\n종류'),
        label('G3', 'G3:H4', '11)재질'),
        label('I3', 'I3:J4', '12)규격(m)'),
        label('K3', 'K3:K4', '13)매설깊이 (m)'),
        label('L3', 'L3:L4', '14)수량(개)'),
        label('M3', 'M3:M4', '15)연장(m)'),
        label('N3', 'N3:N4', '16)설치일'),
        label('O3', 'O3:O4', '17)비고'),
        label('B4', null, '7)시점(km)'),
        label('C4', 'C4:D4', '8)종점(km)'),
        label('E4', null, '9)방향'),
    ]);
    applyRowHeights(ws, 4, { 1: 27 });

    drawDataRows(ws, 5, rows, [
        { colStart: 'B', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'C', colEnd: 'D', get: (r) => numOrBlank(r.sect_ed) },
        { colStart: 'E', get: (r) => noCodebook('DIRECTION', r.direction) },
        { colStart: 'F', get: (r) => noCodebook('DIP_KIND', r.dip_kind) },
        { colStart: 'G', colEnd: 'H', get: (r) => noCodebook('DIP_MET', r.dip_met) },
        { colStart: 'I', colEnd: 'J', get: (r) => real(r.dip_size) },
        { colStart: 'K', get: (r) => numOrBlank(r.dip_hit) },
        { colStart: 'L', get: (r) => numOrBlank(r.ea) },
        { colStart: 'M', get: (r) => numOrBlank(r.eqp_len) },
        { colStart: 'N', get: (r) => real(r.dip_day) },
        { colStart: 'O', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 6-5. 통로박스 (gov_pathway) ──────────────────────────────────────
function buildPathwaySheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('통로박스', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 12.66, B: 17.33, C: 12.66, D: 6.83, E: 17.33, F: 15.16, G: 3.33, H: 11.5,
        J: 1.16, K: 2.16, L: 11.5, M: 8, O: 5.83, P: 14, Q: 24.5, R: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '6-5. 통로박스', { font: LABEL_FONT }],
        label('A2', null, '1)도로종류'), data('B2', null, v.roadRank),
        label('C2', null, '2)노선명'), data('D2', 'D2:E2', v.routeName),
        label('F2', null, '3)노선번호'), data('G2', 'G2:H2', v.routeNo),
        label('I2', 'I2:J2', '4)구간'), data('K2', 'K2:L2', v.sect),
        label('M2', 'M2:N2', '5)관리기관'), data('O2', 'O2:Q2', v.mco),

        label('A3', 'A3:A4', '6)관리번호'),
        label('B3', 'B3:B4', '7)위치(km)'),
        label('C3', 'C3:E3', '규격'),
        label('F3', 'F3:G4', '10)재질'),
        label('H3', 'H3:K4', '11)설치목적'),
        label('L3', 'L3:M4', '12)배수시설'),
        label('N3', 'N3:O4', '13)연장(m)'),
        label('P3', 'P3:P4', '14)설치일'),
        label('Q3', 'Q3:Q4', '15)비고'),
        label('C4', 'C4:D4', '8)가로(m)'),
        label('E4', null, '9)세로(m)'),
    ]);
    applyRowHeights(ws, 4, { 1: 27 });

    drawDataRows(ws, 5, rows, [
        { colStart: 'B', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'C', colEnd: 'D', get: (r) => numOrBlank(r.hor) },
        { colStart: 'E', get: (r) => numOrBlank(r.ver) },
        { colStart: 'F', colEnd: 'G', get: (r) => noCodebook('MET', r.met) },
        { colStart: 'H', colEnd: 'K', get: (r) => real(r.purpose) },
        { colStart: 'L', colEnd: 'M', get: (r) => noCodebook('PUMP', r.pump) },
        { colStart: 'N', colEnd: 'O', get: (r) => numOrBlank(r.eqp_len) },
        { colStart: 'P', get: (r) => real(r.ins_day) },
        { colStart: 'Q', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 7-1. 실연장 (gov_realnth) ────────────────────────────────────────
function buildRealnthSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('실연장', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 16.16, B: 12.66, C: 5.83, D: 6.83, E: 12.66, G: 10.5, H: 11.5, I: 3.33,
        K: 1.16, L: 4.66, M: 5.83, O: 4.66, P: 10.5, Q: 2.16, S: 8, T: 3.33, U: 10.5, V: 14, W: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '7. 그 밖의 사항에 관한 조서', { font: LABEL_FONT }],
        ['A2', 'A2:E2', '7-1. 실연장', { font: LABEL_FONT }],
        label('A3', null, '1)도로종류'), data('B3', 'B3:C3', v.roadRank),
        label('D3', 'D3:E3', '2)노선명'), data('F3', 'F3:G3', v.routeName),
        label('H3', 'H3:I3', '3)노선번호'), data('J3', 'J3:L3', v.routeNo),
        label('M3', 'M3:N3', '4)구간'), data('O3', 'O3:Q3', v.sect),
        label('R3', 'R3:S3', '5)관리기관'), data('T3', 'T3:V3', v.mco),

        label('A4', 'A4:A6', '6)관리번호'),
        label('B4', 'B4:D4', '위치'),
        label('E4', 'E4:J4', '폭원'),
        label('K4', 'K4:U4', '구성시설별 연장'),
        label('V4', 'V4:V6', '20)비고'),
        label('B5', 'B5:B6', '7)시점(km)'),
        label('C5', 'C5:D6', '8)종점(km)'),
        label('E5', 'E5:E6', '9)계(m)'),
        label('F5', 'F5:F6', '10)차도(m)'),
        label('G5', 'G5:H5', '길어깨(보도)'),
        label('I5', 'I5:J6', '13)중앙분리대\n(m)'),
        label('K5', 'K5:M6', '14)계(m)'),
        label('N5', 'N5:O6', '15)도로(m)'),
        label('P5', 'P5:P6', '16)교량(m)'),
        label('Q5', 'Q5:R6', '17)터널(m)'),
        label('S5', 'S5:T6', '18)광장(m)'),
        label('U5', 'U5:U6', '19)그밖시설 (m)'),
        label('G6', null, '11)좌(m)'),
        label('H6', null, '12)우(m)'),
    ]);
    applyRowHeights(ws, 6, { 1: 19.5, 2: 27 });

    drawDataRows(ws, 7, rows, [
        { colStart: 'B', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'C', colEnd: 'D', get: (r) => numOrBlank(r.sect_ed) },
        { colStart: 'E', get: (r) => numOrBlank(r.wid_ent) },
        { colStart: 'F', get: (r) => numOrBlank(r.wid_road) },
        { colStart: 'G', get: (r) => numOrBlank(r.wid_ft_l) },
        { colStart: 'H', get: (r) => numOrBlank(r.wid_ft_r) },
        { colStart: 'I', colEnd: 'J', get: (r) => numOrBlank(r.wid_set) },
        { colStart: 'K', colEnd: 'M', get: (r) => numOrBlank(r.len_ent) },
        { colStart: 'N', colEnd: 'O', get: (r) => numOrBlank(r.len_road) },
        { colStart: 'P', get: (r) => numOrBlank(r.len_brdg) },
        { colStart: 'Q', colEnd: 'R', get: (r) => numOrBlank(r.len_tunl) },
        { colStart: 'S', colEnd: 'T', get: (r) => numOrBlank(r.len_plaza) },
        { colStart: 'U', get: (r) => numOrBlank(r.len_etc) },
        { colStart: 'V', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 7-2. 도로구역 (gov_landuse) — 필지 단위, 위치(km)/방향 없음 ─────
function buildLanduseSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('도로구역', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 15.16, C: 12.66, D: 6.83, E: 17.33, F: 2.16, G: 12.66, H: 5.83, J: 3.33,
        M: 11.5, N: 2.16, O: 16.16, P: 2.16, Q: 16.16, R: 25.5, S: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '7-2. 도로구역', { font: LABEL_FONT }],
        label('A2', null, '1)도로종류'), data('B2', null, v.roadRank),
        label('C2', null, '2)노선명'), data('D2', 'D2:E2', v.routeName),
        label('F2', 'F2:G2', '3)노선번호'), data('H2', 'H2:I2', v.routeNo),
        label('J2', 'J2:L2', '4)구간'), data('M2', 'M2:N2', v.sect),
        label('O2', null, '5)관리기관'), data('P2', 'P2:R2', v.mco),

        label('A3', 'A3:A4', '6)관리번호'),
        label('B3', 'B3:D4', '7)소재지'),
        label('E3', 'E3:F4', '8)지번'),
        label('G3', 'G3:H4', '9)지목'),
        label('I3', 'I3:M3', '면적(㎡)'),
        label('I4', 'I4:K4', '10)저촉면적'),
        label('L4', 'L4:M4', '11)잔여면적'),
        label('N3', 'N3:P4', '12)소유구분'),
        label('Q3', 'Q3:Q4', '13)소유자'),
        label('R3', 'R3:R4', '14)비고'),
    ]);
    applyRowHeights(ws, 4, { 1: 27 });

    drawDataRows(ws, 5, rows, [
        { colStart: 'B', colEnd: 'D', get: (r) => real(r.address) },
        { colStart: 'E', colEnd: 'F', get: (r) => real(r.sec_adrs) },
        { colStart: 'G', colEnd: 'H', get: (r) => noCodebook('PURPOSE', r.purpose) },
        { colStart: 'I', colEnd: 'K', get: (r) => numOrBlank(r.inarea) },
        { colStart: 'L', colEnd: 'M', get: (r) => numOrBlank(r.out_area) },
        { colStart: 'N', colEnd: 'P', get: (r) => noCodebook('OWN_DIT', r.own_dit) },
        { colStart: 'Q', get: (r) => real(r.owner) },
        { colStart: 'R', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// facilityData2: { xpoints, xrails, slopes, stopbays, sides, stones, walls, boxPipes,
// medianStrips, noris, defences, dipEqps, pathways, realnths, landuses } — 각각 이
// 구간(road_rank/road_no/sect)에 속하는 gov_* 행 배열(officialLedgerZip.js에서 조회).
function buildRemainingSheets(workbook, section, facilityData2) {
    buildXpointSheet(workbook, section, facilityData2.xpoints || []);
    buildXrailSheet(workbook, section, facilityData2.xrails || []);
    buildSlopeSheet(workbook, section, facilityData2.slopes || []);
    buildStopbaySheet(workbook, section, facilityData2.stopbays || []);
    buildSideSheet(workbook, section, facilityData2.sides || []);
    buildStoneSheet(workbook, section, facilityData2.stones || []);
    buildWallSheet(workbook, section, facilityData2.walls || []);
    buildBoxPipeSheet(workbook, section, facilityData2.boxPipes || []);
    buildMedianStripSheet(workbook, section, facilityData2.medianStrips || []);
    buildNoriSheet(workbook, section, facilityData2.noris || []);
    buildDefenceSheet(workbook, section, facilityData2.defences || []);
    buildDipEqpSheet(workbook, section, facilityData2.dipEqps || []);
    buildPathwaySheet(workbook, section, facilityData2.pathways || []);
    buildRealnthSheet(workbook, section, facilityData2.realnths || []);
    buildLanduseSheet(workbook, section, facilityData2.landuses || []);
}

module.exports = { buildRemainingSheets };
