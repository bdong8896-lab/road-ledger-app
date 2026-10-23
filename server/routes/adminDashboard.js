// 관리 콘솔 첫 화면(현황판) — 등록 현황, 최근 활동, 서버 디스크, 백업 상태, 승인 대기 계정을 한 번에 보여준다.
// 계정에 관할(시군구)이 있으면 등록 현황과 활동 이력은 그 관할 것만 센다. 디스크·백업은 서버 전체 정보다.
const fs = require('fs');
const path = require('path');
const express = require('express');
const pool = require('../db');
const config = require('../config');
const { requireAdminReauth } = require('../middleware/requireAuth');
const { GOV_LAYER_MAP } = require('../lib/govLayerMap');

const router = express.Router();
router.use(requireAdminReauth);

const FACILITY_TABLES = [...new Set(Object.values(GOV_LAYER_MAP).map((l) => l.table))];

// 진행 중인 일괄등록 작업 정보를 라우트 쪽에서 넘겨받는다(index.js에서 연결).
let getRunningBulkJob = () => null;
router.setRunningJobProvider = (fn) => { getRunningBulkJob = fn; };

// ---- 서버 디스크 / 업로드 폴더 크기 ----
let uploadsSizeCache = { at: 0, bytes: null };
async function folderSize(dir) {
    let total = 0;
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        let entries;
        try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch (e) { continue; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) stack.push(p);
            else { try { total += (await fs.promises.stat(p)).size; } catch (err) { /* 읽는 중 지워진 파일 */ } }
        }
    }
    return total;
}
async function diskInfo() {
    const out = { uploadsDir: config.uploadDir, freeBytes: null, totalBytes: null, uploadsBytes: null };
    try {
        if (typeof fs.promises.statfs === 'function') {
            const st = await fs.promises.statfs(config.uploadDir);
            out.freeBytes = Number(st.bavail) * Number(st.bsize);
            out.totalBytes = Number(st.blocks) * Number(st.bsize);
        }
    } catch (e) { /* 디스크 정보를 못 읽어도 나머지는 보여준다 */ }
    // 폴더 전체를 훑는 작업이라 5분간 결과를 재사용한다.
    if (Date.now() - uploadsSizeCache.at > 5 * 60 * 1000) {
        uploadsSizeCache = { at: Date.now(), bytes: await folderSize(config.uploadDir) };
    }
    out.uploadsBytes = uploadsSizeCache.bytes;
    return out;
}

// ---- 백업 상태 ----
// deploy/backup-prod.ps1(운영)은 <BackupRoot>\\yyyyMMdd_HHmmss 폴더와 backup.log를, backup-db.bat(개발 PC)은 날짜 폴더만 만든다.
// 가장 최근 폴더의 시각과 backup.log의 마지막 결과로 판정한다. 36시간 넘게 새 백업이 없으면 주의, 72시간이면 위험.
async function backupStatus() {
    const root = config.backupRoot;
    if (!root) return { state: 'unknown', message: '백업 폴더가 설정되지 않았습니다(.env의 BACKUP_ROOT).' };
    let names;
    try {
        names = (await fs.promises.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && /^\d{8}_\d{6}$/.test(e.name)).map((e) => e.name).sort();
    } catch (e) {
        return { state: 'unknown', root, message: '백업 폴더를 찾을 수 없습니다. BACKUP_ROOT 설정과 폴더 접근 권한을 확인하세요.' };
    }
    const info = { root, count: names.length, state: 'ok' };
    if (names.length) {
        const n = names[names.length - 1];
        // 폴더 이름은 서버 로컬 시간 기준(yyyyMMdd_HHmmss)이다.
        const t = new Date(+n.slice(0, 4), +n.slice(4, 6) - 1, +n.slice(6, 8), +n.slice(9, 11), +n.slice(11, 13), +n.slice(13, 15));
        info.lastAt = t.toISOString();
        info.ageHours = Math.round(((Date.now() - t.getTime()) / 3600000) * 10) / 10;
    }
    // backup.log의 마지막 결과(성공/실패)
    try {
        const log = await fs.promises.readFile(path.join(root, 'backup.log'), 'utf8');
        const lines = log.trim().split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i--) {
            if (/backup finished OK/i.test(lines[i])) { info.lastResult = 'ok'; break; }
            if (/BACKUP FAILED/i.test(lines[i])) { info.lastResult = 'failed'; info.lastError = lines[i].replace(/^\S+ \S+ /, '').slice(0, 200); break; }
        }
    } catch (e) { /* backup.log가 없으면(개발 PC) 폴더 시각만으로 판단 */ }

    if (info.lastResult === 'failed') info.state = 'error';
    else if (!names.length) { info.state = 'warn'; info.message = '아직 만들어진 백업이 없습니다.'; }
    else if (info.ageHours > 72) info.state = 'error';
    else if (info.ageHours > 36) info.state = 'warn';
    return info;
}

