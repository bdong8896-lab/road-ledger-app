const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireAuth, requireAdmin, requireAdminReauth } = require('../middleware/requireAuth');
const config = require('../config');
const { regionNameEn } = require('../lib/regionNameEn');
const SIGUNGU_CODES = require('../lib/sigunguCodes.json');
const SIGUNGU_EXTENTS = require('../lib/sigunguExtents.json');
const { logAction, clientIp } = require('../lib/auditLog');

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

// ---- 로그인 실패 잠금 ----
// 같은 아이디로 연속 MAX_LOGIN_FAILS번 틀리면 LOCK_MINUTES분 동안 그 아이디의 로그인을
// 막는다(무차별 대입 방지). 실제로 있는 아이디인지와 무관하게 입력된 아이디 문자열
// 기준으로 세므로 "잠겼다/안 잠겼다"로 아이디 존재 여부를 알아낼 수도 없다.
// 메모리에만 두므로 서버를 재시작하면 초기화된다(영구 차단이 필요하면 DB로 옮길 것).
// 트레이드오프: 남이 일부러 관리자 아이디를 계속 틀려 잠글 수도 있지만 LOCK_MINUTES
// 뒤에 풀리고 login_fail 이력에 IP가 남는다 — 무한 잠금보다 안전하다고 판단.
const MAX_LOGIN_FAILS = 5;
const LOCK_MINUTES = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000; // 마지막 실패 후 이 시간이 지나면 횟수 초기화
const MAX_TRACKED_USERNAMES = 5000;    // 존재하지 않는 아이디를 무한히 보내 메모리를 채우는 것 방지
const loginFailures = new Map();       // key(소문자 아이디) -> { count, lockedUntil, lastAt }
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

function failureKey(username) {
    return String(username).trim().toLowerCase().slice(0, 50);
}
function lockRemainingMinutes(key) {
    const rec = loginFailures.get(key);
    if (!rec || !rec.lockedUntil) return 0;
    const remainMs = rec.lockedUntil - Date.now();
    if (remainMs <= 0) { loginFailures.delete(key); return 0; }
    return Math.ceil(remainMs / 60000);
}
// 실패를 기록하고, 이번 실패로 잠겼으면 true.
function recordLoginFailure(key) {
    const now = Date.now();
    let rec = loginFailures.get(key);
    if (!rec || now - rec.lastAt > FAIL_WINDOW_MS) rec = { count: 0, lockedUntil: 0, lastAt: now };
    rec.count += 1;
    rec.lastAt = now;
    let justLocked = false;
    if (rec.count >= MAX_LOGIN_FAILS) {
        rec.lockedUntil = now + LOCK_MINUTES * 60 * 1000;
        rec.count = 0;
        justLocked = true;
    }
    if (!loginFailures.has(key) && loginFailures.size >= MAX_TRACKED_USERNAMES) {
        loginFailures.delete(loginFailures.keys().next().value); // 가장 오래된 항목부터 버림
    }
    loginFailures.set(key, rec);
    return justLocked;
}

