// 도로대장 조서(엑셀) 생성 — sectionExport.js(SHP/DBF 내보내기)의 자매 기능으로,
// GIS 포맷이 아니라 사람이 결재·보고용으로 바로 열어볼 수 있는 엑셀 문서를
// 만든다. 시트: "01.도로대장총괄"(road_sections 전체 목록) + 실제 데이터가
// 있는 시설물 유형별 시트(GOV_LAYER_MAP 49종 중 1건이라도 등록된 것만).
// 필드 한글 라벨은 gov_facility_schema.sql 주석(schemaLabels.js)을 그대로
// 재사용한다 — 라벨을 이중으로 관리하지 않기 위함.
const ExcelJS = require('exceljs');
const pool = require('../db');
const { GOV_LAYER_MAP } = require('./govLayerMap');
const { getTableLabels } = require('./schemaLabels');

const ROAD_SECTION_COLUMNS = [
    { key: 'road_rank_name', label: '도로등급', width: 12 },
    { key: 'route_no', label: '노선번호', width: 10 },
    { key: 'route_name', label: '노선명', width: 22 },
    { key: 'sect', label: '구간', width: 8 },
    { key: 'mco_name', label: '관리기관', width: 18 },
    { key: 's_point', label: '시점', width: 26 },
    { key: 'e_point', label: '종점', width: 26 },
    { key: 'length_m', label: '연장(m)', width: 12 },
    { key: 'width_m', label: '폭원(m)', width: 10 },
    { key: 'lane_count', label: '차로수', width: 8 },
    { key: 'pavement_type', label: '포장종류', width: 12 },
    { key: 'pavement_material', label: '포장재질', width: 12 },
    { key: 'has_sidewalk', label: '보도유무', width: 10 },
    { key: 'has_drainage', label: '배수시설유무', width: 12 },
    { key: 'completion_date', label: '준공일', width: 12 },
    { key: 'remarks', label: '비고', width: 24 },
    { key: 'rdid', label: 'RDID', width: 30 },
];

const HEADER_FONT = { name: 'Malgun Gothic', bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
const BODY_FONT = { name: 'Malgun Gothic', size: 10 };

function styleHeaderRow(row) {
    row.eachCell((cell) => {
        cell.font = HEADER_FONT;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5597' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    row.height = 20;
}

// 엑셀 시트명 제약: 31자 이내, \ / ? * [ ] : 금지, 중복 불가(코드가 고유해서
// 접두어로 붙이면 자동으로 중복은 안 생긴다).
function safeSheetName(name) {
    return String(name).replace(/[\\/?*[\]:]/g, '_').slice(0, 31);
}

function formatCellValue(v) {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (v === true) return 'Y';
    if (v === false) return 'N';
    return v;
}

async function buildLedgerReportWorkbook(sigunguCode) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = '도로대장시스템';
    workbook.created = new Date();

    // sigungu_code가 NULL인 행(관할 미지정)은 기존 outsideJurisdiction() 관례와
    // 동일하게 누구에게나 보이도록 둔다. 사용자에게 관할이 없으면(전체 관리자)
    // 필터 자체를 안 건다.
    const scopedWhere = sigunguCode ? 'WHERE sigungu_code = $1 OR sigungu_code IS NULL' : '';
    const scopedParams = sigunguCode ? [sigunguCode] : [];

    const { rows: sections } = await pool.query(
        `SELECT * FROM road_sections ${scopedWhere}
         ORDER BY road_rank_code, route_no NULLS LAST, sect NULLS LAST`,
        scopedParams
    );

    const summarySheet = workbook.addWorksheet('01.도로대장총괄');
    summarySheet.columns = ROAD_SECTION_COLUMNS.map((c) => ({ header: c.label, key: c.key, width: c.width }));
    styleHeaderRow(summarySheet.getRow(1));
    for (const s of sections) {
        const row = summarySheet.addRow(ROAD_SECTION_COLUMNS.reduce((acc, c) => {
            acc[c.key] = formatCellValue(s[c.key]);
            return acc;
        }, {}));
        row.font = BODY_FONT;
    }
    const lastCol = summarySheet.getColumn(ROAD_SECTION_COLUMNS.length).letter;
    summarySheet.autoFilter = { from: 'A1', to: `${lastCol}1` };
    summarySheet.views = [{ state: 'frozen', ySplit: 1 }];

    // 시설물 유형별 시트 — 49종 중 실제로 1건 이상 등록된 것만 시트를 만든다
    // (전부 빈 시트로 만들면 노이즈만 커짐).
    for (const [code, layerDef] of Object.entries(GOV_LAYER_MAP)) {
        const { table, pkColumn, koreanName } = layerDef;
        let rows;
        try {
            const result = await pool.query(
                `SELECT * FROM ${table} ${scopedWhere} ORDER BY ${pkColumn}`,
                scopedParams
            );
            rows = result.rows;
        } catch (e) {
            continue; // 테이블 구조가 다른 등 예외적인 레이어는 건너뜀(내보내기와 동일한 관용)
        }
        if (!rows.length) continue;

        const labels = getTableLabels(table);
        const columns = Object.keys(rows[0]).filter((c) => c !== 'geom' && c !== 'sigungu_code');
        const sheet = workbook.addWorksheet(safeSheetName(`${code}.${koreanName}`));
        sheet.columns = columns.map((c) => ({ header: labels[c] || c.toUpperCase(), key: c, width: 16 }));
        styleHeaderRow(sheet.getRow(1));
        for (const r of rows) {
            const rowData = {};
            for (const c of columns) rowData[c] = formatCellValue(r[c]);
            const row = sheet.addRow(rowData);
            row.font = BODY_FONT;
        }
        sheet.views = [{ state: 'frozen', ySplit: 1 }];
    }

    return workbook;
}

module.exports = { buildLedgerReportWorkbook };
