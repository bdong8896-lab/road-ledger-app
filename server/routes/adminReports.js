// 관리 콘솔 "통계·점검" — 현황 통계 엑셀 내려받기와 데이터 점검(중복 노선·위치 이탈·시설물 ID).
// 통계/점검 구현은 lib/statsReport.js, lib/dataChecks.js. 둘 다 읽기 전용이며 로그인 계정의 관할 범위만 다룬다.
const express = require('express');
const { requireAdminReauth } = require('../middleware/requireAuth');
const { buildStatsWorkbook } = require('../lib/statsReport');
const { runChecks } = require('../lib/dataChecks');
const { logAction, clientIp } = require('../lib/auditLog');
const adminQuality = require('./adminQuality');

const router = express.Router();
router.use(requireAdminReauth);

router.get('/stats.xlsx', async (req, res) => {
    const wb = await buildStatsWorkbook(req.session.user, adminQuality.getMeta);
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`도로대장_현황통계_${today}.xlsx`)}`);
    await wb.xlsx.write(res);
    res.end();
    await logAction(null, {
        action: 'export', targetTable: 'road_sections', summary: '현황 통계 엑셀 내려받기',
        user: req.session.user, sigunguCode: req.session.user.sigunguCode, ip: clientIp(req),
    });
});

// ---- 데이터 점검: 서버에서 한 번에 하나만 돌리고, 화면은 진행 상황을 주기적으로 물어본다 ----
let job = null; // { id, status: running|done|error, stage, done, total, thresholdM, result, error, startedAt, userId }

function jobView(j) {
    if (!j) return { status: 'idle' };
    return { id: j.id, status: j.status, stage: j.stage, done: j.done, total: j.total, thresholdM: j.thresholdM, result: j.status === 'done' ? j.result : undefined, error: j.status === 'error' ? j.error : undefined, startedAt: j.startedAt };
}

router.post('/checks/run', (req, res) => {
    if (job && job.status === 'running') return res.status(409).json({ error: '이미 점검이 진행 중입니다.', ...jobView(job) });
    const thresholdM = Math.min(5000, Math.max(20, parseInt(req.body.thresholdM, 10) || 200));
    const user = req.session.user;
    job = { id: require('crypto').randomUUID(), status: 'running', stage: '시작', done: 0, total: 1, thresholdM, startedAt: Date.now(), userId: user.id };
    const mine = job;
    runChecks({ user, thresholdM, onProgress: (stage, done, total) => { mine.stage = stage; mine.done = done; mine.total = total; } })
        .then((result) => { mine.result = result; mine.status = 'done'; })
        .catch((e) => { console.error('[admin-reports/checks]', e); mine.status = 'error'; mine.error = '점검 중 오류가 발생했습니다.'; });
    res.status(202).json(jobView(mine));
});

router.get('/checks/status', (req, res) => {
    // 다른 관리자(다른 관할)가 돌린 결과는 보여주지 않는다
    if (job && job.userId !== req.session.user.id && (job.status === 'done')) return res.json({ status: 'idle' });
    res.json(jobView(job));
});

module.exports = router;
