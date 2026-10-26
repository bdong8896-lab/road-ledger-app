// 일괄등록 "확정" 처리 — 백그라운드 작업(job)으로 돌고, 납품 폴더(관리번호 폴더 = 노선) 하나씩 따로 저장한다.
//
// 예전에는 확정 요청 하나가 모든 노선을 DB 트랜잭션 하나로 저장했다. 노선이 많으면:
//   - 요청이 몇 분~십수 분 걸려 IIS 프록시의 응답 대기 시간에 걸려 화면에는 실패로 보이고,
//   - 어느 한 노선이 오류를 내면 전부 취소되고, 이미 복사한 사진은 디스크에 남았다.
// 지금은 (1) 요청은 바로 돌려주고 진행 상황을 job으로 조회하며, (2) 노선마다 트랜잭션을 나눠서 한 노선이 실패해도
// 나머지는 저장하고, (3) 사진/도면은 비동기로 복사하며 노선이 취소되면 그 노선에서 복사한 파일을 지운다.
// 같은 납품을 다시 확정해도 안전하다(레코드는 upsert, 같은 이름의 첨부/도면은 교체하고 옛 파일은 커밋 뒤에 지운다).
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const config = require('../config');
const { routeFilesDir, facilityFilesDir } = require('./uploadPaths');
const { parseDelivery } = require('./bulkImportParse');
const { syncRoadSection } = require('./govSectionSync');
const { findFacilityAttachments, findDrawingFiles, findLooseDrawingFiles } = require('./bulkImportAttachments');
const { autoUploadRouteDrawings } = require('./routeDrawingsBulk');
const { detectRankNameInRoot } = require('./bulkImportRank');
const { parseSectorShpFiles } = require('./bulkImportSectors');
const { convertDwgToDxf } = require('./dwgConvert');
const { logAction } = require('./auditLog');
const { GOV_LAYER_MAP } = require('./govLayerMap');
const { getIncomingSourceOfUpload, cleanup } = require('./bulkImportStaging');
const batchLib = require('./importBatch');

const KOREAN_NAME_BY_TABLE = Object.fromEntries(Object.values(GOV_LAYER_MAP).map((l) => [l.table, l.koreanName]));
const FACILITY_FILE_KIND_BY_EXT = { '.jpg': '사진', '.jpeg': '사진', '.png': '사진', '.gif': '사진', '.bmp': '사진', '.pdf': '보고서' };

// 사용자에게 보여줄 오류 문구 — DB/파일 시스템의 원문은 서버 로그에만 남긴다.
function friendlyError(e) {
    const code = e && e.code;
    if (code === '23502') return '필수 값이 비어 있는 레코드가 있어 저장하지 못했습니다';
    if (code === '23505') return '중복된 값이 있어 저장하지 못했습니다';
    if (code === '22001') return '값이 너무 길어 저장하지 못했습니다';
    if (code === '22P02' || code === '22003' || code === '22007' || code === '22008') return '값의 형식이 맞지 않아 저장하지 못했습니다';
    if (code === 'ENOSPC') return '서버 디스크 공간이 부족합니다';
    if (code === 'EACCES' || code === 'EPERM') return '서버 폴더에 쓸 권한이 없습니다';
    return '저장 중 오류가 발생했습니다';
}

const rmQuiet = (p) => { if (p) fs.rm(p, { force: true }, () => {}); };

