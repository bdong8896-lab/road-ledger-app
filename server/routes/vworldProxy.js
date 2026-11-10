// VWorld CORS 프록시 — 기존 vworld-proxy.js의 "Referer 헤더 고정" 트릭을 이식.
// 프론트엔드는 이 서버로만 요청하고, 이 서버가 VWorld에 등록된 Referer를 실어
// 대신 요청한다. 사이트별 IP가 달라도 .env의 VWORLD_REFERER/VWORLD_API_KEY만
// 바꾸면 그대로 동작한다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const https = require('https');
const config = require('../config');

const router = express.Router();

// ---------- 배경지도 타일 보관(서버 디스크) ----------
// 타일 한 장마다 "PC → 이 서버 → 브이월드"를 다녀오는 게 지도가 늦게 뜨는 가장 큰 이유라, 한 번 받은 타일은
// 서버에 두고 다음 요청엔 바로 내보낸다. 브라우저 캐시는 PC마다 따로라서 처음 보는 지역은 사람마다 다시 받았다.
//  · 대상: WMTS 배경지도 타일(.../wmts/1.0.0/{키}/{종류}/{z}/{y}/{x}.png|jpeg)만. 지적·도로망(WFS)이나 검색은 보관하지 않는다.
//  · 기한: 브이월드가 응답에 적어 준 max-age 까지만(상한 7일). max-age가 없거나 private/no-store면 보관하지 않는다.
//    파일의 수정시각을 "만료시각"으로 적어 두고, 지난 파일은 시작할 때와 6시간마다 지운다.
//  · 파일 경로는 종류/z/y/x 숫자로만 만든다(주소에 든 API 키는 경로에 넣지 않는다).
const TILE_URL_RE = /^https:\/\/api\.vworld\.kr\/req\/wmts\/1\.0\.0\/[^/?#]+\/([A-Za-z]{1,20})\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})\.(png|jpeg)$/;
const TILE_TYPES = { png: 'image/png', jpeg: 'image/jpeg' };
const TILE_MAX_AGE_CAP_SEC = 7 * 24 * 60 * 60;
const TILE_MAX_BYTES = 2 * 1024 * 1024;

function tileFileFor(target) {
    if (!config.tileCache.enabled) return null;
    const m = TILE_URL_RE.exec(target);
    if (!m) return null;
    const [, layer, z, y, x, ext] = m;
    return { file: path.join(config.tileCache.dir, layer, z, y, `${x}.${ext}`), type: TILE_TYPES[ext] };
}

// 응답의 Cache-Control에서 서버에 보관해도 되는 시간(초)을 읽는다. 보관하면 안 되는 응답이면 0.
function storableSeconds(cacheControl) {
    const cc = String(cacheControl || '').toLowerCase();
    if (!cc || /\b(private|no-store|no-cache)\b/.test(cc)) return 0;
    const m = /\bmax-age\s*=\s*(\d+)/.exec(cc);
    return m ? Math.min(Number(m[1]), TILE_MAX_AGE_CAP_SEC) : 0;
}

// 보관된 타일이 있고 아직 기한 전이면 그대로 내보낸다. 내보냈으면 true.
async function sendStoredTile(tile, res) {
    let stat;
    try { stat = await fs.promises.stat(tile.file); } catch (e) { return false; }
    const remainSec = Math.floor((stat.mtimeMs - Date.now()) / 1000);
    if (remainSec <= 0 || !stat.size) return false;
    res.writeHead(200, {
        'Content-Type': tile.type,
        'Content-Length': stat.size,
        'Cache-Control': `public, max-age=${remainSec}`, // 브라우저도 남은 기한만큼만 보관
    });
    fs.createReadStream(tile.file).on('error', () => res.destroy()).pipe(res);
    return true;
}

// 임시 파일에 쓰고 이름을 바꿔서, 쓰는 도중의 반쪽 파일이 다른 요청에 나가지 않게 한다. 실패해도 지도 표시엔 영향 없다.
async function storeTile(tile, body, seconds) {
    const tmp = `${tile.file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        await fs.promises.mkdir(path.dirname(tile.file), { recursive: true });
        await fs.promises.writeFile(tmp, body);
        const expires = new Date(Date.now() + seconds * 1000);
        await fs.promises.utimes(tmp, new Date(), expires);
        await fs.promises.rename(tmp, tile.file);
    } catch (e) {
        fs.promises.unlink(tmp).catch(() => {});
        if (!storeTile.warned) { storeTile.warned = true; console.warn('[tile-cache] 타일 보관 실패(지도는 정상 동작):', e.message); }
    }
}

// 기한이 지난 타일과 쓰다 남은 임시 파일을 지운다.
async function purgeExpiredTiles(dir = config.tileCache.dir) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    const now = Date.now();
    for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            await purgeExpiredTiles(full);
            await fs.promises.rmdir(full).catch(() => {}); // 비었을 때만 지워진다
        } else if (ent.isFile()) {
            try {
                const stat = await fs.promises.stat(full);
                // 임시 파일(.tmp)은 수정시각이 만료시각으로 바뀌기 전일 수 있어 만든 지 1시간이 지난 것만 지운다
                const expired = ent.name.endsWith('.tmp') ? now - stat.birthtimeMs > 60 * 60 * 1000 : stat.mtimeMs <= now;
                if (expired) await fs.promises.unlink(full);
            } catch (e) { /* 그 사이 지워졌거나 잠김 — 다음 차례에 */ }
        }
    }
}
if (config.tileCache.enabled) {
    purgeExpiredTiles().catch(() => {});
    setInterval(() => purgeExpiredTiles().catch(() => {}), 6 * 60 * 60 * 1000).unref();
}

router.get('/', async (req, res) => {
    const target = req.query.url;
    if (typeof target !== 'string' || !target.startsWith('https://api.vworld.kr/')) {
        return res.status(400).send('Invalid target');
    }

    const tile = tileFileFor(target);
    if (tile && await sendStoredTile(tile, res)) return;

    // 응답을 안 주는 경우 연결이 무한정 붙잡히지 않도록 끊는다(자원 고갈 방지).
    // 오류 내용(DNS·네트워크 메시지 등 서버 내부 정보)은 응답에 싣지 않고 서버 로그에만 남긴다.
    const request = https.get(target, { headers: { Referer: config.vworld.referer }, timeout: 20000 }, (proxyRes) => {
        // VWorld가 주는 캐시 헤더(타일은 max-age=3일)를 그대로 넘긴다 — 예전엔 Content-Type만
        // 넘겨서 브라우저가 지도를 움직일 때마다 같은 타일을 서버·VWorld에서 다시 받았다
        // (서버 부하 + VWorld 키의 일일 호출 한도 소모).
        const headers = { 'Content-Type': proxyRes.headers['content-type'] || 'application/json' };
        for (const h of ['cache-control', 'expires', 'etag', 'last-modified', 'content-length']) {
            if (proxyRes.headers[h]) headers[h] = proxyRes.headers[h];
        }
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);

        // 사용자에게 보내는 것과 별개로, 정상 이미지 응답이면 모아 뒀다가 서버에 보관한다(오류 응답·안내 문서는 보관하지 않는다).
        const seconds = tile && proxyRes.statusCode === 200 && String(proxyRes.headers['content-type'] || '').startsWith('image/')
            ? storableSeconds(proxyRes.headers['cache-control'])
            : 0;
        if (!seconds) return;
        const chunks = [];
        let size = 0;
        proxyRes.on('data', (chunk) => {
            size += chunk.length;
            if (size <= TILE_MAX_BYTES) chunks.push(chunk);
        });
        proxyRes.on('end', () => {
            if (!proxyRes.complete || !size || size > TILE_MAX_BYTES) return; // 중간에 끊긴 응답은 버린다
            storeTile(tile, Buffer.concat(chunks), seconds);
        });
    });
    request.on('timeout', () => request.destroy(new Error('VWorld timeout')));
    request.on('error', (err) => {
        console.error('[vworld-proxy]', err.message);
        if (res.headersSent) return res.destroy();
        res.status(502).send('VWorld 요청에 실패했습니다.');
    });
});

// 프론트엔드가 VWorld API 키를 몰라도 되도록, 키가 필요한 부분은
// 서버가 채워 넣는 헬퍼 엔드포인트. 프론트는 /api/vworld/key 로 현재 배포의
// 키만 받아서 URL을 구성한다 (WMTS 타일처럼 프록시를 거치기 애매한 경우용).
router.get('/key', (req, res) => {
    res.json({ apiKey: config.vworld.apiKey });
});

module.exports = router;
