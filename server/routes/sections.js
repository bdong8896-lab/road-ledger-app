// 도로(노선/구간) 단위 도로대장 API — 국토부 표준 "01.도로대장총괄" 개념을
// 반영한 신규 기본 단위. 지도에서 도로망도(LT_L_MOCTLINK) 선분을 클릭해
// 등록하며, RDID를 표준 27자리 규칙으로 자동 채번한다.
const fs = require('fs');
const path = require('path');
const express = require('express');
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/requireAuth');
const { GOV_LAYER_MAP } = require('../lib/govLayerMap');
const SIGN_NAME_CODES = require('../lib/signNameCodes');
const { buildExportZip, buildExportZipMulti } = require('../lib/sectionExport');
const { getTableLabels } = require('../lib/schemaLabels');
const { buildOfficialLedgerZip } = require('../lib/officialLedgerZip');
const { logAction } = require('../lib/auditLog');
const { decodeCode } = require('../lib/govCodebook');

const router = express.Router();

// 국토교통부 「도로대장공간정보 공통입력코드정의서」 03.도로의종류(ROAD_RANK) 공식 코드(1501~1508, 1599).
// ⚠ 1509~1512(면도/리도/농도/도시계획도로)는 공식 코드북(v2.6)에 없는 값이다 —
// 실제로 코드정의서를 재확인함(2026-09-01): 03.도로의종류엔 9개(1501~1508+1599)만
// 있고, 작성지침 PDF도 「도로법」 제10조 적용범위(고속국도~구도)로 못박아
// 도시계획도로는 예시에서도 "기타(1599)"로 편입시킨다. 그럼에도 사용자 요청으로
// 우리 시스템 내부 관리용 비공식 확장 코드로 이 4개를 추가한 것 — 그대로 KRRIS
// 등 외부 표준 시스템에 제출하면 이 4개 코드는 거부되거나 무시될 수 있으므로,
// 실제 제출/납품용 SHP·DBF를 만들 때는 반드시 1599(기타)로 변환해야 한다.
const ROAD_RANK_CODES = {
    '고속국도': '1501', '일반국도': '1502', '특별시도': '1503', '광역시도': '1504',
    '지방도': '1505', '시도': '1506', '군도': '1507', '구도': '1508',
    '면도': '1509', '리도': '1510', '농도': '1511', '도시계획도로': '1512',
    '기타': '1599',
};
// 역방향(코드->이름). gov_* 부속시설 테이블은 국토부 코드(1501~1599)만 저장하고
// 있어서(우리 내부 확장 4개는 저장 안 됨) facility-detail에서 "1507" 같은 값을
// "1507 (군도)"처럼 풀어 보여줄 때 쓴다. govSectionSync.js의 ROAD_RANK_NAME_BY_CODE와
// 같은 패턴 — 거긴 gov_section(도로대장총괄) 동기화용이라 따로 두되 값은 같다.
const ROAD_RANK_NAME_BY_CODE = Object.fromEntries(
    Object.entries(ROAD_RANK_CODES).map(([name, code]) => [code, name])
);

// gov_* 부속시설 테이블의 mco(관리기관 코드)를 풀어 보여주기 위한 표
// (public/data/managing_agencies.json, govSectionSync.js의 getMcoNameByCode와
// 같은 원본). 코드북에 없는 값(예: 납품 DBF의 mco가 실제 공식 코드와 다른 경우
// — govSectionSync.js 주석 참고)이면 그냥 원본 코드만 보여주고 해석을 붙이지 않는다.
let managingAgenciesCache = null;
function getMcoNameByCode(code) {
    if (!managingAgenciesCache) {
        const jsonPath = path.join(__dirname, '..', '..', 'public', 'data', 'managing_agencies.json');
        managingAgenciesCache = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    }
    const found = managingAgenciesCache.find((a) => a.code === code);
    return found ? found.name : null;
}

