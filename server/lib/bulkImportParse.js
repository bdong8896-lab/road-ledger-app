// 압축 해제된 납품 폴더(LAYER/신규, LAYER/삭제)를 훑어서 레이어별로
// DBF+SHP+CRS를 파싱하고, 미리보기 요약과 실제 저장용 레코드를 함께 만든다.
// 미리보기/확정 둘 다 이 함수를 그대로 다시 호출한다(§staging 설계 참고).
//
// zip 하나에 납품(관리번호) 폴더가 여러 개 들어있는 경우(노선 여러 개를 한
// 파일로 묶어 올리는 경우)도 지원한다 — 각 DBF 파일 경로에서 3단계 위
// (LAYER/신규 또는 LAYER/삭제의 상위의 상위)를 그 파일이 속한 "납품 루트"로
// 보고, 같은 레이어 코드라도 서로 다른 납품 루트에서 온 레코드는 합쳐서
// newRecords/deleteRecords에 쌓는다(예전엔 납품 루트를 구분하지 않고 레이어
// 코드 하나당 dbf 경로를 하나만 저장해서, 노선이 여러 개면 마지막 것만 남고
// 나머지는 덮어써져 사라지는 버그가 있었다). gov_section(A0020000) 레코드는
// 어느 납품 루트에서 왔는지를 sectionRecords에 별도로 남겨서, 확정
// 단계에서 구간별로 도면(ETC/TOP)을 정확히 그 구간에만 연결할 수 있게 한다.
const fs = require('fs');
const path = require('path');
const { GOV_LAYER_MAP } = require('./govLayerMap');
const { parseDbf } = require('./dbfParser');
const { parseShp } = require('./shpParser');
const { detectCrs, reprojectGeometry, KRRIS_REQUIRED_EPSG } = require('./crsRegistry');
const { getTableLabels } = require('./schemaLabels');

// KRRIS(국가 도로대장 검수) 사전검사 — 실제 장성군 납품 심사에서 지적된 결함 중
// 기계적으로 판정할 수 있는 두 가지를 미리보기 단계에서 잡는다.
//   C-1: 좌표계가 EPSG:5179(UTM-K)가 아님 — 도로대장 작성지침 43쪽. 우리 시스템은 어떤
//        좌표계든 변환해 저장하므로 화면상 문제가 없지만, 그 원본을 KRRIS에 내면 반려된다.
//   M-1: 필수(NN) 항목 값이 비어 있음 — 필수 여부는 테이블정의서 v2.3을 옮긴 DB 스키마
//        (gov_facility_schema.sql의 NOT NULL)를 그대로 쓴다. 텍스트 필드 빈칸은 ''로
//        들어와 DB NOT NULL을 통과해버리고(실제 적재분에서 45건 확인), 숫자 필드 빈칸은
//        null이 되어 확정 단계 INSERT 자체가 실패해 일괄등록 전체가 롤백된다.
const NN_SAMPLE_LIMIT = 5; // 미리보기 화면에 필드별로 보여줄 대상 ID 개수(전체는 CSV로)

function isBlank(v) {
    return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

// {관리번호}_{레이어코드}_{N|D}.dbf 패턴
const LAYER_FILE_RE = /^(\d+)_([A-Z][0-9]{7})_(N|D)\.dbf$/i;

function walkFiles(dir) {
    const out = [];
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, name.name);
        if (name.isDirectory()) out.push(...walkFiles(full));
        else out.push(full);
    }
    return out;
}

// dbf 파일 경로 → 그 파일이 속한 납품(관리번호) 폴더 루트.
// .../{납품루트}/LAYER/신규/{파일}.dbf 구조를 가정(국토부 표준 납품 폴더 구조)해서
// 3단계 위로 올라간다. zip에 납품 폴더가 하나뿐이고 LAYER가 extractDir
// 바로 밑에 있는 경우엔 결과가 extractDir 자신이 되어 기존 동작과 동일하다.
function deliveryRootOf(dbfPath) {
    return path.dirname(path.dirname(path.dirname(dbfPath)));
}

