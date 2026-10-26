// 등록된 노선(road_sections) 하나를 골라 그 노선의 모든 자료(속성+지오메트리+
// 사진+보고서+도면)를 일괄등록(bulk-import) 때 받는 것과 같은 국토부 표준
// 납품 폴더 구조의 zip으로 묶어 내려주는 "내보내기" — bulkImportParse.js의
// 반대 방향 파이프라인이다. LAYER/삭제(삭제이력 미보관), LAYER/원본(항상
// 비어있었음), LAYER/통합/{code}.*(신규의 중복 사본), ETC/도로대장 점검표
// (업체 자체 QA 문서, 우리 데이터 아님)는 내보내지 않는다.
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const iconv = require('iconv-lite');
const pool = require('../db');
const { GOV_LAYER_MAP } = require('./govLayerMap');
const { writeDbf } = require('./dbfWriter');
const { normalizeRankForExport, rankInName } = require('./roadRank');
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

// 내보내기 파일명·폴더명 앞부분 = 원본 납품의 관리번호(예: 589502026008001).
// 일괄등록으로 들어온 구간은 원본 값(road_sections.delivery_code)을 그대로 쓴다.
// 없으면(수동등록, 컬럼 추가 전 등록분) 관리번호 규칙대로 합성한다:
//   관리기관코드(5) + 연도(4) + 노선번호(3) + 구간(3) = 15자리
// 예전엔 노선번호를 DB 값(4자리, "0008") 그대로 붙여 16자리("5895020260008002")가 되어
// 원본("589502026008002")과 달랐다(사용자 지적으로 확인). 연도는 rdid의 인덱스 19~22
// (R01+도로등급4+관리기관5+노선4+구간3+연도4+일련번호4 = 27자).
function buildPrefix(section) {
    if (section.delivery_code) return section.delivery_code;
    const year = section.rdid.length >= 23 ? section.rdid.slice(19, 23) : '0000';
    const routeNo = String(Number(section.route_no) || 0).padStart(3, '0'); // 1000 이상이면 4자리 그대로
    const sect = String(section.sect || '').padStart(3, '0');
    return `${section.mco_code || '00000'}${year}${routeNo}${sect}`;
}