// 시설물 속성정보 패널(facility-detail)에서 "코드값 (해석)"처럼 접미사로
// 풀어 보여줄 컬럼들 — gov_* 테이블 전체에 공통으로 있는 컬럼명 기준(테이블 무관).
// govCodebook.js(2025_도로대장공간정보_공통입력코드정의서 v2.6)로 대부분의 종류/
// 형식/재질/방향 코드를 해석한다. 코드가 같은 컬럼명이라도 테이블마다 다른
// 의미일 수 있지 않냐 싶지만, 국토부 표준 코드는 숫자 대역 자체가 시설유형별로
// 겹치지 않게 설계돼 있어(예: 표지=18xx, 신호등=41xx, 가로수=36xx) 컬럼명 기준
// 하나의 코드북 테이블(govCodebook)만 참조해도 안전하다. 코드북에도 없는 값은
// null을 돌려줘 "있는 것만 해석"하는 기존 원칙을 유지한다.
function byCode(fieldIdent) {
    return (v) => decodeCode(fieldIdent, v);
}
const FACILITY_ATTR_DECODE = {
    road_rank: (v) => ROAD_RANK_NAME_BY_CODE[v] || null,
    mco: (v) => getMcoNameByCode(v),
    direction: byCode('DIRECTION'),
    sb_kind: byCode('SB_KIND'), sb_name: byCode('SB_NAME'), pole_type: byCode('POLE_TYPE'),
    dun_type: byCode('DUN_TYPE'), dun_mat: byCode('DUN_MAT'),
    lgt_type: byCode('LGT_TYPE'), lgt_wgt: byCode('LGT_WGT'),
    type: byCode('TYPE'), ins_type: byCode('INS_TYPE'),
    st_type: byCode('ST_TYPE'), method: byCode('METHOD'), side_kind: byCode('SIDE_KIND'),
    eqp_kind: byCode('EQP_KIND'), eqp_met: byCode('EQP_MET'), eqp_met1: byCode('EQP_MET1'),
    dip_kind: byCode('DIP_KIND'), dip_met: byCode('DIP_MET'), met: byCode('MET'),
    pump: byCode('PUMP'), purpose: byCode('PURPOSE'), own_dit: byCode('OWN_DIT'),
    grade: byCode('GRADE'), wait: byCode('WAIT'), x_type: byCode('X_TYPE'), uddi: byCode('UDDI'),
    fa_type: byCode('FA_TYPE'), str_level: byCode('STR_LEVEL'), re_dia: byCode('RE_DIA'),
    de_wet: byCode('DE_WET'), in_de: byCode('IN_DE'),
    col_type: byCode('COL_TYPE'), col_mat: byCode('COL_MAT'), pl_type: byCode('PL_TYPE'),
    up_type: byCode('UP_TYPE'), pl_base: byCode('PL_BASE'), edg_type: byCode('EDG_TYPE'),
    fen_mat: byCode('FEN_MAT'), link: byCode('LINK'), edg_base: byCode('EDG_BASE'),
    gy_type: byCode('GY_TYPE'), wing_type: byCode('WING_TYPE'), gy_water: byCode('GY_WATER'),
    per_lane: byCode('PER_LANE'), sep_type: byCode('SEP_TYPE'), sep_len: byCode('SEP_LEN'),
    crs_type: byCode('CRS_TYPE'), cen_type: byCode('CEN_TYPE'), r_s_s_type: byCode('R_S_S_TYPE'),
    sp_type: byCode('SP_TYPE'), met_u: byCode('MET_U'), met_d: byCode('MET_D'),
    drainage: byCode('DRAINAGE'), fl_met: byCode('FL_MET'), ce_met: byCode('CE_MET'),
    sidewall: byCode('SIDEWALL'), al_type: byCode('AL_TYPE'), et_type: byCode('ET_TYPE'),
    sh_u: byCode('SH_U'), sh_d: byCode('SH_D'),
};

const EDITABLE_FIELDS = [
    'route_no', 'route_name', 'sect', 'mco_code', 'mco_name', 's_point', 'e_point',
    'length_m', 'width_m', 'lane_count', 'pavement_type', 'pavement_material',
    'has_sidewalk', 'has_drainage', 'completion_date', 'remarks',
];

// 국토교통부 「도로대장공간정보」 표준 정의서의 부속시설 22종 → 시설물 상세 테이블(gov_*) 매핑.
// 표는 원본 정의서 필드 그대로(server/db/gov_facility_schema.sql)이며, 서로 FK가 아니라
// (road_rank, road_no, sect) 조합(업무키)으로 매칭한다. road_rank는 표준대로 코드값
// (예: 1507=군도)이다 — 예전 버전은 한글 텍스트로 잘못 매칭하고 있었다.
// '교량'은 표준상 부속시설이 아니라 별도 "주요구조물"이지만, 일괄등록 시 딸려오는
// 구조 보고서(PDF)를 지도에서 볼 수 있는 방법이 이 부속시설 마커 시스템(체크박스로
// 지도에 표시 → 클릭하면 첨부파일)뿐이라 여기 같이 포함시켰다.
const FACILITY_TABLE_MAP = {
    '교량': 'gov_bridge',
    '터널': 'gov_tunnel',
    '육교': 'gov_overpass',
    '지하차도': 'gov_under_road',
    '고가도로': 'gov_high_road',
    '인터체인지(IC)': 'gov_interchange',
    '지하보도': 'gov_under_sidewalk',
    '교차시설': 'gov_xrail',
    '오르막차로': 'gov_climbing_lane',
    '정차대': 'gov_stopbay',
    '측구': 'gov_side',
    '석축': 'gov_stone',
    '옹벽': 'gov_wall',
    '도로절개면': 'gov_cut_slope',
    '도로성토면': 'gov_land_fill',
    '배수암거및배수관': 'gov_box_pipe',
    '중앙분리대': 'gov_median_strip',
    '차량방호안전시설': 'gov_defence',
    '낙석방지시설': 'gov_nori',
    '표지': 'gov_sign',
    '전광표지': 'gov_variable_sigh',
    '가로등': 'gov_street_light',
    '신호등': 'gov_signal_lamp',
    '충격흡수시설': 'gov_impact',
    '방음시설': 'gov_sound_proofing',
    '가로수': 'gov_street_tree',
    '지하매설물': 'gov_dip_eqp',
    '과적검문소': 'gov_over_checkpoint',
    '제설시설': 'gov_remove_snow',
    '공동구': 'gov_pipe_conduit',
    '통로박스': 'gov_pathway',
    '생태통로': 'gov_eco_corridor',
    '긴급제동시설': 'gov_emerg_escape',
    '과속방지턱': 'gov_speed_hump',
    '졸음쉼터': 'gov_sleepy_restarea',
};

// 위 35개 테이블 중 실제로 사람이 읽을 수 있는 "명칭" 컬럼이 있는 것만 골라둔
// 매핑. 나머지 테이블엔 "종류" 코드(예: sb_kind, side_kind)만 있고 그건 이
// 시스템에 코드북이 없어 그대로 보여주면 의미 없는 코드값이라 이름으로 쓰지
// 않는다 — 그 경우 지도 마우스오버엔 시설물 종류(label)만 표시된다.
const FACILITY_NAME_FIELD = {
    gov_bridge: 'brdg_name',    // 교량명
    gov_tunnel: 'tun_name',     // 터널명
    gov_overpass: 'op_name',    // 육교명
    gov_under_road: 'ur_name',  // 지하차도명
    gov_high_road: 'hr_name',   // 고가도로명
    gov_interchange: 'ic_name', // IC명
    gov_under_sidewalk: 'us_name', // 지하보도명
    gov_xrail: 'x_name',        // 교차시설명
    gov_defence: 'product',     // 제품명
    gov_impact: 'product',      // 제품명
    gov_sign: 'sb_name',        // 표지 명칭
    gov_pipe_conduit: 'pip_name', // 공동구명
};