router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });
    }
    const ip = clientIp(req);
    const attempted = { id: null, username };
    const key = failureKey(username);

    // 로그인 전 공개 엔드포인트라 DB 오류 등이 프로세스 밖으로 새면 안 된다.
    try {
        const remain = lockRemainingMinutes(key);
        if (remain > 0) {
            await logAction(null, {
                action: 'login_fail', targetTable: 'accounts', summary: `로그인 거부(잠금 중, ${remain}분 남음): ${username}`,
                user: attempted, ip,
            });
            return res.status(429).json({ error: `로그인 시도가 너무 많아 잠겼습니다. ${remain}분 후 다시 시도하세요.` });
        }

        const { rows } = await pool.query('SELECT * FROM accounts WHERE username = $1', [username]);
        const account = rows[0];
        // 없는 아이디도 bcrypt 비교를 한 번 돌려서 응답 시간 차이로 아이디 존재 여부를
        // 짐작하지 못하게 한다.
        const ok = await bcrypt.compare(password, account ? account.password_hash : DUMMY_HASH);
        if (!account || !ok) {
            const locked = recordLoginFailure(key);
            await logAction(null, {
                action: 'login_fail', targetTable: 'accounts',
                summary: `로그인 실패: ${username}${locked ? ` — ${MAX_LOGIN_FAILS}회 연속 실패로 ${LOCK_MINUTES}분 잠금` : ''}`,
                user: account ? { id: account.id, username: account.username } : attempted,
                sigunguCode: account ? account.sigungu_code : null, ip,
            });
            if (locked) {
                return res.status(429).json({ error: `로그인에 ${MAX_LOGIN_FAILS}회 연속 실패해 ${LOCK_MINUTES}분 동안 잠겼습니다.` });
            }
            return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
        }
        // 비밀번호까지 맞은 경우에만 승인 대기 상태를 알려준다(아이디 존재 여부를
        // 비밀번호 없이 확인하는 통로가 되지 않게).
        if (account.status === 'pending') {
            await logAction(null, {
                action: 'login_fail', targetTable: 'accounts', targetId: String(account.id),
                summary: `로그인 거부(승인 대기 계정): ${account.username}`,
                user: { id: account.id, username: account.username }, sigunguCode: account.sigungu_code, ip,
            });
            return res.status(403).json({ error: '관리자 승인 대기 중인 계정입니다. 승인 후 로그인할 수 있습니다.' });
        }

        loginFailures.delete(key);
        // 로그인 직전에 세션 ID를 새로 발급한다(세션 고정 공격 방지) — 로그인 전에 심어둔
        // 세션 ID를 그대로 쓰면 공격자가 알고 있는 ID로 피해자가 로그인하게 만들 수 있다.
        await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
        req.session.user = {
            id: account.id, username: account.username, displayName: account.display_name, role: account.role,
            sigunguCode: account.sigungu_code, sigunguName: account.sigungu_name,
            sigunguExtent: findSigunguExtent(account.sigungu_code),
            // 관리자가 재설정해준 임시 비밀번호로 들어온 경우 — 새 비밀번호로 바꾸기 전까지
            // 다른 API가 막힌다(middleware/requireAuth.js).
            mustChangePassword: !!account.must_change_password,
        };
        await logAction(null, {
            action: 'login', targetTable: 'accounts', targetId: String(account.id),
            summary: `로그인: ${account.username}`,
            user: { id: account.id, username: account.username }, sigunguCode: account.sigungu_code, ip,
        });
        res.json({ user: req.session.user });
    } catch (err) {
        console.error('[auth/login]', err);
        res.status(500).json({ error: '로그인 처리 중 오류가 발생했습니다.' });
    }
});

router.post('/logout', async (req, res) => {
    const user = req.session && req.session.user;
    if (user) {
        await logAction(null, {
            action: 'logout', targetTable: 'accounts', targetId: String(user.id),
            summary: `로그아웃: ${user.username}`, user, sigunguCode: user.sigunguCode, ip: clientIp(req),
        });
    }
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

// 그 계정의 로그인 세션을 전부 끊는다(계정 삭제·비밀번호 변경/재설정 때) — 안 하면 이미 로그인된
// 브라우저는 세션이 만료될 때까지(최대 sessionMaxAgeHours) 계속 쓸 수 있다. 세션은
// connect-pg-simple이 session 테이블에 저장하므로 거기서 그 계정 것을 지우면 된다.
// exceptSid: 본인이 비밀번호를 바꿀 때 지금 쓰는 세션만 남기기 위함.
async function destroyUserSessions(userId, exceptSid) {
    try {
        await pool.query(
            `DELETE FROM session WHERE (sess->'user'->>'id') = $1 AND ($2::text IS NULL OR sid <> $2)`,
            [String(userId), exceptSid || null]
        );
    } catch (e) {
        console.error('[auth/destroyUserSessions]', e.message);
    }
}

// 관리자가 다른 계정을 다룰 수 있는지 — 전체 권한 관리자는 모두, 관할이 제한된 관리자는 같은 시군구 계정만
// (관할이 없는 "전체 권한" 계정은 제한된 관리자가 건드릴 수 없다).
function canManageAccount(actor, target) {
    return !actor.sigunguCode || actor.sigunguCode === target.sigungu_code;
}

function validateNewPassword(password, username) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > 100) {
        return `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상으로 입력하세요.`;
    }
    // 공공기관 비밀번호 작성 기준(행정안전부 권고)에 맞춰 문자 조합을 요구한다 — 영문 대문자·소문자·숫자·특수문자 중
    // 3종류 이상이면 8자부터, 2종류면 10자부터 인정.
    const kinds = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
    if (kinds < 2 || (kinds === 2 && password.length < 10)) {
        return PASSWORD_RULE_TEXT;
    }
    if (password.toLowerCase() === String(username || '').toLowerCase()) return '비밀번호는 아이디와 달라야 합니다.';
    if (username && String(username).length >= 4 && password.toLowerCase().includes(String(username).toLowerCase())) return '비밀번호에 아이디를 포함할 수 없습니다.';
    if (/(.)\1{3,}/.test(password)) return '같은 문자를 4번 이상 연속해서 쓸 수 없습니다.';
    return null;
}

