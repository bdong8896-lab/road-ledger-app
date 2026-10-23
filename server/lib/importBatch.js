// 일괄등록 이력과 되돌리기.
//
// 일괄등록(확정)은 기존 데이터를 upsert로 덮어쓰기 때문에, 잘못된 납품을 올리면 서버 전체 백업을 복원하는 것 말고는 되돌릴 방법이
// 없었다. 그래서 등록 한 번을 "batch"로 기록하고, 덮어쓰기 직전의 값(snapshot)을 같은 DB 트랜잭션 안에서 보관한다.
//   - DB 행: 바뀌기 전 전체 행을 JSON으로 보관(없던 행이면 old_row=NULL → 되돌리면 삭제)
//   - 파일 행(첨부/도면): 추가된 것은 되돌릴 때 행과 파일을 지우고, 교체된 것은 옛 행을 되살리며 옛 파일은 휴지통 폴더
//     (uploads/_import-trash/<batch>)에서 제자리로 옮긴다.
// 되돌리기는 "가장 최근의 등록"만 가능하다(같은 시군구 안에서). 오래된 등록을 되돌리면 그 뒤에 들어온 값까지 덮어써 버리기 때문이다.
// 등록 이후에 화면에서 직접 고친 값은 되돌리면 등록 전 값으로 돌아간다 — 화면에서 먼저 경고한다.
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const config = require('../config');
const { GOV_LAYER_MAP } = require('./govLayerMap');
const { logAction } = require('./auditLog');

const TRASH_ROOT = path.join(config.uploadDir, '_import-trash');
const KEEP_BATCHES = 10; // 되돌릴 수 있게 보관하는 최근 등록 수
const KEEP_DAYS = 30;    // 이 기간이 지난 등록은 보관하지 않는다

// 되돌릴 때 다룰 수 있는 테이블 -> 기본키 컬럼 (화이트리스트: 이 밖의 이름은 SQL에 쓰지 않는다)
const PK_BY_TABLE = new Map(Object.values(GOV_LAYER_MAP).map((l) => [l.table, l.pkColumn]));
PK_BY_TABLE.set('road_sections', 'rdid');
PK_BY_TABLE.set('gov_facility_files', 'id');
PK_BY_TABLE.set('route_files', 'id');
PK_BY_TABLE.set('road_sectors', 'id');
const FILE_KINDS = new Set(['gov_facility_files', 'route_files']);

const columnCache = new Map();
async function columnsOf(client, table) {
    if (!PK_BY_TABLE.has(table)) throw new Error('되돌릴 수 없는 테이블입니다: ' + table);
    if (columnCache.has(table)) return columnCache.get(table);
    const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]
    );
    columnCache.set(table, rows.map((r) => r.column_name));
    return columnCache.get(table);
}

// JSON으로 보관해 둔 행을 그대로 되살린다(있으면 덮어씀).
async function upsertJsonRow(client, table, rowJson) {
    const cols = await columnsOf(client, table);
    const key = PK_BY_TABLE.get(table);
    const list = cols.map((c) => `"${c}"`).join(',');
    const upd = cols.filter((c) => c !== key).map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ');
    await client.query(
        `INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_populate_record(NULL::${table}, $1::jsonb)
         ON CONFLICT ("${key}") DO UPDATE SET ${upd}`,
        [JSON.stringify(rowJson)]
    );
}

async function createBatch({ user, sigunguCode, sourceLabel }) {
    const { rows } = await pool.query(
        `INSERT INTO bulk_import_batches (user_id, username, sigungu_code, source_label, status) VALUES ($1,$2,$3,$4,'running') RETURNING id`,
        [user ? user.id : null, user && user.username ? String(user.username).slice(0, 50) : null, sigunguCode || null, String(sourceLabel || '').slice(0, 200) || null]
    );
    return rows[0].id;
}

// status: 'applied'(하나라도 저장됨) | 'failed'(저장된 것 없음). failed면 보관할 것이 없으니 스냅샷을 지운다.
async function finishBatch(batchId, { status, summary, detail }) {
    await pool.query(
        `UPDATE bulk_import_batches SET status = $2, summary = $3, detail = $4, finished_at = now() WHERE id = $1`,
        [batchId, status, summary || null, detail ? JSON.stringify(detail) : null]
    );
    if (status === 'failed') {
        await pool.query('DELETE FROM bulk_import_snapshots WHERE batch_id = $1', [batchId]);
        await pool.query('DELETE FROM bulk_import_file_changes WHERE batch_id = $1', [batchId]);
        fs.rm(path.join(TRASH_ROOT, String(batchId)), { recursive: true, force: true }, () => {});
    }
}

