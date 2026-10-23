const config = require('../config');

// 관리자가 비밀번호를 재설정해준 계정(session.user.mustChangePassword)은 새 비밀번호로
// 바꾸기 전까지 requireAuth/requireAdmin이 걸린 모든 API를 못 쓴다. 본인 확인(/me)·
// 비밀번호 변경·로그아웃은 auth.js가 이 미들웨어 없이 세션만 직접 확인하므로 계속 된다.
function passwordChangeRequired(res) {
    return res.status(403).json({ error: '비밀번호를 먼저 변경해야 합니다.', code: 'PASSWORD_CHANGE_REQUIRED' });
}

function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: '로그인이 필요합니다.' });
    }
    if (req.session.user.mustChangePassword) return passwordChangeRequired(res);
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: '로그인이 필요합니다.' });
    }
    if (req.session.user.mustChangePassword) return passwordChangeRequired(res);
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    }
    next();
}

// 관리 콘솔 API(계정관리·접속/변경 이력·일괄등록) — 관리자 권한에 더해, 최근에 비밀번호로
// 재인증했어야 한다(POST /api/auth/reauth). 로그인된 채 자리를 비운 PC에서 다른 사람이
// 계정 삭제·비밀번호 재설정 같은 중요 기능을 바로 쓰지 못하게 하기 위함(보안감사 "중요 기능
// 수행 시 재인증"). 유효시간은 관리 작업을 할 때마다 다시 늘어난다(마지막 관리 작업 기준).
function requireAdminReauth(req, res, next) {
    requireAdmin(req, res, () => {
        const at = req.session.adminReauthAt;
        if (!at || Date.now() - at > config.adminReauthMinutes * 60 * 1000) {
            return res.status(403).json({ error: '관리 기능을 쓰려면 비밀번호를 다시 입력하세요.', code: 'REAUTH_REQUIRED' });
        }
        req.session.adminReauthAt = Date.now();
        next();
    });
}

module.exports = { requireAuth, requireAdmin, requireAdminReauth };
