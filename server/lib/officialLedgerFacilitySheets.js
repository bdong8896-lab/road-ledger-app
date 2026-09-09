// 국토교통부 도로대장 표준서식의 부속시설 시트(표지/가로등/신호등/방음시설/가로수)를
// 남양203.xlsx에서 실측한 셀 좌표·병합 그대로 그린다. officialLedgerForm.js의
// 총괄 시트와 같은 방식(정해진 위치에 정해진 라벨, 값만 구간별로 채움).
//
// 코드값 해석: 2025_도로대장공간정보_공통입력코드정의서_v2.6.xlsx(국토교통부,
// 장성군 제공)에서 뽑은 govCodebook.js로 direction/sb_kind/sb_name/pole_type/
// dun_type/dun_mat/lgt_type/lgt_wgt/신호등종류/설치형식/방음시설종류/가로수종류를
// 실제 한글 명칭으로 바꾼다. 코드북에 없는 값(지역 확장 코드 등)만 예외적으로
// "코드값 (코드북 없음)"으로 표시해 미해석 값임을 표시한다.
const {
    THIN, BOX_BORDER, LABEL_FONT, VALUE_FONT, CENTER_WRAP,
    applyCells, label, data, applyRowHeights, formatRouteNoLabel,
} = require('./officialLedgerForm');
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

// columns: [{ colStart, colEnd|null, get(rec) }]. rows가 비어 있으면 빈 줄 1개를 그려
// 서식이 안 채워진 채로 뜨는 것을 막는다(부속시설이 없는 구간이라는 것도 서식으로 보여줌).
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
    return startRow + count - 1; // 마지막으로 쓴 행 번호
}

function setColWidths(ws, widths) {
    Object.entries(widths).forEach(([letter, w]) => {
        ws.getColumn(letter).width = w;
    });
}

function infoLineCells(section) {
    // 모든 부속시설 시트에 공통인 "1)도로종류~5)관리기관" 정보 — 값은 같지만
    // 시트마다 라벨/값 칸의 폭(열 개수)이 달라서 좌표는 시트별로 따로 넘겨받는다.
    return {
        roadRank: section.road_rank_name || '',
        routeName: section.route_name || '',
        routeNo: formatRouteNoLabel(section.route_no),
        sect: section.sect ? Number(section.sect) : '',
        mco: section.mco_name || '',
    };
}

