// 노선 도면 일괄 업로드(ZIP) — 500m 단위 구간도면(500_P/500_Y, routeFileNaming.js
// 패턴)과 구간현황 개요도(CON 등, 패턴 미확정) 파일을 zip 하나로 통째로 올리면
// 파일명에서 구간(sect)을 알아내 이미 등록된 해당 노선의 구간(road_sections)에
// 자동으로 나눠 붙인다. road_grade/route_no는 업로드 화면에서 이미 선택된
// 노선 기준으로 고정해서 넘겨받으므로(도로등급이 달라도 노선번호가 겹치는
// 문제 없음), 여기서는 파일명에서 구간(sect)만 알아내면 된다.
const fs = require('fs');
const path = require('path');
const { openZip } = require('./zipOpen');
const pool = require('../db');
const config = require('../config');
const { convertDwgToDxf } = require('./dwgConvert');
const { parseStationFilename, ROUTE_SECT_FILE_RE, SECTION_WHOLE_FILE_RE } = require('./routeFileNaming');

function routeDirName(roadGrade, routeNo, routeName) {
    const safe = (s) => String(s || '').replace(/[/\\:*?"<>|]/g, '_').trim();
    return [safe(roadGrade), safe(routeNo), safe(routeName)].filter(Boolean).join('__') || 'unspecified';
}

function walkFiles(dir) {
    const out = [];
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, name.name);
        if (name.isDirectory()) out.push(...walkFiles(full));
        else out.push(full);
    }
    return out;
}

// 500m 단위 패턴이 아닌 파일(CON080001.dxf 등)은 정확한 자릿수 규칙을
// 확신할 수 없어서, 파일명 끝자리가 이 노선의 실제 등록된 구간번호(sect,
// 3자리, 예 "001")로 끝나는지 직접 대조한다 — 접두어(CON/TOP 등)가 뭐든
// 동작하고, 어느 구간에도 안 걸리면(예: 전체 노선 개요도) 미매칭으로 남는다.
function matchSectBySuffix(baseName, knownSects) {
    const digits = baseName.replace(/\.(dwg|dxf)$/i, '');
    const matches = knownSects.filter((sect) => digits.endsWith(sect));
    return matches.length === 1 ? matches[0] : null;
}

// 도면 파일 하나를 구간(section)에 붙인다 — 디스크 복사, DWG→DXF 변환, 같은
// 구간+같은 파일명의 기존 행 교체, route_files 행 추가. bulk-zip(노선을 골라서 올림)과
// 자동 인식 업로드가 같이 쓴다. dir: 저장 폴더(노선별).
async function placeDrawing({ filePath, base, section, category, segInfo, userId, userSigungu, dir }) {
    const roadGrade = section.road_rank_name, routeNo = section.route_no, routeName = section.route_name;
    const storedPath = path.join(dir, `${Date.now()}_${Math.random().toString(36).slice(2)}_${base}`);
    fs.copyFileSync(filePath, storedPath);

    let convertedPath = null;
    if (/\.dwg$/i.test(base)) {
        const candidate = storedPath.replace(/\.dwg$/i, '.dxf');
        if (await convertDwgToDxf(storedPath, candidate)) convertedPath = candidate;
    }

    // 같은 zip을 재업로드해도(재시도 등) 쌓이지 않도록, 같은 구간+같은
    // 파일명의 기존 행을 지우고 새로 넣는다(bulkImport.js의 도면 자동첨부와
    // 동일한 관례). DB 행만 지우고 디스크의 실제 파일을 안 지우면 재업로드할
    // 때마다 옛 파일이 orphan으로 계속 쌓인다(실사용 중 확인됨 — 같은
    // 파일명이 디스크에 3벌씩 남아있었음) — 그래서 지우기 전에 옛 경로를
    // 먼저 조회해서 같이 정리한다.
    const { rows: oldRows } = await pool.query(
        'SELECT stored_path, converted_path FROM route_files WHERE section_rdid = $1 AND original_name = $2',
        [section.rdid, base]
    );
    await pool.query(
        'DELETE FROM route_files WHERE section_rdid = $1 AND original_name = $2',
        [section.rdid, base]
    );
    for (const old of oldRows) {
        if (old.stored_path) fs.rm(old.stored_path, { force: true }, () => {});
        if (old.converted_path) fs.rm(old.converted_path, { force: true }, () => {});
    }
    const { rows: inserted } = await pool.query(
        `INSERT INTO route_files (road_grade, route_no, route_name, section_rdid, file_category, original_name, stored_path, converted_path, uploaded_by, sigungu_code, seg_no, seg_start_km, seg_end_km, seg_variant)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id, file_category, original_name, (converted_path IS NOT NULL) AS has_preview`,
        [
            roadGrade, routeNo, routeName, section.rdid, category, base, storedPath, convertedPath, userId, userSigungu || section.sigungu_code || null,
            segInfo ? segInfo.segNo : null, segInfo ? segInfo.segStartKm : null, segInfo ? segInfo.segEndKm : null, segInfo ? segInfo.segVariant : null,
        ]
    );
    return inserted[0];
}