// gov_sign.sb_name은 사람이 읽는 이름이 아니라 코드값("403-1" 등)이라, 코드정의서
// 44.표지명칭 표(signNameCodes.js)로 풀어서 보여준다. 코드에 없는 값이면 원본 그대로.
const FACILITY_NAME_DECODE = {
    gov_sign: (code) => SIGN_NAME_CODES[code] || code,
};

router.use(requireAuth);

function outsideJurisdiction(userSigungu, rowSigungu) {
    return !!userSigungu && !!rowSigungu && userSigungu !== rowSigungu;
}

// 선택한 구간(도로등급+노선번호+구간번호)에 해당하는 부속시설 22종 개수.
// sect를 안 주면(데이터보기 트리에서 노선/호선 자체를 선택한 경우) 그 노선의
// 구간 전부를 합산해서 돌려준다. gov_* 테이블은 아직 데이터가 없을 수 있어
// 각 항목은 실패해도 0으로 처리한다. '/:rdid'보다 먼저 등록해야 이 경로가
// rdid로 잘못 매칭되지 않는다.
router.get('/facility-counts', async (req, res) => {
    const roadRankName = (req.query.road_rank_name || '').trim();
    const roadRankCode = ROAD_RANK_CODES[roadRankName];
    const routeNo = (req.query.route_no || '').trim();
    const sect = (req.query.sect || '').trim();
    if (!roadRankCode || !routeNo) return res.json({ counts: {} });

    const where = sect ? 'road_rank = $1 AND road_no = $2 AND sect = $3' : 'road_rank = $1 AND road_no = $2';
    const params = sect ? [roadRankCode, routeNo, sect] : [roadRankCode, routeNo];

    const entries = await Promise.all(
        Object.entries(FACILITY_TABLE_MAP).map(async ([label, table]) => {
            try {
                const { rows } = await pool.query(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, params);
                return [label, Number(rows[0].count)];
            } catch (e) {
                return [label, 0];
            }
        })
    );
    res.json({ counts: Object.fromEntries(entries) });
});

// 선택한 구간을 500m 단위로 미리 끊어둔 조각들(road_sectors, 실측 SHP 적재분)을
// 돌려준다 — 지도에서 노선에 마우스오버했을 때 "지금 가리키는 500m 구간"을
// 찾기 위한 히트테스트용 지오메트리. 아직 500m SHP를 못 받은 노선은 빈 배열을
// 돌려주고, 그 경우 프론트는 예전처럼 구간 전체 합계 표시로 자연히 되돌아간다.
router.get('/sectors', async (req, res) => {
    const roadRankName = (req.query.road_rank_name || '').trim();
    const roadRankCode = ROAD_RANK_CODES[roadRankName];
    const routeNo = (req.query.route_no || '').trim();
    const sect = (req.query.sect || '').trim();
    if (!roadRankCode || !routeNo) return res.json({ sectors: [] });

    const where = sect ? 'road_rank_code = $1 AND road_no = $2 AND sect = $3' : 'road_rank_code = $1 AND road_no = $2';
    const params = sect ? [roadRankCode, routeNo, sect] : [roadRankCode, routeNo];
    const { rows } = await pool.query(
        `SELECT sect, sect_st, sect_ed, geom FROM road_sectors WHERE ${where} ORDER BY sect, sect_st`,
        params
    );
    res.json({ sectors: rows });
});

// road_sectors와 같은 500m 경계(0.0~0.5, 0.5~1.0, ...)로 부속시설 개수를 미리
// 다 묶어서 한 번에 돌려준다(구간마다/시설물종류마다 마우스오버할 때마다
// 새로 조회하면 너무 잦아서, facility-counts처럼 노선 선택 시점에 한 번만
// 받아 캐시해두고 쓴다). 시설물의 sect_st(위치)를 0.5로 나눈 몫으로 버킷팅 —
// 구간을 걸치는 시설물(예: 옹벽처럼 sect_st~sect_ed가 있는 것)은 시작점
// 기준으로만 한 버킷에 넣는다(정밀한 안분은 하지 않음). sect_st 컬럼이 없는
// 테이블(예: 도로구역)은 조용히 건너뛴다.
router.get('/facility-counts-by-sector', async (req, res) => {
    const roadRankName = (req.query.road_rank_name || '').trim();
    const roadRankCode = ROAD_RANK_CODES[roadRankName];
    const routeNo = (req.query.route_no || '').trim();
    const sect = (req.query.sect || '').trim();
    if (!roadRankCode || !routeNo) return res.json({ buckets: {} });

    const where = sect ? 'road_rank = $1 AND road_no = $2 AND sect = $3' : 'road_rank = $1 AND road_no = $2';
    const params = sect ? [roadRankCode, routeNo, sect] : [roadRankCode, routeNo];

    const buckets = {};
    await Promise.all(
        Object.entries(FACILITY_TABLE_MAP).map(async ([label, table]) => {
            try {
                const { rows } = await pool.query(
                    `SELECT FLOOR(sect_st / 0.5) * 0.5 AS bucket, COUNT(*) AS cnt
                     FROM ${table} WHERE ${where} AND sect_st IS NOT NULL GROUP BY bucket`,
                    params
                );
                for (const row of rows) {
                    const key = Number(row.bucket).toFixed(1);
                    if (!buckets[key]) buckets[key] = {};
                    buckets[key][label] = Number(row.cnt);
                }
            } catch (e) {
                // sect_st 컬럼이 없는 테이블 등 — 이 항목은 버킷 분해를 못 하니 건너뛴다.
            }
        })
    );
    res.json({ buckets });
});

