// 사용자도로관리 API — 공식 도로망도에 없는 임의 구간/지점(포트홀 보수, 민원,
// 시설물 점검 등)에 대해 사용자가 지도에 직접 노선을 그려 업무 이력을 남기는
// 기능. road_sections(공식 구간 대장)와는 별개의 데이터/테이블이다.
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const pool = require('../db');
const config = require('../config');
const { requireAuth, requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();

const CATEGORIES = ['도로구조(점용 등) 현황', '도로 보수 현황', '시설물 보수 현황'];
const STATUSES = ['공사중', '준공완료', '민원제기', '소송', '행정명령', '기타'];
const EDITABLE_FIELDS = ['category', 'team', 'status', 'title', 'content'];

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

router.use(requireAuth);

function outsideJurisdiction(userSigungu, rowSigungu) {
    return !!userSigungu && !!rowSigungu && userSigungu !== rowSigungu;
}

function fixMultipartFilename(name) {
    return Buffer.from(name, 'latin1').toString('utf8');
}

function validateBody(body) {
    if (!CATEGORIES.includes(body.category)) return `알 수 없는 업무구분입니다: ${body.category}`;
    if (body.status !== undefined && body.status !== null && !STATUSES.includes(body.status)) {
        return `알 수 없는 처리현황입니다: ${body.status}`;
    }
    if (!body.title || !String(body.title).trim()) return '제목을 입력해주세요.';
    return null;
}

// 데이터보기 트리: 업무구분 3종으로 그룹핑(관할 시군구만, 3그룹 항상 다 내려줌)
router.get('/tree', async (req, res) => {
    const userSigungu = req.session.user.sigunguCode;
    const { rows } = await pool.query(
        `SELECT id, category, title, status, sigungu_code, geom, geom->>'type' AS geom_type FROM road_issues ORDER BY created_at DESC`
    );
    const visible = rows.filter((r) => !outsideJurisdiction(userSigungu, r.sigungu_code));

    const byCategory = new Map(CATEGORIES.map((c) => [c, []]));
    for (const row of visible) {
        if (!byCategory.has(row.category)) byCategory.set(row.category, []);
        byCategory.get(row.category).push({
            id: row.id, title: row.title, status: row.status, geomType: row.geom_type, geom: row.geom,
        });
    }

    const tree = CATEGORIES.map((category) => ({ category, items: byCategory.get(category) || [] }));
    res.json({ tree, categories: CATEGORIES, statuses: STATUSES });
});

// 사용자가 등록한 항목을 GeoJSON FeatureCollection으로 내려준다(관할 시군구만).
// ?ids=1,2,3 을 넘기면 해당 id만 필터링(트리에서 체크된 항목만 받을 때 사용).
router.get('/geojson', async (req, res) => {
    const userSigungu = req.session.user.sigunguCode;
    const { rows } = await pool.query(
        `SELECT id, category, team, status, title, content, geom, sigungu_code, created_at
         FROM road_issues ORDER BY created_at DESC`
    );
    let visible = rows.filter((r) => !outsideJurisdiction(userSigungu, r.sigungu_code));

    if (req.query.ids) {
        const idSet = new Set(String(req.query.ids).split(',').map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n)));
        visible = visible.filter((r) => idSet.has(r.id));
    }

    const features = visible.filter((r) => r.geom).map((r) => ({
        type: 'Feature',
        geometry: r.geom,
        properties: {
            id: r.id, category: r.category, team: r.team, status: r.status,
            title: r.title, content: r.content, created_at: r.created_at,
        },
    }));

    res.setHeader('Content-Disposition', 'attachment; filename="user_road_issues.geojson"');
    res.json({ type: 'FeatureCollection', features });
});

router.get('/:id', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM road_issues WHERE id = $1', [req.params.id]);
    const record = rows[0];
    if (!record) return res.json({ record: null });
    if (outsideJurisdiction(req.session.user.sigunguCode, record.sigungu_code)) {
        return res.json({ record: null });
    }
    res.json({ record });
});

