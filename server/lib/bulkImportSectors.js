// 일괄등록 납품 폴더 안의 500m 단위 구간 SHP를 찾아 road_sectors 테이블용 레코드로
// 파싱한다. 국토부 표준 49개 레이어(GOV_LAYER_MAP)와 달리 이 시스템만의 항목이라
// 파일명 규칙이 없고, DBF 자체에 ROAD_NO/SECT가 있어 노선을 미리 고를 필요도 없다.
// 두 가지 배치를 모두 찾는다:
//   1) "500SHP" 폴더 안의 .shp 전부(예전 배치, zip/폴더 어디에 있든)
//   2) 납품 폴더(관리번호 폴더) 바로 아래 같은 곳에 놓인 "{도로종류}{노선번호}.shp"
//      (예: 589502026008001/군도0008.shp, 415902026101001/면도0101.shp) — LAYER 밖에 있고
//      DBF에 ROAD_NO/SECT/SECT_ST/SECT_ED 필드가 있는 .shp는 이름과 상관없이 500m 구간으로 본다.
// SHP/DBF/CRS 파싱은 bulkImportParse.js가 국토부 레이어에 쓰는 것과 완전히
// 같은 함수를 그대로 재사용한다(좌표계 변환 코드 포함, 새로 짤 것 없음).
const fs = require('fs');
const path = require('path');
const { parseDbf } = require('./dbfParser');
const { parseShp } = require('./shpParser');
const { detectCrs, reprojectGeometry } = require('./crsRegistry');

// extractDir 이하 어디에 있든 이름이 500SHP(대소문자 무관)인 폴더를 전부 찾는다.
function findSectorShpDirs(extractDir) {
    const out = [];
    const walk = (dir) => {
        for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!name.isDirectory()) continue;
            const full = path.join(dir, name.name);
            if (/^500SHP$/i.test(name.name)) out.push(full);
            else walk(full);
        }
    };
    if (fs.existsSync(extractDir)) walk(extractDir);
    return out;
}

const SECTOR_DBF_FIELDS = ['ROAD_NO', 'SECT', 'SECT_ST', 'SECT_ED'];

// 500m 구간 SHP로 볼 .shp 목록: { dir, shpFile } — 위 두 배치를 합친다.
function findSectorShpFiles(extractDir) {
    const found = new Map(); // 전체 경로 -> { dir, shpFile }
    const add = (dir, shpFile) => found.set(path.join(dir, shpFile).toLowerCase(), { dir, shpFile });

    for (const dir of findSectorShpDirs(extractDir)) {
        for (const f of fs.readdirSync(dir)) if (/\.shp$/i.test(f)) add(dir, f);
    }

    // 2) LAYER 폴더(국토부 레이어)는 건너뛰고, 그 밖의 .shp 중 DBF 필드가 500m 구간 형식인 것만.
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        const names = entries.filter((e) => e.isFile()).map((e) => e.name);
        for (const shpFile of names.filter((n) => /\.shp$/i.test(n))) {
            if (found.has(path.join(dir, shpFile).toLowerCase())) continue;
            const base = shpFile.slice(0, -4).toLowerCase();
            const dbfFile = names.find((n) => n.toLowerCase() === `${base}.dbf`);
            if (!dbfFile) continue;
            try {
                const fields = parseDbf(fs.readFileSync(path.join(dir, dbfFile))).fields.map((f) => f.name.toUpperCase());
                if (SECTOR_DBF_FIELDS.every((f) => fields.includes(f))) add(dir, shpFile);
            } catch (e) { /* 읽을 수 없는 DBF는 500m 구간 파일이 아니라고 본다 */ }
        }
        for (const e of entries) {
            if (e.isDirectory() && !/^LAYER$/i.test(e.name)) walk(path.join(dir, e.name));
        }
    };
    if (fs.existsSync(extractDir)) walk(extractDir);

    // 디렉터리별로 묶어 돌려준다(기존 파싱 루프가 폴더 단위로 .prj/.dbf를 찾는다).
    const byDir = new Map();
    for (const { dir, shpFile } of found.values()) {
        if (!byDir.has(dir)) byDir.set(dir, []);
        byDir.get(dir).push(shpFile);
    }
    return byDir;
}

// DBF 필드명은 대소문자를 구분하지 않고 찾는다(국토부 납품과 달리 이 SHP는
// 벤더가 자유롭게 만들 여지가 있어, 표기 차이에 방어적으로 대응).
function fieldValue(rec, name) {
    const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? rec[key] : undefined;
}

// extractDir 밑의 모든 500SHP 폴더에서 .shp+.dbf(+.prj) 쌍을 찾아 파싱한다.
// 개별 파일/레코드 실패는 전체를 막지 않고 warnings에 쌓기만 한다(다른
// 500SHP 파일이나 국토부 레이어 파싱에는 영향 없음).
function parseSectorShpFiles(extractDir) {
    const records = [];
    const warnings = [];

    for (const [dir, shpFiles] of findSectorShpFiles(extractDir)) {
        const files = fs.readdirSync(dir);

        for (const shpFile of shpFiles) {
            const base = shpFile.slice(0, -4).toLowerCase();
            const dbfFile = files.find((f) => f.toLowerCase() === `${base}.dbf`);
            if (!dbfFile) {
                warnings.push(`${shpFile}: 같은 이름의 .dbf가 없어 건너뜁니다.`);
                continue;
            }
            const prjFile = files.find((f) => f.toLowerCase() === `${base}.prj`);

            let geoms;
            try {
                geoms = parseShp(fs.readFileSync(path.join(dir, shpFile)));
            } catch (e) {
                warnings.push(`${shpFile}: SHP 파싱 실패 — ${e.message}`);
                continue;
            }

            let parsedDbf;
            try {
                parsedDbf = parseDbf(fs.readFileSync(path.join(dir, dbfFile)));
            } catch (e) {
                warnings.push(`${dbfFile}: DBF 파싱 실패 — ${e.message}`);
                continue;
            }

            let crs = { matched: false, epsg: null };
            if (prjFile) {
                crs = detectCrs(fs.readFileSync(path.join(dir, prjFile), 'utf8'));
            }
            if (!crs.matched) {
                warnings.push(`${shpFile}: 좌표계를 인식할 수 없어 건너뜁니다(.prj 확인 필요).`);
                continue;
            }

            parsedDbf.records.forEach((rec, i) => {
                const roadNo = fieldValue(rec, 'ROAD_NO');
                const sect = fieldValue(rec, 'SECT');
                if (!roadNo || sect === undefined || sect === null || sect === '') {
                    warnings.push(`${dbfFile} ${i + 1}번 레코드: ROAD_NO/SECT 필드가 없어 건너뜁니다.`);
                    return;
                }
                const geom = geoms[i] ? reprojectGeometry(geoms[i], crs.epsg) : null;
                if (!geom) {
                    warnings.push(`${dbfFile} ${i + 1}번 레코드: 지오메트리가 없어 건너뜁니다.`);
                    return;
                }
                records.push({
                    roadNo: String(roadNo).trim(),
                    sect: String(sect).trim().padStart(3, '0'),
                    sectSt: Number(fieldValue(rec, 'SECT_ST')) || 0,
                    sectEd: Number(fieldValue(rec, 'SECT_ED')) || 0,
                    sectLen: Number(fieldValue(rec, 'SECT_LEN')) || 0,
                    geom,
                });
            });
        }
    }

    return { records, warnings };
}

module.exports = { findSectorShpDirs, findSectorShpFiles, parseSectorShpFiles };
