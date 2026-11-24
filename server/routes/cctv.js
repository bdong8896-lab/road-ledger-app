// 국가교통정보센터(ITS, openapi.its.go.kr) CCTV API 프록시.
// 키를 프론트엔드에 노출하지 않기 위해 서버가 대신 호출한다.
// 참고: 이 API는 고속도로(ex)·국도(its) CCTV만 제공한다 — 군도/시도 등
// 지자체 관리 소로는 이 데이터에 포함되지 않는다.
const express = require('express');
const https = require('https');
const config = require('../config');

const router = express.Router();
// 외부 API가 응답을 안 주면 연결이 무한정 붙잡히지 않도록 끊는다(자원 고갈 방지).
const UPSTREAM_TIMEOUT_MS = 15000;

function fetchCctv(roadType, bbox) {
    return new Promise((resolve, reject) => {
        const params = new URLSearchParams({
            apiKey: config.itsCctvApiKey,
            type: roadType,
            cctvType: '1',
            minX: bbox.minX, maxX: bbox.maxX, minY: bbox.minY, maxY: bbox.maxY,
            getType: 'json',
        });
        const request = https.get(`https://openapi.its.go.kr:9443/cctvInfo?${params.toString()}`, { timeout: UPSTREAM_TIMEOUT_MS }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
            });
            res.on('error', reject);
        });
        request.on('timeout', () => request.destroy(new Error('ITS CCTV API timeout')));
        request.on('error', reject);
    });
}

// ITS 응답의 response.data 는 보통 배열이지만, 해당 범위에 CCTV 가 1개뿐이거나 오류·안내 응답일 때는
// 배열이 아닌 객체로 오는 경우가 있다 — 그대로 펼치면 "is not iterable" 로 전체가 502 가 되므로 모양을 가려서 받는다.
let warnedShape = false;
function cctvList(result, roadType) {
    const data = result?.response?.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
        if (data.cctvurl || data.coordx !== undefined) return [data];   // 1건짜리 응답
        if (!warnedShape) {                                              // 오류·안내 응답: 한 번만 모양을 남겨 원인 파악에 쓴다
            warnedShape = true;
            console.warn(`[cctv] ${roadType}: 배열이 아닌 응답(${JSON.stringify(data).slice(0, 200)}) — 건너뜁니다.`);
        }
    }
    return [];
}

router.get('/', async (req, res) => {
    const { minX, maxX, minY, maxY } = req.query;
    if (!minX || !maxX || !minY || !maxY) {
        return res.status(400).json({ error: 'minX/maxX/minY/maxY가 필요합니다.' });
    }
    // 좌표는 숫자만 받는다(외부 API로 넘기는 값이라 형식을 서버에서 확인).
    if (![minX, maxX, minY, maxY].every((v) => /^-?\d+(\.\d+)?$/.test(String(v)))) {
        return res.status(400).json({ error: '좌표 형식이 올바르지 않습니다.' });
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
            ...cctvList(exResult, 'ex'),
            ...cctvList(itsResult, 'its'),
        ];
        res.json({ items });
    } catch (err) {
        console.error('[cctv]', err.message);
        res.status(502).json({ error: 'CCTV 정보를 가져오지 못했습니다.' });
    }
});

module.exports = router;
