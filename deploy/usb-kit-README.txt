========================================================
 서버용 USB 설치 키트 — 도로대장 시스템 (폐쇄망 / USB 반입, 모든 시군구 공용)
========================================================
접속 주소: http://<서버 IP>:<IIS 사이트 포트>   (아래 예시는 포트 11800. HTTP 로 우선 운영, HTTPS 는 나중에 — 가이드 43번)
이 키트에는 특정 시군구의 키·비밀번호·주소가 들어 있지 않다. 설치하는 서버의 값은 [3]에서 직접 채운다.
서버 폴더: D:\Dsmap_ROAD     자세한 설명·문제 해결은 deploy\서버배포_가이드.txt (키트의 Dsmap_ROAD\deploy 에도 있음)

키트 구성
  Dsmap_ROAD\        서버의 D:\Dsmap_ROAD 로 통째로 복사한다(server, public-dist, web.config, deploy)
  tools\nssm\nssm.exe        Node 를 Windows 서비스로 등록하는 도구(방법 B)
  tools\pm2-offline.zip      PM2 오프라인 설치본(방법 A)
  preflight-server.ps1       서버 사전 점검(읽기 전용)
  MANIFEST.sha256.txt        주요 파일의 SHA256 (복사가 깨지지 않았는지 확인용)
직접 준비한 것(키트에 없음): Node.js, IIS 확장(URL Rewrite, ARR)

※ 설정 파일은 비밀 값 없는 템플릿(Dsmap_ROAD\server\.env.template)이다. 브이월드 키·DB 비밀번호는 서버에서 채우므로 USB 분실 시 노출되는 비밀이 없다.
   (키트를 -EnvFile 로 만들었다면 Dsmap_ROAD\server\.env.production 에 키가 이미 들어 있다 — 그 경우 [3]에서 복사 대신 이름만 .env 로 바꾸고, 설치 뒤 USB 에서 지운다.)
⚠ 서버에서 PowerShell 은 "관리자 권한"으로 연다. 명령이 안 먹으면 서버배포_가이드.txt 11번(PowerShell 문제 모음) 참고.

--------------------------------------------------------
[0] 사전 점검 (설치 전에 먼저)
--------------------------------------------------------
  powershell -NoProfile -ExecutionPolicy Bypass -File preflight-server.ps1
  → Node 설치/IIS 모듈/PostgreSQL 포트/포트 충돌/방화벽을 확인하고 preflight-<서버이름>.txt 를 만든다. NO·CHECK 표시를 먼저 해결한다.

--------------------------------------------------------
[1] 파일 복사
--------------------------------------------------------
  USB 의 Dsmap_ROAD 폴더 안 내용 전부를 D:\Dsmap_ROAD 로 복사한다.
  (복사가 끝나면 서버에서 MANIFEST.sha256.txt 의 해시와 대조: Get-FileHash <파일> -Algorithm SHA256)

--------------------------------------------------------
[2] DB 계정·데이터베이스 (이미 설치된 PostgreSQL 에 앱 전용 계정을 새로 만든다 — 가이드 0번 "PostgreSQL 포트·계정 확인")
--------------------------------------------------------
  포트는 사전 점검이 알려 준다(기본 5432 가 아닐 수 있음). 계정·DB 이름은 DSMap 으로 통일해 둔 상태다.
  기존 비밀번호를 모르면 가이드 0번의 pg_hba.conf 임시 변경 절차를 따른다(그 PostgreSQL 을 쓰는 다른 시스템이 있으면 운영 영향 적은 시간에).
    CREATE USER "DSMap" WITH PASSWORD '<정한 비밀번호>';
    CREATE DATABASE "DSMap" OWNER "DSMap";