// 구간 하나 분량의 SHP/DBF/사진/보고서/도면 엔트리를 zip에 그대로 추가한다.
// folderPrefix가 있으면(호선/관할 전체 내보내기처럼 구간이 여럿일 때) 그
// 구간만의 하위 폴더 밑에 넣어 여러 구간이 한 zip 안에서 섞이지 않게 한다.
async function addSectionToZip(zip, section, folderPrefix) {
    const prefix = buildPrefix(section);
    const matchedByTable = new Map(); // table -> [pk값...] (사진/보고서 조회용)

    for (const [code, layerDef] of Object.entries(GOV_LAYER_MAP)) {
        const { table, pkColumn } = layerDef;
        const hasRoadRank = table !== 'gov_road_bound';
        let where = hasRoadRank
            ? 'road_rank = $1 AND road_no = $2 AND sect = $3'
            : 'road_no = $1 AND sect = $2';
        const params = hasRoadRank
            ? [section.road_rank_code, section.route_no, section.sect]
            : [section.route_no, section.sect];
        // 같은 업무키가 다른 시군구에도 있을 수 있어 이 구간의 시군구 것만 내보낸다.
        params.push(section.sigungu_code || null);
        where += ` AND (sigungu_code IS NOT DISTINCT FROM $${params.length} OR sigungu_code IS NULL)`;

        let rows;
        try {
            const result = await pool.query(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${pkColumn}`, params);
            rows = result.rows;
        } catch (e) {
            continue; // 테이블 구조가 다른 등 예외적인 레이어는 건너뜀(삭제 핸들러와 동일한 관용)
        }
        if (!rows.length) continue;

        matchedByTable.set(table, rows.map((r) => r[pkColumn]).filter(Boolean));

        // 면도/리도/농도/도시계획도로(1509~1512)는 원본 그대로 저장돼 있다 — KRRIS 규격에 없는 코드라 내려받을 때만 1599로 바꾼다(lib/roadRank.js).
        rows = normalizeRankForExport(rows);
        const colMeta = await getColumnMeta(table);
        const fields = buildDbfFields(colMeta, rows);
        // 같은 레이어 파일을 두 곳에 넣는다 — 원본 납품 구조 그대로:
        //   LAYER/신규/{관리번호}_{코드}_N.*  (신규 레코드)
        //   LAYER/통합/{관리번호}_{코드}.*    (기존+신규-삭제를 반영한 전체 현황)
        // 실제 장성군 납품 2건(589502026008001/002)의 통합 파일은 신규와 바이트 단위로
        // 같았다(첫 납품이라 전체 = 신규). 우리 내보내기는 DB의 현재 전체 상태라 둘 다 같은
        // 내용이 맞다. 예전엔 신규만 만들어 통합 폴더 파일이 빠져 있었다(사용자 지적으로 확인).
        const files = { dbf: writeDbf(fields, rows), cpg: Buffer.from('EUC-KR', 'ascii') };
        if (rows.some((r) => r.geom)) {
            const geometries = rows.map((r) => (r.geom ? reprojectFromWgs84(r.geom, EXPORT_TARGET_EPSG) : null));
            const { shpBuffer, shxBuffer } = writeShp(geometries);
            Object.assign(files, { shp: shpBuffer, shx: shxBuffer, prj: Buffer.from(EXPORT_PRJ_WKT, 'ascii') });
        }
        for (const entryBase of [`${folderPrefix}LAYER/신규/${prefix}_${code}_N`, `${folderPrefix}LAYER/통합/${prefix}_${code}`]) {
            for (const [ext, buf] of Object.entries(files)) zip.addFile(`${entryBase}.${ext}`, buf);
        }
    }

    for (const [table, pks] of matchedByTable) {
        if (!pks.length) continue;
        const { rows: files } = await pool.query(
            `SELECT file_kind, original_name, stored_path, facility_rdid FROM gov_facility_files
             WHERE facility_table = $1 AND facility_rdid = ANY($2)`,
            [table, pks]
        );
        for (const f of files) {
            if (!fs.existsSync(f.stored_path)) continue; // 디스크에서 파일이 지워졌으면 조용히 건너뜀
            let destFolder = f.file_kind === '보고서' ? `${folderPrefix}LAYER/통합/STR` : `${folderPrefix}LAYER/통합/PHOTO`;
            let fileName = f.original_name;
            // 일괄등록은 PHOTO 아래 하위 폴더(원본사진/표지사진)의 파일을 "원본사진_<RDID>.jpg"처럼
            // 폴더명을 앞에 붙여 저장한다(bulkImport.js의 displayName). 원본 납품은
            // "PHOTO/원본사진/<RDID>.jpg"라서 내보낼 때 폴더 구조로 되돌린다(사용자 지적으로 확인).
            const ext = path.extname(fileName);
            const pkSuffix = `_${f.facility_rdid}${ext}`;
            if (f.facility_rdid && fileName.endsWith(pkSuffix) && fileName.length > pkSuffix.length) {
                destFolder += `/${safeFileNamePart(fileName.slice(0, -pkSuffix.length))}`;
                fileName = `${f.facility_rdid}${ext}`;
            }
            // DBF의 RDID를 1599로 바꿔 내보내므로, 파일명에 든 RDID도 같은 값으로 맞춘다(사진/보고서와 DBF 키가 어긋나지 않게).
            zip.addLocalFile(f.stored_path, destFolder, safeFileNamePart(rankInName(fileName)));
        }
    }

    // '도면종류'(노선 전체 단위 CON/TOP 파일)는 ETC/TOP에 들어간다 — 실제 납품
    // 폴더(589502026008001/ETC/TOP)로 직접 확인함.
    const { rows: wholeDrawings } = await pool.query(
        `SELECT original_name, stored_path FROM route_files
         WHERE section_rdid = $1 AND file_category = '도면종류'`,
        [section.rdid]
    );
    for (const d of wholeDrawings) {
        if (!fs.existsSync(d.stored_path)) continue;
        // SE{노선}{구간}{측점}.dxf(구간 전체 평면도)는 납품 폴더의 CONT에 있다 — 500_P처럼 zip 최상위(41590/58950 납품으로 확인).
        const destFolder = /^SE\d/i.test(d.original_name) ? 'CONT' : `${folderPrefix}ETC/TOP`;
        zip.addLocalFile(d.stored_path, destFolder, safeFileNamePart(d.original_name));
    }

    // '도로'(500m 단위 구간 도면)는 ETC/TOP이 아니라 500_P/500_Y/500_U라는
    // 별도의 최상위 폴더에 들어간다 — 실제 원본 납품 폴더(58950/500_P,
    // 500_Y, 500_U)로 직접 확인함(이전엔 ETC/TOP에 같이 넣었는데 잘못
    // 대조한 것이었다 — 500_P/500_Y는 노선 전체 묶음이라 folderPrefix로
    // 구간별 폴더 안에 가두지 않고 zip 최상위에 그대로 둔다).
    const { rows: segDrawings } = await pool.query(
        `SELECT original_name, stored_path, seg_variant FROM route_files
         WHERE section_rdid = $1 AND file_category = '도로'`,
        [section.rdid]
    );
    for (const d of segDrawings) {
        if (!fs.existsSync(d.stored_path)) continue;
        const variant = (d.seg_variant || '').toUpperCase();
        const destFolder = variant === 'P' ? '500_P' : variant === 'Y' ? '500_Y' : '500_U';
        zip.addLocalFile(d.stored_path, destFolder, safeFileNamePart(d.original_name));
    }
}

// ---- 스트리밍 내려받기 ----
// 예전엔 zip 전체를 서버 메모리에서 조립(AdmZip.toBuffer)한 뒤 한 번에 보냈다 — 사진이 많은 노선을 여럿 받으면 서버 메모리가
// 부족해지고 ZIP 4GB/65,535개 한계에 걸렸다. 지금은 두 단계로 나눈다:
//   1) 모으기: addSectionToZip이 SHP/DBF는 메모리 버퍼로(작다), 사진·보고서·도면은 "디스크 경로"만 목록에 모은다.
//      이 단계에서 DB 오류가 나면 아직 응답을 시작하지 않았으니 호출한 쪽이 일반 오류 응답을 줄 수 있다.
//   2) 보내기: archiver가 목록을 순서대로 읽어 압축하면서 바로 응답으로 흘려 보낸다(파일 하나만큼의 메모리만 쓴다, ZIP64 자동).
// 같은 이름의 엔트리가 둘 이상이면 마지막 것만 남긴다(예전 AdmZip이 덮어쓰던 것과 같은 결과).
function collectingSink() {
    const entries = new Map(); // 엔트리 이름 -> { buffer } | { filePath }
    return {
        entries,
        addFile(name, buffer) { entries.set(name, { buffer }); },
        addLocalFile(filePath, folder, name) {
            const dir = folder ? String(folder).replace(/\/+$/, '') + '/' : '';
            entries.set(dir + name, { filePath });
        },
    };
}

// 이미 압축된 형식은 다시 압축해도 안 줄어 CPU만 쓰니 그대로 담는다.
const STORE_ONLY_RE = /\.(jpe?g|png|gif|bmp|pdf|zip|mp4|mov)$/i;

function exportFilename(sections, zipLabel) {
    if (sections.length === 1) {
        const s = sections[0];
        return `${safeFileNamePart(s.route_name) || s.rdid}_${s.rdid}.zip`;
    }
    return `${safeFileNamePart(zipLabel) || '전체자료'}_${new Date().toISOString().slice(0, 10)}.zip`;
}

// sections(1개 이상)을 zip으로 만들어 res에 스트리밍한다. 구간이 하나면 폴더 없이 LAYER/ETC 구조로, 여럿이면
// 구간마다 관리번호 폴더를 나눈다(buildPrefix — 원본 납품 폴더명과 같다). 반환: { filename, bytes, entryCount }.
// 응답을 시작하기 전에 던진 오류는 호출한 쪽이 처리하고, 시작한 뒤의 오류는 연결을 끊는다(다운로드가 중간에 실패로 보임).
async function streamExportZip(res, sections, zipLabel) {
    if (!sections.length) throw new Error('내보낼 구간이 없습니다.');
    const sink = collectingSink();
    if (sections.length === 1) {
        await addSectionToZip(sink, sections[0], '');
    } else {
        const usedFolders = new Set();
        for (const section of sections) {
            let folder = buildPrefix(section);
            if (usedFolders.has(folder)) folder = `${folder}_${section.rdid}`; // 이론상 중복 안 나야 정상이지만 방어적으로 대비
            usedFolders.add(folder);
            await addSectionToZip(sink, section, `${folder}/`);
        }
    }

    const filename = exportFilename(sections, zipLabel);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('X-Accel-Buffering', 'no'); // 프록시가 응답을 모아 두지 말고 바로 넘기게

    const archive = archiver('zip', { zlib: { level: 5 } });
    await new Promise((resolve, reject) => {
        let settled = false;
        const done = (err) => {
            if (settled) return;
            settled = true;
            if (err) { archive.abort(); res.destroy(err); reject(err); } else resolve();
        };
        archive.on('warning', (e) => console.warn('[export] 경고:', e.message)); // 디스크에서 파일이 사라진 경우 등 — 그 파일만 빼고 계속
        archive.on('error', (e) => done(e));
        res.on('finish', () => done());
        res.on('close', () => {
            if (!res.writableFinished) { const err = new Error('받는 쪽이 연결을 끊었습니다.'); err.clientAborted = true; done(err); }
        });
        archive.pipe(res);
        for (const [name, e] of sink.entries) {
            if (e.buffer) archive.append(e.buffer, { name });
            else archive.file(e.filePath, { name, store: STORE_ONLY_RE.test(name) });
        }
        archive.finalize().catch((e) => done(e));
    });
    return { filename, bytes: archive.pointer(), entryCount: sink.entries.size };
}

module.exports = { streamExportZip, exportFilename };
