-- ============================================================
-- 국토교통부 「도로대장공간정보」 표준 정의서 v2.3 기준 전체 스키마
-- 01.도로대장총괄(구간 단위 레코드) + 02~49 시설물 상세 테이블 48종
-- 원본 정의서(2025_도로대장공간정보_테이블정의서_v2.3.xlsx)의 필드 목록을
-- 그대로 옮긴 것으로, 필드명/자료형/길이/필수여부가 표준과 1:1 대응된다.
-- 각 테이블은 독립된 PK(RDID)를 가지며, 상호 참조는 표준상 FK가 아니라
-- (mco, road_rank, road_name, road_no, sect) 조합(업무키)으로 이루어진다
-- (정의서 자체가 관계형 FK가 아닌 코드 매칭 방식의 데이터교환 표준이기 때문).
-- 적용: psql -h <host> -U <user> -d <database> -f gov_facility_schema.sql
-- ============================================================

-- 01.도로대장총괄 : 도로대장총괄 (MROAD, 레이어코드 A0020000) — 103개 필드
CREATE TABLE IF NOT EXISTS gov_section (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    dsgdate VARCHAR(10) NOT NULL,  -- 노선지정(인정)일
    j_date VARCHAR(10) NOT NULL,  -- 도로구역결정(변경)일
    d_date VARCHAR(10) NOT NULL,  -- 접도구역지정일
    jj_date VARCHAR(10) NOT NULL,  -- 지적고시일
    s_point VARCHAR(100) NOT NULL,  -- 위치_시점
    e_point VARCHAR(100) NOT NULL,  -- 위치_종점
    impopass VARCHAR(100) NOT NULL,  -- 주요 통과지
    lenth NUMERIC(13,3) NOT NULL,  -- 노선연장
    perslenth NUMERIC(13,3),  -- 전용연장
    mixlenth NUMERIC(13,3),  -- 중용연장
    ntrflenth NUMERIC(13,3),  -- 통행불능연장
    p_ent_len NUMERIC(13,3) NOT NULL,  -- 노선연장의 내역_포장도로_계
    p_road_len NUMERIC(13,3) NOT NULL,  -- 노선연장의 내역_포장도로_도로
    p_tun_ea2 NUMERIC(7,0),  -- 노선연장의 내역_포장도로_터널_2차로_개소
    p_tun_ea3 NUMERIC(7,0),  -- 노선연장의 내역_포장도로_터널_3차로_개소
    p_tun_ea4 NUMERIC(7,0),  -- 노선연장의 내역_포장도로_터널_4차로_개소
    p_tun_ea5 NUMERIC(7,0),  -- 노선연장의 내역_포장도로_터널_5차로이상_개소
    p_tuneaall NUMERIC(7,0),  -- 노선연장의 내역_포장도로_터널_개소 계
    p_tun_len2 NUMERIC(13,3),  -- 노선연장의 내역_포장도로_터널_2차로_연장
    p_tun_len3 NUMERIC(13,3),  -- 노선연장의 내역_포장도로_터널_3차로_연장
    p_tun_len4 NUMERIC(13,3),  -- 노선연장의 내역_포장도로_터널_4차로_연장
    p_tun_len5 NUMERIC(13,3),  -- 노선연장의 내역_포장도로_터널_5차로이상_연장
    p_tunlenal NUMERIC(13,3),  -- 노선연장의 내역_포장도로_터널_연장 계
    kanga NUMERIC(7,0),  -- 노선연장의 내역_포장도로_교량_강교_개소
    chula NUMERIC(7,0),  -- 노선연장의 내역_포장도로_교량_철근콘크리트교_개소
    haba NUMERIC(7,0),  -- 노선연장의 내역_포장도로_교량_합성교_개소
    etca NUMERIC(7,0),  -- 노선연장의 내역_포장도로_교량_그밖의교량_개소
    alla NUMERIC(7,0),  -- 노선연장의 내역_포장도로_교량_개소 계
    kangb NUMERIC(13,3),  -- 노선연장의 내역_포장도로_교량_강교_연장
    chulb NUMERIC(13,3),  -- 노선연장의 내역_포장도로_교량_철근콘크리트교_연장
    habb NUMERIC(13,3),  -- 노선연장의 내역_포장도로_교량_합성교_연장
    etcb NUMERIC(13,3),  -- 노선연장의 내역_포장도로_교량_그밖의교량_연장
    allb NUMERIC(13,3),  -- 노선연장의 내역_포장도로_교량_연장 계
    np_roadlen NUMERIC(13,3),  -- 노선연장의 내역_비포장도로
    nt_roadlen NUMERIC(13,3),  -- 노선연장의 내역_미개통도로
    wid_all NUMERIC(13,3) NOT NULL,  -- 노선연장의 내역_폭원_계
    wid_road NUMERIC(13,3) NOT NULL,  -- 노선연장의 내역_폭원_차도
    wid_cen NUMERIC(13,3),  -- 노선연장의 내역_폭원_중앙분리대
    wid_gil NUMERIC(13,3),  -- 노선연장의 내역_폭원_길어깨(보도)
    p_thc_all NUMERIC(7,0),  -- 노선연장의 내역_포장두께_계
    p_thc_pg NUMERIC(7,0),  -- 노선연장의 내역_포장두께_표층기층,포장슬래브
    p_thc_sub NUMERIC(7,0),  -- 노선연장의 내역_포장두께_보조기층
    road_len_2 NUMERIC(13,3),  -- 노선연장의 내역_차로수_2차로 미만
    road_len_4 NUMERIC(13,3),  -- 노선연장의 내역_차로수_2차로 이상~4차로 미만
    road_len_6 NUMERIC(13,3),  -- 노선연장의 내역_차로수_4차로 이상~6차로 미만
    road_len_7 NUMERIC(13,3),  -- 노선연장의 내역_차로수_6차로 이상
    roadlenau NUMERIC(13,3) NOT NULL,  -- 노선연장의 내역_차도_계_상행
    roadlenad NUMERIC(13,3) NOT NULL,  -- 노선연장의 내역_차도_계_하행
    as_len_au NUMERIC(13,3),  -- 노선연장의 내역_차도_아스팔트_상행
    as_len_ad NUMERIC(13,3),  -- 노선연장의 내역_차도_아스팔트_하행
    con_lenau NUMERIC(13,3),  -- 노선연장의 내역_차도_콘크리트_상행
    con_lenad NUMERIC(13,3),  -- 노선연장의 내역_차도_콘크리트_하행
    np_len_au NUMERIC(13,3),  -- 노선연장의 내역_차도_비포장_상행
    np_len_ad NUMERIC(13,3),  -- 노선연장의 내역_차도_비포장_하행
    p_m_l NUMERIC(13,3),  -- 노선연장의 내역_길어깨(보도)_포장_좌
    p_m_r NUMERIC(13,3),  -- 노선연장의 내역_길어깨(보도)_포장_우
    np_m_l NUMERIC(13,3),  -- 노선연장의 내역_길어깨(보도)_비포장_좌
    np_m_r NUMERIC(13,3),  -- 노선연장의 내역_길어깨(보도)_비포장_우
    by_l NUMERIC(13,3),  -- 노선연장의 내역_자전거도로_좌
    by_r NUMERIC(13,3),  -- 노선연장의 내역_자전거도로_우
    allarea NUMERIC(13,3) NOT NULL,  -- 도로부지면적_계
    nationarea NUMERIC(13,3),  -- 도로부지면적_국유지
    locatarea NUMERIC(13,3),  -- 도로부지면적_공유지
    priv_area NUMERIC(13,3),  -- 도로부지면적_사유지
    micrv100 NUMERIC(7,0),  -- 곡선반경 100m 미만 개소
    micrv200 NUMERIC(7,0),  -- 곡선반경 100m이상~200m미만 개소
    micrv300 NUMERIC(7,0),  -- 곡선반경 200m이상~300m미만 개소
    micrv460 NUMERIC(7,0),  -- 곡선반경 300m이상~460m미만 개소
    micrv700 NUMERIC(7,0),  -- 곡선반경 460m이상~700m미만 개소
    micrv701 NUMERIC(7,0),  -- 곡선반경 700m 이상 개소
    crs_obrdg NUMERIC(7,0),  -- 교차_육교 개소
    crs_sub NUMERIC(7,0),  -- 교차_지하도 개소
    crs_railgu NUMERIC(7,0),  -- 교차_철도_과선 개소
    crs_railga NUMERIC(7,0),  -- 교차_철도_가도 개소
    crs_road2d NUMERIC(7,0),  -- 교차_도로_평면 개소
    crs_road3d NUMERIC(7,0),  -- 교차_도로_입체 개소
    ver_s_3ea NUMERIC(7,0),  -- 종단경사 3% 미만 개소
    ver_s_3len NUMERIC(13,3),  -- 종단경사 3% 미만 연장
    ver_s_5ea NUMERIC(7,0),  -- 종단경사 3% 이상 5% 미만 개소
    ver_s_5len NUMERIC(13,3),  -- 종단경사 3% 이상 5% 미만 연장
    ver_s_10ea NUMERIC(7,0),  -- 종단경사 5% 이상 10% 미만 개소
    ver_s10len NUMERIC(13,3),  -- 종단경사 5% 이상 10% 미만 연장
    ver_s_11ea NUMERIC(7,0),  -- 종단경사 10% 이상 개소
    ver_s11len NUMERIC(13,3),  -- 종단경사 10% 이상 연장
    paywho VARCHAR(50),  -- 유료도로_관리자
    pay_period VARCHAR(21),  -- 유료도로_요금징수시간(시작일시~종료일시)
    pay_ea NUMERIC(7,0),  -- 유료도로_요금징수시설수
    payrec VARCHAR(100),  -- 유료도로_요금징수근거
    pay_alllen NUMERIC(13,3),  -- 유료도로_연장내역_계
    payroad NUMERIC(13,3),  -- 유료도로_연장내역_도로
    pay_tun_ea NUMERIC(7,0),  -- 유료도로_연장내역_터널_개소
    paytunnel NUMERIC(13,3),  -- 유료도로_연장내역_터널_연장
    pay_brdgea NUMERIC(7,0),  -- 유료도로_연장내역_교량_개소
    paybrdg NUMERIC(13,3),  -- 유료도로_연장내역_교량_연장
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 02.교량 : 교량 (BRIDGE, 레이어코드 A0070000) — 80개 필드
CREATE TABLE IF NOT EXISTS gov_bridge (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    brdg_name VARCHAR(50),  -- 교량명
    fa_type VARCHAR(4) NOT NULL,  -- 시설물종별
    sect_st NUMERIC(13,3),  -- 위치_시점
    address VARCHAR(100),  -- 소재지
    sect_ed NUMERIC(13,3),  -- 위치_종점
    str_level VARCHAR(4) NOT NULL,  -- 상태등급
    re_dia VARCHAR(4) NOT NULL,  -- 진단결과
    brdg_len NUMERIC(13,3),  -- 교량연장
    col_ea NUMERIC(7,0),  -- 경간수
    col_len NUMERIC(13,3),  -- 최대경간장
    lane_u NUMERIC(7,0),  -- 차로수(상행)
    width_sum NUMERIC(13,3),  -- 총폭원
    car_width NUMERIC(13,3),  -- 차도폭
    walk_width NUMERIC(13,3),  -- 보도폭
    lane_d NUMERIC(7,0),  -- 차로수(하행)
    de_wet VARCHAR(4) NOT NULL,  -- 설계활하중
    per_wet NUMERIC(13,3),  -- 허용통행하중
    in_de VARCHAR(1),  -- 내진설계
    col_const VARCHAR(100),  -- 경간구성
    col_type VARCHAR(4) NOT NULL,  -- 주경간형식
    col_mat VARCHAR(4) NOT NULL,  -- 부경간형식
    hc_dst NUMERIC(13,3),  -- 상부공_주형_간격
    hc_hit NUMERIC(13,3),  -- 상부공_주형_높이
    up_thick NUMERIC(13,3),  -- 상부공_상판_두께
    up_type VARCHAR(4) NOT NULL,  -- 상부공_상판_재료
    fen_hit NUMERIC(13,3),  -- 상부공_난간_높이
    fen_len NUMERIC(13,3),  -- 상부공_난간_연장
    fen_mat VARCHAR(4) NOT NULL,  -- 상부공_난간_재료
    link VARCHAR(4) NOT NULL,  -- 상부공_신축이음장치_형식
    link_len NUMERIC(13,3),  -- 상부공_신축이음장치_길이
    link_ea NUMERIC(7,0),  -- 상부공_신축이음장치_수량
    gy_type VARCHAR(4) NOT NULL,  -- 상부공_교면_포장재료
    gy_thick NUMERIC(13,3),  -- 상부공_교면_포장두께
    gy_water VARCHAR(4) NOT NULL,  -- 상부공_교면_방수형식
    pl_type VARCHAR(4) NOT NULL,  -- 하부공_교대_형식
    pl_dip NUMERIC(13,3),  -- 하부공_교대_매립깊이
    pl_hit NUMERIC(13,3),  -- 하부공_교대_총높이
    pl_base VARCHAR(4) NOT NULL,  -- 하부공_교대_기초형식
    edg_type VARCHAR(4) NOT NULL,  -- 하부공_교각_형식
    edg_dip NUMERIC(13,3),  -- 하부공_교각_매립깊이
    edg_hit NUMERIC(13,3),  -- 하부공_교각_총높이
    edg_base VARCHAR(4) NOT NULL,  -- 하부공_교각_기초형식
    edg_hrn NUMERIC(13,3),  -- 하부공_교각_평수위
    wing_type VARCHAR(4) NOT NULL,  -- 하부공_날개벽_종류
    wing_len NUMERIC(13,3),  -- 하부공_날개벽_길이
    per_lane VARCHAR(1),  -- 점검통로
    sep_type VARCHAR(4) NOT NULL,  -- 상부공_교좌장치_형식
    sep_len VARCHAR(4) NOT NULL,  -- 상부공_교좌장치_규격
    crs_type VARCHAR(4) NOT NULL,  -- 교차종류
    cen_type VARCHAR(4) NOT NULL,  -- 중앙분리대_종류
    cen_len NUMERIC(13,3),  -- 중앙분리대_연장
    r_s_s_type VARCHAR(4) NOT NULL,  -- 차․보도분리시설_종류
    r_s_s_len NUMERIC(13,3),  -- 차도.보도분리시설_연장
    lgt_type VARCHAR(4) NOT NULL,  -- 조명시설_종류
    lgt_ea NUMERIC(7,0),  -- 조명시설_수량
    sp_type VARCHAR(4) NOT NULL,  -- 방음시설_종류
    sp_len NUMERIC(13,3),  -- 방음시설_연장
    period NUMERIC(7,0),  -- 공사기간
    st_day VARCHAR(10),  -- 착공일
    ed_day VARCHAR(10),  -- 준공일
    consthall VARCHAR(50),  -- 시행자
    const VARCHAR(50),  -- 시공자
    designer VARCHAR(50),  -- 설계자
    supervisor VARCHAR(50),  -- 감리자
    total_ct NUMERIC(16,3),  -- 총사업비
    dgn_ct NUMERIC(16,3),  -- 설계비
    work_ct NUMERIC(16,3),  -- 공사비
    su_ct NUMERIC(16,3),  -- 감리비
    str_cod VARCHAR(27),  -- 구조물코드
    remark VARCHAR(200),  -- 비고
    c_view VARCHAR(200),  -- 전경사진
    pos_view VARCHAR(200),  -- 위치도
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 03.터널 : 터널 (TUNNEL, 레이어코드 A0110020) — 68개 필드
CREATE TABLE IF NOT EXISTS gov_tunnel (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    tun_name VARCHAR(20),  -- 터널명
    fa_type VARCHAR(4) NOT NULL,  -- 시설물종별
    sect_st NUMERIC(13,3),  -- 위치_시점
    address VARCHAR(100),  -- 소재지
    sect_ed NUMERIC(13,3),  -- 위치_종점
    str_level VARCHAR(4) NOT NULL,  -- 상태등급
    re_dia VARCHAR(4) NOT NULL,  -- 진단결과
    len_u NUMERIC(13,3),  -- 연장_상행
    len_d NUMERIC(13,3),  -- 연장_하행
    wid_au NUMERIC(13,3),  -- 폭원_계_상행
    wid_ad NUMERIC(13,3),  -- 폭원_계_하행
    wid_cu NUMERIC(13,3),  -- 폭원_차도_상행
    wid_cd NUMERIC(13,3),  -- 폭원_차도_하행
    wid_wu NUMERIC(13,3),  -- 폭원_보도_상행
    wid_wd NUMERIC(13,3),  -- 폭원_보도_하행
    hit_u NUMERIC(13,3),  -- 높이_상행
    hit_d NUMERIC(13,3),  -- 높이_하행
    ph_u NUMERIC(13,3),  -- 통행제한높이_상행
    ph_d NUMERIC(13,3),  -- 통행제한높이_하행
    sh_u VARCHAR(50),  -- 형상_상행
    sh_d VARCHAR(50),  -- 형상_하행
    lane_u NUMERIC(7,0),  -- 차로수_상행
    lane_d NUMERIC(7,0),  -- 차로수_하행
    met_u VARCHAR(4) NOT NULL,  -- 공법_상행
    met_d VARCHAR(4) NOT NULL,  -- 공법_하행
    fl_thick NUMERIC(13,3),  -- 바닥_두께
    fl_met VARCHAR(4) NOT NULL,  -- 바닥_재질
    ce_thick NUMERIC(13,3),  -- 천정_두께
    ce_met VARCHAR(4) NOT NULL,  -- 천정_재질
    side_thick NUMERIC(13,3),  -- 측벽 두께
    sidewall VARCHAR(4) NOT NULL,  -- 측벽_재질
    ver_s NUMERIC(13,3),  -- 종단경사
    cur_r NUMERIC(13,3),  -- 곡선반경
    drainage VARCHAR(4) NOT NULL,  -- 배수시설
    et_type VARCHAR(4) NOT NULL,  -- 소화설비_종류
    et_ea NUMERIC(7,0),  -- 소화설비_수량
    al_type VARCHAR(4) NOT NULL,  -- 경보설비 종류
    al_ea NUMERIC(7,0),  -- 경보설비 수량
    eva_type VARCHAR(4) NOT NULL,  -- 피난대피설비 종류
    eva_ea NUMERIC(7,0),  -- 피난대피설비 수량
    fe_type VARCHAR(4) NOT NULL,  -- 소화활동설비 종류
    fe_ea NUMERIC(7,0),  -- 소화활동설비 수량
    em_type VARCHAR(4),  -- 비상전원설비 종류
    em_ea NUMERIC(7,0),  -- 비상전원설비 수량
    lgt_type VARCHAR(4) NOT NULL,  -- 조명시설_종류
    lgt_ea NUMERIC(7,0),  -- 조명시설_수량
    etc_eq VARCHAR(200),  -- 그 밖의 설비
    period NUMERIC(7,0),  -- 공사기간
    st_day VARCHAR(10),  -- 착공일
    end_day VARCHAR(10),  -- 준공일
    consthall VARCHAR(50),  -- 시행청
    const VARCHAR(50),  -- 시공자
    designer VARCHAR(50),  -- 설계자
    supervisor VARCHAR(50),  -- 감리자
    total_ct NUMERIC(16,3),  -- 총사업비
    dgn_ct NUMERIC(16,3),  -- 설계비
    work_ct NUMERIC(16,3),  -- 공사비
    su_ct NUMERIC(16,3),  -- 감리비
    str_cod VARCHAR(27),  -- 구조물코드
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 04.육교 : 육교 (OVERPASS, 레이어코드 A0063321) — 47개 필드
CREATE TABLE IF NOT EXISTS gov_overpass (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    op_name VARCHAR(50),  -- 육교명
    sect_st NUMERIC(13,3),  -- 위치_시점
    address VARCHAR(100),  -- 소재지
    sect_ed NUMERIC(13,3),  -- 위치_종점
    len NUMERIC(13,3),  -- 연장
    hit NUMERIC(13,3),  -- 높이
    type VARCHAR(4) NOT NULL,  -- 육교 형식
    de_wet VARCHAR(4) NOT NULL,  -- 설계활하중
    per_wet NUMERIC(13,3),  -- 허용통행하중
    per_hit NUMERIC(13,3),  -- 통행제한높이
    gu_wid NUMERIC(13,3),  -- 구체_폭원
    sr_wid NUMERIC(13,3),  -- 계단_폭원
    ra_len NUMERIC(13,3),  -- 난간 연장
    gu_u_type VARCHAR(4) NOT NULL,  -- 구체_상부구조
    sr_len NUMERIC(13,3),  -- 계단_연장
    sr_ea NUMERIC(7,0),  -- 계단_개소
    ra_hit NUMERIC(13,3),  -- 난간_높이
    gu_d_type VARCHAR(4) NOT NULL,  -- 구체_하부구조
    sr_type VARCHAR(4) NOT NULL,  -- 계단_재질
    ra_type VARCHAR(4) NOT NULL,  -- 난간_재질
    lgt_type VARCHAR(4) NOT NULL,  -- 조명시설_종류
    lgt_ea NUMERIC(7,0),  -- 조명시설_수량
    dis_type VARCHAR(4) NOT NULL,  -- 장애인편익시설_종류
    dis_ea NUMERIC(7,0),  -- 장애인편익시설_수량
    fa_type VARCHAR(4),  -- 부대시설_종류
    fa_ea NUMERIC(7,0),  -- 부대시설_수량
    period NUMERIC(7,0),  -- 공사기간
    st_day VARCHAR(10),  -- 착공일
    ed_day VARCHAR(10),  -- 준공일
    consthall VARCHAR(50),  -- 시행청
    const VARCHAR(50),  -- 시공자
    designer VARCHAR(50),  -- 설계자
    supervisor VARCHAR(50),  -- 감리자
    total_ct NUMERIC(16,3),  -- 총사업비
    dgn_ct NUMERIC(16,3),  -- 설계비
    work_ct NUMERIC(16,3),  -- 공사비
    su_ct NUMERIC(16,3),  -- 감리비
    str_cod VARCHAR(27),  -- 구조물코드
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 05.지하차도 : 지하차도 (UNDER_ROAD, 레이어코드 A0093352) — 57개 필드
CREATE TABLE IF NOT EXISTS gov_under_road (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    ur_name VARCHAR(50),  -- 지하차도명
    fa_type VARCHAR(4) NOT NULL,  -- 시설물종별
    sect_st NUMERIC(13,3),  -- 위치_시점
    address VARCHAR(100),  -- 소재지
    sect_ed NUMERIC(13,3),  -- 위치_종점
    str_level VARCHAR(4) NOT NULL,  -- 상태등급
    re_dia VARCHAR(4) NOT NULL,  -- 진단결과
    len NUMERIC(13,3),  -- 연장
    type_wid NUMERIC(13,3),  -- 규격(폭)
    type_hit NUMERIC(13,3),  -- 규격(높이)
    type_col NUMERIC(13,3),  -- 규격(열)
    wid_car NUMERIC(13,3),  -- 폭원(차도)
    wid_walk NUMERIC(13,3),  -- 폭원(보도)
    lane_u NUMERIC(7,0),  -- 차로수(상행)
    lane_d NUMERIC(7,0),  -- 차로수(하행)
    ver_s NUMERIC(13,3),  -- 종단경사
    cur_r NUMERIC(13,3),  -- 곡선반경
    per_hit NUMERIC(13,3),  -- 통행제한높이
    wallmin_ht NUMERIC(13,3),  -- 옹벽_높이_최소
    wallmax_ht NUMERIC(13,3),  -- 옹벽_높이_최대
    wallhitlen NUMERIC(13,3),  -- 옹벽_연장
    ma_ce VARCHAR(4) NOT NULL,  -- 마감재_천정
    ma_bl VARCHAR(4) NOT NULL,  -- 마감재_벽체
    drainage VARCHAR(4) NOT NULL,  -- 배수시설
    et_type VARCHAR(4) NOT NULL,  -- 소화설비_종류
    et_ea NUMERIC(7,0),  -- 소화설비_수량
    al_type VARCHAR(4) NOT NULL,  -- 경보설비 종류
    al_ea NUMERIC(7,0),  -- 경보설비 수량
    eva_type VARCHAR(4) NOT NULL,  -- 피난대피설비 종류
    eva_ea NUMERIC(7,0),  -- 피난대피설비 수량
    fe_type VARCHAR(4) NOT NULL,  -- 소화활동설비 종류
    fe_ea NUMERIC(7,0),  -- 소화활동설비 수량
    em_type VARCHAR(4),  -- 비상전원설비 종류
    em_ea NUMERIC(7,0),  -- 비상전원설비 수량
    lgt_type VARCHAR(4) NOT NULL,  -- 조명시설_종류
    lgt_ea NUMERIC(7,0),  -- 조명시설_수량
    period NUMERIC(7,0),  -- 공사기간
    st_day VARCHAR(10),  -- 착공일
    end_day VARCHAR(10),  -- 준공일
    consthall VARCHAR(50),  -- 시행청
    const VARCHAR(50),  -- 시공자
    designer VARCHAR(50),  -- 설계자
    supervisor VARCHAR(50),  -- 감리자
    total_ct NUMERIC(16,3),  -- 총사업비
    dgn_ct NUMERIC(16,3),  -- 설계비
    work_ct NUMERIC(16,3),  -- 공사비
    su_ct NUMERIC(16,3),  -- 감리비
    str_cod VARCHAR(27),  -- 구조물코드
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 06.고가도로 : 고가도로 (HIGH_ROAD, 레이어코드 A0093351) — 47개 필드
CREATE TABLE IF NOT EXISTS gov_high_road (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    hr_name VARCHAR(50),  -- 고가도로명
    fa_type VARCHAR(4) NOT NULL,  -- 시설물종별
    sect_st NUMERIC(13,3),  -- 위치_시점
    address VARCHAR(100),  -- 소재지
    sect_ed NUMERIC(13,3),  -- 위치_종점
    str_level VARCHAR(4) NOT NULL,  -- 상태등급
    re_dia VARCHAR(4) NOT NULL,  -- 진단결과
    road_wid NUMERIC(13,3),  -- 도로_폭원
    ramp_ea NUMERIC(7,0),  -- 램프_개수
    met_car VARCHAR(4) NOT NULL,  -- 재질_차도
    road_len NUMERIC(13,3),  -- 도로_연장
    ramp_wid NUMERIC(13,3),  -- 램프_폭원
    mat_wark VARCHAR(4) NOT NULL,  -- 재질_보도
    lane_u NUMERIC(7,0),  -- 도로_차로수(상행)
    lane_d NUMERIC(7,0),  -- 도로_차로수(하행)
    ramp_len NUMERIC(13,3),  -- 램프_연장
    met_ra VARCHAR(4) NOT NULL,  -- 재질_난간
    u_type VARCHAR(4) NOT NULL,  -- 구조형식_상부구조
    d_type VARCHAR(4) NOT NULL,  -- 구조형식_하부구조
    lgt_type VARCHAR(4) NOT NULL,  -- 조명시설_종류
    lgt_ea NUMERIC(7,0),  -- 조명시설_수량
    sp_type VARCHAR(4) NOT NULL,  -- 방음시설_종류
    sp_len NUMERIC(13,3),  -- 방음시설_연장
    de_wet VARCHAR(4) NOT NULL,  -- 설계활하중
    per_wet NUMERIC(13,3),  -- 허용통행하중
    crs_type VARCHAR(4),  -- 교차종류
    period NUMERIC(7,0),  -- 공사기간
    st_day VARCHAR(10),  -- 착공일
    ed_day VARCHAR(10),  -- 준공일
    consthall VARCHAR(50),  -- 시행청
    const VARCHAR(50),  -- 시공자
    designer VARCHAR(50),  -- 설계자
    supervisor VARCHAR(50),  -- 감리자
    total_ct NUMERIC(16,3),  -- 총사업비
    dgn_ct NUMERIC(16,3),  -- 설계비
    work_ct NUMERIC(16,3),  -- 공사비
    su_ct NUMERIC(16,3),  -- 감리비
    str_cod VARCHAR(27),  -- 구조물코드
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 07.인터체인지(IC) : 인터체인지(IC) (INTERCHANGE, 레이어코드 A0100000) — 73개 필드
CREATE TABLE IF NOT EXISTS gov_interchange (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    ic_name VARCHAR(50),  -- IC명
    ic_day VARCHAR(10),  -- IC 개통일
    sect_st NUMERIC(13,3),  -- 위치-시점
    sect_ed NUMERIC(13,3),  -- 위치-종점
    address VARCHAR(100),  -- 소재지
    type VARCHAR(4) NOT NULL,  -- IC 형식
    jt_road VARCHAR(100),  -- 접속도로-도로명
    jt_mco VARCHAR(50),  -- 접속도로-관리청
    jt_lane NUMERIC(7,0),  -- 접속도로-차로수
    r1_type VARCHAR(1),  -- 램프1 시설구조
    r2_type VARCHAR(1),  -- 램프2 시설구조
    r3_type VARCHAR(1),  -- 램프3 시설구조
    r4_type VARCHAR(1),  -- 램프4 시설구조
    r5_type VARCHAR(1),  -- 램프5 시설구조
    r6_type VARCHAR(1),  -- 램프6 시설구조
    r1_len NUMERIC(13,3),  -- 램프1 연장
    r2_len NUMERIC(13,3),  -- 램프2 연장
    r3_len NUMERIC(13,3),  -- 램프3 연장
    r4_len NUMERIC(13,3),  -- 램프4 연장
    r5_len NUMERIC(13,3),  -- 램프5 연장
    r6_len NUMERIC(13,3),  -- 램프6 연장
    r1_wid NUMERIC(13,3),  -- 램프1 폭원
    r2_wid NUMERIC(13,3),  -- 램프2 폭원
    r3_wid NUMERIC(13,3),  -- 램프3 폭원
    r4_wid NUMERIC(13,3),  -- 램프4 폭원
    r5_wid NUMERIC(13,3),  -- 램프5 폭원
    r6_wid NUMERIC(13,3),  -- 램프6 폭원
    r1_dis VARCHAR(1),  -- 램프1 진,출입로구분
    r2_dis VARCHAR(1),  -- 램프2 진,출입로구분
    r3_dis VARCHAR(1),  -- 램프3 진,출입로구분
    r4_dis VARCHAR(1),  -- 램프4 진,출입로구분
    r5_dis VARCHAR(1),  -- 램프5 진,출입로구분
    r6_dis VARCHAR(1),  -- 램프6 진,출입로구분
    r1_lane NUMERIC(7,0),  -- 램프1 차로수
    r2_lane NUMERIC(7,0),  -- 램프2 차로수
    r3_lane NUMERIC(7,0),  -- 램프3 차로수
    r4_lane NUMERIC(7,0),  -- 램프4 차로수
    r5_lane NUMERIC(7,0),  -- 램프5 차로수
    r6_lane NUMERIC(7,0),  -- 램프6 차로수
    r1_st_n VARCHAR(50),  -- 램프1 시점측 진행방향
    r2_st_n VARCHAR(50),  -- 램프2 시점측 진행방향
    r3_st_n VARCHAR(50),  -- 램프3 시점측 진행방향
    r4_st_n VARCHAR(50),  -- 램프4 시점측 진행방향
    r5_st_n VARCHAR(50),  -- 램프5 시점측 진행방향
    r6_st_n VARCHAR(50),  -- 램프6 시점측 진행방향
    r1_ed_n VARCHAR(50),  -- 램프1 종점측 진행방향
    r2_ed_n VARCHAR(50),  -- 램프2 종점측 진행방향
    r3_ed_n VARCHAR(50),  -- 램프3 종점측 진행방향
    r4_ed_n VARCHAR(50),  -- 램프4 종점측 진행방향
    r5_ed_n VARCHAR(50),  -- 램프5 종점측 진행방향
    r6_ed_n VARCHAR(50),  -- 램프6 종점측 진행방향
    period NUMERIC(7,0),  -- 공사기간
    st_day VARCHAR(10),  -- 착공일
    ed_day VARCHAR(10),  -- 준공일
    consthall VARCHAR(50),  -- 시행청
    const VARCHAR(50),  -- 시공자
    designer VARCHAR(50),  -- 설계자
    supervisor VARCHAR(50),  -- 감리자
    total_ct NUMERIC(16,3),  -- 총사업비
    dgn_ct NUMERIC(16,3),  -- 설계비
    work_ct NUMERIC(16,3),  -- 공사비
    su_ct NUMERIC(16,3),  -- 감리비
    ramp_sno NUMERIC(7,0),  -- 램프일련번호
    str_cod VARCHAR(27),  -- 구조물코드
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 08.교차시설 : 교차시설 (XRAIL, 레이어코드 A0080000) — 16개 필드
CREATE TABLE IF NOT EXISTS gov_xrail (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치
    x_name VARCHAR(50),  -- 교차시설명
    x_type VARCHAR(1),  -- 교차방식
    len NUMERIC(13,3),  -- 교차연장
    wid NUMERIC(13,3),  -- 교차시설의 폭원
    hit NUMERIC(13,3),  -- 유효높이
    x_ang NUMERIC(13,3),  -- 교차각도
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 09.차도부경계 : 차도부경계 (ROAD_BOUND, 레이어코드 A0010000) — 8개 필드
CREATE TABLE IF NOT EXISTS gov_road_bound (
    suid VARCHAR(11) PRIMARY KEY,  -- 차도부경계 공간정보ID
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    segment VARCHAR(4) NOT NULL,  -- 분절구간(중용, 램프 등)
    overlap VARCHAR(30),  -- 중용구간여부
    road_dv VARCHAR(1) NOT NULL,  -- 보차도 구분
    remark VARCHAR(200) NOT NULL,  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 10.중앙분리대 : 중앙분리대 (MEDIAN_STRIP, 레이어코드 C0520000) — 17개 필드
CREATE TABLE IF NOT EXISTS gov_median_strip (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    type VARCHAR(4) NOT NULL,  -- 중앙분리대 종류
    len NUMERIC(13,3),  -- 연장
    wid NUMERIC(13,3),  -- 분리대폭
    hit NUMERIC(13,3),  -- 높이
    grade VARCHAR(4) NOT NULL,  -- 중앙분리대 등급
    ins_day VARCHAR(10),  -- 설치일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 11.석축 : 석축 (STONE, 레이어코드 F9047226) — 20개 필드
CREATE TABLE IF NOT EXISTS gov_stone (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    direction VARCHAR(1) NOT NULL,  -- 방향
    st_dev VARCHAR(30) NOT NULL,  -- 구분
    st_type VARCHAR(4) NOT NULL,  -- 석축 종류
    uddi VARCHAR(1) NOT NULL,  -- 상하단구분
    uddi_2 VARCHAR(11) NOT NULL,  -- 상하단연결
    eqp_len NUMERIC(13,3),  -- 연장
    hit_max NUMERIC(13,3),  -- 높이_최대
    hit_min NUMERIC(13,3),  -- 높이_최소
    width NUMERIC(13,3),  -- 폭_경사
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 12.옹벽 : 옹벽 (WALL, 레이어코드 F9047224) — 20개 필드
CREATE TABLE IF NOT EXISTS gov_wall (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    direction VARCHAR(1) NOT NULL,  -- 방향
    wall_dev VARCHAR(30) NOT NULL,  -- 구분
    method VARCHAR(4) NOT NULL,  -- 옹벽 종류
    uddi VARCHAR(1) NOT NULL,  -- 상하단구분
    uddi_2 VARCHAR(11) NOT NULL,  -- 상하단연결
    eqp_len NUMERIC(13,3),  -- 연장
    hit_max NUMERIC(13,3),  -- 높이_최대
    hit_min NUMERIC(13,3),  -- 높이_최소
    width NUMERIC(13,3),  -- 폭_경사
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 13.깎기비탈면 : 깎기비탈면 (CUT_SLOPE, 레이어코드 F9037222) — 20개 필드
CREATE TABLE IF NOT EXISTS gov_cut_slope (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    direction VARCHAR(1) NOT NULL,  -- 방향
    cs_dev VARCHAR(30) NOT NULL,  -- 구분
    type VARCHAR(4) NOT NULL,  -- 깎기비탈면 종류
    uddi VARCHAR(1) NOT NULL,  -- 상하단구분
    uddi_2 VARCHAR(11) NOT NULL,  -- 상하단연결
    eqp_len NUMERIC(13,3),  -- 연장
    hit_max NUMERIC(13,3),  -- 높이_최대
    hit_min NUMERIC(13,3),  -- 높이_최소
    slope NUMERIC(13,3),  -- 폭_경사
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 14.쌓기비탈면 : 쌓기비탈면 (LAND_FILL, 레이어코드 F9037221) — 20개 필드
CREATE TABLE IF NOT EXISTS gov_land_fill (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    direction VARCHAR(1) NOT NULL,  -- 방향
    lf_dev VARCHAR(30) NOT NULL,  -- 구분
    type VARCHAR(4) NOT NULL,  -- 쌓기비탈면 종류
    uddi VARCHAR(1) NOT NULL,  -- 상하단구분
    uddi_2 VARCHAR(11) NOT NULL,  -- 상하단연결
    eqp_len NUMERIC(13,3),  -- 연장
    hit_max NUMERIC(13,3),  -- 높이_최대
    hit_min NUMERIC(13,3),  -- 높이_최소
    slope NUMERIC(13,3),  -- 폭_경사
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 15.지하보도 : 지하보도 (UNDER_SIDEWALK, 레이어코드 A9093353) — 44개 필드
CREATE TABLE IF NOT EXISTS gov_under_sidewalk (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    us_name VARCHAR(50),  -- 지하보도명
    fa_type VARCHAR(4) NOT NULL,  -- 시설물종별
    sect_st NUMERIC(13,3),  -- 위치_시점
    address VARCHAR(100),  -- 소재지
    sect_ed NUMERIC(13,3),  -- 위치_종점
    str_level VARCHAR(4) NOT NULL,  -- 상태등급
    re_dia VARCHAR(4) NOT NULL,  -- 진단결과
    len NUMERIC(13,3),  -- 연장
    type_wid NUMERIC(13,3),  -- 규격(폭)
    type_hit NUMERIC(13,3),  -- 규격(높이)
    wid NUMERIC(13,3),  -- 폭원
    en_ea NUMERIC(7,0),  -- 출입구 수
    ma_ce VARCHAR(4) NOT NULL,  -- 마감재_천정
    ma_bl VARCHAR(4) NOT NULL,  -- 마감재_벽체
    ma_fl VARCHAR(4) NOT NULL,  -- 마감재_바닥
    ma_en VARCHAR(4) NOT NULL,  -- 마감재_출입구
    lgt_type VARCHAR(4) NOT NULL,  -- 조명시설_종류
    lgt_ea NUMERIC(7,0),  -- 조명시설_수량
    et_type VARCHAR(4) NOT NULL,  -- 소화시설_종류
    et_ea NUMERIC(7,0),  -- 소화시설_수량
    drainage VARCHAR(4) NOT NULL,  -- 배수시설
    br_fa VARCHAR(1) NOT NULL,  -- 방송설비
    aw_fa VARCHAR(4) NOT NULL,  -- 환기방식
    period NUMERIC(7,0),  -- 공사기간
    st_day VARCHAR(10),  -- 착공일
    ed_day VARCHAR(10),  -- 준공일
    consthall VARCHAR(50),  -- 시행청
    const VARCHAR(50),  -- 시공자
    designer VARCHAR(50),  -- 설계자
    supervisor VARCHAR(50),  -- 감리자
    total_ct NUMERIC(16,3),  -- 총사업비
    dgn_ct NUMERIC(16,3),  -- 설계비
    work_ct NUMERIC(16,3),  -- 공사비
    su_ct NUMERIC(16,3),  -- 감리비
    str_cod VARCHAR(27),  -- 구조물코드
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 16.도로중심선교점 : 도로중심선교점 (XPOINT, 레이어코드 A9990001) — 22개 필드
CREATE TABLE IF NOT EXISTS gov_xpoint (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    ip_no VARCHAR(4),  -- IP번호
    ia_deg NUMERIC(7,0),  -- 교각(도)
    ia_min NUMERIC(7,0),  -- 교각(분)
    ia_sec NUMERIC(13,3),  -- 교각(초)
    r NUMERIC(13,3),  -- 곡선반경
    tl NUMERIC(13,3),  -- 접선장
    cl NUMERIC(13,3),  -- 곡선장
    sect_st_km NUMERIC(13,3),  -- 곡선시점
    sect_ed_km NUMERIC(13,3),  -- 곡선종점
    sl NUMERIC(13,3),  -- 중앙종거
    slope NUMERIC(13,3),  -- 경사
    wid NUMERIC(13,3),  -- 확폭
    line NUMERIC(13,3),  -- 직선장
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 17.오르막차로 : 오르막차로 (CLIMBING_LANE, 레이어코드 A9990002) — 16개 필드
CREATE TABLE IF NOT EXISTS gov_climbing_lane (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    direction VARCHAR(1) NOT NULL,  -- 방향
    len NUMERIC(13,3),  -- 연장
    lane NUMERIC(7,0),  -- 차로수
    wid NUMERIC(13,3),  -- 오르막차로의 폭원
    slope NUMERIC(13,3),  -- 경사
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 18. 종단경사 : 종단경사 (SLOPE, 레이어코드 A9990003) — 14개 필드
CREATE TABLE IF NOT EXISTS gov_slope (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    slope NUMERIC(13,3),  -- 경사
    st_hit NUMERIC(13,3),  -- 시점지반고
    slp_len NUMERIC(13,3),  -- 경사연장
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 19. 정차대 : 정차대 (STOPBAY, 레이어코드 A9053327) — 14개 필드
CREATE TABLE IF NOT EXISTS gov_stopbay (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치
    direction VARCHAR(1) NOT NULL,  -- 방향
    eqp_len NUMERIC(13,3),  -- 연장
    wid NUMERIC(13,3),  -- 폭
    wait VARCHAR(1) NOT NULL,  -- 대기소
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 20.측구 : 측구 (SIDE, 레이어코드 C0076117) — 18개 필드
CREATE TABLE IF NOT EXISTS gov_side (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    direction VARCHAR(1) NOT NULL,  -- 방향
    sd_dev VARCHAR(30) NOT NULL,  -- 구분
    side_kind VARCHAR(4) NOT NULL,  -- 측구 종류
    eqp_len NUMERIC(13,3),  -- 연장
    hit_max NUMERIC(13,3),  -- 높이_최대
    hit_min NUMERIC(13,3),  -- 높이_최소
    wid NUMERIC(13,3),  -- 폭_경사
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 21.배수암거 및 배수관 : 배수암거 및 배수관 (BOX_PIPE, 레이어코드 C9070001) — 20개 필드
CREATE TABLE IF NOT EXISTS gov_box_pipe (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치
    hor NUMERIC(13,3),  -- 규격_가로
    ver NUMERIC(13,3),  -- 규격_세로
    dia NUMERIC(13,3),  -- 규격_직경
    eqp_len NUMERIC(13,3),  -- 연장
    eqp_met VARCHAR(4) NOT NULL,  -- 재질_관
    eqp_met1 VARCHAR(4) NOT NULL,  -- 재질_면벽
    nal_l NUMERIC(7,0),  -- 날개벽_좌
    nal_r NUMERIC(7,0),  -- 날개벽_우
    jip_l NUMERIC(7,0),  -- 집수정_좌
    jip_r NUMERIC(7,0),  -- 집수정_우
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 22.낙석방지시설 : 낙석방지시설 (NORI, 레이어코드 C9530005) — 17개 필드
CREATE TABLE IF NOT EXISTS gov_nori (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50),  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3),  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    direction VARCHAR(1) NOT NULL,  -- 방향
    nr_dev VARCHAR(30),  -- 구분
    type VARCHAR(4) NOT NULL,  -- 낙석방지시설 종류
    eqp_len NUMERIC(13,3),  -- 연장
    hit NUMERIC(13,3),  -- 높이
    ins_day VARCHAR(10),  -- 설치일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 23.표지 : 표지 (SIGN, 레이어코드 C0410000) — 15개 필드
CREATE TABLE IF NOT EXISTS gov_sign (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_지점
    direction VARCHAR(1) NOT NULL,  -- 방향
    sb_kind VARCHAR(4) NOT NULL,  -- 표지 종류
    sb_name VARCHAR(8) NOT NULL,  -- 표지 명칭
    pole_type VARCHAR(4) NOT NULL,  -- 지주형식
    inst_day VARCHAR(10),  -- 설치일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 24.전광표지 : 전광표지 (VARIABLE_SIGH, 레이어코드 C9413426) — 15개 필드
CREATE TABLE IF NOT EXISTS gov_variable_sigh (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_지점
    direction VARCHAR(1) NOT NULL,  -- 방향
    dsp_type VARCHAR(4) NOT NULL,  -- 표시면 기술형식
    exp_type VARCHAR(4) NOT NULL,  -- 표출형식
    ins_type VARCHAR(4) NOT NULL,  -- 설치형식
    ins_day VARCHAR(10),  -- 설치일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 25.가로등 : 가로등 (STREET_LIGHT, 레이어코드 C0223367) — 18개 필드
CREATE TABLE IF NOT EXISTS gov_street_light (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    direction VARCHAR(1) NOT NULL,  -- 방향
    dun_type VARCHAR(4) NOT NULL,  -- 등주형식
    dun_mat VARCHAR(4) NOT NULL,  -- 등주재질
    lgt_type VARCHAR(4) NOT NULL,  -- 광원종류
    lgt_wgt VARCHAR(4) NOT NULL,  -- 광원용량
    lgt_num NUMERIC(7,0),  -- 등기구의 수량
    ins_day VARCHAR(10),  -- 설치일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 26.신호등 : 신호등 (SIGNAL_LAMP, 레이어코드 C0493376) — 14개 필드
CREATE TABLE IF NOT EXISTS gov_signal_lamp (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_지점
    direction VARCHAR(1) NOT NULL,  -- 방향
    type VARCHAR(4) NOT NULL,  -- 신호등 종류
    ins_type VARCHAR(4) NOT NULL,  -- 신호등 설치형식
    ins_day VARCHAR(10),  -- 설치일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 27.방호울타리 : 방호울타리 (DEFENCE, 레이어코드 C0530000) — 19개 필드
CREATE TABLE IF NOT EXISTS gov_defence (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    direction VARCHAR(1) NOT NULL,  -- 방향
    df_dev VARCHAR(30),  -- 구분
    eqp_kind VARCHAR(4) NOT NULL,  -- 방호울타리 종류
    eqp_len NUMERIC(13,3),  -- 연장
    hit NUMERIC(13,3),  -- 높이
    ins_day VARCHAR(10),  -- 설치일
    grade VARCHAR(4) NOT NULL,  -- 등급
    product VARCHAR(100),  -- 제품명
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 28.충격흡수시설 : 충격흡수시설 (IMPACT, 레이어코드 C9530001) — 15개 필드
CREATE TABLE IF NOT EXISTS gov_impact (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_지점
    direction VARCHAR(1) NOT NULL,  -- 방향
    eqp_kind VARCHAR(4) NOT NULL,  -- 충격흡수시설 종류
    grade VARCHAR(4) NOT NULL,  -- 충격흡수시설 등급
    ins_day VARCHAR(10),  -- 설치일
    product VARCHAR(100),  -- 제품명
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 29.방음시설 : 방음시설 (SOUND_PROOFING, 레이어코드 C0536114) — 27개 필드
CREATE TABLE IF NOT EXISTS gov_sound_proofing (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    direction VARCHAR(1) NOT NULL,  -- 방향
    sp_dev VARCHAR(30),  -- 구분
    type VARCHAR(4) NOT NULL,  -- 방음시설_종류
    snd_met VARCHAR(4) NOT NULL,  -- 방음시설_재질
    hit NUMERIC(13,3),  -- 높이_수량
    ins_day VARCHAR(10),  -- 설치_식재일
    et_type VARCHAR(4) NOT NULL,  -- 소화설비_종류
    et_ea NUMERIC(7,0),  -- 소화설비_수량
    al_type VARCHAR(4),  -- 경보설비 종류
    al_ea NUMERIC(7,0),  -- 경보설비 수량
    eva_type VARCHAR(4),  -- 피난대피설비 종류
    eva_ea NUMERIC(7,0),  -- 피난대피설비 수량
    fe_type VARCHAR(4),  -- 소화활동설비 종류
    fe_ea NUMERIC(7,0),  -- 소화활동설비 수량
    em_type VARCHAR(4),  -- 비상전원설비 종류
    em_ea NUMERIC(7,0),  -- 비상전원설비 수량
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 30.가로수 : 가로수 (STREET_TREE, 레이어코드 D0023372) — 16개 필드
CREATE TABLE IF NOT EXISTS gov_street_tree (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    direction VARCHAR(1) NOT NULL,  -- 방향
    st_dev VARCHAR(30),  -- 구분
    type VARCHAR(4) NOT NULL,  -- 가로수 종류
    hit NUMERIC(13,3),  -- 높이_수량
    ins_day VARCHAR(10),  -- 설치_식재일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 31.지하매설물 : 지하매설물 (DIP_EQP, 레이어코드 C0246120) — 19개 필드
CREATE TABLE IF NOT EXISTS gov_dip_eqp (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치-시점
    sect_ed NUMERIC(13,3),  -- 위치-종점
    direction VARCHAR(1) NOT NULL,  -- 방향
    dip_kind VARCHAR(4) NOT NULL,  -- 매설물 종류
    dip_met VARCHAR(4) NOT NULL,  -- 매설물 재질
    dip_size VARCHAR(50),  -- 규격
    dip_hit NUMERIC(13,3),  -- 매설깊이
    ea NUMERIC(7,0),  -- 수량
    eqp_len NUMERIC(13,3),  -- 연장
    dip_day VARCHAR(10),  -- 설치일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 32.공동구 : 공동구 (PIPE_CONDUIT, 레이어코드 C0246341) — 17개 필드
CREATE TABLE IF NOT EXISTS gov_pipe_conduit (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    pip_name VARCHAR(50),  -- 공동구명
    hit NUMERIC(13,3),  -- 높이
    wid NUMERIC(13,3),  -- 폭
    eqp_len NUMERIC(13,3),  -- 연장
    dip_hit NUMERIC(13,3),  -- 매설깊이
    ins_day VARCHAR(10),  -- 설치일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 33.과적검문소 : 과적검문소 (OVER_CHECKPOINT, 레이어코드 C9530006) — 14개 필드
CREATE TABLE IF NOT EXISTS gov_over_checkpoint (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_지점
    direction VARCHAR(1) NOT NULL,  -- 방향
    oc_dev VARCHAR(30),  -- 구분
    type VARCHAR(1),  -- 종류
    ins_day VARCHAR(10),  -- 설치일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 34.제설시설 : 제설시설 (REMOVE_SNOW, 레이어코드 C9530007) — 14개 필드
CREATE TABLE IF NOT EXISTS gov_remove_snow (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_지점
    direction VARCHAR(1) NOT NULL,  -- 방향
    type VARCHAR(50),  -- 구분
    rs_type VARCHAR(4) NOT NULL,  -- 제설시설 종류
    ins_day VARCHAR(10),  -- 설치일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 35.통로박스 : 통로박스 (PATHWAY, 레이어코드 C9530008) — 17개 필드
CREATE TABLE IF NOT EXISTS gov_pathway (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치
    hor NUMERIC(13,3),  -- 규격_가로
    ver NUMERIC(13,3),  -- 규격_세로
    met VARCHAR(4) NOT NULL,  -- 통로박스 재질
    purpose VARCHAR(50),  -- 설치목적
    pump VARCHAR(4),  -- 배수시설
    eqp_len NUMERIC(13,3),  -- 연장
    ins_day VARCHAR(10),  -- 설치일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 36.생태통로 : 생태통로 (ECO_CORRIDOR, 레이어코드 C9530009) — 17개 필드
CREATE TABLE IF NOT EXISTS gov_eco_corridor (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치
    type VARCHAR(4) NOT NULL,  -- 생태통로 유형
    hor NUMERIC(13,3),  -- 규모_가로(중앙폭)
    ver NUMERIC(13,3),  -- 규모_세로
    len NUMERIC(13,3),  -- 규모_길이
    fac_div VARCHAR(4) NOT NULL,  -- 시설물 현황_구분
    fac_spec VARCHAR(50),  -- 시설물현황_수량(규격)
    ins_day VARCHAR(10),  -- 설치일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 37.긴급제동시설 : 긴급제동시설 (EMERG_ESCAPE, 레이어코드 C9530002) — 17개 필드
CREATE TABLE IF NOT EXISTS gov_emerg_escape (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_지점
    direction VARCHAR(1) NOT NULL,  -- 방향
    eqp_len NUMERIC(13,3),  -- 시설연장
    type VARCHAR(4) NOT NULL,  -- 긴급제동시설 형식
    slope NUMERIC(13,3),  -- 경사
    attached VARCHAR(4) NOT NULL,  -- 긴급제동시설 부속시설
    reduction VARCHAR(4) NOT NULL,  -- 긴급제동시설 감속시설
    ins_day VARCHAR(10),  -- 설치일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 38.과속방지턱 : 과속방지턱 (SPEED_HUMP, 레이어코드 C9530003) — 17개 필드
CREATE TABLE IF NOT EXISTS gov_speed_hump (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_지점
    direction VARCHAR(1) NOT NULL,  -- 방향
    wid NUMERIC(13,3),  -- 규격_폭
    len NUMERIC(13,3),  -- 규격_길이
    hit NUMERIC(13,3),  -- 규격_높이
    kind VARCHAR(4) NOT NULL,  -- 과속방지턱 종류
    material VARCHAR(4) NOT NULL,  -- 과속방지턱 재료
    ins_day VARCHAR(10),  -- 설치일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 39.졸음쉼터 : 졸음쉼터 (SLEEPY_RESTAREA, 레이어코드 C9530004) — 20개 필드
CREATE TABLE IF NOT EXISTS gov_sleepy_restarea (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    direction VARCHAR(1) NOT NULL,  -- 방향
    park_s NUMERIC(7,0),  -- 주차시설_소형
    park_l NUMERIC(7,0),  -- 주차시설_대형
    co_bath NUMERIC(7,0),  -- 편의시설_화장실
    co_ben NUMERIC(7,0),  -- 편의시설_벤치
    co_etc VARCHAR(100),  -- 편의시설_기타
    bus VARCHAR(1),  -- 버스정류장
    eqp_len NUMERIC(13,3),  -- 연장
    ins_day VARCHAR(10),  -- 설치일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 40.실연장 : 실연장 (REALNTH, 레이어코드 A9990011) — 22개 필드
CREATE TABLE IF NOT EXISTS gov_realnth (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    wid_ent NUMERIC(13,3),  -- 폭원_계
    wid_road NUMERIC(13,3),  -- 폭원_차도
    wid_ft_l NUMERIC(13,3),  -- 폭원_길어깨(보도)_좌
    wid_ft_r NUMERIC(13,3),  -- 폭원_길어깨(보도)_우
    wid_set NUMERIC(13,3),  -- 폭원_중앙분리대
    len_ent NUMERIC(13,3),  -- 구성시설별 연장_계
    len_road NUMERIC(13,3),  -- 구성시설별 연장_도로
    len_brdg NUMERIC(13,3),  -- 구성시설별 연장_교량
    len_tunl NUMERIC(13,3),  -- 구성시설별 연장_터널
    len_plaza NUMERIC(13,3),  -- 구성시설별 연장_광장
    len_etc NUMERIC(13,3),  -- 구성시설별 연장_그 밖의 시설
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 41.도로구역 : 도로구역 (LANDUSE, 레이어코드 A9990007) — 16개 필드
CREATE TABLE IF NOT EXISTS gov_landuse (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    address VARCHAR(100),  -- 소재지
    sec_adrs VARCHAR(30),  -- 지번
    purpose VARCHAR(4) NOT NULL,  -- 지목
    inarea NUMERIC(13,3),  -- 면적_저촉면적
    out_area NUMERIC(13,3),  -- 면적_잔여면적
    own_dit VARCHAR(4) NOT NULL,  -- 소유구분
    owner VARCHAR(50),  -- 소유자
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 42.유료도로 : 유료도로 (PAY_ROAD, 레이어코드 A9990008) — 22개 필드
CREATE TABLE IF NOT EXISTS gov_pay_road (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st_no VARCHAR(50),  -- 시점_구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed_no VARCHAR(50),  -- 종점_구간
    sect_ed NUMERIC(13,3),  -- 위치_종점
    len_ent NUMERIC(13,3),  -- 연장_계
    len_road NUMERIC(13,3),  -- 연장_도로
    len_bridge NUMERIC(13,3),  -- 연장_교량
    len_tunnel NUMERIC(13,3),  -- 연장_터널
    len_etc NUMERIC(13,3),  -- 연장_그 밖의 시설
    pay_prd_s VARCHAR(10),  -- 요금징수기간_시작
    pay_prd_e VARCHAR(10),  -- 요금징수기간_종료
    paybooth_n NUMERIC(7,0),  -- 요금징수시설수
    payrec VARCHAR(100),  -- 유료도로 설치 근거
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 43.우회도로 : 우회도로 (DETOUR_ROAD, 레이어코드 A9990009) — 16개 필드
CREATE TABLE IF NOT EXISTS gov_detour_road (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    type VARCHAR(100),  -- 우회도로 종류
    wid NUMERIC(13,3),  -- 우회도로 폭원
    len NUMERIC(13,3),  -- 우회도로의 연장
    main_dest VARCHAR(100),  -- 주요 통과지
    rec_day VARCHAR(10),  -- 지정일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 44.접도구역 : 접도구역 (ROAD_AREA, 레이어코드 A9990010) — 15개 필드
CREATE TABLE IF NOT EXISTS gov_road_area (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치_시점
    sect_ed NUMERIC(13,3),  -- 위치_종점
    ra_len NUMERIC(13,3),  -- 접도구역 지정연장
    mpole_l NUMERIC(7,0),  -- 표주현황_좌
    mpole_r NUMERIC(7,0),  -- 표주현황_우
    rec_day VARCHAR(10),  -- 지정일
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 45.도로점용(점) : 도로점용(점) (OCCUPY_PT, 레이어코드 A9990004) — 18개 필드
CREATE TABLE IF NOT EXISTS gov_occupy_pt (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    op_address VARCHAR(100),  -- 점용자_주소
    op_name VARCHAR(50),  -- 점용자_성명
    op_ssnum VARCHAR(14),  -- 점용자_생년월일
    op_date VARCHAR(30),  -- 허가번호(허가일)
    op_pos VARCHAR(100),  -- 점용위치
    op_aim VARCHAR(100),  -- 점용목적
    op_area NUMERIC(13,3),  -- 점용면적
    op_period VARCHAR(21),  -- 점용기간
    op_desc VARCHAR(4),  -- 점용시설개요
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 46.도로점용(선) : 도로점용(선) (OCCUPY_PL, 레이어코드 A9990005) — 18개 필드
CREATE TABLE IF NOT EXISTS gov_occupy_pl (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    op_address VARCHAR(100),  -- 점용자_주소
    op_name VARCHAR(50),  -- 점용자_성명
    op_ssnum VARCHAR(14),  -- 점용자_생년월일
    op_date VARCHAR(30),  -- 허가번호(허가일)
    op_pos VARCHAR(100),  -- 점용위치
    op_aim VARCHAR(100),  -- 점용목적
    op_area NUMERIC(13,3),  -- 점용면적
    op_period VARCHAR(21),  -- 점용기간
    op_desc VARCHAR(4),  -- 점용시설개요
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 47.도로점용(면) : 도로점용(면) (OCCUPY_PG, 레이어코드 A9990006) — 18개 필드
CREATE TABLE IF NOT EXISTS gov_occupy_pg (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    op_address VARCHAR(100),  -- 점용자_주소
    op_name VARCHAR(50),  -- 점용자_성명
    op_ssnum VARCHAR(14),  -- 점용자_생년월일
    op_date VARCHAR(30),  -- 허가번호(허가일)
    op_pos VARCHAR(100),  -- 점용위치
    op_aim VARCHAR(100),  -- 점용목적
    op_area NUMERIC(13,3),  -- 점용면적
    op_period VARCHAR(21),  -- 점용기간
    op_desc VARCHAR(4),  -- 점용시설개요
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 48.거리표 : 거리표 (KM_POST, 레이어코드 A9990012) — 19개 필드
CREATE TABLE IF NOT EXISTS gov_km_post (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    post_id VARCHAR(16) NOT NULL,  -- 거리표 고유아이디
    up_down VARCHAR(1) NOT NULL,  -- 상하행 구분
    set_place VARCHAR(60),  -- 설치행정구역명칭
    set_date VARCHAR(10),  -- 설치일자
    set_co VARCHAR(50),  -- 설치업체(시공사)
    acc_len NUMERIC(7,0),  -- 도로대장 구간누적거리
    target_des VARCHAR(30),  -- 목적지명
    street_nam NUMERIC(7,0),  -- 목적지명까지 거리
    damage_etc VARCHAR(1) NOT NULL,  -- 손상여부
    delegate VARCHAR(6),  -- 위임국도
    remark VARCHAR(200),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- 49.측점 : 측점 (Station, 레이어코드 A9990013) — 17개 필드
CREATE TABLE IF NOT EXISTS gov_station (
    rdid VARCHAR(27) PRIMARY KEY,  -- 도로대장 공간정보ID
    ufid VARCHAR(50),  -- 공간유일참조아이디
    mco VARCHAR(5) NOT NULL,  -- 관리기관
    road_rank VARCHAR(4) NOT NULL,  -- 도로의종류
    road_name VARCHAR(50) NOT NULL,  -- 노선명
    road_no VARCHAR(4) NOT NULL,  -- 노선번호
    sect VARCHAR(3) NOT NULL,  -- 구간
    sect_st NUMERIC(13,3),  -- 위치-지점
    height NUMERIC(13,3),  -- 측점지반고
    rbl_height NUMERIC(13,3),  -- 도로경계(좌)지반고
    rbr_height NUMERIC(13,3),  -- 도로경계(우)지반고
    rbl_length NUMERIC(13,3),  -- 도로경계(좌)거리
    rbr_length NUMERIC(13,3),  -- 도로경계(우)거리
    superelv_l NUMERIC(13,3),  -- 편경사(좌)
    superelv_r NUMERIC(13,3),  -- 편경사(우)
    remark VARCHAR(50),  -- 비고
    sern VARCHAR(15)  -- 시스템관리ID
);

-- ============================================================
-- 일괄등록(SHP/DBF 업로드) 기능용 마이그레이션: 원본 정의서에는 지오메트리/
-- 관할 시군구 컬럼이 없어(속성 전용 표준) 여기서 전 테이블에 추가한다.
-- 이미 생성되어 있던 DB(CREATE TABLE IF NOT EXISTS가 건너뛰는 경우)에도
-- 안전하게 재적용 가능.
-- ============================================================
ALTER TABLE gov_box_pipe ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_box_pipe ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_bridge ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_bridge ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_climbing_lane ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_climbing_lane ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_cut_slope ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_cut_slope ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_defence ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_defence ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_detour_road ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_detour_road ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_dip_eqp ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_dip_eqp ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_eco_corridor ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_eco_corridor ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_emerg_escape ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_emerg_escape ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_high_road ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_high_road ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_impact ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_impact ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_interchange ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_interchange ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_km_post ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_km_post ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_land_fill ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_land_fill ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_landuse ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_landuse ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_median_strip ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_median_strip ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_nori ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_nori ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_occupy_pg ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_occupy_pg ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_occupy_pl ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_occupy_pl ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_occupy_pt ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_occupy_pt ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_over_checkpoint ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_over_checkpoint ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_overpass ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_overpass ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_pathway ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_pathway ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_pay_road ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_pay_road ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_pipe_conduit ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_pipe_conduit ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_realnth ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_realnth ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_remove_snow ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_remove_snow ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_road_area ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_road_area ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_road_bound ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_road_bound ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_section ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_section ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_side ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_side ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_sign ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_sign ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_signal_lamp ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_signal_lamp ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_sleepy_restarea ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_sleepy_restarea ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_slope ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_slope ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_sound_proofing ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_sound_proofing ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_speed_hump ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_speed_hump ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_station ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_station ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_stone ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_stone ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_stopbay ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_stopbay ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_street_light ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_street_light ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_street_tree ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_street_tree ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_tunnel ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_tunnel ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_under_road ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_under_road ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_under_sidewalk ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_under_sidewalk ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_variable_sigh ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_variable_sigh ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_wall ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_wall ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_xpoint ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_xpoint ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
ALTER TABLE gov_xrail ADD COLUMN IF NOT EXISTS geom JSONB;
ALTER TABLE gov_xrail ADD COLUMN IF NOT EXISTS sigungu_code VARCHAR(5);