// 특정 테이블의 실제 컬럼 목록(소문자)을 information_schema에서 가져온다.
// requiredNoDefault는 NOT NULL이면서 DEFAULT도 없는 컬럼 — DBF에 이 필드가
// 없으면 INSERT가 제약조건 위반으로 죽는, 진짜로 위험한 케이스만 추려낸 것.
// 별도 검수 프로그램(delivery-checker)은 DB 없이 돌아야 하므로, 컬럼 정보를 DB 대신 넘겨받을 수 있다
// (setTableColumnProvider). 서버에서는 기본값(DB 조회)을 그대로 쓰고, DB 모듈은 이때만 불러온다.
let tableColumnProvider = null;
function setTableColumnProvider(fn) { tableColumnProvider = fn; }

async function getTableColumns(table) {
    if (tableColumnProvider) return tableColumnProvider(table);
    const pool = require('../db');
    const { rows } = await pool.query(
        `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema='public' AND table_name = $1`,
        [table]
    );
    return {
        columns: new Set(rows.map((r) => r.column_name)),
        requiredNoDefault: new Set(
            rows.filter((r) => r.is_nullable === 'NO' && r.column_default === null).map((r) => r.column_name)
        ),
    };
}

async function parseDelivery(extractDir) {
    const dbfFiles = walkFiles(extractDir).filter((f) => path.basename(f).match(LAYER_FILE_RE));

    // 납품 루트별로 묶는다 — 루트 하나 = 노선(구간) 하나.
    const deliveries = new Map(); // root -> { code, dbfFiles: [] }
    for (const dbfPath of dbfFiles) {
        const root = deliveryRootOf(dbfPath);
        const code = path.basename(dbfPath).match(LAYER_FILE_RE)[1];
        if (!deliveries.has(root)) deliveries.set(root, { code, dbfFiles: [] });
        deliveries.get(root).dbfFiles.push(dbfPath);
    }

    const deliveryCodes = [...deliveries.values()].map((d) => d.code);
    const unknownLayerCodes = [];
    const layersByCode = new Map(); // 레이어 코드 -> 여러 납품 루트의 레코드를 합친 layer 객체
    const sectionRecords = []; // { deliveryRoot, row, geom } — A0020000(도로대장총괄) 레코드, 루트별로 구분

    for (const [deliveryRoot, { code: deliveryCode, dbfFiles: files }] of deliveries) {
        const layerEntries = []; // { code, kind, dbfPath } (이 납품 루트 안에서만)
        for (const dbfPath of files) {
            const [, , code, kind] = path.basename(dbfPath).match(LAYER_FILE_RE);
            if (!GOV_LAYER_MAP[code]) {
                unknownLayerCodes.push(code);
                continue;
            }
            layerEntries.push({ code, kind, dbfPath });
        }

        // 이 납품 루트 안에서 코드별로 신규(N)/삭제(D) 묶기
        const byCode = new Map();
        for (const entry of layerEntries) {
            if (!byCode.has(entry.code)) byCode.set(entry.code, {});
            byCode.get(entry.code)[entry.kind] = entry.dbfPath;
        }

        const deliveryLabel = deliveryCode || path.basename(deliveryRoot);
        for (const [code, kinds] of byCode.entries()) {
            const layerDef = GOV_LAYER_MAP[code];
            if (!layersByCode.has(code)) {
                layersByCode.set(code, {
                    code, table: layerDef.table, pkColumn: layerDef.pkColumn, koreanName: layerDef.koreanName,
                    newRecords: [], deleteRecords: [], crs: null, geomType: null, hasShp: false,
                    fieldMatch: { ok: true, missingInDbf: [], extraInDbf: [], missingRequired: [] },
                    warnings: [],
                    nnDefects: [], // M-1: { pk, field, kind: 'empty'|'null' }
                });
            }
            const layer = layersByCode.get(code);
            const { columns, requiredNoDefault } = await getTableColumns(layerDef.table);

            for (const kind of ['N', 'D']) {
                const dbfPath = kinds[kind];
                if (!dbfPath) continue;
                const basePath = dbfPath.slice(0, -4); // .dbf 제거
                const dbfBuf = fs.readFileSync(dbfPath);
                let parsed;
                try {
                    parsed = parseDbf(dbfBuf);
                } catch (e) {
                    layer.warnings.push(`${path.basename(dbfPath)}: DBF 파싱 실패 — ${e.message}`);
                    continue;
                }

                // 필드명 대조(여러 납품 루트가 있어도 매번 다시 검증 — 저렴한 검사라 문제없음)
                if (kind === 'N') {
                    const dbfFieldNames = parsed.fields.map((f) => f.name.toLowerCase());
                    const missingInDbf = [...columns].filter(
                        (c) => !dbfFieldNames.includes(c) && !['geom', 'sigungu_code'].includes(c)
                    );
                    const extraInDbf = dbfFieldNames.filter((f) => !columns.has(f));
                    // missingInDbf 중에서도 NOT NULL + 기본값 없는 컬럼만 실제로 INSERT를
                    // 깨뜨린다(그 외엔 그냥 NULL/기본값으로 채워져서 문제 없음) — 이것만
                    // 확정을 막는 blockingWarnings로 올린다.
                    const missingRequired = missingInDbf.filter((c) => requiredNoDefault.has(c));
                    layer.fieldMatch = { ok: missingInDbf.length === 0 && extraInDbf.length === 0, missingInDbf, extraInDbf, missingRequired };
                    // 다른 레이어의 속성표를 이 레이어 파일로 잘못 내보낸 경우(예: 도로중심선교점 DBF에
                    // 도로대장총괄 속성이 들어옴) — 이 레이어 컬럼은 대부분 비어 있고 다른 테이블 컬럼과는 거의 다 맞는다.
                    // 그대로 저장하면 의미 없는 행이 들어가므로 이 파일은 건너뛴다.
                    const nonGeomColumns = [...columns].filter((c) => !['geom', 'sigungu_code'].includes(c));
                    if (missingInDbf.length >= nonGeomColumns.length / 2 && extraInDbf.length >= 5) {
                        let lookalike = null;
                        for (const [otherCode, otherDef] of Object.entries(GOV_LAYER_MAP)) {
                            if (otherCode === code || otherDef.table === layerDef.table) continue;
                            const other = (await getTableColumns(otherDef.table)).columns;
                            const fit = dbfFieldNames.filter((f) => other.has(f)).length / dbfFieldNames.length;
                            if (fit >= 0.9) { lookalike = otherDef; break; }
                        }
                        if (lookalike) {
                            layer.warnings.push(
                                `${deliveryLabel}: ${path.basename(dbfPath)}의 속성표가 ${layerDef.koreanName}이(가) 아니라 ${lookalike.koreanName}의 것과 같습니다 — 납품 파일이 잘못 만들어져 이 파일(${parsed.records.length}건)은 등록하지 않습니다.`
                            );
                            layer.skippedWrongSchema = (layer.skippedWrongSchema || 0) + parsed.records.length;
                            continue;
                        }
                    }
                    if (extraInDbf.length) {
                        const shown = extraInDbf.slice(0, 8).join(', ');
                        const rest = extraInDbf.length > 8 ? ` 외 ${extraInDbf.length - 8}개` : '';
                        layer.warnings.push(
                            `${deliveryLabel}: DBF에 저장 스키마에 없는 필드 ${extraInDbf.length}개(무시하고 저장됨): ${shown}${rest}`
                        );
                    }
                    if (missingRequired.length) {
                        layer.warnings.push(
                            `DBF에 필수 필드가 없습니다 — 이 레이어는 저장할 수 없습니다: ${missingRequired.join(', ')}`
                        );
                    }
                }

                // 지오메트리(.shp/.prj) — 없으면 속성만 가져온다
                let geoms = null;
                const shpPath = `${basePath}.shp`;
                const prjPath = `${basePath}.prj`;
                if (fs.existsSync(shpPath)) {
                    layer.hasShp = true;
                    try {
                        geoms = parseShp(fs.readFileSync(shpPath));
                        if (geoms[0]) layer.geomType = geoms[0].type;
                    } catch (e) {
                        layer.warnings.push(`${path.basename(shpPath)}: SHP 파싱 실패 — ${e.message}`);
                    }
                    if (fs.existsSync(prjPath)) {
                        const wkt = fs.readFileSync(prjPath, 'utf8');
                        const crs = detectCrs(wkt);
                        if (layer.crs && layer.crs.epsg !== crs.epsg) {
                            layer.warnings.push(`${path.basename(prjPath)}: 다른 레이어 파일과 좌표계가 다릅니다(${layer.crs.epsg} vs ${crs.epsg}).`);
                        }
                        layer.crs = crs;
                        if (!crs.matched) {
                            layer.warnings.push(`${path.basename(prjPath)}: 인식할 수 없는 좌표계입니다 — 이 레이어는 지오메트리 없이 속성만 저장됩니다.`);
                        }
                    } else {
                        layer.warnings.push(`${path.basename(shpPath)}: .prj 파일이 없어 좌표계를 판별할 수 없습니다 — 지오메트리 없이 속성만 저장됩니다.`);
                    }
                }

                const rows = parsed.records.map((rec, i) => {
                    const row = {};
                    // 저장 스키마에 없는 필드(extraInDbf)는 여기서 걸러낸다 — 그대로
                    // INSERT 컬럼 목록에 넣으면 "존재하지 않는 컬럼" 에러로 트랜잭션
                    // 전체(zip 안의 모든 구간/레이어)가 롤백돼버린다.
                    for (const [k, v] of Object.entries(rec)) {
                        const key = k.toLowerCase();
                        if (columns.has(key)) row[key] = v;
                    }
                    let geom = null;
                    if (geoms && geoms[i] && layer.crs && layer.crs.matched) {
                        geom = reprojectGeometry(geoms[i], layer.crs.epsg);
                    }
                    return { row, geom };
                });

                if (kind === 'N') {
                    // M-1: DBF에 있는 필수 필드의 값이 비었는지 행마다 확인. (필드 자체가 없는
                    // 경우는 위의 missingRequired가 레이어 단위로 처리한다.)
                    const presentFields = new Set(parsed.fields.map((f) => f.name.toLowerCase()));
                    const nnFields = [...requiredNoDefault].filter((c) => presentFields.has(c));
                    rows.forEach((rec, i) => {
                        for (const field of nnFields) {
                            const v = rec.row[field];
                            if (!isBlank(v)) continue;
                            const pkVal = rec.row[layer.pkColumn];
                            layer.nnDefects.push({
                                pk: isBlank(pkVal) ? `(${path.basename(dbfPath)} ${i + 1}번째 행)` : String(pkVal),
                                file: path.basename(dbfPath), row: i + 1, // QGIS 등에서 바로 찾을 수 있게 파일과 행 번호도 남긴다
                                field,
                                kind: v === null || v === undefined ? 'null' : 'empty',
                            });
                            // null은 확정 단계 INSERT를 실패시켜 일괄등록 전체를 롤백시키므로,
                            // 이 레코드만 저장에서 빼고 나머지는 정상 진행한다.
                            if (v === null || v === undefined) rec.skipNnNull = true;
                        }
                    });
                    layer.newRecords.push(...rows);
                    // A0020000(도로대장총괄) 자체가 필수 필드 누락이면 road_sections 동기화도
                    // 시도하지 않는다 — gov_section INSERT를 건너뛰는 것과 같은 원칙.
                    if (code === 'A0020000' && !layer.fieldMatch.missingRequired.length) {
                        for (const rec of rows) {
                            if (!rec.skipNnNull) sectionRecords.push({ deliveryRoot, deliveryCode, row: rec.row, geom: rec.geom });
                        }
                    }
                } else {
                    layer.deleteRecords.push(...rows);
                }
            }
        }
    }

    const layers = [...layersByCode.values()];

    const krris = buildKrrisChecks(layers);

    const blockingWarnings = [
        ...layers
            .filter((l) => l.crs && !l.crs.matched)
            .map((l) => `${l.koreanName}(${l.code}): 좌표계 인식 실패`),
        ...layers
            .filter((l) => l.fieldMatch.missingRequired.length)
            .map((l) => `${l.koreanName}(${l.code}): 필수 필드 없음(${l.fieldMatch.missingRequired.join(', ')}) — 이 레이어는 저장되지 않습니다`),
        ...krris.nn
            .filter((n) => n.nullCount)
            .map((n) => `${n.koreanName}(${n.code}): 필수 숫자항목 "${n.label}" 값 없음 ${n.nullCount}건 — 해당 레코드는 저장되지 않습니다`),
    ];

    // gov_section(A0020000)의 MCO 필드값을 참고용으로 뽑아둔다(첫 번째 구간 기준) — 주의:
    // 이 값이 국토부 공식 관리기관코드(5자리, public/data/managing_agencies.json 기준)와
    // 다를 수 있음을 실제로 확인했다(예: 이 값이 "58950"인 납품 건이 있었는데
    // 공식 코드북엔 해당 값이 아예 없고, 진짜 장성군 코드는 "46880"이었음).
    // 그래서 이 값을 sigungu_code로 자동 채택하지 않는다 — 관리자가 검수
    // 화면에서 대상 시군구를 직접 선택하게 하고, 이 값은 참고 정보로만 보여준다.
    const dbfMcoCode = sectionRecords[0] ? sectionRecords[0].row.mco : null;

    return {
        deliveryCode: deliveryCodes[0] || null,
        deliveryCodes,
        dbfMcoCode,
        layers,
        sectionRecords,
        unknownLayerCodes: [...new Set(unknownLayerCodes)],
        blockingWarnings,
        krris,
    };
}

