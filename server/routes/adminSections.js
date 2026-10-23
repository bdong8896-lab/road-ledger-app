// 관리 콘솔 "등록 데이터 관리" — 등록된 노선(구간)을 한눈에 보고 노선 단위로 삭제한다.
// 구간 삭제 자체는 데이터보기 트리와 같은 lib/sectionDelete.js를 쓴다(부속시설·첨부·도면·500m 조각 포함).
const express = require('express');
const pool = require('../db');
const { requireAdminReauth } = require('../middleware/requireAuth');
const { GOV_LAYER_MAP } = require('../lib/govLayerMap');
const { deleteSection, outsideJurisdiction } = require('../lib/sectionDelete');
const { RANK_NAMES_FOR_1599 } = require('../lib/roadRank');
const { logAction } = require('../lib/auditLog');

const router = express.Router();
router.use(requireAdminReauth); // 관리자 전용 + 관리 콘솔 재인증(15분)

// 구간별 부속시설 건수 — "road_rank|road_no|sect" -> 건수. 테이블마다 한 번씩 묶어서 센다.
async function facilityCountsBySection() {
    const counts = new Map();
    for (const { table } of Object.values(GOV_LAYER_MAP)) {
        const hasRoadRank = table !== 'gov_road_bound';
        const sql = hasRoadRank
            ? `SELECT road_rank AS rr, road_no AS rn, sect, COUNT(*)::int AS n FROM ${table} GROUP BY road_rank, road_no, sect`
            : `SELECT NULL::text AS rr, road_no AS rn, sect, COUNT(*)::int AS n FROM ${table} GROUP BY road_no, sect`;
        let rows;
        try {
            ({ rows } = await pool.query(sql));
        } catch (e) {
            continue; // 컬럼 구성이 다른 테이블은 건너뜀
        }
        for (const r of rows) {
            // gov_road_bound는 도로종류가 없어 노선번호+구간만으로 센다(키의 rr은 빈 값).
            const key = `${r.rr || ''}|${r.rn}|${r.sect}`;
            counts.set(key, (counts.get(key) || 0) + r.n);
        }
    }
    return counts;
}

// 등록된 노선 목록(도로종류 > 노선), 계정 관할 안의 것만.
router.get('/', async (req, res) => {
    const userSigungu = req.session.user.sigunguCode;
    const { rows } = await pool.query(
        `SELECT rdid, road_rank_code, road_rank_name, route_no, route_name, sect, length_m, sigungu_code
         FROM road_sections
         ORDER BY road_rank_code, route_no NULLS LAST, sect NULLS LAST`
    );
    const visible = rows.filter((r) => !outsideJurisdiction(userSigungu, r.sigungu_code));

    const [facility, fileRows] = await Promise.all([
        facilityCountsBySection(),
        pool.query('SELECT section_rdid, COUNT(*)::int AS n FROM route_files WHERE section_rdid IS NOT NULL GROUP BY section_rdid'),
    ]);
    const filesByRdid = new Map(fileRows.rows.map((r) => [r.section_rdid, r.n]));

    const routes = new Map();
    for (const r of visible) {
        const key = `${r.road_rank_code}|${r.route_no}|${r.route_name}`;
        if (!routes.has(key)) {
            routes.set(key, {
                roadGrade: r.road_rank_name, roadRankCode: r.road_rank_code, routeNo: r.route_no, routeName: r.route_name,
                sections: [], lengthM: 0, facilityCount: 0, drawingCount: 0,
            });
        }
        const route = routes.get(key);
        const facilityN = (facility.get(`${r.road_rank_code}|${r.route_no}|${r.sect}`) || 0) + (facility.get(`|${r.route_no}|${r.sect}`) || 0);
        const drawingN = filesByRdid.get(r.rdid) || 0;
        route.sections.push({ rdid: r.rdid, sect: r.sect, lengthM: r.length_m == null ? null : Number(r.length_m), facilityCount: facilityN, drawingCount: drawingN });
        route.lengthM += r.length_m == null ? 0 : Number(r.length_m);
        route.facilityCount += facilityN;
        route.drawingCount += drawingN;
    }
    res.json({ routes: [...routes.values()] });
});

// 도로종류 표시 이름 변경(기타 ↔ 면도/리도/농도/도시계획도로). 저장 코드는 1599 그대로 두고 이름만 바꾼다
// — KRRIS 제출 파일과 RDID는 영향이 없다. 코드가 1599가 아닌 구간은 건드리지 않는다.
router.post('/rank-name', async (req, res) => {
    const name = String(req.body.name || '').trim();
    const rdids = Array.isArray(req.body.rdids) ? req.body.rdids.filter((v) => typeof v === 'string' && v) : [];
    if (!RANK_NAMES_FOR_1599.includes(name)) return res.status(400).json({ error: '바꿀 수 없는 도로종류 이름입니다.' });
    if (!rdids.length) return res.status(400).json({ error: '바꿀 구간이 없습니다.' });

    const { rows } = await pool.query(
        'SELECT rdid, road_rank_code, road_rank_name, route_no, route_name, sect, sigungu_code FROM road_sections WHERE rdid = ANY($1)',
        [rdids]
    );
    const targets = rows.filter((r) => r.road_rank_code === '1599' && !outsideJurisdiction(req.session.user.sigunguCode, r.sigungu_code));
    if (!targets.length) return res.status(400).json({ error: '도로종류 코드가 1599(기타)인 구간만 이름을 바꿀 수 있습니다.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const t of targets) {
            await client.query('UPDATE road_sections SET road_rank_name = $1, updated_by = $2, updated_at = now() WHERE rdid = $3',
                [name, req.session.user.id, t.rdid]);
            // 노선 자료(도면 등)는 도로종류 이름으로 노선을 찾으므로 같이 바꾼다.
            await client.query(
                `UPDATE route_files SET road_grade = $1
                 WHERE section_rdid = $2 OR (section_rdid IS NULL AND road_grade = $3 AND route_no = $4 AND route_name = $5)`,
                [name, t.rdid, t.road_rank_name, t.route_no || '', t.route_name || '']
            );
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[admin-sections/rank-name]', e);
        return res.status(500).json({ error: '이름을 바꾸는 중 오류가 발생했습니다.' });
    } finally {
        client.release();
    }
    for (const t of targets) {
        await logAction(null, {
            action: 'update', targetTable: 'road_sections', targetId: t.rdid,
            summary: `도로종류 표시 이름 변경: ${t.road_rank_name} → ${name} (${t.route_no || ''} ${t.route_name || ''} ${t.sect || ''}구간)`.replace(/\s+/g, ' ').trim(),
            detail: { before: t.road_rank_name, after: name },
            sigunguCode: t.sigungu_code, user: req.session.user,
        });
    }
    res.json({ updated: targets.length });
});

// 선택한 구간들(rdids)을 삭제한다 — 노선 하나를 지울 땐 그 노선의 구간 rdid 전부를 넘긴다.
router.post('/delete', async (req, res) => {
    const rdids = Array.isArray(req.body.rdids) ? req.body.rdids.filter((v) => typeof v === 'string' && v) : [];
    if (!rdids.length) return res.status(400).json({ error: '삭제할 구간이 없습니다.' });
    if (rdids.length > 500) return res.status(400).json({ error: '한 번에 500개 구간까지만 삭제할 수 있습니다.' });

    let deleted = 0;
    const failed = [];
    for (const rdid of rdids) {
        const r = await deleteSection(rdid, req.session.user);
        if (r.ok) deleted++;
        else failed.push({ rdid, error: r.error });
    }
    res.json({ deleted, failed });
});

module.exports = router;
