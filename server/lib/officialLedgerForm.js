// 국토교통부 도로대장 표준서식(총괄 1,2페이지)을 exceljs로 그대로 그린다.
// 화성시 농어촌도로대장 조서(남양203.xlsx)를 열어 셀 좌표·병합·라벨을 실측해
// 그대로 옮겼다 — 실제 관공서에 내는 서식지와 같은 모양을 목표로 한다.
//
// 값의 출처는 두 곳이다: road_sections(우리 시스템의 등록/수정 화면이 쓰는
// 마스터 레코드 — 관리기관/도로등급/노선명/노선번호/구간/시점/종점/연장/폭원)와
// gov_section(GOV_LAYER_MAP A0020000, "01.도로대장총괄" SHP 원본을 그대로 적재한
// 테이블 — 나머지 numbered 항목 대부분이 여기 있다: 노선지정일/도로구역결정일/
// 접도구역지정일/지적고시일, 전용·중용·통행불능연장, 포장/비포장/미개통 세부,
// 터널·교량 종류별 개소·연장, 폭원 세부(중앙분리대/길어깨), 포장두께, 차로수별
// 연장, 차도/길어깨/자전거도로 좌우, 도로부지면적, 곡선반경, 교차개소, 종단경사,
// 유료도로 정보). road_sections에는 애초에 이 필드들 자체가 없어 예전엔 전부
// 빈칸으로 뒀는데, gov_section을 (road_rank, road_no, sect) 업무키로 조회하면
// 채울 수 있다 — officialLedgerZip.js가 이 조회를 해서 govSection으로 넘겨준다.
// govSection이 없으면(그 구간에 대한 SHP 총괄 레코드가 아예 없을 때)만 빈�칸으로 둔다.

const THIN = { style: 'thin', color: { argb: 'FF808080' } };
const BOX_BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const LABEL_FONT = { name: 'Malgun Gothic', size: 9, bold: true };
const VALUE_FONT = { name: 'Malgun Gothic', size: 9 };
const TITLE_FONT = { name: 'Malgun Gothic', size: 16, bold: true };
const SECTION_FONT = { name: 'Malgun Gothic', size: 11, bold: true };
const CENTER_WRAP = { vertical: 'middle', horizontal: 'center', wrapText: true };
const LEFT_MID = { vertical: 'middle', horizontal: 'left', wrapText: true };

// cells: [ref, merge|null, value|undefined, { font, align, fill }?]
function applyCells(ws, cells) {
    cells.forEach(([ref, merge, value, opts = {}]) => {
        if (merge) ws.mergeCells(merge);
        const cell = ws.getCell(ref);
        if (value !== undefined) cell.value = value;
        cell.font = opts.font || VALUE_FONT;
        cell.alignment = opts.align || CENTER_WRAP;
        cell.border = BOX_BORDER;
        if (opts.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };
    });
}

const LABEL_FILL = 'FFF2F2F2';
function label(ref, merge, text) {
    return [ref, merge, text, { font: LABEL_FONT, fill: LABEL_FILL }];
}
function data(ref, merge, value) {
    return [ref, merge, value, { font: VALUE_FONT }];
}

// "제 0000 호" 형식 — 노선번호는 road_sections엔 그냥 숫자 문자열(예: "0008")로
// 들어있어서 서식 원본(남양203.xlsx의 "제 0203 호")과 같은 표기로 바꿔준다.
function formatRouteNoLabel(routeNo) {
    if (!routeNo) return '';
    return `제 ${routeNo} 호`;
}

// 원본(남양203.xlsx)에서 실측한 행 높이 — 기본 엑셀 행높이(약 15pt)로는
// 줄바꿈(\n)이 들어간 2줄짜리 라벨(예: "100m 이상\n200m 미만")이 잘려 보여서
// 반드시 이 높이들을 그대로 적용해야 한다.
function applyRowHeights(ws, maxRow, tallRows) {
    for (let r = 1; r <= maxRow; r++) {
        ws.getRow(r).height = tallRows[r] || 23.1;
    }
}

// gs: gov_section 행(없을 수 있음 — 그 구간의 SHP 총괄 레코드가 아예 없는 경우).
function gnum(gs, field) {
    if (!gs || gs[field] === null || gs[field] === undefined || gs[field] === '') return '';
    return Number(gs[field]);
}
function gstr(gs, field) {
    if (!gs || gs[field] === null || gs[field] === undefined) return '';
    return gs[field];
}