// 선택한 구간에 속한 부속시설 22종의 지오메트리(있는 것만) — 지도에 개별
// 시설물을 표시하기 위함. facility-counts와 같은 업무키로 조회한다.
// '/:rdid'보다 먼저 등록해야 한다.
router.get('/facility-geoms', async (req, res) => {
    const roadRankCode = ROAD_RANK_CODES[(req.query.road_rank_name || '').trim()];
    const routeNo = (req.query.route_no || '').trim();
    const sect = (req.query.sect || '').trim();
    if (!roadRankCode || !routeNo) return res.json({ items: [] });

    const where = sect
        ? 'road_rank = $1 AND road_no = $2 AND sect = $3 AND geom IS NOT NULL'
        : 'road_rank = $1 AND road_no = $2 AND geom IS NOT NULL';
    const params = sect ? [roadRankCode, routeNo, sect] : [roadRankCode, routeNo];

    const perTable = await Promise.all(
        Object.entries(FACILITY_TABLE_MAP).map(async ([label, table]) => {
            const nameField = FACILITY_NAME_FIELD[table];
            const nameCol = nameField ? `${nameField} AS facility_name` : 'NULL AS facility_name';
            try {
                const { rows } = await pool.query(
                    `SELECT rdid, geom, ${nameCol} FROM ${table} WHERE ${where}`,
                    params
                );
                const decode = FACILITY_NAME_DECODE[table];
                return rows.map((r) => ({
                    label, table, rdid: r.rdid, geom: r.geom,
                    name: r.facility_name ? (decode ? decode(r.facility_name) : r.facility_name) : null,
                }));
            } catch (e) {
                return [];
            }
        })
    );
    res.json({ items: perTable.flat() });
});

// 특정 시설물 종류(라벨)의 첨부파일(사진/보고서) 목록. 일괄등록 시 자동
// 연결된 gov_facility_files를 조회한다. '/:rdid'보다 먼저 등록해야 한다.
router.get('/facility-files', async (req, res) => {
    // 지도에서 개별 시설물 마커를 클릭했을 때 쓰는 모드 — 그 시설물 하나의
    // 첨부파일만 조회한다(구간 전체 라벨 조회와 달리 업무키 조회가 필요 없음).
    const singleTable = (req.query.table || '').trim();
    const singleFacilityRdid = (req.query.facility_rdid || '').trim();
    if (singleTable && singleFacilityRdid) {
        const userSigungu = req.session.user.sigunguCode;
        const { rows } = await pool.query(
            `SELECT id, facility_rdid, file_kind, original_name, uploaded_at, sigungu_code
             FROM gov_facility_files WHERE facility_table = $1 AND facility_rdid = $2
             ORDER BY uploaded_at DESC`,
            [singleTable, singleFacilityRdid]
        );
        const files = rows.filter((f) => !outsideJurisdiction(userSigungu, f.sigungu_code));
        return res.json({ files });
    }

    const label = (req.query.label || '').trim();
    const table = FACILITY_TABLE_MAP[label];
    const roadRankCode = ROAD_RANK_CODES[(req.query.road_rank_name || '').trim()];
    const routeNo = (req.query.route_no || '').trim();
    const sect = (req.query.sect || '').trim();
    if (!table || !roadRankCode || !routeNo) return res.json({ files: [] });

    // sect가 없으면(노선 자체를 선택한 경우) 그 노선의 구간 전부에서 찾는다.
    const where = sect ? 'road_rank = $1 AND road_no = $2 AND sect = $3' : 'road_rank = $1 AND road_no = $2';
    const params = sect ? [roadRankCode, routeNo, sect] : [roadRankCode, routeNo];
    let rdids;
    try {
        const { rows } = await pool.query(`SELECT rdid FROM ${table} WHERE ${where}`, params);
        rdids = rows.map((r) => r.rdid);
    } catch (e) {
        return res.json({ files: [] });
    }
    if (!rdids.length) return res.json({ files: [] });

    const userSigungu = req.session.user.sigunguCode;
    const { rows } = await pool.query(
        `SELECT id, facility_table, facility_rdid, file_kind, original_name, uploaded_at, sigungu_code
         FROM gov_facility_files WHERE facility_table = $1 AND facility_rdid = ANY($2)
         ORDER BY uploaded_at DESC`,
        [table, rdids]
    );
    const files = rows.filter((f) => !outsideJurisdiction(userSigungu, f.sigungu_code));
    res.json({ files });
});

// table 이름 -> {pkColumn, koreanName}. facility-detail이 임의 테이블명을 그대로
// SQL에 꽂지 않고 GOV_LAYER_MAP에 실제로 존재하는 테이블인지부터 검증하는 데 쓴다.
const TABLE_TO_LAYERDEF = Object.fromEntries(
    Object.values(GOV_LAYER_MAP).map((l) => [l.table, l])
);
// table 이름 -> FACILITY_TABLE_MAP의 한글 라벨(예: gov_sign -> "표지"). 부속시설
// 그리드에서 쓰는 것과 같은 라벨을 속성정보 패널 제목에도 그대로 쓰기 위함.
const TABLE_TO_FACILITY_LABEL = Object.fromEntries(
    Object.entries(FACILITY_TABLE_MAP).map(([label, table]) => [table, label])
);

