// 응답 압축(gzip) — 화면 코드(HTML/JS/CSS)와 큰 JSON 응답을 줄여서 보낸다. 텍스트라 보통 1/3~1/5로 줄어든다.
// 외부 패키지를 더하지 않으려고(폐쇄망 배포·오픈소스 목록 관리) Node 기본 zlib만 쓴다.
// 브라우저가 gzip을 받겠다고 한 요청(Accept-Encoding)에만 적용하고, 조건에 안 맞으면 그냥 다음 단계로 넘긴다
// (정적 파일은 뒤의 express.static이, JSON은 원래의 res.json이 예전대로 보낸다).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MIN_BYTES = 1024; // 이보다 작으면 압축 이득이 없다
const STATIC_EXTS = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt']);

function acceptsGzip(req) {
    return /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
}

// 정적 파일용. 파일마다 한 번만 압축해 메모리에 두고(파일이 바뀌면 다시 압축) 그 뒤로는 그대로 내보낸다.
// setHeaders(res, 파일경로): express.static에 주는 것과 같은 캐시 정책 함수 — 압축본에도 똑같이 적용한다.
function gzipStatic(root, setHeaders) {
    const rootDir = path.resolve(root);
    const cache = new Map(); // 파일 경로 → { mtimeMs, size, etag, body: Promise<Buffer> }
    return async function gzipStaticMiddleware(req, res, next) {
        try {
            if ((req.method !== 'GET' && req.method !== 'HEAD') || !acceptsGzip(req) || req.headers.range) return next();
            let rel;
            try { rel = decodeURIComponent(req.path); } catch (e) { return next(); }
            if (rel.includes('\0')) return next();
            if (rel.endsWith('/')) rel += 'index.html';
            // 숨김 파일(.env 등)은 express.static도 내보내지 않는다 — 여기서도 건드리지 않고 넘긴다
            if (rel.split('/').some((seg) => seg.startsWith('.'))) return next();
            const file = path.join(rootDir, rel);
            if (!file.startsWith(rootDir + path.sep)) return next();
            if (!STATIC_EXTS.has(path.extname(file).toLowerCase())) return next();

            let stat;
            try { stat = await fs.promises.stat(file); } catch (e) { return next(); }
            if (!stat.isFile() || stat.size < MIN_BYTES) return next();

            let entry = cache.get(file);
            if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
                entry = {
                    mtimeMs: stat.mtimeMs,
                    size: stat.size,
                    etag: `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}-gz"`,
                    body: fs.promises.readFile(file).then((buf) => new Promise((resolve, reject) => {
                        zlib.gzip(buf, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out)));
                    })),
                };
                cache.set(file, entry);
            }
            let body;
            try { body = await entry.body; } catch (e) { cache.delete(file); return next(); }

            res.type(path.extname(file));
            res.setHeader('Content-Encoding', 'gzip');
            res.setHeader('Vary', 'Accept-Encoding');
            res.setHeader('ETag', entry.etag);
            res.setHeader('Last-Modified', stat.mtime.toUTCString());
            if (setHeaders) setHeaders(res, file);
            if (req.fresh) { // 브라우저가 가진 것과 같다 — 본문 없이 304
                res.removeHeader('Content-Encoding');
                res.removeHeader('Content-Type');
                res.statusCode = 304;
                return res.end();
            }
            res.setHeader('Content-Length', body.length);
            return res.end(req.method === 'HEAD' ? undefined : body);
        } catch (e) {
            return next(); // 어떤 이유로든 실패하면 압축 없이 원래 경로로
        }
    };
}

// API의 JSON 응답용. res.json()이 보내려는 내용이 1KB 이상이면 압축해서 보낸다(노선 트리, 선형, 시설물 목록 등).
function gzipJson(req, res, next) {
    if (!acceptsGzip(req) || req.method === 'HEAD') return next();
    const sendPlain = res.json.bind(res);
    res.json = function gzipJsonSend(obj) {
        let text;
        try { text = JSON.stringify(obj); } catch (e) { return sendPlain(obj); }
        if (typeof text !== 'string' || text.length < MIN_BYTES || res.headersSent || res.getHeader('Content-Encoding')) return sendPlain(obj);
        zlib.gzip(text, { level: 6 }, (err, out) => {
            if (res.headersSent || res.destroyed) return; // 그 사이 다른 응답(오류 등)이 나갔다
            if (err) return sendPlain(obj);
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Encoding', 'gzip');
            res.setHeader('Vary', 'Accept-Encoding');
            res.setHeader('Content-Length', out.length);
            res.end(out);
        });
        return res;
    };
    next();
}

module.exports = { gzipStatic, gzipJson };
