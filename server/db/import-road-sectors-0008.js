// 군도0008(월산-와우)의 500m 단위 SHP를 미리 파싱해둔 road_sectors_0008.json을
// road_sectors 테이블에 적재한다. road_sections에서 (route_no, sect)로 그 PC의
// road_rank_code/sigungu_code를 찾아 채우므로, 이 PC에 같은 도로가 등록돼 있지
// 않으면 그냥 건너뛴다(에러 없이 조용히 스킵 — 여러 PC에 그대로 재사용해도 안전).
// 사용법: cd server && node db/import-road-sectors-0008.js
const fs = require('fs');
const path = require('path');
const pool = require('../db');

async function main() {
    const dataPath = path.join(__dirname, 'road_sectors_0008.json');
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

    const keyCache = {};
    async function resolveKey(roadNo, sect3) {
        const cacheKey = `${roadNo}|${sect3}`;
        if (cacheKey in keyCache) return keyCache[cacheKey];
        const r = await pool.query(
            'SELECT road_rank_code, sigungu_code FROM road_sections WHERE route_no = $1 AND sect = $2 LIMIT 1',
            [roadNo, sect3]
        );
        keyCache[cacheKey] = r.rows[0]
            ? { road_rank_code: r.rows[0].road_rank_code, sigungu_code: r.rows[0].sigungu_code }
            : null;
        return keyCache[cacheKey];
    }

    let inserted = 0;
    let skipped = 0;
    for (const rec of data) {
        const sect3 = rec.sect.padStart(3, '0');
        const key = await resolveKey(rec.road_no, sect3);
        if (!key) { skipped++; continue; }

        const exists = await pool.query(
            'SELECT 1 FROM road_sectors WHERE road_rank_code = $1 AND road_no = $2 AND sect = $3 AND sect_st = $4',
            [key.road_rank_code, rec.road_no, sect3, rec.sect_st]
        );
        if (exists.rows.length) { skipped++; continue; } // 이미 적재됐으면 중복 삽입 방지

        const geojson = { type: 'LineString', coordinates: rec.coords };
        await pool.query(
            `INSERT INTO road_sectors (road_rank_code, road_no, sect, sect_st, sect_ed, sect_len, geom, sigungu_code)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [key.road_rank_code, rec.road_no, sect3, rec.sect_st, rec.sect_ed, rec.sect_len, JSON.stringify(geojson), key.sigungu_code]
        );
        inserted++;
    }
    console.log(`road_sectors 적재 완료: ${inserted}건 삽입, ${skipped}건 스킵(매칭되는 구간이 없거나 이미 있음)`);
    await pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
