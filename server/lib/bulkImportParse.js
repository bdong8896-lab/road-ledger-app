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
const { CODEBOOK } = require('./govCodebook');
const { CODE_ALIASES } = require('./codeAliases');
const { GOV_LAYER_GEOM, GEOM_KIND_LABEL, geomKindOf } = require('./govLayerGeom');

// KRRIS(국가 도로대장 검수) 사전검사 — 실제 장성군 납품 심사에서 지적된 결함 중
// 기계적으로 판정할 수 있는 두 가지(C-1, M-1)와, 코드표 대조(V-1)를 미리보기 단계에서 잡는다.
//   C-1: 좌표계가 EPSG:5179(UTM-K)가 아님 — 도로대장 작성지침 43쪽. 우리 시스템은 어떤
//        좌표계든 변환해 저장하므로 화면상 문제가 없지만, 그 원본을 KRRIS에 내면 반려된다.
//   M-1: 필수(NN) 항목 값이 비어 있음 — 필수 여부는 테이블정의서 v2.3을 옮긴 DB 스키마
//        (gov_facility_schema.sql의 NOT NULL)를 그대로 쓴다. 텍스트 필드 빈칸은 ''로
//        들어와 DB NOT NULL을 통과해버리고(실제 적재분에서 45건 확인), 숫자 필드 빈칸은
//        null이 되어 확정 단계 INSERT 자체가 실패해 일괄등록 전체가 롤백된다.
const NN_SAMPLE_LIMIT = 5; // 미리보기 화면에 필드별로 보여줄 대상 ID 개수(전체는 CSV로)

// V-1: 코드표(공통입력코드정의서 v2.6, lib/govCodebook.js)에 없는 코드값. 코드 칸에 'U'/'D'나 '이팝'처럼
//      코드가 아닌 값이 들어간 경우를 잡는다. 저장은 막지 않고(확인 필요 수준) 결함 목록에만 올린다.
//      빈 값은 M-1이 따로 보므로 여기서는 건너뛴다.
//   - 필드 이름(영문)이 코드북의 필드 식별자와 같은 칸만 대조한다(예: DIRECTION, PL_TYPE, SB_NAME).
//   - 코드북의 TYPE처럼 레이어마다 뜻이 다른 필드는 코드를 합쳐 둔 것이라, "어느 레이어에서든 있는 코드"면 통과시킨다.
//   - mco(관리기관)는 뺀다: 납품 데이터가 쓰는 값(예: 58950)이 공식 코드(장성군 46880)와 다른 경우가 실제로 있어
//     대조하면 모든 행이 걸려 정작 중요한 경고가 묻힌다(아래 dbfMcoCode 주석 참고).
const CODE_SKIP_FIELDS = new Set(['mco']);
const CODE_VALUE_LIMIT = 10;     // 미리보기 화면에 필드별로 보여줄 코드값 개수
const CODE_DEFECT_CAP = 20000;   // 레이어당 CSV 결함 목록에 담는 행 상한(건수 집계는 상한과 무관하게 전부 센다)

const codeSetCache = new Map(); // 필드명(대문자) -> Set(코드)
function codeSetOf(field) {
    const key = field.toUpperCase();
    if (!codeSetCache.has(key)) {
        const book = CODEBOOK[key];
        codeSetCache.set(key, book && Object.keys(book).length ? new Set(Object.keys(book)) : null);
    }
    return codeSetCache.get(key);
}

// DBF가 코드 칸을 숫자형으로 만들면 앞의 0이 사라진다(0401 → 401). 자릿수를 채워 본 값도 같은 코드로 본다.
function isKnownCode(field, v) {
    const set = codeSetOf(field);
    const s = typeof v === 'string' ? v.trim() : String(v);
    if (set.has(s)) return true;
    // 정의서 주석이 인정하는 다른 표기(예: 표지명칭 406 = 40600) — lib/codeAliases.js
    const alias = CODE_ALIASES[field.toUpperCase()];
    if (alias && alias[s] && set.has(alias[s])) return true;
    if (typeof v === 'number') {
        for (let len = s.length + 1; len <= 5; len++) if (set.has(s.padStart(len, '0'))) return true;
    }
    return false;
}

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

// 레이어 폴더(LAYER/신규, LAYER/삭제) 안에 있는데 {관리번호}_{레이어코드}_{N|D} 형식이 아니라서 읽히지 않은 파일.
// 예) 589502026003003_A00200000_N.dbf — 레이어코드의 0이 하나 많아(숫자 8자) 통째로 무시되고, 도로대장총괄(A0020000)이
//     빠지면 그 구간이 만들어지지 않는다. 예전에는 아무 알림 없이 건너뛰었다(unknownLayerCodes는 형식이 맞는 것만 본다).
const LAYER_STEM_RE = /^(\d+)_([A-Z][0-9]{7})_(N|D)$/i;
const LAYER_COMPANION_EXTS = new Set(['.dbf', '.shp', '.shx', '.prj']);
const IGNORED_FILE_LIMIT = 200;

