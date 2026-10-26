// 기존 업로드 파일을 시군구별 폴더 구조로 옮긴다(lib/uploadPaths.js 참고).
//   routes/<도로종류__노선번호__노선명>/…        → routes/<시군구>/<…>/…
//   road-issues/<번호>/…                          → road-issues/<시군구>/<번호>/…
//   uploads/<PNU>/…                               → parcels/<시군구>/<PNU>/…
//   gov-facility-files/<다른 시군구 또는 unassigned>/ → 파일 행의 시군구 폴더
// 옮기면서 DB에 적힌 파일 경로(route_files, road_issue_files, road_ledger_files, gov_facility_files)와, 아직 남아 있는 이력 기록
// (일괄등록 되돌리기, 노선 삭제 휴지통)의 경로도 같이 바꾼다. 시군구가 비어 있는 도면 행은 그 구간의 시군구로 채운다.
//
// 사용법 (서버는 멈추고 하는 것을 권장, 먼저 백업):
//   node db/migrate-upload-folders.js                      # 미리보기(아무것도 바꾸지 않음)
//   node db/migrate-upload-folders.js --apply              # 실제로 옮김 — uploads/_migration-<시각>.json 에 되돌릴 기록을 남김
//   node db/migrate-upload-folders.js --rollback <기록파일>  # 되돌림
// 여러 번 실행해도 안전하다(이미 옮긴 것은 건너뛴다).
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const config = require('../config');
const { relocate } = require('../lib/uploadPaths');

const APPLY = process.argv.includes('--apply');
const rbIdx = process.argv.indexOf('--rollback');
const ROLLBACK_FILE = rbIdx > -1 ? process.argv[rbIdx + 1] : null;

function moveFile(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.renameSync(from, to); } catch (e) {
        fs.copyFileSync(from, to);
        fs.rmSync(from, { force: true });
    }
}
const reloc = (p, sg) => relocate(p, sg, 'route') || relocate(p, sg, 'facility');

async function tableExists(name) {
    const { rows } = await pool.query('SELECT to_regclass($1) AS t', ['public.' + name]);
    return !!rows[0].t;
}

async function plan() {
    const moves = new Map();   // from -> to (같은 파일을 두 행이 가리켜도 한 번만 옮긴다)
    const updates = [];        // { table, idCol, id, col, oldVal, newVal, json }
    const backfill = [];       // { id, sigungu } route_files 시군구 채우기
    const missing = [];
    const addPath = (table, id, col, oldVal, newVal, isJson = false) => { if (newVal && newVal !== oldVal) updates.push({ table, idCol: 'id', id, col, oldVal, newVal, json: isJson }); };
    // 파일이 실제로 있고 옮길 수 있을 때만 true — 그때만 DB 경로도 바꾼다(없는 파일의 기록은 그대로 둔다).
    const addMove = (from, to) => {
        if (!to || to === from) return false;
        if (moves.get(from) === to) return true;
        if (!fs.existsSync(from)) { missing.push(from); return false; }
        if (fs.existsSync(to)) { missing.push(`(대상이 이미 있음) ${to}`); return false; }
        moves.set(from, to);
        return true;
    };

    // 1) 노선 도면
    const { rows: rf } = await pool.query(
        `SELECT f.id, f.stored_path, f.converted_path, f.sigungu_code, s.sigungu_code AS sec_sg
         FROM route_files f LEFT JOIN road_sections s ON s.rdid = f.section_rdid`);
    for (const r of rf) {
        const sg = r.sigungu_code || r.sec_sg || null;
        if (!r.sigungu_code && r.sec_sg) backfill.push({ id: r.id, sigungu: r.sec_sg });
        const ns = relocate(r.stored_path, sg, 'route');
        const nc = r.converted_path ? relocate(r.converted_path, sg, 'route') : null;
        if (ns && addMove(r.stored_path, ns)) addPath('route_files', r.id, 'stored_path', r.stored_path, ns);
        if (nc && addMove(r.converted_path, nc)) addPath('route_files', r.id, 'converted_path', r.converted_path, nc);
    }
    // 2) 사용자도로관리 첨부
    const { rows: ri } = await pool.query(`SELECT f.id, f.stored_path, i.sigungu_code FROM road_issue_files f JOIN road_issues i ON i.id = f.issue_id`);
    for (const r of ri) { const n = relocate(r.stored_path, r.sigungu_code, 'issue'); if (n && addMove(r.stored_path, n)) addPath('road_issue_files', r.id, 'stored_path', r.stored_path, n); }
    // 3) 필지 첨부
    const { rows: rl } = await pool.query(`SELECT id, stored_path FROM road_ledger_files`);
    for (const r of rl) { const n = relocate(r.stored_path, null, 'parcel'); if (n && addMove(r.stored_path, n)) addPath('road_ledger_files', r.id, 'stored_path', r.stored_path, n); }
    // 4) 시설물 사진·보고서(시군구 폴더가 행의 시군구와 다른 것)
    const { rows: gf } = await pool.query(`SELECT id, stored_path, sigungu_code FROM gov_facility_files`);
    for (const r of gf) { const n = relocate(r.stored_path, r.sigungu_code, 'facility'); if (n && addMove(r.stored_path, n)) addPath('gov_facility_files', r.id, 'stored_path', r.stored_path, n); }

    // 5) 이력 기록 속 경로(일괄등록 되돌리기)
    if (await tableExists('bulk_import_file_changes')) {
        const { rows } = await pool.query(
            `SELECT c.id, c.stored_path, c.converted_path, c.old_row, b.sigungu_code AS batch_sg
             FROM bulk_import_file_changes c JOIN bulk_import_batches b ON b.id = c.batch_id`);
        for (const r of rows) {
            const sg = (r.old_row && r.old_row.sigungu_code) || r.batch_sg || null;
            addPath('bulk_import_file_changes', r.id, 'stored_path', r.stored_path, reloc(r.stored_path, sg));
            addPath('bulk_import_file_changes', r.id, 'converted_path', r.converted_path, reloc(r.converted_path, sg));
            if (r.old_row) {
                const o = { ...r.old_row };
                const a = reloc(o.stored_path, sg); const b = reloc(o.converted_path, sg);
                if (a) o.stored_path = a;
                if (b) o.converted_path = b;
                if (a || b) addPath('bulk_import_file_changes', r.id, 'old_row', JSON.stringify(r.old_row), JSON.stringify(o), true);
            }
        }
    }
    // 6) 이력 기록 속 경로(노선 삭제 휴지통)
    if (await tableExists('section_trash')) {
        const { rows: tf } = await pool.query(`SELECT f.id, f.original_path, t.sigungu_code FROM section_trash_files f JOIN section_trash t ON t.id = f.trash_id`);
        for (const r of tf) addPath('section_trash_files', r.id, 'original_path', r.original_path, reloc(r.original_path, r.sigungu_code));
        const { rows: tr } = await pool.query(
            `SELECT r.id, r.row_json, t.sigungu_code FROM section_trash_rows r JOIN section_trash t ON t.id = r.trash_id
             WHERE r.table_name IN ('route_files', 'gov_facility_files')`);
        for (const r of tr) {
            const sg = r.row_json.sigungu_code || r.sigungu_code || null;
            const o = { ...r.row_json };
            const a = reloc(o.stored_path, sg); const b = reloc(o.converted_path, sg);
            if (a) o.stored_path = a;
            if (b) o.converted_path = b;
            if (a || b) addPath('section_trash_rows', r.id, 'row_json', JSON.stringify(r.row_json), JSON.stringify(o), true);
        }
    }
    return { moves, updates, backfill, missing };
}