function buildSummarySheet1(workbook, section, gs) {
    const ws = workbook.addWorksheet('도로대장총괄1', { views: [{ showGridLines: false }] });
    for (let c = 1; c <= 34; c++) ws.getColumn(c).width = 4.2;
    applyRowHeights(ws, 24, { 1: 27, 2: 27, 19: 30 });

    applyCells(ws, [
        ['A1', 'A1:AH1', '도 로 대 장', { font: TITLE_FONT, align: CENTER_WRAP }],
        ['A2', 'A2:B2', '1. 총괄', { font: SECTION_FONT, align: { vertical: 'middle', horizontal: 'left' } }],

        label('A3', 'A3:D3', '1)관리번호'),
        data('E3', 'E3:H3', ''),
        label('I3', 'I3:Z3', ''), // 실측 서식엔 이 구간이 비어있어 라벨 없이 병합만
        label('AA3', 'AA3:AD3', '2)관리기관'),
        data('AE3', 'AE3:AH3', section.mco_name || ''),

        label('A4', 'A4:D4', '3)도로의 종류'),
        data('E4', 'E4:H4', section.road_rank_name || ''),
        label('I4', 'I4:K4', '4)노 선 명'),
        data('L4', 'L4:O4', section.route_name || ''),
        label('P4', 'P4:T4', '5)노선번호'),
        data('U4', 'U4:Z4', formatRouteNoLabel(section.route_no)),
        label('AA4', 'AA4:AD4', '6)구 간'),
        data('AE4', 'AE4:AH4', section.sect ? Number(section.sect) : ''),

        label('A5', 'A5:H5', '7)노선지정(인정)일'),
        data('I5', 'I5:O5', gstr(gs, 'dsgdate')),
        label('P5', 'P5:Z5', '8)도로구역결정(변경)일'),
        data('AA5', 'AA5:AH5', gstr(gs, 'j_date')),
        label('A6', 'A6:H6', '9)접도구역 지정일'),
        data('I6', 'I6:O6', gstr(gs, 'd_date')),
        label('P6', 'P6:Z6', '10)지적 고시일'),
        data('AA6', 'AA6:AH6', gstr(gs, 'jj_date')),

        label('A7', 'A7:C8', '위\n치'),
        label('D7', 'D7:F7', '11)시 점'),
        data('G7', 'G7:O7', section.s_point || ''),
        label('P7', 'P7:V8', '13)주요 통과지'),
        data('W7', 'W7:AH8', gstr(gs, 'impopass')),
        label('D8', 'D8:F8', '12)종 점'),
        data('G8', 'G8:O8', section.e_point || ''),

        label('A9', 'A9:E9', '14)노선연장(m)'),
        data('F9', 'F9:H9', section.length_m != null ? Number(section.length_m) : ''),
        label('I9', 'I9:K9', '15)전용연장(m)'),
        data('L9', 'L9:O9', gnum(gs, 'perslenth')),
        label('P9', 'P9:S9', '16)중용연장(m)'),
        data('T9', 'T9:Z9', gnum(gs, 'mixlenth')),
        label('AA9', 'AA9:AD9', '17)통행불능연장(m)'),
        data('AE9', 'AE9:AH9', gnum(gs, 'ntrflenth')),

        label('A10', 'A10:A24', '노\n선\n연\n장\n의\n\n내\n역'),
        label('B10', 'B10:AB10', '포 장 도 로'),
        label('AC10', 'AC10:AE12', '26)비포장도로(m)'),
        label('AF10', 'AF10:AH12', '27)미개통도로(m)'),

        label('B11', 'B11:F12', '18)계(m)'),
        label('G11', 'G11:I12', '19)도로(m)'),
        label('J11', 'J11:Q11', '터 널'),
        label('R11', 'R11:AB11', '교 량'),
        label('J12', 'J12:L12', '20)종류'),
        label('M12', 'M12:N12', '21)개소'),
        label('O12', 'O12:Q12', '22)연장(m)'),
        label('R12', 'R12:U12', '23)종류'),
        label('V12', 'V12:Y12', '24)개소'),
        label('Z12', 'Z12:AB12', '25)연장(m)'),

        data('B13', 'B13:F17', gnum(gs, 'p_ent_len')),
        data('G13', 'G13:I17', gnum(gs, 'p_road_len')),
        label('J13', 'J13:L13', '2차로'), data('M13', 'M13:N13', gnum(gs, 'p_tun_ea2')), data('O13', 'O13:Q13', gnum(gs, 'p_tun_len2')),
        label('R13', 'R13:U13', '강교'), data('V13', 'V13:Y13', gnum(gs, 'kanga')), data('Z13', 'Z13:AB13', gnum(gs, 'kangb')),
        label('J14', 'J14:L14', '3차로'), data('M14', 'M14:N14', gnum(gs, 'p_tun_ea3')), data('O14', 'O14:Q14', gnum(gs, 'p_tun_len3')),
        label('R14', 'R14:U14', '철근콘크리트교'), data('V14', 'V14:Y14', gnum(gs, 'chula')), data('Z14', 'Z14:AB14', gnum(gs, 'chulb')),
        label('J15', 'J15:L15', '4차로'), data('M15', 'M15:N15', gnum(gs, 'p_tun_ea4')), data('O15', 'O15:Q15', gnum(gs, 'p_tun_len4')),
        label('R15', 'R15:U15', '합성교'), data('V15', 'V15:Y15', gnum(gs, 'haba')), data('Z15', 'Z15:AB15', gnum(gs, 'habb')),
        label('J16', 'J16:L16', '5차로 이상'), data('M16', 'M16:N16', gnum(gs, 'p_tun_ea5')), data('O16', 'O16:Q16', gnum(gs, 'p_tun_len5')),
        label('R16', 'R16:U16', '그 밖의 교량'), data('V16', 'V16:Y16', gnum(gs, 'etca')), data('Z16', 'Z16:AB16', gnum(gs, 'etcb')),
        label('J17', 'J17:L17', '계'), data('M17', 'M17:N17', gnum(gs, 'p_tuneaall')), data('O17', 'O17:Q17', gnum(gs, 'p_tunlenal')),
        label('R17', 'R17:U17', '계'), data('V17', 'V17:Y17', gnum(gs, 'alla')), data('Z17', 'Z17:AB17', gnum(gs, 'allb')),
        data('AC13', 'AC13:AE17', gnum(gs, 'np_roadlen')), data('AF13', 'AF13:AH17', gnum(gs, 'nt_roadlen')),

        label('B18', 'B18:L18', '폭원(m)'),
        label('M18', 'M18:W18', '포장두께(cm)'),
        label('X18', 'X18:AH18', '차로수(m)'),

        label('B19', 'B19:E19', '28)계'),
        label('F19', 'F19:G19', '29)차도'),
        label('H19', 'H19:J19', '30)\n중앙분리대'),
        label('K19', 'K19:L19', '31)길어깨 (보도)'),
        label('M19', 'M19:N19', '32)계'),
        label('O19', 'O19:R19', '33)표층기층·\n포장슬래브'),
        label('S19', 'S19:W19', '34)\n보조기층'),
        label('X19', 'X19:Z19', '35)\n2차로 미만'),
        label('AA19', 'AA19:AC19', '36)2차로 이상\n4차로 미만'),
        label('AD19', 'AD19:AF19', '37)4차로 이상\n6차로 미만'),
        label('AG19', 'AG19:AH19', '38)6차로 이상'),

        data('B20', 'B20:E20', gs ? gnum(gs, 'wid_all') : (section.width_m != null ? Number(section.width_m) : '')),
        data('F20', 'F20:G20', gs ? gnum(gs, 'wid_road') : (section.width_m != null ? Number(section.width_m) : '')),
        data('H20', 'H20:J20', gnum(gs, 'wid_cen')), data('K20', 'K20:L20', gnum(gs, 'wid_gil')), data('M20', 'M20:N20', gnum(gs, 'p_thc_all')),
        data('O20', 'O20:R20', gnum(gs, 'p_thc_pg')), data('S20', 'S20:W20', gnum(gs, 'p_thc_sub')), data('X20', 'X20:Z20', gnum(gs, 'road_len_2')),
        data('AA20', 'AA20:AC20', gnum(gs, 'road_len_4')),
        data('AD20', 'AD20:AF20', gnum(gs, 'road_len_6')), data('AG20', 'AG20:AH20', gnum(gs, 'road_len_7')),

        label('B21', 'B21:P21', '차도(m)'),
        label('Q21', 'Q21:AD21', '길어깨(보도)(m)'),
        label('AE21', 'AE21:AH21', '자전거도로(m)'),

        label('B22', 'B22:F22', '39)계'),
        label('G22', 'G22:I22', '40)아스팔트'),
        label('J22', 'J22:M22', '41)콘크리트'),
        label('N22', 'N22:P22', '42)비포장'),
        label('Q22', 'Q22:X22', '포장'),
        label('Y22', 'Y22:AD22', '비포장'),
        label('AE22', 'AE22:AG23', '47)좌'),
        label('AH22', 'AH22:AH23', '48)우'),

        label('B23', 'B23:D23', '상행'), label('E23', 'E23:F23', '하행'),
        label('G23', null, '상행'), label('H23', 'H23:I23', '하행'),
        label('J23', 'J23:K23', '상행'), label('L23', 'L23:M23', '하행'),
        label('N23', null, '상행'), label('O23', 'O23:P23', '하행'),
        label('Q23', 'Q23:T23', '43)좌'), label('U23', 'U23:X23', '44)우'),
        label('Y23', 'Y23:AA23', '45)좌'), label('AB23', 'AB23:AD23', '46)우'),

        data('B24', 'B24:D24', gnum(gs, 'roadlenau')),
        data('E24', 'E24:F24', gnum(gs, 'roadlenad')),
        data('G24', null, gnum(gs, 'as_len_au')), data('H24', 'H24:I24', gnum(gs, 'as_len_ad')),
        data('J24', 'J24:K24', gnum(gs, 'con_lenau')), data('L24', 'L24:M24', gnum(gs, 'con_lenad')),
        data('N24', null, gnum(gs, 'np_len_au')), data('O24', 'O24:P24', gnum(gs, 'np_len_ad')),
        data('Q24', 'Q24:T24', gnum(gs, 'p_m_l')), data('U24', 'U24:X24', gnum(gs, 'p_m_r')),
        data('Y24', 'Y24:AA24', gnum(gs, 'np_m_l')), data('AB24', 'AB24:AD24', gnum(gs, 'np_m_r')),
        data('AE24', 'AE24:AG24', gnum(gs, 'by_l')), data('AH24', null, gnum(gs, 'by_r')),
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

function buildSummarySheet2(workbook, section, gs) {
    const ws = workbook.addWorksheet('도로대장총괄2', { views: [{ showGridLines: false }] });
    for (let c = 1; c <= 27; c++) ws.getColumn(c).width = 4.2;
    applyRowHeights(ws, 13, { 13: 133.7 });

    // 종단경사 연장(m)은 원본 서식이 "0.00 m"처럼 단위를 붙인 문자열로 표기한다.
    const slopeLen = (field) => {
        const v = gnum(gs, field);
        return v === '' ? '' : `${v.toFixed(2)} m`;
    };

    applyCells(ws, [
        ['A1', 'A1:M1', '도로부지면적(㎡)', { font: SECTION_FONT }],
        ['N1', 'N1:AA1', '53)곡선 반경(개소)', { font: SECTION_FONT }],

        label('A2', 'A2:C2', '49)계'), label('D2', 'D2:G2', '50)국유지'),
        label('H2', 'H2:J2', '51)공유지'), label('K2', 'K2:M2', '52)사유지'),
        label('N2', 'N2:O2', '100m 미만'), label('P2', 'P2:S2', '100m 이상\n200m 미만'),
        label('T2', 'T2:U2', '200m 이상\n300m 미만'), label('V2', 'V2:W2', '300m 이상\n460m 미만'),
        label('X2', 'X2:Y2', '460m 이상\n700m 미만'), label('Z2', 'Z2:AA2', '700m 이상'),

        data('A3', 'A3:C3', gnum(gs, 'allarea')), data('D3', 'D3:G3', gnum(gs, 'nationarea')),
        data('H3', 'H3:J3', gnum(gs, 'locatarea')), data('K3', 'K3:M3', gnum(gs, 'priv_area')),
        data('N3', 'N3:O3', gnum(gs, 'micrv100')), data('P3', 'P3:S3', gnum(gs, 'micrv200')),
        data('T3', 'T3:U3', gnum(gs, 'micrv300')),
        data('V3', 'V3:W3', gnum(gs, 'micrv460')), data('X3', 'X3:Y3', gnum(gs, 'micrv700')), data('Z3', 'Z3:AA3', gnum(gs, 'micrv701')),

        label('A4', 'A4:N4', '교차(개소)'),
        label('O4', 'O4:AA4', '60)종단경사'),

        label('A5', 'A5:B6', '54)육교'), label('C5', 'C5:E6', '55)지하도'),
        label('F5', 'F5:I5', '철도'), label('J5', 'J5:N5', '도로'),
        label('O5', 'O5:Q5', '3% 미만'), label('R5', 'R5:U5', '3% 이상\n5% 미만'),
        label('V5', 'V5:X5', '5% 이상\n10% 미만'), label('Y5', 'Y5:AA5', '10% 이상'),

        label('F6', 'F6:H6', '56)과선'), label('I6', null, '57)가도'),
        label('J6', 'J6:L6', '58)평면'), label('M6', 'M6:N6', '59)입체'),
        data('O6', 'O6:P6', gnum(gs, 'ver_s_3ea')), label('Q6', null, '개소'),
        data('T6', null, gnum(gs, 'ver_s_5ea')), label('U6', null, '개소'),
        data('V6', null, gnum(gs, 'ver_s_10ea')), label('X6', null, '개소'),
        data('Z6', null, gnum(gs, 'ver_s_11ea')), label('AA6', null, '개소'),

        data('A7', 'A7:B7', gnum(gs, 'crs_obrdg')), data('C7', 'C7:E7', gnum(gs, 'crs_sub')),
        data('F7', 'F7:H7', gnum(gs, 'crs_railgu')), data('I7', null, gnum(gs, 'crs_railga')),
        data('J7', 'J7:L7', gnum(gs, 'crs_road2d')), data('M7', 'M7:N7', gnum(gs, 'crs_road3d')),
        data('O7', 'O7:P7', gnum(gs, 'ver_s_3len')), label('Q7', null, 'm'),
        data('R7', 'R7:U7', slopeLen('ver_s_5len')), data('V7', 'V7:X7', slopeLen('ver_s10len')), data('Y7', 'Y7:AA7', slopeLen('ver_s11len')),

        label('A8', 'A8:A12', '유료 도로'),
        label('B8', 'B8:F8', '61)관 리 자'), data('G8', 'G8:N8', gstr(gs, 'paywho')),
        label('O8', 'O8:R8', '62)요금징수시간'), data('S8', 'S8:AA8', gstr(gs, 'pay_period')),

        label('B9', 'B9:F9', '63)요금징수 시설 수'), data('G9', 'G9:N9', gnum(gs, 'pay_ea')),
        label('O9', 'O9:R9', '64)요금징수근거'), data('S9', 'S9:AA9', gstr(gs, 'payrec')),

        label('B10', 'B10:D12', '연장 내역'),
        label('E10', 'E10:H11', '65)계(m)'),
        label('I10', 'I10:K11', '66)도 로(m)'),
        label('L10', 'L10:R10', '터널'),
        label('S10', 'S10:AA10', '교량'),

        label('L11', 'L11:N11', '67)개 소'), label('O11', 'O11:R11', '68)연 장(m)'),
        label('S11', 'S11:V11', '69)개 소'), label('W11', 'W11:AA11', '70)연 장(m)'),

        data('E12', 'E12:H12', gnum(gs, 'pay_alllen')), data('I12', 'I12:K12', gnum(gs, 'payroad')),
        data('L12', 'L12:N12', gnum(gs, 'pay_tun_ea')), data('O12', 'O12:R12', gnum(gs, 'paytunnel')),
        data('S12', 'S12:V12', gnum(gs, 'pay_brdgea')), data('W12', 'W12:AA12', gnum(gs, 'paybrdg')),

        label('A13', 'A13:D13', '비고'),
        data('E13', 'E13:AA13', gstr(gs, 'remark') || section.remarks || ''),
    ]);
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

// workbook에 총괄1/총괄2 두 시트를 추가한다. section: road_sections 한 행,
// gs: 같은 구간의 gov_section 행(officialLedgerZip.js가 조회해서 넘김, 없으면 null).
function buildSummarySheets(workbook, section, gs) {
    buildSummarySheet1(workbook, section, gs);
    buildSummarySheet2(workbook, section, gs);
}

module.exports = {
    buildSummarySheets,
    THIN, BOX_BORDER, LABEL_FONT, VALUE_FONT, TITLE_FONT, SECTION_FONT,
    CENTER_WRAP, LEFT_MID, LABEL_FILL,
    applyCells, label, data, applyRowHeights, formatRouteNoLabel,
};
