// 노선(구간) 단위 도면·구조물·공사도면·영상 자료 API.
// road_ledger_files(files.js)는 필지(pnu) 단위지만, 이건 도로등급+노선번호+노선명
// 조합으로 식별되는 노선 전체에 붙는 자료다 — 좌측 CAD 뷰어 패널에서 사용.
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const pool = require('../db');
const config = require('../config');
const { requireAuth, requireAdmin } = require('../middleware/requireAuth');
const { convertDwgToDxf } = require('../lib/dwgConvert');
const { parseStationFilename, classifyDrawingType, DRAWING_TYPES } = require('../lib/routeFileNaming');
const { bulkUploadRouteDrawings } = require('../lib/routeDrawingsBulk');

const router = express.Router();
const CATEGORIES = ['도로', '도면종류', '구조물', '공사도면', '동영상'];

router.use(requireAuth);

function fixMultipartFilename(name) {
    return Buffer.from(name, 'latin1').toString('utf8');
}

// 노선 식별자를 안전한 파일 경로 조각으로 변환 (업로드 디렉터리 분리용)
function routeDirName(roadGrade, routeNo, routeName) {
    const safe = (s) => String(s || '').replace(/[/\\:*?"<>|]/g, '_').trim();
    return [safe(roadGrade), safe(routeNo), safe(routeName)].filter(Boolean).join('__') || 'unspecified';
}

function parseRouteQuery(q) {
    const roadGrade = q.road_grade;
    if (!roadGrade) return null;
    return { roadGrade, routeNo: q.route_no || '', routeName: q.route_name || '', sectionRdid: q.section_rdid || '' };
}

// road_grade 등 텍스트 필드는 파일 필드보다 뒤에 올 수도 있어(HTML form/브라우저
// 구현에 따라 순서가 보장 안 됨), multer의 diskStorage.destination()이 req.body를
// 아직 못 읽는 문제가 생길 수 있다. 그래서 일단 메모리에 버퍼링해 req.body가 전부
// 채워진 뒤(라우트 핸들러 시점) 직접 디스크에 쓴다.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// 노선 도면 일괄 업로드(ZIP)용 — 사진 없이 dxf/dwg만 묶어도 대량이면 수백MB가
// 될 수 있어(bulkImport.js와 동일한 이유로) 메모리 대신 디스크에 바로 쓴다.
const zipTmpDir = path.join(config.uploadDir, 'route-drawings-zip-tmp');
fs.mkdirSync(zipTmpDir, { recursive: true });
const uploadZip = multer({
    storage: multer.diskStorage({
        destination: zipTmpDir,
        filename: (req, file, cb) => cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}.zip`),
    }),
    limits: { fileSize: 1024 * 1024 * 1024 },
});

// 파일에 태깅된 sigungu_code가 로그인 계정의 관할과 다르면 접근을 막는다.
// NULL(비계정범위 파일 또는 전체공개 계정)은 항상 허용한다.
function outsideJurisdiction(userSigungu, fileSigungu) {
    return !!userSigungu && !!fileSigungu && userSigungu !== fileSigungu;
}

router.get('/', async (req, res) => {
    const route = parseRouteQuery(req.query);
    if (!route) return res.status(400).json({ error: 'road_grade가 필요합니다.' });
    const userSigungu = req.session.user.sigunguCode;

    const params = [route.roadGrade, route.routeNo, route.routeName];
    // sec.sect/sec.length_m: 노선 전체(호선) 단위로 볼 때는 한 파일목록에 여러
    // 구간의 파일이 섞여 나오는데(section_rdid가 서로 다름), 그 노선 전체 파일
    // (예: CON, seg_no 없음)의 이름표를 "그 파일이 실제로 속한 구간"의 구간명+
    // 총연장으로 보여주려면 파일마다 자기 구간 정보가 필요하다 — currentRoute는
    // 호선 전체 모드에서 sect/length_m이 비어있어서 그것만으로는 안 됐다.
    let sql = `SELECT f.id, f.file_category, f.original_name, f.uploaded_at, f.sigungu_code,
                      (f.converted_path IS NOT NULL) AS has_preview, a.display_name AS uploaded_by_name,
                      f.seg_no, f.seg_start_km, f.seg_end_km, f.seg_variant,
                      sec.sect AS section_sect, sec.length_m AS section_length_m
               FROM route_files f
               LEFT JOIN accounts a ON a.id = f.uploaded_by
               LEFT JOIN road_sections sec ON sec.rdid = f.section_rdid
               WHERE f.road_grade = $1 AND f.route_no = $2 AND f.route_name = $3`;
    // RDID(구간 단위)가 있으면 그 구간의 파일만 정확히 걸러낸다 — 없으면(과거 데이터 등)
    // 노선 전체(도로등급+노선번호+노선명) 기준으로 보여준다.
    if (route.sectionRdid) {
        params.push(route.sectionRdid);
        sql += ` AND f.section_rdid = $${params.length}`;
    }
    // drawing_type(평면도/용지도/매설물도/구조물도)은 "도로"+"도면종류" 두 카테고리를
    // 넘나드는 상위 분류라 category 필터 대신 이걸 쓴다 — "도면종류" 탭이 도로 탭
    // (500m 구간 P/Y)까지 포함하는 상위 개념이라는 요구사항 때문이다. 두 값이 같이
    // 오면 drawing_type이 우선한다.
    const drawingType = req.query.drawing_type;
    if (drawingType && DRAWING_TYPES.includes(drawingType)) {
        sql += ` AND f.file_category IN ('도로', '도면종류')`;
    } else if (req.query.category && CATEGORIES.includes(req.query.category)) {
        params.push(req.query.category);
        sql += ` AND f.file_category = $${params.length}`;
    }
    sql += ' ORDER BY f.uploaded_at DESC';

    const { rows } = await pool.query(sql, params);
    let files = rows.filter((f) => !outsideJurisdiction(userSigungu, f.sigungu_code));
    if (drawingType && DRAWING_TYPES.includes(drawingType)) {
        files = files.filter((f) => classifyDrawingType(f) === drawingType);
    }
    res.json({ files });
});

router.post('/', upload.single('file'), async (req, res) => {
    const route = parseRouteQuery(req.body);
    if (!route) return res.status(400).json({ error: 'road_grade가 필요합니다.' });
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

    const category = CATEGORIES.includes(req.body.category) ? req.body.category : '도로';
    const userId = req.session.user.id;
    const userSigungu = req.session.user.sigunguCode;
    const originalName = fixMultipartFilename(req.file.originalname);

    const dir = path.join(config.uploadDir, 'routes', routeDirName(route.roadGrade, route.routeNo, route.routeName));
    fs.mkdirSync(dir, { recursive: true });
    const storedPath = path.join(dir, `${Date.now()}_${originalName.replace(/[/\\]/g, '_')}`);
    fs.writeFileSync(storedPath, req.file.buffer);

    // DWG는 브라우저에서 직접 볼 수 없으니 미리보기용 DXF를 미리 변환해둔다.
    // 변환기가 설정 안 됐거나 실패해도 원본 업로드 자체는 그대로 성공시킨다.
    let convertedPath = null;
    if (/\.dwg$/i.test(originalName)) {
        const candidatePath = storedPath.replace(/\.dwg$/i, '.dxf');
        const ok = await convertDwgToDxf(storedPath, candidatePath);
        if (ok) convertedPath = candidatePath;
    }

    // "도로" 카테고리이고 파일명이 500m 단위 구간 도면 패턴(예: 000801100500P.dwg)과
    // 맞으면 시점/종점/구간번호를 파싱해둔다 — 좌측 CAD 패널의 "도로" 탭이 이 값으로
    // 표(번호/명칭/시점/종점) 형태로 묶어서 보여준다. 패턴에 안 맞으면 전부 NULL로
    // 남고 기존처럼 평범한 파일 목록에 표시된다.
    let seg = null;
    if (category === '도로') {
        let sectionLengthKm = null;
        if (route.sectionRdid) {
            const { rows: secRows } = await pool.query('SELECT length_m FROM road_sections WHERE rdid = $1', [route.sectionRdid]);
            if (secRows[0] && secRows[0].length_m != null) sectionLengthKm = Number(secRows[0].length_m) / 1000;
        }
        seg = parseStationFilename(originalName, sectionLengthKm);
    }

    const { rows } = await pool.query(
        `INSERT INTO route_files (road_grade, route_no, route_name, section_rdid, file_category, original_name, stored_path, converted_path, uploaded_by, sigungu_code, seg_no, seg_start_km, seg_end_km, seg_variant)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id, file_category, original_name, uploaded_at, (converted_path IS NOT NULL) AS has_preview, seg_no, seg_start_km, seg_end_km, seg_variant`,
        [
            route.roadGrade, route.routeNo, route.routeName, route.sectionRdid || null, category, originalName, storedPath, convertedPath, userId, userSigungu || null,
            seg ? seg.segNo : null, seg ? seg.segStartKm : null, seg ? seg.segEndKm : null, seg ? seg.segVariant : null,
        ]
    );
    res.status(201).json({ file: rows[0] });
});

// 노선 도면 일괄 업로드(ZIP) — 500m 단위 구간도면(500_P/500_Y)과 구간현황
// 개요도(CON 등)를 zip 하나로 통째로 올리면, 파일명에서 구간을 알아내 이미
// 등록된 이 노선의 구간들에 자동으로 나눠 붙인다. section_rdid를 안 받는다
// (한 노선의 여러 구간에 걸쳐 나눠 붙이는 게 목적이라 특정 구간 하나로 못
// 좁힘) — 대신 road_grade+route_no로 이 노선에 등록된 구간 전체를 대상으로
// 삼는다. ':fileId'보다 먼저 등록해야 한다.
router.post('/bulk-zip', uploadZip.single('file'), async (req, res) => {
    const route = parseRouteQuery(req.body);
    if (!route) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'road_grade가 필요합니다.' });
    }
    if (!req.file) return res.status(400).json({ error: 'ZIP 파일이 없습니다.' });

    try {
        const result = await bulkUploadRouteDrawings({
            zipPath: req.file.path,
            roadGrade: route.roadGrade,
            routeNo: route.routeNo,
            routeName: route.routeName,
            userId: req.session.user.id,
            userSigungu: req.session.user.sigunguCode,
        });
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    } finally {
        fs.unlink(req.file.path, () => {});
    }
});

router.get('/:fileId', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM route_files WHERE id = $1', [req.params.fileId]);
    const file = rows[0];
    if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    if (outsideJurisdiction(req.session.user.sigunguCode, file.sigungu_code)) {
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }

    // variant=dxf: DWG의 CAD 뷰어 미리보기용 변환본을 요청. 없으면 404 — 원본
    // 다운로드(variant 없이 요청)는 항상 stored_path(원본) 그대로 내려간다.
    let targetPath = file.stored_path;
    let downloadName = file.original_name;
    if (req.query.variant === 'dxf') {
        if (!file.converted_path || !fs.existsSync(file.converted_path)) {
            return res.status(404).json({ error: '변환된 미리보기 파일이 없습니다.' });
        }
        targetPath = file.converted_path;
        downloadName = file.original_name.replace(/\.dwg$/i, '.dxf');
    }
    if (!fs.existsSync(targetPath)) {
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }

    if (req.query.inline === '1') {
        const encodedName = encodeURIComponent(downloadName);
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodedName}`);
        res.sendFile(path.resolve(targetPath));
    } else {
        res.download(targetPath, downloadName);
    }
});

// 프론트의 "관리자 모드"는 삭제 버튼 노출만 제어할 뿐(style.css의
// body.admin-mode 규칙), 실제 권한은 여기서 강제해야 한다 — 안 그러면 일반
// 계정도 API를 직접 호출해 지울 수 있다(sections.js DELETE와 동일한 관례).
router.delete('/:fileId', requireAdmin, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM route_files WHERE id = $1', [req.params.fileId]);
    const file = rows[0];
    if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    if (outsideJurisdiction(req.session.user.sigunguCode, file.sigungu_code)) {
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }
    await pool.query('DELETE FROM route_files WHERE id = $1', [file.id]);
    fs.promises.unlink(file.stored_path).catch(() => {});
    res.json({ ok: true });
});

module.exports = router;