// pks의 현재 행을 보관한다(없는 pk는 old_row=NULL). 반드시 덮어쓰기 "직전"에, 같은 트랜잭션(client)에서 부른다.
async function snapshotRows(client, batchId, table, pks) {
    const key = PK_BY_TABLE.get(table);
    if (!key) throw new Error('보관할 수 없는 테이블입니다: ' + table);
    const uniq = [...new Set(pks.filter((v) => v !== null && v !== undefined && v !== '').map(String))];
    for (let i = 0; i < uniq.length; i += 500) {
        await client.query(
            `INSERT INTO bulk_import_snapshots (batch_id, table_name, pk, old_row)
             SELECT $1, $2, k.pk, to_jsonb(t) FROM unnest($3::text[]) AS k(pk) LEFT JOIN ${table} t ON t.${key}::text = k.pk`,
            [batchId, table, uniq.slice(i, i + 500)]
        );
    }
}

// 500m 구간은 자연키(도로종류, 노선, 구간, 시점)로 upsert한다 — 그 키의 현재 행을 보관(pk는 "|"로 이은 문자열).
async function snapshotSector(client, batchId, rankCode, roadNo, sect, sectSt) {
    const { rows } = await client.query(
        `SELECT to_jsonb(t) AS j FROM road_sectors t WHERE road_rank_code = $1 AND road_no = $2 AND sect = $3 AND sect_st = $4`,
        [rankCode, roadNo, sect, sectSt]
    );
    await client.query(
        `INSERT INTO bulk_import_snapshots (batch_id, table_name, pk, old_row) VALUES ($1, 'road_sectors', $2, $3)`,
        [batchId, [rankCode, roadNo, sect, sectSt].join('|'), rows[0] ? JSON.stringify(rows[0].j) : null]
    );
}

// ---- 파일 변경 기록 ----
function trashPathFor(batchId, original) {
    if (!original) return null;
    return path.join(TRASH_ROOT, String(batchId), `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}_${path.basename(original)}`);
}

// 교체돼서 곧 지워질 예전 파일 행을 기록한다. 반환: 커밋 뒤에 옮겨야 할 파일 목록 [{from, to}]
async function recordFileReplaced(client, batchId, kind, oldRow) {
    if (!FILE_KINDS.has(kind)) throw new Error('잘못된 파일 종류');
    const trash = trashPathFor(batchId, oldRow.stored_path);
    const trashConv = trashPathFor(batchId, oldRow.converted_path);
    await client.query(
        `INSERT INTO bulk_import_file_changes (batch_id, kind, action, old_row, trash_path, trash_converted)
         VALUES ($1,$2,'replaced',$3,$4,$5)`,
        [batchId, kind, JSON.stringify(oldRow), trash, trashConv]
    );
    const moves = [];
    if (trash) moves.push({ from: oldRow.stored_path, to: trash });
    if (trashConv) moves.push({ from: oldRow.converted_path, to: trashConv });
    return moves;
}

async function recordFileAdded(client, batchId, kind, row) {
    if (!FILE_KINDS.has(kind)) throw new Error('잘못된 파일 종류');
    await client.query(
        `INSERT INTO bulk_import_file_changes (batch_id, kind, action, row_id, stored_path, converted_path) VALUES ($1,$2,'added',$3,$4,$5)`,
        [batchId, kind, row.id, row.stored_path || null, row.converted_path || null]
    );
}

// 파일을 휴지통으로 옮긴다(없는 파일은 건너뜀). 실패해도 등록 자체는 영향이 없다 — 그 파일만 되돌릴 때 복원되지 않는다.
async function moveFilesToTrash(moves) {
    for (const m of moves) {
        try {
            await fs.promises.mkdir(path.dirname(m.to), { recursive: true });
            await fs.promises.rename(m.from, m.to);
        } catch (e) {
            // 다른 드라이브면 복사 후 삭제
            try { await fs.promises.copyFile(m.from, m.to); await fs.promises.rm(m.from, { force: true }); } catch (e2) { /* 원본이 없으면 무시 */ }
        }
    }
}