// 시설물 하나(table+facility_rdid)의 지오메트리+속성 전체. 도면뷰어 부속시설
// 파일 목록에서 파일을 클릭했을 때 "해당 위치로 이동" + "속성정보 표시"에 쓴다.
// '/:rdid'보다 먼저 등록해야 한다.
router.get('/facility-detail', async (req, res) => {
    const table = (req.query.table || '').trim();
    const facilityRdid = (req.query.facility_rdid || '').trim();
    const layerDef = TABLE_TO_LAYERDEF[table];
    if (!layerDef || !facilityRdid) return res.json({ record: null });

    const { rows } = await pool.query(
        `SELECT * FROM ${table} WHERE ${layerDef.pkColumn} = $1`,
        [facilityRdid]
    );
    const row = rows[0];
    if (!row) return res.json({ record: null });
    if (outsideJurisdiction(req.session.user.sigunguCode, row.sigungu_code)) {
        return res.json({ record: null });
    }

    const nameField = FACILITY_NAME_FIELD[table];
    const decode = FACILITY_NAME_DECODE[table];
    const rawName = nameField ? row[nameField] : null;
    const name = rawName ? (decode ? decode(rawName) : rawName) : null;

    const labels = getTableLabels(table);
    const SKIP_FIELDS = new Set(['geom', 'sigungu_code', layerDef.pkColumn]);
    const attributes = Object.entries(row)
        .filter(([k, v]) => !SKIP_FIELDS.has(k) && v !== null && v !== '')
        .map(([k, v]) => {
            if (k === nameField) return { key: k, label: labels[k] || k, value: name };
            const attrDecode = FACILITY_ATTR_DECODE[k];
            const decoded = attrDecode ? attrDecode(v) : null;
            return { key: k, label: labels[k] || k, value: decoded ? `${v} (${decoded})` : v };
        });

    res.json({
        record: {
            table, rdid: row[layerDef.pkColumn],
            label: TABLE_TO_FACILITY_LABEL[table] || layerDef.koreanName,
            name, geom: row.geom, attributes,
        },
    });
});

