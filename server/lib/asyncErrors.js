// Express 4는 async 핸들러가 던진 오류(거부된 Promise)를 잡지 못한다. 그 오류는
// "처리되지 않은 Promise 거부"가 되고, Node 15+는 이 경우 프로세스를 종료한다 —
// 실제로 잘못된 ID 하나(/api/sections/facility-files/abc → DB 형변환 오류)로 서버 전체가
// 내려가는 것을 확인했다. 라우트마다 try/catch를 다는 대신, 모든 핸들러의 반환값이
// Promise면 그 거부를 next(err)로 넘겨 index.js의 전역 에러 핸들러(500 응답)로 보낸다.
// (express-async-errors 패키지와 같은 방식. Express 5로 올리면 기본 동작이라 필요 없어짐.)
const Layer = require('express/lib/router/layer');

function install() {
    Layer.prototype.handle_request = function handleRequest(req, res, next) {
        const fn = this.handle;
        if (fn.length > 3) return next(); // 에러 처리 미들웨어(err, req, res, next)는 원래대로 건너뜀
        try {
            const ret = fn(req, res, next);
            if (ret && typeof ret.catch === 'function') ret.catch(next);
        } catch (err) {
            next(err);
        }
    };

    // 요청 밖(타이머 등)에서 난 거부까지 프로세스를 죽이지 않도록 기록만 남긴다.
    process.on('unhandledRejection', (reason) => {
        console.error('[unhandledRejection]', reason);
    });
}

module.exports = { install };
