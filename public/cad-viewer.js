// 도면(CAD) 뷰어 공용 모듈 — index.html(좌측 사이드바 내장형)과 cad-popup.html(팝업
// 큰화면형) 둘 다 이 파일을 그대로 로드해서 쓴다. 그래서 여기 있는 함수들은
// document.getElementById 호출 시 "이 스크립트가 실행되는 문서" 기준으로 동작하므로,
// 팝업 창에서 로드되면 자연히 팝업 창 자신의 DOM을 찾게 된다 — 별도 분기 불필요.

let currentRoute = null; // { road_grade, route_no, route_name, start_point, end_point }
// "도로" 탭은 파일 목록이 아니라 "이 호선의 구간 중 어느 걸 볼지 고르는" 용도로
// 바뀌었다 — 여기서 구간을 고르면 currentRoute가 그 구간으로 바뀌고, "도면" 탭이
// 그 구간 기준으로 파일을 보여준다(loadRouteSectionPicker/selectSectionForFileBrowsing 참고).
let currentRouteCategory = '도로';
// "도면"(구 도면종류) 탭 안의 하위 유형(평면도/용지도/매설물도/구조물도) — 도로 탭(500m
// 구간 P/Y)과 도면종류 탭(TOP/CON 등 노선 전체 파일)을 유형별로 통합해서 보여줄
// 때 쓴다. classifyDrawingType()과 같은 규칙을 서버(routeFileNaming.js)가 쓴다.
let currentDrawingType = '평면도';