// 본인 비밀번호 변경 — 로그인 상태의 누구나. 관리자 재설정으로 임시 비밀번호를 받은
// 계정도 이걸로 바꾼다(requireAuth는 그 계정을 막으므로 여기선 세션만 직접 확인).
// 현재 비밀번호 확인이 틀리면 로그인 실패와 같은 카운터로 센다 — 세션을 탈취한 사람이
// 현재 비밀번호를 무차별 대입하는 걸 막기 위함.
router.post('/change-password', async (req, res) => {
    const user = req.session && req.session.user;
    if (!user) return res.status(401).json({ error: '로그인이 필요합니다.' });
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
        return res.status(400).json({ error: '현재 비밀번호와 새 비밀번호를 입력하세요.' });
    }
    const key = failureKey(user.username);
    const remain = lockRemainingMinutes(key);
    if (remain > 0) {
        return res.status(429).json({ error: `시도가 너무 많아 잠겼습니다. ${remain}분 후 다시 시도하세요.` });
    }
    const pwError = validateNewPassword(newPassword, user.username);
    if (pwError) return res.status(400).json({ error: pwError });
    if (newPassword === currentPassword) {
        return res.status(400).json({ error: '새 비밀번호는 현재 비밀번호와 달라야 합니다.' });
    }
    try {
        const { rows } = await pool.query('SELECT password_hash FROM accounts WHERE id = $1', [user.id]);
        if (!rows.length) {
            return req.session.destroy(() => res.status(401).json({ error: '계정을 찾을 수 없습니다. 다시 로그인하세요.' }));
        }
        if (!(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
            const locked = recordLoginFailure(key);
            await logAction(null, {
                action: 'login_fail', targetTable: 'accounts', targetId: String(user.id),
                summary: `비밀번호 변경 실패(현재 비밀번호 불일치): ${user.username}${locked ? ` — ${LOCK_MINUTES}분 잠금` : ''}`,
                user, sigunguCode: user.sigunguCode, ip: clientIp(req),
            });
            return res.status(400).json({ error: '현재 비밀번호가 올바르지 않습니다.' });
        }
        await pool.query(
            'UPDATE accounts SET password_hash = $1, must_change_password = false WHERE id = $2',
            [await bcrypt.hash(newPassword, 10), user.id]
        );
        await destroyUserSessions(user.id, req.sessionID);
        req.session.user.mustChangePassword = false;
        await logAction(null, {
            action: 'password_change', targetTable: 'accounts', targetId: String(user.id),
            summary: `비밀번호 변경: ${user.username}`, user, sigunguCode: user.sigunguCode, ip: clientIp(req),
        });
        res.json({ ok: true });
    } catch (err) {
        console.error('[auth/change-password]', err);
        res.status(500).json({ error: '비밀번호 변경 중 오류가 발생했습니다.' });
    }
});