function isUnder(file, root) {
    const rel = path.relative(root, file);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 노선(납품 폴더) 하나를 저장한다 — 자기 트랜잭션. 실패하면 던지고(롤백 + 복사한 파일 삭제는 이 함수 안에서 처리).
async function saveRoute({ root, part, targetSigunguCode, requestedRankName, user, pkTableMap, facilityFilesUnmatched, batchId }) {
    const stats = {
        inserted: {}, deleted: {}, sections: 0, facilityFiles: 0, drawingFiles: 0,
    };
    const copied = []; // 이 노선이 복사한 파일 — 롤백되면 지운다
    const localPk = new Map(); // 이 노선의 시설물 PK -> 테이블 (커밋된 뒤에만 pkTableMap에 합친다 — 취소된 노선의 PK가 남지 않게)
    const trashMoves = []; // 같은 이름으로 교체된 예전 파일 — 커밋 뒤에 휴지통으로 옮긴다(이력이 없으면 그냥 지운다)
    const replaced = [];  // 이력 기록이 꺼진 경우(batchId 없음) 커밋 뒤에 지울 예전 파일
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        for (const [layer, { newRecords, deleteRecords }] of part.layers) {
            // 필수 필드(NOT NULL, 기본값 없음)가 DBF에 아예 없는 레이어는 INSERT하면 제약조건 위반으로 죽는다 —
            // 검수 단계에서 이미 경고했으니 신규 저장만 건너뛴다(삭제는 pk만 쓰므로 그대로 처리).
            const skipInsert = layer.fieldMatch.missingRequired.length > 0;
            if (batchId) {
                // 덮어쓰거나 지우기 직전의 값을 보관한다(되돌리기용)
                const pkList = [
                    ...(skipInsert ? [] : newRecords.filter((r) => !r.skipNnNull).map((r) => r.row[layer.pkColumn])),
                    ...deleteRecords.map((r) => r.row[layer.pkColumn]),
                ];
                await batchLib.snapshotRows(client, batchId, layer.table, pkList);
            }
            if (newRecords.length && !skipInsert) {
                let insertedCount = 0;
                for (const { row, geom, skipNnNull } of newRecords) {
                    // 필수 숫자항목이 비어 있는 레코드(KRRIS M-1)는 NOT NULL 위반이라 이 레코드만 건너뛴다(검수에서 경고함).
                    if (skipNnNull) continue;
                    insertedCount++;
                    const columns = [...Object.keys(row), 'geom', 'sigungu_code'];
                    const values = [...Object.values(row), geom ? JSON.stringify(geom) : null, targetSigunguCode];
                    const placeholders = columns.map((_, i) => `$${i + 1}`).join(',');
                    const updateSet = columns.filter((c) => c !== layer.pkColumn).map((c) => `${c} = EXCLUDED.${c}`).join(', ');
                    await client.query(
                        `INSERT INTO ${layer.table} (${columns.join(',')}) VALUES (${placeholders})
                         ON CONFLICT (${layer.pkColumn}) DO UPDATE SET ${updateSet}`,
                        values
                    );
                    const pk = row[layer.pkColumn];
                    if (pk) localPk.set(String(pk), layer.table);
                }
                stats.inserted[layer.table] = (stats.inserted[layer.table] || 0) + insertedCount;
            }
            if (deleteRecords.length) {
                for (const { row } of deleteRecords) {
                    const pk = row[layer.pkColumn];
                    if (!pk) continue;
                    await client.query(`DELETE FROM ${layer.table} WHERE ${layer.pkColumn} = $1`, [pk]);
                }
                stats.deleted[layer.table] = (stats.deleted[layer.table] || 0) + deleteRecords.length;
            }
        }

        // road_sections 동기화(노선 = 구간 목록). 도로종류 표시 이름: 직접 고른 이름이 있으면 그것을, 없으면
        // 이 노선의 500m 구간 SHP 파일명(면도0101.shp 등)에서 알아낸 이름을 쓴다(코드가 1599인 노선만).
        const syncedSections = [];
        for (const { deliveryCode, row, geom } of part.sections) {
            const rankName = requestedRankName || (row.road_rank === '1599' ? detectRankNameInRoot(root) : '') || '';
            const synced = await syncRoadSection(client, { row, geom }, targetSigunguCode, user.id, rankName,
                batchId ? (rdid) => batchLib.snapshotRows(client, batchId, 'road_sections', [rdid]) : undefined);
            if (deliveryCode) await client.query('UPDATE road_sections SET delivery_code = $1 WHERE rdid = $2', [deliveryCode, synced.rdid]);
            syncedSections.push(synced);
            stats.sections++;
        }

        // 시설물 사진/보고서 자동 연결 — 파일명(확장자 제외)이 이 노선에서 방금 저장한 PK와 정확히 같은 것만.
        // PHOTO 아래 하위 폴더(원본사진/표지사진)는 파일명 앞에 폴더명을 붙여 서로 다른 첨부로 둔다.
        for (const filePath of findFacilityAttachments(root)) {
            const base = path.basename(filePath);
            const ext = path.extname(base).toLowerCase();
            const pkCandidate = base.slice(0, base.length - ext.length);
            const table = localPk.get(pkCandidate);
            const fileKind = FACILITY_FILE_KIND_BY_EXT[ext];
            const parentFolder = path.basename(path.dirname(filePath));
            const displayName = ['PHOTO', 'STR'].includes(parentFolder) ? base : `${parentFolder}_${base}`;
            if (!table || !fileKind) { facilityFilesUnmatched.push(base); continue; }
            const dir = facilityFilesDir(targetSigunguCode, table);
            await fs.promises.mkdir(dir, { recursive: true });
            const storedPath = path.join(dir, `${Date.now()}_${displayName.replace(/[/\\]/g, '_')}`);
            await fs.promises.copyFile(filePath, storedPath);
            copied.push(storedPath);
            const { rows: old } = await client.query(
                'SELECT * FROM gov_facility_files WHERE facility_table = $1 AND facility_rdid = $2 AND original_name = $3',
                [table, pkCandidate, displayName]
            );
            for (const o of old) {
                if (batchId) trashMoves.push(...await batchLib.recordFileReplaced(client, batchId, 'gov_facility_files', o));
                else replaced.push(o.stored_path);
            }
            const { rows: upserted } = await client.query(
                `INSERT INTO gov_facility_files (facility_table, facility_rdid, file_kind, original_name, stored_path, sigungu_code, uploaded_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (facility_table, facility_rdid, original_name)
                 DO UPDATE SET stored_path = EXCLUDED.stored_path, sigungu_code = EXCLUDED.sigungu_code,
                     uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()
                 RETURNING id, stored_path`,
                [table, pkCandidate, fileKind, displayName, storedPath, targetSigunguCode, user.id]
            );
            if (batchId && !old.length) await batchLib.recordFileAdded(client, batchId, 'gov_facility_files', upserted[0]);
            stats.facilityFiles++;
        }

        // 도면(ETC 폴더의 DXF/DWG) — 이 노선에 구간이 정확히 1개일 때만 그 구간에 연결한다(여러 개면 어느 구간 것인지 알 수 없음).
        if (syncedSections.length === 1) {
            const section = syncedSections[0];
            const dir = routeFilesDir(targetSigunguCode, section.roadRankName, section.routeNo, section.routeName);
            for (const filePath of findDrawingFiles(root)) {
                const base = path.basename(filePath);
                await fs.promises.mkdir(dir, { recursive: true });
                const storedPath = path.join(dir, `${Date.now()}_${base.replace(/[/\\]/g, '_')}`);
                await fs.promises.copyFile(filePath, storedPath);
                copied.push(storedPath);
                let convertedPath = null;
                if (/\.dwg$/i.test(base)) {
                    const candidate = storedPath.replace(/\.dwg$/i, '.dxf');
                    if (await convertDwgToDxf(storedPath, candidate)) { convertedPath = candidate; copied.push(candidate); }
                }
                // 같은 구간+같은 파일명의 기존 도면은 지우고 새로 넣는다(재확정할 때 중복이 쌓이지 않게).
                const { rows: dup } = await client.query(
                    `DELETE FROM route_files WHERE section_rdid = $1 AND file_category = '도면종류' AND original_name = $2
                     RETURNING *`,
                    [section.rdid, base]
                );
                for (const r of dup) {
                    if (batchId) trashMoves.push(...await batchLib.recordFileReplaced(client, batchId, 'route_files', r));
                    else replaced.push(r.stored_path, r.converted_path);
                }
                const { rows: newDrawing } = await client.query(
                    `INSERT INTO route_files (road_grade, route_no, route_name, section_rdid, file_category, original_name, stored_path, converted_path, uploaded_by, sigungu_code)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, stored_path, converted_path`,
                    [section.roadRankName, section.routeNo, section.routeName, section.rdid, '도면종류', base, storedPath, convertedPath, user.id, targetSigunguCode]
                );
                if (batchId) await batchLib.recordFileAdded(client, batchId, 'route_files', newDrawing[0]);
                stats.drawingFiles++;
            }
        }

        await client.query('COMMIT');
        localPk.forEach((v, k) => pkTableMap.set(k, v));
        replaced.filter((p) => !copied.includes(p)).forEach(rmQuiet);
        await batchLib.moveFilesToTrash(trashMoves);
        return stats;
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (e2) { /* 연결이 이미 끊긴 경우 */ }
        copied.forEach(rmQuiet); // 취소된 노선이 복사해 둔 파일은 남기지 않는다
        throw e;
    } finally {
        client.release();
    }
}