// 레이어별 결과를 KRRIS 사전검사 요약으로 모은다(미리보기 화면용 — 필드별 건수 + 대상 ID 몇 개).
// 결함 전체 목록은 krrisDefectRows()로 CSV를 만든다.
function buildKrrisChecks(layers) {
    const crs = [];
    for (const l of layers) {
        if (!l.hasShp) continue; // 속성만 있는 레이어는 좌표계 검사 대상 아님
        if (!l.crs) crs.push({ code: l.code, koreanName: l.koreanName, status: 'no-prj', epsg: null, label: null });
        else if (!l.crs.matched) crs.push({ code: l.code, koreanName: l.koreanName, status: 'unknown', epsg: null, label: null });
        else if (l.crs.epsg !== KRRIS_REQUIRED_EPSG) crs.push({ code: l.code, koreanName: l.koreanName, status: 'mismatch', epsg: l.crs.epsg, label: l.crs.label });
    }
    const nn = [];
    for (const l of layers) {
        if (!l.nnDefects.length) continue;
        const labels = getTableLabels(l.table);
        const byField = new Map();
        for (const d of l.nnDefects) {
            if (!byField.has(d.field)) byField.set(d.field, { emptyCount: 0, nullCount: 0, samples: [] });
            const f = byField.get(d.field);
            if (d.kind === 'null') f.nullCount++; else f.emptyCount++;
            if (f.samples.length < NN_SAMPLE_LIMIT) f.samples.push(d.pk);
        }
        for (const [field, f] of byField) {
            nn.push({ code: l.code, koreanName: l.koreanName, field, label: labels[field] || field, ...f });
        }
    }
    return {
        requiredEpsg: KRRIS_REQUIRED_EPSG,
        checkedShpLayers: layers.filter((l) => l.hasShp).length,
        crs,
        nn,
        nnTotal: layers.reduce((s, l) => s + l.nnDefects.length, 0),
    };
}

