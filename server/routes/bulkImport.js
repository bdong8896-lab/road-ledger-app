// 일괄등록(SHP/DBF 표준 데이터 업로드) API. 미리보기(검수) → 확정의 2단계
// 흐름이다: /preview는 zip을 풀어서 파싱 결과만 보여주고 DB는 건드리지
// 않으며, /confirm이 같은 staging 폴더를 다시 파싱해서 실제로 저장한다.
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const config = require('../config');
const { requireAdmin } = require('../middleware/requireAuth');
const { parseDelivery } = require('../lib/bulkImportParse');
const {
    createEmptyStaging, extractZip, getExtractDir, cleanup, sweepOldStagingDirs,
    resolveIncomingDir, mergeIncomingDir, stageFromIncomingDir, listIncomingFolders,
    getIncomingSourceOfUpload,
} = require('../lib/bulkImportStaging');
const { syncRoadSection } = require('../lib/govSectionSync');
const { findFacilityAttachments, findDrawingFiles } = require('../lib/bulkImportAttachments');
const { parseSectorShpFiles } = require('../lib/bulkImportSectors');
const { convertDwgToDxf } = require('../lib/dwgConvert');
const { logAction } = require('../lib/auditLog');
const { GOV_LAYER_MAP } = require('../lib/govLayerMap');

const KOREAN_NAME_BY_TABLE = Object.fromEntries(
    Object.values(GOV_LAYER_MAP).map((l) => [l.table, l.koreanName])
);

const FACILITY_FILE_KIND_BY_EXT = {
    '.jpg': '사진', '.jpeg': '사진', '.png': '사진', '.gif': '사진', '.bmp': '사진',
    '.pdf': '보고서',
};

