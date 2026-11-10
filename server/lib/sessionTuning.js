// 세션 저장소(connect-pg-simple)의 DB 왕복을 줄인다. 로그인된 요청은 하나마다 session 테이블을
// 읽고(SELECT) 만료시각을 갱신(UPDATE)하는데, 지도 타일 한 장도 요청 하나라서 지도를 한 번 움직이면
// 그게 수십 번씩 나갔다(타일·API 응답이 그만큼 DB를 기다림).
//
//  1) 만료시각 갱신(touch)은 세션당 몇 분에 한 번만 한다. 건너뛴 동안 DB의 만료시각은 최대 그 간격만큼
//     이르게 남을 뿐이라 로그인 유지시간(기본 8시간)엔 영향이 없다.
//  2) 읽기(get)는 몇 초 동안 메모리에 둔 것을 쓴다. 지도를 움직일 때 한꺼번에 몰리는 타일 요청들이 한 번의
//     조회를 나눠 쓴다. 세션이 바뀌거나(로그인·재인증 등 set) 지워지면(로그아웃 destroy) 바로 버리고,
//     계정 삭제·비밀번호 변경으로 세션을 DB에서 직접 지울 때는 clearSessionReadCache()로 전부 버린다
//     (routes/auth.js destroyUserSessions) — 그래서 강제 로그아웃도 늦어지지 않는다.
//
// 세션 내용이 바뀌는 요청은 touch가 아니라 저장(set)이라 1)의 건너뛰기와 무관하게 바로 기록된다.

const READ_CACHE_MS = 3000;

const readCache = new Map(); // 세션 ID → { json, at }
const writeSeq = new Map();  // 세션 ID → 저장/삭제가 일어난 횟수(읽는 도중 바뀌었는지 판별)

function clearSessionReadCache() {
    readCache.clear();
    for (const sid of writeSeq.keys()) writeSeq.set(sid, writeSeq.get(sid) + 1);
}

function tuneSessionStore(store, { maxAgeMs }) {
    // ---- 1) touch 줄이기 ----
    const touchIntervalMs = Math.min(5 * 60 * 1000, maxAgeMs / 10);
    const lastTouch = new Map(); // 세션 ID → 마지막으로 DB에 갱신한 시각
    const touchInDb = store.touch.bind(store);
    store.touch = (sid, sess, cb) => {
        const now = Date.now();
        const last = lastTouch.get(sid);
        if (last && now - last < touchIntervalMs) return cb && cb(null);
        lastTouch.set(sid, now);
        return touchInDb(sid, sess, cb);
    };

    // ---- 2) get 잠깐 기억하기 ----
    const invalidate = (sid) => {
        readCache.delete(sid);
        writeSeq.set(sid, (writeSeq.get(sid) || 0) + 1);
    };
    const getFromDb = store.get.bind(store);
    store.get = (sid, cb) => {
        const hit = readCache.get(sid);
        if (hit && Date.now() - hit.at < READ_CACHE_MS) {
            let sess;
            try { sess = JSON.parse(hit.json); } catch (e) { sess = null; } // 요청마다 새 객체(express-session이 받은 객체를 고쳐 쓴다)
            if (sess) return cb(null, sess);
        }
        const seqAtStart = writeSeq.get(sid) || 0;
        return getFromDb(sid, (err, sess) => {
            // 읽는 사이에 저장·삭제가 있었으면 방금 읽은 건 옛 값일 수 있으니 기억하지 않는다
            if (!err && sess && (writeSeq.get(sid) || 0) === seqAtStart) {
                try { readCache.set(sid, { json: JSON.stringify(sess), at: Date.now() }); } catch (e) { /* 기억만 못 할 뿐 */ }
            } else if (err || !sess) {
                readCache.delete(sid);
            }
            cb(err, sess);
        });
    };
    const setInDb = store.set.bind(store);
    store.set = (sid, sess, cb) => {
        invalidate(sid);
        return setInDb(sid, sess, (err) => { invalidate(sid); if (cb) cb(err); });
    };
    const destroyInDb = store.destroy.bind(store);
    store.destroy = (sid, cb) => {
        invalidate(sid);
        lastTouch.delete(sid);
        return destroyInDb(sid, (err) => { invalidate(sid); if (cb) cb(err); });
    };

    // 오래된 기록 정리(로그아웃 없이 닫은 세션 등)
    setInterval(() => {
        const now = Date.now();
        for (const [sid, at] of lastTouch) if (now - at > touchIntervalMs) lastTouch.delete(sid);
        for (const [sid, hit] of readCache) if (now - hit.at > READ_CACHE_MS) readCache.delete(sid);
        for (const sid of writeSeq.keys()) if (!readCache.has(sid) && !lastTouch.has(sid)) writeSeq.delete(sid);
    }, 10 * 60 * 1000).unref();

    return store;
}

module.exports = { tuneSessionStore, clearSessionReadCache };
