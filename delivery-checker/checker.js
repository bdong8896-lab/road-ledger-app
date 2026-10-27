// 납품 폴더/ZIP 검수(일괄등록 검수와 같은 검사)를 DB·서버 없이 실행한다.
// 파싱·검사 코드는 서버와 같은 server/lib/*를 그대로 쓴다 — 그래서 여기서 통과한 납품은 서버 일괄등록 검수에서도
// 같은 결과가 나온다. DB가 필요한 부분(테이블 컬럼 정보)만 schema-snapshot.json으로 대신한다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseDelivery, krrisDefectRows, setTableColumnProvider } = require('../server/lib/bulkImportParse');
const { parseSectorShpFiles } = require('../server/lib/bulkImportSectors');
const { findFacilityAttachments, findDrawingFiles, findLooseDrawingFiles } = require('../server/lib/bulkImportAttachments');
const { detectRankNameHints } = require('../server/lib/bulkImportRank');
const { parseDrawingFilename } = require('../server/lib/routeFileNaming');
const { openZip } = require('../server/lib/zipOpen');
const snapshot = require('./schema-snapshot.json');

setTableColumnProvider(async (table) => {
    const t = snapshot.tables[table];
    if (!t) throw new Error(`검수 프로그램의 스키마 정보에 ${table} 테이블이 없습니다(schema-snapshot.json을 다시 만드세요).`);
    return { columns: new Set(t.columns), requiredNoDefault: new Set(t.required) };
});

const ATTACHMENT_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.pdf']);
const LIST_LIMIT = 300; // 화면에 보여줄 목록 개수 상한(전체는 CSV)

function csvCell(v) {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// 결함 전체 목록 CSV(엑셀에서 한글이 안 깨지게 BOM 포함). 서버의 KRRIS 사전검사 CSV와 같은 열이다.
function defectsToCsv(defects) {
    const lines = [['검사항목', '레이어코드', '레이어', '대상ID', '파일', '행', '필드', '필드명', '내용'].map(csvCell).join(',')];
    for (const r of defects) {
        lines.push([r.check, r.code, r.layer, r.pk, r.file, r.row, r.field, r.label, r.detail].map(csvCell).join(','));
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
}

// ZIP이면 임시 폴더에 풀고, 폴더면 그대로 쓴다. 정리할 폴더(cleanupDir)를 함께 돌려준다.
function prepareInput(inputPath) {
    if (!fs.existsSync(inputPath)) throw new Error('경로를 찾을 수 없습니다: ' + inputPath);
    const stat = fs.statSync(inputPath);
    if (stat.isDirectory()) return { dir: inputPath, cleanupDir: null, kind: 'folder' };
    if (!/\.zip$/i.test(inputPath)) throw new Error('폴더 또는 ZIP 파일만 검수할 수 있습니다.');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'road-ledger-checker-'));
    try {
        openZip(inputPath).extractAllTo(tmp, true);
    } catch (e) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw new Error('ZIP을 풀 수 없습니다: ' + e.message);
    }
    return { dir: tmp, cleanupDir: tmp, kind: 'zip' };
}

