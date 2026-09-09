const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const pool = require('../db');
const config = require('../config');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();
const PNU_RE = /^[0-9]{19}$/;
const CATEGORIES = ['도면', '조서', '기타'];

router.use(requireAuth);

// 로그인 계정의 관할 시군구(PNU 앞 5자리) 밖 필지의 첨부파일은 접근을 막는다.
function outsideJurisdiction(req, pnu) {
    const sigunguCode = req.session.user.sigunguCode;
    return sigunguCode && !pnu.startsWith(sigunguCode);
}

// busboy(멀티파트 파서)는 파일명을 기본적으로 latin1로 디코딩한다.
// 브라우저는 UTF-8 바이트로 파일명을 보내므로, 한글 파일명이 깨지지 않으려면
// latin1로 잘못 해석된 바이트를 다시 utf8로 복원해야 한다.
function fixMultipartFilename(name) {
    return Buffer.from(name, 'latin1').toString('utf8');
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const pnu = req.params.pnu;
        if (!PNU_RE.test(pnu)) return cb(new Error('잘못된 PNU 형식입니다.'));
        if (outsideJurisdiction(req, pnu)) return cb(new Error('관할 시군구 밖의 필지입니다.'));
        const dir = path.join(config.uploadDir, pnu);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const fixedName = fixMultipartFilename(file.originalname);
        const safeName = `${Date.now()}_${fixedName.replace(/[/\\]/g, '_')}`;
        cb(null, safeName);
    },
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

router.get('/:pnu/files', async (req, res) => {
    const { pnu } = req.params;
    if (!PNU_RE.test(pnu)) return res.status(400).json({ error: '잘못된 PNU 형식입니다.' });
    if (outsideJurisdiction(req, pnu)) return res.json({ files: [] });

    const { rows } = await pool.query(
        `SELECT f.id, f.file_category, f.original_name, f.uploaded_at, a.display_name AS uploaded_by_name
         FROM road_ledger_files f
         LEFT JOIN accounts a ON a.id = f.uploaded_by
         WHERE f.pnu = $1 ORDER BY f.uploaded_at DESC`,
        [pnu]
    );
    res.json({ files: rows });
});

router.post('/:pnu/files', upload.single('file'), async (req, res) => {
    const { pnu } = req.params;
    if (!PNU_RE.test(pnu)) return res.status(400).json({ error: '잘못된 PNU 형식입니다.' });
    if (outsideJurisdiction(req, pnu)) return res.status(403).json({ error: '관할 시군구 밖의 필지입니다.' });
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

    const category = CATEGORIES.includes(req.body.category) ? req.body.category : '기타';
    const userId = req.session.user.id;
    const originalName = fixMultipartFilename(req.file.originalname);

    // road_ledger에 아직 레코드가 없어도 파일부터 올릴 수 있도록 빈 레코드 보장
    await pool.query(
        `INSERT INTO road_ledger (pnu, created_by, updated_by) VALUES ($1, $2, $2)
         ON CONFLICT (pnu) DO NOTHING`,
        [pnu, userId]
    );

    const { rows } = await pool.query(
        `INSERT INTO road_ledger_files (pnu, file_category, original_name, stored_path, uploaded_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, file_category, original_name, uploaded_at`,
        [pnu, category, originalName, req.file.path, userId]
    );
    res.status(201).json({ file: rows[0] });
});

router.get('/:pnu/files/:fileId', async (req, res) => {
    const { pnu, fileId } = req.params;
    if (outsideJurisdiction(req, pnu)) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    const { rows } = await pool.query(
        'SELECT * FROM road_ledger_files WHERE id = $1 AND pnu = $2',
        [fileId, pnu]
    );
    const file = rows[0];
    if (!file || !fs.existsSync(file.stored_path)) {
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }

    // ?inline=1 → 분할화면 미리보기용(브라우저가 바로 렌더링), 그 외 → 강제 다운로드
    if (req.query.inline === '1') {
        const encodedName = encodeURIComponent(file.original_name);
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodedName}`);
        res.sendFile(path.resolve(file.stored_path));
    } else {
        res.download(file.stored_path, file.original_name);
    }
});

router.delete('/:pnu/files/:fileId', async (req, res) => {
    const { pnu, fileId } = req.params;
    if (outsideJurisdiction(req, pnu)) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    const { rows } = await pool.query(
        'DELETE FROM road_ledger_files WHERE id = $1 AND pnu = $2 RETURNING stored_path',
        [fileId, pnu]
    );
    const file = rows[0];
    if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    fs.promises.unlink(file.stored_path).catch(() => {});
    res.json({ ok: true });
});

module.exports = router;
