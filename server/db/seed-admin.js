// 최초 관리자 계정 생성.
// 사용법: node db/seed-admin.js <username> <password> [displayName] [sigunguCode] [sigunguName]
// sigunguCode/sigunguName을 생략하면 모든 시군구 데이터를 다 보는 계정으로 생성된다.
const bcrypt = require('bcryptjs');
const pool = require('../db');

async function main() {
    const [username, password, displayName, sigunguCode, sigunguName] = process.argv.slice(2);
    if (!username || !password) {
        console.error('사용법: node db/seed-admin.js <username> <password> [displayName] [sigunguCode] [sigunguName]');
        process.exit(1);
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
        `INSERT INTO accounts (username, password_hash, display_name, role, sigungu_code, sigungu_name)
         VALUES ($1, $2, $3, 'admin', $4, $5)
         ON CONFLICT (username) DO UPDATE SET
             password_hash = EXCLUDED.password_hash, role = 'admin',
             sigungu_code = EXCLUDED.sigungu_code, sigungu_name = EXCLUDED.sigungu_name`,
        [username, passwordHash, displayName || username, sigunguCode || null, sigunguName || null]
    );
    console.log(`관리자 계정 생성/갱신 완료: ${username}${sigunguName ? ` (${sigunguName})` : ' (전체 시군구)'}`);
    await pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
