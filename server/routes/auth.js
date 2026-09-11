const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/requireAuth');
const SIGUNGU_CODES = require('../lib/sigunguCodes.json');
const SIGUNGU_EXTENTS = require('../lib/sigunguExtents.json');

// 로그인 계정의 관할 시군구 코드로 지도 기본 확대범위(EPSG:3857)를 찾는다 —
// 예전엔 프론트엔드(script.js)에 시군구 3~4개만 하드코딩해뒀었는데, 새
// 계정을 만들 때마다 코드를 고쳐야 했다(사용자 지적으로 확인). VWorld
// 행정경계를 전국 격자로 미리 훑어 만든 lib/sigunguExtents.json(build 스크립트
// 결과물, 269개 코드 — 수원/성남/화성처럼 자치구로 쪼개진 대도시는 그 구들의
// 범위를 합쳐서 저장해둠)에서 바로 찾으므로 새 계정에도 자동으로 적용된다.
function findSigunguExtent(sigunguCode) {
    if (!sigunguCode) return null;
    const hit = SIGUNGU_EXTENTS[sigunguCode];
    return hit ? hit.extent : null;
}

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
        sigunguExtent: findSigunguExtent(account.sigungu_code),
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

// 관리자 전용: 계정 목록(회원가입 화면 대신 관리자가 직접 계정을 만드는
// "계정관리" 탭에서 씀). password_hash는 응답에 절대 포함하지 않는다.
router.get('/accounts', requireAdmin, async (req, res) => {
    const { rows } = await pool.query(
        `SELECT id, username, display_name, role, sigungu_code, sigungu_name, created_at
         FROM accounts ORDER BY created_at`
    );
    res.json({ accounts: rows });
});

// 관리자 전용: 시군구명으로 법정동코드 검색(계정관리 "새 계정 추가" 폼에서
// 시군구코드를 직접 입력하지 않고 이름만 치면 자동으로 찾게 하기 위함).
// "중구"처럼 여러 시도에 같은 이름이 있을 수 있어(서울/부산/대구/인천/대전/
// 울산 중구 등 6곳) 이름만으로 하나로 정하지 않고 후보 목록을 돌려준다 —
// 코드값은 행정안전부 공개 법정동코드 전체자료(2018년 gist, 이후 전남·광주가
// "전남광주통합특별시"로 통합되면서 바뀐 코드는 사용자가 직접 제공한 원본
// 파일로 덮어써서 최신화함) 기준.
router.get('/sigungu-search', requireAdmin, (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ items: [] });
    const items = SIGUNGU_CODES
        .filter((item) => item.full.includes(q) || item.sgg.includes(q))
        .slice(0, 20);
    res.json({ items });
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

// 관리자 전용: 계정 삭제. 본인 계정은 못 지운다 — 실수로 관리자 계정을
// 전부 지워서 아무도 로그인 못 하게 되는 상황을 막기 위함.
router.delete('/accounts/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '잘못된 계정 ID입니다.' });
    if (id === req.session.user.id) {
        return res.status(400).json({ error: '로그인 중인 본인 계정은 삭제할 수 없습니다.' });
    }
    try {
        const { rowCount } = await pool.query('DELETE FROM accounts WHERE id = $1', [id]);
        if (!rowCount) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
        res.json({ ok: true });
    } catch (err) {
        // 이 계정이 등록/수정/업로드한 기록이 남아있으면(created_by 등 FK) 삭제가
        // 막힌다 — 이력 데이터를 조용히 고아로 만들지 않기 위한 DB 차원의 안전장치.
        if (err.code === '23503') {
            return res.status(409).json({ error: '이 계정으로 등록/수정된 자료가 있어 삭제할 수 없습니다.' });
        }
        throw err;
    }
});

module.exports = { router, requireAuth, requireAdmin };
