// 시설물별 점검·보수 이력과 변경 이력.
//   점검·보수 이력 : 시설물(table + rdid)마다 점검/보수 기록을 쌓는다(facility_maintenance). 보기는 모두, 추가·수정·삭제는 관리자(편집 모드)만.
//                    기록을 바꾸면 변경·접속 이력(audit_log)에도 남는다.
//   변경 이력      : 그 시설물에 일어난 일을 시간 순으로 모아 보여 준다 — 점검·보수 기록 변경, 사진·보고서 올리기/삭제(audit_log),
//                    일괄등록으로 새로 들어오거나 값이 바뀐 것(bulk_import_snapshots, 보관 기간 안의 것만).
// table 이름은 GOV_LAYER_MAP에 있는 시설물 테이블만 받아 SQL에 쓴다. 다른 시군구의 시설물은 보이지도 바꿀 수도 없다.
const express = require('express');
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/requireAuth');
const { GOV_LAYER_MAP } = require('../lib/govLayerMap');
const { getTableLabels } = require('../lib/schemaLabels');
const { logAction, clientIp } = require('../lib/auditLog');

const router = express.Router();
router.use(requireAuth);

const LAYER_BY_TABLE = Object.fromEntries(Object.values(GOV_LAYER_MAP).map((l) => [l.table, l]));
const KINDS = ['점검', '보수'];
const RESULTS = {
    점검: ['양호', '보통', '불량', '조치필요'],
    보수: ['예정', '진행중', '완료'],
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACTION_NAME = { maint_create: '등록', maint_update: '수정', maint_delete: '삭제' };

function outsideJurisdiction(userSigungu, rowSigungu) {
    return !!userSigungu && !!rowSigungu && userSigungu !== rowSigungu;
}

// 시설물 한 건을 찾고 이 계정의 관할 안인지 확인한다. 없거나 관할 밖이면 null.
async function findFacility(table, rdid, user) {
    const layer = LAYER_BY_TABLE[table];
    if (!layer || !rdid || String(rdid).length > 40) return null;
    const { rows } = await pool.query(`SELECT ${layer.pkColumn} AS rdid, sigungu_code FROM ${table} WHERE ${layer.pkColumn} = $1`, [rdid]);
    const row = rows[0];
    if (!row || outsideJurisdiction(user.sigunguCode, row.sigungu_code)) return null;
    return { table, rdid: row.rdid, sigungu: row.sigungu_code, label: layer.koreanName };
}

const SELECT_COLS = `id, facility_table, facility_rdid, kind, to_char(performed_on, 'YYYY-MM-DD') AS performed_on, result, title, detail,
    cost_won, contractor, to_char(next_due, 'YYYY-MM-DD') AS next_due, created_by_name, updated_by_name, created_at, updated_at`;

// 요청 본문을 검사해서 저장할 값으로 만든다. 문제가 있으면 { error }.
function parseRecord(body) {
    const kind = String(body.kind || '').trim();
    if (!KINDS.includes(kind)) return { error: '구분(점검/보수)을 선택하세요.' };
    const performedOn = String(body.performed_on || '').trim();
    if (!DATE_RE.test(performedOn) || Number.isNaN(Date.parse(performedOn))) return { error: '일자를 정확히 입력하세요.' };
    const result = String(body.result || '').trim();
    if (result && !RESULTS[kind].includes(result)) return { error: `${kind} 결과는 ${RESULTS[kind].join('/')} 중에서 고르세요.` };
    const title = String(body.title || '').trim().slice(0, 200);
    if (!title) return { error: '내용(한 줄 제목)을 입력하세요.' };
    const detail = String(body.detail || '').trim().slice(0, 5000) || null;
    const contractor = String(body.contractor || '').trim().slice(0, 100) || null;
    let cost = null;
    if (body.cost_won !== undefined && body.cost_won !== null && String(body.cost_won).trim() !== '') {
        cost = Number(String(body.cost_won).replace(/,/g, ''));
        if (!Number.isFinite(cost) || cost < 0 || cost > 1e13) return { error: '비용은 0 이상의 숫자(원)로 입력하세요.' };
        cost = Math.round(cost);
    }
    let nextDue = String(body.next_due || '').trim() || null;
    if (nextDue && (!DATE_RE.test(nextDue) || Number.isNaN(Date.parse(nextDue)))) return { error: '다음 점검 예정일을 정확히 입력하세요.' };
    if (nextDue && nextDue < performedOn) return { error: '다음 점검 예정일은 일자보다 빠를 수 없습니다.' };
    return { value: { kind, performedOn, result: result || null, title, detail, cost, contractor, nextDue } };
}

// ---- 점검·보수 목록 ----
router.get('/maintenance', async (req, res) => {
    const facility = await findFacility(String(req.query.table || '').trim(), String(req.query.rdid || '').trim(), req.session.user);
    if (!facility) return res.json({ items: [], summary: null });
    const { rows } = await pool.query(
        `SELECT ${SELECT_COLS} FROM facility_maintenance WHERE facility_table = $1 AND facility_rdid = $2
         ORDER BY performed_on DESC, id DESC`, [facility.table, facility.rdid]
    );
    const lastInspection = rows.find((r) => r.kind === '점검') || null;
    const latestWithDue = rows.find((r) => r.next_due) || null; // 가장 최근 기록에 적은 다음 점검 예정일
    res.json({
        items: rows,
        summary: {
            count: rows.length,
            inspections: rows.filter((r) => r.kind === '점검').length,
            repairs: rows.filter((r) => r.kind === '보수').length,
            lastInspection: lastInspection ? { performed_on: lastInspection.performed_on, result: lastInspection.result } : null,
            nextDue: latestWithDue ? latestWithDue.next_due : null,
        },
    });
});

// ---- 추가 / 수정 / 삭제 (관리자 · 편집 모드) ----
router.post('/maintenance', requireAdmin, async (req, res) => {
    const facility = await findFacility(String(req.body.table || '').trim(), String(req.body.rdid || '').trim(), req.session.user);
    if (!facility) return res.status(404).json({ error: '시설물을 찾을 수 없거나 관할 밖입니다.' });
    const parsed = parseRecord(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const v = parsed.value;
    const user = req.session.user;
    const { rows } = await pool.query(
        `INSERT INTO facility_maintenance (facility_table, facility_rdid, kind, performed_on, result, title, detail, cost_won, contractor, next_due,
                                           sigungu_code, created_by, created_by_name, updated_by, updated_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$12,$13)
         RETURNING ${SELECT_COLS}`,
        [facility.table, facility.rdid, v.kind, v.performedOn, v.result, v.title, v.detail, v.cost, v.contractor, v.nextDue,
            facility.sigungu, user.id, user.username || null]
    );
    await logAction(null, {
        action: 'maint_create', targetTable: 'facility_maintenance', targetId: facility.rdid,
        summary: `${v.kind} 기록 등록: ${facility.label} ${facility.rdid} — ${v.title}`,
        detail: { table: facility.table, id: rows[0].id, after: v }, sigunguCode: facility.sigungu, user, ip: clientIp(req),
    });
    res.status(201).json({ item: rows[0] });
});

async function loadOwned(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) { res.status(400).json({ error: '잘못된 번호입니다.' }); return null; }
    const { rows } = await pool.query(`SELECT ${SELECT_COLS}, sigungu_code FROM facility_maintenance WHERE id = $1`, [id]); // 날짜는 문자열(YYYY-MM-DD)로 — Date 객체로 받으면 이력에 시간대가 섞여 저장된다
    const row = rows[0];
    if (!row || outsideJurisdiction(req.session.user.sigunguCode, row.sigungu_code)) { res.status(404).json({ error: '기록을 찾을 수 없습니다.' }); return null; }
    return row;
}

router.put('/maintenance/:id', requireAdmin, async (req, res) => {
    const old = await loadOwned(req, res);
    if (!old) return;
    const parsed = parseRecord(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const v = parsed.value;
    const user = req.session.user;
    const { rows } = await pool.query(
        `UPDATE facility_maintenance SET kind=$2, performed_on=$3, result=$4, title=$5, detail=$6, cost_won=$7, contractor=$8, next_due=$9,
                updated_by=$10, updated_by_name=$11, updated_at=now()
         WHERE id=$1 RETURNING ${SELECT_COLS}`,
        [old.id, v.kind, v.performedOn, v.result, v.title, v.detail, v.cost, v.contractor, v.nextDue, user.id, user.username || null]
    );
    const label = (LAYER_BY_TABLE[old.facility_table] || {}).koreanName || old.facility_table;
    await logAction(null, {
        action: 'maint_update', targetTable: 'facility_maintenance', targetId: old.facility_rdid,
        summary: `${v.kind} 기록 수정: ${label} ${old.facility_rdid} — ${v.title}`,
        detail: {
            table: old.facility_table, id: old.id,
            before: { kind: old.kind, performed_on: old.performed_on, result: old.result, title: old.title, detail: old.detail, cost_won: old.cost_won, contractor: old.contractor, next_due: old.next_due },
            after: v,
        },
        sigunguCode: old.sigungu_code, user, ip: clientIp(req),
    });
    res.json({ item: rows[0] });
});

router.delete('/maintenance/:id', requireAdmin, async (req, res) => {
    const old = await loadOwned(req, res);
    if (!old) return;
    await pool.query('DELETE FROM facility_maintenance WHERE id = $1', [old.id]);
    const label = (LAYER_BY_TABLE[old.facility_table] || {}).koreanName || old.facility_table;
    await logAction(null, {
        action: 'maint_delete', targetTable: 'facility_maintenance', targetId: old.facility_rdid,
        summary: `${old.kind} 기록 삭제: ${label} ${old.facility_rdid} — ${old.title}`,
        detail: { table: old.facility_table, id: old.id, before: { kind: old.kind, performed_on: old.performed_on, result: old.result, title: old.title, detail: old.detail, cost_won: old.cost_won, contractor: old.contractor, next_due: old.next_due } },
        sigunguCode: old.sigungu_code, user: req.session.user, ip: clientIp(req),
    });
    res.json({ ok: true });
});

// ---- 변경 이력(시간순) ----
// 반환 항목: { at, type, who, text, fields? } — type: maint | file | import_new | import_update
router.get('/changes', async (req, res) => {
    const facility = await findFacility(String(req.query.table || '').trim(), String(req.query.rdid || '').trim(), req.session.user);
    if (!facility) return res.json({ items: [] });
    const items = [];

    // 1) 변경·접속 이력(audit_log): 이 시설물의 점검·보수 기록 변경, 사진·보고서 올리기/삭제
    const { rows: logs } = await pool.query(
        `SELECT action, target_table, summary, detail, username, created_at FROM audit_log
          WHERE target_id = $1 AND target_table IN ('facility_maintenance', 'gov_facility_files', $2)
          ORDER BY created_at DESC LIMIT 300`, [facility.rdid, facility.table]
    );
    logs.forEach((l) => {
        if (l.target_table === 'facility_maintenance') {
            const d = l.detail || {};
            if (d.table && d.table !== facility.table) return;
            const fields = [];
            if (l.action === 'maint_update' && d.before && d.after) {
                const map = { kind: '구분', performed_on: '일자', result: '결과', title: '내용', detail: '상세', cost_won: '비용', contractor: '업체', next_due: '다음 점검 예정일' };
                const after = { kind: d.after.kind, performed_on: d.after.performedOn, result: d.after.result, title: d.after.title, detail: d.after.detail, cost_won: d.after.cost, contractor: d.after.contractor, next_due: d.after.nextDue };
                Object.keys(map).forEach((k) => {
                    const b = d.before[k] == null ? '' : String(d.before[k]);
                    const a = after[k] == null ? '' : String(after[k]);
                    if (b !== a) fields.push({ label: map[k], before: b || '(없음)', after: a || '(없음)' });
                });
            }
            items.push({ at: l.created_at, type: 'maint', who: l.username, text: l.summary, fields });
        } else if (l.target_table === 'gov_facility_files') {
            items.push({ at: l.created_at, type: 'file', who: l.username, text: l.summary, fields: [] });
        } else {
            items.push({ at: l.created_at, type: 'edit', who: l.username, text: l.summary, fields: [] });
        }
    });

    // 2) 일괄등록으로 새로 들어오거나 값이 바뀐 기록(보관 기간 안의 것만 — lib/importBatch.js)
    try {
        const { rows: snaps } = await pool.query(
            `SELECT s.old_row, b.id AS batch_id, b.created_at, b.username, b.source_label, b.status
               FROM bulk_import_snapshots s JOIN bulk_import_batches b ON b.id = s.batch_id
              WHERE s.table_name = $1 AND s.pk = $2 AND b.status IN ('applied', 'undone')
              ORDER BY b.created_at DESC LIMIT 50`, [facility.table, facility.rdid]
        );
        if (snaps.length) {
            const { rows: curRows } = await pool.query(`SELECT * FROM ${facility.table} WHERE ${LAYER_BY_TABLE[facility.table].pkColumn} = $1`, [facility.rdid]);
            const cur = curRows[0] || {};
            const labels = getTableLabels(facility.table);
            snaps.forEach((s) => {
                const undone = s.status === 'undone' ? ' (이후 취소됨)' : '';
                if (!s.old_row) {
                    items.push({ at: s.created_at, type: 'import_new', who: s.username, text: `일괄등록 #${s.batch_id}로 새로 등록됨${s.source_label ? ` — ${s.source_label}` : ''}${undone}`, fields: [] });
                    return;
                }
                const fields = [];
                Object.keys(s.old_row).forEach((k) => {
                    if (k === 'geom' || k === 'sigungu_code') return;
                    const b = s.old_row[k] == null ? '' : String(s.old_row[k]);
                    const a = cur[k] == null ? '' : String(cur[k]);
                    if (b !== a && fields.length < 12) fields.push({ label: labels[k] || k, before: b || '(없음)', after: a || '(없음)' });
                });
                items.push({
                    at: s.created_at, type: 'import_update', who: s.username,
                    text: `일괄등록 #${s.batch_id}로 값이 바뀜${s.source_label ? ` — ${s.source_label}` : ''}${undone}`,
                    fields, note: fields.length ? '바뀌기 전 값 → 지금 값 (그 뒤에 또 바뀐 항목도 지금 값 기준으로 보입니다)' : '바뀐 항목이 지금 값과는 같습니다.',
                });
            });
        }
    } catch (e) { /* 일괄등록 이력 테이블이 아직 없는 서버(schema.sql 재적용 전)여도 나머지 이력은 보여 준다 */ }

    items.sort((a, b) => new Date(b.at) - new Date(a.at));
    res.json({ items: items.slice(0, 300) });
});

module.exports = router;
