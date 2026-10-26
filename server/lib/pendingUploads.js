// 도면 올리기에서 "이미 있는 파일"(같은 구간·같은 이름)을 따로 빼 두는 곳.
// 같은 이름의 도면을 다시 올리면 예전에는 그냥 쌓이거나(개별 올리기) 말없이 덮어써서 예전 파일이 영구 삭제됐다(자동 인식 올리기).
// 이제는 새 도면은 바로 등록하고, 이미 있는 것과 겹치는 파일은 uploads/_pending-uploads/<토큰>/ 에 보관한 채 기존 파일을 건드리지 않는다.
// 사용자가 "교체"를 고르면 그때 기존 파일을 보관함(_import-trash)으로 옮기고 새 파일로 바꾸며, 이 교체는 일괄등록 이력에 한 건으로 남아
// "이 등록 취소"로 되돌릴 수 있다. "교체 안 함"을 고르거나 하루가 지나면 따로 빼 둔 파일은 지운다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const PENDING_ROOT = path.join(config.uploadDir, '_pending-uploads');
const KEEP_MS = 24 * 60 * 60 * 1000;
const TOKEN_RE = /^[0-9a-f]{16}$/;

const dirOf = (token) => path.join(PENDING_ROOT, token);

// 하루 지난 보관본을 지운다(서버가 도중에 꺼졌거나 사용자가 답하지 않은 경우).
function purgeOld() {
    try {
        if (!fs.existsSync(PENDING_ROOT)) return;
        for (const name of fs.readdirSync(PENDING_ROOT)) {
            const p = path.join(PENDING_ROOT, name);
            try { if (Date.now() - fs.statSync(p).mtimeMs > KEEP_MS) fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* 무시 */ }
        }
    } catch (e) { /* 무시 */ }
}

// items: [{ srcPath, move?, name, route:{roadGrade,routeNo,routeName,sectionRdid}, category, segInfo, sigungu, existing:{id,uploadedAt} }]
// srcPath 파일을 보관 폴더로 옮기거나(move) 복사한다. 반환: 토큰.
function create({ userId, sigungu, items }) {
    purgeOld();
    const token = crypto.randomBytes(8).toString('hex');
    const dir = dirOf(token);
    fs.mkdirSync(dir, { recursive: true });
    const meta = { userId, sigungu: sigungu || null, createdAt: Date.now(), items: [] };
    items.forEach((it, i) => {
        const file = `${i}.bin`;
        const dest = path.join(dir, file);
        if (it.move) {
            try { fs.renameSync(it.srcPath, dest); } catch (e) { fs.copyFileSync(it.srcPath, dest); fs.rmSync(it.srcPath, { force: true }); }
        } else {
            fs.copyFileSync(it.srcPath, dest);
        }
        meta.items.push({ file, name: it.name, route: it.route, category: it.category, segInfo: it.segInfo || null, sigungu: it.sigungu || null, existing: it.existing || null });
    });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
    return token;
}

function load(token) {
    if (!TOKEN_RE.test(String(token))) return null;
    try {
        const meta = JSON.parse(fs.readFileSync(path.join(dirOf(token), 'meta.json'), 'utf8'));
        meta.token = token;
        meta.dir = dirOf(token);
        meta.items.forEach((it) => { it.path = path.join(meta.dir, it.file); });
        return meta;
    } catch (e) { return null; }
}

function remove(token) {
    if (!TOKEN_RE.test(String(token))) return;
    fs.rm(dirOf(token), { recursive: true, force: true }, () => {});
}

module.exports = { create, load, remove, purgeOld };