--------------------------------------------------------
[3] 설정 파일 .env
--------------------------------------------------------
  Copy-Item "D:\Dsmap_ROAD\server\.env.template" "D:\Dsmap_ROAD\server\.env"
  메모장으로 D:\Dsmap_ROAD\server\.env 를 열어 < > 로 표시된 값을 채운다(템플릿 안의 설명 참고):
    PGPORT           위에서 확인한 실제 포트
    PGPASSWORD       [2]에서 정한 비밀번호
    SESSION_SECRET   이 서버용으로 새로 만든 무작위 문자열(만드는 명령이 템플릿에 적혀 있다)
    VWORLD_API_KEY   이 서버 접속 주소로 새로 발급받은 브이월드 키
    VWORLD_REFERER   http://<서버 IP>:<IIS 사이트 포트>/  ← VWorld 개발자센터의 "서비스 URL" 과 글자 그대로 같아야 한다
    ITS_CCTV_API_KEY CCTV 를 쓸 때만(없으면 비워 둔다)
  확인: SERVE_DIR=public-dist , COOKIE_SECURE 줄은 없어야 한다(HTTP 에서 켜면 로그인 불가).
  < > 가 남아 있으면 서버가 시작을 거부한다.

--------------------------------------------------------
[4] 스키마 적용 (한글 깨짐 방지로 인코딩 먼저 — $ 기호 확인)
--------------------------------------------------------
  $env:PGCLIENTENCODING = "UTF8"
  & "C:\Program Files\PostgreSQL\<버전>\bin\psql.exe" -h localhost -p <포트> -U DSMap -d DSMap -f D:\Dsmap_ROAD\server\db\schema.sql
  & "C:\Program Files\PostgreSQL\<버전>\bin\psql.exe" -h localhost -p <포트> -U DSMap -d DSMap -f D:\Dsmap_ROAD\server\db\gov_facility_schema.sql
  (둘 다 IF NOT EXISTS 라 중간에 실패해도 원인을 고친 뒤 그대로 다시 실행하면 된다. gov_facility_schema 는 데이터가 없어 금방 끝난다.)

--------------------------------------------------------
[5] 관리자 계정
--------------------------------------------------------
  cd D:\Dsmap_ROAD\server
  node db\seed-admin.js <아이디> <비밀번호> <표시이름>
  (node 가 PATH 에 없으면 Node 설치 폴더의 node.exe 전체 경로로 실행. 비밀번호 규칙: 가이드 §14 [C])
  ※ node_modules 는 키트에 이미 들어 있어 npm install 이 필요 없다.

--------------------------------------------------------
[6] 앱을 상시 구동 — 둘 중 하나(방법 A, 안 되면 B)
--------------------------------------------------------
  먼저 직접 한 번 띄워 보며 오류가 없는지 확인한다(안 뜨면 로그에 원인이 나온다):
    cd D:\Dsmap_ROAD\server ; $env:NODE_ENV="production" ; node index.js
    → "서버 실행 중 …" 류 메시지 확인 후 Ctrl+C

  [방법 A] PM2
    Expand-Archive -Path "<USB>\tools\pm2-offline.zip" -DestinationPath "$env:APPDATA\npm" -Force
    새 PowerShell 창에서:  pm2 -v
    cd D:\Dsmap_ROAD\server
    pm2 start ecosystem.config.js
    pm2 save
    pm2-startup install            (재부팅 시 자동 시작 — [10] 재부팅 시험으로 꼭 확인)
    ※ pm2 start/restart 로 바꿀 때마다 pm2 save 도 함께(안 하면 재부팅 뒤 사라짐)

  [방법 B] NSSM (Windows 서비스 — 로그인 없이도 부팅 때 자동 시작)
    New-Item -ItemType Directory -Path D:\Dsmap_ROAD\nssm -Force
    Copy-Item "<USB>\tools\nssm\nssm.exe" D:\Dsmap_ROAD\nssm\nssm.exe
    $n = "D:\Dsmap_ROAD\nssm\nssm.exe"
    $node = (Get-Command node).Source            # 안 나오면 node.exe 전체 경로를 직접 적는다
    & $n install road-ledger $node "D:\Dsmap_ROAD\server\index.js"
    & $n set road-ledger AppDirectory "D:\Dsmap_ROAD\server"
    & $n set road-ledger Start SERVICE_AUTO_START
    & $n set road-ledger AppEnvironmentExtra NODE_ENV=production       ← 빼먹지 말 것
    New-Item -ItemType Directory -Path D:\Dsmap_ROAD\server\logs -Force
    & $n set road-ledger AppStdout "D:\Dsmap_ROAD\server\logs\out.log"
    & $n set road-ledger AppStderr "D:\Dsmap_ROAD\server\logs\error.log"
    & $n set road-ledger AppRotateFiles 1
    & $n set road-ledger AppRotateBytes 10485760
    & $n start road-ledger
    Get-Service road-ledger ; Get-Content D:\Dsmap_ROAD\server\logs\out.log -Tail 20
  ⚠ A 와 B 를 동시에 켜면 포트 3000 충돌 — 하나만 쓴다. 전환하려면 앞의 것을 완전히 내린 뒤(pm2 delete / nssm remove) 다른 쪽을 켠다.

