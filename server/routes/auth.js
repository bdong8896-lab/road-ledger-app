const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();

router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });
    }

    const { rows } = await pool.query('SELECT * FROM accounts WHERE username = $1', [username]);
    const account = rows[0];
    if (!account) {
        return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    const ok = await bcrypt.compare(password, account.password_hash);
    if (!ok) {
        return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    req.session.user = {
        id: account.id, username: account.username, displayName: account.display_name, role: account.role,
        sigunguCode: account.sigungu_code, sigunguName: account.sigungu_name,
    };
    res.json({ user: req.session.user });
});

router.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ ok: true });
    });
});

router.get('/me', (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: '로그인이 필요합니다.' });
    }
    res.json({ user: req.session.user });
});

// 관리자 전용: 계정 생성
router.post('/accounts', requireAdmin, async (req, res) => {
    const { username, password, displayName, role, sigunguCode, sigunguName } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    try {
        const { rows } = await pool.query(
            `INSERT INTO accounts (username, password_hash, display_name, role, sigungu_code, sigungu_name)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, username, display_name, role, sigungu_code, sigungu_name, created_at`,
            [username, passwordHash, displayName || username, role === 'admin' ? 'admin' : 'user', sigunguCode || null, sigunguName || null]
        );
        res.status(201).json({ account: rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ error: '이미 존재하는 아이디입니다.' });
        }
        throw err;
    }
});

module.exports = { router, requireAuth, requireAdmin };