// 구간정보 패널의 "연장" 표시용 — index.html(단일 구간/호선 합산 둘 다),
// cad-popup.html(단일 구간) 공용.
function formatLengthM(value) {
    const n = Number(value);
    if (!value || !Number.isFinite(n) || n <= 0) return '-';
    return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })} m`;
}
let currentDxfFileUrl = null;
let currentDxfFileName = null;
// 지도에서 노선(구간 강조선)에 마우스오버했을 때 보여줄 부속시설 개수 그리드용 —
// loadRouteFacilityCounts()가 채워두면 script.js의 지도 호버 팝업이 재조회 없이 재사용한다.
let currentRouteFacilityCounts = {};

// 구간을 500m 단위로 미리 끊어둔 조각(road_sectors, 실측 SHP 적재분)과 그
// 단위로 묶은 부속시설 개수 — script.js가 마우스오버 시 지금 가리키는 500m
// 구간을 찾아 이 데이터로 "구간 전체"가 아니라 "그 500m만" 보여준다.
// 아직 500m SHP를 못 받은 노선은 currentRouteSectors가 빈 배열로 남고, 그
// 경우 지도 호버는 예전처럼 currentRouteFacilityCounts(구간 전체 합계)를 쓴다.
let currentRouteSectors = [];
let currentRouteSectorCounts = {};

async function loadRouteSectors(section) {
    currentRouteSectors = [];
    currentRouteSectorCounts = {};
    try {
        const params = new URLSearchParams({
            road_rank_name: section.road_rank_name || section.road_grade || '',
            route_no: section.route_no || '', sect: section.sect || '',
        });
        const [sectorsData, countsData] = await Promise.all([
            fetch('/api/sections/sectors?' + params.toString()).then((r) => r.json()),
            fetch('/api/sections/facility-counts-by-sector?' + params.toString()).then((r) => r.json()),
        ]);
        currentRouteSectors = sectorsData.sectors || [];
        currentRouteSectorCounts = countsData.buckets || {};
    } catch (e) { /* 500m 구간 데이터가 없는 노선은 예전처럼 구간 전체 합계로 동작 */ }
}

// 참고 화면과 동일한 부속시설 목록. 실제 시설 개수를 집계하는 데이터 소스가
// 아직 없어서 항목 틀만 표시하고 값은 0으로 둘 때도 있다(로드 실패 시).
const ROAD_FACILITY_TYPES = [
    '교량', '터널', '육교', '지하차도', '고가도로', '인터체인지(IC)', '지하보도',
    '교차시설', '오르막차로', '정차대', '측구', '석축', '옹벽',
    '도로절개면', '도로성토면', '배수암거및배수관', '중앙분리대',
    '차량방호안전시설', '충격흡수시설', '낙석방지시설', '표지', '전광표지',
    '가로등', '신호등', '방음시설', '가로수', '지하매설물', '과적검문소', '제설시설',
    '공동구', '통로박스', '생태통로', '긴급제동시설', '과속방지턱', '졸음쉼터',
];

function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s ?? '';
    return div.innerHTML;
}

function routeQueryParams() {
    return new URLSearchParams({
        road_grade: currentRoute.road_rank_name || currentRoute.road_grade || '',
        route_no: currentRoute.route_no || '',
        route_name: currentRoute.route_name || '',
        section_rdid: currentRoute.rdid || '',
    });
}

// 개별 파일(사진/보고서/도면) 다운로드 — 원래는 <a href> 네이티브 다운로드였으나
// 진행 중임을 보여줄 방법이 없어서(브라우저가 알아서 처리) fetch+blob 방식으로
// 바꿨다. 개별 첨부는 노선 전체 zip(downloadSectionExport)과 달리 보통 크지
// 않아서 전체를 메모리에 올려도 부담이 적다 — 대용량은 여전히 SFTP/서버 폴더
// 경로(방식 A/B)로 처리하는 게 원칙.
async function downloadFileWithBusyCursor(url, filename, btnEl) {
    document.body.classList.add('app-busy');
    const originalHtml = btnEl.innerHTML;
    btnEl.disabled = true;
    btnEl.innerHTML = '<i class="fa-solid fa-hourglass-half bulk-spinner"></i>';
    try {
        const res = await fetch(url);
        if (!res.ok) { alert('다운로드에 실패했습니다.'); return; }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(objectUrl);
    } catch (e) {
        alert('다운로드에 실패했습니다.');
    } finally {
        document.body.classList.remove('app-busy');
        btnEl.disabled = false;
        btnEl.innerHTML = originalHtml;
    }
}

// 파일 목록 행 하나(파일명 + DWG 배지 + 다운로드/삭제 아이콘) — 카테고리 무관
// 공용. "도로" 탭에서 500m 단위 패턴에 안 맞는 파일(seg_no 없음)도 이 형태
// 그대로 표 아래에 보여준다(하위호환 — 기존에 올라간 파일이 안 사라짐).
function buildRouteFileRow(f) {
    const isDwg = /\.dwg$/i.test(f.original_name);
    const dwgBadge = isDwg
        ? (f.has_preview
            ? '<span class="file-dwg-badge file-dwg-badge-ok" title="변환된 미리보기 있음">DXF 변환됨</span>'
            : '<span class="file-dwg-badge file-dwg-badge-none" title="미리보기 없음 — 원본만 다운로드 가능">미리보기 없음</span>')
        : '';
    const row = document.createElement('div');
    row.className = 'file-item';
    row.innerHTML = `
        <span class="file-name">${escapeHtml(f.original_name)}</span>
        ${dwgBadge}
        <button class="file-dl-btn" title="다운로드"><i class="fa-solid fa-download"></i></button>
        <button class="file-del-btn" title="삭제"><i class="fa-solid fa-trash"></i></button>
    `;
    row.querySelector('.file-name').addEventListener('click', () => openRouteFileInViewer(f));
    const dlBtn = row.querySelector('.file-dl-btn');
    dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadFileWithBusyCursor(`/api/routes/files/${f.id}`, f.original_name, dlBtn);
    });
    const delBtn = row.querySelector('.file-del-btn');
    delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`"${f.original_name}" 파일을 삭제하시겠습니까?`)) return;
        await fetch(`/api/routes/files/${f.id}`, { method: 'DELETE' });
        loadRouteFileList();
    });
    return row;
}

// "도면종류" 탭에서 500m 구간 표 위에 얹는 노선 전체 단위 파일(TOP/CON 등,
// seg_no 없음) 한 줄 — buildRouteFileRow와 달리 파일명을 그대로 보여주는 대신
// 등록된 구간 데이터 기준으로 "군도 8호선 월산-와우 001구간 (5,023 m)" 형태로
// 조합해서 보여준다(요청사항). route_no는 "0008"처럼 0으로 채워진 4자리라
// 숫자로 바꿔 앞자리 0을 없앤 뒤 "호선"을 붙인다. 다운로드/삭제는 관리자모드
// 에서만 노출한다(.rs-name-dl-btn/.rs-file-del-btn을 그대로 재사용 — 도로 탭
// 표에서 쓰는 것과 같은 클래스라 body.admin-mode CSS가 그대로 적용됨). "DXF
// 변환됨" 배지도 여기선 안 보여준다(요청사항).
function buildRouteWholeFileRow(f) {
    const roadGrade = currentRoute.road_rank_name || currentRoute.road_grade || '';
    const routeNoNum = parseInt(currentRoute.route_no, 10);
    const routeNoText = Number.isFinite(routeNoNum) ? `${routeNoNum}호선` : (currentRoute.route_no || '');
    const parts = [roadGrade, routeNoText, currentRoute.route_name || ''].filter(Boolean);
    // 호선 전체(구간 선택 없이) 볼 때는 currentRoute.sect/length_m이 비어있다 —
    // 대신 이 파일이 실제로 속한 구간의 정보(f.section_sect/section_length_m,
    // 서버가 route_files.section_rdid로 road_sections를 조인해 같이 내려준다)를
    // 쓴다. 구간을 직접 선택했을 때는 둘 다 같은 값이라 결과는 동일하다.
    const sect = currentRoute.sect || f.section_sect;
    const lengthM = currentRoute.length_m != null && currentRoute.length_m !== '' ? currentRoute.length_m : f.section_length_m;
    if (sect) parts.push(`${sect}구간`);
    const label = `${parts.join(' ')} (${formatLengthM(lengthM)})`;
    const row = document.createElement('div');
    row.className = 'route-whole-file-row';
    row.innerHTML = `
        <span class="rwf-no">전체</span>
        <span class="rwf-name">${escapeHtml(label)}</span>
        <button type="button" class="rs-name-dl-btn" title="${escapeHtml(f.original_name)} 다운로드"><i class="fa-solid fa-download"></i></button>
        <button type="button" class="rs-file-del-btn" title="${escapeHtml(f.original_name)} 삭제"><i class="fa-solid fa-xmark"></i></button>
    `;
    row.querySelector('.rwf-name').addEventListener('click', () => openRouteFileInViewer(f));
    const dlBtn = row.querySelector('.rs-name-dl-btn');
    dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadFileWithBusyCursor(`/api/routes/files/${f.id}`, f.original_name, dlBtn);
    });
    const delBtn = row.querySelector('.rs-file-del-btn');
    delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`"${f.original_name}" 파일을 삭제하시겠습니까?`)) return;
        await fetch(`/api/routes/files/${f.id}`, { method: 'DELETE' });
        // "도면종류" 탭(loadRouteFileList)뿐 아니라 "도로" 탭(loadRouteSectionPicker,
        // 구간 목록 아래에 종류별 전체 도면을 같이 보여줌)에서도 이 행이 쓰이므로,
        // 지금 활성 탭에 맞는 쪽을 다시 그리는 refreshRouteFilePanel()을 쓴다.
        refreshRouteFilePanel();
    });
    return row;
}

// "도로" 탭 전용 — 500m 단위 구간 도면을 번호/명칭/시점/종점 표로 묶어 보여준다
// (다른 시스템의 도면뷰어 참고화면과 동일한 구성). seg_no가 같은 파일들(P/Y 등
// 변형)을 한 행에 모아서, 변형별 아이콘을 나란히 배치한다.
function buildRouteFileSegmentTable(segFiles) {
    const bySeg = new Map();
    segFiles.forEach((f) => {
        if (!bySeg.has(f.seg_no)) bySeg.set(f.seg_no, []);
        bySeg.get(f.seg_no).push(f);
    });
    const segNos = [...bySeg.keys()].sort((a, b) => a - b);

    const table = document.createElement('div');
    table.className = 'route-seg-table';
    table.innerHTML = `
        <div class="route-seg-row route-seg-header">
            <span class="rs-no">번호</span>
            <span class="rs-name">명칭</span>
            <span class="rs-range">시점</span>
            <span class="rs-range">종점</span>
            <span class="rs-files">도면</span>
        </div>
    `;
    const routeName = currentRoute.route_name || currentRoute.road_rank_name || '-';
    segNos.forEach((segNo) => {
        const variants = bySeg.get(segNo).sort((a, b) => (a.seg_variant || '').localeCompare(b.seg_variant || ''));
        const row = document.createElement('div');
        const first = variants[0];
        // script.js가 지도 클릭으로 관리하는 selectedSector({sect, sect_st, sect_ed})와
        // 매칭 — road_sectors(실측 SHP)와 route_files(파일명 파싱값)는 별도 테이블이라
        // FK는 없지만, 같은 500m 격자를 가리키므로 오차 허용 비교로 충분하다.
        const isSectorSelected = typeof selectedSector !== 'undefined' && selectedSector &&
            variants.some((f) => f.section_sect === selectedSector.sect && Math.abs(Number(f.seg_start_km) - selectedSector.sect_st) < 0.01);
        row.className = 'route-seg-row' + (isSectorSelected ? ' sector-selected' : '');
        row.innerHTML = `
            <span class="rs-no">${String(segNo).padStart(2, '0')}</span>
            <span class="rs-name">
                <span class="rs-name-text">${escapeHtml(routeName)}</span>
                <button type="button" class="rs-name-dl-btn" title="${segNo}번 구간 도면 다운로드"><i class="fa-solid fa-download"></i></button>
            </span>
            <span class="rs-range">${Number(first.seg_start_km).toFixed(3)}</span>
            <span class="rs-range">${Number(first.seg_end_km).toFixed(3)}</span>
            <span class="rs-files"></span>
        `;
        // 관리자모드 전용 — 그 번호(구간)의 도면 파일(P/Y 등 변형 전부)을 순서대로
        // 내려받는다. 여러 개면 브라우저가 다운로드를 여러 건 순서대로 처리한다.
        const nameDlBtn = row.querySelector('.rs-name-dl-btn');
        nameDlBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            nameDlBtn.disabled = true;
            for (const f of variants) {
                await downloadFileWithBusyCursor(`/api/routes/files/${f.id}`, f.original_name, nameDlBtn);
            }
            nameDlBtn.disabled = false;
        });
        const filesEl = row.querySelector('.rs-files');
        variants.forEach((f) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'rs-file-btn';
            // 예전엔 P/Y(원본 파일명의 변형 문자)를 그대로 보여줬는데, 이게 무슨
            // 뜻인지 직관적이지 않았다(요청사항) — 이 파일이 속한 구간명(예: "001",
            // road_sections.sect)을 대신 보여준다. 노선 전체(호선) 보기처럼 여러
            // 구간의 500m 조각이 섞여 나올 때, 서로 다른 구간인데 seg_no가 같아서
            // 한 줄에 같이 묶이는 경우에도 이 표시로 구분할 수 있다.
            // 화면에는 앞자리 0 없이(001 -> 1) 짧게 보여주고, 정확한 값(툴팁)엔
            // 원래 3자리 구간번호를 그대로 남긴다(요청사항).
            const sectShort = f.section_sect ? String(parseInt(f.section_sect, 10)) : null;
            btn.title = `${f.section_sect ? `${f.section_sect}구간` : f.seg_variant} — ${f.original_name}`;
            btn.textContent = sectShort || f.seg_variant || '?';
            btn.addEventListener('click', () => openRouteFileInViewer(f));
            filesEl.appendChild(btn);
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'rs-file-del-btn';
            delBtn.title = `${f.original_name} 삭제`;
            delBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm(`"${f.original_name}" 파일을 삭제하시겠습니까?`)) return;
                await fetch(`/api/routes/files/${f.id}`, { method: 'DELETE' });
                loadRouteFileList();
            });
            filesEl.appendChild(delBtn);
        });
        table.appendChild(row);
    });
    return table;
}

// "도로" 탭(구간 고르기)이면 loadRouteSectionPicker, 그 외 탭이면 기존
// loadRouteFileList — 구간을 새로 선택했을 때(트리 클릭, 도로 탭에서 구간
// 클릭, 팝업 초기 로딩 등) 지금 활성화된 탭에 맞는 쪽을 다시 그려야 하므로
// 외부(script.js/cad-popup.html)에서는 이 함수 하나만 부르면 된다.
function refreshRouteFilePanel() {
    if (currentRouteCategory === '도로') loadRouteSectionPicker();
    else loadRouteFileList();
}

// "도로" 탭 — 파일이 아니라 지금 노선(currentRoute.route_no)의 구간 목록을
// 보여주고, 하나를 고르면 그 구간으로 currentRoute를 바꿔서 "도면" 탭 등
// 나머지 탭이 그 구간 기준으로 파일을 보여주게 한다(요청사항: 도로 탭에서
// 구간을 골라 도면 탭에서 그 도면을 본다). 구간 목록은 데이터보기 트리와 같은
// /api/sections/tree를 재사용한다(전용 API 없이도 이미 다 있는 데이터라).
// 구간 행 클릭 한 번에도 selectSectionForLeftSidebar -> refreshRouteFilePanel
// 경로와, 그 아래 명시적으로 다시 부르는 loadRouteSectionPicker() 두 경로로
// 이 함수가 겹쳐 호출된다(기존부터 있던 구조 — 예전엔 매번 같은 tree 데이터로
// 목록을 그대로 다시 그리기만 해서 겹쳐도 티가 안 났음). 지금은 그 아래에서
// 전체 도면을 네 번(종류별) 비동기로 더 조회하는데, 구간을 빠르게 넘나들면
// 먼저 클릭한(오래된) 구간의 응답이 나중에 도착해 최신 화면에 그대로 덧붙여지는
// 문제가 있었다 — 매 호출마다 토큰을 발급해서, 응답이 왔을 때 그사이 더 최신
// 호출이 있었으면(토큰 불일치) 그 결과는 버리고 화면에 반영하지 않는다.
let routeSectionPickerToken = 0;
async function loadRouteSectionPicker() {
    const myToken = ++routeSectionPickerToken;
    const listEl = document.getElementById('route-file-list');
    if (!currentRoute) {
        listEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;">데이터보기 트리에서 노선을 선택하세요.</div>';
        return;
    }
    listEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;">불러오는 중...</div>';
    const { tree } = await fetch('/api/sections/tree').then((r) => r.json());
    if (myToken !== routeSectionPickerToken) return; // 기다리는 동안 더 최신 호출이 시작됐으면 여기서 중단
    const roadGrade = currentRoute.road_rank_name || currentRoute.road_grade;
    const gradeGroup = (tree || []).find((g) => g.road_grade === roadGrade);
    const routeGroup = gradeGroup && gradeGroup.routes.find((r) => r.route_no === currentRoute.route_no);
    const sections = routeGroup ? [...routeGroup.sections].sort((a, b) => (a.sect || '').localeCompare(b.sect || '')) : [];

    listEl.innerHTML = '';
    if (!sections.length) {
        listEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;">등록된 구간이 없습니다.</div>';
        return;
    }
    sections.forEach((section) => {
        const row = document.createElement('div');
        row.className = 'route-section-pick-row' + (section.rdid === currentRoute.rdid ? ' active' : '');
        row.innerHTML = `
            <span class="rsp-name">${escapeHtml(section.sect ? `${section.sect}구간` : '-')}</span>
            <span class="rsp-range">${escapeHtml(formatLengthM(section.length_m))}</span>
        `;
        row.addEventListener('click', () => {
            selectSectionForFileBrowsing({
                ...section,
                road_rank_name: gradeGroup.road_grade, road_grade: gradeGroup.road_grade,
                route_no: routeGroup.route_no, route_name: routeGroup.route_name,
            });
            loadRouteSectionPicker(); // active 표시만 다시 그림(선택 갱신)
        });
        listEl.appendChild(row);
    });

    await loadWholeDrawingsByTypeBelowSectionList(listEl, myToken);
}

// "도로" 탭 — 구간을 고르면 그 구간의 평면도/용지도/매설물도/구조물도 각각의
// "전체"(500m 단위로 안 쪼개진, 구간 전체 단위) 도면이 있는지 종류별로 조회해서
// 구간 목록 아래에 같이 보여준다 — 원래 "도면" 탭에서 하위탭을 하나씩 눌러가며
// 찾아야 했던 것을 "도로" 탭 한곳에서 바로 골라 열 수 있게 한다(요청사항).
// 값은 /api/routes/files?drawing_type=...(classifyDrawingType, routeFileNaming.js)를
// 그대로 재사용 — 종류별로 없으면(아직 그 종류를 아무도 안 올렸으면) 그 종류는
// 그냥 건너뛴다.
const WHOLE_DRAWING_TYPES = ['평면도', '용지도', '매설물도', '구조물도'];
async function loadWholeDrawingsByTypeBelowSectionList(listEl, myToken) {
    if (!currentRoute.rdid) return;
    const results = await Promise.all(
        WHOLE_DRAWING_TYPES.map(async (type) => {
            const params = routeQueryParams();
            params.set('drawing_type', type);
            const { files } = await fetch('/api/routes/files?' + params.toString()).then((r) => r.json());
            const whole = (files || []).find((f) => f.seg_no == null);
            return whole ? { type, file: whole } : null;
        })
    );
    // 네 종류 조회가 진행되는 동안 구간을 또 바꿨으면(더 최신 호출이 시작됐으면)
    // 이 오래된 결과는 화면에 반영하지 않고 버린다 — 중복/엉뚱한 구간 표시 방지.
    if (myToken !== routeSectionPickerToken) return;
    const withFiles = results.filter(Boolean);
    if (!withFiles.length) return;

    const heading = document.createElement('div');
    heading.className = 'route-whole-file-heading';
    heading.textContent = '전체 도면';
    listEl.appendChild(heading);
    withFiles.forEach(({ type, file }) => {
        const row = buildRouteWholeFileRow(file);
        // buildRouteWholeFileRow는 원래 "전체"라고만 배지를 붙이는데(도면 탭처럼
        // 이미 종류 하위탭 안이라 구분할 필요가 없었음), 여기는 네 종류가 한
        // 목록에 섞여 나오니 배지를 실제 종류명으로 바꿔 구분한다.
        const badge = row.querySelector('.rwf-no');
        if (badge) badge.textContent = type;
        listEl.appendChild(row);
    });
}

// "도로" 탭에서 구간을 고르면 실행 — index.html(트리/지도가 있는 컨텍스트)에서는
// script.js의 selectSectionForLeftSidebar를 그대로 써서 트리 강조/지도까지 같이
// 맞춘다. cad-popup.html처럼 그 함수가 없는 컨텍스트에서는 최소한만(정보 탭
// 필드 + 파일목록) 직접 갱신한다.
function selectSectionForFileBrowsing(section) {
    if (typeof selectSectionForLeftSidebar === 'function') {
        selectSectionForLeftSidebar(section);
        return;
    }
    currentRoute = section;
    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    setText('ri-road-grade', section.road_rank_name || section.road_grade || '-');
    setText('ri-route-name', section.route_name || '-');
    setText('ri-segment-name', section.sect ? `${section.sect}구간` : '-');
    setText('ri-length', formatLengthM(section.length_m));
    const sEl = document.getElementById('ri-start-point'); if (sEl) sEl.textContent = section.s_point || '-';
    const eEl = document.getElementById('ri-end-point'); if (eEl) eEl.textContent = section.e_point || '-';
    // "도로" 탭(구간 선택 목록)에서 구간을 고른 직후인데 여기서 무조건
    // loadRouteFileList()를 부르면 currentRouteCategory와 무관하게 파일
    // 목록으로 화면이 바뀌어버린다("도로" 탭인데 도면 목록이 나오던 버그의
    // 원인) — 지금 활성 탭 기준으로 알맞은 쪽(도로면 다시 구간 선택 목록,
    // 도면 등이면 파일 목록)을 그리는 refreshRouteFilePanel()을 대신 쓴다.
    refreshRouteFilePanel();
    if (typeof loadRouteFacilityCounts === 'function') loadRouteFacilityCounts(section);
    loadRouteSectors(section);
}

async function loadRouteFileList() {
    const listEl = document.getElementById('route-file-list');
    if (!currentRoute) {
        listEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;">데이터보기 트리에서 노선을 선택하세요.</div>';
        return;
    }
    const params = routeQueryParams();
    // "도면종류" 탭은 유형(평면도/용지도/매설물도/구조물도) 기준으로 조회한다 —
    // 도로 탭(500m 구간 P/Y)과 도면종류 탭(TOP/CON 등 노선 전체 파일)을 넘나드는
    // 상위 분류라 category 대신 drawing_type을 쓴다(server routeFiles.js 참고).
    if (currentRouteCategory === '도면종류') {
        params.set('drawing_type', currentDrawingType);
    } else {
        params.set('category', currentRouteCategory);
    }
    const { files: rawFiles } = await fetch('/api/routes/files?' + params.toString()).then((r) => r.json());
    // "도로" 탭은 평면도(P)만 보여준다 — 용지도(Y)는 도면종류 탭의 용지도
    // 하위탭에서 본다(요청사항: 도로 탭엔 평면도만).
    const files = currentRouteCategory === '도로' ? rawFiles.filter((f) => f.seg_no == null || f.seg_variant === 'P') : rawFiles;

    listEl.innerHTML = '';
    if (!files || files.length === 0) {
        listEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;">등록된 파일이 없습니다.</div>';
        return;
    }

    if (currentRouteCategory === '도로' || currentRouteCategory === '도면종류') {
        // 500m 단위 패턴을 파싱해둔 파일(seg_no 있음)은 표로, 그 외(노선 전체
        // 단위 파일, 예: TOP/CON)는 별도 요약 줄로 보여준다.
        const segFiles = files.filter((f) => f.seg_no != null);
        const plainFiles = files.filter((f) => f.seg_no == null);
        if (currentRouteCategory === '도면종류') {
            // 노선 전체 파일(TOP/CON)이 500m 구간 표보다 위에 오도록(요청사항).
            plainFiles.forEach((f) => listEl.appendChild(buildRouteWholeFileRow(f)));
            if (segFiles.length) listEl.appendChild(buildRouteFileSegmentTable(segFiles));
        } else {
            if (segFiles.length) listEl.appendChild(buildRouteFileSegmentTable(segFiles));
            plainFiles.forEach((f) => listEl.appendChild(buildRouteFileRow(f)));
        }
        return;
    }

    files.forEach((f) => listEl.appendChild(buildRouteFileRow(f)));
}

async function uploadOneRouteFile(file) {
    // 주의: multer는 파일 필드보다 뒤에 오는 텍스트 필드를 destination() 콜백
    // 시점에 아직 못 읽는다 — road_grade 등은 반드시 file보다 먼저 append해야 한다.
    const formData = new FormData();
    formData.append('road_grade', currentRoute.road_rank_name || currentRoute.road_grade || '');
    formData.append('route_no', currentRoute.route_no || '');
    formData.append('route_name', currentRoute.route_name || '');
    formData.append('section_rdid', currentRoute.rdid || '');
    formData.append('category', currentRouteCategory);
    formData.append('file', file);
    const res = await fetch('/api/routes/files', { method: 'POST', body: formData });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `${file.name}: 업로드 실패`);
    }
    return (await res.json()).file;
}

// 500m 단위 구간 도면처럼 한 노선에 파일이 수십 개씩(P/Y 합쳐 50개 이상) 딸린
// 경우를 감안해 다중 선택을 지원한다(#route-upload-file에 multiple 속성).
// 순서대로 하나씩 올린다 — 동시에 수십 개를 병렬로 쏘면 서버 메모리(multer가
// 메모리 버퍼링 방식이라)에 부담이 크다.
async function uploadRouteFile() {
    if (!currentRoute) { alert('먼저 데이터보기 트리에서 노선을 선택하세요.'); return; }
    const fileInput = document.getElementById('route-upload-file');
    if (!fileInput || !fileInput.files.length) return;

    const files = [...fileInput.files];
    document.body.classList.add('app-busy');
    const statusEl = document.getElementById('route-upload-status');
    let lastUploaded = null;
    const errors = [];
    try {
        for (let i = 0; i < files.length; i++) {
            if (statusEl) statusEl.textContent = `업로드 중... (${i + 1}/${files.length}) ${files[i].name}`;
            try {
                lastUploaded = await uploadOneRouteFile(files[i]);
            } catch (e) {
                errors.push(e.message);
            }
        }
    } finally {
        document.body.classList.remove('app-busy');
        if (statusEl) statusEl.textContent = '';
    }

    fileInput.value = '';
    await loadRouteFileList();
    if (errors.length) alert(`${errors.length}건 실패:\n${errors.slice(0, 10).join('\n')}`);
    if (files.length === 1 && lastUploaded && !errors.length) openRouteFileInViewer(lastUploaded);
}

function openRouteFileInViewer(file) {
    const ext = (file.original_name.split('.').pop() || '').toLowerCase();
    if (ext === 'dxf') {
        loadDxfFile(`/api/routes/files/${file.id}?inline=1`, file.original_name);
    } else if (ext === 'dwg') {
        if (file.has_preview) {
            loadDxfFile(`/api/routes/files/${file.id}?inline=1&variant=dxf`, file.original_name);
        } else {
            alert('이 DWG 파일은 미리보기를 사용할 수 없습니다.\n(서버에 DWG 변환 도구가 설정되지 않았거나 변환에 실패했습니다)\n다운로드 버튼으로 원본 파일은 받을 수 있습니다.');
        }
    } else if (typeof openFilePreview === 'function') {
        // 좌측 사이드바(메인 화면)에는 우측 분할뷰 미리보기가 있음
        openFilePreview(null, file.id, file.original_name, '/api/routes/files');
    } else {
        // 팝업 창처럼 분할뷰가 없는 곳에서는 그냥 새 탭으로 연다
        window.open(`/api/routes/files/${file.id}?inline=1`, '_blank');
    }
}

async function loadRouteFacilityCounts(section) {
    const filesEl = document.getElementById('route-facility-files');
    if (filesEl) filesEl.style.display = 'none';
    // 조회 중에도 항목 틀은 유지하고, 응답이 오면 값만 갱신한다
    let counts = {};
    try {
        const params = new URLSearchParams({
            road_rank_name: section.road_rank_name || section.road_grade || '',
            route_no: section.route_no || '', sect: section.sect || '',
        });
        const data = await fetch('/api/sections/facility-counts?' + params.toString()).then((r) => r.json());
        counts = data.counts || {};
    } catch (e) { /* 조회 실패 시 0으로 표시 */ }

    currentRouteFacilityCounts = counts;

    // index.html: 오른쪽 사이드바 데이터보기 탭의 그룹 트리로 표시(주요시설물/부대시설).
    // cad-popup.html은 이 패널 자체가 없어(script.js 미로드) typeof 체크로 건너뛴다.
    if (typeof renderRouteFacilityTree === 'function') renderRouteFacilityTree(counts);
}

// 부속시설 개수 그리드에서 항목 하나를 클릭하면, 현재 선택된 구간(currentRoute)의
// 그 시설물 종류에 자동 연결된 사진/보고서 목록을 그리드 아래 공유 패널에 보여준다.
async function openFacilityFileList(label) {
    const filesEl = document.getElementById('route-facility-files');
    if (!filesEl || !currentRoute) return;
    filesEl.style.display = 'block';
    filesEl.innerHTML = `<div class="rff-header">${escapeHtml(label)} 첨부파일<button class="rff-close" title="닫기">×</button></div><div class="rff-body">불러오는 중...</div>`;
    filesEl.querySelector('.rff-close').addEventListener('click', () => { filesEl.style.display = 'none'; });

    const bodyEl = filesEl.querySelector('.rff-body');
    try {
        const params = new URLSearchParams({
            label,
            road_rank_name: currentRoute.road_rank_name || currentRoute.road_grade || '',
            route_no: currentRoute.route_no || '', sect: currentRoute.sect || '',
        });
        const data = await fetch('/api/sections/facility-files?' + params.toString()).then((r) => r.json());
        const files = data.files || [];
        if (!files.length) {
            // 예전엔 여기서 바로 return해서 아래 scrollIntoView까지 건너뛰었다 —
            // 파일이 있을 때만 패널로 스크롤 이동하고 없을 때는 "연결된 첨부파일이
            // 없습니다" 문구가 어디 있는지 안 보여서 클릭이 씹힌 것처럼 느껴졌다
            // (요청사항). return을 빼고 끝까지 흘러가게 해서 항상 스크롤되게 한다.
            bodyEl.innerHTML = '<div class="rff-empty">연결된 첨부파일이 없습니다.</div>';
        } else {
            bodyEl.innerHTML = files
                .map((f) => `<div class="rff-row" data-id="${f.id}" data-name="${escapeHtml(f.original_name)}" data-table="${escapeHtml(f.facility_table || '')}" data-facility-rdid="${escapeHtml(f.facility_rdid || '')}"><span>${escapeHtml(f.file_kind)}</span><span>${escapeHtml(f.original_name)}</span></div>`)
                .join('');
            bodyEl.querySelectorAll('.rff-row').forEach((row) => {
                row.addEventListener('click', () => openFacilityFileRowClick(row));
            });
        }
    } catch (e) {
        bodyEl.innerHTML = '<div class="rff-empty">불러오기 실패</div>';
    }
    // 목록이 다 그려진 뒤에(행 개수만큼 높이가 확정된 뒤에) 스크롤해야
    // 헤더가 스크롤 영역 맨 위에 붙고 그 아래 여러 줄이 제대로 보인다 —
    // 로딩 중 상태(짧은 placeholder)일 때 미리 스크롤하면 그때 기준으로
    // 위치가 계산돼서, 나중에 목록이 길어져도 헤더 바로 아래 한두 줄만
    // 겨우 보이는 상태로 멈춰있는 문제가 있었다.
    filesEl.scrollIntoView({ behavior: 'auto', block: 'start' });
}

// 부속시설 첨부파일 목록(#route-facility-files)에서 파일 하나를 클릭했을 때 —
// 그 시설물의 속성정보를 먼저 조회해서 (1) 분할화면에 파일을 열면서 상단에
// 속성정보를 같이 보여주고, (2) 지도가 있는 화면(index.html)이면 그 시설물
// 위치로 지도를 이동시킨다. 도면뷰어 팝업창(cad-popup.html)은 지도 자체가
// 없어 위치 이동은 건너뛴다(map이 선언 안 된 전역이라 typeof로 안전하게 확인).
async function openFacilityFileRowClick(row) {
    const { id, name, table, facilityRdid } = row.dataset;
    let facilityInfo = null;
    if (table && facilityRdid) {
        try {
            const params = new URLSearchParams({ table, facility_rdid: facilityRdid });
            const data = await fetch('/api/sections/facility-detail?' + params.toString()).then((r) => r.json());
            if (data.record) {
                facilityInfo = { label: data.record.label, name: data.record.name, attributes: data.record.attributes };
                if (typeof map !== 'undefined' && map && data.record.geom) {
                    jumpToFacilityLocation(data.record.geom);
                }
            }
        } catch (e) { /* 속성정보 조회 실패해도 파일은 그대로 열어준다 */ }
    }
    if (typeof openFilePreview === 'function') {
        openFilePreview(null, id, name, '/api/sections/facility-files', facilityInfo);
    } else {
        window.open(`/api/sections/facility-files/${id}?inline=1`, '_blank');
    }
}

// GeoJSON 지오메트리 위치로 지도를 이동시키고 3초간 깜빡여 강조한다.
// facilityJumpLayer는 script.js의 initMap()에서 만드는 전용 강조 레이어 —
// 이 함수는 index.html(map이 있는 페이지)에서만 호출되므로 항상 존재한다.
function jumpToFacilityLocation(geom) {
    const geojsonFormat = new ol.format.GeoJSON();
    const feature = geojsonFormat.readFeature(
        { type: 'Feature', geometry: geom, properties: {} },
        { featureProjection: map.getView().getProjection() }
    );
    highlightFacilityFeature(feature);
    const extent = feature.getGeometry().getExtent();
    map.getView().fit(extent, { duration: 500, padding: [80, 80, 80, 80], maxZoom: 19 });
}

// 지도 이동 없이 강조만(지도에서 마커를 직접 클릭한 경우 — 이미 그 위치를 보고
// 있으니 이동은 필요 없고 어떤 걸 선택했는지만 확인시켜주면 됨). script.js의
// onMapClick(부속시설 마커 클릭)에서도 그대로 재사용한다.
function highlightFacilityFeature(feature) {
    facilityJumpLayer.getSource().clear();
    facilityJumpLayer.getSource().addFeature(feature);
    startFacilityJumpBlink();
}

// 완전히 켜짐/꺼짐을 반복하는 깜빡임(반투명이 아니라 진짜 점멸) — 3초 뒤에는
// 옅게 남기지 않고 강조 자체를 완전히 지운다.
let facilityJumpBlinkTimer = null;
function startFacilityJumpBlink() {
    if (facilityJumpBlinkTimer) clearInterval(facilityJumpBlinkTimer);
    let visible = true;
    facilityJumpLayer.setOpacity(1);
    facilityJumpBlinkTimer = setInterval(() => {
        visible = !visible;
        facilityJumpLayer.setOpacity(visible ? 1 : 0);
    }, 350);
    setTimeout(() => {
        clearInterval(facilityJumpBlinkTimer);
        facilityJumpBlinkTimer = null;
        facilityJumpLayer.getSource().clear();
        facilityJumpLayer.setOpacity(1);
    }, 3000);
}

// 도면 뷰어를 새 창(큰 화면)으로 팝업시킨다 — 지금 보고 있는 노선/구간과 도면을 그대로 이어서 연다.
function openCadPopup() {
    // window.opener로 상태를 넘기면 팝업 차단을 사용자가 나중에 수동으로 허용하는
    // 흐름 등에서 브라우저가 opener 연결을 끊어버리는 경우가 있어(실사용 중 확인됨),
    // 대신 URL 쿼리스트링에 필요한 값을 실어서 넘긴다 — 어떤 경로로 열리든 안전하다.
    const params = new URLSearchParams();
    if (currentRoute) {
        params.set('road_grade', currentRoute.road_rank_name || currentRoute.road_grade || '');
        params.set('route_no', currentRoute.route_no || '');
        params.set('route_name', currentRoute.route_name || '');
        params.set('sect', currentRoute.sect || '');
        params.set('s_point', currentRoute.s_point || '');
        params.set('e_point', currentRoute.e_point || '');
        params.set('rdid', currentRoute.rdid || '');
        params.set('length_m', currentRoute.length_m || '');
    }
    if (currentDxfFileUrl) {
        params.set('file_url', currentDxfFileUrl);
        params.set('file_name', currentDxfFileName || '');
    }

    const popup = window.open('cad-popup.html?' + params.toString(), 'cadPopup', 'width=1400,height=900,resizable=yes');
    if (!popup) {
        alert('팝업이 차단되었습니다. 브라우저의 팝업 차단을 해제해주세요.');
    }
}

// ---------- DXF 캔버스 뷰어 ----------
// dxf-parser(순수 파싱)만 CDN에서 가져오고, 렌더링은 Canvas2D로 직접 구현했다.
// 지원: LINE/LWPOLYLINE/POLYLINE/CIRCLE/ARC/POINT/TEXT/MTEXT/SPLINE(직선 근사)/INSERT(블록)
// 미지원(생략): HATCH, DIMENSION 등 — 도면이 일부만 표시될 수 있음
// dxf-parser가 ACI 256색 팔레트/트루컬러(24bit RGB)를 이미 다 계산해서
// entity.color/layer.color에 정수(0xRRGGBB)로 넣어준다 — 그걸 그대로 쓴다.
function rgbIntToHex(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    return '#' + (Math.max(0, n) & 0xffffff).toString(16).padStart(6, '0');
}

// AutoCAD Color Index(ACI) 1~9 표준 팔레트 — DXF 전체 표준에서 고정된 값이라
// 도면마다 다르지 않다. dxf-parser가 직접 파싱하는 엔티티는 이 변환을 이미
// 끝내서 e.color(트루컬러)에 넣어주지만, 우리가 직접 만드는 보충 엔티티(HATCH
// 등)는 colorIndex(그룹코드 62)만 가지고 있어서 _resolveColor()가 이 표로
// 대신 계산한다. 7번은 DXF 표준상 "배경에 따라 흰/검"이 정해진 규칙이라 고정
// 색 대신 'bg' 마커로 표시해 호출부에서 defaultColor(배경에 맞는 색)를 쓰게 한다.
const ACI_BASIC_PALETTE = {
    1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff',
    6: '#ff00ff', 7: 'bg', 8: '#414141', 9: '#808080',
};

// dxf-parser는 TEXT/MTEXT 문자열을 가공 없이 그대로 넘긴다 — AutoCAD가 ASCII DXF에
// 비-ASCII 문자를 넣을 때 쓰는 \U+XXXX 이스케이프(한글 등)도, MTEXT 서식 코드
// (\H1.5x;, \Cn;, \P 등)도 전부 날것 그대로라 fillText에 바로 넣으면 글자 대신
// "\U+C9C0..." 같은 escape 문자열이나 서식 코드가 그대로 찍힌다. 여기서 직접 해석한다.
//
// \M+X#### 는 AutoCAD 표준이 아니라 일부 서드파티 DXF 저작 툴(예: CADSoftTools의
// "CAD .NET")이 쓰는 자기네 표기법 — 뒤 4자리가 EUC-KR(완성형 한글) 2바이트
// 문자코드다. 실제 파일로 역추적해서 확인함: "\M+3B8B6\M+3BBEA\M+3B7CE" → "마산로".
const EUC_KR_DECODER = (typeof TextDecoder !== 'undefined') ? new TextDecoder('euc-kr') : null;

function decodeDxfText(raw) {
    if (!raw) return '';
    let s = raw;
    s = s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (EUC_KR_DECODER) {
        s = s.replace(/\\M\+[0-9A-Fa-f]([0-9A-Fa-f]{4})/g, (_, hex) => {
            try {
                const b1 = parseInt(hex.slice(0, 2), 16);
                const b2 = parseInt(hex.slice(2, 4), 16);
                return EUC_KR_DECODER.decode(new Uint8Array([b1, b2]));
            } catch (err) { return ''; }
        });
    }
    s = s.replace(/\\[A-Za-z][^;\\{}]*;/g, ''); // \Hx.x; \Cn; \Wn; \fFont|...; 등 서식 코드
    s = s.replace(/\\P/gi, '\n'); // 단락개행
    s = s.replace(/\\[X~]/g, ' ');
    s = s.replace(/[{}]/g, '');
    s = s.replace(/\\\\/g, '\\');
    return s;
}

// "_SLOPE" 레이어의 TEXT는 원본 캐드 프로그램(도로 종단 설계용 애드인)이 자기
// 자신만 다시 파싱해서 편집할 수 있도록 "시점역#종점역#S=경사%#수평거리#H=높이
// L=길이" 5개 필드를 "#"로 이어붙여 그룹코드 1(문자열)에 그대로 저장해둔다
// (실제 업로드 파일의 _SLOPE TEXT 16개 표본 전부 이 형식 — 예:
// "4+060#5+040#S=3.220%#39.10#H=5.17 L=962.00"). 원본 오토캐드 화면에는 3·5번째
// 필드(S=...%, H=...L=...)만 두 줄로 보이고 나머지(역 구간, 수평거리)는 안
// 보이는데, dxf-parser는 이 원문을 가공 없이 그대로 넘기므로 우리가 그대로
// fillText에 넣으면 "#"까지 전부 드러나 이상해 보였다(사용자 스크린샷으로
// 확인된 버그) — 그래서 이 레이어에서만 필드를 골라 재구성한다.
function formatSlopeAnnotationText(raw, layer) {
    if (layer !== '_SLOPE' || !raw) return raw;
    const parts = raw.split('#');
    if (parts.length === 5 && /^S=/.test(parts[2]) && /^H=/.test(parts[4])) {
        return `${parts[2]}\n${parts[4]}`;
    }
    return raw;
}

const dxfViewer = {
    canvas: null, ctx: null,
    entities: [], layers: {}, layerVisible: {}, blocks: {},
    bbox: null,
    scale: 1, panX: 0, panY: 0,
    bgDark: true,
    measureMode: null, // null | 'distance' | 'area'
    measurePoints: [], // 진행 중인 측정의 월드 좌표 점들
    measurements: [], // 완료된 측정 결과들 { type, points, value }

    load(dxf) {
        this.entities = dxf.entities || [];
        this.layers = (dxf.tables && dxf.tables.layer && dxf.tables.layer.layers) || {};
        this.blocks = dxf.blocks || {};
        this.layerVisible = {};
        // dxf-parser는 LAYER 테이블의 그룹코드 70(플래그)·62(색상)을 이미 layer.frozen
        // (동결)·layer.visible(off 레이어면 false, 색상값이 음수)로 해석해서 넘겨준다.
        // 예전엔 이걸 무시하고 무조건 전부 true로 켰는데, 실제 파일(_SLOPE 레이어,
        // 종단 구배 주기용 TEXT)이 원본 캐드에서는 동결(70=1)돼 있어 안 보이는데도
        // 우리 뷰어에서는 뜬금없이 보이는 버그가 있었다(사용자가 스크린샷으로 확인,
        // 원본엔 그 위치에 글자가 아예 없음). 오토캐드처럼 원본 DXF에 저장된 켜짐/꺼짐
        // 상태를 기본값으로 그대로 따른다 — 여전히 레이어 목록에서 수동으로 켤 수 있다.
        Object.keys(this.layers).forEach((name) => {
            const l = this.layers[name];
            this.layerVisible[name] = !(l && (l.frozen || l.visible === false));
        });
        // TITLE 레이어(장성로고 같은 기관 마크 INSERT)는 실제 파일에서 도면 프레임
        // 바깥 좌표에 놓여 있어 화면/인쇄 어디에도 보이지 않는데, 레이어 목록에는
        // 계속 뜨고 바운딩박스도 왜곡시켜 기본값을 꺼둔다(DXF 자체엔 동결 표시가
        // 없어 위 규칙만으론 안 잡힘). 필요하면 레이어 목록에서 다시 켤 수 있다.
        if ('TITLE' in this.layerVisible) this.layerVisible.TITLE = false;
        this.bbox = this._computeBBox();
        this.fit();
    },

    _computeBBox() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const consider = (x, y) => {
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        };
        this.entities.forEach((e) => {
            // TITLE 레이어는 실제 도면과 무관한 장식 요소(예: "장성로고" INSERT)가
            // 도면 본문에서 한참 떨어진 좌표에 박혀 있는 경우가 실제 파일에서
            // 확인됐다(도면 내용은 폭 ~540 범위인데 이 로고 하나 때문에 바운딩박스
            // 폭이 ~950으로 늘어나, "전체보기"/인쇄 모두에서 빈 배경이 크게 남았다).
            // 도면 프레임(CX-BORD-*)이나 실제 지형지물이 아니라 순수 장식이라
            // 바운딩박스 계산에서 제외한다.
            if (e.layer === 'TITLE') return;
            if (e.vertices) e.vertices.forEach((v) => consider(v.x, v.y));
            if (e.center) { consider(e.center.x - (e.radius || 0), e.center.y - (e.radius || 0)); consider(e.center.x + (e.radius || 0), e.center.y + (e.radius || 0)); }
            if (e.position) consider(e.position.x, e.position.y);
            if (e.startPoint) consider(e.startPoint.x, e.startPoint.y);
            if (e.controlPoints) e.controlPoints.forEach((v) => consider(v.x, v.y));
            if (e.boundaryPaths) e.boundaryPaths.forEach((path) => path.forEach((v) => consider(v.x, v.y)));
            if (e.points) e.points.forEach((v) => consider(v.x, v.y));
            if (e.corners) e.corners.forEach((v) => consider(v.x, v.y));
        });
        if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
        return { minX, minY, maxX, maxY };
    },

    fit() {
        if (!this.canvas || !this.bbox) return;
        const w = this.bbox.maxX - this.bbox.minX || 1;
        const h = this.bbox.maxY - this.bbox.minY || 1;
        const cw = this.canvas.width, ch = this.canvas.height;
        this.scale = Math.min(cw / w, ch / h) * 0.9;
        this.panX = cw / 2 - ((this.bbox.minX + this.bbox.maxX) / 2) * this.scale;
        this.panY = ch / 2 - ((this.bbox.minY + this.bbox.maxY) / 2) * this.scale;
        this.render();
    },

    zoom(factor) {
        // 버튼 클릭 등 기준점이 따로 없을 때는 캔버스 중앙을 기준으로 확대/축소한다.
        this.zoomAt(factor, this.canvas.width / 2, this.canvas.height / 2);
    },

    // (screenX, screenY) 아래의 월드 좌표가 확대/축소 후에도 화면상 같은 위치에
    // 남아있도록 panX/panY를 함께 재계산한다 — 마우스 휠 확대/축소가 커서 위치를
    // 기준으로 이루어지게 하기 위함.
    zoomAt(factor, screenX, screenY) {
        const [wx, wy] = this._toWorld(screenX, screenY);
        this.scale *= factor;
        this.panX = screenX - wx * this.scale;
        this.panY = this.canvas.height - wy * this.scale - screenY;
        this.render();
    },

    pan(dx, dy) {
        this.panX += dx;
        this.panY += dy;
        this.render();
    },

    _toScreen(x, y) {
        return [x * this.scale + this.panX, -(y * this.scale) + (this.canvas.height - this.panY)];
    },

    _toWorld(screenX, screenY) {
        return [(screenX - this.panX) / this.scale, (this.canvas.height - this.panY - screenY) / this.scale];
    },

    toggleBackground() {
        this.bgDark = !this.bgDark;
        this.render();
    },

    render() {
        const ctx = this.ctx;
        if (!ctx) return;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.fillStyle = this.bgDark ? '#1a1a1a' : '#ffffff';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        const defaultColor = this.bgDark ? '#dddddd' : '#222222';
        this.entities.forEach((e) => {
            if (e.layer && this.layerVisible[e.layer] === false) return;
            const color = this._resolveColor(e, defaultColor);
            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.lineWidth = 1;

            try { this._drawEntity(e, null, 1, 0, defaultColor, 0, color); } catch (err) { /* 지원하지 않는 엔티티 형태는 조용히 무시 */ }
        });

        this._drawMeasurements();
    },

    // inheritedColor: 이 엔티티를 담고 있는 INSERT(블록 배치) 자체가 이미
    // 계산해 둔 색 — 레이어 "0"에 그려진 하위 엔티티가 색을 못 정했을 때
    // 쓴다(아래 설명).
    _resolveColor(e, fallback, inheritedColor) {
        // colorIndex 0(ByBlock)/256(ByLayer)는 자기 색이 없다는 뜻이라 레이어 색으로 넘어간다.
        if (e.colorIndex && e.colorIndex !== 256) {
            // dxf-parser가 정식으로 파싱하는 엔티티는 ACI(colorIndex, 그룹코드 62)를
            // 이미 트루컬러(e.color)로 계산해서 채워준다. 그런데 우리가 직접 만드는
            // 보충 엔티티(HATCH 등, extractSupplementalEntitiesFromLines 쪽)는
            // colorIndex만 읽고 e.color는 안 채우므로 이 경로를 안 타면 항상
            // fallback(레이어색/기본색)으로만 그려졌다 — 실제로 파란/빨간 표지판
            // 채우기가 죄다 레이어색(초록)으로만 보이던 원인. ACI 1~9 기본 팔레트를
            // 직접 알고 있으니 e.color가 없을 때는 이걸로 대신 계산한다.
            const own = rgbIntToHex(e.color) || ACI_BASIC_PALETTE[e.colorIndex];
            if (own === 'bg') return fallback; // 7번은 배경에 따라 흰/검 — defaultColor가 이미 그 값
            if (own) return own;
        }
        // 레이어 "0"은 AutoCAD의 특수 규칙이 있다 — 블록을 "레이어 0"에 그려
        // 정의해두면, 그 블록을 실제로 배치(INSERT)할 때는 배치한 자리의
        // 레이어 색을 그대로 물려받는다(하나의 기호를 여러 레이어에 꽂아도
        // 항상 그 레이어 색으로 보이게 하기 위한 관례 — ByBlock). 실제 파일로
        // 확인함: 속도표지판(CMRS220) 안의 "50" 숫자와 원이 전부 레이어 "0"에
        // 있고 자기 색이 없는데, CM-RDSB 레이어(초록)에 배치돼 있어서 오토캐드
        // 에선 초록으로 뜬다 — 이 규칙을 안 넣으면 그냥 기본색(흰색)으로만
        // 그려져서 색이 달라 보였다.
        if (e.layer === '0' && inheritedColor) return inheritedColor;
        const layer = e.layer && this.layers[e.layer];
        const layerColor = layer ? rgbIntToHex(layer.color) : null;
        return layerColor || fallback;
    },

    // tf: 로컬(블록) 좌표 → 월드 좌표 변환 함수(없으면 항등). INSERT 내부 엔티티를 그릴 때 쓰인다.
    _pt(tf, x, y) {
        const [wx, wy] = tf ? tf(x, y) : [x, y];
        return this._toScreen(wx, wy);
    },

    // 블록(BLOCK) 정의를 INSERT의 위치/회전/축척으로 변환해서 그린다.
    // insertColor: 이 INSERT 엔티티 자체에 이미 적용된(호출부에서 계산해 둔) 색 —
    // 블록 내부에서 레이어 "0"에 그려진 자식 엔티티가 ByBlock 규칙으로 물려받을 색.
    _drawInsert(e, parentTf, parentRadiusScale, parentRot, defaultColor, depth, insertColor) {
        if (depth > 5) return; // 블록이 자기 자신을 참조하는 등의 이상 데이터 방지
        const block = this.blocks[e.name];
        if (!block || !block.entities || !block.entities.length) return;

        const angleRad = ((e.rotation || 0) * Math.PI) / 180;
        const cos = Math.cos(angleRad), sin = Math.sin(angleRad);
        const sx = e.xScale ?? 1, sy = e.yScale ?? 1;
        const bx = block.position ? block.position.x : 0;
        const by = block.position ? block.position.y : 0;
        const ex = e.position ? e.position.x : 0;
        const ey = e.position ? e.position.y : 0;

        const tf = (x, y) => {
            const dx = (x - bx) * sx;
            const dy = (y - by) * sy;
            const rx = dx * cos - dy * sin + ex;
            const ry = dx * sin + dy * cos + ey;
            return parentTf ? parentTf(rx, ry) : [rx, ry];
        };
        const radiusScale = parentRadiusScale * ((Math.abs(sx) + Math.abs(sy)) / 2);
        const rot = parentRot + angleRad;

        block.entities.forEach((be) => {
            if (be.layer && this.layerVisible[be.layer] === false) return;
            const color = this._resolveColor(be, defaultColor, insertColor);
            this.ctx.strokeStyle = color;
            this.ctx.fillStyle = color;
            try { this._drawEntity(be, tf, radiusScale, rot, defaultColor, depth + 1, color); } catch (err) { /* 무시 */ }
        });
    },

    _drawMeasurements() {
        const ctx = this.ctx;
        const measureColor = '#ff9500';
        ctx.font = 'bold 12px sans-serif';

        const drawPoint = ([sx, sy]) => {
            ctx.beginPath(); ctx.arc(sx, sy, 3, 0, Math.PI * 2);
            ctx.fillStyle = measureColor; ctx.fill();
        };

        // 완료된 측정들
        this.measurements.forEach((m) => {
            const pts = m.points.map(([x, y]) => this._toScreen(x, y));
            ctx.strokeStyle = measureColor;
            ctx.fillStyle = 'rgba(255,149,0,0.15)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            pts.forEach(([sx, sy], i) => { if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); });
            if (m.type === 'area') { ctx.closePath(); ctx.fill(); }
            ctx.stroke();
            pts.forEach(drawPoint);

            const [lx, ly] = pts[pts.length - 1];
            ctx.fillStyle = measureColor;
            const label = m.type === 'distance' ? `${m.value.toFixed(2)} m` : `${m.value.toFixed(2)} m²`;
            ctx.fillText(label, lx + 6, ly - 6);
        });

        // 진행 중인 측정
        if (this.measurePoints.length > 0) {
            const pts = this.measurePoints.map(([x, y]) => this._toScreen(x, y));
            ctx.strokeStyle = measureColor;
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            pts.forEach(([sx, sy], i) => { if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); });
            ctx.stroke();
            ctx.setLineDash([]);
            pts.forEach(drawPoint);
        }
    },

    addMeasurePoint(worldX, worldY) {
        if (!this.measureMode) return;
        this.measurePoints.push([worldX, worldY]);

        if (this.measureMode === 'distance' && this.measurePoints.length === 2) {
            const [[x1, y1], [x2, y2]] = this.measurePoints;
            const value = Math.hypot(x2 - x1, y2 - y1);
            this.measurements.push({ type: 'distance', points: [...this.measurePoints], value });
            this.measurePoints = [];
            updateMeasureResult(`거리: ${value.toFixed(2)} m`);
        }
        this.render();
    },

    finishAreaMeasurement() {
        if (this.measureMode !== 'area' || this.measurePoints.length < 3) return;
        let sum = 0;
        const pts = this.measurePoints;
        for (let i = 0; i < pts.length; i++) {
            const [x1, y1] = pts[i];
            const [x2, y2] = pts[(i + 1) % pts.length];
            sum += x1 * y2 - x2 * y1;
        }
        const value = Math.abs(sum) / 2;
        this.measurements.push({ type: 'area', points: [...pts], value });
        this.measurePoints = [];
        updateMeasureResult(`면적: ${value.toFixed(2)} m²`);
        this.render();
    },

    clearMeasurements() {
        this.measurements = [];
        this.measurePoints = [];
        updateMeasureResult('');
        this.render();
    },

    // tf/radiusScale/rot: INSERT(블록) 내부 엔티티를 부모 블록의 위치/축척/회전으로
    // 변환해서 그리기 위한 값들. 최상위 엔티티는 tf=null(항등변환), radiusScale=1, rot=0.
    // ownColor: 호출부가 이미 이 엔티티 e에 대해 계산해 ctx에 적용해 둔 색 —
    // e가 INSERT일 때 그 안의 레이어 "0" 자식들에게 물려줄 색으로 그대로 전달된다.
    _drawEntity(e, tf, radiusScale, rot, defaultColor, depth, ownColor) {
        const ctx = this.ctx;
        switch (e.type) {
            case 'LINE': {
                if (!e.vertices || e.vertices.length < 2) return;
                const [x1, y1] = this._pt(tf, e.vertices[0].x, e.vertices[0].y);
                const [x2, y2] = this._pt(tf, e.vertices[1].x, e.vertices[1].y);
                ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
                break;
            }
            case 'LWPOLYLINE':
            case 'POLYLINE': {
                if (!e.vertices || e.vertices.length === 0) return;
                ctx.beginPath();
                e.vertices.forEach((v, i) => {
                    const [x, y] = this._pt(tf, v.x, v.y);
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                });
                if (e.shape) ctx.closePath();
                ctx.stroke();
                break;
            }
            case 'SPLINE': {
                if (!e.controlPoints || e.controlPoints.length === 0) return;
                ctx.beginPath();
                e.controlPoints.forEach((v, i) => {
                    const [x, y] = this._pt(tf, v.x, v.y);
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                });
                ctx.stroke();
                break;
            }
            case 'CIRCLE': {
                const [cx, cy] = this._pt(tf, e.center.x, e.center.y);
                ctx.beginPath(); ctx.arc(cx, cy, e.radius * radiusScale * this.scale, 0, Math.PI * 2); ctx.stroke();
                break;
            }
            case 'ARC': {
                const [cx, cy] = this._pt(tf, e.center.x, e.center.y);
                const start = -(((e.startAngle || 0) * Math.PI / 180) + rot);
                const end = -(((e.endAngle || 0) * Math.PI / 180) + rot);
                ctx.beginPath(); ctx.arc(cx, cy, e.radius * radiusScale * this.scale, end, start, false); ctx.stroke();
                break;
            }
            case 'POINT': {
                const [x, y] = this._pt(tf, e.position.x, e.position.y);
                ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fill();
                break;
            }
            case 'SOLID': {
                // DXF SOLID의 점 순서는 1,2,4,3이라야 사각형이 올바르게 그려진다(3점만
                // 있는 삼각형이면 3번째·4번째 점이 같은 값이라 순서를 바꿔도 결과는 같다).
                if (!e.points || e.points.length < 3) return;
                const order = [0, 1, 3, 2].filter((i) => i < e.points.length);
                ctx.beginPath();
                order.forEach((i, idx) => {
                    const [x, y] = this._pt(tf, e.points[i].x, e.points[i].y);
                    if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                });
                ctx.closePath();
                ctx.fill();
                break;
            }
            case 'ELLIPSE': {
                if (!e.center || !e.majorAxisEndPoint) return;
                const [cx, cy] = this._pt(tf, e.center.x, e.center.y);
                const majorLen = Math.hypot(e.majorAxisEndPoint.x, e.majorAxisEndPoint.y);
                const rx = majorLen * radiusScale * this.scale;
                const ry = rx * (e.axisRatio != null ? e.axisRatio : 1);
                const axisAngle = Math.atan2(e.majorAxisEndPoint.y, e.majorAxisEndPoint.x);
                // ELLIPSE의 시작/끝각(그룹코드 41/42)은 ARC(도)와 달리 라디안 단위이고,
                // 장축 기준 로컬 각도다 — rotation이 장축 방향(+블록 회전)을 이미 반영하므로
                // start/end는 ARC와 동일하게 화면 Y축 반전만 적용해서 넘긴다.
                const rotation = -(axisAngle + rot);
                const start = -(e.startAngle != null ? e.startAngle : 0);
                const end = -(e.endAngle != null ? e.endAngle : Math.PI * 2);
                ctx.beginPath();
                ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), rotation, end, start, false);
                ctx.stroke();
                break;
            }
            case 'TEXT':
            case 'MTEXT': {
                // 그룹코드 72(수평 정렬)/73(수직 정렬)이 기본값(0=좌측/기준선)이
                // 아니면, 실제 기준점은 삽입점(10/20, startPoint)이 아니라 정렬점
                // (11/21, dxf-parser의 endPoint)이다 — DXF 표준 규칙. 이걸 무시하고
                // 늘 삽입점에서 캔버스 기본(좌측정렬)으로만 그리면, 가운데정렬로
                // 배치된 여러 줄짜리 표지판 글씨가 서로 다른 위치로 밀려 보인다
                // (실제 파일로 확인: "장성군"/"8 호선"이 halign=1(가운데)이고
                // endPoint가 startPoint와 다른데, 이걸 무시하니 표지판 글씨가
                // 오토캐드와 다르게 왼쪽으로 치우쳐 그려졌다).
                const aligned = !!(e.halign || e.valign) && e.endPoint;
                const p = aligned ? e.endPoint : (e.startPoint || e.position);
                if (!p) return;
                const [x, y] = this._pt(tf, p.x, p.y);
                // dxf-parser는 TEXT의 높이를 textHeight(그룹코드 40)에, MTEXT는 같은
                // 그룹코드 40을 height에 담는다 — 예전엔 e.height만 읽어서 TEXT
                // 엔티티(이 프로젝트 DXF의 대다수)는 전부 매번 기본값(2)으로만
                // 그려졌다(실제 높이는 0.0002~2 이상까지 제각각인데도).
                // 예전엔 최소 8px로 강제 고정해서, 축소된 화면에서 제목/일반 텍스트가
                // 실제 크기 차이와 무관하게 다 똑같이 작게 보이는 문제가 있었다.
                // 실제 DXF 텍스트 높이를 그대로 축척에 맞춰 그리되, 캔버스 폰트 크기가
                // 0/음수가 되는 것만 막는다(진짜 CAD처럼 축소하면 작아지는 게 맞는 동작).
                const height = e.textHeight ?? e.height ?? 2;
                const size = Math.max(0.5, height * radiusScale * this.scale);
                if (size >= 1) {
                    // 그룹코드 50(회전각, 도) — 지금까지는 아예 무시하고 항상 수평으로
                    // 그렸다. ARC/ELLIPSE와 같은 규칙으로 화면 Y축 반전 + 블록 누적
                    // 회전(rot)을 반영해서 부호를 맞춘다.
                    const angleRad = ((e.rotation || 0) * Math.PI) / 180;
                    ctx.save();
                    ctx.translate(x, y);
                    ctx.rotate(-(angleRad + rot));
                    ctx.font = `${size}px sans-serif`;
                    // halign 1=가운데, 2=우측(그 외 0/좌측이 기본) — canvas의
                    // textAlign이 그대로 대응돼서 계산 없이 바로 쓸 수 있다.
                    ctx.textAlign = e.halign === 2 ? 'right' : e.halign ? 'center' : 'left';
                    ctx.textBaseline = e.valign === 3 ? 'top' : e.valign === 2 ? 'middle' : e.valign === 1 ? 'bottom' : 'alphabetic';
                    decodeDxfText(formatSlopeAnnotationText(e.text, e.layer)).split('\n').forEach((line, i) => {
                        ctx.fillText(line, 0, i * size * 1.2);
                    });
                    ctx.restore();
                }
                break;
            }
            case 'INSERT': {
                this._drawInsert(e, tf, radiusScale, rot, defaultColor, depth, ownColor);
                break;
            }
            case 'HATCH': {
                // 실제 해치 무늬(사선 등)는 재현 안 하고, 경계를 반투명하게 채워서
                // "칠해진 영역이 있었다"는 것만 보여준다.
                if (!e.boundaryPaths || !e.boundaryPaths.length) return;
                ctx.save();
                ctx.globalAlpha = 0.35;
                // 경계가 2개 이상이면(예: 속도표지판의 링 모양 — 바깥원+안쪽원
                // 두 루프로 된 "도넛" 하나) 각 경계를 따로따로 beginPath+fill 하면
                // 안쪽 루프까지 그냥 다 칠해져서 도넛 가운데 뚫려야 할 구멍이
                // 안 뚫리고 원 전체가 꽉 찬 것처럼 보였다(실제 파일로 확인 —
                // CMRS220 표지판이 링이 아니라 꽉 찬 원으로 보이던 원인). 모든
                // 경계를 하나의 path에 subpath로 얹고 한 번만 채우되, evenodd
                // 규칙을 써야 경계 방향(시계/반시계)과 무관하게 항상 구멍이 뚫린다.
                ctx.beginPath();
                e.boundaryPaths.forEach((path) => {
                    path.forEach((p, i) => {
                        const [x, y] = this._pt(tf, p.x, p.y);
                        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                    });
                    ctx.closePath();
                });
                ctx.fill('evenodd');
                ctx.restore();
                break;
            }
            case 'LEADER_RAW': {
                if (!e.points || e.points.length < 2) return;
                ctx.beginPath();
                e.points.forEach((p, i) => {
                    const [x, y] = this._pt(tf, p.x, p.y);
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                });
                ctx.stroke();
                if (e.hasArrow) {
                    const [x0, y0] = this._pt(tf, e.points[0].x, e.points[0].y);
                    const [x1, y1] = this._pt(tf, e.points[1].x, e.points[1].y);
                    const ang = Math.atan2(y1 - y0, x1 - x0);
                    const sz = Math.max(4, 8 * radiusScale * this.scale);
                    ctx.beginPath();
                    ctx.moveTo(x0, y0);
                    ctx.lineTo(x0 + Math.cos(ang + 0.3) * sz, y0 + Math.sin(ang + 0.3) * sz);
                    ctx.lineTo(x0 + Math.cos(ang - 0.3) * sz, y0 + Math.sin(ang - 0.3) * sz);
                    ctx.closePath();
                    ctx.fill();
                }
                break;
            }
            case 'WIPEOUT_RAW': {
                // 배경색으로 덮어서 "가려짐" 효과만 흉내낸다(원본의 정확한 마스크
                // 모양까지는 재현하지 않고 직사각형 영역으로 근사).
                if (!e.corners) return;
                ctx.save();
                ctx.fillStyle = this.bgDark ? '#1a1a1a' : '#ffffff';
                ctx.beginPath();
                e.corners.forEach((p, i) => {
                    const [x, y] = this._pt(tf, p.x, p.y);
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                });
                ctx.closePath();
                ctx.fill();
                ctx.restore();
                break;
            }
            default:
                // DIMENSION 등 미지원 엔티티는 표시하지 않는다
                break;
        }
    },
};

function resizeDxfCanvas() {
    const canvas = document.getElementById('cad-canvas');
    const wrap = document.getElementById('cad-viewer-wrap');
    const oldW = canvas.width, oldH = canvas.height;
    const newW = wrap.clientWidth, newH = wrap.clientHeight;
    // 도면이 로드된 상태에서 캔버스 크기만 바꾸고 scale/pan을 그대로 두면(예전
    // 방식), 열었을 땐 창에 꽉 차 보이던 도면이 팝업 창을 최대화하거나 창
    // 크기를 조절할 때마다 캔버스만 커지고 도면은 이전 픽셀 크기 그대로 남아
    // "화면이 멀리서 축소된 것처럼" 보이는 문제가 있었다(실사용 중 확인됨).
    // 그래서 크기가 바뀌기 직전 화면 중심의 월드좌표를 기억해뒀다가, 크기가
    // 바뀐 뒤에도 그 좌표가 새 캔버스 중심에 오도록, 그리고 도면이 이전과 같은
    // 비율로 화면을 채우도록 scale/pan을 함께 비례 조정한다.
    if (dxfViewer.bbox && oldW > 0 && oldH > 0 && (newW !== oldW || newH !== oldH)) {
        const [cx, cy] = dxfViewer._toWorld(oldW / 2, oldH / 2);
        const k = Math.min(newW / oldW, newH / oldH);
        canvas.width = newW;
        canvas.height = newH;
        dxfViewer.scale *= k;
        dxfViewer.panX = newW / 2 - cx * dxfViewer.scale;
        dxfViewer.panY = newH / 2 - cy * dxfViewer.scale;
        dxfViewer.render();
    } else {
        canvas.width = newW;
        canvas.height = newH;
        if (dxfViewer.bbox) dxfViewer.render();
    }
}

function initDxfCanvas() {
    const canvas = document.getElementById('cad-canvas');
    dxfViewer.canvas = canvas;
    dxfViewer.ctx = canvas.getContext('2d');

    resizeDxfCanvas();
    window.addEventListener('resize', resizeDxfCanvas);

    let dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0;
    canvas.addEventListener('mousedown', (e) => {
        dragging = true;
        lastX = e.clientX; lastY = e.clientY;
        downX = e.clientX; downY = e.clientY;
    });
    window.addEventListener('mouseup', (e) => {
        if (dragging && dxfViewer.measureMode && Math.hypot(e.clientX - downX, e.clientY - downY) < 4) {
            const rect = canvas.getBoundingClientRect();
            const [wx, wy] = dxfViewer._toWorld(e.clientX - rect.left, e.clientY - rect.top);
            dxfViewer.addMeasurePoint(wx, wy);
        }
        dragging = false;
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        dxfViewer.pan(e.clientX - lastX, -(e.clientY - lastY));
        lastX = e.clientX; lastY = e.clientY;
    });
    canvas.addEventListener('dblclick', () => {
        if (dxfViewer.measureMode === 'area') dxfViewer.finishAreaMeasurement();
    });
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        dxfViewer.zoomAt(e.deltaY < 0 ? 1.1 : 0.9, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });
}

function updateMeasureResult(text) {
    document.getElementById('cad-measure-result').textContent = text;
}

function setMeasureMode(mode) {
    dxfViewer.measureMode = dxfViewer.measureMode === mode ? null : mode;
    dxfViewer.measurePoints = [];
    document.getElementById('cad-measure-dist-btn').classList.toggle('active', dxfViewer.measureMode === 'distance');
    document.getElementById('cad-measure-area-btn').classList.toggle('active', dxfViewer.measureMode === 'area');
    document.getElementById('cad-canvas').style.cursor = dxfViewer.measureMode ? 'crosshair' : 'grab';
    updateMeasureResult(dxfViewer.measureMode === 'area' ? '다각형 클릭 후 더블클릭으로 완료' : '');
    dxfViewer.render();
}

function saveDxfAsImage() {
    if (!dxfViewer.canvas) return;
    const link = document.createElement('a');
    link.download = (document.getElementById('cad-filename').textContent || 'drawing') + '.png';
    link.href = dxfViewer.canvas.toDataURL('image/png');
    link.click();
}

// 인쇄 결과가 도면 이미지 하나만 덜렁 있어 문서로서는 부실했다 — 현재 선택된
// 구간정보(currentRoute)를 표로 얹고 제목/출력일시/테두리를 갖춘 한 장짜리
// 문서 형태로 꾸며서 새 창을 연다. currentRoute가 없으면(팝업을 구간 정보 없이
// 직접 연 경우 등) 표는 그대로 두되 값은 "-"로 비워둔다.
// 화면에 보이던 뷰어 캔버스를 그대로 캡처하면, 뷰어 패널의 화면 비율(대체로
// 정사각형에 가까움)과 도면 자체의 비율(긴 도로 구간은 가로로 아주 긺)이 달라서
// 캡처된 이미지 안에 내용 없는 빈 배경이 위아래로 크게 남는다(실제 출력 결과가
// 그렇게 나왔음). 도면의 바운딩박스 비율에 맞춘 별도의 오프스크린 캔버스에
// 다시 그려서(여백도 fit()의 0.9배수보다 좁은 0.97로 줄여 최대한 꽉 채움) 그
// 캔버스를 캡처한다. dxfViewer.canvas/ctx/scale/pan은 그리는 동안만 바꿔치기하고
// 끝나면 원래 값으로 되돌려서, 인쇄 버튼을 눌러도 화면의 뷰어 자체는 그대로다.
function captureDxfPrintImage() {
    const bbox = dxfViewer.bbox;
    if (!bbox) return dxfViewer.canvas.toDataURL('image/png');

    const w = (bbox.maxX - bbox.minX) || 1;
    const h = (bbox.maxY - bbox.minY) || 1;
    const LONG_SIDE = 1900;
    const printCanvas = document.createElement('canvas');
    if (w >= h) {
        printCanvas.width = LONG_SIDE;
        printCanvas.height = Math.max(200, Math.round(LONG_SIDE * (h / w)));
    } else {
        printCanvas.height = LONG_SIDE;
        printCanvas.width = Math.max(200, Math.round(LONG_SIDE * (w / h)));
    }

    const savedCanvas = dxfViewer.canvas, savedCtx = dxfViewer.ctx;
    const savedScale = dxfViewer.scale, savedPanX = dxfViewer.panX, savedPanY = dxfViewer.panY;
    dxfViewer.canvas = printCanvas;
    dxfViewer.ctx = printCanvas.getContext('2d');
    const cw = printCanvas.width, ch = printCanvas.height;
    dxfViewer.scale = Math.min(cw / w, ch / h) * 0.97;
    dxfViewer.panX = cw / 2 - ((bbox.minX + bbox.maxX) / 2) * dxfViewer.scale;
    dxfViewer.panY = ch / 2 - ((bbox.minY + bbox.maxY) / 2) * dxfViewer.scale;
    dxfViewer.render();
    const dataUrl = printCanvas.toDataURL('image/png');

    dxfViewer.canvas = savedCanvas;
    dxfViewer.ctx = savedCtx;
    dxfViewer.scale = savedScale;
    dxfViewer.panX = savedPanX;
    dxfViewer.panY = savedPanY;
    return dataUrl;
}

function printDxfCanvas() {
    if (!dxfViewer.canvas) return;
    const dataUrl = captureDxfPrintImage();
    const filename = document.getElementById('cad-filename').textContent || '도면';
    const r = currentRoute || {};
    const roadRank = r.road_rank_name || r.road_grade || '-';
    const routeName = r.route_name || '-';
    const segment = r.sect ? `${r.sect}구간` : '-';
    const length = formatLengthM(r.length_m);
    const sPoint = r.s_point || '-';
    const ePoint = r.e_point || '-';
    const printedAt = new Date().toLocaleString('ko-KR', { dateStyle: 'long', timeStyle: 'short' });

    const win = window.open('', '_blank');
    win.document.write(`<!DOCTYPE html>