// 관리 콘솔 진입 전 재인증 — 로그인한 관리자가 비밀번호를 한 번 더 입력한다. 성공하면
// config.adminReauthMinutes(기본 15분) 동안 관리 API(requireAdminReauth)를 쓸 수 있다.
// 틀리면 로그인 실패와 같은 카운터로 세서 잠근다(세션을 가로챈 사람의 무차별 대입 방지).
router.post('/reauth', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const { password } = req.body || {};
    if (typeof password !== 'string' || !password) {
        return res.status(400).json({ error: '비밀번호를 입력하세요.' });
    }
    const key = failureKey(user.username);
    const remain = lockRemainingMinutes(key);
    if (remain > 0) {
        return res.status(429).json({ error: `시도가 너무 많아 잠겼습니다. ${remain}분 후 다시 시도하세요.` });
    }
    try {
        const { rows } = await pool.query('SELECT password_hash FROM accounts WHERE id = $1', [user.id]);
        if (!rows.length) {
            return req.session.destroy(() => res.status(401).json({ error: '계정을 찾을 수 없습니다. 다시 로그인하세요.' }));
        }
        if (!(await bcrypt.compare(password, rows[0].password_hash))) {
            const locked = recordLoginFailure(key);
            await logAction(null, {
                action: 'login_fail', targetTable: 'accounts', targetId: String(user.id),
                summary: `관리자 재인증 실패: ${user.username}${locked ? ` — ${LOCK_MINUTES}분 잠금` : ''}`,
                user, sigunguCode: user.sigunguCode, ip: clientIp(req),
            });
            return res.status(400).json({ error: '비밀번호가 올바르지 않습니다.' });
        }
        loginFailures.delete(key);
        req.session.adminReauthAt = Date.now();
        await logAction(null, {
            action: 'admin_reauth', targetTable: 'accounts', targetId: String(user.id),
            summary: `관리 콘솔 재인증: ${user.username}`, user, sigunguCode: user.sigunguCode, ip: clientIp(req),
        });
        res.json({ ok: true, validMinutes: config.adminReauthMinutes });
    } catch (err) {
        console.error('[auth/reauth]', err);
        res.status(500).json({ error: '재인증 처리 중 오류가 발생했습니다.' });
    }
});

// 재인증이 아직 유효한지(관리 콘솔을 열 때 재인증 창을 띄울지 결정). 유효시간은 늘리지 않는다.
router.get('/reauth-status', requireAdmin, (req, res) => {
    const at = req.session.adminReauthAt;
    const remainingMs = at ? config.adminReauthMinutes * 60 * 1000 - (Date.now() - at) : 0;
    res.json({ valid: remainingMs > 0, remainingSeconds: Math.max(0, Math.floor(remainingMs / 1000)) });
});

// 지도 하단 저작권 문구 — 로그인한 계정의 관할 지자체 영문명으로 만든다
// (예: "copyright © 2026 HWASEONG CITY. All Rights Reserved."). 관할이 없는(전체) 계정은
// .env의 SITE_COPYRIGHT(배포처 기본 문구)를 쓰고, 그것도 없으면 빈 값(화면에 표시 안 함).
router.get('/site-info', (req, res) => {
    const user = req.session && req.session.user;
    if (!user) return res.json({ copyright: '' });
    const nameEn = user.sigunguCode ? regionNameEn(user.sigunguCode) : null;
    const year = new Date(Date.now() + 9 * 3600 * 1000).getUTCFullYear(); // 한국시간 기준 연도
    res.json({ copyright: nameEn ? `copyright © ${year} ${nameEn}. All Rights Reserved.` : config.siteCopyright });
});