--------------------------------------------------------
[7] IIS 사이트 (IIS·URL Rewrite·ARR 는 설치돼 있어야 함 — 사전 점검에서 확인)
--------------------------------------------------------
  - ARR: IIS 관리자 → 서버 최상위 노드 → "Application Request Routing Cache" → 우측 "Server Proxy Settings" →
         Enable proxy 체크, Time-out 600(초), "Preserve client IP … X-Forwarded-For" 체크, Response buffer threshold 0 → Apply
  - 사이트 추가: 이름 RoadLedger / 포트 11800 / 물리 경로 D:\Dsmap_ROAD (web.config 가 이 폴더 최상위에 있다)
    ※ 8080 등 기존 사이트는 건드리지 않는다.
  - 인증: 익명 인증 = 사용, Windows 인증 = 사용 안 함(안 하면 401)
  - 권한: icacls "D:\Dsmap_ROAD" /grant "IIS_IUSRS:(OI)(CI)RX" /T
  - web.config 때문에 500.19 가 나면 가이드 4번(requestFiltering 잠금 해제) 참고

--------------------------------------------------------
[8] 방화벽
--------------------------------------------------------
  New-NetFirewallRule -DisplayName "RoadLedger-11800" -Direction Inbound -Protocol TCP -LocalPort 11800 -Action Allow
  (3000·PostgreSQL 포트는 외부에 열지 않는다. 보안팀 협의가 필요하면 먼저 요청)

--------------------------------------------------------
[9] 접속 테스트
--------------------------------------------------------
  서버 안에서 http://localhost:3000 (Node 직접) → 되면 IIS 쪽: http://localhost:11800 → 다른 PC 에서 http://<서버 IP>:11800
  로그인 → 지도 → 도로대장 목록. 지도가 안 뜨면 VWorld 키의 서비스 URL 이 접속 주소(VWORLD_REFERER 와 같은 값)로 등록됐는지부터 확인(가이드 4번).
  화면 라이브러리(CDN)가 막힌 PC 면 화면이 비어 보인다 — 사전 점검의 "접속 PC" 항목 참고.

--------------------------------------------------------
[10] 재부팅 시험 (꼭 한 번)
--------------------------------------------------------
  서버를 재부팅하고 "RDP 로그인 없이" 5분쯤 기다린 뒤, 다른 PC 에서 접속해 로그인 화면이 뜨는지 본다.
  502 가 나면 앱이 로그인 전에 안 올라온 것 → PM2 대신 NSSM(방법 B)으로 바꾼다.

--------------------------------------------------------
[11] 백업 작업 등록(운영 시작 전에)
--------------------------------------------------------
  가이드 15번: 다른 드라이브/공유로 백업 폴더를 정하고, 먼저 수동으로 한 번 돌려 backup.log 를 확인한 뒤 작업 스케줄러에 등록한다.
  powershell -NoProfile -ExecutionPolicy Bypass -File D:\Dsmap_ROAD\deploy\backup-prod.ps1 -AppDir D:\Dsmap_ROAD -BackupRoot <백업폴더> -PgBin "C:\Program Files\PostgreSQL\<버전>\bin"

--------------------------------------------------------
문제가 생기면
--------------------------------------------------------
  앱 로그: D:\Dsmap_ROAD\server\logs\ (app-날짜.log, out.log, error.log) / PM2: pm2 logs road-ledger --lines 50
  흔한 증상(401, 500.19, 로그인 안 됨, 한글 깨짐 등)은 deploy\서버배포_가이드.txt 4번.
