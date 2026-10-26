require('dotenv').config();
const path = require('path');

function required(name, fallback) {
    const v = process.env[name];
    if (v !== undefined && v !== '') return v;
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
}

// 세션 서명 키 — 개발 PC에선 기본값으로 떨어져도 되지만 운영(NODE_ENV=production)에서
// 키가 없거나 기본값/템플릿 플레이스홀더("<...>") 그대로면 기동을 거부한다. 공개된 기본
// 키로 돌면 누구나 세션 쿠키를 위조할 수 있다.
const DEV_SESSION_SECRET = 'dev-only-secret-change-me';
function sessionSecret() {
    const v = process.env.SESSION_SECRET;
    if (process.env.NODE_ENV === 'production') {
        if (!v || v === DEV_SESSION_SECRET || v.startsWith('<') || v.length < 16) {
            throw new Error('운영 환경에서는 SESSION_SECRET을 16자 이상의 무작위 값으로 .env에 설정해야 합니다(기본값/플레이스홀더 불가).');
        }
        return v;
    }
    return v || DEV_SESSION_SECRET;
}

module.exports = {
    port: Number(required('PORT', '8080')),
    db: {
        host: required('PGHOST', 'localhost'),
        port: Number(required('PGPORT', '5432')),
        database: required('PGDATABASE', 'road_ledger'),
        user: required('PGUSER', 'road_ledger_app'),
        password: required('PGPASSWORD', ''),
    },
    sessionSecret: sessionSecret(),
    // IIS 등 앞단에서 HTTPS로만 서비스하는 운영 환경이면 .env에 COOKIE_SECURE=true — 로그인
    // 쿠키에 Secure 속성을 붙이고 HSTS 헤더를 보낸다. HTTP로 서비스 중인데 켜면 쿠키가
    // 안 먹어 로그인이 안 되므로 HTTPS 적용을 마친 뒤에만 켤 것(deploy/서버배포_가이드.txt 14번).
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    // 데이터를 바꾸는 요청의 출처 검사(CSRF)에서 허용할 접속 주소(쉼표 구분). 예: ALLOWED_ORIGINS=https://roadledger.example.go.kr
    // 비워 두면 요청의 Host와 같은 출처만 통과(IIS가 Host를 localhost로 바꿔 전달하면 검사를 건너뜀 — lib/csrfOrigin.js).
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean),
    // 로그인 세션 유지시간(시간 단위). 세션은 메모리가 아니라 DB(connect-pg-simple,
    // session 테이블)에 저장되므로 서버를 재시작해도 이 시간이 지나기 전까지는
    // 로그인이 풀리지 않는다. 기본 8시간 — 개발 PC에서 매번 다시 로그인하기
    // 귀찮으면 .env에 SESSION_MAX_AGE_HOURS=720(30일) 같은 값을 넣어 늘릴 수
    // 있다. 운영 서버는 이 값을 굳이 안 늘리는 게 안전하다(로그인 상태로
    // 방치된 PC가 오래 남는 것 자체가 위험 요소이므로).
    sessionMaxAgeHours: Number(required('SESSION_MAX_AGE_HOURS', '8')),
    // 관리 콘솔(계정·이력·일괄등록)에 들어갈 때 받는 비밀번호 재인증의 유효시간(분).
    // 관리 작업을 할 때마다 다시 늘어나므로, 이 시간 동안 관리 작업이 없을 때만 다시 묻는다.
    adminReauthMinutes: Number(process.env.ADMIN_REAUTH_MINUTES || 15),
    // 지도 하단 저작권 문구는 로그인한 계정의 관할 지자체 영문명으로 자동 생성된다
    // (routes/auth.js /site-info). 이 값은 관할이 없는(전체) 계정에만 쓰는 배포처 기본 문구.
    // 예: SITE_COPYRIGHT=copyright © 2026 HWASEONG CITY. All Rights Reserved.  (비우면 표시 안 함)
    siteCopyright: process.env.SITE_COPYRIGHT || '',
    // 백업이 쌓이는 폴더 — 관리 콘솔 현황판이 "마지막 백업이 언제인지"를 보여주는 데 쓴다(읽기만 한다).
    // 운영: deploy/backup-prod.ps1의 -BackupRoot와 같은 값(예: E:\Backup\road-ledger). 개발 PC 기본값은 프로젝트의 backups 폴더.
    backupRoot: process.env.BACKUP_ROOT || path.join(__dirname, '..', 'backups'),
    // 1년이 지나 DB에서 정리한 변경·접속 이력을 CSV로 보관하는 폴더(관리 콘솔 > 변경·접속 이력 > 보관·정리). 기본은 백업 폴더 아래 audit-archive.
    auditArchiveDir: process.env.AUDIT_ARCHIVE_DIR || path.join(process.env.BACKUP_ROOT || path.join(__dirname, '..', 'backups'), 'audit-archive'),
    vworld: {
        apiKey: process.env.VWORLD_API_KEY || '',
        referer: process.env.VWORLD_REFERER || 'http://localhost/',
    },
    itsCctvApiKey: process.env.ITS_CCTV_API_KEY || '',
    // 정적 파일을 서빙할 폴더명(public/ 아래가 아니라 프로젝트 루트 기준) —
    // 평소엔 'public'(원본), 배포용 난독화 버전을 쓰려면 .env에
    // SERVE_DIR=public-dist(server/build-dist.js가 만든 결과물)로 설정.
    // 원복은 이 값을 다시 'public'으로 바꾸고 서버만 재시작하면 끝(파일 변경 불필요).
    serveDir: process.env.SERVE_DIR || 'public',
    uploadDir: path.resolve(__dirname, process.env.UPLOAD_DIR || './uploads'),
    // DWG→DXF 변환기 경로. 기본값은 함께 배포되는 LibreDWG(dwg2dxf, GPL 오픈소스)
    // 바이너리다. 나중에 다른 변환기(ODA 등)로 바꾸려면 DWG_CONVERTER_PATH만
    // 재설정하면 된다 — server/lib/dwgConvert.js 외 다른 코드는 손댈 필요 없음.
    // 비어있거나 파일이 없으면 변환을 그냥 건너뛴다(dwg 업로드 자체는 항상 성공).
    dwgConverterPath: process.env.DWG_CONVERTER_PATH
        || path.resolve(__dirname, 'vendor/libredwg-win64/dwg2dxf.exe'),
};
