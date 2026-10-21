// 변경 이력·접속 이력(감사 로그) 조회 — 관리자 전용. sections.js(구간 등록/수정/삭제),
// bulkImport.js(일괄등록), auth.js(로그인/로그아웃/가입/승인/계정 생성·삭제)에서
// lib/auditLog.js의 logAction()으로 기록해둔 것을 목록으로 보여주고, 같은 조건으로
// CSV(텍스트) 파일로 내려받을 수 있다(감사·보고 제출용).
const express = require('express');
const pool = require('../db');
const { requireAdmin } = require('../middleware/requireAuth');
const { logAction, clientIp } = require('../lib/auditLog');

const router = express.Router();
router.use(requireAdmin);

const ACTION_LABELS = {
    create: '등록', update: '수정', delete: '삭제', bulk_import: '일괄등록',
    login: '로그인', login_fail: '로그인 실패', logout: '로그아웃',
    signup: '가입 신청', approve: '가입 승인', account_create: '계정 생성', account_delete: '계정 삭제',
    password_change: '비밀번호 변경', password_reset: '비밀번호 재설정',
    log_export: '이력 다운로드',
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
    res.json({ total, totalPages: Math.max(1, Math.ceil(total / size)), items: rows });
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
                r.at, ACTION_LABELS[r.action] || r.action, r.username, r.ip, r.sigungu_code,
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

module.exports = router;