router.get('/facility-files/:id', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM gov_facility_files WHERE id = $1', [req.params.id]);
    const file = rows[0];
    if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    if (outsideJurisdiction(req.session.user.sigunguCode, file.sigungu_code)) {
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }
    if (!fs.existsSync(file.stored_path)) {
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }
    if (req.query.inline === '1') {
        const encodedName = encodeURIComponent(file.original_name);
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodedName}`);
        res.sendFile(path.resolve(file.stored_path));
    } else {
        res.download(file.stored_path, file.original_name);
    }
});

// RDID(27자리) 자동 채번: R01(총괄) + 도로등급코드(4) + 관리기관코드(5)
// + 노선번호(4) + 구간번호(3) + 부여연도(4) + 일련번호(4)
async function generateRdid(roadRankCode, mcoCode, routeNo, sect) {
    const year = String(new Date().getFullYear());
    const mco = (mcoCode || '').padStart(5, '0').slice(0, 5);
    const rno = (routeNo || '').padStart(4, '0').slice(0, 4);
    const sc = (sect || '').padStart(3, '0').slice(0, 3);
    const seqKey = `${roadRankCode}${mco}${rno}${sc}${year}`;

    const { rows } = await pool.query(
        `INSERT INTO road_sections_rdid_seq (seq_key, last_no) VALUES ($1, 1)
         ON CONFLICT (seq_key) DO UPDATE SET last_no = road_sections_rdid_seq.last_no + 1
         RETURNING last_no`,
        [seqKey]
    );
    const serial = String(rows[0].last_no).padStart(4, '0');
    return `R01${roadRankCode}${mco}${rno}${sc}${year}${serial}`;
}

// 노선 검색(검색보기 탭 '노선' 카테고리) — 예전엔 VWorld 전국 도로망도(LT_L_MOCTLINK)를
// 정확일치로만 검색했는데, 실제로 등록/일괄등록된 우리 시스템의 노선명을 부분검색하는
// 방식으로 바꿨다. '/:rdid'보다 먼저 등록해야 한다.
router.get('/search', async (req, res) => {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const size = Math.min(50, Math.max(1, parseInt(req.query.size, 10) || 20));
    if (!q) return res.json({ total: 0, totalPages: 1, items: [] });

    const userSigungu = req.session.user.sigunguCode;
    const { rows } = await pool.query(
        `SELECT rdid, road_rank_code, road_rank_name, route_no, route_name, sect,
                s_point, e_point, length_m, sigungu_code
         FROM road_sections
         WHERE route_name ILIKE $1
         ORDER BY road_rank_code, route_no NULLS LAST, sect NULLS LAST`,
        [`%${q}%`]
    );
    const visible = rows.filter((r) => !outsideJurisdiction(userSigungu, r.sigungu_code));
    const total = visible.length;
    const totalPages = Math.max(1, Math.ceil(total / size));
    const items = visible.slice((page - 1) * size, page * size);
    res.json({ total, totalPages, items });
});

// 데이터보기 트리: 도로등급 > 노선(노선번호/노선명) 순으로 그룹핑 (관할 시군구만)
router.get('/tree', async (req, res) => {
    const userSigungu = req.session.user.sigunguCode;
    const { rows } = await pool.query(
        `SELECT rdid, road_rank_code, road_rank_name, route_no, route_name, sect,
                s_point, e_point, length_m, sigungu_code
         FROM road_sections
         ORDER BY road_rank_code, route_no NULLS LAST, sect NULLS LAST`
    );
    const visible = rows.filter((r) => !outsideJurisdiction(userSigungu, r.sigungu_code));

    const gradeMap = new Map();
    for (const row of visible) {
        if (!gradeMap.has(row.road_rank_name)) gradeMap.set(row.road_rank_name, new Map());
        const routeMap = gradeMap.get(row.road_rank_name);
        const routeKey = row.route_no || row.route_name || '(미지정)';
        if (!routeMap.has(routeKey)) {
            routeMap.set(routeKey, { route_no: row.route_no, route_name: row.route_name, sections: [] });
        }
        routeMap.get(routeKey).sections.push({
            rdid: row.rdid, sect: row.sect, s_point: row.s_point, e_point: row.e_point, length_m: row.length_m,
        });
    }

    const tree = [...gradeMap.entries()].map(([road_grade, routeMap]) => ({
        road_grade,
        routes: [...routeMap.values()],
    }));
    res.json({ tree });
});

// 등록된 전체 구간의 지오메트리 — 좌측 툴바 "전체보기" 버튼이 지도를 등록된
// 노선 전체 범위로 한 번에 맞추는 데 쓴다. '/:rdid'보다 먼저 등록해야 한다.
router.get('/all-geoms', async (req, res) => {
    const userSigungu = req.session.user.sigunguCode;
    const { rows } = await pool.query(
        'SELECT rdid, geom, sigungu_code FROM road_sections WHERE geom IS NOT NULL'
    );
    const visible = rows.filter((r) => !outsideJurisdiction(userSigungu, r.sigungu_code));
    res.json({ items: visible.map((r) => ({ rdid: r.rdid, geom: r.geom })) });
});

// 조서/전체자료 다운로드 공용: 좌측 트리에서 무엇을 선택했느냐에 따라 범위를
// 3단계로 좁힌다 — 구간을 선택했으면(rdid) 그 구간 하나만, 구간 없이 호선만
// 선택했으면(roadGrade+routeNo) 그 호선의 구간 전부, 아무것도 선택 안 했으면
// 로그인 계정의 관할 전체. road_grade는 road_sections.road_rank_name과
// 같은 값(데이터보기 트리가 그 컬럼으로 묶은 것 그대로 route_no와 함께
// 돌려주는 값, script.js의 currentRoute 참고)이라 road_rank_code 없이도
// 정확히 매칭된다. rdid/호선 범위도 관할 밖 구간은 조용히 걸러낸다(다른
// 시군 rdid를 직접 넣어 우회하는 것 방지).
async function resolveScopedSections(userSigungu, { rdid, roadGrade, routeNo, routeName }) {
    if (rdid) {
        const { rows } = await pool.query('SELECT * FROM road_sections WHERE rdid = $1', [rdid]);
        return rows.filter((r) => !outsideJurisdiction(userSigungu, r.sigungu_code));
    }
    if (roadGrade && routeNo) {
        const { rows } = await pool.query(
            `SELECT * FROM road_sections WHERE road_rank_name = $1 AND route_no = $2
             ORDER BY sect NULLS LAST`,
            [roadGrade, routeNo]
        );
        return rows.filter((r) => !outsideJurisdiction(userSigungu, r.sigungu_code));
    }
    const scopedWhere = userSigungu ? 'WHERE sigungu_code = $1 OR sigungu_code IS NULL' : '';
    const scopedParams = userSigungu ? [userSigungu] : [];
    const { rows } = await pool.query(
        `SELECT * FROM road_sections ${scopedWhere}
         ORDER BY road_rank_code, route_no NULLS LAST, sect NULLS LAST`,
        scopedParams
    );
    return rows;
}

function scopeParamsFromQuery(q) {
    return { rdid: q.rdid || '', roadGrade: q.road_grade || '', routeNo: q.route_no || '', routeName: q.route_name || '' };
}

// 범위(구간 하나/호선 전체/관할 전체)에 맞는 파일명 라벨을 만든다 — 조서와
// 전체자료 다운로드가 같은 이름 규칙을 쓴다.
function scopeLabel(sections, { rdid, roadGrade, routeNo }, sigunguName) {
    if (rdid) {
        const s = sections[0];
        return s ? `${s.route_name || s.rdid}_${s.sect ? s.sect + '구간' : s.rdid}` : rdid;
    }
    if (roadGrade && routeNo) {
        const routeName = sections[0] ? sections[0].route_name : '';
        return `${roadGrade}${routeName ? '_' + routeName : ''}`;
    }
    return sigunguName || '전체';
}

// 도로대장 조서(엑셀) 다운로드 — 국토부 표준서식(구간 하나 = 워크북 하나,
// officialLedgerZip.js)으로 만들어 zip 하나로 묶어 내려준다(사람이 결재·
// 보고용으로 바로 여는 문서, GIS 포맷인 SHP/DBF 내보내기(/export)와는 별개).
// '/:rdid'보다 먼저 등록해야 한다. 예전엔 평범한 표 시트로 된 워크북
// 하나였다(buildLedgerReportWorkbook, ledgerReport.js) — 시설물별 시트를
// 서식화하기 전까지는 그쪽 코드를 참고용으로 남겨둔다.
router.get('/ledger-report', async (req, res) => {
    try {
        const scope = scopeParamsFromQuery(req.query);
        const sections = await resolveScopedSections(req.session.user.sigunguCode, scope);
        if (!sections.length) return res.status(404).json({ error: '조서를 만들 구간을 찾을 수 없습니다.' });
        const zipBuffer = await buildOfficialLedgerZip(sections);
        const label = scopeLabel(sections, scope, req.session.user.sigunguName);
        const filename = `${label}_도로대장_${new Date().toISOString().slice(0, 10)}.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
        res.send(zipBuffer);
    } catch (e) {
        res.status(500).json({ error: `조서 생성 중 오류가 발생했습니다: ${e.message}` });
    }
});