// 트랜잭션 밖(자동 연결되는 구간 도면 등)에서 쓰는 기록기 — placeDrawing이 호출한다.
function makeRecorder(batchId) {
    return {
        async replaced(kind, oldRow) {
            const client = await pool.connect();
            try {
                const moves = await recordFileReplaced(client, batchId, kind, oldRow);
                await moveFilesToTrash(moves);
            } finally { client.release(); }
        },
        async added(kind, row) {
            const client = await pool.connect();
            try { await recordFileAdded(client, batchId, kind, row); } finally { client.release(); }
        },
    };
}

// ---- 목록 / 되돌리기 / 정리 ----
async function latestAppliedId(sigunguCode) {
    const { rows } = await pool.query(
        `SELECT id FROM bulk_import_batches WHERE status = 'applied' AND sigungu_code IS NOT DISTINCT FROM $1 ORDER BY id DESC LIMIT 1`, [sigunguCode || null]
    );
    return rows[0] ? rows[0].id : null;
}

async function undoBatch(batchId, user) {
    const { rows: [batch] } = await pool.query('SELECT * FROM bulk_import_batches WHERE id = $1', [batchId]);
    if (!batch) return { ok: false, status: 404, error: '등록 이력을 찾을 수 없습니다.' };
    if (user.sigunguCode && batch.sigungu_code && user.sigunguCode !== batch.sigungu_code) {
        return { ok: false, status: 403, error: '관할 시군구 밖의 등록입니다.' };
    }
    if (batch.status !== 'applied') return { ok: false, status: 409, error: '되돌릴 수 있는 상태가 아닙니다(이미 취소했거나 보관 기간이 지났습니다).' };
    if ((await latestAppliedId(batch.sigungu_code)) !== batch.id) {
        return { ok: false, status: 409, error: '가장 최근의 등록만 취소할 수 있습니다. 더 최근 등록을 먼저 취소하세요.' };
    }

    const client = await pool.connect();
    const unlinkAfter = [];     // 이 등록이 새로 만든 파일
    const restoreMoves = [];    // 휴지통 -> 원래 위치
    let missingFiles = 0;
    try {
        await client.query('BEGIN');

        // 1) 파일 행: 추가된 것은 지우고, 교체된 것은 옛 행을 되살린다
        const { rows: changes } = await client.query('SELECT * FROM bulk_import_file_changes WHERE batch_id = $1 ORDER BY id DESC', [batchId]);
        for (const c of changes) {
            if (c.action === 'added') {
                const { rows } = await client.query(`DELETE FROM ${c.kind} WHERE id = $1 RETURNING *`, [c.row_id]); // gov_facility_files에는 converted_path가 없다 — 있는 컬럼만 쓴다
                if (rows[0]) { unlinkAfter.push(rows[0].stored_path, rows[0].converted_path); }
                else { unlinkAfter.push(c.stored_path, c.converted_path); }
            }
        }
        for (const c of changes) {
            if (c.action !== 'replaced') continue;
            if (c.kind === 'gov_facility_files') {
                // 같은 행(id)이 새 파일을 가리키도록 갱신됐던 것 — 되돌리면 그 새 파일은 어디서도 쓰이지 않으니 지운다.
                const { rows } = await client.query('SELECT stored_path FROM gov_facility_files WHERE id = $1', [c.old_row.id]);
                if (rows[0] && rows[0].stored_path !== c.old_row.stored_path) unlinkAfter.push(rows[0].stored_path);
            }
            await upsertJsonRow(client, c.kind, c.old_row);
            if (c.trash_path) restoreMoves.push({ from: c.trash_path, to: c.old_row.stored_path });
            if (c.trash_converted) restoreMoves.push({ from: c.trash_converted, to: c.old_row.converted_path });
        }

        // 2) DB 행: 나중에 보관한 것부터 거꾸로
        const { rows: snaps } = await client.query('SELECT table_name, pk, old_row FROM bulk_import_snapshots WHERE batch_id = $1 ORDER BY id DESC', [batchId]);
        for (const s of snaps) {
            if (s.table_name === 'road_sectors') {
                const [rank, no, sect, st] = s.pk.split('|');
                await client.query('DELETE FROM road_sectors WHERE road_rank_code = $1 AND road_no = $2 AND sect = $3 AND sect_st = $4', [rank, no, sect, st]);
                if (s.old_row) await upsertJsonRow(client, 'road_sectors', s.old_row);
                continue;
            }
            const key = PK_BY_TABLE.get(s.table_name);
            if (!key) continue; // 알 수 없는 테이블은 건드리지 않는다
            if (s.old_row) await upsertJsonRow(client, s.table_name, s.old_row);
            else await client.query(`DELETE FROM ${s.table_name} WHERE ${key}::text = $1`, [s.pk]);
        }

        await client.query('DELETE FROM bulk_import_snapshots WHERE batch_id = $1', [batchId]);
        await client.query('DELETE FROM bulk_import_file_changes WHERE batch_id = $1', [batchId]);
        await client.query(`UPDATE bulk_import_batches SET status = 'undone', undone_at = now(), undone_by = $2 WHERE id = $1`, [batchId, user.username || null]);
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (e2) { /* 무시 */ }
        console.error('[importBatch/undo]', e);
        return { ok: false, status: 500, error: '되돌리는 중 오류가 발생했습니다. 아무것도 바뀌지 않았습니다.' };
    } finally {
        client.release();
    }

    // 커밋 뒤: 새 파일 삭제, 옛 파일 제자리로
    unlinkAfter.filter(Boolean).forEach((p) => fs.rm(p, { force: true }, () => {}));
    for (const m of restoreMoves) {
        try {
            await fs.promises.mkdir(path.dirname(m.to), { recursive: true });
            await fs.promises.rename(m.from, m.to);
        } catch (e) { missingFiles++; }
    }
    fs.rm(path.join(TRASH_ROOT, String(batchId)), { recursive: true, force: true }, () => {});

    await logAction(null, {
        action: 'bulk_undo', targetTable: 'road_sections', targetId: null,
        summary: `일괄등록 취소: #${batch.id} ${batch.source_label || ''} (${batch.summary ? batch.summary.slice(0, 80) : ''})`.trim(),
        detail: { batchId: batch.id, missingFiles }, sigunguCode: batch.sigungu_code, user, ip: undefined,
    });
    return { ok: true, missingFiles };
}

