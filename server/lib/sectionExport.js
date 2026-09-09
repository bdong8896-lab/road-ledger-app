// 등록된 노선(road_sections) 하나를 골라 그 노선의 모든 자료(속성+지오메트리+
// 사진+보고서+도면)를 일괄등록(bulk-import) 때 받는 것과 같은 국토부 표준
// 납품 폴더 구조의 zip으로 묶어 내려주는 "내보내기" — bulkImportParse.js의
// 반대 방향 파이프라인이다. LAYER/삭제(삭제이력 미보관), LAYER/원본(항상
// 비어있었음), LAYER/통합/{code}.*(신규의 중복 사본), ETC/도로대장 점검표
// (업체 자체 QA 문서, 우리 데이터 아님)는 내보내지 않는다.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');
const pool = require('../db');
const { GOV_LAYER_MAP } = require('./govLayerMap');
const { writeDbf } = require('./dbfWriter');
const { writeShp } = require('./shpWriter');
const { reprojectFromWgs84, EXPORT_TARGET_EPSG, EXPORT_PRJ_WKT } = require('./crsRegistry');

function safeFileNamePart(s) {
    return String(s || '').replace(/[/\\:*?"<>|]/g, '_').trim();
}

// information_schema에서 컬럼 타입 메타를 가져온다(dbf 필드 스펙 산정용).
// geom/sigungu_code는 국토부 표준 필드가 아니라 앱 내부용이라 제외한다 —
// 가져오기 쪽 bulkImportParse.js가 이 둘을 특별취급하는 것과 대칭.
async function getColumnMeta(table) {
    const { rows } = await pool.query(
        `SELECT column_name, data_type, numeric_precision, numeric_scale
         FROM information_schema.columns
         WHERE table_schema='public' AND table_name = $1 AND column_name NOT IN ('geom','sigungu_code')
         ORDER BY ordinal_position`,
        [table]
    );
    return rows;
}

const NUMERIC_TYPES = new Set(['numeric', 'integer', 'smallint', 'bigint', 'real', 'double precision']);

// Postgres 컬럼 메타 + 실제 내보낼 행들로 DBF 필드 스펙(fields)을 만든다.
// 문자열 필드 폭은 Postgres 글자수(character_maximum_length)를 믿지 않고,
// 실제로 EUC-KR 인코딩했을 때 나오는 최대 바이트수로 정한다(한글은 2바이트).
function buildDbfFields(colMeta, rows) {
    return colMeta.map((col) => {
        const dbColumn = col.column_name;
        const name = dbColumn.toUpperCase().slice(0, 10);
        if (col.data_type === 'boolean') {
            return { name, dbColumn, type: 'L', length: 1, decimals: 0 };
        }
        if (NUMERIC_TYPES.has(col.data_type)) {
            const scale = col.numeric_scale || 0;
            const precision = col.numeric_precision || 10;
            const length = Math.min(precision + (scale > 0 ? 1 : 0) + 1, 254); // +1은 부호 여유
            return { name, dbColumn, type: 'N', length: Math.max(length, 1), decimals: scale };
        }
        let maxLen = 1;
        for (const row of rows) {
            const v = row[dbColumn];
            if (v == null) continue;
            const encoded = iconv.encode(String(v), 'euc-kr');
            if (encoded.length > maxLen) maxLen = encoded.length;
        }
        return { name, dbColumn, type: 'C', length: Math.min(maxLen, 254), decimals: 0 };
    });
}

// road_sections.rdid는 R01+도로등급코드(4)+관리기관코드(5)+노선번호(4)+구간(3)
// +연도(4)+일련번호(4) = 27자. 연도는 인덱스 19~22. 원본 관리번호(예:
// 589502026008001)는 DB에 안 남아있어 정확히 복원할 수 없으므로, 사람이
// 알아볼 수 있는 값을 새로 합성한다(재수입 매칭에 쓰이는 값이 아니라 파일명
// prefix일 뿐이라 자릿수가 원본과 달라도 무방).
function buildPrefix(section) {
    const year = section.rdid.length >= 23 ? section.rdid.slice(19, 23) : '0000';
    return `${section.mco_code || '00000'}${year}${section.route_no || ''}${section.sect || ''}`;
}

async function buildExportZip(rdid) {
    const { rows: sectionRows } = await pool.query('SELECT * FROM road_sections WHERE rdid = $1', [rdid]);
    const section = sectionRows[0];
    if (!section) return null;

    const prefix = buildPrefix(section);
    const zip = new AdmZip();
    const matchedByTable = new Map(); // table -> [pk값...] (사진/보고서 조회용)

    for (const [code, layerDef] of Object.entries(GOV_LAYER_MAP)) {
        const { table, pkColumn } = layerDef;
        const hasRoadRank = table !== 'gov_road_bound';
        const where = hasRoadRank
            ? 'road_rank = $1 AND road_no = $2 AND sect = $3'
            : 'road_no = $1 AND sect = $2';
        const params = hasRoadRank
            ? [section.road_rank_code, section.route_no, section.sect]
            : [section.route_no, section.sect];

        let rows;
        try {
            const result = await pool.query(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${pkColumn}`, params);
            rows = result.rows;
        } catch (e) {
            continue; // 테이블 구조가 다른 등 예외적인 레이어는 건너뜀(삭제 핸들러와 동일한 관용)
        }
        if (!rows.length) continue;

        matchedByTable.set(table, rows.map((r) => r[pkColumn]).filter(Boolean));

        const colMeta = await getColumnMeta(table);
        const fields = buildDbfFields(colMeta, rows);
        const entryBase = `LAYER/신규/${prefix}_${code}_N`;
        zip.addFile(`${entryBase}.dbf`, writeDbf(fields, rows));
        zip.addFile(`${entryBase}.cpg`, Buffer.from('EUC-KR', 'ascii'));

        if (rows.some((r) => r.geom)) {
            const geometries = rows.map((r) => (r.geom ? reprojectFromWgs84(r.geom, EXPORT_TARGET_EPSG) : null));
            const { shpBuffer, shxBuffer } = writeShp(geometries);
            zip.addFile(`${entryBase}.shp`, shpBuffer);
            zip.addFile(`${entryBase}.shx`, shxBuffer);
            zip.addFile(`${entryBase}.prj`, Buffer.from(EXPORT_PRJ_WKT, 'ascii'));
        }
    }

    for (const [table, pks] of matchedByTable) {
        if (!pks.length) continue;
        const { rows: files } = await pool.query(
            `SELECT file_kind, original_name, stored_path FROM gov_facility_files
             WHERE facility_table = $1 AND facility_rdid = ANY($2)`,
            [table, pks]
        );
        for (const f of files) {
            if (!fs.existsSync(f.stored_path)) continue; // 디스크에서 파일이 지워졌으면 조용히 건너뜀
            const destFolder = f.file_kind === '보고서' ? 'LAYER/통합/STR' : 'LAYER/통합/PHOTO';
            zip.addLocalFile(f.stored_path, destFolder, safeFileNamePart(f.original_name));
        }
    }

    // '도면종류'(일반 도면)뿐 아니라 '도로'(500m 단위 구간 도면, 도로대장 탭의
    // "도로" 표에 뜨는 것들)도 실제 납품 폴더에서는 같은 ETC/TOP 안에 함께
    // 들어있다(58950 폴더 실물로 확인함 — 구간별 도로 도면과 500m 단위 도면이
    // 같이 있었음). 예전엔 '도면종류'만 조회해서 '도로' 파일이 통째로 빠졌었다.
    const { rows: drawings } = await pool.query(
        `SELECT original_name, stored_path FROM route_files
         WHERE section_rdid = $1 AND file_category IN ('도면종류', '도로')`,
        [rdid]
    );
    for (const d of drawings) {
        if (!fs.existsSync(d.stored_path)) continue;
        zip.addLocalFile(d.stored_path, 'ETC/TOP', safeFileNamePart(d.original_name));
    }

    const zipBuffer = zip.toBuffer();
    const filename = `${safeFileNamePart(section.route_name) || section.rdid}_${section.rdid}.zip`;
    return { zipBuffer, filename };
}

module.exports = { buildExportZip };