// 전체자료(SHP/DBF/사진/보고서/도면) 다운로드 — /ledger-report와 같은 3단계
// 범위 규칙(구간/호선/관할)을 쓴다. 구간이 하나뿐이면 폴더 없이 바로
// LAYER/ETC 구조로(buildExportZip), 여럿이면 구간마다 폴더를 나눠 하나의
// zip으로 묶는다(buildExportZipMulti). '/:rdid'보다 먼저 등록해야 한다.
router.get('/export', async (req, res) => {
    try {
        const scope = scopeParamsFromQuery(req.query);
        const sections = await resolveScopedSections(req.session.user.sigunguCode, scope);
        if (!sections.length) return res.status(404).json({ error: '내보낼 구간을 찾을 수 없습니다.' });
        const label = scopeLabel(sections, scope, req.session.user.sigunguName);
        const result = sections.length === 1
            ? await buildExportZip(sections[0].rdid)
            : await buildExportZipMulti(sections, label);
        if (!result) return res.status(404).json({ error: '내보낼 구간을 찾을 수 없습니다.' });
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
        res.send(result.zipBuffer);
    } catch (e) {
        res.status(500).json({ error: `내보내기 중 오류가 발생했습니다: ${e.message}` });
    }
});

router.get('/:rdid', async (req, res) => {
    const { rdid } = req.params;
    const { rows } = await pool.query('SELECT * FROM road_sections WHERE rdid = $1', [rdid]);
    const record = rows[0];
    if (!record) return res.json({ record: null });
    if (outsideJurisdiction(req.session.user.sigunguCode, record.sigungu_code)) {
        return res.json({ record: null });
    }
    res.json({ record });
});

