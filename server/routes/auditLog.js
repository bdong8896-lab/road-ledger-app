// 변경 이력·접속 이력(감사 로그) 조회 — 관리자 전용. sections.js(구간 등록/수정/삭제),
// bulkImport.js(일괄등록), auth.js(로그인/로그아웃/가입/승인/계정 생성·삭제)에서
// lib/auditLog.js의 logAction()으로 기록해둔 것을 목록으로 보여주고, 같은 조건으로
// CSV(텍스트) 파일로 내려받을 수 있다(감사·보고 제출용).
const express = require('express');
const pool = require('../db');
const { requireAdminReauth } = require('../middleware/requireAuth');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { logAction, clientIp, displayIp } = require('../lib/auditLog');

const router = express.Router();
router.use(requireAdminReauth); // 관리 콘솔 재인증(15분) 필요

const ACTION_LABELS = {
    create: '등록', update: '수정', delete: '삭제', bulk_import: '일괄등록', bulk_undo: '일괄등록 취소', restore: '복원',
    maint_create: '점검·보수 등록', maint_update: '점검·보수 수정', maint_delete: '점검·보수 삭제',
    login: '로그인', login_fail: '로그인 실패', logout: '로그아웃',
    signup: '가입 신청', approve: '가입 승인', account_create: '계정 생성', account_delete: '계정 삭제',
    password_change: '비밀번호 변경', password_reset: '비밀번호 재설정',
    log_export: '이력 다운로드', log_purge: '이력 정리', admin_reauth: '관리자 재인증', export: '자료 내려받기',
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 목록과 다운로드가 같은 필터를 쓴다 — 로그인 계정의 관할(시군구) 범위 + 작업 종류 +
// 기간(from~to, 한국시간 기준 날짜, to는 그날 끝까지 포함).
function buildFilter(req) {
    const userSigungu = req.session.user.sigunguCode;
    const action = (req.query.action || '').trim();
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const conditions = [];
    const params = [];
    if (userSigungu) {
        params.push(userSigungu);
        // 계정·접속 이력(target_table='accounts'/'audit_log')은 관할 제한 없이 모든 관리자에게 보인다 —
        // 계정 관리(승인·재설정·삭제)가 관할과 무관하게 전체 계정 대상이라, 다른 관할 계정의
        // 비밀번호 변경·로그인 실패 같은 이력이 안 보이면 관리 근거가 사라진다.
        conditions.push(`(sigungu_code = $${params.length} OR sigungu_code IS NULL OR target_table IN ('accounts', 'audit_log'))`);
    }
    if (action) {
        params.push(action);
        conditions.push(`action = $${params.length}`);
    }
    if (DATE_RE.test(from)) {
        params.push(from);
        conditions.push(`created_at >= ($${params.length}::date)::timestamp AT TIME ZONE 'Asia/Seoul'`);
    }
    if (DATE_RE.test(to)) {
        params.push(to);
        conditions.push(`created_at < (($${params.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul')`);
    }
    return {
        where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
        params,
        summary: [action ? `종류=${ACTION_LABELS[action] || action}` : '', DATE_RE.test(from) ? `from=${from}` : '', DATE_RE.test(to) ? `to=${to}` : '']
            .filter(Boolean).join(', ') || '조건 없음',
    };
}

router.get('/', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size, 10) || 30));
    const { where, params } = buildFilter(req);

    const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM audit_log ${where}`, params);
    const total = parseInt(countRows[0].count, 10);

    params.push(size, (page - 1) * size);
    const { rows } = await pool.query(
        `SELECT id, action, target_table, target_id, summary, detail, sigungu_code, username, ip, created_at
         FROM audit_log ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    res.json({ total, totalPages: Math.max(1, Math.ceil(total / size)), items: rows.map((r) => ({ ...r, ip: displayIp(r.ip) })) });
});

// CSV 셀 — 따옴표/쉼표/줄바꿈을 감싸고, 엑셀에서 수식으로 실행될 수 있는 시작 문자(= + - @)는
// 앞에 '를 붙여 무력화한다(로그인 실패 이력의 "시도한 아이디"는 외부인이 임의 문자열로
// 넣을 수 있어서 CSV 인젝션 통로가 될 수 있다).
function csvCell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const EXPORT_MAX_ROWS = 100000;

