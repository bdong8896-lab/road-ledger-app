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

module.exports = { requireAuth, requireAdmin };
