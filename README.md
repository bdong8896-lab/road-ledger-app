# 도로대장 시스템 (Road Ledger System)

지도에서 도로망도(VWorld LT_L_MOCTLINK) 선분을 클릭해 노선/구간 단위로 도로대장 정보를
등록·수정하고, 관련 도면 파일을 업로드/조회하는 웹앱. Node.js/Express + PostgreSQL.

※ 2026-08-07: 필지(PNU) 단위 입력 구조를 국토부 표준(01.도로대장총괄)에 맞춘 노선/구간
  단위 구조로 전면 교체했다. 자세한 내용은 아래 "노선/구간 단위 구조(현재)" 참고.
  기존 필지 단위 테이블(road_ledger)과 API는 과거 데이터 보존을 위해 스키마에는 남아있지만
  화면에서는 더 이상 쓰이지 않는다.

## 최초 설치 (관공서별 신규 배포)

1. PostgreSQL DB 생성 후 스키마 적용
   ```
   psql -h <host> -U <user> -d <database> -f server/db/schema.sql
   ```
2. `server/.env.example`을 `server/.env`로 복사하고 값 채우기
   - `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD`: 해당 서버의 PostgreSQL 접속정보
   - `SESSION_SECRET`: 무작위 문자열로 교체
   - `VWORLD_API_KEY` / `VWORLD_REFERER`: 이 서버의 도메인·IP로 VWorld 개발자센터에
     발급받은 키와, 그 키에 등록한 Referer 값 (관공서마다 IP가 달라 키를 새로 발급해야 함)
   - `ITS_CCTV_API_KEY`: 국가교통정보센터(openapi.its.go.kr) CCTV API 키. 고속도로·국도
     CCTV만 제공하며(군도·시도 등 지자체 관리 도로는 미포함), 키가 비어있으면 CCTV
     레이어는 그냥 빈 상태로 남는다(에러 없음).
   - `UPLOAD_DIR`: 도면·조서 파일 저장 경로
   - `DWG_CONVERTER_PATH` (선택, 보통 비워둬도 됨): DWG 파일을 CAD 뷰어에서 보여줄 때
     쓰는 DXF 변환기 경로. `server/vendor/libredwg-win64/dwg2dxf.exe`(LibreDWG,
     GPL 오픈소스, 앱과 함께 배포됨)가 기본값이라 별도 설치 없이 바로 동작한다.
     다른 변환기(유료 ODA File Converter 등)로 바꾸고 싶을 때만 이 값을 채운다.
     비어있거나 파일이 없으면 DWG 업로드는 되지만 미리보기는 제공되지 않는다
     (원본 다운로드만 가능, 에러 없이 넘어감).

   로드뷰(카카오 Roadview)는 `public/kakao_sdk.js`(DS-LandInfo와 동일한 벤더 SDK, 레거시
   Daum 지도 API 경로라 앱키/도메인 등록이 필요 없음)를 그대로 사용하므로 별도 설정이
   필요 없다.
3. 의존성 설치 및 관리자 계정 생성
   ```
   cd server
   npm install
   npm run seed-admin -- <아이디> <비밀번호> <표시이름>
   ```
4. 서버 실행
   ```
   npm start
   ```
   기본 포트는 `.env`의 `PORT` (기본 8080). `http://<서버IP>:<PORT>` 로 접속.

## 구조

- `server/` — Express API 서버 (인증, 노선/구간 CRUD, 파일 업로드, VWorld/CCTV 프록시)
- `public/` — 정적 프론트엔드 (지도 + 도로대장 입력 폼 + 좌측 CAD 도면 뷰어)

## 노선/구간 단위 구조 (현재)

국토교통부 「도로대장공간정보」 표준의 "01.도로대장총괄" 개념을 반영해, **도로(노선/구간)가
필지가 아니라 그 자체로 독립된 레코드**다 (`road_sections` 테이블, PK는 표준 27자리
RDID). 예전 버전(필지 클릭 → 그 필지에 도로등급/노선명 등을 직접 입력)은 완전히
대체되었다.

