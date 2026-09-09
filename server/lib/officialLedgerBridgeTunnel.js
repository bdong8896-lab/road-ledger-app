// 국토교통부 도로대장 표준서식의 교량(2-1)/터널(2-2) 제원 시트 — 다른 부속시설
// 시트와 달리 "항목 하나 = 반복되는 표의 한 행"이 아니라 "항목 하나 = 페이지
// 전체"인 완전히 다른 레이아웃이라 별도 모듈로 분리했다. 구간에 교량/터널이
// 여러 개면 그 개수만큼 시트 쌍(교량1/교량2, 터널)을 만든다. 하나도 없으면
// 서식만 있는 빈 시트 1개를 만든다(다른 부속시설 시트와 동일한 정책).
//
// 코드값 해석: govCodebook.js로 str_level/re_dia/col_type/col_mat/up_type/
// fen_mat/link/gy_type/gy_water/pl_type/pl_base/edg_type/edg_base/wing_type/
// sep_type/sep_len/crs_type/de_wet/in_de/per_lane/fa_type/met_u/met_d/fl_met/
// ce_met/sidewall/drainage/al_type/et_type/lgt_type/sp_type/cen_type/
// r_s_s_type/sh_u/sh_d를 실제 한글 명칭으로 바꾼다. 전경사진/위치도(73/74번)는
// 이 시스템에 사진 자체가 없어 채울 수 없다 — 서식만 두고 빈칸으로 둔다.
const {
    LABEL_FONT, VALUE_FONT, CENTER_WRAP,
    applyCells, label, data, applyRowHeights, formatRouteNoLabel,
} = require('./officialLedgerForm');
const { BOX_BORDER } = require('./officialLedgerForm');
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
function combine(...parts) {
    return parts.filter((p) => p !== '' && p !== null && p !== undefined).join(' / ');
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

function suffixName(base, index) {
    return index === 0 ? base : `${base}(${index + 1})`;
}

// ── 2-1. 교량 제원 (gov_bridge, 1페이지) ─────────────────────────────
function buildBridge1Sheet(workbook, section, b, sheetName) {
    const ws = workbook.addWorksheet(sheetName, { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        A: 10.5, B: 3.33, C: 11.5, D: 17.33, E: 5.83, F: 2.16, H: 4.66, I: 19.83,
        J: 10.5, K: 12.66, L: 24.5, M: 20.83, N: 29.16, O: 6.83,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '2. 주요시설물 제원', { font: LABEL_FONT }],
        ['A2', 'A2:E2', '2-1. 교량 제원', { font: LABEL_FONT }],
        label('A3', 'A3:C3', '1)관리번호'), data('D3', 'D3:F3', ''), data('G3', 'G3:L3', ''),
        label('M3', null, '2)관리기관'), data('N3', null, v.mco),

        label('A4', 'A4:C4', '3)도로의 종류'), data('D4', null, v.roadRank),
        label('E4', 'E4:G4', '4)노 선 명'), data('H4', 'H4:I4', v.routeName),
        label('J4', 'J4:K4', '5)노 선 번 호'), data('L4', null, v.routeNo),
        label('M4', null, '6)구 간'), data('N4', null, v.sect),

        label('A5', 'A5:C5', '7)교 량 명'), data('D5', 'D5:I5', real(b.brdg_name)),
        label('J5', 'J5:K5', '8)시설물 종별'), data('L5', 'L5:N5', noCodebook('FA_TYPE', b.fa_type)),

        label('A6', 'A6:B7', '위치'),
        label('C6', null, '9)시점(km)'), data('D6', 'D6:I6', numOrBlank(b.sect_st)),
        label('J6', 'J6:K6', '10)소 재 지'), data('L6', 'L6:N6', real(b.address)),
        label('C7', null, '11)종점(km)'), data('D7', 'D7:I7', numOrBlank(b.sect_ed)),
        label('J7', 'J7:K7', '12)상태 등급'), data('L7', null, noCodebook('STR_LEVEL', b.str_level)),
        label('M7', null, '13)진단 결과'), data('N7', null, noCodebook('RE_DIA', b.re_dia)),

        label('A8', 'A8:C8', '14)교량연장(m)'), data('D8', 'D8:E8', numOrBlank(b.brdg_len)),
        label('F8', 'F8:H8', '15)경간 수'), data('I8', null, numOrBlank(b.col_ea)),
        label('J8', 'J8:K8', '16)최대 경간장(m)'), data('L8', null, numOrBlank(b.col_len)),
        label('M8', null, '17)차로 수(상행)'), data('N8', null, numOrBlank(b.lane_u)),

        label('A9', 'A9:C9', '18)총 폭 원(m)'), data('D9', 'D9:E9', numOrBlank(b.width_sum)),
        label('F9', 'F9:H9', '19)차 도 폭'), data('I9', null, numOrBlank(b.car_width)),
        label('J9', 'J9:K9', '20)보 도 폭(m)'), data('L9', null, numOrBlank(b.walk_width)),
        label('M9', null, '21)차로 수(하행)'), data('N9', null, numOrBlank(b.lane_d)),

        label('A10', 'A10:C10', '22)설계활하중'), data('D10', 'D10:E10', noCodebook('DE_WET', b.de_wet)),
        label('F10', 'F10:H10', '23)\n허용통행하중'), data('I10', null, numOrBlank(b.per_wet)),
        label('J10', 'J10:K10', '24)내진설계'), data('L10', null, noCodebook('IN_DE', b.in_de)),
        label('M10', null, '25)경간 구성'), data('N10', null, real(b.col_const)),

        label('A11', 'A11:C11', '26)주경간 형식'), data('D11', 'D11:I11', noCodebook('COL_TYPE', b.col_type)),
        label('J11', 'J11:K11', '27)부경간형식'), data('L11', 'L11:N11', noCodebook('COL_MAT', b.col_mat)),

        label('A12', 'A12:A24', '상부공'),
        label('B12', 'B12:C13', '주 형\n(교량보, 거더)'),
        label('D12', 'D12:E12', '28)간 격(cm)'), data('F12', 'F12:I12', numOrBlank(b.hc_dst)),
        label('J12', 'J12:J22', '하부공'),
        label('K12', 'K12:K15', '교 대'),
        label('L12', null, '40)형 식'), data('M12', 'M12:N12', noCodebook('PL_TYPE', b.pl_type)),

        label('D13', 'D13:E13', '29)높 이(cm)'), data('F13', 'F13:I13', numOrBlank(b.hc_hit)),
        label('L13', null, '41)매립깊이(m)'), data('M13', 'M13:N13', numOrBlank(b.pl_dip)),

        label('B14', 'B14:C15', '상 판'),
        label('D14', 'D14:E14', '30)두 께(cm)'), data('F14', 'F14:I14', numOrBlank(b.up_thick)),
        label('L14', null, '42)총높이(m)'), data('M14', 'M14:N14', numOrBlank(b.pl_hit)),

        label('D15', 'D15:E15', '31)재 료'), data('F15', 'F15:I15', noCodebook('UP_TYPE', b.up_type)),
        label('L15', null, '43)기초형식'), data('M15', 'M15:N15', noCodebook('PL_BASE', b.pl_base)),

        label('B16', 'B16:C18', '난 간'),
        label('D16', 'D16:E16', '32)높 이(cm)'), data('F16', 'F16:I16', numOrBlank(b.fen_hit)),
        label('K16', 'K16:K20', '교 각'),
        label('L16', null, '44)형 식'), data('M16', 'M16:N16', noCodebook('EDG_TYPE', b.edg_type)),

        label('D17', 'D17:E17', '33)연 장(m)'), data('F17', 'F17:I17', numOrBlank(b.fen_len)),
        label('L17', null, '45)매립깊이(m)'), data('M17', 'M17:N17', numOrBlank(b.edg_dip)),

        label('D18', 'D18:E18', '34)재  료'), data('F18', 'F18:I18', noCodebook('FEN_MAT', b.fen_mat)),
        label('L18', null, '46)총높이(m)'), data('M18', 'M18:N18', numOrBlank(b.edg_hit)),

        label('B19', 'B19:C20', '신축 이음\n장치'),
        label('D19', 'D19:E19', '35)형 식'), data('F19', 'F19:I19', noCodebook('LINK', b.link)),
        label('L19', null, '47)기초형식'), data('M19', 'M19:N19', noCodebook('EDG_BASE', b.edg_base)),

        label('D20', 'D20:E20', '36)\n길이(cm)/수량(개)'),
        data('F20', 'F20:I20', combine(numOrBlank(b.link_len), b.link_ea != null ? `${b.link_ea}개` : '')),
        label('L20', null, '48)평수위(m)'), data('M20', 'M20:N20', numOrBlank(b.edg_hrn)),

        label('B21', 'B21:C23', '교 면'),
        label('D21', 'D21:E21', '37)포장재료'), data('F21', 'F21:I21', noCodebook('GY_TYPE', b.gy_type)),
        label('K21', 'K21:K22', '날개벽'),
        label('L21', null, '49)종 류'), data('M21', 'M21:N21', noCodebook('WING_TYPE', b.wing_type)),

        label('D22', 'D22:E22', '38)포장두께(cm)'), data('F22', 'F22:I22', numOrBlank(b.gy_thick)),
        label('L22', null, '50)길 이(m)'), data('M22', 'M22:N22', numOrBlank(b.wing_len)),

        label('D23', 'D23:E23', '39)방수형식'), data('F23', 'F23:I23', noCodebook('GY_WATER', b.gy_water)),
        label('J23', 'J23:L23', '51)점 검 통 로'), data('M23', 'M23:N23', noCodebook('PER_LANE', b.per_lane)),

        label('B24', 'B24:C24', '교좌장치'),
        label('D24', 'D24:E24', '형식 및 종류'),
        data('F24', 'F24:I24', combine(noCodebook('SEP_TYPE', b.sep_type), noCodebook('SEP_LEN', b.sep_len))),
        label('J24', 'J24:L24', '52)교 차 종 류'), data('M24', 'M24:N24', noCodebook('CRS_TYPE', b.crs_type)),
    ]);
    applyRowHeights(ws, 24, { 1: 27, 2: 27 });
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 2-1. 교량 제원 2페이지 (부대시설/공사정보/사진) ──────────────────
function buildBridge2Sheet(workbook, section, b, sheetName) {
    const ws = workbook.addWorksheet(sheetName, { views: [{ showGridLines: false }] });
    setColWidths(ws, { A: 22, B: 23.33, C: 22, D: 23.33, E: 20.83, F: 25.5, G: 19.83, H: 25.5, I: 9.33 });

    applyCells(ws, [
        ['A1', 'A1:B1', '중앙분리대시설', { font: LABEL_FONT }],
        ['C1', 'C1:D1', '차도·보도 분리시설', { font: LABEL_FONT }],
        ['E1', 'E1:F1', '조명시설', { font: LABEL_FONT }],
        ['G1', 'G1:H1', '방음시설', { font: LABEL_FONT }],

        label('A2', null, '54)종 류'), label('B2', null, '55)연 장(m)'),
        label('C2', null, '56)종 류'), label('D2', null, '57)연 장(m)'),
        label('E2', null, '58)종 류'), label('F2', null, '59)수 량(개)'),
        label('G2', null, '60)종 류'), label('H2', null, '61)연 장(m)'),

        data('A3', null, noCodebook('CEN_TYPE', b.cen_type)), data('B3', null, numOrBlank(b.cen_len)),
        data('C3', null, noCodebook('R_S_S_TYPE', b.r_s_s_type)), data('D3', null, numOrBlank(b.r_s_s_len)),
        data('E3', null, noCodebook('LGT_TYPE', b.lgt_type)), data('F3', null, numOrBlank(b.lgt_ea)),
        data('G3', null, noCodebook('SP_TYPE', b.sp_type)), data('H3', null, numOrBlank(b.sp_len)),

        label('A4', null, '62)공사기간\n(개월)'), data('B4', null, numOrBlank(b.period)),
        label('C4', null, '63)착공일'), data('D4', 'D4:E4', real(b.st_day)),
        label('F4', null, '64)준공일'), data('G4', 'G4:H4', real(b.ed_day)),

        label('A5', null, '65)시 행 자'), data('B5', null, real(b.consthall)),
        label('C5', null, '66)시공자'), data('D5', null, real(b.const)),
        label('E5', null, '67)설계자'), data('F5', null, real(b.designer)),
        label('G5', null, '68)감리자'), data('H5', null, real(b.supervisor)),

        label('A6', null, '69)총사업비\n(천원)'), data('B6', null, numOrBlank(b.total_ct)),
        label('C6', null, '70)설계비\n(천원)'), data('D6', null, numOrBlank(b.dgn_ct)),
        label('E6', null, '71)공사비\n(천원)'), data('F6', null, numOrBlank(b.work_ct)),
        label('G6', null, '72)감리비\n(천원)'), data('H6', null, numOrBlank(b.su_ct)),

        label('A7', 'A7:D7', '73)전경사진'),
        label('E7', 'E7:H7', '74)위치도'),
        data('A8', 'A8:D8', ''), data('E8', 'E8:H8', ''),
    ]);
    applyRowHeights(ws, 8, { 1: 26.1, 2: 26.1, 3: 26.1, 4: 26.1, 5: 26.1, 6: 26.1, 7: 26.1, 8: 265.7 });
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// ── 2-2. 터널 제원 (gov_tunnel) ──────────────────────────────────────
function buildTunnelSheet(workbook, section, t, sheetName) {
    const ws = workbook.addWorksheet(sheetName, { views: [{ showGridLines: false }] });
    setColWidths(ws, {
        B: 5.83, C: 4.66, D: 2.16, E: 8, F: 10.5, G: 6.83, H: 12.66, I: 1.16, J: 4.66,
        K: 18.66, L: 16.16, M: 6.83, N: 18.66, O: 5.83, P: 2.16, Q: 11.5, R: 6.83, S: 4.66, T: 6.83, U: 17.33,
    });
    const v = infoLineCells(section);
    applyCells(ws, [
        ['A1', 'A1:E1', '2-2. 터널 제원', { font: LABEL_FONT }],
        label('A2', 'A2:D2', '1)관리번호'), data('E2', 'E2:G2', ''), data('H2', 'H2:O2', ''),
        label('P2', 'P2:R2', '2)관리기관'), data('S2', 'S2:U2', v.mco),

        label('A3', 'A3:D3', '3)도로종류'), data('E3', 'E3:G3', v.roadRank),
        label('H3', null, '4)노선명'), data('I3', 'I3:K3', v.routeName),
        label('L3', 'L3:M3', '5)노선번호'), data('N3', 'N3:O3', v.routeNo),
        label('P3', 'P3:R3', '6)구간'), data('S3', 'S3:U3', v.sect),

        label('A4', 'A4:D4', '7)터널명'), data('E4', 'E4:K4', real(t.tun_name)),
        label('L4', 'L4:M4', '8)시설물종별'), data('N4', 'N4:U4', noCodebook('FA_TYPE', t.fa_type)),

        label('A5', 'A5:A6', '위치'),
        label('B5', 'B5:D5', '9)시점(km)'), data('E5', 'E5:K5', numOrBlank(t.sect_st)),
        label('L5', 'L5:M5', '10)소재지'), data('N5', 'N5:U5', real(t.address)),
        label('B6', 'B6:D6', '11)종점(km)'), data('E6', 'E6:K6', numOrBlank(t.sect_ed)),
        label('L6', 'L6:M6', '12)상태등급'), data('N6', 'N6:O6', noCodebook('STR_LEVEL', t.str_level)),
        label('P6', 'P6:R6', '13)진단결과'), data('S6', 'S6:U6', noCodebook('RE_DIA', t.re_dia)),

        label('A7', 'A7:B8', '구 분'),
        label('C7', 'C7:E8', '14)연 장(m)'),
        label('F7', 'F7:K7', '폭원'),
        label('L7', 'L7:M8', '18)높 이(m)'),
        label('N7', 'N7:N8', '19)통행제한높이 (m)'),
        label('O7', 'O7:Q8', '20)형 상'),
        label('R7', 'R7:T8', '21)차로 수(차로)'),
        label('U7', 'U7:U8', '22)공 법'),
        label('F8', 'F8:G8', '15)계(m)'),
        label('H8', 'H8:J8', '16)차 도(m)'),
        label('K8', null, '17)보 도(m)'),

        label('A9', 'A9:B9', '23)상행'),
        data('C9', 'C9:E9', numOrBlank(t.len_u)), data('F9', 'F9:G9', numOrBlank(t.wid_au)),
        data('H9', 'H9:J9', numOrBlank(t.wid_cu)), data('K9', null, numOrBlank(t.wid_wu)),
        data('L9', 'L9:M9', numOrBlank(t.hit_u)), data('N9', null, numOrBlank(t.ph_u)),
        data('O9', 'O9:Q9', noCodebook('SH_U', t.sh_u)), data('R9', 'R9:T9', numOrBlank(t.lane_u)),
        data('U9', null, noCodebook('MET_U', t.met_u)),

        label('A10', 'A10:B10', '24)하행'),
        data('C10', 'C10:E10', numOrBlank(t.len_d)), data('F10', 'F10:G10', numOrBlank(t.wid_ad)),
        data('H10', 'H10:J10', numOrBlank(t.wid_cd)), data('K10', null, numOrBlank(t.wid_wd)),
        data('L10', 'L10:M10', numOrBlank(t.hit_d)), data('N10', null, numOrBlank(t.ph_d)),
        data('O10', 'O10:Q10', noCodebook('SH_D', t.sh_d)), data('R10', 'R10:T10', numOrBlank(t.lane_d)),
        data('U10', null, noCodebook('MET_D', t.met_d)),

        label('A11', 'A11:C11', '구분'),
        label('D11', 'D11:F11', '25)바 닥'), label('G11', 'G11:I11', '26)천 정'),
        label('J11', 'J11:K11', '27)측 벽'),
        label('L11', 'L11:M11', '28)종단경사(%)'), data('N11', 'N11:P11', numOrBlank(t.ver_s)),
        label('Q11', 'Q11:S11', '29)곡선반경(m)'), data('T11', 'T11:U11', numOrBlank(t.cur_r)),

        label('A12', 'A12:C12', '30)두 께(cm)'),
        data('D12', 'D12:F12', numOrBlank(t.fl_thick)), data('G12', 'G12:I12', numOrBlank(t.ce_thick)),
        data('J12', 'J12:K12', numOrBlank(t.side_thick)),
        label('L12', 'L12:M12', '31)라디오방송설비'), data('N12', 'N12:P12', ''),
        label('Q12', 'Q12:S12', '32)배수시설'), data('T12', 'T12:U12', noCodebook('DRAINAGE', t.drainage)),

        label('A13', 'A13:C13', '33)재 질'),
        data('D13', 'D13:F13', noCodebook('FL_MET', t.fl_met)), data('G13', 'G13:I13', noCodebook('CE_MET', t.ce_met)),
        data('J13', 'J13:K13', noCodebook('SIDEWALL', t.sidewall)),
        label('L13', 'L13:M13', '34)비상전화(대)'), data('N13', 'N13:P13', ''),
        label('Q13', 'Q13:S13', '35)환기설비'), data('T13', 'T13:U13', ''),

        label('A14', 'A14:C14', '구분'),
        label('D14', 'D14:F14', '36)방재시설'), label('G14', 'G14:I14', '37)조명시설'),
        label('J14', 'J14:K14', '38)소화설비'), label('L14', 'L14:M14', '39)경보설비'),
        data('N14', 'N14:P14', combine(noCodebook('AL_TYPE', t.al_type), t.al_ea != null ? `${t.al_ea}개` : '')),
        label('Q14', 'Q14:S14', '40)그 밖의 설비'), data('T14', 'T14:U14', real(t.etc_eq)),

        label('A15', 'A15:C15', '41)종 류'),
        data('D15', 'D15:F15', ''), data('G15', 'G15:I15', noCodebook('LGT_TYPE', t.lgt_type)),
        data('J15', 'J15:K15', noCodebook('ET_TYPE', t.et_type)),
        label('L15', 'L15:P15', '42)차량 대피시설 유무'), data('Q15', 'Q15:U15', ''),

        label('A16', 'A16:C16', '43)수 량\n(개)'),
        data('D16', 'D16:F16', ''), data('G16', 'G16:I16', numOrBlank(t.lgt_ea)),
        data('J16', 'J16:K16', numOrBlank(t.et_ea)),
        label('L16', 'L16:P16', '44)무정전 시스템 유무'), data('Q16', 'Q16:U16', ''),

        label('A17', 'A17:C17', '45)공사기간\n(개월)'), data('D17', 'D17:F17', numOrBlank(t.period)),
        label('G17', 'G17:I17', '46)착공일'), data('J17', 'J17:M17', real(t.st_day)),
        label('N17', 'N17:P17', '47)준공일'), data('Q17', 'Q17:U17', real(t.end_day)),

        label('A18', 'A18:C18', '48)시 행 자'), data('D18', 'D18:F18', real(t.consthall)),
        label('G18', 'G18:I18', '49)시 공 자'), data('J18', 'J18:K18', real(t.const)),
        label('L18', 'L18:M18', '50)설 계 자'), data('N18', 'N18:P18', real(t.designer)),
        label('Q18', 'Q18:S18', '51)감 리 자'), data('T18', 'T18:U18', real(t.supervisor)),

        label('A19', 'A19:C19', '52)총사업비\n(천원)'), data('D19', 'D19:F19', numOrBlank(t.total_ct)),
        label('G19', 'G19:I19', '53)설 계 비\n(천원)'), data('J19', 'J19:K19', numOrBlank(t.dgn_ct)),
        label('L19', 'L19:M19', '54)공 사 비\n(천원)'), data('N19', 'N19:P19', numOrBlank(t.work_ct)),
        label('Q19', 'Q19:S19', '55)감 리 비\n(천원)'), data('T19', 'T19:U19', numOrBlank(t.su_ct)),

        label('A20', 'A20:C20', '비고'), data('D20', 'D20:U20', real(t.remark)),
    ]);
    applyRowHeights(ws, 20, { 1: 27, 20: 45.2 });
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// bridges: gov_bridge 행 배열, tunnels: gov_tunnel 행 배열 — 이 구간에 속하는 것만
// (officialLedgerZip.js에서 (road_rank, road_no, sect)로 조회).
function buildBridgeTunnelSheets(workbook, section, bridges, tunnels) {
    const bridgeList = bridges.length ? bridges : [{}];
    bridgeList.forEach((b, i) => {
        buildBridge1Sheet(workbook, section, b, suffixName('교량1', i));
        buildBridge2Sheet(workbook, section, b, suffixName('교량2', i));
    });
    const tunnelList = tunnels.length ? tunnels : [{}];
    tunnelList.forEach((t, i) => {
        buildTunnelSheet(workbook, section, t, suffixName('터널', i));
    });
}

module.exports = { buildBridgeTunnelSheets };
