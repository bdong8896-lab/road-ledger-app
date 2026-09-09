function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: '로그인이 필요합니다.' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: '로그인이 필요합니다.' });
    }
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    }
    next();
}

module.exports = { requireAuth, requireAdmin };