router.get('/', async (req, res) => {
    const userSigungu = req.session.user.sigunguCode || null;
    const scope = userSigungu ? ' WHERE sigungu_code = $1 OR sigungu_code IS NULL' : '';
    const p = userSigungu ? [userSigungu] : [];

    const [secRows, facilityCounts, fileCounts, sectorCount, recent, pending, logins, disk, backup] = await Promise.all([
        pool.query(`SELECT road_rank_name, route_no, route_name, COUNT(*)::int AS sections FROM road_sections${scope} GROUP BY road_rank_name, route_no, route_name`, p),
        Promise.all(FACILITY_TABLES.map(async (t) => {
            try { return Number((await pool.query(`SELECT COUNT(*) AS n FROM ${t}${scope}`, p)).rows[0].n); } catch (e) { return 0; }
        })),
        Promise.all([
            pool.query(`SELECT COUNT(*)::int AS n FROM route_files${scope}`, p),
            pool.query(`SELECT COUNT(*)::int AS n FROM gov_facility_files${scope}`, p),
        ]),
        pool.query(`SELECT COUNT(*)::int AS n FROM road_sectors${scope}`, p),
        pool.query(
            `SELECT id, action, summary, username, created_at FROM audit_log
             WHERE action IN ('bulk_import','bulk_undo','export','delete','create','update','approve')
               ${userSigungu ? 'AND (sigungu_code = $1 OR sigungu_code IS NULL)' : ''}
             ORDER BY id DESC LIMIT 8`, p
        ),
        pool.query(`SELECT COUNT(*)::int AS n FROM accounts WHERE status = 'pending'`),
        pool.query(
            `SELECT action, COUNT(*)::int AS n FROM audit_log
             WHERE action IN ('login','login_fail') AND created_at > now() - interval '24 hours' GROUP BY action`
        ),
        diskInfo(),
        backupStatus(),
    ]);

    // 도로종류별 노선/구간 수
    const byGrade = new Map();
    for (const r of secRows.rows) {
        if (!byGrade.has(r.road_rank_name)) byGrade.set(r.road_rank_name, { roadGrade: r.road_rank_name, routes: 0, sections: 0 });
        const g = byGrade.get(r.road_rank_name);
        g.routes++; g.sections += r.sections;
    }
    const loginMap = Object.fromEntries(logins.rows.map((r) => [r.action, r.n]));
    const job = getRunningBulkJob();

    res.json({
        counts: {
            routes: secRows.rows.length,
            sections: secRows.rows.reduce((s, r) => s + r.sections, 0),
            facilities: facilityCounts.reduce((s, n) => s + n, 0),
            drawings: fileCounts[0].rows[0].n,
            attachments: fileCounts[1].rows[0].n,
            sectors: sectorCount.rows[0].n,
        },
        byGrade: [...byGrade.values()].sort((a, b) => b.sections - a.sections),
        recent: recent.rows,
        pendingAccounts: pending.rows[0].n,
        logins24h: { ok: loginMap.login || 0, fail: loginMap.login_fail || 0 },
        disk, backup,
        runningJob: job ? { stage: job.stage, done: job.done, total: job.total, currentRoute: job.currentRoute } : null,
        generatedAt: new Date().toISOString(),
    });
});

module.exports = router;
