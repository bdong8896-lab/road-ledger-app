// 변경 이력(감사 로그) 기록 헬퍼. 트랜잭션 안에서 호출하면(client 전달) 같은
// 트랜잭션으로 묶여 원본 작업이 롤백되면 로그도 같이 롤백된다 — 트랜잭션 밖에서
// 호출하면(client 생략) pool을 직접 써서 커밋과 무관하게 즉시 기록된다.
// 실패해도 절대 throw하지 않는다 — 로그 기록 실패(예: 서버에 아직 schema.sql
// 재적용 전이라 audit_log 테이블이 없는 경우) 때문에 원래 하려던 등록/수정/
// 삭제 작업 자체의 응답이 막히거나 Express 4의 unhandled rejection으로
// 서버가 죽는 일이 없어야 한다 — 그래서 호출부에서 매번 try/catch로 감싸는
// 대신 여기서 한 번만 감싼다.
//
// 데이터 변경(create/update/delete/bulk_import)뿐 아니라 접속·계정 이력
// (login, login_fail, logout, signup, approve, account_create, account_delete)도
// 같은 테이블에 남긴다 — 비밀번호 등 비밀값은 summary/detail에 절대 넣지 않는다.
const pool = require('../db');

// 접속 IP — index.js의 `trust proxy` 설정 덕에 IIS(리버스프록시) 뒤에서도
// X-Forwarded-For의 실제 접속자 IP가 req.ip로 온다. IIS의 ARR은 X-Forwarded-For에 "IP:포트"(IPv6는 "[주소]:포트")를
// 붙여 보내므로 포트(접속할 때마다 달라지는 임시 번호)를 떼고 IP만 남긴다. IPv4-mapped IPv6(::ffff:1.2.3.4)도 풀어준다.
function normalizeIp(raw) {
    let ip = String(raw || '').trim();
    const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);       // [::1]:50751
    if (v6) ip = v6[1];
    else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':')); // 1.2.3.4:50751
    return ip.replace(/^::ffff:/i, '').slice(0, 45);
}

function clientIp(req) {
    return normalizeIp(req && req.ip) || null;
}

// 화면·CSV에 보일 IP. 이 서버 자신에서 접속한 것은 구분해서 표시한다:
//   localhost로 접속(::1, 127.0.0.1) → "서버 본체(localhost)",  서버의 자기 IP 주소로 접속 → "서버 본체(192.168.0.211)"
// 다른 PC에서 접속한 것은 그 PC의 IP 그대로. 예전에 포트가 붙어 저장된 기록도 같이 보정해서 보여준다(DB 값은 바꾸지 않음).
function ownAddresses() {
    const out = new Set();
    const ifs = require('os').networkInterfaces();
    Object.values(ifs).forEach((list) => (list || []).forEach((i) => { if (i && i.address) out.add(i.address.replace(/%.*$/, '')); }));
    return out;
}
function displayIp(raw) {
    const ip = normalizeIp(raw);
    if (!ip) return '';
    if (ip === '::1' || ip === '127.0.0.1') return '서버 본체(localhost)';
    if (ownAddresses().has(ip)) return `서버 본체(${ip})`;
    return ip;
}

async function logAction(client, { action, targetTable, targetId, summary, detail, sigunguCode, user, ip }) {
    const q = client || pool;
    try {
        await q.query(
            `INSERT INTO audit_log (action, target_table, target_id, summary, detail, sigungu_code, user_id, username, ip)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
                action, targetTable, targetId || null, summary,
                detail !== undefined ? JSON.stringify(detail) : null,
                sigunguCode || null,
                user ? user.id : null, user && user.username ? String(user.username).slice(0, 50) : null,
                ip || null,
            ]
        );
    } catch (e) {
        console.error('[auditLog] 기록 실패(무시하고 계속 진행):', e.message);
    }
}

module.exports = { logAction, clientIp, normalizeIp, displayIp };