// 코드가 한두 글자 어긋난 오타로 보이면(숫자가 하나 많거나 적음) 가장 가까운 표준 레이어코드를 알려 준다.
function suggestLayerCode(stem) {
    const m = stem.match(/^.*?_([A-Za-z][0-9]+)_[A-Za-z]$/);
    if (!m) return null;
    const code = m[1].toUpperCase();
    const candidates = [];
    if (code.length > 8) {
        for (let i = 1; i < code.length; i++) candidates.push(code.slice(0, i) + code.slice(i + 1));
    } else if (code.length < 8) {
        for (let i = 1; i <= code.length; i++) candidates.push(code.slice(0, i) + '0' + code.slice(i));
    }
    const hit = candidates.find((c) => GOV_LAYER_MAP[c]);
    return hit ? { code: hit, koreanName: GOV_LAYER_MAP[hit].koreanName } : null;
}

function findIgnoredLayerFiles(allFiles) {
    const groups = new Map(); // 폴더|파일명(확장자 제외) -> { deliveryCode, folder, stem, exts[] }
    for (const f of allFiles) {
        const ext = path.extname(f).toLowerCase();
        if (!LAYER_COMPANION_EXTS.has(ext)) continue;
        const dir = path.dirname(f);
        const folder = path.basename(dir);
        if (!['신규', '삭제'].includes(folder) || path.basename(path.dirname(dir)).toUpperCase() !== 'LAYER') continue;
        const stem = path.basename(f, path.extname(f));
        if (LAYER_STEM_RE.test(stem)) continue;
        const key = `${dir}|${stem}`;
        if (!groups.has(key)) groups.set(key, { deliveryCode: path.basename(path.dirname(path.dirname(dir))), folder, stem, exts: [] });
        groups.get(key).exts.push(ext);
    }
    return [...groups.values()]
        .sort((a, b) => a.deliveryCode.localeCompare(b.deliveryCode) || a.stem.localeCompare(b.stem))
        .slice(0, IGNORED_FILE_LIMIT)
        .map((g) => {
            const suggestion = suggestLayerCode(g.stem);
            const files = `${g.stem}${g.exts.length > 1 ? `(${g.exts.join(' ')})` : g.exts[0]}`;
            let message;
            if (suggestion) {
                message = `납품 ${g.deliveryCode} — 파일명 오류로 읽히지 않았습니다: ${files}. 레이어코드가 형식(영문 1자+숫자 7자)에 맞지 않습니다 — ${suggestion.code}(${suggestion.koreanName})의 오타로 보입니다. 고치지 않으면 이 레이어는 등록되지 않습니다.`;
                if (suggestion.code === 'A0020000') message += ' 도로대장총괄이 없으면 이 구간 자체가 만들어지지 않습니다.';
            } else {
                message = `납품 ${g.deliveryCode} — LAYER/${g.folder}에 {관리번호}_{레이어코드}_{N|D} 형식이 아닌 파일이 있어 읽히지 않았습니다: ${files}.`;
            }
            return { deliveryCode: g.deliveryCode, folder: g.folder, stem: g.stem, exts: g.exts, suggestion, message };
        });
}

// ---- 납품 데이터 점검: ID 중복 · 도형 종류 · 한글 인코딩 · 관리번호(노선·구간) 일치 ----
// 등록은 되지만 결과가 어긋나는 경우(같은 ID가 덮어써짐, 지도에 엉뚱한 도형이 그려짐, 한글이 깨짐, 다른 구간으로 들어감)를
// 미리보기/검수 단계에서 알려 주기 위한 것이다. 서버 미리보기와 별도 검수 프로그램이 같은 결과를 쓴다.
const INTEGRITY_LIST_LIMIT = 500; // 화면·CSV에 담는 항목 수 상한(건수 집계는 상한과 무관하게 전부 센다)
const INTEGRITY_SAMPLE_LIMIT = 3; // 메시지에 예로 보여주는 ID 개수
const GEOM_SAMPLE_LIMIT = 200;

// 관리번호 15자리 = 관리기관(5) + 연도(4) + 노선번호(3) + 구간(3). 예) 415902026101001 → 노선 101(0101), 구간 001.
function routeFromDeliveryCode(code) {
    const s = String(code || '');
    if (!/^\d{15}$/.test(s)) return null;
    return { mco: s.slice(0, 5), year: s.slice(5, 9), roadNo: Number(s.slice(9, 12)), sect: s.slice(12, 15) };
}

