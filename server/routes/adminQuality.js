// 관리 콘솔 "데이터 품질(KRRIS)" — 이미 등록된 데이터에서 필수(NOT NULL) 문자 항목이 빈 값인 곳을 찾고, 그 자리에서 채운다.
// 일괄등록 검수(M-1)는 납품 파일을 보고 알려 주기만 하고, 내려받기는 DB 값 그대로 내보내므로, 업체의 재납품을 기다리지 않고
// 시스템 안에서 고치려면 이 화면이 필요하다. 채운 값은 다음 내려받기부터 그대로 나간다.
// 안전장치: 이미 값이 있는 칸은 절대 덮어쓰지 않는다(빈 칸만 채움). 노선 식별 키(도로종류/노선번호/구간/관리기관)와 ID는 고칠 수 없다.
const express = require('express');
const pool = require('../db');
const { requireAdminReauth } = require('../middleware/requireAuth');
const { GOV_LAYER_MAP } = require('../lib/govLayerMap');
const { getTableLabels } = require('../lib/schemaLabels');
const { CODEBOOK } = require('../lib/govCodebook');
const { logAction, clientIp } = require('../lib/auditLog');

const router = express.Router();
router.use(requireAdminReauth);

const LAYER_BY_TABLE = new Map(Object.values(GOV_LAYER_MAP).map((l) => [l.table, l]));
const TABLES = [...LAYER_BY_TABLE.keys()];
const KEY_COLUMNS = new Set(['road_rank', 'road_no', 'sect', 'mco']); // 노선 식별 키는 여기서 고치지 않는다
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

// 테이블별 "빈 값 점검 대상 컬럼" — 필수(NOT NULL, 기본값 없음)인 문자 컬럼 중 키/ID를 뺀 것. 한 번 읽어 재사용한다.
let metaCache = null;
async function getMeta() {
    if (metaCache) return metaCache;
    const { rows } = await pool.query(
        `SELECT table_name, column_name, character_maximum_length AS maxlen
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ANY($1) AND is_nullable = 'NO' AND column_default IS NULL
           AND data_type IN ('character varying', 'character', 'text')
         ORDER BY table_name, ordinal_position`,
        [TABLES]
    );
    const meta = new Map(); // table -> Map(column -> { maxlen })
    for (const r of rows) {
        const layer = LAYER_BY_TABLE.get(r.table_name);
        if (!layer || r.column_name === layer.pkColumn || KEY_COLUMNS.has(r.column_name)) continue;
        if (!meta.has(r.table_name)) meta.set(r.table_name, new Map());
        meta.get(r.table_name).set(r.column_name, { maxlen: r.maxlen });
    }
    metaCache = meta;
    return meta;
}

function scopeSql(user, params, alias = '') {
    // 관할이 있는 관리자는 자기 관할(시군구) 데이터만 본다/고친다.
    if (!user.sigunguCode) return '';
    params.push(user.sigunguCode);
    const p = alias ? alias + '.' : '';
    return ` AND (${p}sigungu_code = $${params.length} OR ${p}sigungu_code IS NULL)`;
}

function codeChoices(column) {
    const book = CODEBOOK[column.toUpperCase()];
    if (!book) return null;
    return Object.entries(book).map(([code, name]) => ({ code, name }));
}

// 빈 값 현황: 테이블/컬럼별 건수
router.get('/summary', async (req, res) => {
    const meta = await getMeta();
    const items = [];
    let total = 0;
    for (const [table, cols] of meta) {
        const params = [];
        const scope = scopeSql(req.session.user, params);
        const colNames = [...cols.keys()];
        const select = colNames.map((c, i) => `COUNT(*) FILTER (WHERE btrim(${c}) = '') AS c${i}`).join(', ');
        let row;
        try {
            ({ rows: [row] } = await pool.query(`SELECT ${select} FROM ${table} WHERE true${scope}`, params));
        } catch (e) { continue; }
        const labels = getTableLabels(table);
        const layer = LAYER_BY_TABLE.get(table);
        colNames.forEach((c, i) => {
            const n = Number(row[`c${i}`]);
            if (!n) return;
            total += n;
            items.push({ table, layerCode: layer.code, layerName: layer.koreanName, column: c, label: labels[c] || c, count: n, hasCodes: !!CODEBOOK[c.toUpperCase()] });
        });
    }
    items.sort((a, b) => b.count - a.count);
    res.json({ total, items });
});