// ── 5-3. 표지 (gov_sign) ─────────────────────────────────────────────
function buildSignSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('표지', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 14, B: 17.33, C: 11.5, D: 15.16, F: 8, G: 6.83, H: 15.16, I: 3.33,
        J: 6.83, K: 11.5, L: 1.16, M: 16.16, N: 1.16, O: 15.16, P: 29.16, Q: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '5-3. 표지', { font: LABEL_FONT }],
        label('A2', null, '1)도로종류'), data('B2', null, v.roadRank),
        label('C2', null, '2)노선명'), data('D2', 'D2:E2', v.routeName),
        label('F2', 'F2:G2', '3)노선번호'), data('H2', null, v.routeNo),
        label('I2', 'I2:J2', '4)구간'), data('K2', 'K2:L2', v.sect),
        label('M2', 'M2:N2', '5)관리기관'), data('O2', 'O2:P2', v.mco),

        label('A3', 'A3:A4', '6)관리번호'),
        label('B3', 'B3:D3', '위치'),
        label('E3', 'E3:F4', '9)종류'),
        label('G3', 'G3:K4', '10)명칭'),
        label('L3', 'L3:M4', '11)지주형식'),
        label('N3', 'N3:O4', '12)설치일'),
        label('P3', 'P3:P4', '13)비고'),
        label('B4', null, '7)지점(km)'),
        label('C4', 'C4:D4', '8)방향'),
    ]);
    applyRowHeights(ws, 4, { 1: 27 });

    drawDataRows(ws, 5, rows, [
        { colStart: 'B', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'C', colEnd: 'D', get: (r) => noCodebook('DIRECTION', r.direction) },
        { colStart: 'E', colEnd: 'F', get: (r) => noCodebook('SB_KIND', r.sb_kind) },
        { colStart: 'G', colEnd: 'K', get: (r) => noCodebook('SB_NAME', r.sb_name) },
        { colStart: 'L', colEnd: 'M', get: (r) => noCodebook('POLE_TYPE', r.pole_type) },
        { colStart: 'N', colEnd: 'O', get: (r) => real(r.inst_day) },
        { colStart: 'P', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 5-5. 가로등 (gov_street_light) ──────────────────────────────────
function buildStreetLightSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('가로등', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 12.66, B: 11.5, C: 5.83, E: 6.83, F: 4.66, G: 19.83, H: 15.16, I: 4.66,
        J: 10.5, K: 5.83, L: 4.66, M: 12.66, N: 3.33, O: 14, P: 8, Q: 14, R: 22, S: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '5-5. 가로등', { font: LABEL_FONT }],
        label('A2', null, '1)도로종류'), data('B2', 'B2:C2', v.roadRank),
        label('D2', 'D2:E2', '2)노선명'), data('F2', 'F2:G2', v.routeName),
        label('H2', null, '3)노선번호'), data('I2', 'I2:J2', v.routeNo),
        label('K2', 'K2:L2', '4)구간'), data('M2', null, v.sect),
        label('N2', 'N2:O2', '5)관리기관'), data('P2', 'P2:R2', v.mco),

        label('A3', 'A3:A4', '6)관리번호'),
        label('B3', 'B3:F3', '위치'),
        label('G3', 'G3:G4', '10)등주형식'),
        label('H3', 'H3:I4', '11)등주재질'),
        label('J3', 'J3:L4', '12)광원종류'),
        label('M3', 'M3:N4', '13)광원용량(w)'),
        label('O3', 'O3:P4', '14)등기구의 수량(개)'),
        label('Q3', 'Q3:Q4', '15)설치일'),
        label('R3', 'R3:R4', '16)비고'),
        label('B4', null, '7)시점(km)'),
        label('C4', 'C4:D4', '8)종점(km)'),
        label('E4', 'E4:F4', '9)방향'),
    ]);
    applyRowHeights(ws, 4, { 1: 27 });

    drawDataRows(ws, 5, rows, [
        { colStart: 'B', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'C', colEnd: 'D', get: (r) => numOrBlank(r.sect_ed) },
        { colStart: 'E', colEnd: 'F', get: (r) => noCodebook('DIRECTION', r.direction) },
        { colStart: 'G', get: (r) => noCodebook('DUN_TYPE', r.dun_type) },
        { colStart: 'H', colEnd: 'I', get: (r) => noCodebook('DUN_MAT', r.dun_mat) },
        { colStart: 'J', colEnd: 'L', get: (r) => noCodebook('LGT_TYPE', r.lgt_type) },
        { colStart: 'M', colEnd: 'N', get: (r) => noCodebook('LGT_WGT', r.lgt_wgt) },
        { colStart: 'O', colEnd: 'P', get: (r) => numOrBlank(r.lgt_num) },
        { colStart: 'Q', get: (r) => real(r.ins_day) },
        { colStart: 'R', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 5-6. 신호등 (gov_signal_lamp) ───────────────────────────────────
function buildSignalLampSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('신호등', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 12.66, B: 18.66, C: 11.5, D: 10.5, E: 14, F: 15.16, H: 5.83, I: 4.66,
        J: 6.83, K: 5.83, L: 17.33, M: 1.16, N: 43.16, O: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '5-6. 신호등', { font: LABEL_FONT }],
        label('A2', null, '1)도로종류'), data('B2', null, v.roadRank),
        label('C2', null, '2)노선명'), data('D2', 'D2:E2', v.routeName),
        label('F2', null, '3)노선번호'), data('G2', null, v.routeNo),
        label('H2', 'H2:I2', '4)구간'), data('J2', 'J2:K2', v.sect),
        label('L2', null, '5)관리기관'), data('M2', 'M2:N2', v.mco),

        label('A3', 'A3:A4', '6)관리번호'),
        label('B3', 'B3:D3', '위치'),
        label('E3', 'E3:F4', '9)종류'),
        label('G3', 'G3:J4', '10)설치형식'),
        label('K3', 'K3:M4', '11)설치일'),
        label('N3', 'N3:N4', '12)비고'),
        label('B4', null, '7)지점(km)'),
        label('C4', 'C4:D4', '8)방향'),
    ]);
    applyRowHeights(ws, 4, { 1: 27 });

    drawDataRows(ws, 5, rows, [
        { colStart: 'B', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'C', colEnd: 'D', get: (r) => noCodebook('DIRECTION', r.direction) },
        { colStart: 'E', colEnd: 'F', get: (r) => noCodebook('TYPE', r.type) },
        { colStart: 'G', colEnd: 'J', get: (r) => noCodebook('INS_TYPE', r.ins_type) },
        { colStart: 'K', colEnd: 'M', get: (r) => real(r.ins_day) },
        { colStart: 'N', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 6-1. 방음시설 (gov_sound_proofing) ──────────────────────────────
function buildSoundProofingSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('방음시설', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 12.66, B: 17.33, C: 12.66, D: 5.83, E: 18.66, F: 15.16, G: 6.83, H: 8,
        J: 1.16, K: 8, L: 4.66, M: 15.16, N: 2.16, O: 12.66, P: 31.33, Q: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '6. 부대시설조서', { font: LABEL_FONT }],
        ['A2', 'A2:E2', '6-1. 방음시설', { font: LABEL_FONT }],
        label('A3', null, '1)도로종류'), data('B3', null, v.roadRank),
        label('C3', null, '2)노선명'), data('D3', 'D3:E3', v.routeName),
        label('F3', null, '3)노선번호'), data('G3', 'G3:H3', v.routeNo),
        label('I3', 'I3:J3', '4)구간'), data('K3', 'K3:L3', v.sect),
        label('M3', 'M3:N3', '5)관리기관'), data('O3', 'O3:P3', v.mco),

        label('A4', 'A4:A5', '6)관리번호'),
        label('B4', 'B4:E4', '위치'),
        label('F4', 'F4:G5', '10)구분'),
        label('H4', 'H4:K5', '11)종류'),
        label('L4', 'L4:M5', '12)높이(m)'),
        label('N4', 'N4:O5', '13)설치일'),
        label('P4', 'P4:P5', '14)비고'),
        label('B5', null, '7)시점(km)'),
        label('C5', 'C5:D5', '8)종점(km)'),
        label('E5', null, '9)방향'),
    ]);
    applyRowHeights(ws, 5, { 1: 27 });

    drawDataRows(ws, 6, rows, [
        { colStart: 'B', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'C', colEnd: 'D', get: (r) => numOrBlank(r.sect_ed) },
        { colStart: 'E', get: (r) => noCodebook('DIRECTION', r.direction) },
        { colStart: 'F', colEnd: 'G', get: (r) => real(r.sp_dev) },
        { colStart: 'H', colEnd: 'K', get: (r) => noCodebook('SP_TYPE', r.type) },
        { colStart: 'L', colEnd: 'M', get: (r) => numOrBlank(r.hit) },
        { colStart: 'N', colEnd: 'O', get: (r) => real(r.ins_day) },
        { colStart: 'P', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 6-1. 가로수 (gov_street_tree) ───────────────────────────────────
function buildStreetTreeSheet(workbook, section, rows) {
    const ws = workbook.addWorksheet('가로수', { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 12.66, B: 17.33, C: 12.66, D: 6.83, E: 17.33, F: 15.16, G: 8, H: 6.83,
        J: 3.33, K: 8, L: 5.83, M: 14, N: 2.16, O: 17.33, P: 26.66, Q: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '6-1. 가로수', { font: LABEL_FONT }],
        label('A2', null, '1)도로종류'), data('B2', null, v.roadRank),
        label('C2', null, '2)노선명'), data('D2', 'D2:E2', v.routeName),
        label('F2', null, '3)노선번호'), data('G2', 'G2:H2', v.routeNo),
        label('I2', 'I2:J2', '4)구간'), data('K2', 'K2:L2', v.sect),
        label('M2', 'M2:N2', '5)관리기관'), data('O2', 'O2:P2', v.mco),

        label('A3', 'A3:A4', '6)관리번호'),
        label('B3', 'B3:E3', '위치'),
        label('F3', 'F3:G4', '10)구분'),
        label('H3', 'H3:K4', '11)종류'),
        label('L3', 'L3:M4', '12)수량(개)'),
        label('N3', 'N3:O4', '13)식재일'),
        label('P3', 'P3:P4', '14)비고'),
        label('B4', null, '7)시점(km)'),
        label('C4', 'C4:D4', '8)종점(km)'),
        label('E4', null, '9)방향'),
    ]);
    applyRowHeights(ws, 4, { 1: 27 });

    drawDataRows(ws, 5, rows, [
        { colStart: 'B', get: (r) => numOrBlank(r.sect_st) },
        { colStart: 'C', colEnd: 'D', get: (r) => numOrBlank(r.sect_ed) },
        { colStart: 'E', get: (r) => noCodebook('DIRECTION', r.direction) },
        { colStart: 'F', colEnd: 'G', get: (r) => real(r.st_dev) },
        { colStart: 'H', colEnd: 'K', get: (r) => noCodebook('TYPE', r.type) },
        { colStart: 'L', colEnd: 'M', get: (r) => numOrBlank(r.hit) },
        { colStart: 'N', colEnd: 'O', get: (r) => real(r.ins_day) },
        { colStart: 'P', get: (r) => real(r.remark) },
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// facilityData: { signs, streetLights, signalLamps, soundProofings, streetTrees } — 각각
// 이 구간(road_rank/road_no/sect)에 속하는 gov_* 행 배열(officialLedgerZip.js에서 조회).
function buildFacilitySheets(workbook, section, facilityData) {
    buildSignSheet(workbook, section, facilityData.signs || []);
    buildStreetLightSheet(workbook, section, facilityData.streetLights || []);
    buildSignalLampSheet(workbook, section, facilityData.signalLamps || []);
    buildSoundProofingSheet(workbook, section, facilityData.soundProofings || []);
    buildStreetTreeSheet(workbook, section, facilityData.streetTrees || []);
}

module.exports = { buildFacilitySheets };
