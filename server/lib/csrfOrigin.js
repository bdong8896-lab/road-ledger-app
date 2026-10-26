// CSRF 방어 — 데이터를 바꾸는 요청(POST/PUT/PATCH/DELETE)의 출처(Origin, 없으면 Referer)가 이 서비스의 주소인지 확인한다.
// 세션 쿠키가 SameSite=Lax라 다른 사이트에서 보내는 POST엔 쿠키가 실리지 않지만, 브라우저/설정에 따라 빠지는 경우를 대비한 이중 장치다.
//
// 허용하는 출처: 요청의 Host(= 사용자가 접속한 주소), X-Forwarded-Host, 그리고 .env의 ALLOWED_ORIGINS(쉼표 구분 주소).
// IIS(ARR) 뒤에서 Host가 localhost로 바뀌어 전달되는 배포라면 "진짜 접속 주소"를 알 수 없으므로, ALLOWED_ORIGINS가 비어 있을 땐
// 막지 않고 경고만 남긴다(로그인이 통째로 막히는 사고를 피하기 위해). ALLOWED_ORIGINS를 적으면 그때부터 엄격하게 막는다.
const config = require('../config');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function hostOf(value) {
    try { return new URL(value).host.toLowerCase(); } catch (e) { return null; }
}

const allowedHosts = new Set((config.allowedOrigins || []).map((v) => (/^https?:\/\//i.test(v) ? hostOf(v) : v.toLowerCase())).filter(Boolean));
let warned = false;

function csrfOriginCheck(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    const source = origin || req.get('referer');
    if (!source) return next(); // 브라우저가 아닌 클라이언트(스크립트 등) — 세션 쿠키를 훔쳐 쓰는 CSRF와는 무관
    const srcHost = origin === 'null' ? null : hostOf(source);

    const host = (req.get('host') || '').toLowerCase();
    const forwarded = String(req.get('x-forwarded-host') || '').split(',')[0].trim().toLowerCase();
    if (srcHost && (srcHost === host || (forwarded && srcHost === forwarded) || allowedHosts.has(srcHost))) return next();

    // 접속 주소를 알 수 없는 배포(Host가 loopback이고 ALLOWED_ORIGINS 미설정)는 경고만 하고 통과시킨다.
    if (!allowedHosts.size && LOOPBACK_RE.test(host) && !forwarded) {
        if (!warned) {
            warned = true;
            console.warn(`[csrf] 요청 출처(${srcHost || source})와 서버가 보는 주소(${host})가 달라 출처 검사를 건너뜁니다. 엄격하게 검사하려면 .env에 ALLOWED_ORIGINS=https://접속주소 를 설정하세요.`);
        }
        return next();
    }
    console.warn(`[csrf] 차단: ${req.method} ${req.originalUrl.split('?')[0]} 출처=${srcHost || source} Host=${host}${forwarded ? ' Forwarded=' + forwarded : ''}`);
    return res.status(403).json({ error: '허용되지 않은 출처의 요청입니다. 서비스 주소로 직접 접속해 다시 시도하세요(관리자: .env의 ALLOWED_ORIGINS에 접속 주소를 추가).' });
}

module.exports = { csrfOriginCheck };
