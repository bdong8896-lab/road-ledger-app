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
// X-Forwarded-For의 실제 접속자 IP가 req.ip로 온다. IPv4-mapped IPv6
// (::ffff:1.2.3.4)는 보기 좋게 풀어준다.
function clientIp(req) {
    const ip = (req && req.ip) || '';
    return ip.replace(/^::ffff:/, '').slice(0, 45) || null;
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

module.exports = { logAction, clientIp };
