// VWorld CORS 프록시 — 기존 vworld-proxy.js의 "Referer 헤더 고정" 트릭을 이식.
// 프론트엔드는 이 서버로만 요청하고, 이 서버가 VWorld에 등록된 Referer를 실어
// 대신 요청한다. 사이트별 IP가 달라도 .env의 VWORLD_REFERER/VWORLD_API_KEY만
// 바꾸면 그대로 동작한다.
const express = require('express');
const https = require('https');
const config = require('../config');

const router = express.Router();

router.get('/', (req, res) => {
    const target = req.query.url;
    if (!target || !target.startsWith('https://api.vworld.kr/')) {
        return res.status(400).send('Invalid target');
    }

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
