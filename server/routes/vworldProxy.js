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

    https
        .get(target, { headers: { Referer: config.vworld.referer } }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, {
                'Content-Type': proxyRes.headers['content-type'] || 'application/json',
            });
            proxyRes.pipe(res);
        })
        .on('error', (err) => {
            res.status(502).send(err.message);
        });
});

// 프론트엔드가 VWorld API 키를 몰라도 되도록, 키가 필요한 부분은
// 서버가 채워 넣는 헬퍼 엔드포인트. 프론트는 /api/vworld/key 로 현재 배포의
// 키만 받아서 URL을 구성한다 (WMTS 타일처럼 프록시를 거치기 애매한 경우용).
router.get('/key', (req, res) => {
    res.json({ apiKey: config.vworld.apiKey });
});

module.exports = router;
