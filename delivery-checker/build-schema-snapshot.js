// 검수 프로그램이 DB 없이 돌 수 있게, 서버 DB의 시설물 테이블 컬럼 정보(컬럼 목록 + 필수 컬럼)를
// schema-snapshot.json으로 저장한다. DB 스키마(server/db/gov_facility_schema.sql)가 바뀌면 이 스크립트를
// 개발 PC에서 다시 실행해서 snapshot을 갱신하고 검수 프로그램을 다시 만든다.
//
//   사용:  cd server && node ../delivery-checker/build-schema-snapshot.js     (server/.env의 DB에 접속 — 반드시 server 폴더에서 실행)
const fs = require('fs');
const path = require('path');
const { GOV_LAYER_MAP } = require('../server/lib/govLayerMap');
const pool = require('../server/db');

(async () => {
    const tables = {};
    const names = [...new Set(Object.values(GOV_LAYER_MAP).map((l) => l.table))];
    for (const table of names) {
        const { rows } = await pool.query(
            `SELECT column_name, is_nullable, column_default
             FROM information_schema.columns WHERE table_schema='public' AND table_name = $1 ORDER BY ordinal_position`,
            [table]
        );
        if (!rows.length) { console.warn('테이블 없음(건너뜀):', table); continue; }
        tables[table] = {
            columns: rows.map((r) => r.column_name),
            required: rows.filter((r) => r.is_nullable === 'NO' && r.column_default === null).map((r) => r.column_name),
        };
    }
    const out = path.join(__dirname, 'schema-snapshot.json');
    fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), tables }, null, 1));
    console.log(`저장: ${out} (테이블 ${Object.keys(tables).length}개)`);
    await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