// routeFiles.js의 routeDirName()과 동일한 규칙(업로드 디렉터리 분리용) —
// 라우트 파일끼리 서로 require하지 않는 기존 관례를 따라 여기 그대로 둔다.
function routeDirName(roadGrade, routeNo, routeName) {
    const safe = (s) => String(s || '').replace(/[/\\:*?"<>|]/g, '_').trim();
    return [safe(roadGrade), safe(routeNo), safe(routeName)].filter(Boolean).join('__') || 'unspecified';
}

const router = express.Router();
router.use(requireAdmin); // 이 기능 전체가 관리자 전용(프론트에서도 admin-only-tab)

sweepOldStagingDirs();
setInterval(sweepOldStagingDirs, 60 * 60 * 1000).unref();

const tmpUploadDir = path.join(config.uploadDir, 'bulk-import-tmp');
fs.mkdirSync(tmpUploadDir, { recursive: true });
const upload = multer({
    storage: multer.diskStorage({
        destination: tmpUploadDir,
        filename: (req, file, cb) => cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}.zip`),
    }),
    limits: { fileSize: 500 * 1024 * 1024 }, // 사진 등이 포함된 실제 납품은 수백 MB일 수 있음
});

// "폴더 선택(ZIP 없이)" 업로드용 — 브라우저의 webkitdirectory로 고른 폴더를
// 파일 여러 개로 그대로 올린다(각 파일명에 상대경로가 "관리번호/LAYER/신규/x.dbf"
// 식으로 슬래시 포함해서 들어옴). LAYER/신규(DBF/SHP)만 담는 게 전제라 개별
// 파일은 작지만, 레이어 수만큼 파일 개수는 많을 수 있어 files 제한을 넉넉히 둔다.
const uploadFolder = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024, files: 3000 },
});

function summarizeForPreview(parsed) {
    return {
        deliveryCode: parsed.deliveryCode,
        deliveryCodes: parsed.deliveryCodes,
        dbfMcoCode: parsed.dbfMcoCode,
        unknownLayerCodes: parsed.unknownLayerCodes,
        blockingWarnings: parsed.blockingWarnings,
        layers: parsed.layers.map((l) => ({
            code: l.code, table: l.table, koreanName: l.koreanName,
            newCount: l.newRecords.length, deleteCount: l.deleteRecords.length,
            crs: l.crs, geomType: l.geomType, fieldMatch: l.fieldMatch, warnings: l.warnings,
        })),
        totalNew: parsed.layers.reduce((s, l) => s + l.newRecords.length, 0),
        totalDelete: parsed.layers.reduce((s, l) => s + l.deleteRecords.length, 0),
    };
}

// extractDir이 이미 채워진 뒤(zip 압축해제든, 폴더 업로드 재구성이든, 서버
// incoming 폴더 참조든) 공통으로 하는 일 — 사전 업로드 폴더 병합 + 파싱 +
// 요약. /preview, /preview-folder-upload, /preview-from-folder가 공유한다.
async function buildPreviewPayload(extractDir, incomingFolderName, sessionUser) {
    let mergedLargeFiles = false;
    if (incomingFolderName) {
        const incomingDir = resolveIncomingDir(incomingFolderName);
        if (!incomingDir) {
            throw new Error(`서버(bulk-import-incoming)에서 "${incomingFolderName}" 폴더를 찾을 수 없습니다. SFTP로 먼저 올렸는지 확인하세요.`);
        }
        mergeIncomingDir(incomingDir, extractDir);
        mergedLargeFiles = true;
    }
    const parsed = await parseDelivery(extractDir);
    const largeFileCount = mergedLargeFiles
        ? findFacilityAttachments(extractDir).length + findDrawingFiles(extractDir).length
        : 0;
    const sectors = parseSectorShpFiles(extractDir);
    return {
        suggestedSigunguCode: sessionUser.sigunguCode || null,
        mergedLargeFiles,
        largeFileCount,
        sectorCount: sectors.records.length,
        sectorWarnings: sectors.warnings,
        ...summarizeForPreview(parsed),
    };
}

router.post('/preview', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'zip 파일이 없습니다.' });
    let uploadId;
    try {
        const extracted = extractZip(req.file.path);
        uploadId = extracted.uploadId;
        // 사진/보고서/도면처럼 용량이 큰 파일은 SFTP로 미리 서버에 올려둔
        // 폴더(bulk-import-incoming/<incomingFolderName>)가 있으면 병합한다 —
        // 그러면 웹으로 올리는 zip은 DBF/SHP(수 MB)만 담으면 되고, 큰 파일은
        // HTTP 업로드(IIS 용량 제한)를 거치지 않는다. /confirm은 같은
        // extractDir을 다시 파싱하므로 별도 처리가 필요 없다.
        const payload = await buildPreviewPayload(extracted.extractDir, (req.body.incomingFolderName || '').trim(), req.session.user);
        res.json({ uploadId, ...payload });
    } catch (e) {
        if (uploadId) cleanup(uploadId);
        res.status(400).json({ error: e.message });
    } finally {
        fs.unlink(req.file.path, () => {});
    }
});

// "폴더 선택(ZIP 없이)" 업로드 — 브라우저에서 폴더를 통째로 골라 개별 파일로
// 올리면(각 파일명이 "관리번호/LAYER/신규/x.dbf" 식으로 상대경로 포함) 여기서
// 그 구조를 그대로 재구성한 뒤 /preview와 동일하게 처리한다. zip을 만드는
// 번거로움 없이도 사전 업로드 폴더(incomingFolderName)와 병합할 수 있다.
router.post('/preview-folder-upload', uploadFolder.array('files'), async (req, res) => {
    if (!req.files || !req.files.length) return res.status(400).json({ error: '폴더 안에 파일이 없습니다.' });
    let uploadId;
    try {
        const staged = createEmptyStaging();
        uploadId = staged.uploadId;
        for (const file of req.files) {
            // originalname은 브라우저가 webkitRelativePath를 그대로 파일명으로
            // 보낸 것("관리번호/LAYER/신규/x.dbf") — 맨 앞 폴더명(관리번호 등,
            // 선택한 폴더 자체)은 extractDir이 이미 그 역할이라 제거하고 나머지만
            // 재구성한다. '..' 세그먼트나 빈 경로는 안전을 위해 건너뛴다.
            const parts = String(file.originalname).split('/').filter(Boolean);
            const relParts = parts.length > 1 ? parts.slice(1) : parts;
            if (!relParts.length || relParts.includes('..')) continue;
            const dest = path.join(staged.extractDir, ...relParts);
            if (path.relative(staged.extractDir, dest).startsWith('..')) continue; // 방어적 재검증
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, file.buffer);
        }
        const payload = await buildPreviewPayload(staged.extractDir, (req.body.incomingFolderName || '').trim(), req.session.user);
        res.json({ uploadId, ...payload });
    } catch (e) {
        if (uploadId) cleanup(uploadId);
        res.status(400).json({ error: e.message });
    }
});

// bulk-import-incoming 밑에 SFTP로 미리 올려둔 폴더 목록 — "서버 폴더에서
// 검수" 모드에서 관리자가 고를 수 있는 후보를 보여주는 용도.
router.get('/incoming', (req, res) => {
    res.json({ folders: listIncomingFolders() });
});

// zip 업로드 없이, bulk-import-incoming/<folderName>을 그대로 미리보기
// 대상으로 쓴다. LAYER/신규(DBF/SHP)까지 포함해 납품 폴더 전체를 SFTP로
// 미리 올려둔 경우용 — /preview(zip 업로드)의 대안 경로다. 이후 /confirm은
// uploadId만 있으면 되므로 이 경로로 만든 uploadId도 그대로 동작한다.
router.post('/preview-from-folder', async (req, res) => {
    const folderName = (req.body.folderName || '').trim();
    if (!folderName) return res.status(400).json({ error: '폴더를 선택하세요.' });
    let uploadId;
    try {
        const staged = stageFromIncomingDir(folderName);
        uploadId = staged.uploadId;
        const parsed = await parseDelivery(staged.extractDir);
        const largeFileCount = findFacilityAttachments(staged.extractDir).length + findDrawingFiles(staged.extractDir).length;
        const sectors = parseSectorShpFiles(staged.extractDir);
        res.json({
            uploadId,
            suggestedSigunguCode: req.session.user.sigunguCode || null,
            mergedLargeFiles: true,
            largeFileCount,
            sectorCount: sectors.records.length,
            sectorWarnings: sectors.warnings,
            ...summarizeForPreview(parsed),
        });
    } catch (e) {
        if (uploadId) cleanup(uploadId);
        res.status(400).json({ error: e.message });
    }
});

router.post('/:uploadId/confirm', async (req, res) => {
    const { uploadId } = req.params;
    const targetSigunguCode = (req.body.sigunguCode || '').trim() || null;

    let extractDir;
    try {
        extractDir = getExtractDir(uploadId);
    } catch (e) {
        return res.status(404).json({ error: e.message });
    }

    let parsed;
    try {
        parsed = await parseDelivery(extractDir);
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }
    if (parsed.blockingWarnings.length && !req.body.acknowledgeUnrecognizedCrs) {
        return res.status(400).json({
            error: '좌표계를 인식할 수 없는 레이어가 있습니다. 확인 후 다시 시도하세요.',
            blockingWarnings: parsed.blockingWarnings,
        });
    }

    const client = await pool.connect();
    const inserted = {};
    const deleted = {};
    let roadSectionsUpserted = 0;
    const pkTableMap = new Map(); // 시설물 PK값(rdid/suid) -> gov_* 테이블명
    const syncedSections = []; // { rdid, roadRankName, routeNo, routeName, deliveryRoot }
    try {
        await client.query('BEGIN');
        for (const layer of parsed.layers) {
            // 필수 필드(NOT NULL, 기본값 없음)가 DBF에 아예 없는 레이어는 INSERT하면
            // 제약조건 위반으로 트랜잭션 전체가 죽는다 — bulkImportParse.js가 이미
            // blockingWarnings로 admin에게 경고했으니, 여기서는 이 레이어의 신규
            // 레코드 저장만 건너뛴다(삭제 레코드는 pkColumn만 쓰므로 영향 없이 그대로 처리).
            const skipInsert = layer.fieldMatch.missingRequired.length > 0;

            if (layer.newRecords.length && !skipInsert) {
                for (const { row, geom } of layer.newRecords) {
                    const columns = [...Object.keys(row), 'geom', 'sigungu_code'];
                    const values = [...Object.values(row), geom ? JSON.stringify(geom) : null, targetSigunguCode];
                    const placeholders = columns.map((_, i) => `$${i + 1}`).join(',');
                    const updateSet = columns
                        .filter((c) => c !== layer.pkColumn)
                        .map((c) => `${c} = EXCLUDED.${c}`)
                        .join(', ');
                    await client.query(
                        `INSERT INTO ${layer.table} (${columns.join(',')}) VALUES (${placeholders})
                         ON CONFLICT (${layer.pkColumn}) DO UPDATE SET ${updateSet}`,
                        values
                    );
                    const pk = row[layer.pkColumn];
                    if (pk) pkTableMap.set(String(pk), layer.table);
                }
                inserted[layer.table] = layer.newRecords.length;
            }

            if (layer.deleteRecords.length) {
                for (const { row } of layer.deleteRecords) {
                    const pk = row[layer.pkColumn];
                    if (!pk) continue;
                    await client.query(`DELETE FROM ${layer.table} WHERE ${layer.pkColumn} = $1`, [pk]);
                }
                deleted[layer.table] = layer.deleteRecords.length;
            }
        }

        // road_sections 동기화 — zip 하나에 노선(납품 폴더)이 여러 개 있을 수
        // 있어(bulkImportParse.js), 레이어 루프와 분리해 parsed.sectionRecords를
        // 전부 순회한다. 예전엔 레이어 루프 안에서 A0020000의 newRecords만
        // 돌았는데, 납품 폴더가 여러 개면 같은 레이어 코드의 레코드가 하나로
        // 합쳐지기 전에도(즉 이 버그를 고치기 전에도) 구간이 하나만 등록되는
        // 문제가 있었다 — sectionRecords는 납품 루트별로 구분해서 만들어지므로
        // 이제 전부 등록된다.
        for (const { deliveryRoot, row, geom } of parsed.sectionRecords) {
            const synced = await syncRoadSection(client, { row, geom }, targetSigunguCode, req.session.user.id);
            syncedSections.push({ ...synced, deliveryRoot });
            roadSectionsUpserted++;
        }

        // 500m 구간(road_sectors) 저장 — 위 road_sections 동기화가 끝난 뒤에
        // 돌아야, 이번 zip에 같이 실려온 노선도 바로 (route_no, sect) 매칭이
        // 된다. road_sections에 해당 노선이 아예 없으면(이 PC에 등록 안 된
        // 노선) 조용히 skip한다 — import-road-sectors-0008.js의 기존 원칙과 동일.
        let sectorsInserted = 0;
        let sectorsSkipped = 0;
        const sectorKeyCache = new Map();
        for (const rec of parseSectorShpFiles(extractDir).records) {
            const cacheKey = `${rec.roadNo}|${rec.sect}`;
            let key = sectorKeyCache.get(cacheKey);
            if (key === undefined) {
                const r = await client.query(
                    'SELECT road_rank_code, sigungu_code FROM road_sections WHERE route_no = $1 AND sect = $2 LIMIT 1',
                    [rec.roadNo, rec.sect]
                );
                key = r.rows[0] ? { road_rank_code: r.rows[0].road_rank_code, sigungu_code: r.rows[0].sigungu_code } : null;
                sectorKeyCache.set(cacheKey, key);
            }
            if (!key) { sectorsSkipped++; continue; }
            await client.query(
                `INSERT INTO road_sectors (road_rank_code, road_no, sect, sect_st, sect_ed, sect_len, geom, sigungu_code)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                 ON CONFLICT (road_rank_code, road_no, sect, sect_st)
                 DO UPDATE SET sect_ed = EXCLUDED.sect_ed, sect_len = EXCLUDED.sect_len,
                     geom = EXCLUDED.geom, sigungu_code = EXCLUDED.sigungu_code`,
                [key.road_rank_code, rec.roadNo, rec.sect, rec.sectSt, rec.sectEd, rec.sectLen, JSON.stringify(rec.geom), key.sigungu_code]
            );
            sectorsInserted++;
        }

        // 시설물 사진/보고서 자동 연결 — 파일명(확장자 제외)이 방금 저장한
        // gov_* 레코드의 PK와 정확히 일치하는 경우만 매칭한다(실제 납품
        // 데이터로 검증된 규칙, server/lib/govSectionSync.js 주석 참고).
        // 주의: 같은 시설물에 "원본사진"/"표지사진"처럼 하위 폴더별로 서로
        // 다른 사진이 같은 파일명으로 들어오는 경우가 실제 납품에 있어서
        // (PHOTO/원본사진/R23....jpg, PHOTO/표지사진/R23....jpg 둘 다 존재),
        // 상위 폴더명이 PHOTO/STR가 아니면(=하위 분류 폴더가 있으면) 파일명
        // 앞에 그 폴더명을 붙여 서로 다른 첨부로 구분해서 저장한다.
        let facilityFilesAttached = 0;
        const facilityFilesUnmatched = [];
        for (const filePath of findFacilityAttachments(extractDir)) {
            const base = path.basename(filePath);
            const ext = path.extname(base).toLowerCase();
            const pkCandidate = base.slice(0, base.length - ext.length);
            const table = pkTableMap.get(pkCandidate);
            const fileKind = FACILITY_FILE_KIND_BY_EXT[ext];
            const parentFolder = path.basename(path.dirname(filePath));
            const displayName = ['PHOTO', 'STR'].includes(parentFolder) ? base : `${parentFolder}_${base}`;
            if (!table || !fileKind) {
                facilityFilesUnmatched.push(base);
                continue;
            }
            const dir = path.join(config.uploadDir, 'gov-facility-files', targetSigunguCode || 'unassigned', table);
            fs.mkdirSync(dir, { recursive: true });
            const storedPath = path.join(dir, `${Date.now()}_${displayName.replace(/[/\\]/g, '_')}`);
            fs.copyFileSync(filePath, storedPath);
            await client.query(
                `INSERT INTO gov_facility_files (facility_table, facility_rdid, file_kind, original_name, stored_path, sigungu_code, uploaded_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (facility_table, facility_rdid, original_name)
                 DO UPDATE SET stored_path = EXCLUDED.stored_path, sigungu_code = EXCLUDED.sigungu_code,
                     uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
                [table, pkCandidate, fileKind, displayName, storedPath, targetSigunguCode, req.session.user.id]
            );
            facilityFilesAttached++;
        }

        // 도면(DXF/DWG) 자동 연결 — 납품 루트(zip 안의 노선 폴더)별로 도면을
        // 그 루트에 딸린 구간에만 연결한다. 한 루트에 구간이 정확히 1개일 때만
        // (보통 그렇다) 자동 연결하고, 0개/2개 이상이면 그 루트는 건너뛴다
        // (어느 구간 도면인지 특정할 수 없음). zip 하나에 노선이 여러 개
        // 있어도 각자 자기 루트의 ETC/TOP만 보므로 서로 섞이지 않는다.
        const sectionsByRoot = new Map();
        for (const s of syncedSections) {
            if (!sectionsByRoot.has(s.deliveryRoot)) sectionsByRoot.set(s.deliveryRoot, []);
            sectionsByRoot.get(s.deliveryRoot).push(s);
        }

        let drawingFilesAttached = 0;
        for (const [deliveryRoot, sections] of sectionsByRoot) {
            if (sections.length !== 1) continue;
            const section = sections[0];
            const dir = path.join(config.uploadDir, 'routes', routeDirName(section.roadRankName, section.routeNo, section.routeName));
            for (const filePath of findDrawingFiles(deliveryRoot)) {
                const base = path.basename(filePath);
                fs.mkdirSync(dir, { recursive: true });
                const storedPath = path.join(dir, `${Date.now()}_${base.replace(/[/\\]/g, '_')}`);
                fs.copyFileSync(filePath, storedPath);
                let convertedPath = null;
                if (/\.dwg$/i.test(base)) {
                    const candidate = storedPath.replace(/\.dwg$/i, '.dxf');
                    if (await convertDwgToDxf(storedPath, candidate)) convertedPath = candidate;
                }
                // route_files는 원래 수동 업로드 전용이라 중복 방지 제약이 없다(동일
                // 파일을 여러 번 올려 이력으로 남기는 것도 허용하는 설계). 하지만
                // 일괄등록은 같은 zip을 재확정(재검수)할 수도 있으므로, 이 자동 연결
                // 경로에서만 같은 구간+같은 파일명의 기존 행을 지우고 새로 넣어
                // 중복 누적을 막는다.
                await client.query(
                    `DELETE FROM route_files WHERE section_rdid = $1 AND file_category = '도면종류' AND original_name = $2`,
                    [section.rdid, base]
                );
                await client.query(
                    `INSERT INTO route_files (road_grade, route_no, route_name, section_rdid, file_category, original_name, stored_path, converted_path, uploaded_by, sigungu_code)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                    [section.roadRankName, section.routeNo, section.routeName, section.rdid, '도면종류', base, storedPath, convertedPath, req.session.user.id, targetSigunguCode]
                );
                drawingFilesAttached++;
            }
        }

        await client.query('COMMIT');
        // "서버 폴더에서 검수"로 만든 uploadId면(zip 업로드가 아니라
        // bulk-import-incoming을 직접 참조한 경우) 등록이 끝났으니 원본 폴더를
        // 지운다 — cleanup(마커 삭제) 전에 먼저 원본 경로를 읽어와야 한다.
        const incomingSource = getIncomingSourceOfUpload(uploadId);
        cleanup(uploadId);
        if (incomingSource) {
            try { fs.rmSync(incomingSource, { recursive: true, force: true }); } catch (e) { /* 무시 */ }
        }

        // 일괄등록은 기존 시설물 데이터를 upsert(덮어쓰기)하므로, 어느 관리자가
        // 언제 무엇을 얼마나 반영했는지 감사 로그에 요약 1건으로 남긴다(레코드
        // 단위로 남기면 수천 건씩 쌓여 노이즈가 크므로 배치 단위 요약만).
        const insertedParts = Object.entries(inserted).map(([t, c]) => `${KOREAN_NAME_BY_TABLE[t] || t} ${c}건`);
        const deletedParts = Object.entries(deleted).map(([t, c]) => `${KOREAN_NAME_BY_TABLE[t] || t} ${c}건 삭제`);
        const summary = [`일괄등록: 구간 ${roadSectionsUpserted}건`, ...insertedParts, ...deletedParts,
            facilityFilesAttached ? `첨부 ${facilityFilesAttached}건` : null, drawingFilesAttached ? `도면 ${drawingFilesAttached}건` : null,
            sectorsInserted ? `500m 구간 ${sectorsInserted}건` : null]
            .filter(Boolean).join(', ');
        await logAction(null, {
            action: 'bulk_import', targetTable: 'road_sections', targetId: null,
            summary,
            detail: { inserted, deleted, roadSectionsUpserted, facilityFilesAttached, drawingFilesAttached, sectorsInserted, sectorsSkipped },
            sigunguCode: targetSigunguCode, user: req.session.user,
        });

        res.json({
            ok: true, inserted, deleted, roadSectionsUpserted,
            facilityFilesAttached, facilityFilesUnmatched, drawingFilesAttached,
            sectorsInserted, sectorsSkipped,
            incomingFolderRemoved: !!incomingSource,
        });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: `저장 중 오류가 발생했습니다: ${e.message}` });
    } finally {
        client.release();
    }
});

router.delete('/:uploadId', (req, res) => {
    try {
        cleanup(req.params.uploadId);
    } catch (e) { /* 이미 없어도 무시 */ }
    res.json({ ok: true });
});

module.exports = router;
