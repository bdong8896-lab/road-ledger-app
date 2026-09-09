-- 도로대장 시스템 DB 스키마
-- 적용: psql -h <host> -U <user> -d <database> -f schema.sql

CREATE TABLE IF NOT EXISTS accounts (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(50) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name  VARCHAR(100),
    role          VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    -- 관할 시군구(법정동코드 앞 5자리). PNU의 앞 5자리와 매칭해 데이터를 필터링한다.
    -- NULL이면 전체 시군구를 다 보는 계정(예: 여러 시군구를 통합 관리하는 최상위 관리자).
    sigungu_code  VARCHAR(5),
    sigungu_name  VARCHAR(50),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 도로(노선/구간) 단위 도로대장 — 국토부 표준의 "01.도로대장총괄" 개념을
-- 반영한 신규 기본 단위. 지도에서 도로망도(LT_L_MOCTLINK) 선분을 클릭해
-- 등록하며, RDID가 국토부 표준 27자리 규칙(레이어분류+도로등급코드+
-- 관리기관코드+노선번호+구간번호+부여연도+일련번호)으로 자동 채번된다.
-- 기존 필지(road_ledger) 단위 입력은 이 테이블로 대체되었다(road_ledger는
-- 과거 데이터 보존을 위해 테이블만 남겨두고 더 이상 사용하지 않는다).
-- ============================================================
CREATE TABLE IF NOT EXISTS road_sections (
    rdid             VARCHAR(27) PRIMARY KEY,
    road_rank_code   VARCHAR(4) NOT NULL,   -- 도로의종류 코드 (예: 1502=일반국도)
    road_rank_name   VARCHAR(30) NOT NULL,  -- 표시용 명칭 (예: 일반국도)
    route_no         VARCHAR(4),            -- 노선번호 (4자리 숫자, 표준)
    route_name       VARCHAR(100),
    sect             VARCHAR(3),            -- 구간번호 (3자리 숫자, 표준)
    mco_code         VARCHAR(5),            -- 관리기관 코드
    mco_name         VARCHAR(100),          -- 관리기관 명칭
    s_point          VARCHAR(100),          -- 시점 (번지 단위 주소)
    e_point          VARCHAR(100),          -- 종점 (번지 단위 주소)
    length_m         NUMERIC(13, 3),
    width_m          NUMERIC(6, 2),
    lane_count       SMALLINT,
    pavement_type    VARCHAR(20),
    pavement_material VARCHAR(30),
    has_sidewalk     BOOLEAN,
    has_drainage     BOOLEAN,
    completion_date  DATE,
    remarks          TEXT,
    geom             JSONB,                 -- 선택한 도로망도 선분의 GeoJSON 지오메트리
    link_ids         TEXT,                  -- 근거가 된 LT_L_MOCTLINK link_id (콤마 구분)
    sigungu_code     VARCHAR(5),            -- 관할 시군구 (등록한 계정의 sigungu_code)
    created_by       INTEGER REFERENCES accounts(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by       INTEGER REFERENCES accounts(id),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_road_sections_rank ON road_sections(road_rank_code);
CREATE INDEX IF NOT EXISTS idx_road_sections_sigungu ON road_sections(sigungu_code);

-- 등록된 구간을 500m 단위로 미리 끊어둔 SHP를 그대로 적재한 테이블 — 지도에서
-- 노선에 마우스오버했을 때 "구간 전체"가 아니라 "지금 가리키는 500m 구간"의
-- 부속시설 개수를 보여주기 위함(routes/sections.js의 /sectors,
-- /facility-counts-by-sector). gov_* 부속시설 테이블처럼 (road_rank, road_no,
-- sect) 업무키로 매칭한다. 아직 500m SHP를 받지 못한 노선은 이 테이블에
-- 행이 없고, 그 경우 지도는 예전처럼 구간 전체 합계로 자연히 되돌아간다.
CREATE TABLE IF NOT EXISTS road_sectors (
    id             SERIAL PRIMARY KEY,
    road_rank_code VARCHAR(4) NOT NULL,
    road_no        VARCHAR(4) NOT NULL,
    sect           VARCHAR(3) NOT NULL,
    sect_st        NUMERIC(13,3) NOT NULL,  -- 이 500m 조각의 시작 위치(km)
    sect_ed        NUMERIC(13,3) NOT NULL,
    sect_len       NUMERIC(13,3),
    geom           JSONB NOT NULL,          -- GeoJSON LineString(WGS84) — 지도 마우스오버 히트테스트용
    sigungu_code   VARCHAR(5)
);
CREATE INDEX IF NOT EXISTS idx_road_sectors_key ON road_sectors(road_rank_code, road_no, sect);
-- 일괄등록(500SHP)이 같은 500m 조각을 재확정할 때 upsert(ON CONFLICT)할 수 있도록.
CREATE UNIQUE INDEX IF NOT EXISTS uq_road_sectors_key ON road_sectors(road_rank_code, road_no, sect, sect_st);

-- RDID 채번용 일련번호 카운터. (road_rank_code, mco_code, route_no, sect, 연도)
-- 조합별로 별도 카운터를 둔다 — 국토부 표준의 "일련번호(4자리)"가 이 조합 내에서
-- 매겨지는 번호이기 때문이다.
CREATE TABLE IF NOT EXISTS road_sections_rdid_seq (
    seq_key   VARCHAR(24) PRIMARY KEY,  -- road_rank_code+mco_code+route_no+sect+year
    last_no   INTEGER NOT NULL DEFAULT 0
);

-- (참고용, 더 이상 신규 등록에 쓰지 않음 — 필지 단위 구조에서 노선/구간
--  단위 구조로 전환되었다. 과거 데이터 열람/백업 목적으로만 테이블을 보존한다.)
CREATE TABLE IF NOT EXISTS road_ledger (
    pnu                VARCHAR(19) PRIMARY KEY,
    jibun_addr         TEXT,
    road_addr          TEXT,
    route_no           VARCHAR(30),
    route_name         VARCHAR(100),
    road_grade         VARCHAR(30),
    sect               VARCHAR(10), -- 구간(SECT), 국토부 도로대장공간정보 표준 필드
    start_point        VARCHAR(100),
    end_point          VARCHAR(100),
    length_m           NUMERIC(10, 2),
    width_m            NUMERIC(6, 2),
    lane_count         SMALLINT,
    pavement_type      VARCHAR(20),
    pavement_material  VARCHAR(30),
    has_sidewalk       BOOLEAN,
    has_drainage       BOOLEAN,
    managing_agency    VARCHAR(100),
    completion_date    DATE,
    remarks            TEXT,
    created_by         INTEGER REFERENCES accounts(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by         INTEGER REFERENCES accounts(id),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS road_ledger_files (
    id            SERIAL PRIMARY KEY,
    pnu           VARCHAR(19) NOT NULL REFERENCES road_ledger(pnu) ON DELETE CASCADE,
    file_category VARCHAR(20) CHECK (file_category IN ('도면', '조서', '기타')),
    original_name TEXT NOT NULL,
    stored_path   TEXT NOT NULL,
    uploaded_by   INTEGER REFERENCES accounts(id),
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_road_ledger_files_pnu ON road_ledger_files(pnu);

-- 노선(구간) 단위 도면·구조물·영상 자료. 필지(pnu) 단위가 아니라
-- 도로등급+노선번호+노선명 조합으로 식별되는 노선 전체에 붙는 자료다.
-- (좌측 CAD 뷰어 패널 — 데이터보기 트리에서 노선을 선택하면 여기 연결됨)
CREATE TABLE IF NOT EXISTS route_files (
    id            SERIAL PRIMARY KEY,
    road_grade    VARCHAR(30) NOT NULL,
    route_no      VARCHAR(30) NOT NULL DEFAULT '',
    route_name    VARCHAR(100) NOT NULL DEFAULT '',
    -- road_sections.rdid 참조 (FK 제약은 걸지 않음 — 국토부 표준 자체가 ID
    -- 외래키가 아니라 업무키 매칭 방식이라 관례를 그대로 따름)
    section_rdid  VARCHAR(27),
    file_category VARCHAR(20) NOT NULL CHECK (file_category IN ('도로', '도면종류', '구조물', '공사도면', '동영상')),
    original_name TEXT NOT NULL,
    stored_path   TEXT NOT NULL,
    -- 노선은 필지(pnu)가 없어 시군구를 자동으로 알 수 없으므로, 업로드한 계정의
    -- 관할 시군구를 그대로 태깅한다(계정이 sigungu_code 없으면 NULL = 전체 공개).
    sigungu_code  VARCHAR(5),
    uploaded_by   INTEGER REFERENCES accounts(id),
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_route_files_route
    ON route_files(road_grade, route_no, route_name);

-- 시설물(gov_* 테이블) 단위 사진/보고서. 일괄등록(SHP/DBF) 시 같이 딸려오는
-- LAYER/통합/PHOTO, LAYER/통합/STR 파일들을 파일명(=시설물 RDID)으로 매칭해
-- 자동 연결한다(server/routes/bulkImport.js). facility_table+facility_rdid로
-- gov_* 각 테이블의 특정 레코드를 가리키며, FK는 걸지 않는다(gov_* 테이블이
-- 49개라 다형(polymorphic) 참조가 되고, 국토부 표준 자체가 업무키 매칭 방식임).
CREATE TABLE IF NOT EXISTS gov_facility_files (
    id             SERIAL PRIMARY KEY,
    facility_table VARCHAR(30) NOT NULL,
    facility_rdid  VARCHAR(30) NOT NULL,
    file_kind      VARCHAR(10) NOT NULL CHECK (file_kind IN ('사진', '보고서')),
    original_name  TEXT NOT NULL,
    stored_path    TEXT NOT NULL,
    sigungu_code   VARCHAR(5),
    uploaded_by    INTEGER REFERENCES accounts(id),
    uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 같은 zip을 다시 확정해도(재검수/재시도) 첨부가 중복되지 않도록
    -- gov_* 테이블 UPSERT와 동일하게 멱등으로 처리한다.
    UNIQUE (facility_table, facility_rdid, original_name)
);

CREATE INDEX IF NOT EXISTS idx_gov_facility_files_lookup
    ON gov_facility_files(facility_table, facility_rdid);

-- ============================================================
-- 사용자도로관리 — 공식 도로망도에 없는 임의 구간/지점(포트홀 보수, 민원,
-- 시설물 점검 등)에 대해 사용자가 지도에 직접 노선을 그려 업무 이력을
-- 남기는 기능. road_sections(공식 구간 대장)와는 별개의 데이터다.
-- ============================================================
CREATE TABLE IF NOT EXISTS road_issues (
    id           SERIAL PRIMARY KEY,
    category     VARCHAR(30) NOT NULL,  -- 업무구분: 도로구조(점용 등) 현황 | 도로 보수 현황 | 시설물 보수 현황
    team         VARCHAR(50),           -- 처리팀(자유 입력)
    status       VARCHAR(20) NOT NULL DEFAULT '민원제기',  -- 공사중|준공완료|민원제기|소송|행정명령|기타
    title        VARCHAR(200) NOT NULL,
    content      TEXT,
    geom         JSONB NOT NULL,        -- 사용자가 그린 경로, GeoJSON LineString(EPSG:4326)
    sigungu_code VARCHAR(5),
    created_by   INTEGER REFERENCES accounts(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by   INTEGER REFERENCES accounts(id),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_road_issues_category ON road_issues(category);
CREATE INDEX IF NOT EXISTS idx_road_issues_sigungu ON road_issues(sigungu_code);

CREATE TABLE IF NOT EXISTS road_issue_files (
    id            SERIAL PRIMARY KEY,
    issue_id      INTEGER NOT NULL REFERENCES road_issues(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    stored_path   TEXT NOT NULL,
    uploaded_by   INTEGER REFERENCES accounts(id),
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_road_issue_files_issue ON road_issue_files(issue_id);

-- express-session 저장용 테이블 (connect-pg-simple이 요구하는 스키마)
CREATE TABLE IF NOT EXISTS session (
    sid    VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
    sess   JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);

-- 이미 생성되어 있던 DB(CREATE TABLE IF NOT EXISTS가 건너뛰는 경우)에도
-- 새로 추가된 컬럼이 반영되도록 안전하게 재적용 가능한 마이그레이션.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sigungu_name VARCHAR(50);
ALTER TABLE route_files ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE route_files ADD COLUMN IF NOT EXISTS section_rdid VARCHAR(27);
CREATE INDEX IF NOT EXISTS idx_route_files_section_rdid ON route_files(section_rdid);
-- DWG 업로드 시 ODA File Converter로 변환해둔 DXF 미리보기 파일 경로 (없으면 NULL)
ALTER TABLE route_files ADD COLUMN IF NOT EXISTS converted_path TEXT;

-- "도로" 카테고리 중 500m 단위로 쪼갠 구간 도면(평면도P/Y 등, 파일명 패턴
-- {노선번호4}{구간2}{측점6}{P|Y}.dwg)의 구간 정보. 업로드 시 파일명을 파싱해서
-- 채우고(routeFileNaming.js), 패턴에 안 맞는 일반 "도로" 파일은 전부 NULL로
-- 남아 기존처럼 평범한 파일 목록으로 표시된다(하위호환).
ALTER TABLE route_files ADD COLUMN IF NOT EXISTS seg_no INTEGER;
ALTER TABLE route_files ADD COLUMN IF NOT EXISTS seg_start_km NUMERIC(6,3);
ALTER TABLE route_files ADD COLUMN IF NOT EXISTS seg_end_km NUMERIC(6,3);
ALTER TABLE route_files ADD COLUMN IF NOT EXISTS seg_variant VARCHAR(4);
CREATE INDEX IF NOT EXISTS idx_route_files_seg ON route_files(section_rdid, seg_no);

-- ============================================================
-- 변경 이력(감사 로그) — 누가 언제 무엇을(구간 등록/수정/삭제, 일괄등록으로
-- 인한 시설물 대량 upsert) 했는지 추적한다. 일괄등록은 기존 데이터를 조용히
-- 덮어쓰는 upsert라 이 로그가 없으면 "왜 값이 바뀌었는지" 추적이 불가능했다.
-- user_id는 계정이 삭제돼도 로그 자체는 남아야 하므로 ON DELETE SET NULL —
-- 대신 username을 그때 값 그대로 스냅샷해서 계정이 사라져도 "누가"는 남는다.
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
    id            BIGSERIAL PRIMARY KEY,
    action        VARCHAR(20) NOT NULL,   -- 'create' | 'update' | 'delete' | 'bulk_import'
    target_table  VARCHAR(50) NOT NULL,   -- 'road_sections' 등
    target_id     VARCHAR(50),            -- rdid 등(일괄등록 요약 행은 NULL)
    summary       TEXT NOT NULL,          -- 목록에 바로 보여줄 한 줄 설명
    detail        JSONB,                  -- 변경 전/후 값, 레이어별 건수 등
    sigungu_code  VARCHAR(5),
    user_id       INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    username      VARCHAR(50),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target_table, target_id);
