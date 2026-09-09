const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

const EDITABLE_FIELDS = [
    'jibun_addr', 'road_addr', 'route_no', 'route_name', 'road_grade', 'sect',
    'start_point', 'end_point', 'length_m', 'width_m', 'lane_count',
    'pavement_type', 'pavement_material', 'has_sidewalk', 'has_drainage',
    'managing_agency', 'completion_date', 'remarks',
];

const PNU_RE = /^[0-9]{19}$/;

router.use(requireAuth);

// 로그인 계정의 관할 시군구(법정동코드 앞 5자리) 밖 PNU는 걸러낸다.
// sigunguCode가 없는 계정(NULL)은 전체 시군구를 다 보는 계정이라 필터링하지 않는다.
function filterBySigungu(pnus, sigunguCode) {
    if (!sigunguCode) return pnus;
    return pnus.filter((pnu) => pnu.startsWith(sigunguCode));
}

// 현재 화면에 보이는 PNU 목록 중 이미 도로대장이 등록된 것만 반환
// (지적도 레이어 색상 표기용). 예: /api/parcels?pnus=417...,417...
router.get('/', async (req, res) => {
    const raw = req.query.pnus;
    if (!raw) return res.json({ pnus: [] });
    let pnus = String(raw).split(',').map((s) => s.trim()).filter((s) => PNU_RE.test(s));
    pnus = filterBySigungu(pnus, req.session.user.sigunguCode);
    if (pnus.length === 0) return res.json({ pnus: [] });

    const { rows } = await pool.query('SELECT pnu FROM road_ledger WHERE pnu = ANY($1)', [pnus]);
    res.json({ pnus: rows.map((r) => r.pnu) });
});

// 데이터보기 트리: 도로등급 > 노선번호/노선명 순으로 그룹핑 (로그인 계정의 관할 시군구만)
router.get('/tree', async (req, res) => {
    const sigunguCode = req.session.user.sigunguCode;
    const { rows } = await pool.query(
        `SELECT road_grade, route_no, route_name, pnu, start_point, end_point
         FROM road_ledger
         WHERE road_grade IS NOT NULL AND road_grade <> ''
           AND ($1::varchar IS NULL OR LEFT(pnu, 5) = $1)
         ORDER BY road_grade, route_no NULLS LAST, route_name NULLS LAST`,
        [sigunguCode || null]
    );

    const gradeMap = new Map();
    for (const row of rows) {
        if (!gradeMap.has(row.road_grade)) gradeMap.set(row.road_grade, new Map());
        const routeMap = gradeMap.get(row.road_grade);
        const routeKey = row.route_no || row.route_name || '(미지정)';
        if (!routeMap.has(routeKey)) {
            routeMap.set(routeKey, {
                route_no: row.route_no, route_name: row.route_name,
                start_point: row.start_point, end_point: row.end_point,
                pnus: [],
            });
        }
        const entry = routeMap.get(routeKey);
        entry.pnus.push(row.pnu);
        // 노선 내 여러 필지 중 시점/종점이 채워진 첫 값을 대표값으로 사용
        if (!entry.start_point && row.start_point) entry.start_point = row.start_point;
        if (!entry.end_point && row.end_point) entry.end_point = row.end_point;
    }

    const tree = [...gradeMap.entries()].map(([road_grade, routeMap]) => ({
        road_grade,
        routes: [...routeMap.values()],
    }));

    res.json({ tree });
});

router.get('/:pnu', async (req, res) => {
    const { pnu } = req.params;
    if (!PNU_RE.test(pnu)) return res.status(400).json({ error: '잘못된 PNU 형식입니다.' });
    const sigunguCode = req.session.user.sigunguCode;
    if (sigunguCode && !pnu.startsWith(sigunguCode)) return res.json({ record: null });

    const { rows } = await pool.query('SELECT * FROM road_ledger WHERE pnu = $1', [pnu]);
    if (rows.length === 0) return res.json({ record: null });
    res.json({ record: rows[0] });
});

router.put('/:pnu', async (req, res) => {
    const { pnu } = req.params;
    if (!PNU_RE.test(pnu)) return res.status(400).json({ error: '잘못된 PNU 형식입니다.' });
    const sigunguCode = req.session.user.sigunguCode;
    if (sigunguCode && !pnu.startsWith(sigunguCode)) {
        return res.status(403).json({ error: '관할 시군구 밖의 필지는 등록할 수 없습니다.' });
    }

    const body = req.body || {};
    const userId = req.session.user.id;

    const columns = ['pnu', ...EDITABLE_FIELDS, 'created_by', 'updated_by'];
    const values = [pnu, ...EDITABLE_FIELDS.map((f) => (body[f] === undefined ? null : body[f])), userId, userId];
    const placeholders = columns.map((_, i) => `$${i + 1}`);

    const updateSet = EDITABLE_FIELDS.map((f) => `${f} = EXCLUDED.${f}`).join(', ');

    const { rows } = await pool.query(
        `INSERT INTO road_ledger (${columns.join(', ')})
         VALUES (${placeholders.join(', ')})
         ON CONFLICT (pnu) DO UPDATE SET ${updateSet}, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING *`,
        values
    );
    res.json({ record: rows[0] });
});

module.exports = router;
