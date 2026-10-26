// 도로(노선/구간) 단위 도로대장 API — 국토부 표준 "01.도로대장총괄" 개념을
// 반영한 신규 기본 단위. 지도에서 도로망도(LT_L_MOCTLINK) 선분을 클릭해
// 등록하며, RDID를 표준 27자리 규칙으로 자동 채번한다.
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/requireAuth');
const { GOV_LAYER_MAP } = require('../lib/govLayerMap');
const SIGN_NAME_CODES = require('../lib/signNameCodes');
const { sendInlineSafely } = require('../lib/safeInline');
const { streamExportZip, exportFilename } = require('../lib/sectionExport');
const { getTableLabels } = require('../lib/schemaLabels');
const { buildOfficialLedgerZip, buildSectionWorkbook } = require('../lib/officialLedgerZip');
const { logAction } = require('../lib/auditLog');
const { ROAD_RANK_CODES, ROAD_RANK_NAME_BY_CODE } = require('../lib/roadRank');
const { deleteSection } = require('../lib/sectionDelete');
const { searchFacilities } = require('../lib/facilitySearch');
const { facilityFilesDir, deletedFacilityDir } = require('../lib/uploadPaths');
const { getThumbPath, IMAGE_RE } = require('../lib/thumbnail');
const { decodeCode } = require('../lib/govCodebook');

const router = express.Router();

// 도로의종류 코드표와 면도/리도/농도/도시계획도로 처리 방침은 lib/roadRank.js 참고
// (저장 코드는 1599, 이름만 구분 — KRRIS 규격 외 코드 1509~1512는 쓰지 않는다).
// 도로종류 이름 → 저장 코드. 같은 이름이라도 코드가 다를 수 있다(납품 코드가 1599인 노선을 "면도"로 보이게 해 둔 경우,
// 화면 이름은 면도지만 코드는 1599). 그래서 등록된 구간(road_sections)에서 이름+노선번호로 실제 코드를 먼저 찾고,
// 없으면 기본 코드표(ROAD_RANK_CODES)를 쓴다.
async function rankCodeFor(roadRankName, routeNo, user) {
    const name = String(roadRankName || '').trim();
    const no = String(routeNo || '').trim();
    if (name && no) {
        // 도로종류+노선번호는 시군구마다 겹칠 수 있다 — 관할이 있는 계정은 자기 관할의 구간에서 먼저 찾는다.
        const params = [name, no];
        let scope = '';
        if (user && user.sigunguCode) { params.push(user.sigunguCode); scope = ' AND (sigungu_code = $3 OR sigungu_code IS NULL)'; }
        const { rows } = await pool.query(
            `SELECT road_rank_code FROM road_sections WHERE road_rank_name = $1 AND route_no = $2${scope} LIMIT 1`, params
        );
        if (rows[0]) return rows[0].road_rank_code;
    }
    return ROAD_RANK_CODES[name];
}