// 관리자 전용: 다른 계정의 비밀번호 재설정(분실 대응). 관리자가 임시 비밀번호를 정해
// 알려주면 그 계정은 그걸로 로그인한 뒤 새 비밀번호로 바꿔야만 쓸 수 있다
// (must_change_password). 기존 로그인 세션은 모두 끊고, 로그인 잠금도 풀어준다.
router.post('/accounts/:id/reset-password', requireAdminReauth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '잘못된 계정 ID입니다.' });
    if (id === req.session.user.id) {
        return res.status(400).json({ error: '본인 비밀번호는 "비밀번호 변경"으로 바꾸세요.' });
    }
    const { newPassword } = req.body || {};
    try {
        const { rows } = await pool.query('SELECT username, sigungu_code FROM accounts WHERE id = $1', [id]);
        if (!rows.length) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
        if (!canManageAccount(req.session.user, rows[0])) return res.status(403).json({ error: '관할 시군구 밖의 계정입니다.' });
        const pwError = validateNewPassword(newPassword, rows[0].username);
        if (pwError) return res.status(400).json({ error: pwError });
        await pool.query(
            'UPDATE accounts SET password_hash = $1, must_change_password = true WHERE id = $2',
            [await bcrypt.hash(newPassword, 10), id]
        );
        await destroyUserSessions(id);
        loginFailures.delete(failureKey(rows[0].username));
        await logAction(null, {
            action: 'password_reset', targetTable: 'accounts', targetId: String(id),
            summary: `비밀번호 재설정: ${rows[0].username} (다음 로그인 시 변경 필수)`,
            sigunguCode: rows[0].sigungu_code, user: req.session.user, ip: clientIp(req),
        });
        res.json({ ok: true });
    } catch (err) {
        console.error('[auth/reset-password]', err);
        res.status(500).json({ error: '비밀번호 재설정 중 오류가 발생했습니다.' });
    }
});

// 관리자 전용: 계정 목록("계정관리" 탭 — 직접 만든 계정과 회원가입 신청 계정을
// 한 목록에서 같이 관리, 승인대기가 맨 위). password_hash는 응답에 절대 포함하지 않는다.
router.get('/accounts', requireAdminReauth, async (req, res) => {
    const userSigungu = req.session.user.sigunguCode;
    const { rows } = await pool.query(
        `SELECT id, username, display_name, role, status, sigungu_code, sigungu_name, created_at
         FROM accounts ${userSigungu ? 'WHERE sigungu_code = $1' : ''} ORDER BY (status = 'pending') DESC, created_at`,
        userSigungu ? [userSigungu] : []
    );
    res.json({ accounts: rows });
});

// 관리자 전용: 회원가입 신청(pending) 계정 승인
router.post('/accounts/:id/approve', requireAdminReauth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '잘못된 계정 ID입니다.' });
    const actorSigungu = req.session.user.sigunguCode;
    const { rows } = await pool.query(
        `UPDATE accounts SET status = 'active' WHERE id = $1 AND status = 'pending' AND ($2::text IS NULL OR sigungu_code = $2)
         RETURNING id, username, sigungu_code`, [id, actorSigungu || null]
    );
    if (!rows.length) return res.status(404).json({ error: '승인 대기 중인 계정을 찾을 수 없습니다.' });
    await logAction(null, {
        action: 'approve', targetTable: 'accounts', targetId: String(id),
        summary: `가입 승인: ${rows[0].username}`, sigunguCode: rows[0].sigungu_code,
        user: req.session.user, ip: clientIp(req),
    });
    res.json({ ok: true });
});

// ---- 계정 생성 공통 규칙 ----
// 관리자가 계정관리에서 만드는 계정(POST /accounts)과 로그인 화면 회원가입(POST
// /signup)은 같은 accounts 테이블에 같은 규칙으로 들어간다 — 둘의 차이는
// status(관리자 생성=active, 가입 신청=pending), role(신청은 항상 user),
// 관할 시군구 필수 여부(신청은 필수, 관리자는 비우면 전체 관할)뿐이다.
const USERNAME_RE = /^[A-Za-z0-9_.-]{4,30}$/;
const MIN_PASSWORD_LENGTH = 8;
const PASSWORD_RULE_TEXT = '비밀번호는 영문 대문자·소문자·숫자·특수문자 중 3종류 이상을 섞어 8자 이상(2종류면 10자 이상)으로 입력하세요.';
const MAX_PENDING_SIGNUPS = 100; // 승인 대기가 너무 쌓이면 더 안 받음(공개 엔드포인트 스팸 방지)