// ⚠ DWG→DXF 변환기가 설정돼 있으면 파일마다 순차로 변환을 기다린다(파일당
// 최대 45초). 파일이 아주 많은 zip(수백 개)이면 이 요청 하나가 오래 걸릴 수
// 있다 — 변환기 미설정 시(isConverterConfigured()===false)는 즉시 스킵되므로
// 문제없다. 대용량 배치가 잦아지면 나중에 비동기 작업(job)으로 바꿀 것.
async function bulkUploadRouteDrawings({ zipPath, roadGrade, routeNo, routeName, userId, userSigungu }) {
    const { rows: sections } = await pool.query(
        `SELECT rdid, sect, length_m, road_rank_name, route_no, route_name, sigungu_code FROM road_sections WHERE road_rank_name = $1 AND route_no = $2`,
        [roadGrade, routeNo]
    );
    if (!sections.length) {
        throw new Error('이 노선에 등록된 구간이 없습니다. 먼저 구간을 등록한 뒤 올려주세요.');
    }
    const sectionBySect = new Map(sections.map((s) => [s.sect, s]));
    const knownSects = sections.map((s) => s.sect);
    const expectedRouteNo4 = String(routeNo).padStart(4, '0');

    const tmpDir = path.join(config.uploadDir, 'route-drawings-tmp', `${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
        openZip(zipPath).extractAllTo(tmpDir, true); // 한국어(CP949) 파일명 처리 — lib/zipOpen.js 참고
    } catch (e) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw new Error(`ZIP 압축 해제 실패: ${e.message}`);
    }

    const allFiles = walkFiles(tmpDir).filter((f) => /\.(dwg|dxf)$/i.test(f));
    const dir = path.join(config.uploadDir, 'routes', routeDirName(roadGrade, routeNo, routeName));
    fs.mkdirSync(dir, { recursive: true });

    const matched = [];
    const unmatched = [];

    for (const filePath of allFiles) {
        const base = path.basename(filePath);
        let sect = null;
        let category = '도면종류';
        let segInfo = null;

        const stationParsed = parseStationFilename(base, null);
        // 파일명의 구간번호는 2자리(예 "01")인데 road_sections.sect는 국토부
        // 표준대로 3자리(예 "001")라 0을 채워서 비교해야 한다 — 실제 mDB
        // 원본은 2자리, 우리 DB 저장 규칙은 3자리로 서로 다름(실사용 중 확인됨).
        const stationSect3 = stationParsed ? stationParsed.sect.padStart(3, '0') : null;
        if (stationParsed && stationParsed.routeNo === expectedRouteNo4 && sectionBySect.has(stationSect3)) {
            sect = stationSect3;
            category = '도로';
            const lengthM = sectionBySect.get(sect).length_m;
            const sectionLengthKm = lengthM != null ? Number(lengthM) / 1000 : null;
            segInfo = parseStationFilename(base, sectionLengthKm);
        } else {
            sect = matchSectBySuffix(base, knownSects);
        }

        if (!sect || !sectionBySect.has(sect)) {
            unmatched.push(base);
            continue;
        }

        const section = sectionBySect.get(sect);
        await placeDrawing({ filePath, base, section, category, segInfo, userId, userSigungu, dir });
        matched.push({ name: base, sect, category });
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { matched, unmatched };
}

// ---- 자동 인식 업로드 ----
// 노선을 고르지 않고 도면 파일(또는 ZIP)을 올리면 파일명에서 노선·구간을 알아내 해당
// 구간에 붙인다. 인식하는 파일명 규칙(둘 다 노선번호 4자리 + 구간 2자리가 들어 있음):
//   1) 500m 단위 구간도면: {노선4}{구간2}{측점6}{P|Y}  예) 000801100500P.dwg
//   2) 노선·구간 도면:      [영문접두어]{노선4}{구간2}  예) TOP010101.dxf, 010101.dxf
//   3) 구간 전체 도면(CONT): {영문접두어}{노선4}{구간2}{측점5}  예) SE01010100000.dxf
// 그 밖의 이름(구간번호만 끝에 붙은 옛 형식 등)은 노선을 알 수 없어, 노선을 골라 둔 경우(hint)에만
// 기존 규칙(끝자리 구간번호)으로 붙이고 아니면 "인식 못함"으로 돌려준다.
// 같은 노선번호가 도로종류 두 곳 이상에 있으면(예: 군도 0008, 시도 0008) 파일명만으로 정할 수 없으므로
// hint(선택한 노선)의 도로종류로 좁히고, 그래도 못 정하면 인식 못함으로 둔다.
// (파일명 정규식 ROUTE_SECT_FILE_RE/SECTION_WHOLE_FILE_RE는 routeFileNaming.js에 있다 — 검수 프로그램과 공유)

function sameRouteNo(a, b) {
    const x = Number(a), y = Number(b);
    return Number.isFinite(x) && Number.isFinite(y) ? x === y : String(a) === String(b);
}

// 후보 구간(sections 중 노선번호+구간이 맞는 것)에서 하나를 고른다. { section } 또는 { reason }.
function pickSection(sections, routeNo, sect3, hint) {
    let cands = sections.filter((s) => sameRouteNo(s.route_no, routeNo) && s.sect === sect3);
    if (!cands.length) return { reason: '등록된 구간이 없습니다(노선번호/구간번호를 확인하세요)' };
    if (cands.length > 1 && hint && hint.roadGrade) {
        const narrowed = cands.filter((s) => s.road_rank_name === hint.roadGrade);
        if (narrowed.length) cands = narrowed;
    }
    if (cands.length > 1) return { reason: '같은 번호의 노선이 도로종류 여러 곳에 있습니다 — 노선을 선택하고 올리세요' };
    return { section: cands[0] };
}

function resolveDrawingTarget(base, sections, hint) {
    const station = parseStationFilename(base, null);
    if (station) {
        const r = pickSection(sections, station.routeNo, station.sect.padStart(3, '0'), hint);
        if (!r.section) return r;
        const lengthM = r.section.length_m;
        return { section: r.section, category: '도로', segInfo: parseStationFilename(base, lengthM != null ? Number(lengthM) / 1000 : null) };
    }
    const m = ROUTE_SECT_FILE_RE.exec(base);
    if (m) {
        const r = pickSection(sections, m[1], m[2].padStart(3, '0'), hint);
        if (r.section) return { section: r.section, category: '도면종류', segInfo: null };
        if (!hint) return r;
    }
    const w = SECTION_WHOLE_FILE_RE.exec(base);
    if (w) {
        const r = pickSection(sections, w[1], w[2].padStart(3, '0'), hint);
        if (r.section) return { section: r.section, category: '도면종류', segInfo: null };
        if (!hint) return r;
    }
    if (hint && hint.roadGrade) {
        const mine = sections.filter((s) => s.road_rank_name === hint.roadGrade && sameRouteNo(s.route_no, hint.routeNo));
        const sect = matchSectBySuffix(base, mine.map((s) => s.sect));
        if (sect) return { section: mine.find((s) => s.sect === sect), category: '도면종류', segInfo: null };
    }
    return { reason: '파일명에서 노선·구간을 알 수 없습니다(노선을 선택하고 올리세요)' };
}

// files: [{ path, name }] — .dwg/.dxf 또는 .zip(안의 dwg/dxf를 꺼냄). hint: { roadGrade, routeNo } 또는 null.
async function autoUploadRouteDrawings({ files, hint, userId, userSigungu }) {
    const { rows: sections } = await pool.query(
        `SELECT rdid, sect, length_m, road_rank_name, route_no, route_name, sigungu_code FROM road_sections
          WHERE ($1::text IS NULL OR sigungu_code IS NULL OR sigungu_code = $1)`,
        [userSigungu || null]
    );

    const tmpDirs = [];
    const items = []; // { path, name }
    const unmatched = [];
    try {
        for (const f of files) {
            if (/\.zip$/i.test(f.name)) {
                const tmpDir = path.join(config.uploadDir, 'route-drawings-tmp', `${Date.now()}_${Math.random().toString(36).slice(2)}`);
                fs.mkdirSync(tmpDir, { recursive: true });
                tmpDirs.push(tmpDir);
                try {
                    openZip(f.path).extractAllTo(tmpDir, true);
                } catch (e) {
                    unmatched.push({ name: f.name, reason: 'ZIP 압축 해제 실패' });
                    continue;
                }
                walkFiles(tmpDir).filter((p) => /\.(dwg|dxf)$/i.test(p)).forEach((p) => items.push({ path: p, name: path.basename(p) }));
            } else if (/\.(dwg|dxf)$/i.test(f.name)) {
                items.push(f);
            } else {
                unmatched.push({ name: f.name, reason: '도면 파일(dwg/dxf)이 아닙니다' });
            }
        }

        const matched = [];
        for (const item of items) {
            const t = resolveDrawingTarget(item.name, sections, hint);
            if (!t.section) { unmatched.push({ name: item.name, reason: t.reason }); continue; }
            const sec = t.section;
            const dir = path.join(config.uploadDir, 'routes', routeDirName(sec.road_rank_name, sec.route_no, sec.route_name));
            fs.mkdirSync(dir, { recursive: true });
            const file = await placeDrawing({ filePath: item.path, base: item.name, section: sec, category: t.category, segInfo: t.segInfo, userId, userSigungu, dir });
            matched.push({ file, name: item.name, roadGrade: sec.road_rank_name, routeNo: sec.route_no, routeName: sec.route_name, sect: sec.sect, category: t.category });
        }
        return { matched, unmatched };
    } finally {
        tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
    }
}

module.exports = { bulkUploadRouteDrawings, autoUploadRouteDrawings };