// (도로종류, 노선번호, 구간) 업무키는 시군구마다 같은 값이 있을 수 있다(예: 장성 군도 8호선 1구간과 화성 군도 8호선 1구간).
// 관할이 있는 계정은 자기 관할의 시설물만 보도록 where에 시군구 조건을 붙인다(없으면 전체 권한이라 그대로).
function withJurisdiction(user, where, params) {
    if (!user || !user.sigunguCode) return where;
    params.push(user.sigunguCode);
    return `${where} AND (sigungu_code = $${params.length} OR sigungu_code IS NULL)`;
}

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
    const roadRankCode = await rankCodeFor(roadRankName, req.query.route_no, req.session.user);
    const routeNo = (req.query.route_no || '').trim();
    const sect = (req.query.sect || '').trim();
    if (!roadRankCode || !routeNo) return res.json({ counts: {} });

    let where = sect ? 'road_rank = $1 AND road_no = $2 AND sect = $3' : 'road_rank = $1 AND road_no = $2';
    const params = sect ? [roadRankCode, routeNo, sect] : [roadRankCode, routeNo];
    where = withJurisdiction(req.session.user, where, params);

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
    const roadRankCode = await rankCodeFor(roadRankName, req.query.route_no, req.session.user);
    const routeNo = (req.query.route_no || '').trim();
    const sect = (req.query.sect || '').trim();
    if (!roadRankCode || !routeNo) return res.json({ sectors: [] });

    let where = sect ? 'road_rank_code = $1 AND road_no = $2 AND sect = $3' : 'road_rank_code = $1 AND road_no = $2';
    const params = sect ? [roadRankCode, routeNo, sect] : [roadRankCode, routeNo];
    where = withJurisdiction(req.session.user, where, params);
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
    const roadRankCode = await rankCodeFor(roadRankName, req.query.route_no, req.session.user);
    const routeNo = (req.query.route_no || '').trim();
    const sect = (req.query.sect || '').trim();
    if (!roadRankCode || !routeNo) return res.json({ buckets: {} });

    let where = sect ? 'road_rank = $1 AND road_no = $2 AND sect = $3' : 'road_rank = $1 AND road_no = $2';
    const params = sect ? [roadRankCode, routeNo, sect] : [roadRankCode, routeNo];
    where = withJurisdiction(req.session.user, where, params);

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
    const roadRankCode = await rankCodeFor(req.query.road_rank_name, req.query.route_no, req.session.user);
    const routeNo = (req.query.route_no || '').trim();
    const sect = (req.query.sect || '').trim();
    if (!roadRankCode || !routeNo) return res.json({ items: [] });

    let where = sect
        ? 'road_rank = $1 AND road_no = $2 AND sect = $3 AND geom IS NOT NULL'
        : 'road_rank = $1 AND road_no = $2 AND geom IS NOT NULL';
    const params = sect ? [roadRankCode, routeNo, sect] : [roadRankCode, routeNo];
    where = withJurisdiction(req.session.user, where, params);

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
    const roadRankCode = await rankCodeFor(req.query.road_rank_name, req.query.route_no, req.session.user);
    const routeNo = (req.query.route_no || '').trim();
    const sect = (req.query.sect || '').trim();
    if (!table || !roadRankCode || !routeNo) return res.json({ files: [] });

    // sect가 없으면(노선 자체를 선택한 경우) 그 노선의 구간 전부에서 찾는다.
    let where = sect ? 'road_rank = $1 AND road_no = $2 AND sect = $3' : 'road_rank = $1 AND road_no = $2';
    const params = sect ? [roadRankCode, routeNo, sect] : [roadRankCode, routeNo];
    where = withJurisdiction(req.session.user, where, params);
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
    // thumb=1: 사진은 1000px 이내 JPEG 썸네일을 보낸다(원본의 약 1/5). 못 만들면 아래에서 원본을 보낸다.
    if (req.query.thumb === '1' && IMAGE_RE.test(file.original_name)) {
        const thumb = await getThumbPath(file.id, file.stored_path);
        if (thumb) {
            res.setHeader('Cache-Control', 'private, no-cache'); // 매번 확인(304) — 원본이 바뀌면 바로 새 것
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.type('image/jpeg');
            return res.sendFile(path.resolve(thumb));
        }
    }
    if (req.query.inline === '1') {
        sendInlineSafely(res, file.stored_path, file.original_name);
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

// ---- 시설물 파일(사진/보고서) 직접 올리기 — 편집 모드(관리자)에서만 ----
// 일괄등록이 붙이는 것과 같은 gov_facility_files에 같은 방식(uploads/gov-facility-files/<시군구>/<테이블>/)으로 저장해
// 지도의 시설물 마커·속성정보 창에서 똑같이 보인다. 같은 시설물에 같은 이름이 이미 있으면 덮어쓸지 화면이 먼저 묻는다(replace=1).
const FACILITY_UPLOAD_KIND = {
    '.jpg': '사진', '.jpeg': '사진', '.png': '사진', '.gif': '사진', '.bmp': '사진', '.webp': '사진',
    '.pdf': '보고서', '.hwp': '보고서', '.hwpx': '보고서', '.doc': '보고서', '.docx': '보고서', '.xls': '보고서', '.xlsx': '보고서',
};
const facilityUploadTmp = path.join(config.uploadDir, 'facility-files-tmp');
fs.mkdirSync(facilityUploadTmp, { recursive: true });
const facilityUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => { fs.mkdirSync(facilityUploadTmp, { recursive: true }); cb(null, facilityUploadTmp); }, // 폴더가 지워져도 다시 만든다
        filename: (req, file, cb) => cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}`),
    }),
    limits: { fileSize: 200 * 1024 * 1024, files: 20 },
});
function uploadFacilityFilesMiddleware(req, res, next) {
    facilityUpload.array('files', 20)(req, res, (err) => {
        if (!err) return next();
        const msg = err.code === 'LIMIT_FILE_SIZE' ? '파일 하나는 200MB까지 올릴 수 있습니다.'
            : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? '한 번에 20개까지 올릴 수 있습니다.' : '업로드 중 오류가 발생했습니다.';
        res.status(400).json({ error: msg });
    });
}
async function moveFile(from, to) {
    try { await fs.promises.rename(from, to); } catch (e) { await fs.promises.copyFile(from, to); await fs.promises.rm(from, { force: true }); }
}

router.post('/facility-files', requireAdmin, uploadFacilityFilesMiddleware, async (req, res) => {
    const files = req.files || [];
    const cleanupTemp = () => files.forEach((f) => fs.unlink(f.path, () => {}));
    const table = String(req.body.table || '').trim();
    const rdid = String(req.body.facility_rdid || '').trim();
    const replace = req.body.replace === '1';
    const layerDef = TABLE_TO_LAYERDEF[table];
    if (!layerDef || !rdid || !files.length) { cleanupTemp(); return res.status(400).json({ error: '시설물과 올릴 파일을 확인하세요.' }); }

    const { rows: [facility] } = await pool.query(
        `SELECT ${layerDef.pkColumn} AS pk, sigungu_code FROM ${table} WHERE ${layerDef.pkColumn} = $1`, [rdid]
    );
    if (!facility) { cleanupTemp(); return res.status(404).json({ error: '시설물을 찾을 수 없습니다.' }); }
    if (outsideJurisdiction(req.session.user.sigunguCode, facility.sigungu_code)) {
        cleanupTemp();
        return res.status(403).json({ error: '관할 시군구 밖의 시설물입니다.' });
    }

    const items = [];
    const rejected = [];
    for (const f of files) {
        const name = path.basename(Buffer.from(f.originalname, 'latin1').toString('utf8')).slice(0, 200);
        const kind = FACILITY_UPLOAD_KIND[path.extname(name).toLowerCase()];
        if (!name || !kind) rejected.push(name || '(이름 없음)');
        else items.push({ name, kind, tmp: f.path });
    }
    if (rejected.length) {
        cleanupTemp();
        return res.status(400).json({ error: `올릴 수 없는 형식입니다: ${rejected.slice(0, 5).join(', ')}\n(사진: jpg·png·gif·bmp·webp / 보고서: pdf·hwp·hwpx·doc(x)·xls(x))` });
    }
    if (new Set(items.map((i) => i.name)).size !== items.length) {
        cleanupTemp();
        return res.status(400).json({ error: '같은 이름의 파일이 두 개 이상 선택됐습니다. 이름을 다르게 해서 올려 주세요.' });
    }

    const { rows: old } = await pool.query(
        'SELECT * FROM gov_facility_files WHERE facility_table = $1 AND facility_rdid = $2 AND original_name = ANY($3)', [table, rdid, items.map((i) => i.name)]
    );
    if (old.length && !replace) {
        cleanupTemp();
        return res.status(409).json({ error: '같은 이름의 파일이 이미 있습니다.', conflicts: old.map((o) => o.original_name) });
    }

    const dir = facilityFilesDir(facility.sigungu_code, table);
    await fs.promises.mkdir(dir, { recursive: true });
    const saved = [];
    const created = [];
    try {
        for (const it of items) {
            const stored = path.join(dir, `${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${it.name.replace(/[/\\]/g, '_')}`);
            await moveFile(it.tmp, stored);
            created.push(stored);
            const { rows: [row] } = await pool.query(
                `INSERT INTO gov_facility_files (facility_table, facility_rdid, file_kind, original_name, stored_path, sigungu_code, uploaded_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (facility_table, facility_rdid, original_name)
                 DO UPDATE SET file_kind = EXCLUDED.file_kind, stored_path = EXCLUDED.stored_path, sigungu_code = EXCLUDED.sigungu_code,
                     uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()
                 RETURNING id, original_name, file_kind`,
                [table, rdid, it.kind, it.name, stored, facility.sigungu_code || null, req.session.user.id]
            );
            saved.push(row);
        }
    } catch (e) {
        console.error('[sections/facility-files upload]', e);
        created.forEach((p) => fs.unlink(p, () => {}));
        cleanupTemp();
        return res.status(500).json({ error: '파일을 저장하지 못했습니다.' });
    }
    old.forEach((o) => { if (o.stored_path) fs.unlink(o.stored_path, () => {}); }); // 덮어쓴 옛 파일 정리
    await logAction(null, {
        action: 'create', targetTable: 'gov_facility_files', targetId: rdid,
        summary: `시설물 파일 올리기: ${TABLE_TO_FACILITY_LABEL[table] || layerDef.koreanName} ${rdid} — ${saved.map((s) => s.original_name).join(', ').slice(0, 120)}${old.length ? ` (덮어쓰기 ${old.length}개)` : ''}`,
        sigunguCode: facility.sigungu_code, user: req.session.user,
    });
    res.status(201).json({ files: saved, replaced: old.length });
});

// 시설물 파일 삭제 — DB 기록을 지우고, 파일은 바로 없애지 않고 서버의 보관 폴더로 옮겨 30일 뒤에 지운다(실수로 지웠을 때 관리자가 서버에서 되살릴 수 있게).
const DELETED_FACILITY_DIR = path.join(config.uploadDir, '_deleted-facility-files');
const DELETED_FACILITY_KEEP_DAYS = 30;
async function purgeDeletedFacilityFiles() {
    try {
        if (!fs.existsSync(DELETED_FACILITY_DIR)) return;
        const cutoff = Date.now() - DELETED_FACILITY_KEEP_DAYS * 24 * 3600 * 1000;
        const sweep = async (dirPath, depth) => {
            for (const name of await fs.promises.readdir(dirPath)) {
                const p = path.join(dirPath, name);
                const stat = await fs.promises.stat(p).catch(() => null);
                if (!stat) continue;
                if (stat.isDirectory()) { if (depth < 2) await sweep(p, depth + 1); }
                else if (stat.mtimeMs < cutoff) await fs.promises.rm(p, { force: true }).catch(() => {});
            }
        };
        await sweep(DELETED_FACILITY_DIR, 0);
    } catch (e) { console.error('[facility-files/purge-deleted]', e.message); }
}
purgeDeletedFacilityFiles();
setInterval(purgeDeletedFacilityFiles, 6 * 60 * 60 * 1000).unref();

router.delete('/facility-files/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 파일 번호입니다.' });
    const { rows: [file] } = await pool.query('SELECT * FROM gov_facility_files WHERE id = $1', [id]);
    if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    if (outsideJurisdiction(req.session.user.sigunguCode, file.sigungu_code)) {
        return res.status(403).json({ error: '관할 시군구 밖의 파일입니다.' });
    }
    await pool.query('DELETE FROM gov_facility_files WHERE id = $1', [id]);
    let keptAt = null;
    if (file.stored_path && fs.existsSync(file.stored_path)) {
        try {
            const keepDir = deletedFacilityDir(file.sigungu_code);
            await fs.promises.mkdir(keepDir, { recursive: true });
            keptAt = path.join(keepDir, `${Date.now()}_${id}_${path.basename(file.original_name).replace(/[/\\]/g, '_')}`);
            await moveFile(file.stored_path, keptAt);
            await fs.promises.utimes(keptAt, new Date(), new Date()); // 보관 기간은 지운 날부터 센다
        } catch (e) {
            console.error('[facility-files/delete move]', e.message);
            fs.unlink(file.stored_path, () => {});
        }
    }
    await logAction(null, {
        action: 'delete', targetTable: 'gov_facility_files', targetId: file.facility_rdid,
        summary: `시설물 파일 삭제: ${TABLE_TO_FACILITY_LABEL[file.facility_table] || file.facility_table} ${file.facility_rdid} — ${file.original_name}`,
        detail: { id, file_kind: file.file_kind, keptAt }, sigunguCode: file.sigungu_code, user: req.session.user,
    });
    res.json({ ok: true });
});

// 시설물 검색(검색보기 탭 '시설물' 카테고리) — 시설물 ID(일부), "종류 번호", 이름. 구현은 lib/facilitySearch.js.
// '/:rdid'보다 먼저 등록해야 한다.
router.get('/facility-search', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ items: [], total: 0, truncated: false });
    res.json(await searchFacilities(q.slice(0, 100), req.session.user));
});

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
// ?grade=군도 처럼 도로 종류(road_rank_name)를 주면 그 종류의 구간만 돌려준다(트리의 도로 종류 제목을 눌렀을 때).
router.get('/all-geoms', async (req, res) => {
    const userSigungu = req.session.user.sigunguCode;
    const grade = typeof req.query.grade === 'string' ? req.query.grade.trim() : '';
    const { rows } = grade
        ? await pool.query('SELECT rdid, geom, sigungu_code FROM road_sections WHERE geom IS NOT NULL AND road_rank_name = $1', [grade])
        : await pool.query('SELECT rdid, geom, sigungu_code FROM road_sections WHERE geom IS NOT NULL');
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
async function resolveScopedSections(userSigungu, { rdid, rdids, roadGrade, routeNo, routeName }) {
    // 여러 노선을 골라 내려받을 때 — 고른 구간들(rdid 목록)을 그대로 쓴다(노선별 폴더는 내보내기 쪽이 나눈다).
    if (rdids && rdids.length) {
        const { rows } = await pool.query(
            `SELECT * FROM road_sections WHERE rdid = ANY($1) ORDER BY road_rank_code, route_no NULLS LAST, sect NULLS LAST`,
            [rdids]
        );
        return rows.filter((r) => !outsideJurisdiction(userSigungu, r.sigungu_code));
    }
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

const MAX_EXPORT_RDIDS = 300; // 한 번에 고를 수 있는 구간 수(주소 길이와 서버 부담을 함께 고려)
function scopeParamsFromQuery(q) {
    const rdids = String(q.rdids || '').split(',').map((v) => v.trim()).filter(Boolean).slice(0, MAX_EXPORT_RDIDS + 1);
    return { rdid: q.rdid || '', rdids, roadGrade: q.road_grade || '', routeNo: q.route_no || '', routeName: q.route_name || '' };
}

// 범위(구간 하나/호선 전체/관할 전체)에 맞는 파일명 라벨을 만든다 — 조서와
// 전체자료 다운로드가 같은 이름 규칙을 쓴다.
function scopeLabel(sections, { rdid, rdids, roadGrade, routeNo }, sigunguName) {
    if (rdids && rdids.length) {
        const routes = new Set(sections.map((s) => `${s.road_rank_code}|${s.route_no}|${s.route_name}`));
        const first = sections[0];
        const firstName = first ? (first.route_name || first.route_no || '') : '';
        return routes.size > 1 ? `${firstName} 외 ${routes.size - 1}개 노선` : (firstName || '선택한 노선');
    }
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
        console.error('[sections/ledger-report]', e);
        res.status(500).json({ error: '조서 생성 중 오류가 발생했습니다.' });
    }
});

// 조서 새창 미리보기 — 다운로드(zip, 구간 여러 개 가능)와 달리 구간 정확히
// 하나만 받는다(여러 구간이면 파일이 여러 개라 "새창 하나에 바로 보여주기"가
// 안 됨 — 그런 경우는 기존 zip 다운로드를 쓰게 한다). xlsx 원본 그대로
// 돌려주고, 실제 표 렌더링(SheetJS)은 프론트(openLedgerReportPreview)가 한다.
router.get('/ledger-report-preview', async (req, res) => {
    try {
        const rdid = (req.query.rdid || '').trim();
        if (!rdid) return res.status(400).json({ error: '미리보기는 구간을 하나 선택해야 합니다.' });
        const sections = await resolveScopedSections(req.session.user.sigunguCode, { rdid });
        if (!sections.length) return res.status(404).json({ error: '조서를 만들 구간을 찾을 수 없습니다.' });
        const workbook = await buildSectionWorkbook(sections[0]);
        const buffer = await workbook.xlsx.writeBuffer();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(Buffer.from(buffer));
    } catch (e) {
        console.error('[sections/ledger-report-preview]', e);
        res.status(500).json({ error: '조서 생성 중 오류가 발생했습니다.' });
    }
});

// 전체자료(SHP/DBF/사진/보고서/도면) 다운로드 — /ledger-report와 같은 3단계
// 범위 규칙(구간/호선/관할)을 쓴다. 구간이 하나뿐이면 폴더 없이 바로
// LAYER/ETC 구조로(buildExportZip), 여럿이면 구간마다 폴더를 나눠 하나의
// zip으로 묶는다(buildExportZipMulti). '/:rdid'보다 먼저 등록해야 한다.
router.get('/export', async (req, res) => {
    try {
        const scope = scopeParamsFromQuery(req.query);
        if (scope.rdids.length > MAX_EXPORT_RDIDS) {
            return res.status(400).json({ error: `한 번에 구간 ${MAX_EXPORT_RDIDS}개까지만 선택해서 내려받을 수 있습니다. 나누어 받아 주세요.` });
        }
        const sections = await resolveScopedSections(req.session.user.sigunguCode, scope);
        if (!sections.length) return res.status(404).json({ error: '내보낼 구간을 찾을 수 없습니다.' });
        const label = scopeLabel(sections, scope, req.session.user.sigunguName);

        // check=1: 실제로 만들지 않고 "받을 수 있는지"만 확인한다. 프론트가 먼저 이걸로 오류를 알아낸 뒤 브라우저의
        // 일반 다운로드(스트리밍)를 시작한다 — 그래야 오류가 JSON 페이지로 화면을 덮지 않는다.
        if (req.query.check) return res.json({ ok: true, filename: exportFilename(sections, label), sectionCount: sections.length });

        // 오래 걸리는 큰 전송이 서버 기본 시간 제한에 끊기지 않게 한다.
        req.setTimeout(0);
        res.setTimeout(0);
        const result = await streamExportZip(res, sections, label);
        await logAction(null, {
            action: 'export', targetTable: 'road_sections', targetId: sections.length === 1 ? sections[0].rdid : null,
            summary: `전체자료 내려받기: ${label} (구간 ${sections.length}개, ${(result.bytes / 1048576).toFixed(1)}MB)`,
            detail: { sectionCount: sections.length, bytes: result.bytes, entryCount: result.entryCount },
            sigunguCode: sections[0].sigungu_code, user: req.session.user, ip: req.ip,
        });
    } catch (e) {
        // 받는 쪽이 다운로드를 취소한 경우는 오류가 아니다 — 짧게만 남긴다.
        if (e && e.clientAborted) { console.warn('[sections/export] 받는 쪽이 다운로드를 중간에 취소했습니다.'); return; }
        console.error('[sections/export]', e);
        // 응답을 이미 시작했으면(다운로드 도중) 연결이 끊긴 것으로 끝난다 — 아직이면 일반 오류 응답.
        if (!res.headersSent) res.status(500).json({ error: '내보내기 중 오류가 발생했습니다.' });
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
    const result = await deleteSection(req.params.rdid, req.session.user);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
});

module.exports = router;
module.exports.ROAD_RANK_CODES = ROAD_RANK_CODES;