function readCpg(basePath) {
    try { return fs.readFileSync(`${basePath}.cpg`, 'utf8').trim(); } catch (e) { return ''; }
}

// parseDbf가 모은 인코딩 집계를 판정한다. 한글 값의 절반 이상이 UTF-8로 읽히면 UTF-8로 저장된 파일로 본다.
function judgeEncoding(stats) {
    if (!stats) return null;
    if (stats.nonAscii > 0 && stats.utf8Like >= Math.max(1, stats.nonAscii * 0.5)) return { kind: 'utf8', count: stats.utf8Like };
    // 일부 값만 UTF-8이거나 깨진 경우(여러 곳에서 합친 데이터 등)
    if (stats.invalid + stats.utf8Like > 0) return { kind: 'broken', count: stats.invalid + stats.utf8Like };
    if (stats.question > 0) return { kind: 'question', count: stats.question };
    return null;
}

async function parseDelivery(extractDir) {
    const allFiles = walkFiles(extractDir);
    const dbfFiles = allFiles.filter((f) => path.basename(f).match(LAYER_FILE_RE));

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

    // 납품 데이터 점검 집계(레이어 밖에서 모으는 것들)
    const rootIssues = new Map();      // 납품 루트 -> { nn, code, dup, geom, encoding, mismatch } 구간별 요약표용
    const bump = (root, key, n = 1) => {
        if (!rootIssues.has(root)) rootIssues.set(root, { nn: 0, code: 0, dup: 0, geom: 0, encoding: 0, mismatch: 0 });
        rootIssues.get(root)[key] += n;
    };
    const encodingIssues = [];         // { code, koreanName, file, kind, count, nonAscii, cpg, samples }
    const routeMismatches = new Map(); // 루트|레이어|필드 -> { deliveryCode, code, koreanName, field, expected, count, values, samples }

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
                    codeDefects: [],      // V-1: { pk, file, row, field, value } — CODE_DEFECT_CAP까지만 담는다
                    codeTotal: 0,         // V-1 전체 건수(상한과 무관)
                    codeStats: new Map(), // V-1 집계: field -> Map(코드값 -> { count, samples })
                    pkSeen: new Map(),    // 점검: 신규(N)에 나온 ID -> 처음 나온 위치("파일 n행") — 같은 ID가 또 나오면 중복
                    dupGroups: new Map(), // 점검: 중복된 ID -> { pk, count, locations[] }
                    geomStat: null,       // 점검: 도형 종류 집계(SHP가 있는 레이어만)
                });
            }
            const layer = layersByCode.get(code);
            const { columns, requiredNoDefault } = await getTableColumns(layerDef.table);
            layer.routeCols = columns.has('road_no') && columns.has('sect'); // 서버 기존 데이터와 비교할 때 쓴다

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

                // 한글 인코딩 점검 — 표준은 EUC-KR(CP949). UTF-8로 저장됐거나 글자가 깨진 파일을 잡는다.
                const enc = judgeEncoding(parsed.encodingStats);
                if (enc) {
                    encodingIssues.push({
                        code, koreanName: layerDef.koreanName, deliveryCode: deliveryLabel, file: path.basename(dbfPath), kind: enc.kind, count: enc.count,
                        nonAscii: parsed.encodingStats.nonAscii, cpg: readCpg(basePath), samples: parsed.encodingStats.samples,
                    });
                    bump(deliveryRoot, 'encoding', enc.count);
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
                    return { row, geom, deliveryRoot }; // deliveryRoot: 확정 때 노선(납품 폴더)별로 나눠 저장하는 데 쓴다
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
                            bump(deliveryRoot, 'nn');
                            // null은 확정 단계 INSERT를 실패시켜 일괄등록 전체를 롤백시키므로,
                            // 이 레코드만 저장에서 빼고 나머지는 정상 진행한다.
                            if (v === null || v === undefined) rec.skipNnNull = true;
                        }
                    });
                    // V-1: 코드표에 없는 코드값 (저장은 막지 않는다)
                    const codeFields = [...columns].filter((c) => presentFields.has(c) && !CODE_SKIP_FIELDS.has(c) && codeSetOf(c));
                    if (codeFields.length) {
                        rows.forEach((rec, i) => {
                            for (const field of codeFields) {
                                const v = rec.row[field];
                                if (isBlank(v) || isKnownCode(field, v)) continue;
                                const value = typeof v === 'string' ? v.trim() : String(v);
                                const pkVal = rec.row[layer.pkColumn];
                                const pk = isBlank(pkVal) ? `(${path.basename(dbfPath)} ${i + 1}번째 행)` : String(pkVal);
                                layer.codeTotal++;
                                bump(deliveryRoot, 'code');
                                if (!layer.codeStats.has(field)) layer.codeStats.set(field, new Map());
                                const byValue = layer.codeStats.get(field);
                                if (!byValue.has(value)) byValue.set(value, { count: 0, samples: [] });
                                const st = byValue.get(value);
                                st.count++;
                                if (st.samples.length < NN_SAMPLE_LIMIT) st.samples.push(pk);
                                if (layer.codeDefects.length < CODE_DEFECT_CAP) {
                                    layer.codeDefects.push({ pk, file: path.basename(dbfPath), row: i + 1, field, value });
                                }
                            }
                        });
                    }

                    const dbfName = path.basename(dbfPath);
                    // 점검 1) ID 중복 — 같은 ID는 DB에 한 건만 남고 나중 것이 앞의 것을 덮어쓴다(ON CONFLICT DO UPDATE).
                    rows.forEach((rec, i) => {
                        const pkVal = rec.row[layer.pkColumn];
                        if (isBlank(pkVal)) return;
                        const pk = String(pkVal).trim();
                        const where = `${dbfName} ${i + 1}행`;
                        const first = layer.pkSeen.get(pk);
                        if (first === undefined) { layer.pkSeen.set(pk, where); return; }
                        let g = layer.dupGroups.get(pk);
                        if (!g) { g = { pk, count: 1, locations: [first] }; layer.dupGroups.set(pk, g); }
                        g.count++;
                        if (g.locations.length < 5) g.locations.push(where);
                        bump(rec.deliveryRoot, 'dup');
                    });

                    // 점검 2) 도형 종류 — 표준 SHP 템플릿의 점/선/면과 같은지, 도형이 비어 있지 않은지
                    const expectedGeom = GOV_LAYER_GEOM[code];
                    if (geoms && expectedGeom) {
                        const g = layer.geomStat || (layer.geomStat = {
                            expected: expectedGeom, total: 0, none: 0, mismatch: 0, found: { Point: 0, Line: 0, Polygon: 0 }, list: [],
                        });
                        rows.forEach((rec, i) => {
                            g.total++;
                            const kindOfGeom = geomKindOf(geoms[i]);
                            const pkVal = rec.row[layer.pkColumn];
                            const pk = isBlank(pkVal) ? `(${dbfName} ${i + 1}번째 행)` : String(pkVal);
                            if (!kindOfGeom) {
                                g.none++;
                                bump(rec.deliveryRoot, 'geom');
                                if (g.list.length < GEOM_SAMPLE_LIMIT) g.list.push({ pk, file: dbfName, row: i + 1, found: null });
                                return;
                            }
                            g.found[kindOfGeom]++;
                            if (kindOfGeom !== expectedGeom) {
                                g.mismatch++;
                                bump(rec.deliveryRoot, 'geom');
                                if (g.list.length < GEOM_SAMPLE_LIMIT) g.list.push({ pk, file: dbfName, row: i + 1, found: kindOfGeom });
                            }
                        });
                    }

                    // 점검 3) 관리번호와 레코드의 노선·구간 — 한 납품(관리번호) = 한 노선의 한 구간이라 레코드의 노선번호·구간이 같아야 한다.
                    //          다르면 그 레코드가 엉뚱한 구간에 붙는다. (노선번호가 4자리로 1000 이상이면 관리번호(3자리)로 비교할 수 없어 건너뛴다.)
                    const expectedRoute = routeFromDeliveryCode(deliveryCode);
                    if (expectedRoute) {
                        const note = (rec, i, field, actual, expected) => {
                            const key = `${deliveryRoot}|${code}|${field}`;
                            if (!routeMismatches.has(key)) {
                                routeMismatches.set(key, { deliveryCode: deliveryLabel, code, koreanName: layerDef.koreanName, field, expected, count: 0, values: new Map(), samples: [] });
                            }
                            const m = routeMismatches.get(key);
                            m.count++;
                            m.values.set(actual, (m.values.get(actual) || 0) + 1);
                            if (m.samples.length < GEOM_SAMPLE_LIMIT) {
                                const pkVal = rec.row[layer.pkColumn];
                                m.samples.push({ pk: isBlank(pkVal) ? `(${dbfName} ${i + 1}번째 행)` : String(pkVal), file: dbfName, row: i + 1, value: actual });
                            }
                            bump(rec.deliveryRoot, 'mismatch');
                        };
                        rows.forEach((rec, i) => {
                            const { road_no: roadNo, sect } = rec.row;
                            if (!isBlank(roadNo)) {
                                const n = Number(roadNo);
                                if (Number.isFinite(n) && n < 1000 && n !== expectedRoute.roadNo) note(rec, i, 'road_no', String(roadNo).trim(), String(expectedRoute.roadNo).padStart(4, '0'));
                            }
                            if (!isBlank(sect)) {
                                const s = String(sect).trim();
                                if (/^\d+$/.test(s) && s.padStart(3, '0') !== expectedRoute.sect) note(rec, i, 'sect', s, expectedRoute.sect);
                            }
                        });
                    }

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
    const ignoredLayerFiles = findIgnoredLayerFiles(allFiles);
    const integrity = buildIntegrity({ layers, deliveries, sectionRecords, rootIssues, encodingIssues, routeMismatches, ignoredLayerFiles });
    for (const l of layers) { l.pkSeen = null; l.dupGroups = null; } // 큰 Map은 점검이 끝나면 비운다

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
        ignoredLayerFiles,
        blockingWarnings,
        krris,
        integrity,
    };
}