async function applyPlan(p) {
    const done = [];
    const client = await pool.connect();
    try {
        for (const [from, to] of p.moves) { moveFile(from, to); done.push([from, to]); }
        await client.query('BEGIN');
        for (const u of p.updates) {
            await client.query(`UPDATE ${u.table} SET ${u.col} = ${u.json ? '$1::jsonb' : '$1'} WHERE ${u.idCol} = $2`, [u.newVal, u.id]);
        }
        for (const b of p.backfill) await client.query('UPDATE route_files SET sigungu_code = $1 WHERE id = $2 AND sigungu_code IS NULL', [b.sigungu, b.id]);
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (e2) { /* 무시 */ }
        for (const [from, to] of done.reverse()) { try { moveFile(to, from); } catch (e2) { console.error('되돌리지 못함:', to); } }
        client.release();
        throw e;
    }
    client.release();
    const logFile = path.join(config.uploadDir, `_migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(logFile, JSON.stringify({ moves: [...p.moves], updates: p.updates, backfill: p.backfill }, null, 1));
    return logFile;
}

function removeEmptyDirs(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name));
    if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
}

async function rollback(file) {
    const log = JSON.parse(fs.readFileSync(file, 'utf8'));
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const u of log.updates) await client.query(`UPDATE ${u.table} SET ${u.col} = ${u.json ? '$1::jsonb' : '$1'} WHERE ${u.idCol} = $2`, [u.oldVal, u.id]);
        for (const b of log.backfill) await client.query('UPDATE route_files SET sigungu_code = NULL WHERE id = $1', [b.id]);
        await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); client.release(); throw e; }
    client.release();
    let n = 0;
    for (const [from, to] of log.moves) { if (fs.existsSync(to)) { moveFile(to, from); n++; } }
    ['routes', 'road-issues', 'parcels', 'gov-facility-files'].forEach((d) => removeEmptyDirs(path.join(config.uploadDir, d)));
    console.log(`되돌림 완료: 파일 ${n}개, DB 경로 ${log.updates.length}건`);
}

async function main() {
    if (ROLLBACK_FILE) { await rollback(ROLLBACK_FILE); return; }
    const p = await plan();
    const byTable = {};
    p.updates.forEach((u) => { byTable[u.table + '.' + u.col] = (byTable[u.table + '.' + u.col] || 0) + 1; });
    console.log(`옮길 파일 ${p.moves.size}개 / DB 경로 갱신 ${p.updates.length}건 / 시군구 채울 도면 행 ${p.backfill.length}건`);
    console.log('DB 갱신 내역:', byTable);
    if (p.missing.length) console.log(`건너뜀(파일 없음/대상 있음) ${p.missing.length}건 — 예:`, p.missing.slice(0, 3));
    [...p.moves].slice(0, 4).forEach(([a, b]) => console.log('  ', path.relative(config.uploadDir, a), '\n   →', path.relative(config.uploadDir, b)));
    if (!APPLY) { console.log('\n(미리보기입니다. 실제로 옮기려면 --apply 를 붙이세요.)'); return; }
    const logFile = await applyPlan(p);
    ['routes', 'road-issues'].forEach((d) => removeEmptyDirs(path.join(config.uploadDir, d)));
    console.log('\n완료. 되돌릴 기록:', logFile);
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
