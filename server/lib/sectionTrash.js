// 노선(구간) 삭제 휴지통.
//
// 구간을 지울 때(lib/sectionDelete.js) 딸린 DB 행 전체를 section_trash_rows에 JSON으로 보관하고, 첨부·도면 파일은
// uploads/_section-trash/<id>/ 로 옮겨 둔다. 보관 기간(TRASH_DAYS) 안에는 관리 콘솔에서 "복원"할 수 있고, 기간이 지나면 자동으로
// 완전 삭제한다. DB 보관은 삭제와 같은 트랜잭션 안에서 하므로 "지워졌는데 휴지통엔 없는" 상태가 생기지 않는다.
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const config = require('../config');
const { logAction } = require('./auditLog');
const { upsertJsonRow, PK_BY_TABLE } = require('./importBatch');

const TRASH_ROOT = path.join(config.uploadDir, '_section-trash');
const TRASH_DAYS = Number(process.env.SECTION_TRASH_DAYS || 30);

async function isReady(db = pool) {
    const { rows } = await db.query(`SELECT to_regclass('public.section_trash') AS t`);
    return !!rows[0].t;
}

// ---- 삭제할 때(트랜잭션 안에서) 쓰는 기록 도구 ----
async function createEntry(client, section, rdid, user, sigunguCode) {
    const { rows } = await client.query(
        `INSERT INTO section_trash (expires_at, deleted_by_id, username, sigungu_code, rdid, road_rank_code, road_rank_name, route_no, route_name, sect)
         VALUES (now() + ($1 || ' days')::interval, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [String(TRASH_DAYS), user && user.id ? user.id : null, user && user.username ? String(user.username).slice(0, 50) : null, sigunguCode || null, rdid,
            section.road_rank_code, section.road_rank_name, section.route_no, section.route_name, section.sect]
    );
    return rows[0].id;
}

// table에서 where에 맞는 행을 지우기 "전에" 그대로 보관한다. 반환: 보관한 행 수
async function saveRows(client, trashId, table, pkColumn, where, params) {
    if (!PK_BY_TABLE.has(table)) throw new Error('보관할 수 없는 테이블입니다: ' + table);
    const r = await client.query(
        `INSERT INTO section_trash_rows (trash_id, table_name, pk, row_json)
         SELECT $${params.length + 1}, '${table}', ${pkColumn}::text, to_jsonb(t) FROM ${table} t WHERE ${where}`,
        [...params, trashId]
    );
    return r.rowCount;
}

// 파일 한 개를 휴지통으로 옮길 계획을 DB에 적고 {from,to}를 돌려준다(실제 이동은 커밋 뒤 moveToTrash가 한다).
async function planFile(client, trashId, original) {
    if (!original) return null;
    const to = path.join(TRASH_ROOT, String(trashId), `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}_${path.basename(original)}`);
    await client.query('INSERT INTO section_trash_files (trash_id, original_path, trash_path) VALUES ($1,$2,$3)', [trashId, original, to]);
    return { from: original, to };
}

async function moveFile(m) {
    try {
        await fs.promises.mkdir(path.dirname(m.to), { recursive: true });
        try { await fs.promises.rename(m.from, m.to); } catch (e) {
            await fs.promises.copyFile(m.from, m.to); // 다른 드라이브면 복사 후 삭제
            await fs.promises.rm(m.from, { force: true });
        }
        return (await fs.promises.stat(m.to)).size;
    } catch (e) {
        return 0; // 원본이 이미 없으면 보관할 것도 없다
    }
}

// 커밋 뒤에 파일을 옮기고 용량을 기록한다. 실패해도 삭제 자체는 이미 끝났다 — 그 파일만 복원되지 않는다.
async function moveToTrash(trashId, moves) {
    let bytes = 0;
    for (const m of moves) bytes += await moveFile(m);
    await pool.query('UPDATE section_trash SET file_bytes = $2 WHERE id = $1', [trashId, bytes]);
}

// ---- 목록 / 복원 / 정리 ----
function visibleTo(user, row) {
    return !user.sigunguCode || !row.sigungu_code || user.sigunguCode === row.sigungu_code;
}

async function listTrash(user) {
    const { rows } = await pool.query(
        `SELECT t.id, t.deleted_at, t.expires_at, t.username, t.sigungu_code, t.rdid, t.road_rank_name, t.route_no, t.route_name, t.sect, t.counts, t.file_bytes,
                EXISTS (SELECT 1 FROM road_sections s WHERE s.rdid = t.rdid) AS rdid_in_use
         FROM section_trash t ORDER BY t.deleted_at DESC, t.id DESC LIMIT 500`
    );
    return rows.filter((r) => visibleTo(user, r));
}

async function restore(trashId, user) {
    const { rows: [t] } = await pool.query('SELECT * FROM section_trash WHERE id = $1', [trashId]);
    if (!t) return { ok: false, status: 404, error: '휴지통에 없는 항목입니다(이미 복원했거나 보관 기간이 지났습니다).' };
    if (!visibleTo(user, t)) return { ok: false, status: 403, error: '관할 시군구 밖의 구간입니다.' };
    const { rows: exists } = await pool.query('SELECT 1 FROM road_sections WHERE rdid = $1', [t.rdid]);
    if (exists.length) return { ok: false, status: 409, error: '같은 구간번호(RDID)가 이미 다시 등록되어 있어 복원할 수 없습니다. 새로 등록된 구간을 먼저 삭제하세요.' };

    const client = await pool.connect();
    let restoredRows = 0;
    const moves = [];
    try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT table_name, pk, row_json FROM section_trash_rows WHERE trash_id = $1 ORDER BY id', [trashId]);
        // 구간(road_sections) 먼저, 나머지는 보관한 순서대로
        rows.sort((a, b) => (b.table_name === 'road_sections') - (a.table_name === 'road_sections'));
        for (const r of rows) {
            // 파일 행의 업로더 계정이 그 사이 삭제됐으면 FK에 걸리므로 비워 둔다(created_by/updated_by도 같다)
            for (const col of ['uploaded_by', 'created_by', 'updated_by']) {
                if (r.row_json[col] != null) {
                    const { rows: a } = await client.query('SELECT 1 FROM accounts WHERE id = $1', [r.row_json[col]]);
                    if (!a.length) r.row_json[col] = null;
                }
            }
            if (r.table_name === 'road_sectors') {
                // 500m 조각은 자연키 unique가 있어 같은 키가 다시 생겼으면 그 값으로 덮는다
                await client.query('DELETE FROM road_sectors WHERE road_rank_code = $1 AND road_no = $2 AND sect = $3 AND sect_st = $4',
                    [r.row_json.road_rank_code, r.row_json.road_no, r.row_json.sect, r.row_json.sect_st]);
            }
            await upsertJsonRow(client, r.table_name, r.row_json);
            restoredRows++;
        }
        const { rows: files } = await client.query('SELECT original_path, trash_path FROM section_trash_files WHERE trash_id = $1', [trashId]);
        files.forEach((f) => moves.push({ from: f.trash_path, to: f.original_path }));
        await client.query('DELETE FROM section_trash WHERE id = $1', [trashId]); // rows/files는 CASCADE
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (e2) { /* 무시 */ }
        console.error('[sectionTrash/restore]', e);
        return { ok: false, status: 500, error: '복원 중 오류가 발생했습니다. 아무것도 바뀌지 않았습니다.' };
    } finally {
        client.release();
    }

    let missingFiles = 0;
    for (const m of moves) {
        try {
            await fs.promises.mkdir(path.dirname(m.to), { recursive: true });
            await fs.promises.rename(m.from, m.to);
        } catch (e) { missingFiles++; }
    }
    fs.rm(path.join(TRASH_ROOT, String(trashId)), { recursive: true, force: true }, () => {});

    await logAction(null, {
        action: 'restore', targetTable: 'road_sections', targetId: t.rdid,
        summary: `구간 복원: ${t.road_rank_name || ''} ${t.route_no || ''} ${t.route_name || ''} ${t.sect || ''}구간 (${restoredRows}건 복원)`.replace(/\s+/g, ' ').trim(),
        detail: { trashId, restoredRows, missingFiles }, sigunguCode: t.sigungu_code, user,
    });
    return { ok: true, restoredRows, missingFiles };
}

// 휴지통 항목 하나를 지금 완전히 지운다(보관 기간 전에 용량을 비우고 싶을 때). 복원할 수 없다.
async function purgeOne(trashId, user) {
    const { rows: [t] } = await pool.query('SELECT * FROM section_trash WHERE id = $1', [trashId]);
    if (!t) return { ok: false, status: 404, error: '휴지통에 없는 항목입니다.' };
    if (!visibleTo(user, t)) return { ok: false, status: 403, error: '관할 시군구 밖의 구간입니다.' };
    await pool.query('DELETE FROM section_trash WHERE id = $1', [trashId]);
    fs.rm(path.join(TRASH_ROOT, String(trashId)), { recursive: true, force: true }, () => {});
    await logAction(null, {
        action: 'delete', targetTable: 'road_sections', targetId: t.rdid,
        summary: `휴지통 비우기(복원 불가): ${t.road_rank_name || ''} ${t.route_no || ''} ${t.route_name || ''} ${t.sect || ''}구간`.replace(/\s+/g, ' ').trim(),
        detail: { trashId }, sigunguCode: t.sigungu_code, user,
    });
    return { ok: true };
}

// 보관 기간이 지난 항목을 완전 삭제한다(시작할 때 한 번, 그 뒤 6시간마다).
async function purgeExpired() {
    try {
        if (!(await isReady())) return;
        const { rows } = await pool.query('DELETE FROM section_trash WHERE expires_at < now() RETURNING id');
        for (const r of rows) fs.rm(path.join(TRASH_ROOT, String(r.id)), { recursive: true, force: true }, () => {});
        // DB에는 없는데 폴더만 남은 것(삭제 도중 서버가 꺼진 경우)도 정리
        if (fs.existsSync(TRASH_ROOT)) {
            const { rows: live } = await pool.query('SELECT id FROM section_trash');
            const liveSet = new Set(live.map((r) => String(r.id)));
            for (const name of await fs.promises.readdir(TRASH_ROOT)) {
                if (!liveSet.has(name)) fs.rm(path.join(TRASH_ROOT, name), { recursive: true, force: true }, () => {});
            }
        }
    } catch (e) { console.error('[sectionTrash/purge]', e.message); }
}

module.exports = { TRASH_DAYS, TRASH_ROOT, isReady, createEntry, saveRows, planFile, moveToTrash, listTrash, restore, purgeOne, purgeExpired };