// 위에서 모은 점검 결과를 화면·CSV·종합판정에 쓰는 모양으로 정리한다.
function buildIntegrity({ layers, deliveries, sectionRecords, rootIssues, encodingIssues, routeMismatches, ignoredLayerFiles }) {
    // ID 중복(신규 파일 안에서 같은 ID가 두 번 이상) / 신규와 삭제에 같은 ID
    const idDuplicates = [];
    const deleteConflicts = [];
    let idDuplicateTotal = 0;
    let idDuplicateRecords = 0;
    let deleteConflictTotal = 0;
    for (const l of layers) {
        for (const g of l.dupGroups.values()) {
            idDuplicateTotal++;
            idDuplicateRecords += g.count;
            if (idDuplicates.length < INTEGRITY_LIST_LIMIT) idDuplicates.push({ code: l.code, koreanName: l.koreanName, pk: g.pk, count: g.count, locations: g.locations });
        }
        // 확정은 신규를 먼저 저장하고 삭제를 나중에 처리한다 — 같은 ID가 둘 다 있으면 방금 저장한 것이 곧바로 지워진다.
        for (const rec of l.deleteRecords) {
            const pkVal = rec.row[l.pkColumn];
            if (isBlank(pkVal)) continue;
            const pk = String(pkVal).trim();
            if (!l.pkSeen.has(pk)) continue;
            deleteConflictTotal++;
            if (deleteConflicts.length < INTEGRITY_LIST_LIMIT) deleteConflicts.push({ code: l.code, koreanName: l.koreanName, pk });
        }
    }

    // 도형 종류 불일치 / 도형 없음
    const geometry = layers.filter((l) => l.geomStat && (l.geomStat.mismatch || l.geomStat.none)).map((l) => ({
        code: l.code, koreanName: l.koreanName, expected: l.geomStat.expected, total: l.geomStat.total,
        mismatch: l.geomStat.mismatch, none: l.geomStat.none, found: l.geomStat.found, samples: l.geomStat.list,
    }));

    // 관리번호와 레코드의 노선·구간 불일치
    const routeMismatch = [...routeMismatches.values()].map((m) => ({
        deliveryCode: m.deliveryCode, code: m.code, koreanName: m.koreanName, field: m.field, expected: m.expected, count: m.count,
        values: [...m.values.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count).slice(0, 5),
        samples: m.samples,
    }));

    // 구간(관리번호)별 요약
    const perRoot = new Map(); // 루트 -> Map(레이어코드 -> { newCount, deleteCount })
    for (const l of layers) {
        for (const [key, list] of [['newCount', l.newRecords], ['deleteCount', l.deleteRecords]]) {
            for (const rec of list) {
                if (!perRoot.has(rec.deliveryRoot)) perRoot.set(rec.deliveryRoot, new Map());
                const m = perRoot.get(rec.deliveryRoot);
                if (!m.has(l.code)) m.set(l.code, { code: l.code, koreanName: l.koreanName, newCount: 0, deleteCount: 0 });
                m.get(l.code)[key]++;
            }
        }
    }
    const sections = [];
    for (const [root, info] of deliveries) {
        const sec = sectionRecords.find((s) => s.deliveryRoot === root);
        const route = routeFromDeliveryCode(info.code);
        const layerList = [...(perRoot.get(root) || new Map()).values()].sort((a, b) => a.code.localeCompare(b.code));
        const issues = rootIssues.get(root) || { nn: 0, code: 0, dup: 0, geom: 0, encoding: 0, mismatch: 0 };
        const typoFixable = ignoredLayerFiles.some((g) => g.deliveryCode === info.code && g.suggestion && g.suggestion.code === 'A0020000');
        sections.push({
            _root: root, // 서버 안에서만 쓴다(서버 기존 데이터와 비교할 때 레코드를 구간에 묶는 키) — 화면에 보내기 전에 publicIntegrity()로 뺀다
            deliveryCode: info.code,
            roadName: sec ? String(sec.row.road_name || '').trim() : '',
            roadNo: sec && !isBlank(sec.row.road_no) ? String(sec.row.road_no).trim() : (route ? String(route.roadNo).padStart(4, '0') : ''),
            sect: sec && !isBlank(sec.row.sect) ? String(sec.row.sect).trim() : (route ? route.sect : ''),
            hasSection: !!sec,
            sectionNameTypo: !sec && typoFixable, // 총괄 파일이 있는데 파일명 오타로 읽히지 않은 경우(오타 메시지가 따로 나간다)
            layerCount: layerList.length,
            newTotal: layerList.reduce((s, l) => s + l.newCount, 0),
            deleteTotal: layerList.reduce((s, l) => s + l.deleteCount, 0),
            layers: layerList,
            issues,
        });
    }
    sections.sort((a, b) => a.deliveryCode.localeCompare(b.deliveryCode));

    const integrity = { idDuplicates, idDuplicateTotal, idDuplicateRecords, deleteConflicts, deleteConflictTotal, geometry, encoding: encodingIssues, routeMismatch, sections };
    integrity.messages = integrityMessages(integrity);
    return integrity;
}

