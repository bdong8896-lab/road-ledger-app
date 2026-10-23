// 가장 먼저 — 이후 모든 console 출력이 날짜별 로그 파일(server/logs/app-*.log)에도 남는다.
require('./lib/serverLog').install();
// async 라우트 오류가 프로세스를 죽이지 않고 전역 에러 핸들러(500)로 가게 한다.
require('./lib/asyncErrors').install();

const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const config = require('./config');
const pool = require('./db');
const { requireAuth } = require('./middleware/requireAuth');
const authRoutes = require('./routes/auth').router;
const vworldProxyRoutes = require('./routes/vworldProxy');
const parcelsRoutes = require('./routes/parcels');
const filesRoutes = require('./routes/files');
const cctvRoutes = require('./routes/cctv');
const routeFilesRoutes = require('./routes/routeFiles');
const adminSectionsRoutes = require('./routes/adminSections');
const sectionsRoutes = require('./routes/sections');
const roadIssuesRoutes = require('./routes/roadIssues');
const bulkImportRoutes = require('./routes/bulkImport');
const auditLogRoutes = require('./routes/auditLog');

const app = express();

// IIS(ARR 리버스프록시)가 같은 서버(127.0.0.1)에서 붙으므로 loopback만 신뢰한다 —
// 그러면 req.ip가 프록시 주소(127.0.0.1)가 아니라 X-Forwarded-For의 실제 접속자 IP가
// 된다(접속 이력의 IP 기록용). 단, IIS ARR "Server Proxy Settings"에서 "Preserve
// client IP in the following HTTP header: X-Forwarded-For"를 켜야 헤더가 실린다
// (deploy/서버배포_가이드.txt 참고). 안 켜면 IP가 전부 127.0.0.1로 남을 뿐 동작은 정상.
app.set('trust proxy', 'loopback');
app.disable('x-powered-by'); // 서버 종류(Express) 노출 제거

// 보안 헤더. CSP는 스크립트/스타일 출처까지 제한하면 지도·CDN 라이브러리·인라인
// onclick이 많은 이 화면이 깨질 수 있어, 깨질 일이 없는 항목(다른 사이트가 이 화면을
// iframe으로 감싸기 금지, 플러그인 금지, base 태그 고정)만 건다.
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
});
// HTTPS를 IIS가 끝내고 Node엔 평문 HTTP로 넘기므로, 운영에서 COOKIE_SECURE=true면 "이 서비스는
// HTTPS로만 접속된다"고 보고 express가 요청을 https로 인식하게 한다(안 그러면 Secure 쿠키를
// 안 내려줘서 로그인이 안 됨). Node는 localhost에서만 접근 가능하다는 전제(방화벽 3000 비공개).
if (config.cookieSecure) {
    app.use((req, res, next) => { req.headers['x-forwarded-proto'] = 'https'; next(); });
}

app.use(express.json());
app.use(
    session({
        store: new pgSession({ pool, tableName: 'session' }),
        secret: config.sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: config.sessionMaxAgeHours * 60 * 60 * 1000,
            httpOnly: true,
            // 다른 사이트에서 이 서버로 날리는 요청에 쿠키가 안 실리게(CSRF 완화). 외부 링크로
            // 들어오는 일반 이동은 lax라 그대로 로그인 상태가 유지된다.
            sameSite: 'lax',
            secure: config.cookieSecure,
        },
    })
);

// 운영 로그용 요청 기록 — 모든 요청을 찍으면 지도 타일 프록시 때문에 로그가 너무
// 커지므로 API 중 실패(4xx/5xx)와 느린 요청(5초 이상)만 남긴다. 쿼리스트링(필지번호
// 목록 등)은 길고 불필요해서 경로만, 비밀번호가 담긴 body는 애초에 안 찍는다.
const SLOW_REQUEST_MS = 5000;
app.use('/api', (req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - started;
        // 401은 제외 — 로그인 전 /api/auth/me 확인 등으로 정상 흐름에서도 매번 나고,
        // 로그인 실패는 접속 이력(audit_log의 login_fail)에 따로 남는다.
        if ((res.statusCode >= 400 && res.statusCode !== 401) || ms >= SLOW_REQUEST_MS) {
            const who = req.session && req.session.user ? req.session.user.username : '-';
            console[res.statusCode >= 500 ? 'error' : 'warn'](
                `[http] ${req.method} ${req.baseUrl}${req.path} ${res.statusCode} ${ms}ms user=${who} ip=${(req.ip || '').replace(/^::ffff:/, '')}`
            );
        }
    });
    next();
});

app.use('/api/auth', authRoutes);
app.use('/api/vworld', requireAuth, vworldProxyRoutes);
app.use('/api/cctv', requireAuth, cctvRoutes);
app.use('/api/parcels', parcelsRoutes);
app.use('/api/parcels', filesRoutes);
app.use('/api/routes/files', routeFilesRoutes);
app.use('/api/sections', sectionsRoutes);
app.use('/api/admin/sections', adminSectionsRoutes);
app.use('/api/road-issues', roadIssuesRoutes);
app.use('/api/bulk-import', bulkImportRoutes);
app.use('/api/audit-log', auditLogRoutes);

const staticDir = path.join(__dirname, '..', config.serveDir);
app.use(express.static(staticDir));

// 전역 에러 핸들러 — 각 라우트의 자체 try/catch를 빠져나간 예외(주로 throw err로
// 위임된 것들)까지 여기서 잡아서, DB 에러 메시지(테이블/제약조건명 등)나 스택
// 트레이스가 응답에 그대로 실리지 않게 막는 마지막 안전장치. 실제 원인은
// 서버 로그(pm2 logs)에만 남긴다.
app.use((err, req, res, next) => {
    console.error(`[unhandled] ${req.method} ${req.originalUrl}`, err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

app.listen(config.port, () => {
    console.log(`도로대장 시스템 서버 실행 중: http://localhost:${config.port} (정적 파일: ${config.serveDir}/)`);
});