<html><head><title>${escapeHtml(filename)}</title>
<style>
  /* A4 가로 297×210mm에서 사방 14mm 여백을 빼면 실제 인쇄 가능 영역은
     269×182mm — body를 정확히 그 높이(182mm)의 세로 flex로 고정해두고
     헤더/표/푸터는 자기 내용만큼만(flex-shrink:0), 도면 액자는 flex:1로
     "남는 공간 전부"를 차지하게 한다. 이러면 도면 원본 캔버스가 아무리
     크고 비율이 이상해도 액자 안에서 항상 알아서 줄어들어(max-width/
     max-height:100%) 한 장 안에 들어간다 — 전에는 가로만 페이지에 맞추고
     세로는 안 맞춰서, 캔버스가 세로로 길면 그대로 다음 페이지로 넘쳐
     흘러 4장까지 나오는 문제가 있었다. */
  @page { size: A4 landscape; margin: 14mm; }
  * { box-sizing: border-box; }
  html, body { height: 182mm; overflow: hidden; }
  body {
    font-family: '맑은 고딕', 'Malgun Gothic', sans-serif; margin: 0; color: #222;
    display: flex; flex-direction: column;
  }
  .print-header {
    flex-shrink: 0; display: flex; align-items: flex-end; justify-content: space-between;
    border-bottom: 3px solid #2e6fae; padding-bottom: 6px; margin-bottom: 8px;
  }
  .print-title { font-size: 17px; font-weight: 800; color: #2e6fae; }
  .print-subtitle { font-size: 11px; color: #666; margin-top: 2px; }
  .print-meta { font-size: 10px; color: #888; text-align: right; }
  .print-info-table { flex-shrink: 0; width: 100%; border-collapse: collapse; margin-bottom: 8px; font-size: 11px; }
  .print-info-table td { border: 1px solid #ccc; padding: 3px 10px; }
  .print-info-table td.label { background: #eef3fa; font-weight: 700; width: 90px; color: #444; }
  .print-drawing-frame {
    flex: 1; min-height: 0; border: 1px solid #ccc; padding: 4px;
    display: flex; align-items: center; justify-content: center; overflow: hidden;
  }
  .print-drawing-frame img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
  .print-footer { flex-shrink: 0; margin-top: 6px; font-size: 9px; color: #999; text-align: right; }
</style></head>
<body>
  <div class="print-header">
    <div>
      <div class="print-title">도로대장 시스템 — 도면 출력</div>
      <div class="print-subtitle">${escapeHtml(filename)}</div>
    </div>
    <div class="print-meta">출력일시: ${escapeHtml(printedAt)}</div>
  </div>
  <table class="print-info-table">
    <tr><td class="label">도로종류</td><td>${escapeHtml(roadRank)}</td><td class="label">노선명</td><td>${escapeHtml(routeName)}</td></tr>
    <tr><td class="label">구간명</td><td>${escapeHtml(segment)}</td><td class="label">연장</td><td>${escapeHtml(length)}</td></tr>
    <tr><td class="label">시점</td><td>${escapeHtml(sPoint)}</td><td class="label">종점</td><td>${escapeHtml(ePoint)}</td></tr>
  </table>
  <div class="print-drawing-frame"><img src="${dataUrl}" onload="window.print()"></div>
  <div class="print-footer">도로대장 시스템(Road Ledger System)에서 출력됨</div>
</body></html>`);
    win.document.close();
}

// ---------- HATCH/LEADER/WIPEOUT/ATTRIB 보충 파서 ----------
// dxf-parser는 이 네 엔티티를 아예 읽지 않고 건너뛴다(라이브러리 자체 한계).
// 그래서 원본 DXF 텍스트를 직접 그룹코드 단위로 훑어서 필요한 좌표만 뽑아낸다.
function extractSectionText(text, sectionName) {
    const re = new RegExp(`0[ \\t]*\\r?\\n[ \\t]*SECTION[ \\t]*\\r?\\n[ \\t]*2[ \\t]*\\r?\\n[ \\t]*${sectionName}[ \\t]*\\r?\\n`);
    const m = re.exec(text);
    if (!m) return '';
    const start = m.index + m[0].length;
    const endIdx = text.indexOf('ENDSEC', start);
    return text.slice(start, endIdx === -1 ? text.length : endIdx);
}

// lines(그룹코드/값이 한 줄씩 번갈아 나오는 배열) 안에서 wanted에 있는 엔티티
// 타입만 뽑아 빌더 함수로 만든다. 코드가 '0'이 아닌 나머지는 무슨 엔티티든
// 그룹코드 쌍 단위(2줄씩)로만 건너뛰므로, 어디서 시작해도 다음 '0' 경계에서
// 항상 다시 정렬된다 — 잘라낸 조각(예: 블록 하나 분량)을 넘겨도 안전하다.
//
// INSERT를 지나칠 때마다 그 레이어를 currentInsertLayer로 기억해뒀다가 빌더에
// 같이 넘긴다 — ATTRIB은 거의 항상 레이어 "0"(ByBlock)인데, 이 값을 몰라서는
// "이 INSERT가 배치된 레이어" 색을 물려받을 수 없다(바로 아래 buildAttribEntity
// 참고, 실제로 표지판 숫자 색이 틀리던 원인).
function extractSupplementalEntitiesFromLines(lines, wanted) {
    const out = [];
    let i = 0;
    let currentInsertLayer = null;
    while (i + 1 < lines.length) {
        const code = lines[i].trim();
        const value = lines[i + 1].trim();
        if (code === '0' && value === 'INSERT') {
            let j = i + 2;
            while (j + 1 < lines.length && lines[j].trim() !== '0') {
                if (lines[j].trim() === '8') currentInsertLayer = lines[j + 1].trim();
                j += 2;
            }
            i = j;
            continue;
        }
        if (code === '0' && wanted[value]) {
            let j = i + 2;
            while (j + 1 < lines.length && lines[j].trim() !== '0') j += 2;
            const tags = [];
            for (let k = i + 2; k < j; k += 2) {
                tags.push([parseInt(lines[k].trim(), 10), (lines[k + 1] || '').trim()]);
            }
            try {
                const e = wanted[value](tags, currentInsertLayer);
                if (e) out.push(e);
            } catch (err) { /* 이 엔티티 하나만 건너뛰고 계속 진행 */ }
            i = j;
        } else {
            i += 2;
        }
    }
    return out;
}

const TOP_LEVEL_SUPPLEMENTAL_BUILDERS = {
    HATCH: buildHatchEntity, LEADER: buildLeaderEntity, WIPEOUT: buildWipeoutEntity, ATTRIB: buildAttribEntity,
};

function extractUnsupportedEntities(text) {
    const section = extractSectionText(text, 'ENTITIES');
    if (!section) return [];
    return extractSupplementalEntitiesFromLines(section.split(/\r\n|\r|\n/), TOP_LEVEL_SUPPLEMENTAL_BUILDERS);
}

const BLOCK_SUPPLEMENTAL_BUILDERS = { HATCH: buildHatchEntity, LEADER: buildLeaderEntity, WIPEOUT: buildWipeoutEntity };

// 표지판/아이콘 블록(예: 자전거 표지판의 원, 화살표 도형)에 채워진 도형이
// 실은 그 블록 정의 안에 든 HATCH인 경우가 실제 파일에서 확인됐다
// (CON080001.dxf 기준 블록 안에만 있는 HATCH가 60개 — 전부 빠지고 있었음).
// 블록 내부 좌표는 블록 기준(로컬)이라 INSERT마다 위치/회전/축척이 달라질
// 수 있으니 여기서 미리 절대좌표로 바꾸지 않는다 — 블록 이름별로만 모아서
// dxf.blocks[이름].entities에 얹어두면, 기존 INSERT 렌더링(_drawInsert)이
// 배치마다 알아서 올바른 변환을 적용해 그린다.
function extractBlockSupplementalEntities(text) {
    const section = extractSectionText(text, 'BLOCKS');
    if (!section) return {};
    const lines = section.split(/\r\n|\r|\n/);
    const result = {};
    let i = 0;
    while (i + 1 < lines.length) {
        if (lines[i].trim() === '0' && lines[i + 1].trim() === 'BLOCK') {
            // 블록 이름(그룹코드 2)은 BLOCK 헤더 안, 다음 '0'이 나오기 전에 있다.
            let name = null;
            let j = i + 2;
            while (j + 1 < lines.length && lines[j].trim() !== '0') {
                if (lines[j].trim() === '2' && name === null) name = lines[j + 1].trim();
                j += 2;
            }
            // j는 이제 블록의 첫 엔티티(또는 바로 ENDBLK) 직전 '0' 위치.
            let k = j;
            while (k + 1 < lines.length && !(lines[k].trim() === '0' && lines[k + 1].trim() === 'ENDBLK')) k += 2;
            if (name) {
                const entities = extractSupplementalEntitiesFromLines(lines.slice(j, k), BLOCK_SUPPLEMENTAL_BUILDERS);
                if (entities.length) result[name] = (result[name] || []).concat(entities);
            }
            i = k + 2; // ENDBLK 다음으로
        } else {
            i += 2;
        }
    }
    return result;
}

function buildHatchEntity(tags) {
    let layer = '0', colorIndex, color;
    const paths = [];
    let idx = 0;
    while (idx < tags.length) {
        const [code, value] = tags[idx];
        if (code === 8) { layer = value; idx++; continue; }
        if (code === 62) { colorIndex = parseInt(value, 10); idx++; continue; }
        if (code === 420) { color = parseInt(value, 10); idx++; continue; }
        if (code === 92) {
            const flag = parseInt(value, 10);
            idx++;
            const isPolyline = !!(flag & 2);
            const pts = [];
            if (isPolyline) {
                if (tags[idx] && tags[idx][0] === 72) idx++; // 불지(bulge) 존재 여부 — 직선 근사라 무시
                if (tags[idx] && tags[idx][0] === 73) idx++; // 닫힘 여부
                let vcount = 0;
                if (tags[idx] && tags[idx][0] === 93) { vcount = parseInt(tags[idx][1], 10); idx++; }
                for (let v = 0; v < vcount && idx < tags.length; v++) {
                    let x = null, y = null;
                    if (tags[idx] && tags[idx][0] === 10) { x = parseFloat(tags[idx][1]); idx++; }
                    if (tags[idx] && tags[idx][0] === 20) { y = parseFloat(tags[idx][1]); idx++; }
                    if (tags[idx] && tags[idx][0] === 42) idx++; // bulge 값 — 무시(직선 근사)
                    if (x != null && y != null) pts.push({ x, y });
                }
            } else {
                let ecount = 0;
                if (tags[idx] && tags[idx][0] === 93) { ecount = parseInt(tags[idx][1], 10); idx++; }
                for (let e = 0; e < ecount && idx < tags.length; e++) {
                    if (!tags[idx] || tags[idx][0] !== 72) break;
                    const edgeType = parseInt(tags[idx][1], 10); idx++;
                    if (edgeType === 1) { // 직선
                        let sx = null, sy = null, ex = null, ey = null;
                        if (tags[idx] && tags[idx][0] === 10) { sx = parseFloat(tags[idx][1]); idx++; }
                        if (tags[idx] && tags[idx][0] === 20) { sy = parseFloat(tags[idx][1]); idx++; }
                        if (tags[idx] && tags[idx][0] === 11) { ex = parseFloat(tags[idx][1]); idx++; }
                        if (tags[idx] && tags[idx][0] === 21) { ey = parseFloat(tags[idx][1]); idx++; }
                        if (pts.length === 0 && sx != null) pts.push({ x: sx, y: sy });
                        if (ex != null) pts.push({ x: ex, y: ey });
                    } else if (edgeType === 2) { // 원호
                        let cx = null, cy = null, r = null, a1 = 0, a2 = 360, ccw = 1;
                        if (tags[idx] && tags[idx][0] === 10) { cx = parseFloat(tags[idx][1]); idx++; }
                        if (tags[idx] && tags[idx][0] === 20) { cy = parseFloat(tags[idx][1]); idx++; }
                        if (tags[idx] && tags[idx][0] === 40) { r = parseFloat(tags[idx][1]); idx++; }
                        if (tags[idx] && tags[idx][0] === 50) { a1 = parseFloat(tags[idx][1]); idx++; }
                        if (tags[idx] && tags[idx][0] === 51) { a2 = parseFloat(tags[idx][1]); idx++; }
                        if (tags[idx] && tags[idx][0] === 73) { ccw = parseInt(tags[idx][1], 10); idx++; }
                        if (cx != null && r != null) {
                            let start = a1 * Math.PI / 180, end = a2 * Math.PI / 180;
                            if (!ccw && end > start) end -= Math.PI * 2;
                            const steps = 16;
                            for (let s = 0; s <= steps; s++) {
                                const a = start + (end - start) * (s / steps);
                                pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
                            }
                        }
                    } else {
                        // 타원호/스플라인 경계(3,4)는 복잡도가 높아 생략 — 이 edge만
                        // 건너뛰고 나머지로 대략적인 윤곽은 유지한다.
                        while (idx < tags.length && ![72, 97, 92, 75].includes(tags[idx][0])) idx++;
                    }
                }
            }
            if (pts.length >= 3) paths.push(pts);
            if (tags[idx] && tags[idx][0] === 97) {
                const n = parseInt(tags[idx][1], 10); idx++;
                for (let h = 0; h < n && tags[idx] && tags[idx][0] === 330; h++) idx++;
            }
            continue;
        }
        idx++;
    }
    if (paths.length === 0) return null;
    return { type: 'HATCH', layer, colorIndex, color, boundaryPaths: paths };
}

function buildLeaderEntity(tags) {
    let layer = '0', colorIndex, color, hasArrow = 1;
    const pts = [];
    let idx = 0;
    while (idx < tags.length) {
        const [code, value] = tags[idx];
        if (code === 8) layer = value;
        else if (code === 62) colorIndex = parseInt(value, 10);
        else if (code === 420) color = parseInt(value, 10);
        else if (code === 71) hasArrow = parseInt(value, 10);
        else if (code === 10) {
            const x = parseFloat(value);
            if (tags[idx + 1] && tags[idx + 1][0] === 20) {
                pts.push({ x, y: parseFloat(tags[idx + 1][1]) });
                idx++;
            }
        }
        idx++;
    }
    if (pts.length < 2) return null;
    return { type: 'LEADER_RAW', layer, colorIndex, color, points: pts, hasArrow };
}

function buildWipeoutEntity(tags) {
    let layer = '0';
    let ins = null, uvec = null, vvec = null;
    let idx = 0;
    while (idx < tags.length) {
        const [code, value] = tags[idx];
        if (code === 8) layer = value;
        else if (code === 10 && tags[idx + 1] && tags[idx + 1][0] === 20) {
            ins = { x: parseFloat(value), y: parseFloat(tags[idx + 1][1]) }; idx++;
        } else if (code === 11 && tags[idx + 1] && tags[idx + 1][0] === 21) {
            uvec = { x: parseFloat(value), y: parseFloat(tags[idx + 1][1]) }; idx++;
        } else if (code === 12 && tags[idx + 1] && tags[idx + 1][0] === 22) {
            vvec = { x: parseFloat(value), y: parseFloat(tags[idx + 1][1]) }; idx++;
        }
        idx++;
    }
    if (!ins || !uvec || !vvec) return null;
    const corners = [
        { x: ins.x, y: ins.y },
        { x: ins.x + uvec.x, y: ins.y + uvec.y },
        { x: ins.x + uvec.x + vvec.x, y: ins.y + uvec.y + vvec.y },
        { x: ins.x + vvec.x, y: ins.y + vvec.y },
    ];
    return { type: 'WIPEOUT_RAW', layer, corners };
}

// INSERT에 딸린 ATTRIB(속성값, 예: 접속점 표지판의 "0+500" 같은 실제 측점
// 텍스트)를 dxf-parser는 아예 파싱하지 않고 통째로 버린다(실제 파일 기준
// CON080001.dxf에 113개 — 전부 화면에서 빠지고 있었음). ATTRIB의 좌표(10/20)는
// INSERT의 블록좌표가 아니라 이미 그 INSERT 배치에 맞춰 계산된 절대(월드)
// 좌표라서(실측 확인: INSERT 위치와 ATTRIB 위치가 서로 다름), 블록 변환 없이
// 그냥 평범한 TEXT 엔티티로 만들면 된다.
//
// 단, 그룹코드 70(속성 플래그)의 최하위 비트는 "숨김(invisible)"이다 — 실제
// 파일로 확인함: 표지판마다 붙어있는 "최고속도제한 B"(태그 SIGNTXT, 설명용
// 내부 관리 텍스트) 같은 항목은 70=1(숨김)인데, 처음엔 이 플래그를 안 읽어서
// 화면에 다 그려버렸다(오토데스크 뷰어엔 당연히 안 보이는 것들). 반대로 실제로
// 보여야 하는 "0+500" 같은 측점 라벨(태그 STA)은 70=0(보임)이었다 — 그래서
// 70의 최하위 비트가 켜져 있으면 아예 만들지 않는다.
// insertLayer: 이 ATTRIB을 담고 있던 INSERT의 레이어(extractSupplementalEntitiesFromLines가
// 스캔하면서 미리 기억해 둔 값). ATTRIB 자신의 레이어(그룹코드 8)는 거의 항상
// "0"인데, DXF에서 레이어 "0"은 "이 블록을 배치한 자리의 레이어를 그대로
// 물려받는다(ByBlock)"는 특수 규칙이라 — 실제로 확인함: 속도표지판의 "50"
// 숫자가 레이어 "0"인데 CM-RDSB(초록) 레이어에 배치돼 있어서 초록으로 떠야
// 하는데, 이 값을 안 물려주면 그냥 흰색(레이어 0의 기본색)으로 그려졌다.
function buildAttribEntity(tags, insertLayer) {
    let layer = '0', x = null, y = null, height = 2, text = '', rotation = 0, flags = 0;
    tags.forEach(([code, value]) => {
        if (code === 8) layer = value;
        else if (code === 10) x = parseFloat(value);
        else if (code === 20) y = parseFloat(value);
        else if (code === 40) height = parseFloat(value);
        else if (code === 1) text = value;
        else if (code === 50) rotation = parseFloat(value);
        else if (code === 70) flags = parseInt(value, 10) || 0;
    });
    if (flags & 1) return null; // 숨김 속성 — 실제 뷰어에도 안 보여야 정상
    if (x == null || y == null || !text) return null;
    if (layer === '0' && insertLayer) layer = insertLayer;
    return { type: 'TEXT', layer, position: { x, y }, textHeight: height, text, rotation };
}

// DWG→DXF 변환(LibreDWG dwg2dxf)은 원본 DWG의 $DWGCODEPAGE(예: ANSI_949=한글
// CP949)를 그대로 유지한 채 텍스트를 그 코드페이지 "원본 바이트" 그대로 쓴다 —
// 진짜 AutoCAD가 저장하는 "순수 ASCII DXF + \U+XXXX 이스케이프" 관례를 안
// 따른다. 그런데 fetch().text()는 항상 UTF-8로 디코드하므로, 이런 파일을
// 그대로 읽으면 한글이 깨진다 — 실제 변환된 DXF로 확인함: 그룹코드 1(텍스트
// 값) 바이트를 UTF-8로 읽으면 깨지지만 CP949/EUC-KR로 읽으면 "동화로",
// "장성군", "8 호선", "과속방지턱" 등 정상 텍스트로 정확히 풀린다.
// $DWGCODEPAGE 헤더값은 실제 인코딩을 알려주는 유일한 단서긴 한데, 이 값
// 자체가 실제 내용과 안 맞는 파일이 있다는 게 실사용 중 두 번이나 확인됐다:
//   - CON080001.dxf: $DWGCODEPAGE=ANSI_949, 실제 텍스트도 진짜 EUC-KR → 헤더가 맞음
//   - TOP080001/TOP080002.dxf: $DWGCODEPAGE=ANSI_949인데, 실제 텍스트는 이미
//     UTF-8이다(직접 hex 확인 — EUC-KR로 읽으면 "595-2 답"이 "595-2 �떟"처럼
//     깨지고, UTF-8로 읽으면 정상). 이 두 파일은 서로 다른 변환 경로를 거쳐서
//     헤더값과 실제 바이트 인코딩이 어긋난 것으로 보인다.
// 헤더값 하나만으로는 이 둘을 구분할 수 없어서(둘 다 ANSI_949), 헤더보다
// 실제 바이트 내용을 먼저 확인한다: 파일 전체가 "엄격한 UTF-8"로 문제없이
// 디코딩되면 실제 내용은 UTF-8이라는 뜻이다 — 진짜 EUC-KR로 인코딩된 한글
// 바이트열이 우연히도 유효한 멀티바이트 UTF-8 시퀀스로 읽힐 확률은 UTF-8의
// 엄격한 바이트 패턴 때문에 사실상 0에 가깝다(CON080001.dxf로 검증함 — 엄격
// UTF-8 디코딩이 실패한다). 그래서 엄격 UTF-8 디코딩이 성공하면 그걸 쓰고,
// 실패할 때만 $DWGCODEPAGE 헤더값으로 폴백한다.
const DXF_CODEPAGE_TO_ENCODING = {
    ANSI_949: 'euc-kr', ANSI_1361: 'euc-kr', // 949=완성형 한글(CP949), 1361=조합형(Johab) — 둘 다 euc-kr로 근사
    ANSI_1252: 'windows-1252', ANSI_936: 'gbk', ANSI_950: 'big5', ANSI_932: 'shift-jis',
    UTF8: 'utf-8',
};

function isStrictUtf8(bytes) {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return true;
    } catch (err) {
        return false;
    }
}

function detectDxfEncoding(bytes) {
    if (isStrictUtf8(bytes)) return 'utf-8';
    // latin1은 바이트값을 그대로 코드포인트로 매핑해서(1바이트=1문자) 실제
    // 인코딩이 뭐든 ASCII 마커를 안전하게 찾을 수 있다.
    const headLen = Math.min(bytes.length, 8000);
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, headLen));
    const m = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*([A-Za-z0-9_]+)/.exec(head);
    if (!m) return 'utf-8';
    return DXF_CODEPAGE_TO_ENCODING[m[1].toUpperCase()] || 'utf-8';
}

// dxf-parser@1.1.2는 그룹코드 값을 읽을 때 전부 trim()해버린다(라이브러리 자체
// 동작 — 직접 소스 확인함). 그런데 일부 텍스트는 일부러 끝에 공백을 넣어
// 가운데정렬 중심점을 옮겨두는 방식으로 그 뒤에 붙는 다른 텍스트(예: ATTRIB
// 측점값)와 겹치지 않게 배치한다 — 실제 파일(000801100000P.dxf, MATCH_F 블록)
// 로 확인: 원문은 "MATCH LINE STA.     "(끝에 공백 5칸)인데 dxf-parser를
// 거치면 "MATCH LINE STA."로 공백이 사라져, 가운데정렬 중심점이 뒤로 밀리면서
// "0+000" 측점 텍스트와 겹쳐 보였다(사용자 스크린샷으로 확인된 버그). 이
// 함수는 원본 텍스트를 핸들(그룹코드 5, dxf-parser도 그대로 entity.handle에
// 넣어준다)로 다시 훑어서 trim되지 않은 원래 값을 따로 모아두고, 아래
// loadDxfFile에서 파싱 결과에 되돌려 붙인다.
function buildUntrimmedTextByHandle(text) {
    const lines = text.split(/\r\n|\r|\n/);
    const map = {};
    let i = 0;
    let curHandle = null;
    let curText;
    const flush = () => {
        if (curHandle != null && curText !== undefined) map[curHandle] = curText;
        curHandle = null;
        curText = undefined;
    };
    while (i + 1 < lines.length) {
        const code = lines[i].trim();
        const value = lines[i + 1];
        if (code === '0') {
            flush();
        } else if (code === '5') {
            curHandle = value.trim();
        } else if (code === '1') {
            curText = value.replace(/\r$/, '');
        }
        i += 2;
    }
    flush();
    return map;
}

function restoreUntrimmedText(dxf, untrimmedByHandle) {
    const patch = (e) => {
        if (e && e.handle && e.text !== undefined && untrimmedByHandle[e.handle] !== undefined) {
            e.text = untrimmedByHandle[e.handle];
        }
    };
    (dxf.entities || []).forEach(patch);
    Object.values(dxf.blocks || {}).forEach((b) => (b.entities || []).forEach(patch));
}

async function loadDxfFile(url, filename) {
    currentDxfFileUrl = url;
    currentDxfFileName = filename;
    document.getElementById('cad-empty-msg').style.display = 'none';
    document.getElementById('cad-filename').textContent = filename;

    // #cad-viewer-wrap은 index.html(사이드바 내장형)과 cad-popup.html(전체화면
    // 팝업) 둘 다 같은 id를 쓰므로, 이 클래스 하나로 두 화면 모두 로딩 중
    // 모래시계 커서가 적용된다(style.css의 .cad-loading 규칙 참고).
    const wrapEl = document.getElementById('cad-viewer-wrap');
    wrapEl.classList.add('cad-loading');
    try {
        const bytes = new Uint8Array(await fetch(url).then((r) => r.arrayBuffer()));
        const text = new TextDecoder(detectDxfEncoding(bytes)).decode(bytes);
        try {
            const dxf = new DxfParser().parseSync(text);
            try {
                restoreUntrimmedText(dxf, buildUntrimmedTextByHandle(text));
            } catch (err) { /* 실패해도 기본 도면은 그대로 보여준다(trim된 텍스트로라도 표시) */ }
            try {
                dxf.entities = (dxf.entities || []).concat(extractUnsupportedEntities(text));
            } catch (err) { /* 보충 파싱 실패해도 기본 도면은 그대로 보여준다 */ }
            try {
                const blockExtras = extractBlockSupplementalEntities(text);
                Object.keys(blockExtras).forEach((name) => {
                    if (dxf.blocks && dxf.blocks[name]) {
                        dxf.blocks[name].entities = (dxf.blocks[name].entities || []).concat(blockExtras[name]);
                    }
                });
            } catch (err) { /* 블록 보충 파싱 실패해도 기본 도면은 그대로 보여준다 */ }
            resizeDxfCanvas(); // 캔버스가 접힌 사이드바 안에서 초기화됐을 수 있어 크기를 다시 계산
            dxfViewer.load(dxf);
            renderDxfLayerList();
        } catch (err) {
            document.getElementById('cad-empty-msg').style.display = 'flex';
            document.getElementById('cad-empty-msg').innerHTML = `DXF 파싱 실패<br><span>${escapeHtml(err.message || '')}</span>`;
        }
    } finally {
        wrapEl.classList.remove('cad-loading');
    }
}

// 실제 업로드된 CAD 파일(server/uploads/routes 밑 DXF 108개)의 레이어명을
// 전부 뽑아 분석한 결과 182종이 나왔다 — 아래 두 그룹만 이 사전에 넣었다:
//
// (1) DXF_LAYER_OFFICIAL_HINTS: "영문자+숫자7자리" 형식(예: A0013110,
//     C0076117) 레이어코드 중, 아래 두 공식 문서 중 하나와 코드가 완전히
//     일치하는 것들. 추정이 아니라 확정값이다.
//       - govLayerMap.js의 GOV_LAYER_MAP 49종(국토부 「도로대장공간정보」
//         표준 정의서 v2.3, 이 앱이 이미 알고 있음) — 4종 일치
//         (C0076117=측구, C0223367=가로등, C0493376=신호등, D0023372=가로수)
//       - 국가법령정보센터(law.go.kr)에서 내려받은 국토지리정보원
//         "수치지도 지형지물 표준코드(안)" 원본 엑셀(680개 코드 전체 수록,
//         xlrd로 직접 파싱해 대조 — 육안 판독이 아니라 원본 셀 값을 그대로
//         가져온 것) — 75종 일치. 사용자가 국토정보 표준코드 범례 이미지를
//         제공해준 것을 계기로 원본 문서를 찾아 대조했다.
// (2) DXF_LAYER_KOREAN_HINTS: 이 CAD 레이어명(예: CL-LOTT, CA-ALGN-STSM)을
//     설명하는 공식 문서는 국토부 표준·이 프로젝트 어디에도 없다(직접
//     확인함 — 지적재조사 측량 CAD 도구의 벤더 내부 규칙으로 추정). 접두어
//     패턴(CL=지적선 Cadastral Line류, CA=중심선형 Alignment류, CC=횡단면
//     Cross-section류, CD=배수 Drainage류, CF=구조물 Facility류, CM=노면
//     표시/안전시설 Marking류, CR=도면 참고표기 Reference류, CS=철근
//     Steel-rebar류, CV=격자 grid, CX=도곽/기타 경계)를 근거로 추정해
//     붙인 것이라 확정된 해석이 아니다 — 참고용 힌트로만 표시한다.
//
// 나머지("영문자+숫자7자리" 형식 중 위 두 문서 어디에도 없는 것, 그리고
// AE134/AEC007/SB101/TITLE/TJ/KRB007 등 뚜렷한 패턴이 없는 것들)은 일부러
// 안 넣었다 — 근거 없이 추정하면 오히려 오해를 줄 수 있다고 판단했다.
const DXF_LAYER_OFFICIAL_HINTS = {
    // govLayerMap.js GOV_LAYER_MAP과 일치 (도로대장 v2.3)
    'C0076117': '측구',
    'C0223367': '가로등',
    'C0493376': '신호등',
    'D0023372': '가로수',
    // 국토지리정보원 수치지도 지형지물 표준코드(안)와 일치
    'A0013110': '도로(미분류)',
    'A0013112': '일반국도',
    'A0013116': '군도',
    'A0013117': '면리간도로',
    'A0013118': '부지안도로',
    'A0023119': '소로',
    'A0023210': '도로중심선(미분류)',
    'A0023212': '도로중심선(일반국도)',
    'A0023216': '도로중심선(군도)',
    'A0023217': '도로중심선(면리간도로)',
    'A0033327': '자전거도로',
    'A0043325': '횡단보도',
    'A0071211': '철교',
    'A0073340': '다리(미분류)',
    'A0143411': '버스정류장',
    'A0151111': '보통철도',
    'A0160024': '철도부지선',
    'B0014111': '주택외건물',
    'B0014112': '주택',
    'B0014113': '연립주택',
    'B0014116': '무벽건물',
    'B0014118': '가건물',
    'B0014311': '공장',
    'B0024120': '담장(미분류)',
    'B0024127': '문주',
    'C0052211': '콘크리트제방(상단)',
    'C0052212': '콘크리트제방(하단)',
    'C0062243': '보',
    'C0076116': '암거',
    'C0220205': '보조지지주',
    'C0226232': '방범등',
    'C0236241': '전화주',
    'C0236242': '전력주',
    'C0246344': '맨홀(전기)',
    'C0246347': '맨홀(통신선)',
    'C0413422': '안내표지',
    'C0413423': '지시표지',
    'C0413424': '규제표지',
    'C0413425': '주의표지',
    'C0423365': '주유소',
    'C0513369': '도로반사경',
    'D0015211': '논',
    'D0015212': '밭',
    'D0015213': '과수원',
    'D0025111': '지류계',
    'E0022112': '세류',
    'E0022115': '하천중심선',
    'E0032111': '실폭하천',
    'E0042326': '유수방향',
    'E0052114': '호수, 저수지',
    'F0017111': '주곡선(볼록지)',
    'F0017114': '계곡선(볼록지)',
    'F0017121': '주곡선(오목지)',
    'F0017131': '등고수치',
    'F0027132': '표고점수치',
    'F0027217': '표고점',
    'F0037221': '성토(상단)',
    'F0037222': '절토(상단)',
    'F0037223': '성토(하단)',
    'F0047224': '콘크리트옹벽(상단)',
    'F0047225': '콘크리트옹벽(하단)',
    'G0018117': '동계(행정경계)',
    'G0022313': '습지',
    'G0022323': '습지기호',
    'H0017334': '도곽',
    'H0027133': '삼각점수치',
    'H0027134': '수준점수치',
    'H0027135': '통합기준점수치',
    'H0027312': '수준점',
    'H0049114': '다리(지명주기)',
    'H0049131': '하천(지명주기)',
    'H0049140': '건물(지명주기, 미분류)',
    'H0049160': '시설물(지명주기, 미분류)',
    'H0049224': '면(지명주기)',
    'H0049226': '자연부락',
};
const DXF_LAYER_KOREAN_HINTS = {
    'CA-ALGN-CNTL': '선형 기준점',
    'CA-ALGN-HMS1': '선형 각도 표기 1',
    'CA-ALGN-HMS3': '선형 각도 표기 3',
    'CA-ALGN-STSM': '측점(스테이션)',
    'CA-ALGN-SUBL': '선형 보조선',
    'CA-ALGN-TEXT': '선형 문자',
    'CA-BORD-MEDN': '중앙분리대 경계',
    'CA-BORD-ROAD': '도로 경계',
    'CA-BORD-WALK': '보도 경계',
    'CA-MACL': '주 중심선',
    'CA-MISC-SYMB': '기타 기호',
    'CADISTM': '거리 표시',
    'CADISTS': '거리 표시(보조)',
    'CC-BEDF': '기초',
    'CC-CNTL': '횡단 기준점',
    'CC-CUTT': '절토',
    'CC-DIML': '치수선',
    'CC-DIMT': '치수 문자',
    'CC-FILL': '성토',
    'CC-GRND': '지반(지형)',
    'CC-GSTR': '지반 구조',
    'CC-GSTR-DICH': '지반 구조(배수로)',
    'CC-PAVE': '포장',
    'CC-STRU-MISC': '구조물 기타',
    'CC-TEXT': '횡단 문자',
    'CC-TEXT-HMS4': '횡단 문자(각도표기 4)',
    'CC-XXXX': '횡단 기타',
    'CD-BOXC-WATR': '박스형 수로',
    'CD-DRAN-PIPE': '배수관',
    'CD-SDLL-TYP0': '측구(배수로) 유형0-1',
    'CD-SDLU-TYP0': '측구(배수로) 유형0-2',
    'CF-BLDG-BUST': '건물',
    'CF-RTWL-CONC': '콘크리트 옹벽',
    'CF-RTWL-STON': '석축형 옹벽',
    'CL-ADMN-NAME': '행정구역 명칭',
    'CL-ADMN-TOWN': '행정구역(읍면동) 경계',
    'CL-BOND-ROAD': '도로 경계선',
    'CL-LOTL': '지번선',
    'CL-LOTT': '지번 텍스트',
    'CM-LEAD': '인출선',
    'CM-MISC': '기타',
    'CM-RDGS': '도로 기하',
    'CM-RDMK': '노면 표시',
    'CM-RDMK-LAND': '노면 표시(육상)',
    'CM-RDMK-WALK': '노면 표시(보도)',
    'CM-RDSB': '노면 표시 기호',
    'CM-RDSB-PATT-PAT1': '노면 표시 패턴 1',
    'CM-RDSB-PATT-PAT5': '노면 표시 패턴 5',
    'CM-SFTY-GFNC': '안전시설(가드펜스)',
    'CM-SFTY-GRAL': '안전시설(가드레일)',
    'CM-SFTY-GWAL': '안전시설(가드월)',
    'CM-SFTY-SLID': '안전시설(미끄럼방지)',
    'CM-SFTY-STON': '안전시설(석재 방호)',
    'CM-TRAN-SIGN': '교통 표지판',
    'CR-BRDG-NEWC': '신설 교량',
    'CR-GRID-VERT': '수직 격자',
    'CR-GRND': '지반(참고)',
    'CR-GSCL-LINE': '그래픽 축척 선',
    'CR-GSCL-MISC': '그래픽 축척 기타',
    'CR-GSCL-TEXT': '그래픽 축척 문자',
    'CR-MISC': '기타',
    'CR-TABL-LIN1': '표 선 1',
    'CR-TABL-TEX1': '표 문자 1',
    'CR-TABL-TEX2': '표 문자 2',
    'CR-TEXT': '참고 문자',
    'CR-TEXT-HMS6': '참고 문자(각도표기 6)',
    'CS-RBAR-SYMB': '철근 기호',
    'CV-GRID-LINE': '격자 선',
    'CV-GRID-TEXT': '격자 문자',
    'CX-BORD-LIN1': '테두리(도곽)선 1',
    'CX-BORD-LIN2': '테두리(도곽)선 2',
    'CX-BORD-TEX1': '테두리(도곽) 문자 1',
    'CX-BORD-TEX3': '테두리(도곽) 문자 3',
    'CX-MISC': '기타',
};

function renderDxfLayerList() {
    const listEl = document.getElementById('dxf-layer-list');
    const names = Object.keys(dxfViewer.layers);
    if (names.length === 0) {
        listEl.innerHTML = '<div class="tree-empty">레이어 정보가 없습니다.</div>';
        return;
    }
    listEl.innerHTML = '';
    names.forEach((name) => {
        const color = rgbIntToHex(dxfViewer.layers[name].color) || '#888';
        const row = document.createElement('label');
        row.className = 'dxf-layer-row';
        // 국토부 표준코드와 코드 자체가 일치하는 건 확정값이라 다른 문구로
        // 구분해서 보여준다(추정 힌트와 헷갈리지 않게).
        const officialHint = DXF_LAYER_OFFICIAL_HINTS[name];
        const estimatedHint = DXF_LAYER_KOREAN_HINTS[name];
        let hintHtml = '';
        if (officialHint) {
            hintHtml = `<span class="dxf-layer-hint dxf-layer-hint-official" title="국토부/국토지리정보원 공식 표준 레이어코드와 일치 확인됨">${escapeHtml(officialHint)}</span>`;
        } else if (estimatedHint) {
            hintHtml = `<span class="dxf-layer-hint" title="공식 자료가 없어 이름 패턴으로 추정한 해석입니다">${escapeHtml(estimatedHint)}</span>`;
        }
        // 체크박스는 항상 checked로 하드코딩돼 있었다 — _SLOPE처럼 로드 시점에
        // layerVisible이 false(동결 레이어)로 시작하는 레이어도 목록에서는 항상
        // "켜짐"으로 보여서, 실제로는 안 그려지는데 체크박스만 켜진 것처럼
        // 보이는 불일치가 있었다(실제 렌더링 자체는 render()의 layerVisible
        // 체크를 그대로 따라 맞게 숨겨졌지만, 화면상 체크박스 상태가 거짓말).
        const visible = dxfViewer.layerVisible[name] !== false;
        row.innerHTML = `
            <input type="checkbox" ${visible ? 'checked' : ''}>
            <span class="dxf-layer-swatch" style="background:${color};"></span>
            <span>${escapeHtml(decodeDxfText(name))}</span>${hintHtml}
        `;
        row.querySelector('input').addEventListener('change', (e) => {
            dxfViewer.layerVisible[name] = e.target.checked;
            dxfViewer.render();
        });
        listEl.appendChild(row);
    });
}

// 도로/도면종류/구조물/공사도면/동영상 탭 전환 — index.html/cad-popup.html 공용.
function initRouteFileTabs() {
    const drawingTypeTabs = document.getElementById('route-drawing-type-tabs');
    document.querySelectorAll('.route-tab-button').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.route-tab-button').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            currentRouteCategory = btn.dataset.cat;
            // "도면종류" 탭일 때만 평면도/용지도/매설물도/구조물도 하위탭을 보여준다.
            if (drawingTypeTabs) drawingTypeTabs.hidden = currentRouteCategory !== '도면종류';
            refreshRouteFilePanel();
        });
    });
    document.querySelectorAll('.route-drawing-type-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.route-drawing-type-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            currentDrawingType = btn.dataset.type;
            loadRouteFileList();
        });
    });
}

// CAD 툴바 버튼(줌/배경/측정/저장/인쇄/팝업)을 공통으로 연결한다. index.html과
// cad-popup.html 둘 다 같은 버튼 id를 쓰므로 이 함수 하나로 양쪽 다 초기화된다.
function initCadToolbarButtons() {
    document.getElementById('cad-zoom-in-btn').addEventListener('click', () => dxfViewer.zoom(1.25));
    document.getElementById('cad-zoom-out-btn').addEventListener('click', () => dxfViewer.zoom(0.8));
    document.getElementById('cad-fit-btn').addEventListener('click', () => dxfViewer.fit());
    document.getElementById('cad-bg-toggle-btn').addEventListener('click', (e) => {
        dxfViewer.toggleBackground();
        e.currentTarget.classList.toggle('active', dxfViewer.bgDark);
    });
    document.getElementById('cad-measure-dist-btn').addEventListener('click', () => setMeasureMode('distance'));
    document.getElementById('cad-measure-area-btn').addEventListener('click', () => setMeasureMode('area'));
    document.getElementById('cad-measure-clear-btn').addEventListener('click', () => dxfViewer.clearMeasurements());
    document.getElementById('cad-save-btn').addEventListener('click', saveDxfAsImage);
    document.getElementById('cad-print-btn').addEventListener('click', printDxfCanvas);
    const popupBtn = document.getElementById('cad-popup-btn');
    if (popupBtn) popupBtn.addEventListener('click', openCadPopup);
    const exportBtn = document.getElementById('route-export-btn');
    if (exportBtn) exportBtn.addEventListener('click', downloadSectionExport);
}

// 선택된 노선의 모든 자료(속성+지오메트리+사진+보고서+도면)를 일괄등록 때
// 받는 것과 같은 SHP/DBF 납품 폴더 구조의 zip으로 내려받는다.
// "사용자도로관리"의 GeoJSON 다운로드(downloadIssueGeoJson, script.js)와
// 같은 fetch→blob→<a download> 방식.
async function downloadSectionExport() {
    if (!currentRoute || !currentRoute.rdid) {
        alert('먼저 데이터보기 트리에서 노선을 선택하세요.');
        return;
    }
    // 이 버튼은 index.html/cad-popup.html에서 서로 다른 위치(패널)에 있어
    // 공통으로 잡을 컨테이너가 없으므로 body 전체에 모래시계 커서를 건다.
    document.body.classList.add('app-busy');
    try {
        const res = await fetch(`/api/sections/${currentRoute.rdid}/export`);
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            alert(data.error || '다운로드에 실패했습니다.');
            return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const cd = res.headers.get('Content-Disposition') || '';
        const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
        a.download = m ? decodeURIComponent(m[1]) : `${currentRoute.rdid}.zip`;
        a.click();
        URL.revokeObjectURL(url);
    } finally {
        document.body.classList.remove('app-busy');
    }
}