router.get('/export', async (req, res) => {
    try {
        const { where, params, summary } = buildFilter(req);
        const { rows } = await pool.query(
            `SELECT to_char(created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') AS at,
                    action, username, ip, sigungu_code, summary, target_table, target_id
             FROM audit_log ${where}
             ORDER BY created_at DESC
             LIMIT ${EXPORT_MAX_ROWS + 1}`,
            params
        );
        const truncated = rows.length > EXPORT_MAX_ROWS;
        if (truncated) rows.pop();

        const lines = [['일시(KST)', '구분', '아이디', 'IP', '관할코드', '내용', '대상', '대상ID'].map(csvCell).join(',')];
        for (const r of rows) {
            lines.push([
                r.at, ACTION_LABELS[r.action] || r.action, r.username, displayIp(r.ip), r.sigungu_code,
                r.summary, r.target_table, r.target_id,
            ].map(csvCell).join(','));
        }
        // 내려받은 사실 자체도 이력에 남긴다(누가 이력을 뽑아갔는지 추적).
        await logAction(null, {
            action: 'log_export', targetTable: 'audit_log',
            summary: `이력 다운로드(${summary}): ${rows.length}건${truncated ? ` — 상한 ${EXPORT_MAX_ROWS}건에서 잘림` : ''}`,
            user: req.session.user, sigunguCode: req.session.user.sigunguCode, ip: clientIp(req),
        });

        const today = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`변경접속이력_${today}.csv`)}`);
        // 맨 앞 BOM(﻿) — 없으면 한국어 엑셀이 UTF-8 CSV의 한글을 깨뜨려 연다. 메모장에서도 정상.
        res.send('﻿' + lines.join('\r\n') + '\r\n');
    } catch (e) {
        console.error('[audit-log/export]', e);
        res.status(500).json({ error: '이력 다운로드 중 오류가 발생했습니다.' });
    }
});

// ---- 보관 정책: 1년이 지난 이력을 파일로 보관하고 DB에서 정리 ----
// 지침상 접속·변경 이력은 최소 1년 보관해야 하므로, DB에서 지울 수 있는 것은 "1년이 지난 것"뿐이다(서버가 강제).
// 지우기 전에 CSV 파일로 전부 저장하고 파일이 제대로 써진 것을 확인한 뒤에만 DB에서 지운다.
// 이력은 모든 시군구의 기록이 한 테이블에 있으므로, 관할이 제한된 관리자는 정리할 수 없다(조회·다운로드만).
const MIN_KEEP_DAYS = 365;
const ARCHIVE_NAME_RE = /^audit-log_\d{8}-\d{8}_\d{14}\.csv$/;

function archiveDir() { return config.auditArchiveDir; }

async function listArchiveFiles() {
    try {
        const names = (await fs.promises.readdir(archiveDir())).filter((n) => ARCHIVE_NAME_RE.test(n));
        const out = [];
        for (const name of names) {
            const st = await fs.promises.stat(path.join(archiveDir(), name));
            out.push({ name, bytes: st.size, savedAt: st.mtime });
        }
        return out.sort((a, b) => b.name.localeCompare(a.name));
    } catch (e) { return []; }
}

router.get('/retention', async (req, res) => {
    const { rows: [r] } = await pool.query(
        `SELECT COUNT(*)::int AS total,
                to_char(MIN(created_at) AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS oldest,
                COUNT(*) FILTER (WHERE created_at < (((now() AT TIME ZONE 'Asia/Seoul')::date - $1::int)::timestamp AT TIME ZONE 'Asia/Seoul'))::int AS eligible,
                to_char((now() AT TIME ZONE 'Asia/Seoul')::date - $1::int, 'YYYY-MM-DD') AS latest_cutoff
         FROM audit_log`, [MIN_KEEP_DAYS]
    );
    res.json({
        total: r.total, oldest: r.oldest, eligible: r.eligible, latestCutoff: r.latest_cutoff,
        minKeepDays: MIN_KEEP_DAYS, canPurge: !req.session.user.sigunguCode,
        archiveDir: req.session.user.sigunguCode ? null : archiveDir(), files: req.session.user.sigunguCode ? [] : await listArchiveFiles(),
    });
});

// before(YYYY-MM-DD) 이전(그날 제외)의 이력을 파일로 저장하고 DB에서 지운다.
router.post('/archive', async (req, res) => {
    if (req.session.user.sigunguCode) return res.status(403).json({ error: '관할이 제한된 관리자는 이력을 정리할 수 없습니다. 전체 권한 관리자에게 요청하세요.' });
    const before = String(req.body.before || '').trim();
    if (!DATE_RE.test(before)) return res.status(400).json({ error: '날짜를 YYYY-MM-DD 형식으로 입력하세요.' });
    const { rows: [lim] } = await pool.query(
        `SELECT ($1::date <= (now() AT TIME ZONE 'Asia/Seoul')::date - $2::int) AS ok, to_char((now() AT TIME ZONE 'Asia/Seoul')::date - $2::int, 'YYYY-MM-DD') AS latest`,
        [before, MIN_KEEP_DAYS]
    );
    if (!lim.ok) return res.status(400).json({ error: `이력은 최소 1년(${MIN_KEEP_DAYS}일) 보관해야 합니다. ${lim.latest} 이전 날짜만 정리할 수 있습니다.` });

    const cutoffSql = `created_at < (($1::date)::timestamp AT TIME ZONE 'Asia/Seoul')`;
    const { rows: [probe] } = await pool.query(
        `SELECT COUNT(*)::int AS n, MAX(id) AS max_id,
                to_char(MIN(created_at) AT TIME ZONE 'Asia/Seoul', 'YYYYMMDD') AS d1, to_char(MAX(created_at) AT TIME ZONE 'Asia/Seoul', 'YYYYMMDD') AS d2
         FROM audit_log WHERE ${cutoffSql}`, [before]
    );
    if (!probe.n) return res.status(400).json({ error: `${before} 이전의 이력이 없습니다.` });

    const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace(/\D/g, '').slice(0, 14);
    const fileName = `audit-log_${probe.d1}-${probe.d2}_${stamp}.csv`;
    const filePath = path.join(archiveDir(), fileName);
    let written = 0;
    try {
        await fs.promises.mkdir(archiveDir(), { recursive: true });
        const out = fs.createWriteStream(filePath, { flags: 'wx' });
        const done = new Promise((resolve, reject) => { out.on('error', reject); out.on('close', resolve); });
        const write = (chunk) => (out.write(chunk) ? Promise.resolve() : new Promise((r) => out.once('drain', r)));
        await write('﻿' + ['ID', '일시(KST)', '구분', '아이디', 'IP', '관할코드', '내용', '대상', '대상ID', '상세(JSON)'].map(csvCell).join(',') + '\r\n');
        let lastId = 0;
        for (;;) {
            const { rows } = await pool.query(
                `SELECT id, to_char(created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') AS at, action, username, ip, sigungu_code, summary, target_table, target_id, detail
                 FROM audit_log WHERE ${cutoffSql} AND id > $2 AND id <= $3 ORDER BY id LIMIT 5000`, [before, lastId, probe.max_id]
            );
            if (!rows.length) break;
            let chunk = '';
            for (const r of rows) {
                chunk += [r.id, r.at, ACTION_LABELS[r.action] || r.action, r.username, displayIp(r.ip), r.sigungu_code, r.summary, r.target_table, r.target_id,
                    r.detail ? JSON.stringify(r.detail) : ''].map(csvCell).join(',') + '\r\n';
            }
            await write(chunk);
            written += rows.length;
            lastId = rows[rows.length - 1].id;
        }
        out.end();
        await done;
        // 파일이 비어 있지 않고 저장한 건수가 지울 건수와 같은 것을 확인한 뒤에만 DB에서 지운다.
        const st = await fs.promises.stat(filePath);
        if (!st.size || written !== probe.n) throw new Error(`저장 검증 실패(예상 ${probe.n}건, 저장 ${written}건)`);
    } catch (e) {
        console.error('[audit-log/archive]', e);
        fs.rm(filePath, { force: true }, () => {});
        return res.status(500).json({ error: '이력을 파일로 저장하지 못해 아무것도 지우지 않았습니다: ' + e.message });
    }

    const del = await pool.query(`DELETE FROM audit_log WHERE ${cutoffSql} AND id <= $2`, [before, probe.max_id]);
    await logAction(null, {
        action: 'log_purge', targetTable: 'audit_log',
        summary: `이력 정리: ${before} 이전 ${del.rowCount.toLocaleString()}건을 파일(${fileName})로 보관하고 DB에서 삭제`,
        user: req.session.user, sigunguCode: req.session.user.sigunguCode, ip: clientIp(req),
    });
    res.json({ ok: true, deleted: del.rowCount, saved: written, fileName });
});

router.get('/archive-files/:name', async (req, res) => {
    if (req.session.user.sigunguCode) return res.status(403).json({ error: '관할이 제한된 관리자는 받을 수 없습니다.' });
    const name = req.params.name;
    if (!ARCHIVE_NAME_RE.test(name)) return res.status(400).json({ error: '잘못된 파일 이름입니다.' });
    const p = path.join(archiveDir(), name);
    if (!fs.existsSync(p)) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    await logAction(null, {
        action: 'log_export', targetTable: 'audit_log', summary: `보관된 이력 파일 다운로드: ${name}`,
        user: req.session.user, sigunguCode: req.session.user.sigunguCode, ip: clientIp(req),
    });
    res.download(p, name);
});

module.exports = router;
