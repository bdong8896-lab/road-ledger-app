// 일괄등록 납품 폴더 안의 "500SHP" 폴더(도면/ETC 밑에 두는 500m 단위 구간
// SHP 모음)를 찾아 road_sectors 테이블용 레코드로 파싱한다. 국토부 표준
// 49개 레이어(GOV_LAYER_MAP)와 달리 이 시스템만의 항목이라 파일명 규칙이
// 없고, DBF 자체에 ROAD_NO/SECT가 있어 노선을 미리 고를 필요도 없다 —
// 그래서 zip/폴더 어디에 있든 이 이름의 폴더를 재귀로 찾기만 하면 된다.
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

    for (const dir of findSectorShpDirs(extractDir)) {
        const files = fs.readdirSync(dir);
        const shpFiles = files.filter((f) => /\.shp$/i.test(f));

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

module.exports = { findSectorShpDirs, parseSectorShpFiles };