**등록 흐름**
1. 지도에서 도로망도(LT_L_MOCTLINK, 국가표준노드링크) 선분을 클릭한다.
2. 그 선분의 도로명·도로등급·형상(geometry)이 VWorld 속성에서 자동으로 채워진 채로
   [정보] 탭에 신규 구간 등록 폼이 열린다.
3. 관리기관·노선번호·구간번호·시점/종점(번지 단위 주소)·연장·폭원 등을 입력하고 저장하면
   `POST /api/sections`가 호출되어 RDID가 자동 채번되고 `road_sections`에 저장된다.
4. 이후 [데이터보기] 트리에서 도로등급 → 노선 → 구간 순으로 나타나며, 구간을 클릭하면
   [정보] 탭에서 다시 조회/수정할 수 있다(`PUT /api/sections/:rdid`).

**RDID(27자리) 구성** — `작성지침.pdf` 제2장 3절 기준, `server/routes/sections.js`의
`generateRdid()`에서 자동 채번:
```
R01(레이어분류, 총괄=01) + 도로등급코드(4) + 관리기관코드(5) + 노선번호(4)
+ 구간번호(3) + 부여연도(4) + 일련번호(4)  = 27자리
```
도로등급 코드는 국토부 「공통입력코드정의서」 03.도로의종류 기준
(예: 1501=고속국도, 1502=일반국도, …, 1507=군도, 1599=기타) — `ROAD_RANK_CODES`에 정의.

**부속시설 개수 연동** — `GET /api/sections/facility-counts`가 선택한 구간의
(도로등급코드+노선번호+구간번호)로 `gov_*` 49개 테이블(국토부 표준 그대로,
`server/db/gov_facility_schema.sql`)을 조회해서 좌측 사이드바 부속시설 22종 그리드에
실제 개수를 채운다. 아직 `gov_*` 테이블에 실 데이터가 없으면 전부 0으로 표시된다.

**파일 첨부** — `route_files` 테이블이 `section_rdid` 컬럼으로 특정 구간에 정확히
연결된다(예전엔 도로등급+노선번호+노선명 조합만으로 느슨하게 묶여서, 같은 노선의
여러 구간이 파일을 공유하는 문제가 있었음).

**시군구 필터링과의 관계** — 구간은 필지(PNU)가 없어 시군구를 자동으로 알 수 없으므로,
등록한 계정의 `sigungu_code`를 그대로 태깅한다. 계정에 `sigungu_code`가 없으면(NULL)
전체 시군구를 다 보는 계정으로 동작한다.

**남은 한계** — `road_sections`는 일상적인 입력/조회에 필요한 핵심 필드만 담고 있고,
국토부 "01.도로대장총괄"의 통계성 필드 90여 개(유료도로 요금징수, 곡선반경 개소수 등)는
반영하지 않았다. 실제 KRRIS 제출이 필요해지면 그 시점에 별도 매핑 작업이 필요하다.

## 좌측 사이드바 (도면/CAD 뷰어)

데이터보기 트리에서 노선을 클릭하면 자동으로 펼쳐지며, 그 노선의 구간정보와
첨부 자료(도로/도면종류/구조물/공사도면/동영상 탭)를 보여준다. 자료는 필지(pnu)가
아니라 도로등급+노선번호+노선명 조합(`route_files` 테이블)에 붙는다.

DXF 파일은 `dxf-parser`(CDN, 순수 파싱)로 읽고 Canvas2D로 직접 렌더링한다 —
외부 클라우드나 유료 API 없이 완전히 브라우저 안에서 동작한다. 지원: LINE, LWPOLYLINE,
POLYLINE, CIRCLE, ARC, POINT, TEXT/MTEXT, SPLINE(직선 근사). 미지원(생략): INSERT(블록
삽입), HATCH, DIMENSION — 도면에 이런 요소가 많으면 일부만 보일 수 있다.

DWG(오토데스크 표준 포맷)는 파싱할 수 없다 — 열려면 DXF로 미리 변환해야 한다.
DWG를 그대로 지원하려면 서버에 ODA File Converter 같은 변환기를 두고 업로드 시
자동 변환하거나(무료, 별도 설치·라이선스 확인 필요), Autodesk APS(구 Forge) 클라우드
뷰어로 바꾸는 방법이 있다(더 많은 포맷 지원하지만 파일이 외부 클라우드에 업로드되고
API 키·인터넷 연결이 필요함 — 폐쇄망 관공서 환경엔 부적합할 수 있음).