function addCounts(target, add) {
    for (const [k, v] of Object.entries(add)) target[k] = (target[k] || 0) + v;
}

// job: { id, status, stage, done, total, currentRoute, results[], result, error } — 호출한 쪽(라우트)이 만든 객체를 갱신한다.
async function runBulkConfirm(job, ctx) {
    const { uploadId, extractDir, targetSigunguCode, requestedRankName, acknowledgeUnrecognizedCrs, user, batchId } = ctx;
    try {
        job.stage = '납품 파일 분석 중';
        const parsed = await parseDelivery(extractDir);
        if (parsed.blockingWarnings.length && !acknowledgeUnrecognizedCrs) {
            if (batchId) await batchLib.finishBatch(batchId, { status: 'failed', summary: '좌표계를 인식할 수 없어 시작하지 않음' });
            job.status = 'error';
            job.error = '좌표계를 인식할 수 없는 레이어가 있습니다. 확인 후 다시 시도하세요.';
            job.blockingWarnings = parsed.blockingWarnings;
            return;
        }

        // 납품 폴더(노선)별로 레코드를 모은다 — parseDelivery가 레코드마다 deliveryRoot를 달아 준다.
        const parts = new Map(); // root -> { code, layers: Map(layer -> {newRecords, deleteRecords}), sections: [] }
        const partOf = (root) => {
            if (!parts.has(root)) parts.set(root, { code: path.basename(root), layers: new Map(), sections: [] });
            return parts.get(root);
        };
        const layerPart = (part, layer) => {
            if (!part.layers.has(layer)) part.layers.set(layer, { newRecords: [], deleteRecords: [] });
            return part.layers.get(layer);
        };
        for (const layer of parsed.layers) {
            for (const rec of layer.newRecords) layerPart(partOf(rec.deliveryRoot), layer).newRecords.push(rec);
            for (const rec of layer.deleteRecords) layerPart(partOf(rec.deliveryRoot), layer).deleteRecords.push(rec);
        }
        for (const sr of parsed.sectionRecords) {
            const part = partOf(sr.deliveryRoot);
            part.sections.push(sr);
            if (sr.deliveryCode) part.code = sr.deliveryCode;
        }

        job.total = parts.size;
        job.done = 0;
        const totals = { inserted: {}, deleted: {}, roadSectionsUpserted: 0, facilityFilesAttached: 0, drawingFilesAttached: 0 };
        const pkTableMap = new Map(); // 시설물 PK -> 테이블 (노선 폴더 밖에 놓인 첨부를 맞출 때도 쓴다)
        const facilityFilesUnmatched = [];
        const routeResults = [];

        for (const [root, part] of parts) {
            job.currentRoute = part.code;
            job.stage = `노선 저장 중 (${job.done + 1}/${job.total})`;
            try {
                const s = await saveRoute({ root, part, targetSigunguCode, requestedRankName, user, pkTableMap, facilityFilesUnmatched, batchId });
                addCounts(totals.inserted, s.inserted);
                addCounts(totals.deleted, s.deleted);
                totals.roadSectionsUpserted += s.sections;
                totals.facilityFilesAttached += s.facilityFiles;
                totals.drawingFilesAttached += s.drawingFiles;
                routeResults.push({ code: part.code, ok: true });
            } catch (e) {
                console.error(`[bulk-import/confirm] 노선 ${part.code} 저장 실패:`, e);
                routeResults.push({ code: part.code, ok: false, error: friendlyError(e) });
            }
            job.done++;
            job.results = routeResults;
        }
        const failedRoutes = routeResults.filter((r) => !r.ok);

        // 노선 폴더 밖에 놓인 시설물 사진/보고서(공용 PHOTO 폴더 등) — 이번에 저장한 PK와 이름이 맞는 것만 붙인다.
        job.currentRoute = '';
        job.stage = '노선 밖 첨부 연결 중';
        const rootList = [...parts.keys()];
        const recorder = batchId ? batchLib.makeRecorder(batchId) : null;
        for (const filePath of findFacilityAttachments(extractDir)) {
            if (rootList.some((r) => isUnder(filePath, r))) continue; // 노선 안의 파일은 위에서 처리됨
            const base = path.basename(filePath);
            const ext = path.extname(base).toLowerCase();
            const pk = base.slice(0, base.length - ext.length);
            const table = pkTableMap.get(pk);
            const fileKind = FACILITY_FILE_KIND_BY_EXT[ext];
            if (!table || !fileKind) { facilityFilesUnmatched.push(base); continue; }
            const parentFolder = path.basename(path.dirname(filePath));
            const displayName = ['PHOTO', 'STR'].includes(parentFolder) ? base : `${parentFolder}_${base}`;
            try {
                const dir = facilityFilesDir(targetSigunguCode, table);
                await fs.promises.mkdir(dir, { recursive: true });
                const storedPath = path.join(dir, `${Date.now()}_${displayName.replace(/[/\\]/g, '_')}`);
                await fs.promises.copyFile(filePath, storedPath);
                const { rows: old } = await pool.query(
                    'SELECT * FROM gov_facility_files WHERE facility_table = $1 AND facility_rdid = $2 AND original_name = $3', [table, pk, displayName]
                );
                if (recorder) for (const o of old) await recorder.replaced('gov_facility_files', o);
                const { rows: upserted } = await pool.query(
                    `INSERT INTO gov_facility_files (facility_table, facility_rdid, file_kind, original_name, stored_path, sigungu_code, uploaded_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)
                     ON CONFLICT (facility_table, facility_rdid, original_name)
                     DO UPDATE SET stored_path = EXCLUDED.stored_path, sigungu_code = EXCLUDED.sigungu_code, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()
                     RETURNING id, stored_path`,
                    [table, pk, fileKind, displayName, storedPath, targetSigunguCode, user.id]
                );
                if (recorder && !old.length) await recorder.added('gov_facility_files', upserted[0]);
                if (!recorder) old.forEach((o) => { if (o.stored_path !== storedPath) rmQuiet(o.stored_path); });
                totals.facilityFilesAttached++;
            } catch (e) {
                console.error('[bulk-import/confirm] 노선 밖 첨부 저장 실패:', e);
                facilityFilesUnmatched.push(base);
            }
        }

        // 500m 구간(road_sectors) — 위에서 저장한 구간(road_sections)과 (노선번호, 구간)이 맞는 조각만. 별도 트랜잭션.
        job.stage = '500m 구간 저장 중';
        let sectorsInserted = 0;
        let sectorsSkipped = 0;
        let sectorsFailed = false;
        const sectorRecords = parseSectorShpFiles(extractDir).records;
        if (sectorRecords.length) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const sectorKeyCache = new Map();
                for (const rec of sectorRecords) {
                    const cacheKey = `${rec.roadNo}|${rec.sect}`;
                    let key = sectorKeyCache.get(cacheKey);
                    if (key === undefined) {
                        const r = await client.query('SELECT road_rank_code, sigungu_code FROM road_sections WHERE route_no = $1 AND sect = $2 LIMIT 1', [rec.roadNo, rec.sect]);
                        key = r.rows[0] ? { road_rank_code: r.rows[0].road_rank_code, sigungu_code: r.rows[0].sigungu_code } : null;
                        sectorKeyCache.set(cacheKey, key);
                    }
                    if (!key) { sectorsSkipped++; continue; }
                    if (batchId) await batchLib.snapshotSector(client, batchId, key.road_rank_code, rec.roadNo, rec.sect, rec.sectSt);
                    await client.query(
                        `INSERT INTO road_sectors (road_rank_code, road_no, sect, sect_st, sect_ed, sect_len, geom, sigungu_code)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                         ON CONFLICT (road_rank_code, road_no, sect, sect_st)
                         DO UPDATE SET sect_ed = EXCLUDED.sect_ed, sect_len = EXCLUDED.sect_len, geom = EXCLUDED.geom, sigungu_code = EXCLUDED.sigungu_code`,
                        [key.road_rank_code, rec.roadNo, rec.sect, rec.sectSt, rec.sectEd, rec.sectLen, JSON.stringify(rec.geom), key.sigungu_code]
                    );
                    sectorsInserted++;
                }
                await client.query('COMMIT');
            } catch (e) {
                try { await client.query('ROLLBACK'); } catch (e2) { /* 무시 */ }
                console.error('[bulk-import/confirm] 500m 구간 저장 실패:', e);
                sectorsInserted = 0;
                sectorsFailed = true;
            } finally {
                client.release();
            }
        }

        // 납품 폴더 밖의 구간 도면(500_P/500_Y/500_U, CONT): 방금 저장한 구간을 DB에서 찾아 파일명으로 붙인다.
        job.stage = '구간 도면 분류 중';
        const drawingsAuto = { matchedCount: 0, unmatched: [], failed: false };
        const looseDrawings = findLooseDrawingFiles(extractDir);
        if (looseDrawings.length) {
            try {
                const r = await autoUploadRouteDrawings({
                    files: looseDrawings.map((p) => ({ path: p, name: path.basename(p) })),
                    hint: null, userId: user.id, userSigungu: targetSigunguCode, recorder,
                });
                drawingsAuto.matchedCount = r.matched.length;
                drawingsAuto.unmatched = r.unmatched.slice(0, 20);
                drawingsAuto.unmatchedCount = r.unmatched.length;
            } catch (e) {
                console.error('[bulk-import/confirm/loose-drawings]', e);
                drawingsAuto.failed = true;
            }
        }

        // 마무리: 실패한 노선이 없을 때만 임시 작업 폴더와 서버 사전업로드 원본 폴더를 지운다(실패가 있으면 다시 시도할 수 있게 남긴다).
        job.stage = '마무리 중';
        let incomingSource = null;
        if (!failedRoutes.length) {
            incomingSource = getIncomingSourceOfUpload(uploadId);
            cleanup(uploadId);
            if (incomingSource) { try { fs.rmSync(incomingSource, { recursive: true, force: true }); } catch (e) { /* 무시 */ } }
        }

        const insertedParts = Object.entries(totals.inserted).map(([t, c]) => `${KOREAN_NAME_BY_TABLE[t] || t} ${c}건`);
        const deletedParts = Object.entries(totals.deleted).map(([t, c]) => `${KOREAN_NAME_BY_TABLE[t] || t} ${c}건 삭제`);
        const summary = [`일괄등록: 구간 ${totals.roadSectionsUpserted}건`, ...insertedParts, ...deletedParts,
            totals.facilityFilesAttached ? `첨부 ${totals.facilityFilesAttached}건` : null,
            totals.drawingFilesAttached ? `도면 ${totals.drawingFilesAttached}건` : null,
            sectorsInserted ? `500m 구간 ${sectorsInserted}건` : null,
            failedRoutes.length ? `실패한 노선 ${failedRoutes.length}개(${failedRoutes.map((r) => r.code).join(', ')})` : null]
            .filter(Boolean).join(', ');
        await logAction(null, {
            action: 'bulk_import', targetTable: 'road_sections', targetId: null, summary,
            detail: { ...totals, sectorsInserted, sectorsSkipped, routes: routeResults },
            sigunguCode: targetSigunguCode, user,
        });

        // 저장된 것이 하나라도 있으면 "되돌릴 수 있는 등록"으로 남긴다(전부 실패했으면 보관할 것이 없다).
        if (batchId) {
            const anySaved = routeResults.some((r) => r.ok) || sectorsInserted > 0 || drawingsAuto.matchedCount > 0;
            await batchLib.finishBatch(batchId, {
                status: anySaved ? 'applied' : 'failed', summary,
                detail: { ...totals, sectorsInserted, sectorsSkipped, routes: routeResults },
            });
        }

        job.result = {
            ok: failedRoutes.length === 0,
            inserted: totals.inserted, deleted: totals.deleted, roadSectionsUpserted: totals.roadSectionsUpserted,
            facilityFilesAttached: totals.facilityFilesAttached, facilityFilesUnmatched, drawingFilesAttached: totals.drawingFilesAttached,
            sectorsInserted, sectorsSkipped, sectorsFailed,
            incomingFolderRemoved: !!incomingSource,
            drawingsAuto,
            routes: routeResults, failedRoutes,
        };
        job.status = 'done';
        job.stage = '완료';
    } catch (e) {
        console.error('[bulk-import/confirm]', e);
        // 도중에 중단돼도 이미 저장된 노선이 있으면 되돌릴 수 있게 남긴다.
        if (batchId) {
            try { await batchLib.finishBatch(batchId, { status: (job.results || []).some((r) => r.ok) ? 'applied' : 'failed', summary: '오류로 중단됨' }); } catch (e2) { /* 무시 */ }
        }
        job.status = 'error';
        job.error = '저장 중 오류가 발생했습니다.';
    } finally {
        job.finishedAt = Date.now();
    }
}

module.exports = { runBulkConfirm };
