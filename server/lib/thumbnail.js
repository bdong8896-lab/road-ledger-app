// 시설물 사진 썸네일 — 사진 한 장이 평균 0.7~1.5MB(2048×2048)라 시설물을 누를 때마다 원본을 받으면 느리다.
// 화면 미리보기는 1000px 이내 JPEG(약 1/5 크기)를 쓰고, 누르면 원본을 연다. 처음 요청할 때 만들어
// uploads/_thumbs에 두고(파일 이름에 원본의 크기·수정시각이 들어가 원본이 바뀌면 새로 만든다) 다음부터는 그 파일을 보낸다.
// sharp(네이티브 모듈)를 못 불러오는 서버에서도 앱은 그대로 동작해야 하므로, 그 경우 null을 돌려 원본을 보내게 한다.
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const config = require('../config');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { console.warn('[thumbnail] sharp를 불러오지 못했습니다 — 사진은 썸네일 없이 원본으로 보냅니다:', e.message); }

const THUMB_DIR = path.join(config.uploadDir, '_thumbs');
const IMAGE_RE = /\.(jpe?g|png|gif|bmp)$/i;
const MAX_SIZE = 1000;

// 한꺼번에 많은 썸네일을 만들면 CPU/메모리를 쓰니 동시에 3개까지만
let running = 0;
const waiters = [];
async function withSlot(fn) {
    if (running >= 3) await new Promise((r) => waiters.push(r));
    running++;
    try { return await fn(); } finally { running--; const next = waiters.shift(); if (next) next(); }
}

// id: gov_facility_files.id. 반환: 썸네일 파일 경로 또는 null(만들 수 없음 → 호출한 쪽이 원본을 보낸다)
async function getThumbPath(id, srcPath) {
    if (!sharp || !IMAGE_RE.test(srcPath)) return null;
    let st;
    try { st = await fs.promises.stat(srcPath); } catch (e) { return null; }
    const out = path.join(THUMB_DIR, `${id}_${MAX_SIZE}_${st.size}_${Math.round(st.mtimeMs)}.jpg`);
    if (fs.existsSync(out)) return out;
    try {
        await fs.promises.mkdir(THUMB_DIR, { recursive: true });
        await withSlot(async () => {
            if (fs.existsSync(out)) return;
            const tmp = `${out}.${process.pid}.${Date.now()}.tmp`;
            await sharp(srcPath, { failOn: 'none' })
                .rotate() // 사진의 회전 정보(EXIF)대로 바로 세운다
                .resize({ width: MAX_SIZE, height: MAX_SIZE, fit: 'inside', withoutEnlargement: true })
                .flatten({ background: '#ffffff' }) // 투명 PNG는 흰 바탕으로
                .jpeg({ quality: 78 })
                .toFile(tmp);
            await fs.promises.rename(tmp, out);
        });
        return out;
    } catch (e) {
        console.warn('[thumbnail] 썸네일을 만들지 못해 원본을 보냅니다:', path.basename(srcPath), e.message);
        return null;
    }
}

// DB에서 지워진 파일의 썸네일과 오래 안 쓴 것(120일)을 정리한다.
async function purgeOrphanThumbs() {
    try {
        if (!fs.existsSync(THUMB_DIR)) return;
        const { rows } = await pool.query('SELECT id FROM gov_facility_files');
        const live = new Set(rows.map((r) => String(r.id)));
        const cutoff = Date.now() - 120 * 24 * 3600 * 1000;
        for (const name of await fs.promises.readdir(THUMB_DIR)) {
            const p = path.join(THUMB_DIR, name);
            const id = name.split('_')[0];
            let st; try { st = await fs.promises.stat(p); } catch (e) { continue; }
            if (name.endsWith('.tmp') ? st.mtimeMs < Date.now() - 3600 * 1000 : (!live.has(id) || st.mtimeMs < cutoff)) {
                fs.rm(p, { force: true }, () => {});
            }
        }
    } catch (e) { console.error('[thumbnail/purge]', e.message); }
}

module.exports = { getThumbPath, purgeOrphanThumbs, IMAGE_RE };
