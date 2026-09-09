// 노선 도면 일괄 업로드(ZIP) — 500m 단위 구간도면(500_P/500_Y, routeFileNaming.js
// 패턴)과 구간현황 개요도(CON 등, 패턴 미확정) 파일을 zip 하나로 통째로 올리면
// 파일명에서 구간(sect)을 알아내 이미 등록된 해당 노선의 구간(road_sections)에
// 자동으로 나눠 붙인다. road_grade/route_no는 업로드 화면에서 이미 선택된
// 노선 기준으로 고정해서 넘겨받으므로(도로등급이 달라도 노선번호가 겹치는
// 문제 없음), 여기서는 파일명에서 구간(sect)만 알아내면 된다.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const pool = require('../db');
const config = require('../config');
const { convertDwgToDxf } = require('./dwgConvert');
const { parseStationFilename } = require('./routeFileNaming');

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

// ⚠ DWG→DXF 변환기가 설정돼 있으면 파일마다 순차로 변환을 기다린다(파일당
// 최대 45초). 파일이 아주 많은 zip(수백 개)이면 이 요청 하나가 오래 걸릴 수
// 있다 — 변환기 미설정 시(isConverterConfigured()===false)는 즉시 스킵되므로
// 문제없다. 대용량 배치가 잦아지면 나중에 비동기 작업(job)으로 바꿀 것.
async function bulkUploadRouteDrawings({ zipPath, roadGrade, routeNo, routeName, userId, userSigungu }) {
    const { rows: sections } = await pool.query(
        `SELECT rdid, sect, length_m FROM road_sections WHERE road_rank_name = $1 AND route_no = $2`,
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
        new AdmZip(zipPath).extractAllTo(tmpDir, true);
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
        await pool.query(
            `INSERT INTO route_files (road_grade, route_no, route_name, section_rdid, file_category, original_name, stored_path, converted_path, uploaded_by, sigungu_code, seg_no, seg_start_km, seg_end_km, seg_variant)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
                roadGrade, routeNo, routeName, section.rdid, category, base, storedPath, convertedPath, userId, userSigungu || null,
                segInfo ? segInfo.segNo : null, segInfo ? segInfo.segStartKm : null, segInfo ? segInfo.segEndKm : null, segInfo ? segInfo.segVariant : null,
            ]
        );
        matched.push({ name: base, sect, category });
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { matched, unmatched };
}

module.exports = { bulkUploadRouteDrawings };