router.post('/', async (req, res) => {
    const body = req.body || {};
    const err = validateBody(body);
    if (err) return res.status(400).json({ error: err });
    if (!body.geom) return res.status(400).json({ error: '경로(geom)가 없습니다.' });

    const userId = req.session.user.id;
    const userSigungu = req.session.user.sigunguCode;

    const { rows } = await pool.query(
        `INSERT INTO road_issues (category, team, status, title, content, geom, sigungu_code, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
        [
            body.category, body.team || null, body.status || '민원제기', body.title, body.content || null,
            JSON.stringify(body.geom), userSigungu || null, userId,
        ]
    );
    res.status(201).json({ record: rows[0] });
});

router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const existing = await pool.query('SELECT sigungu_code FROM road_issues WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: '항목을 찾을 수 없습니다.' });
    if (outsideJurisdiction(req.session.user.sigunguCode, existing.rows[0].sigungu_code)) {
        return res.status(403).json({ error: '관할 시군구 밖의 항목입니다.' });
    }

    const body = req.body || {};
    const err = validateBody(body);
    if (err) return res.status(400).json({ error: err });

    const userId = req.session.user.id;
    const setClauses = EDITABLE_FIELDS.map((f, i) => `${f} = $${i + 2}`);
    const values = [id, ...EDITABLE_FIELDS.map((f) => (body[f] === undefined ? null : body[f]))];
    let geomClause = '';
    if (body.geom) {
        values.push(JSON.stringify(body.geom));
        geomClause = `, geom = $${values.length}`;
    }

    const { rows } = await pool.query(
        `UPDATE road_issues SET ${setClauses.join(', ')}${geomClause}, updated_by = $${values.length + 1}, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [...values, userId]
    );
    res.json({ record: rows[0] });
});

// 삭제는 관리자만 — road_sections와 동일한 정책. 프론트 admin-mode는 UI 노출만
// 제어할 뿐이라 실제 권한은 여기서 강제해야 한다.
router.delete('/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const existing = await pool.query('SELECT sigungu_code FROM road_issues WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: '항목을 찾을 수 없습니다.' });
    if (outsideJurisdiction(req.session.user.sigunguCode, existing.rows[0].sigungu_code)) {
        return res.status(403).json({ error: '관할 시군구 밖의 항목입니다.' });
    }
    await pool.query('DELETE FROM road_issues WHERE id = $1', [id]);
    res.json({ ok: true });
});

router.get('/:id/files', async (req, res) => {
    const { rows } = await pool.query(
        `SELECT f.id, f.original_name, f.uploaded_at, a.display_name AS uploaded_by_name
         FROM road_issue_files f LEFT JOIN accounts a ON a.id = f.uploaded_by
         WHERE f.issue_id = $1 ORDER BY f.uploaded_at DESC`,
        [req.params.id]
    );
    res.json({ files: rows });
});

router.post('/:id/files', upload.single('file'), async (req, res) => {
    const { id } = req.params;
    const issue = await pool.query('SELECT sigungu_code FROM road_issues WHERE id = $1', [id]);
    if (issue.rows.length === 0) return res.status(404).json({ error: '항목을 찾을 수 없습니다.' });
    if (outsideJurisdiction(req.session.user.sigunguCode, issue.rows[0].sigungu_code)) {
        return res.status(403).json({ error: '관할 시군구 밖의 항목입니다.' });
    }
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

    const userId = req.session.user.id;
    const originalName = fixMultipartFilename(req.file.originalname);

    const dir = path.join(config.uploadDir, 'road-issues', String(id));
    fs.mkdirSync(dir, { recursive: true });
    const storedPath = path.join(dir, `${Date.now()}_${originalName.replace(/[/\\]/g, '_')}`);
    fs.writeFileSync(storedPath, req.file.buffer);

    const { rows } = await pool.query(
        `INSERT INTO road_issue_files (issue_id, original_name, stored_path, uploaded_by)
         VALUES ($1, $2, $3, $4) RETURNING id, original_name, uploaded_at`,
        [id, originalName, storedPath, userId]
    );
    res.status(201).json({ file: rows[0] });
});

router.get('/files/:fileId', async (req, res) => {
    const { rows } = await pool.query(
        `SELECT f.*, i.sigungu_code FROM road_issue_files f
         JOIN road_issues i ON i.id = f.issue_id WHERE f.id = $1`,
        [req.params.fileId]
    );
    const file = rows[0];
    if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    if (outsideJurisdiction(req.session.user.sigunguCode, file.sigungu_code)) {
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }
    if (!fs.existsSync(file.stored_path)) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    res.download(file.stored_path, file.original_name);
});

router.delete('/files/:fileId', async (req, res) => {
    const { rows } = await pool.query(
        `SELECT f.*, i.sigungu_code FROM road_issue_files f
         JOIN road_issues i ON i.id = f.issue_id WHERE f.id = $1`,
        [req.params.fileId]
    );
    const file = rows[0];
    if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    if (outsideJurisdiction(req.session.user.sigunguCode, file.sigungu_code)) {
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }
    await pool.query('DELETE FROM road_issue_files WHERE id = $1', [file.id]);
    fs.promises.unlink(file.stored_path).catch(() => {});
    res.json({ ok: true });
});

module.exports = router;
