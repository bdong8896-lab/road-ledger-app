// 도로대장 조서(구간/호선/관할 전체) 다운로드 — 예전엔 관할 내 모든 구간을
// 표 형태로 하나의 워크북에 몰아 넣었지만(ledgerReport.js), 실제 시군에서
// 쓰는 조서는 국토부 표준서식으로 "구간 하나 = 워크북 하나"다
// (officialLedgerForm.js). 그래서 구간마다 서식 워크북을 만들고
// sectionExport.js와 같은 방식(adm-zip)으로 묶어서 한 번에 내려준다.
const ExcelJS = require('exceljs');
const AdmZip = require('adm-zip');
const pool = require('../db');
const { buildSummarySheets } = require('./officialLedgerForm');
const { buildFacilitySheets } = require('./officialLedgerFacilitySheets');
const { buildRemainingSheets } = require('./officialLedgerFacilitySheets2');
const { buildBridgeTunnelSheets } = require('./officialLedgerBridgeTunnel');

function safeFileNamePart(s) {
    return String(s || '').replace(/[/\\:*?"<>|]/g, '_').trim();
}

// 부속시설 gov_* 테이블은 road_sections와 FK가 아니라 (road_rank, road_no, sect)
// 업무키로 매칭한다(routes/sections.js의 FACILITY_TABLE_MAP 주석과 동일한 규칙).
const FACILITY_TABLES = {
    signs: 'gov_sign',
    streetLights: 'gov_street_light',
    signalLamps: 'gov_signal_lamp',
    soundProofings: 'gov_sound_proofing',
    streetTrees: 'gov_street_tree',
};

// officialLedgerFacilitySheets2.js가 다루는 15종 — 대부분 sect_st(위치)로 정렬하지만
// gov_landuse(도로구역)만 필지 단위라 위치 컬럼이 없어 rdid로 정렬한다.
const FACILITY_TABLES_2 = {
    xpoints: 'gov_xpoint',
    xrails: 'gov_xrail',
    slopes: 'gov_slope',
    stopbays: 'gov_stopbay',
    sides: 'gov_side',
    stones: 'gov_stone',
    walls: 'gov_wall',
    boxPipes: 'gov_box_pipe',
    medianStrips: 'gov_median_strip',
    noris: 'gov_nori',
    defences: 'gov_defence',
    dipEqps: 'gov_dip_eqp',
    pathways: 'gov_pathway',
    realnths: 'gov_realnth',
    landuses: 'gov_landuse',
};
// 정렬 기준 컬럼 — 대부분 sect_st(위치)지만 예외가 있다: gov_xpoint는 위치가
// sect_st_km, gov_landuse(도로구역)는 필지 단위라 위치 컬럼 자체가 없다(rdid로 대체).
const ORDER_COLUMN_OVERRIDES = {
    gov_xpoint: 'sect_st_km NULLS LAST',
    gov_landuse: 'rdid',
};

async function fetchByTableMap(tableMap, section) {
    const entries = await Promise.all(
        Object.entries(tableMap).map(async ([key, table]) => {
            const orderCol = ORDER_COLUMN_OVERRIDES[table] || 'sect_st NULLS LAST';
            const { rows } = await pool.query(
                `SELECT * FROM ${table} WHERE road_rank = $1 AND road_no = $2 AND sect = $3 ORDER BY ${orderCol}`,
                [section.road_rank_code, section.route_no, section.sect]
            );
            return [key, rows];
        })
    );
    return Object.fromEntries(entries);
}

// gov_section = GOV_LAYER_MAP A0020000("01.도로대장총괄") — SHP를 그대로 적재한
// 테이블로, 총괄1/2 시트의 numbered 항목 대부분(노선지정일~유료도로)이 여기 있다.
async function fetchGovSection(section) {
    const { rows } = await pool.query(
        'SELECT * FROM gov_section WHERE road_rank = $1 AND road_no = $2 AND sect = $3',
        [section.road_rank_code, section.route_no, section.sect]
    );
    return rows[0] || null;
}

// sections: road_sections 행 배열 — 어느 범위(구간 하나/호선 전체/관할 전체)를
// 내려줄지는 호출부(routes/sections.js)가 미리 걸러서 넘겨준다(이 함수는
// 그 범위를 몰라도 됨 — 받은 구간들로만 조서를 만든다).
async function buildOfficialLedgerZip(sections) {
    const zip = new AdmZip();
    const usedNames = new Set();
    for (const section of sections) {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = '도로대장시스템';
        workbook.created = new Date();
        const gs = await fetchGovSection(section);
        buildSummarySheets(workbook, section, gs);
        const facilityData = await fetchByTableMap(FACILITY_TABLES, section);
        buildFacilitySheets(workbook, section, facilityData);
        const facilityData2 = await fetchByTableMap(FACILITY_TABLES_2, section);
        buildRemainingSheets(workbook, section, facilityData2);
        const { bridges, tunnels } = await fetchByTableMap(
            { bridges: 'gov_bridge', tunnels: 'gov_tunnel' },
            section
        );
        buildBridgeTunnelSheets(workbook, section, bridges, tunnels);
        const buffer = await workbook.xlsx.writeBuffer();

        // 노선(route_name)마다 zip 안에 폴더를 하나씩 만들고, 그 안에 구간별 xlsx를 넣는다.
        // 폴더 밖으로 파일만 꺼내도 어느 노선인지 알 수 있게 파일명에도 노선명을 반복해서 적는다.
        const routeLabel = safeFileNamePart(section.route_name) || section.rdid;
        const sectLabel = section.sect ? `${section.sect}구간` : section.rdid;
        let name = `${routeLabel}/${routeLabel}_${sectLabel}.xlsx`;
        // 같은 노선 안에서 구간명이 중복될 수 있어(예: 같은 구간, 다른 관리기관) rdid로 구분한다.
        if (usedNames.has(name)) name = `${routeLabel}/${routeLabel}_${sectLabel}_${section.rdid}.xlsx`;
        usedNames.add(name);

        zip.addFile(name, Buffer.from(buffer));
    }

    return zip.toBuffer();
}

module.exports = { buildOfficialLedgerZip };