// 보관 기간/개수를 넘은 등록의 스냅샷과 휴지통 파일을 정리한다(되돌릴 수 없게 됨 → 'expired').
async function purgeOldBatches() {
    try {
        const { rows } = await pool.query(
            `SELECT id FROM bulk_import_batches WHERE status = 'applied' AND (
                created_at < now() - ($1 || ' days')::interval
                OR id NOT IN (SELECT id FROM bulk_import_batches WHERE status = 'applied' ORDER BY id DESC LIMIT $2)
             )`, [String(KEEP_DAYS), KEEP_BATCHES]
        );
        for (const r of rows) {
            await pool.query('DELETE FROM bulk_import_snapshots WHERE batch_id = $1', [r.id]);
            await pool.query('DELETE FROM bulk_import_file_changes WHERE batch_id = $1', [r.id]);
            await pool.query(`UPDATE bulk_import_batches SET status = 'expired' WHERE id = $1`, [r.id]);
            fs.rm(path.join(TRASH_ROOT, String(r.id)), { recursive: true, force: true }, () => {});
        }
        // 'running'인 채 오래 남은 것(서버가 도중에 꺼진 경우)은 실패로 정리
        await pool.query(`UPDATE bulk_import_batches SET status = 'failed', finished_at = now() WHERE status = 'running' AND created_at < now() - interval '12 hours'`);
    } catch (e) {
        console.error('[importBatch/purge]', e.message);
    }
}

async function listBatches(user, limit = 40) {
    const params = [limit];
    let where = '';
    if (user.sigunguCode) { params.push(user.sigunguCode); where = 'WHERE sigungu_code = $2 OR sigungu_code IS NULL'; }
    const { rows } = await pool.query(
        `SELECT id, created_at, finished_at, username, sigungu_code, source_label, status, summary, detail, undone_at, undone_by
         FROM bulk_import_batches ${where} ORDER BY id DESC LIMIT $1`, params
    );
    const latestBySigungu = new Map();
    for (const r of rows) {
        if (r.status === 'applied' && !latestBySigungu.has(r.sigungu_code || '')) latestBySigungu.set(r.sigungu_code || '', r.id);
    }
    return rows.map((r) => ({ ...r, undoable: r.status === 'applied' && latestBySigungu.get(r.sigungu_code || '') === r.id }));
}

module.exports = {
    createBatch, finishBatch, snapshotRows, snapshotSector, recordFileReplaced, recordFileAdded, moveFilesToTrash,
    makeRecorder, undoBatch, purgeOldBatches, listBatches, TRASH_ROOT,
};