// KRRIS 사전검사 결함 전체 목록(CSV 다운로드용) — 한 줄 = 결함 하나.
function krrisDefectRows(parsed) {
    const rows = [];
    for (const c of parsed.krris.crs) {
        const detail = c.status === 'mismatch'
            ? `좌표계가 ${c.label}(${c.epsg})입니다 — 제출 기준 ${parsed.krris.requiredEpsg}`
            : c.status === 'no-prj' ? '.prj 파일이 없어 좌표계를 확인할 수 없습니다' : '인식할 수 없는 좌표계입니다';
        rows.push({ check: 'C-1 좌표계', code: c.code, layer: c.koreanName, pk: '', file: '', row: '', field: '', label: '', detail });
    }
    for (const l of parsed.layers) {
        if (!l.nnDefects.length) continue;
        const labels = getTableLabels(l.table);
        for (const d of l.nnDefects) {
            rows.push({
                check: 'M-1 필수항목', code: l.code, layer: l.koreanName, pk: d.pk, file: d.file || '', row: d.row || '', field: d.field,
                label: labels[d.field] || d.field,
                detail: d.kind === 'null' ? '값 없음(숫자) — 이 레코드는 저장되지 않음' : '빈 값',
            });
        }
    }
    return rows;
}

module.exports = { parseDelivery, krrisDefectRows, setTableColumnProvider };