// 화면·API로 내보내는 모양 — 서버 임시 폴더 경로(_root)를 뺀다.
function publicIntegrity(integ) {
    if (!integ) return integ;
    return { ...integ, sections: integ.sections.map(({ _root, ...s }) => s) };
}

const GEOM_LABEL = GEOM_KIND_LABEL;
function samplesText(arr, fn) {
    return arr.slice(0, INTEGRITY_SAMPLE_LIMIT).map(fn).join(', ');
}

// 종합 판정에 쓰는 문장 — errors: 등록 결과가 잘못되거나 일부가 사라지는 것, warnings: 확인이 필요한 것.
function integrityMessages(integ) {
    const errors = [];
    const warnings = [];

    // 레이어별로 묶어서 한 줄씩
    const dupByLayer = new Map();
    for (const d of integ.idDuplicates) {
        if (!dupByLayer.has(d.code)) dupByLayer.set(d.code, { koreanName: d.koreanName, items: [] });
        dupByLayer.get(d.code).items.push(d);
    }
    for (const [code, { koreanName, items }] of dupByLayer) {
        const records = items.reduce((s, d) => s + d.count, 0);
        errors.push(`${koreanName}(${code}): 같은 ID가 두 번 이상 들어 있습니다 — ${items.length.toLocaleString()}개 ID(${records.toLocaleString()}건). 같은 ID는 한 건만 저장되고 마지막 것이 앞의 것을 덮어씁니다. 예: ${samplesText(items, (d) => `${d.pk}(${d.locations.join(' / ')})`)}`);
    }
    if (integ.idDuplicateTotal > integ.idDuplicates.length) errors.push(`ID 중복이 많아 목록에는 앞의 ${integ.idDuplicates.length.toLocaleString()}개 ID만 담았습니다(전체 ${integ.idDuplicateTotal.toLocaleString()}개).`);

    const delByLayer = new Map();
    for (const d of integ.deleteConflicts) {
        if (!delByLayer.has(d.code)) delByLayer.set(d.code, { koreanName: d.koreanName, items: [] });
        delByLayer.get(d.code).items.push(d);
    }
    for (const [code, { koreanName, items }] of delByLayer) {
        errors.push(`${koreanName}(${code}): 같은 ID가 신규(N)와 삭제(D)에 모두 있습니다 — ${items.length.toLocaleString()}건. 등록하면 저장한 직후 삭제돼 남지 않습니다. 예: ${samplesText(items, (d) => d.pk)}`);
    }

    for (const e of integ.encoding) {
        const cpg = e.cpg ? ` (.cpg: ${e.cpg})` : '';
        const sample = e.samples[0] ? ` 예: ${e.samples[0].row}행 ${e.samples[0].field} = "${e.samples[0].value}"` : '';
        if (e.kind === 'utf8') {
            errors.push(`납품 ${e.deliveryCode} ${e.file}: 한글이 UTF-8로 저장된 것으로 보입니다${cpg} — 표준은 EUC-KR(CP949)이라 이대로 등록하면 한글이 깨져 저장됩니다(${e.count.toLocaleString()}개 값).${sample} SHP를 EUC-KR로 다시 내보내 달라고 요청하세요.`);
        } else if (e.kind === 'broken') {
            warnings.push(`납품 ${e.deliveryCode} ${e.file}: 글자가 깨졌거나 UTF-8로 저장된 값이 ${e.count.toLocaleString()}개 있습니다${cpg} — 원본 파일에서 이미 깨졌거나 여러 곳의 데이터를 합치다 섞였을 수 있습니다.${sample}`);
        } else {
            warnings.push(`납품 ${e.deliveryCode} ${e.file}: 글자가 '?'로 바뀐 것으로 보이는 값이 ${e.count.toLocaleString()}개 있습니다${cpg} — 내보낼 때 한글이 사라졌을 수 있습니다.${sample}`);
        }
    }

    for (const g of integ.geometry) {
        if (g.mismatch) {
            const foundText = Object.entries(g.found).filter(([k, n]) => n && k !== g.expected).map(([k, n]) => `${GEOM_LABEL[k]} ${n.toLocaleString()}건`).join(', ');
            warnings.push(`${g.koreanName}(${g.code}): 표준은 ${GEOM_LABEL[g.expected]} 도형인데 다른 도형이 ${g.mismatch.toLocaleString()}건 들어 있습니다(${foundText}, 전체 ${g.total.toLocaleString()}건) — 다른 레이어를 잘못 내보냈을 수 있습니다. 예: ${samplesText(g.samples.filter((s) => s.found), (s) => s.pk)}`);
        }
        if (g.none) {
            warnings.push(`${g.koreanName}(${g.code}): 도형이 없는 레코드가 ${g.none.toLocaleString()}건 있습니다(속성 행이 SHP 도형보다 많거나 빈 도형) — 지도에 표시되지 않습니다. 예: ${samplesText(g.samples.filter((s) => !s.found), (s) => s.pk)}`);
        }
    }

    // 관리번호 불일치는 레이어마다 따로 쓰면 한 구간이 통째로 어긋났을 때 수십 줄이 되므로 납품·항목별로 묶는다.
    const fieldLabel = { road_no: '노선번호(ROAD_NO)', sect: '구간(SECT)' };
    const mmGroups = new Map();
    for (const m of integ.routeMismatch) {
        const key = `${m.deliveryCode}|${m.field}`;
        if (!mmGroups.has(key)) mmGroups.set(key, { deliveryCode: m.deliveryCode, field: m.field, expected: m.expected, count: 0, values: new Map(), layers: [] });
        const g = mmGroups.get(key);
        g.count += m.count;
        for (const v of m.values) g.values.set(v.value, (g.values.get(v.value) || 0) + v.count);
        g.layers.push(`${m.koreanName} ${m.count.toLocaleString()}건`);
    }
    for (const g of mmGroups.values()) {
        const values = [...g.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, n]) => `${v}(${n.toLocaleString()}건)`).join(', ');
        const layerText = g.layers.slice(0, 4).join(', ') + (g.layers.length > 4 ? ` 외 ${g.layers.length - 4}개 레이어` : '');
        warnings.push(`납품 ${g.deliveryCode}: ${fieldLabel[g.field]}가 관리번호의 값(${g.expected})과 다른 레코드가 ${g.count.toLocaleString()}건 있습니다 — 파일의 값: ${values}. 이 레코드는 관리번호 폴더와 다른 노선·구간으로 등록됩니다. (${layerText})`);
    }

    for (const s of integ.sections) {
        if (!s.hasSection && !s.sectionNameTypo) {
            warnings.push(`납품 ${s.deliveryCode}: 도로대장총괄(A0020000)이 없거나 등록할 수 없어 이 구간이 새로 만들어지지 않습니다 — 서버에 이미 있는 구간이어야 시설물이 붙습니다.`);
        }
    }
    return { errors, warnings };
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
    // V-1: 코드표에 없는 값 — 레이어·필드별로 코드값 종류와 건수(많은 순)
    const codes = [];
    for (const l of layers) {
        if (!l.codeStats.size) continue;
        const labels = getTableLabels(l.table);
        for (const [field, byValue] of l.codeStats) {
            const all = [...byValue.entries()].map(([value, s]) => ({ value, count: s.count, samples: s.samples })).sort((a, b) => b.count - a.count);
            codes.push({
                code: l.code, koreanName: l.koreanName, field, label: labels[field] || field,
                total: all.reduce((s, v) => s + v.count, 0), distinct: all.length, values: all.slice(0, CODE_VALUE_LIMIT),
            });
        }
    }
    return {
        requiredEpsg: KRRIS_REQUIRED_EPSG,
        checkedShpLayers: layers.filter((l) => l.hasShp).length,
        crs,
        nn,
        nnTotal: layers.reduce((s, l) => s + l.nnDefects.length, 0),
        codes,
        codesTotal: layers.reduce((s, l) => s + l.codeTotal, 0),
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
        const labels = getTableLabels(l.table);
        for (const d of l.nnDefects) {
            rows.push({
                check: 'M-1 필수항목', code: l.code, layer: l.koreanName, pk: d.pk, file: d.file || '', row: d.row || '', field: d.field,
                label: labels[d.field] || d.field,
                detail: d.kind === 'null' ? '값 없음(숫자) — 이 레코드는 저장되지 않음' : '빈 값',
            });
        }
    }
    for (const l of parsed.layers) {
        const labels = getTableLabels(l.table);
        for (const d of l.codeDefects) {
            rows.push({
                check: 'V-1 코드표', code: l.code, layer: l.koreanName, pk: d.pk, file: d.file, row: d.row, field: d.field,
                label: labels[d.field] || d.field, detail: `코드표에 없는 값 "${d.value}"`,
            });
        }
        if (l.codeTotal > l.codeDefects.length) {
            rows.push({
                check: 'V-1 코드표', code: l.code, layer: l.koreanName, pk: '', file: '', row: '', field: '', label: '',
                detail: `이 레이어는 ${l.codeTotal.toLocaleString()}건 중 ${l.codeDefects.length.toLocaleString()}건만 목록에 담았습니다(상한)`,
            });
        }
    }
    // 납품 데이터 점검(ID 중복·도형 종류·인코딩·관리번호) — 업체에 보완을 요청할 때 같은 CSV에서 함께 보이게 한다.
    const integ = parsed.integrity;
    if (integ) {
        const row = (check, code, layer, pk, file, rowNo, detail) => rows.push({ check, code, layer, pk, file, row: rowNo, field: '', label: '', detail });
        for (const d of integ.idDuplicates) {
            row('D-1 ID중복', d.code, d.koreanName, d.pk, '', '', `같은 ID가 ${d.count}번 나옵니다 (${d.locations.join(' / ')}) — 마지막 것만 남습니다`);
        }
        if (integ.idDuplicateTotal > integ.idDuplicates.length) {
            row('D-1 ID중복', '', '', '', '', '', `중복 ID ${integ.idDuplicateTotal.toLocaleString()}개 중 ${integ.idDuplicates.length.toLocaleString()}개만 목록에 담았습니다(상한)`);
        }
        for (const d of integ.deleteConflicts) {
            row('D-2 신규·삭제 충돌', d.code, d.koreanName, d.pk, '', '', '같은 ID가 신규(N)와 삭제(D)에 모두 있습니다 — 등록 직후 삭제됩니다');
        }
        for (const g of integ.geometry) {
            for (const s of g.samples) {
                row('G-1 도형종류', g.code, g.koreanName, s.pk, s.file, s.row, s.found
                    ? `표준은 ${GEOM_LABEL[g.expected]} 도형인데 ${GEOM_LABEL[s.found]} 도형입니다`
                    : '도형이 없습니다(빈 도형이거나 SHP에 해당 행이 없음)');
            }
            if (g.mismatch + g.none > g.samples.length) {
                row('G-1 도형종류', g.code, g.koreanName, '', '', '', `이 레이어는 ${(g.mismatch + g.none).toLocaleString()}건 중 ${g.samples.length.toLocaleString()}건만 목록에 담았습니다(상한)`);
            }
        }
        for (const e of integ.encoding) {
            const what = e.kind === 'utf8' ? 'UTF-8로 저장된 한글' : e.kind === 'broken' ? '글자가 깨진 값' : "'?'로 바뀐 값";
            row('E-1 한글인코딩', e.code, e.koreanName, '', e.file, e.samples[0] ? e.samples[0].row : '', `${what} ${e.count}개${e.cpg ? ` (.cpg: ${e.cpg})` : ''} — 표준은 EUC-KR`);
        }
        const fieldLabel = { road_no: 'ROAD_NO', sect: 'SECT' };
        for (const m of integ.routeMismatch) {
            for (const s of m.samples) {
                row('R-1 관리번호', m.code, m.koreanName, s.pk, s.file, s.row, `${fieldLabel[m.field]} = ${s.value} (관리번호 ${m.deliveryCode} 기준 ${m.expected})`);
            }
            if (m.count > m.samples.length) {
                row('R-1 관리번호', m.code, m.koreanName, '', '', '', `${fieldLabel[m.field]}가 관리번호와 다른 레코드 ${m.count.toLocaleString()}건 중 ${m.samples.length.toLocaleString()}건만 목록에 담았습니다(상한)`);
            }
        }
    }
    return rows;
}

module.exports = { parseDelivery, krrisDefectRows, setTableColumnProvider, publicIntegrity };
