// 변경 이력(감사 로그) 조회 — 관리자 전용. sections.js(구간 등록/수정/삭제)와
// bulkImport.js(일괄등록) confirm()에서 auditLog.js의 logAction()으로 기록해둔
// 것을 목록으로 보여준다.
const express = require('express');
const pool = require('../db');
const { requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size, 10) || 30));
    const action = (req.query.action || '').trim();

    const userSigungu = req.session.user.sigunguCode;
    const conditions = [];
    const params = [];
    if (userSigungu) {
        params.push(userSigungu);
        conditions.push(`(sigungu_code = $${params.length} OR sigungu_code IS NULL)`);
    }
    if (action) {
        params.push(action);
        conditions.push(`action = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM audit_log ${where}`, params);
    const total = parseInt(countRows[0].count, 10);

    params.push(size, (page - 1) * size);
    const { rows } = await pool.query(
        `SELECT id, action, target_table, target_id, summary, detail, sigungu_code, username, created_at
         FROM audit_log ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    res.json({ total, totalPages: Math.max(1, Math.ceil(total / size)), items: rows });
});

module.exports = router;