// 한 항목(테이블+컬럼)의 빈 값 행 목록
router.get('/rows', async (req, res) => {
    const table = String(req.query.table || '');
    const column = String(req.query.column || '');
    const meta = await getMeta();
    if (!meta.has(table) || !meta.get(table).has(column) || !IDENT_RE.test(column)) return res.status(400).json({ error: '점검 대상이 아닌 항목입니다.' });
    const layer = LAYER_BY_TABLE.get(table);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const params = [];
    const scope = scopeSql(req.session.user, params);
    const where = `btrim(${column}) = ''${scope}`;
    const { rows: [{ n }] } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`, params);
    params.push(limit, offset);
    const { rows } = await pool.query(
        `SELECT ${layer.pkColumn} AS pk, road_no, sect, road_name FROM ${table} WHERE ${where}
         ORDER BY road_no, sect, ${layer.pkColumn} LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    res.json({
        table, column, label: getTableLabels(table)[column] || column, layerName: layer.koreanName,
        maxlen: meta.get(table).get(column).maxlen, total: n, rows, choices: codeChoices(column),
    });
});

// 빈 칸 채우기: pks로 고른 행들, 또는 all=true면 이 항목의 빈 칸 전부(관할 범위 안에서). 값이 있는 칸은 건드리지 않는다.
router.post('/fix', async (req, res) => {
    const { table, column } = req.body || {};
    const value = String((req.body || {}).value ?? '').trim();
    const all = req.body && req.body.all === true;
    const pks = Array.isArray(req.body && req.body.pks) ? req.body.pks.map(String).filter(Boolean).slice(0, 2000) : [];
    const meta = await getMeta();
    if (!meta.has(table) || !meta.get(table).has(column) || !IDENT_RE.test(column)) return res.status(400).json({ error: '수정할 수 없는 항목입니다.' });
    if (!value) return res.status(400).json({ error: '채울 값을 입력하세요.' });
    const maxlen = meta.get(table).get(column).maxlen;
    if (maxlen && value.length > maxlen) return res.status(400).json({ error: `값이 너무 깁니다(최대 ${maxlen}자).` });
    const choices = codeChoices(column);
    if (choices && !choices.some((c) => c.code === value)) {
        return res.status(400).json({ error: '코드표에 없는 값입니다. 목록에서 코드를 골라 입력하세요.' });
    }
    if (!all && !pks.length) return res.status(400).json({ error: '채울 행을 선택하세요.' });

    const layer = LAYER_BY_TABLE.get(table);
    const params = [value];
    let where = `btrim(${column}) = ''`;
    if (!all) { params.push(pks); where += ` AND ${layer.pkColumn} = ANY($${params.length})`; }
    where += scopeSql(req.session.user, params);
    const result = await pool.query(`UPDATE ${table} SET ${column} = $1 WHERE ${where} RETURNING ${layer.pkColumn} AS pk`, params);
    const updated = result.rowCount;

    const label = getTableLabels(table)[column] || column;
    if (updated) {
        await logAction(null, {
            action: 'update', targetTable: table, targetId: all ? null : (pks.length === 1 ? pks[0] : null),
            summary: `필수항목 빈 값 채우기: ${layer.koreanName} · ${label} ${updated}건 → "${value}"`,
            detail: { table, column, value, updated, mode: all ? 'all' : 'selected', samplePks: result.rows.slice(0, 20).map((r) => r.pk) },
            sigunguCode: req.session.user.sigunguCode, user: req.session.user, ip: clientIp(req),
        });
    }
    res.json({ updated });
});

router.getMeta = getMeta; // 통계 엑셀(lib/statsReport.js)이 같은 "빈 값 점검 대상 컬럼"을 쓴다
module.exports = router;
