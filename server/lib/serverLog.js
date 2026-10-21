// 서버 운영 로그 파일 — console.log/info/warn/error 출력을 화면(PM2/NSSM 로그)에는
// 그대로 두면서, 같은 내용을 server/logs/app-YYYY-MM-DD.log 에 날짜별로 따로
// 저장하고 LOG_RETENTION_DAYS(기본 365일)가 지난 파일은 자동으로 지운다.
// PM2·NSSM 어느 쪽으로 구동하든(폐쇄망이라 pm2-logrotate 같은 모듈을 못 깔아도)
// 앱 자체가 로그 분리·보관기간을 책임지게 하려는 것 — 이게 없으면 out.log가
// 무한히 커진다. 비밀번호 등 비밀값은 애초에 console에 찍지 않는다(호출부 규칙).
const fs = require('fs');
const path = require('path');
const util = require('util');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const RETENTION_DAYS = Math.max(1, parseInt(process.env.LOG_RETENTION_DAYS, 10) || 365);
const FILE_RE = /^app-(\d{4}-\d{2}-\d{2})\.log$/;

let currentDate = '';
let stream = null;

function pad(n) { return String(n).padStart(2, '0'); }
function stamp(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function ensureStream(now) {
    const date = stamp(now);
    if (date === currentDate && stream) return stream;
    if (stream) stream.end();
    fs.mkdirSync(LOG_DIR, { recursive: true });
    stream = fs.createWriteStream(path.join(LOG_DIR, `app-${date}.log`), { flags: 'a' });
    stream.on('error', () => { /* 로그 파일 쓰기 실패가 서비스를 멈추게 하면 안 된다 */ });
    currentDate = date;
    return stream;
}

function purgeOldLogs() {
    try {
        const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
        for (const name of fs.readdirSync(LOG_DIR)) {
            const m = FILE_RE.exec(name);
            if (!m) continue;
            const t = new Date(m[1] + 'T00:00:00').getTime();
            if (!Number.isNaN(t) && t < cutoff) fs.unlinkSync(path.join(LOG_DIR, name));
        }
    } catch (e) { /* 폴더가 아직 없거나 권한 문제면 다음 주기에 다시 시도 */ }
}

function writeLine(level, args) {
    try {
        const now = new Date();
        const time = `${stamp(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        ensureStream(now).write(`${time} [${level}] ${util.format(...args)}\n`);
    } catch (e) { /* 위와 같은 이유로 조용히 무시 */ }
}

// console을 감싼다 — 원래 출력은 그대로 하고 파일에도 한 줄 더 남긴다.
function install() {
    for (const [method, level] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
        const original = console[method].bind(console);
        console[method] = (...args) => {
            original(...args);
            writeLine(level, args);
        };
    }
    purgeOldLogs();
    setInterval(purgeOldLogs, 24 * 60 * 60 * 1000).unref();
}

module.exports = { install, LOG_DIR, RETENTION_DAYS };
