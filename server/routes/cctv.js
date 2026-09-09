// 국가교통정보센터(ITS, openapi.its.go.kr) CCTV API 프록시.
// 키를 프론트엔드에 노출하지 않기 위해 서버가 대신 호출한다.
// 참고: 이 API는 고속도로(ex)·국도(its) CCTV만 제공한다 — 군도/시도 등
// 지자체 관리 소로는 이 데이터에 포함되지 않는다.
const express = require('express');
const https = require('https');
const config = require('../config');

const router = express.Router();

function fetchCctv(roadType, bbox) {
    return new Promise((resolve, reject) => {
        const params = new URLSearchParams({
            apiKey: config.itsCctvApiKey,
            type: roadType,
            cctvType: '1',
            minX: bbox.minX, maxX: bbox.maxX, minY: bbox.minY, maxY: bbox.maxY,
            getType: 'json',
        });
        https.get(`https://openapi.its.go.kr:9443/cctvInfo?${params.toString()}`, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
            });
        }).on('error', reject);
    });
}

router.get('/', async (req, res) => {
    const { minX, maxX, minY, maxY } = req.query;
    if (!minX || !maxX || !minY || !maxY) {
        return res.status(400).json({ error: 'minX/maxX/minY/maxY가 필요합니다.' });
    }
    if (!config.itsCctvApiKey) {
        return res.json({ items: [] });
    }

    try {
        const bbox = { minX, maxX, minY, maxY };
        const [exResult, itsResult] = await Promise.all([
            fetchCctv('ex', bbox),
            fetchCctv('its', bbox),
        ]);
        const items = [
            ...(exResult?.response?.data || []),
            ...(itsResult?.response?.data || []),
        ];
        res.json({ items });
    } catch (err) {
        res.status(502).json({ error: 'CCTV 정보를 가져오지 못했습니다.' });
    }
});

module.exports = router;
