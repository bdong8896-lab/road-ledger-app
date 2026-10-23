// 관리 콘솔 "일괄등록 이력" — 등록 목록과 "이 등록 취소(되돌리기)". 구현은 lib/importBatch.js.
const express = require('express');
const { requireAdminReauth } = require('../middleware/requireAuth');
const importBatch = require('../lib/importBatch');

const router = express.Router();
router.use(requireAdminReauth);

let getRunningBulkJob = () => null;
router.setRunningJobProvider = (fn) => { getRunningBulkJob = fn; };

// 오래된 이력 정리: 시작할 때 한 번, 그 뒤 6시간마다
importBatch.purgeOldBatches();
setInterval(importBatch.purgeOldBatches, 6 * 60 * 60 * 1000).unref();

router.get('/', async (req, res) => {
    res.json({ batches: await importBatch.listBatches(req.session.user) });
});

router.post('/:id/undo', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 번호입니다.' });
    // 저장 작업이 진행 중일 때는 되돌릴 수 없다(같은 행을 동시에 바꾸게 된다).
    if (getRunningBulkJob()) return res.status(409).json({ error: '일괄등록이 진행 중입니다. 끝난 뒤에 다시 시도하세요.' });
    const r = await importBatch.undoBatch(id, req.session.user);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true, missingFiles: r.missingFiles });
});

module.exports = router;