## 국토교통부 「도로대장공간정보」 표준 정의서 반영 현황

`D:\DSMAP\25_11_25_스키마 및 정의서\` 에 있는 국토교통부 공식 정의서(테이블정의서
v2.3, 공통입력코드정의서 v2.6, 업무 매뉴얼/작성 지침 PDF 2종)를 검토하고 반영한 내용.
PDF 2종은 폰트에 유니코드 매핑이 없어 텍스트 추출이 안 됨(OCR 필요) — 텍스트/코드
정의는 두 엑셀 파일 기준으로 반영했다.

**반영함**
- 도로등급(ROAD_RANK) 코드 수정: 기존에 잘못 들어있던 면도·리도·농도·국지도를
  제거하고, 공식 9개 값(고속국도/일반국도/특별시도/광역시도/지방도/시도/군도/구도/
  기타)으로 맞춤 (`public/index.html`의 `#in-road_grade`, `public/script.js`의
  `ROAD_GRADES`).
- 관리기관(MCO) 공식 코드 368개 반영: `public/data/managing_agencies.json`
  (정의서의 "02.전체공통" 시트에서 추출)을 관리기관 입력창의 자동완성 목록으로 연결.
  자유 입력도 계속 가능(datalist 방식).
- 구간(SECT) 필드 추가: 총괄 테이블에는 있으나 기존 스키마엔 없던 필드
  (`road_ledger.sect`).

**참고만 하고 적용 안 함 (구조 변경이 커서)**
- "01.도로대장총괄" 테이블은 **필지(pnu) 단위가 아니라 노선(구간) 단위**(공간유형:
  선/LineString, PK=관리번호)이고 103개 필드를 가진다 — 저희 앱은 필지 단위 구조라
  전체 이관은 데이터 모델을 새로 설계해야 하는 큰 작업. 핵심 필드(노선명/노선번호/
  도로등급/구간/시종점/연장 등)만 기존 필지 단위 폼에 반영했고, 나머지(포장두께,
  곡선반경 개소, 교차시설 개소, 유료도로 상세 등 상세 통계성 필드)는 미반영.
- 시설물 상세 테이블 48종(교량/터널/육교/옹벽/신호등/배수시설 등, 정의서
  "02.교량"~"49.측점" 시트 각각)은 통째로 새 기능 영역(테이블+입력폼+수백 개
  코드값)이라 이번엔 적용하지 않았다. 왼쪽 CAD 패널의 "레이어(구조물 종류)"
  목록에 있는 명칭들이 이 48종 시설물 분류와 대략 대응된다 — 실제 개수 데이터가
  필요해지면 이 정의서를 기준으로 테이블을 새로 설계하면 된다.

## IP가 바뀌는 배포 환경 대응

- 프론트엔드는 VWorld에 직접 접속하지 않고 항상 `/api/vworld`를 거친다. 실제 VWorld
  요청의 Referer는 서버가 `.env`의 `VWORLD_REFERER`로 고정해서 보내므로, 접속하는
  브라우저의 실제 주소(IP)가 바뀌어도 영향받지 않는다.
- 서버 자체의 IP/도메인은 어디에도 하드코딩되어 있지 않다 (모든 API 호출이 상대경로
  `/api/...`). 서버를 다른 IP로 옮기면 `.env`만 재설정하면 된다.

## 운영 서버 배포 (192.168.0.211, Windows Server + IIS)

DS-LandInfo(기존 Electron 앱)와 같은 서버(192.168.0.211)에, 다른 IIS 사이트(8080 포트
사용 중)와 나란히 새 사이트로 배포한다. 구조: **IIS(8081, 리버스프록시) → Node(3000,
PM2로 상시 구동) → PostgreSQL(5432, 로컬만 접속 허용)**.

### 1. PostgreSQL