// 도로망도(LT_L_MOCTLINK) 선분을 클릭해 새 구간을 등록한다.
// road_rank_name, route_name, geom, link_id는 VWorld 속성에서 자동으로 채워 보내고,
// 관리기관/노선번호/구간번호 등은 사용자가 입력한 값을 그대로 받는다.
router.post('/', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const roadRankName = (body.road_rank_name || '').trim();
    const roadRankCode = ROAD_RANK_CODES[roadRankName];
    if (!roadRankCode) {
        return res.status(400).json({ error: `알 수 없는 도로등급입니다: ${roadRankName}` });
    }
    const userId = req.session.user.id;
    const userSigungu = req.session.user.sigunguCode;

    // 이미 같은 업무키(도로등급+관리기관+노선번호+구간번호)로 등록된 구간이 있으면
    // 막는다. 일괄등록은 RDID가 DBF에 이미 들어있어서 그 업무키로 upsert하니
    // 중복이 안 생기지만(govSectionSync.js), 이 수동 등록 경로는 매번 RDID를
    // 새로 채번해서 그냥 INSERT만 했었다 — 그래서 완전히 같은 정보를 다시
    // 저장할 때마다 RDID만 다른 중복 행이 계속 쌓이는 문제가 있었다.
    if (body.mco_code && body.route_no && body.sect) {
        const dup = await pool.query(
            `SELECT rdid FROM road_sections
             WHERE road_rank_code = $1 AND mco_code = $2 AND route_no = $3 AND sect = $4`,
            [roadRankCode, body.mco_code, body.route_no, body.sect]
        );
        if (dup.rows.length) {
            return res.status(409).json({
                error: `이미 같은 도로등급/관리기관/노선번호/구간번호로 등록된 구간이 있습니다(RDID: ${dup.rows[0].rdid}). 데이터보기에서 그 구간을 찾아 수정하세요.`,
                existingRdid: dup.rows[0].rdid,
            });
        }
    }

    const rdid = await generateRdid(roadRankCode, body.mco_code, body.route_no, body.sect);

    const columns = [
        'rdid', 'road_rank_code', 'road_rank_name', ...EDITABLE_FIELDS,
        'geom', 'link_ids', 'sigungu_code', 'created_by', 'updated_by',
    ];
    const values = [
        rdid, roadRankCode, roadRankName,
        ...EDITABLE_FIELDS.map((f) => (body[f] === undefined ? null : body[f])),
        body.geom ? JSON.stringify(body.geom) : null,
        body.link_ids || null,
        userSigungu || null, userId, userId,
    ];
    const placeholders = columns.map((_, i) => `$${i + 1}`);

    const { rows } = await pool.query(
        `INSERT INTO road_sections (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
        values
    );
    const record = rows[0];
    // govSectionSync.js가 ROAD_RANK_CODES를 얻으려고 이 파일을 거꾸로 require하므로,
    // 여기서 최상단에 require하면 순환참조로 로딩 시점에 깨진다 — 핸들러 안에서
    // (모듈 로딩이 끝난 뒤) 지연 require한다.
    const { syncGovSectionFromRoadSection } = require('../lib/govSectionSync');
    await syncGovSectionFromRoadSection(pool, record);
    await logAction(null, {
        action: 'create', targetTable: 'road_sections', targetId: record.rdid,
        summary: `구간 등록: ${record.road_rank_name} ${record.route_no || ''} ${record.route_name || ''} ${record.sect || ''}구간`.replace(/\s+/g, ' ').trim(),
        detail: { after: record },
        sigunguCode: userSigungu, user: req.session.user,
    });
    res.status(201).json({ record });
});

router.put('/:rdid', requireAdmin, async (req, res) => {
    const { rdid } = req.params;
    const existing = await pool.query('SELECT * FROM road_sections WHERE rdid = $1', [rdid]);
    if (existing.rows.length === 0) return res.status(404).json({ error: '구간을 찾을 수 없습니다.' });
    const before = existing.rows[0];
    if (outsideJurisdiction(req.session.user.sigunguCode, before.sigungu_code)) {
        return res.status(403).json({ error: '관할 시군구 밖의 구간입니다.' });
    }

    const body = req.body || {};
    const userId = req.session.user.id;
    const setClauses = EDITABLE_FIELDS.map((f, i) => `${f} = $${i + 2}`);
    const values = [rdid, ...EDITABLE_FIELDS.map((f) => (body[f] === undefined ? null : body[f]))];

    const { rows } = await pool.query(
        `UPDATE road_sections SET ${setClauses.join(', ')}, updated_by = $${values.length + 1}, updated_at = now()
         WHERE rdid = $1 RETURNING *`,
        [...values, userId]
    );
    const record = rows[0];
    const { syncGovSectionFromRoadSection } = require('../lib/govSectionSync');
    await syncGovSectionFromRoadSection(pool, record);
    // 실제로 값이 바뀐 필드만 detail에 남긴다 — 편집 폼을 열었다 그대로 저장만
    // 눌러도 매번 전체 필드가 로그에 쌓이는 걸 막기 위함.
    const changed = {};
    for (const f of EDITABLE_FIELDS) {
        if (String(before[f] ?? '') !== String(record[f] ?? '')) changed[f] = { from: before[f], to: record[f] };
    }
    await logAction(null, {
        action: 'update', targetTable: 'road_sections', targetId: rdid,
        summary: `구간 수정: ${record.road_rank_name} ${record.route_no || ''} ${record.route_name || ''} ${record.sect || ''}구간 (${Object.keys(changed).length}개 필드 변경)`.replace(/\s+/g, ' ').trim(),
        detail: { changed },
        sigunguCode: before.sigungu_code, user: req.session.user,
    });
    res.json({ record });
});

// 구간 삭제는 관리자만 — 프론트의 "관리자 모드"는 UI 노출만 제어할 뿐,
// 실제 권한은 여기서 강제해야 한다(그렇지 않으면 일반 계정도 API를 직접
// 호출해 삭제할 수 있음).
// 구간을 지우면 거기 딸린 자료도 다 같이 지운다 — route_files(도면 등),
// 일괄등록으로 들어온 gov_* 시설물 상세 레코드(업무키: road_rank/road_no/sect
// 일치), 그 시설물에 연결된 gov_facility_files(사진/보고서)까지 전부.
// gov_road_bound만 road_rank 컬럼이 없어(구조가 다름) road_no+sect로만 매칭한다.
router.delete('/:rdid', requireAdmin, async (req, res) => {
    const { rdid } = req.params;
    const { rows } = await pool.query(
        'SELECT sigungu_code, road_rank_code, road_rank_name, route_no, route_name, sect FROM road_sections WHERE rdid = $1',
        [rdid]
    );
    const section = rows[0];
    if (!section) return res.status(404).json({ error: '구간을 찾을 수 없습니다.' });
    if (outsideJurisdiction(req.session.user.sigunguCode, section.sigungu_code)) {
        return res.status(403).json({ error: '관할 시군구 밖의 구간입니다.' });
    }

    const client = await pool.connect();
    const filesToUnlink = [];
    const deletedCounts = {};
    try {
        await client.query('BEGIN');

        const routeFileRows = await client.query(
            'SELECT stored_path FROM route_files WHERE section_rdid = $1',
            [rdid]
        );
        filesToUnlink.push(...routeFileRows.rows.map((r) => r.stored_path));
        if (routeFileRows.rows.length) deletedCounts.route_files = routeFileRows.rows.length;
        await client.query('DELETE FROM route_files WHERE section_rdid = $1', [rdid]);

        for (const { table, pkColumn } of Object.values(GOV_LAYER_MAP)) {
            const hasRoadRank = table !== 'gov_road_bound';
            const where = hasRoadRank
                ? 'road_rank = $1 AND road_no = $2 AND sect = $3'
                : 'road_no = $1 AND sect = $2';
            const params = hasRoadRank
                ? [section.road_rank_code, section.route_no, section.sect]
                : [section.route_no, section.sect];

            let pkRows;
            try {
                pkRows = await client.query(`SELECT ${pkColumn} FROM ${table} WHERE ${where}`, params);
            } catch (e) {
                continue; // 테이블에 해당 컬럼이 없는 등 예외 케이스는 건너뜀
            }
            const pks = pkRows.rows.map((r) => r[pkColumn]);
            if (pks.length) {
                deletedCounts[table] = pks.length;
                const attFileRows = await client.query(
                    'SELECT stored_path FROM gov_facility_files WHERE facility_table = $1 AND facility_rdid = ANY($2)',
                    [table, pks]
                );
                filesToUnlink.push(...attFileRows.rows.map((r) => r.stored_path));
                await client.query(
                    'DELETE FROM gov_facility_files WHERE facility_table = $1 AND facility_rdid = ANY($2)',
                    [table, pks]
                );
                await client.query(`DELETE FROM ${table} WHERE ${where}`, params);
            }
        }

        await client.query('DELETE FROM road_sections WHERE rdid = $1', [rdid]);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: `삭제 중 오류가 발생했습니다: ${e.message}` });
    } finally {
        client.release();
    }

    for (const p of filesToUnlink) fs.promises.unlink(p).catch(() => {});
    await logAction(null, {
        action: 'delete', targetTable: 'road_sections', targetId: rdid,
        summary: `구간 삭제: ${section.road_rank_name} ${section.route_no || ''} ${section.route_name || ''} ${section.sect || ''}구간 (부속시설 ${Object.values(deletedCounts).reduce((a, b) => a + b, 0)}건 함께 삭제)`.replace(/\s+/g, ' ').trim(),
        detail: { section, deletedCounts },
        sigunguCode: section.sigungu_code, user: req.session.user,
    });
    res.json({ ok: true });
});

module.exports = router;
module.exports.ROAD_RANK_CODES = ROAD_RANK_CODES;