// 성공: { account }, 실패: { code(HTTP 상태), error }. 검증·시군구 확인·INSERT·
// 중복/DB 오류 처리를 전부 여기서 하므로 호출하는 라우트는 결과만 응답하면 된다
// (공개 엔드포인트(signup)에서 예외가 프로세스 밖으로 새지 않게 하는 효과도 있음).
async function insertAccount({ username, password, displayName, role, status, sigunguCode, requireSigungu, requireDisplayName, privacyConsent }) {
    const uname = String(username || '').trim();
    if (!USERNAME_RE.test(uname)) {
        return { code: 400, error: '아이디는 영문/숫자/_.- 4~30자로 입력하세요.' };
    }
    const pwError = validateNewPassword(password, uname); // 비밀번호 변경/재설정과 같은 규칙
    if (pwError) return { code: 400, error: pwError };
    const name = String(displayName || '').trim();
    if (requireDisplayName && !name) {
        return { code: 400, error: '이름(소속/성명)을 입력하세요.' };
    }
    if (name.length > 50) {
        return { code: 400, error: '이름은 50자 이내로 입력하세요.' };
    }
    // 시군구는 클라이언트가 보낸 이름을 믿지 않고 서버 코드표(sigunguCodes.json)로
    // 코드를 확인한 뒤 이름도 그 표에서 가져온다.
    let sigungu = null;
    if (sigunguCode) {
        sigungu = SIGUNGU_CODES.find((it) => it.code5 === String(sigunguCode));
        if (!sigungu) return { code: 400, error: '소속 시군구를 목록에서 선택하세요.' };
    } else if (requireSigungu) {
        return { code: 400, error: '소속 시군구를 목록에서 선택하세요.' };
    }
    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const { rows } = await pool.query(
            `INSERT INTO accounts (username, password_hash, display_name, role, status, sigungu_code, sigungu_name, privacy_consent_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::boolean THEN now() END)
             RETURNING id, username, display_name, role, status, sigungu_code, sigungu_name, created_at`,
            [uname, passwordHash, name || uname, role, status, sigungu ? sigungu.code5 : null, sigungu ? sigungu.sgg : null, !!privacyConsent]
        );
        return { account: rows[0] };
    } catch (err) {
        if (err.code === '23505') return { code: 409, error: '이미 사용 중인 아이디입니다.' };
        console.error('[auth/insertAccount]', err);
        return { code: 500, error: '계정 생성 중 오류가 발생했습니다.' };
    }
}