이미 서버에 5432 포트로 PostgreSQL이 설치되어 있고 `DSMap` 계정/데이터베이스가
생성되어 있다는 전제. 스키마만 적용하면 된다.
```
psql -h localhost -p 5432 -U DSMap -d DSMap -f server/db/schema.sql
```
PostgreSQL이 외부(다른 IP)에서 직접 접속 가능하지 않도록 `postgresql.conf`의
`listen_addresses`와 `pg_hba.conf`를 로컬(127.0.0.1)만 허용하도록 확인 — 웹앱은
같은 서버에서 localhost로만 접속하므로 외부 노출이 불필요하다.

### 2. 앱 파일 배포

`server/`, `public/` 전체를 서버로 복사(SFTP 등). `server/.env.production`에 이미
운영 값(DB 접속정보, VWorld/CCTV 키, 새로 발급한 SESSION_SECRET)이 채워져 있으니,
서버에 올린 뒤 파일명을 `.env`로 바꾼다. 그 다음:
```
cd server
npm install --omit=dev
node db/seed-admin.js <아이디> <비밀번호> <표시이름>   # 운영 관리자 계정 생성
```

### 3. Node를 PM2로 Windows 서비스 등록

```
npm install -g pm2 pm2-windows-startup
pm2-startup install
cd server
pm2 start ecosystem.config.js
pm2 save
```
`ecosystem.config.js`가 `PORT=3000`(즉 `.env`의 값)으로 `index.js`를 구동하고,
크래시 시 자동 재시작한다. `pm2-startup install`로 등록해두면 서버 재부팅 후에도
`pm2 save`로 저장된 프로세스가 자동 복구된다.

### 4. IIS에 새 사이트(8081) 추가 + 리버스프록시

1. **URL Rewrite**, **Application Request Routing(ARR)** IIS 확장모듈 설치(미설치 시).
2. IIS 관리자 → 서버 최상위 노드 → "Application Request Routing Cache" →
   우측 "Server Proxy Settings..." → **Enable proxy** 체크.
3. 새 웹사이트 추가: 포트 `8081`, 물리 경로는 빈 폴더(정적 파일을 여기 두지 않음 —
   Express가 직접 서빙하므로 IIS는 프록시 역할만 함).
4. 그 물리 경로에 [`deploy/web.config`](deploy/web.config) 복사 — 모든 요청을
   `http://localhost:3000`으로 리라이트하는 규칙이 들어있다.
5. 방화벽 인바운드 규칙: **8081만 허용**. 3000(Node)과 5432(Postgres)는 외부에
   노출하지 않는다(로컬 전용).
6. 접속 확인: `http://192.168.0.211:8081`

### 5. VWorld 키 관련 주의

`.env.production`의 `VWORLD_API_KEY`/`VWORLD_REFERER`는 `8081` 전용으로 새로 발급받은
개발키(서비스 URL `https://192.168.0.211:8081`, 발급 2026-08-28, 만료 2027-02-28)를
쓴다 — 기존 DS-LandInfo 키(FF96060E-...) 재사용은 그만두었다. 개발키는 만료가 있으므로
만료 전에 VWorld 개발자센터에서 운영키로 전환 신청해야 하고(연장신청 최대 3회), 서버의
접속 주소(도메인 연결, 포트 변경 등)가 바뀌면 이 키의 서비스 URL도 같이 재등록해야
지도가 계속 뜬다.

### 6. SFTP 배포 설정 — 확인 필요

기존 DS-LandInfo의 `.vscode/sftp.json`은 `remotePath: "/var/www/html"`(리눅스 경로),
포트 `11800`으로 되어 있다. 이번에 말씀하신 "IIS로 구축된 윈도우 서버"라는 설명과는
경로 형식이 안 맞는다(윈도우라면 보통 `C:\inetpub\wwwroot\...` 같은 경로). 아래 중
어느 쪽인지 확인해주시면 `road-ledger-app`용 `.vscode/sftp.json`을 새로 만들겠다.

- 같은 SFTP 서버(포트 11800, 계정 `Dsuser`)를 그대로 쓰되 **remotePath만** 새 IIS
  사이트의 물리 경로로 바꾸면 되는지
- 아니면 완전히 다른 SFTP 접속 정보(포트/계정/경로)를 새로 써야 하는지
