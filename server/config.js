require('dotenv').config();
const path = require('path');

function required(name, fallback) {
    const v = process.env[name];
    if (v !== undefined && v !== '') return v;
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
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
    sessionSecret: required('SESSION_SECRET', 'dev-only-secret-change-me'),
    // 로그인 세션 유지시간(시간 단위). 세션은 메모리가 아니라 DB(connect-pg-simple,
    // session 테이블)에 저장되므로 서버를 재시작해도 이 시간이 지나기 전까지는
    // 로그인이 풀리지 않는다. 기본 8시간 — 개발 PC에서 매번 다시 로그인하기
    // 귀찮으면 .env에 SESSION_MAX_AGE_HOURS=720(30일) 같은 값을 넣어 늘릴 수
    // 있다. 운영 서버는 이 값을 굳이 안 늘리는 게 안전하다(로그인 상태로
    // 방치된 PC가 오래 남는 것 자체가 위험 요소이므로).
    sessionMaxAgeHours: Number(required('SESSION_MAX_AGE_HOURS', '8')),
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