// 로그인 화면의 회원가입(신청) — 로그인 전이라 인증 없이 열려 있다. 그래서
// 항상 일반(user) 권한 + 승인 대기(pending)로만 만들고(관리자 승인 전엔 로그인
// 불가), 관할 시군구를 필수로 받는다(관할 없는 계정은 전체 데이터를 볼 수 있어
// 신청 단계에선 허용하지 않음).
router.post('/signup', async (req, res) => {
    const { username, password, displayName, sigunguCode, privacyConsent } = req.body || {};
    // 개인정보 수집·이용 동의는 화면 체크만 믿지 않고 서버에서도 요구하고 동의 시각을 남긴다.
    if (privacyConsent !== true) {
        return res.status(400).json({ error: '개인정보 수집·이용에 동의해야 가입 신청을 할 수 있습니다.' });
    }
    try {
        const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM accounts WHERE status = 'pending'`);
        if (rows[0].n >= MAX_PENDING_SIGNUPS) {
            return res.status(503).json({ error: '현재 가입 신청을 받을 수 없습니다. 관리자에게 문의하세요.' });
        }
    } catch (err) {
        console.error('[auth/signup]', err);
        return res.status(500).json({ error: '가입 신청 중 오류가 발생했습니다.' });
    }
    const result = await insertAccount({
        username, password, displayName, sigunguCode, privacyConsent: true,
        role: 'user', status: 'pending', requireSigungu: true, requireDisplayName: true,
    });
    if (result.error) return res.status(result.code).json({ error: result.error });
    const acc = result.account;
    await logAction(null, {
        action: 'signup', targetTable: 'accounts', targetId: String(acc.id),
        summary: `가입 신청: ${acc.username} (${acc.sigungu_name})`, sigunguCode: acc.sigungu_code,
        user: { id: acc.id, username: acc.username }, ip: clientIp(req),
    });
    res.status(201).json({ ok: true });
});

// 시군구명으로 법정동코드 검색 — 계정관리 "새 계정 추가" 폼과 로그인 화면
// 회원가입 폼이 같이 쓴다(로그인 전에도 불러야 해서 인증 없이 열어둠 — 행정구역
// 이름/코드뿐이라 비밀이 아니다). "중구"처럼 여러 시도에 같은 이름이 있을 수
// 있어(서울/부산/대구/인천/대전/울산 중구 등 6곳) 이름만으로 하나로 정하지 않고
// 후보 목록을 돌려준다 — 코드값은 행정안전부 공개 법정동코드 전체자료(2018년
// gist, 이후 전남·광주가 "전남광주통합특별시"로 통합되면서 바뀐 코드는 사용자가
// 직접 제공한 원본 파일로 덮어써서 최신화함) 기준.
router.get('/sigungu-search', (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ items: [] });
    const items = SIGUNGU_CODES
        .filter((item) => item.full.includes(q) || item.sgg.includes(q))
        .slice(0, 20);
    res.json({ items });
});

// 관리자 전용: 계정 생성 — 바로 사용 가능(active). 관할을 비우면 전체 관할.
router.post('/accounts', requireAdminReauth, async (req, res) => {
    const { username, password, displayName, role } = req.body || {};
    // 관할이 제한된 관리자는 자기 시군구의 계정만 만들 수 있다 — 관할을 비우거나(전체 권한) 다른 시군구로 지정해
    // 자기보다 넓은 권한의 계정(권한 상승)을 만드는 길을 막는다.
    const actorSigungu = req.session.user.sigunguCode;
    let sigunguCode = (req.body || {}).sigunguCode;
    if (actorSigungu) {
        if (sigunguCode && String(sigunguCode) !== actorSigungu) {
            return res.status(403).json({ error: '관할 시군구 밖의 계정은 만들 수 없습니다.' });
        }
        sigunguCode = actorSigungu;
    }
    const result = await insertAccount({
        username, password, displayName, sigunguCode,
        role: role === 'admin' ? 'admin' : 'user', status: 'active',
        requireSigungu: false, requireDisplayName: false,
    });
    if (result.error) return res.status(result.code).json({ error: result.error });
    const acc = result.account;
    await logAction(null, {
        action: 'account_create', targetTable: 'accounts', targetId: String(acc.id),
        summary: `계정 생성: ${acc.username} (${acc.role === 'admin' ? '관리자' : '일반'}, 관할 ${acc.sigungu_name || '전체'})`,
        sigunguCode: acc.sigungu_code, user: req.session.user, ip: clientIp(req),
    });
    res.status(201).json({ account: acc });
});

// 관리자 전용: 계정 삭제. 본인 계정은 못 지운다 — 실수로 관리자 계정을
// 전부 지워서 아무도 로그인 못 하게 되는 상황을 막기 위함.
router.delete('/accounts/:id', requireAdminReauth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '잘못된 계정 ID입니다.' });
    if (id === req.session.user.id) {
        return res.status(400).json({ error: '로그인 중인 본인 계정은 삭제할 수 없습니다.' });
    }
    try {
        const { rows: target } = await pool.query('SELECT sigungu_code FROM accounts WHERE id = $1', [id]);
        if (!target.length) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
        if (!canManageAccount(req.session.user, target[0])) return res.status(403).json({ error: '관할 시군구 밖의 계정입니다.' });
        const { rows } = await pool.query(
            'DELETE FROM accounts WHERE id = $1 RETURNING username, status, sigungu_code', [id]
        );
        if (!rows.length) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
        await destroyUserSessions(id); // 지운 계정이 이미 로그인해 있었다면 그 세션도 즉시 끊는다
        await logAction(null, {
            action: 'account_delete', targetTable: 'accounts', targetId: String(id),
            summary: `${rows[0].status === 'pending' ? '가입 신청 거절(삭제)' : '계정 삭제'}: ${rows[0].username}`,
            sigunguCode: rows[0].sigungu_code, user: req.session.user, ip: clientIp(req),
        });
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