async function inspect(inputPath, onStep = () => {}) {
    const started = Date.now();
    onStep('압축 해제/폴더 확인');
    const { dir, cleanupDir, kind } = prepareInput(inputPath);
    try {
        onStep('레이어 파일(DBF/SHP) 검사');
        const parsed = await parseDelivery(dir);

        onStep('500m 구간 SHP 확인');
        const sectors = parseSectorShpFiles(dir);

        onStep('사진·보고서 연결 확인');
        const pkSet = new Set();
        for (const l of parsed.layers) {
            for (const rec of l.newRecords) {
                const pk = rec.row[l.pkColumn];
                if (pk) pkSet.add(String(pk));
            }
        }
        const attFiles = findFacilityAttachments(dir);
        const attUnmatched = [];
        let attMatched = 0;
        for (const f of attFiles) {
            const base = path.basename(f);
            const ext = path.extname(base).toLowerCase();
            if (ATTACHMENT_EXTS.has(ext) && pkSet.has(base.slice(0, base.length - ext.length))) attMatched++;
            else attUnmatched.push({ name: base, reason: ATTACHMENT_EXTS.has(ext) ? '같은 이름(ID)의 시설물이 이번 납품에 없음' : '지원하지 않는 파일 형식' });
        }

        onStep('도면 확인');
        const etcDrawings = findDrawingFiles(dir).map((f) => path.basename(f));
        const sectionKeys = new Set();
        for (const r of parsed.sectionRecords) sectionKeys.add(`${Number(r.row.road_no)}|${String(r.row.sect).padStart(3, '0')}`);
        const looseDrawings = findLooseDrawingFiles(dir).map((f) => {
            const base = path.basename(f);
            const p = parseDrawingFilename(base);
            if (!p) return { name: base, status: 'unrecognized', note: '파일명에서 노선·구간을 알 수 없음 — 도면 업로드에서 노선을 골라 올려야 합니다' };
            const inPackage = sectionKeys.has(`${Number(p.routeNo)}|${p.sect}`);
            return {
                name: base, routeNo: p.routeNo, sect: p.sect, category: p.category,
                status: inPackage ? 'in-package' : 'other-route',
                note: inPackage ? '이번 납품의 노선' : '이번 납품에 없는 노선 — 서버에 이미 등록된 노선이어야 붙습니다',
            };
        });

        const defects = krrisDefectRows(parsed);
        const rankHints = detectRankNameHints(parsed.sectionRecords);

        const layers = parsed.layers.map((l) => ({
            code: l.code, name: l.koreanName, table: l.table,
            newCount: l.newRecords.length, deleteCount: l.deleteRecords.length,
            epsg: l.crs && l.crs.matched ? l.crs.epsg : null,
            crsLabel: l.crs ? (l.crs.matched ? l.crs.label : '인식 못함') : (l.hasShp ? '.prj 없음' : '-'),
            geomType: l.geomType || null, hasShp: l.hasShp,
            extraFields: l.fieldMatch.extraInDbf, missingFields: l.fieldMatch.missingInDbf, missingRequired: l.fieldMatch.missingRequired,
            skippedWrongSchema: l.skippedWrongSchema || 0,
            nnCount: l.nnDefects.length,
            codeCount: l.codeTotal,
            warnings: l.warnings,
        }));

        // ---- 종합 판정 ----
        const errors = [];
        const warns = [];
        parsed.blockingWarnings.forEach((w) => errors.push(w));
        layers.forEach((l) => {
            if (l.missingRequired.length) errors.push(`${l.code} ${l.name}: 필수 필드가 DBF에 없습니다 — ${l.missingRequired.join(', ')}`);
            if (l.skippedWrongSchema) errors.push(`${l.code} ${l.name}: 다른 레이어의 속성표가 들어 있어 ${l.skippedWrongSchema}건은 등록되지 않습니다`);
        });
        const nullDefects = defects.filter((d) => d.detail.startsWith('값 없음(숫자)')).length;
        if (nullDefects) errors.push(`필수 숫자 항목이 비어 등록되지 않는 레코드 ${nullDefects}건`);
        if (parsed.krris.crs.length) warns.push(`좌표계가 EPSG:5179가 아닌 레이어 ${parsed.krris.crs.length}개 (KRRIS 제출 기준 미충족)`);
        const emptyDefects = defects.filter((d) => d.check.startsWith('M-1') && d.detail === '빈 값').length;
        if (emptyDefects) warns.push(`필수 항목 빈 값 ${emptyDefects}건 (KRRIS에서 결함으로 지적됨)`);
        if (parsed.krris.codesTotal) warns.push(`코드표에 없는 코드 값 ${parsed.krris.codesTotal}건 (V-1 — 등록은 되지만 원본 확인 필요)`);
        if (layers.some((l) => l.extraFields.length)) warns.push('DBF에 저장 스키마에 없는 필드가 있는 레이어가 있습니다(무시하고 저장됨)');
        if (attUnmatched.length) warns.push(`시설물과 연결되지 않는 사진/보고서 ${attUnmatched.length}건`);
        const unrecog = looseDrawings.filter((d) => d.status === 'unrecognized').length;
        if (unrecog) warns.push(`파일명으로 노선을 알 수 없는 구간 도면 ${unrecog}건`);
        if (!layers.length) {
            // 도면만 담은 납품(500_P/CONT 등)은 레이어가 없는 게 정상이라 오류로 보지 않는다.
            if (looseDrawings.length || etcDrawings.length) warns.push('레이어 파일이 없는 도면 전용 납품입니다 — 도면이 붙을 노선·구간은 서버에 이미 등록돼 있어야 합니다.');
            else errors.push('국토부 표준 레이어 파일({관리번호}_{레이어코드}_N.dbf)을 찾지 못했습니다.');
        }
        const verdict = errors.length ? 'error' : warns.length ? 'warn' : 'ok';

        return {
            input: { path: inputPath, kind },
            elapsedMs: Date.now() - started,
            schemaGeneratedAt: snapshot.generatedAt,
            verdict, errors, warnings: warns,
            deliveryCodes: parsed.deliveryCodes,
            sectionCount: parsed.sectionRecords.length,
            unknownLayerCodes: parsed.unknownLayerCodes,
            totalNew: layers.reduce((s, l) => s + l.newCount, 0),
            totalDelete: layers.reduce((s, l) => s + l.deleteCount, 0),
            layers,
            krris: { requiredEpsg: parsed.krris.requiredEpsg, crs: parsed.krris.crs, nn: parsed.krris.nn, nnTotal: parsed.krris.nnTotal, codes: parsed.krris.codes, codesTotal: parsed.krris.codesTotal },
            defectTotal: defects.length,
            // 화면 목록은 검사 항목(C-1/M-1/V-1)별로 앞 LIST_LIMIT건씩 — 한 항목이 많아도 다른 항목이 가려지지 않게 한다
            defects: ['C-1', 'M-1', 'V-1'].flatMap((c) => defects.filter((d) => d.check.startsWith(c)).slice(0, LIST_LIMIT)),
            sectors: { count: sectors.records.length, warnings: sectors.warnings },
            attachments: { total: attFiles.length, matched: attMatched, unmatchedTotal: attUnmatched.length, unmatched: attUnmatched.slice(0, LIST_LIMIT) },
            drawings: { etc: etcDrawings.length, etcNames: etcDrawings.slice(0, LIST_LIMIT), loose: looseDrawings.slice(0, LIST_LIMIT), looseTotal: looseDrawings.length },
            rankHints,
            // CSV용 전체 목록(화면 JSON에는 싣지 않는다)
            _allDefects: defects,
        };
    } finally {
        if (cleanupDir) fs.rmSync(cleanupDir, { recursive: true, force: true });
    }
}

module.exports = { inspect, defectsToCsv };
