// gov_section(A0020000, 도로대장총괄) 레코드를 road_sections에 upsert한다.
// road_sections는 지도의 데이터보기 트리/편집 UI가 직접 쓰는 별도의 단순화된
// 테이블이라, 여기서 동기화해줘야 일괄등록한 노선이 바로 트리에 나타난다.
//
// 주의: gov_section의 MCO 필드는 국토부 공식 관리기관코드와 다를 수 있음을
// 실제 납품 데이터에서 확인했다(예: DBF는 "58950"인데 공식 코드북엔 해당
// 관리기관이 "46880"으로 등록돼 있었음). 그래서 sigungu_code(관할 시군구)는
// DBF 값에서 자동으로 뽑지 않고, 검수 화면에서 관리자가 선택한 값
// (targetSigunguCode)을 그대로 쓴다. mco_code/mco_name은 참고용 표시 필드일
// 뿐 관할 판정에 쓰이지 않으므로 DBF 원본 값을 그대로 저장한다.
const path = require('path');
const fs = require('fs');
const { ROAD_RANK_CODES } = require('../routes/sections');

const ROAD_RANK_NAME_BY_CODE = Object.fromEntries(
    Object.entries(ROAD_RANK_CODES).map(([name, code]) => [code, name])
);

let managingAgencies = null;
function getMcoNameByCode(code) {
    if (!managingAgencies) {
        const jsonPath = path.join(__dirname, '..', '..', 'public', 'data', 'managing_agencies.json');
        managingAgencies = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    }
    const found = managingAgencies.find((a) => a.code === code);
    return found ? found.name : null;
}

// client: pg 트랜잭션 클라이언트. row: gov_section의 파싱된 한 레코드(소문자
// 필드명). geom: 재투영된 GeoJSON LineString(없으면 null).
async function syncRoadSection(client, { row, geom }, targetSigunguCode, userId) {
    const roadRankCode = row.road_rank;
    const roadRankName = ROAD_RANK_NAME_BY_CODE[roadRankCode] || null;
    const mcoName = getMcoNameByCode(row.mco);

    // 같은 업무키(도로등급+관리기관+노선번호+구간)로 이미 등록된 구간이 있으면
    // 그 행의 기존 RDID를 유지한 채 UPDATE한다 — route_files.section_rdid가
    // 이미 그 RDID를 참조하고 있을 수 있어(FK는 없지만 업무 관례상 참조),
    // RDID를 바꾸면 기존 첨부파일 연결이 끊긴다.
    const { rows: existingRows } = await client.query(
        `SELECT rdid FROM road_sections
         WHERE road_rank_code = $1 AND mco_code = $2 AND route_no = $3 AND sect = $4`,
        [roadRankCode, row.mco, row.road_no, row.sect]
    );
    const rdid = existingRows[0] ? existingRows[0].rdid : row.rdid;

    await client.query(
        `INSERT INTO road_sections (
            rdid, road_rank_code, road_rank_name, route_no, route_name, sect,
            mco_code, mco_name, s_point, e_point, length_m, width_m, remarks,
            geom, sigungu_code, created_by, updated_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
        ON CONFLICT (rdid) DO UPDATE SET
            road_rank_code = EXCLUDED.road_rank_code, road_rank_name = EXCLUDED.road_rank_name,
            route_no = EXCLUDED.route_no, route_name = EXCLUDED.route_name, sect = EXCLUDED.sect,
            mco_code = EXCLUDED.mco_code, mco_name = EXCLUDED.mco_name,
            s_point = EXCLUDED.s_point, e_point = EXCLUDED.e_point,
            length_m = EXCLUDED.length_m, width_m = EXCLUDED.width_m, remarks = EXCLUDED.remarks,
            geom = EXCLUDED.geom, sigungu_code = EXCLUDED.sigungu_code,
            updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [
            rdid, roadRankCode, roadRankName, row.road_no, row.road_name, row.sect,
            row.mco, mcoName, row.s_point, row.e_point, row.lenth, row.wid_road, row.remark,
            geom ? JSON.stringify(geom) : null, targetSigunguCode, userId,
        ]
    );
    return { rdid, roadRankName, routeNo: row.road_no, routeName: row.road_name };
}

// syncRoadSection의 반대 방향 — 수동등록(지도에서 국가교통정보도 클릭 후 직접
// 입력) 경로는 road_sections만 채우고 gov_section(01.도로대장총괄)은 전혀
// 안 건드려서, "전체 자료 다운로드"에 그 레이어가 통째로 빠지는 문제가 있었다.
// road_sections에 실제로 입력된 필드(노선명/구간/시종점/연장/폭원/비고)만
// gov_section에도 반영하고, 이 앱이 알 수 없는 나머지 ~50개 공식 필드(터널/
// 교량 개소, 곡선반경, 종단경사 등)는 NOT NULL 제약을 만족시키는 최소값
// (숫자 0 / 빈 문자열)으로 채운다 — 실제 조사값이 아니라 "미상" placeholder.
async function syncGovSectionFromRoadSection(client, record) {
    // 같은 업무키(도로등급/노선번호/구간)로 이미 다른 rdid의 gov_section이
    // 있으면(예: 이후 실제 일괄등록 납품이 들어와 진짜 공식 데이터가 쌓인 경우)
    // 이 placeholder로 덮어쓰거나 중복 레코드를 만들지 않고 그냥 둔다.
    const { rows: dup } = await client.query(
        `SELECT rdid FROM gov_section WHERE road_rank = $1 AND road_no = $2 AND sect = $3 AND rdid != $4`,
        [record.road_rank_code, record.route_no, record.sect, record.rdid]
    );
    if (dup.length) return;

    await client.query(
        `INSERT INTO gov_section (
            rdid, mco, road_rank, road_name, road_no, sect,
            dsgdate, j_date, d_date, jj_date, s_point, e_point, impopass,
            lenth, p_ent_len, p_road_len, wid_all, wid_road,
            roadlenau, roadlenad, allarea, remark, geom, sigungu_code
        ) VALUES ($1,$2,$3,$4,$5,$6,'','','','',$7,$8,'',$9,0,0,$10,$10,0,0,0,$11,$12,$13)
        ON CONFLICT (rdid) DO UPDATE SET
            mco = EXCLUDED.mco, road_rank = EXCLUDED.road_rank, road_name = EXCLUDED.road_name,
            road_no = EXCLUDED.road_no, sect = EXCLUDED.sect,
            s_point = EXCLUDED.s_point, e_point = EXCLUDED.e_point,
            lenth = EXCLUDED.lenth, wid_all = EXCLUDED.wid_all, wid_road = EXCLUDED.wid_road,
            remark = EXCLUDED.remark, geom = EXCLUDED.geom, sigungu_code = EXCLUDED.sigungu_code`,
        [
            record.rdid, record.mco_code || '', record.road_rank_code, record.route_name || '',
            record.route_no || '', record.sect || '', record.s_point || '', record.e_point || '',
            record.length_m || 0, record.width_m || 0, record.remarks || null,
            record.geom ? JSON.stringify(record.geom) : null, record.sigungu_code || null,
        ]
    );
}

module.exports = { syncRoadSection, syncGovSectionFromRoadSection };
