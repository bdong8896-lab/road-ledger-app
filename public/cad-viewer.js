// 도면(CAD) 뷰어 공용 모듈 — index.html(좌측 사이드바 내장형)과 cad-popup.html(팝업
// 큰화면형) 둘 다 이 파일을 그대로 로드해서 쓴다. 그래서 여기 있는 함수들은
// document.getElementById 호출 시 "이 스크립트가 실행되는 문서" 기준으로 동작하므로,
// 팝업 창에서 로드되면 자연히 팝업 창 자신의 DOM을 찾게 된다 — 별도 분기 불필요.

// ---------- 공용 알림·확인창 (브라우저 기본 alert/confirm/prompt 대체) ----------
// 기본 알림창은 디자인이 시스템과 다르고 긴 목록이 잘 안 보이며 화면 전체를 멈춘다. 이 헬퍼는 같은 테마의 작은 알림(토스트)과 확인 창으로 바꾼다.
//   uiAlert(메시지)            — 짧으면 화면 아래 알림(자동으로 사라짐), 길거나 줄이 많으면 확인 버튼이 있는 창. Promise 반환.
//   await uiConfirm(메시지, { okText, cancelText, danger }) → true/false
//   await uiPrompt(메시지, { placeholder, type, okText })    → 입력한 글자 또는 취소하면 null
// index.html과 cad-popup.html 둘 다 이 파일을 쓰므로 여기에 둔다(스타일은 style.css의 .ui-*).
(function () {
    const KIND_ERROR = /실패|오류|에러|없습니다|못했|불가|잘못|권한|초과|거부|막혔|올바르지|필요합니다|이상|차단/;
    const KIND_OK = /완료|성공|되었습니다|됐습니다|했습니다|저장했|올렸|삭제했|복원했|되돌렸/;

    function toastWrap() {
        let w = document.getElementById('ui-toast-wrap');
        if (!w) {
            w = document.createElement('div');
            w.id = 'ui-toast-wrap';
            w.setAttribute('aria-live', 'polite');
            document.body.appendChild(w);
        }
        return w;
    }

    function uiToast(message, kind, ms) {
        return new Promise((resolve) => {
            const text = String(message == null ? '' : message);
            const k = kind || (KIND_ERROR.test(text) ? 'error' : KIND_OK.test(text) ? 'success' : 'info');
            const el = document.createElement('div');
            el.className = 'ui-toast ui-toast-' + k;
            el.setAttribute('role', k === 'error' ? 'alert' : 'status');
            const icon = k === 'error' ? 'fa-circle-exclamation' : k === 'success' ? 'fa-circle-check' : 'fa-circle-info';
            el.innerHTML = '<i class="fa-solid ' + icon + '"></i><span class="ui-toast-msg"></span><button type="button" class="ui-toast-close" aria-label="알림 닫기"><i class="fa-solid fa-xmark"></i></button>';
            el.querySelector('.ui-toast-msg').textContent = text;
            const wrap = toastWrap();
            wrap.appendChild(el);
            let done = false;
            const close = () => {
                if (done) return;
                done = true;
                el.classList.add('ui-toast-out');
                setTimeout(() => { el.remove(); resolve(); }, 180);
            };
            el.querySelector('.ui-toast-close').addEventListener('click', close);
            // 오류는 오래, 글이 길면 더 오래 보여 준다
            const dur = ms || Math.min(15000, (k === 'error' ? 6000 : 3500) + text.length * 40);
            setTimeout(close, dur);
            while (wrap.children.length > 4) wrap.firstChild.remove();
        });
    }

    let modalOpen = 0;
    function openModal({ message, buttons, input }) {
        return new Promise((resolve) => {
            const prevFocus = document.activeElement;
            const back = document.createElement('div');
            back.className = 'ui-modal-backdrop';
            const box = document.createElement('div');
            box.className = 'ui-modal';
            box.setAttribute('role', 'dialog');
            box.setAttribute('aria-modal', 'true');
            const msg = document.createElement('div');
            msg.className = 'ui-modal-msg';
            msg.textContent = String(message == null ? '' : message);
            box.appendChild(msg);
            let inp = null;
            if (input) {
                inp = document.createElement('input');
                inp.className = 'ui-modal-input';
                inp.type = input.type || 'text';
                inp.placeholder = input.placeholder || '';
                inp.autocomplete = 'off';
                box.appendChild(inp);
            }
            const bar = document.createElement('div');
            bar.className = 'ui-modal-buttons';
            box.appendChild(bar);
            back.appendChild(box);
            document.body.appendChild(back);
            modalOpen++;
            const finish = (value) => {
                back.remove();
                modalOpen--;
                document.removeEventListener('keydown', onKey, true);
                if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) { /* 무시 */ } }
                resolve(value);
            };
            const btnEls = buttons.map((b) => {
                const el = document.createElement('button');
                el.type = 'button';
                el.className = 'ui-modal-btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
                el.textContent = b.text;
                el.addEventListener('click', () => finish(b.value(inp)));
                bar.appendChild(el);
                return el;
            });
            const primary = btnEls[buttons.findIndex((b) => b.primary)] || btnEls[btnEls.length - 1];
            const cancelBtn = buttons.find((b) => b.cancel);
            function onKey(e) {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(cancelBtn ? cancelBtn.value(inp) : buttons[0].value(inp)); }
                else if (e.key === 'Enter' && !(e.target && e.target.tagName === 'BUTTON')) { e.preventDefault(); e.stopPropagation(); primary.click(); }
                else if (e.key === 'Tab') { // 창 밖으로 포커스가 나가지 않게
                    const f = [...box.querySelectorAll('input,button')];
                    if (!f.length) return;
                    const first = f[0], last = f[f.length - 1];
                    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
                }
            }
            document.addEventListener('keydown', onKey, true);
            back.addEventListener('mousedown', (e) => { if (e.target === back && cancelBtn) finish(cancelBtn.value(inp)); });
            (inp || primary).focus();
        });
    }

    function uiAlert(message) {
        const text = String(message == null ? '' : message);
        const lines = text.split('\n').length;
        if (text.length > 180 || lines > 5) {
            return openModal({ message: text, buttons: [{ text: '확인', primary: true, value: () => undefined }] });
        }
        return uiToast(text);
    }
    function uiConfirm(message, opts) {
        const o = opts || {};
        const text = String(message == null ? '' : message);
        // 삭제·완전 삭제를 묻는 창은 따로 지정하지 않아도 빨간 버튼(확인 → 삭제)으로 보여 실수로 누르지 않게 한다
        const danger = o.danger !== undefined ? o.danger : /삭제|지웁니다/.test(text);
        const okText = o.okText || (/삭제하시겠습니까|지웁니다/.test(text) ? '삭제' : '확인');
        return openModal({
            message: text,
            buttons: [
                { text: o.cancelText || '취소', cancel: true, value: () => false },
                { text: okText, primary: true, danger, value: () => true },
            ],
        });
    }
    function uiPrompt(message, opts) {
        const o = opts || {};
        return openModal({
            message,
            input: { type: o.type || (/비밀번호/.test(String(message)) ? 'password' : 'text'), placeholder: o.placeholder },
            buttons: [
                { text: '취소', cancel: true, value: () => null },
                { text: o.okText || '확인', primary: true, value: (inp) => (inp ? inp.value : '') },
            ],
        });
    }
    window.uiToast = uiToast; window.uiAlert = uiAlert; window.uiConfirm = uiConfirm; window.uiPrompt = uiPrompt;
    window.uiModalOpen = () => modalOpen > 0;
})();

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
        if (!res.ok) { uiAlert('다운로드에 실패했습니다.'); return; }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(objectUrl);
    } catch (e) {
        uiAlert('다운로드에 실패했습니다.');
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
        if (!await uiConfirm(`"${f.original_name}" 파일을 삭제하시겠습니까?`)) return;
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
        if (!await uiConfirm(`"${f.original_name}" 파일을 삭제하시겠습니까?`)) return;
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
                if (!await uiConfirm(`"${f.original_name}" 파일을 삭제하시겠습니까?`)) return;
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

function requireEditModeForUpload() {
    if (document.body.classList.contains('admin-mode')) return true;
    uiAlert('편집 모드에서만 파일을 올릴 수 있습니다.');
    return false;
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
    return res.json(); // { file } 또는, 같은 이름이 이미 있으면 { duplicate: { name, pendingToken, existingUploadedAt } }
}

// 500m 단위 구간 도면처럼 한 노선에 파일이 수십 개씩(P/Y 합쳐 50개 이상) 딸린
// 경우를 감안해 다중 선택을 지원한다(#route-upload-file에 multiple 속성).
// 순서대로 하나씩 올린다 — 동시에 수십 개를 병렬로 쏘면 서버 메모리(multer가
// 메모리 버퍼링 방식이라)에 부담이 크다.
// "파일 선택" 버튼 옆에 고른 파일 이름(여러 개면 개수)을 보여준다 — 기본 파일 입력 대신.
function updateRouteUploadName() {
    const input = document.getElementById('route-upload-file');
    const nameEl = document.getElementById('route-upload-name');
    if (!input || !nameEl) return;
    const files = [...input.files];
    nameEl.textContent = !files.length ? '선택된 파일 없음'
        : files.length === 1 ? files[0].name : `${files[0].name} 외 ${files.length - 1}개`;
    nameEl.title = files.map((f) => f.name).join('\n');
    nameEl.classList.toggle('has-file', files.length > 0);
}

// 도면 탭(도로/도면)에서는 노선을 고르지 않아도 파일명으로 노선·구간을 알아내 붙인다.
// 서버가 인식 못 한 파일은, 노선을 골라 둔 경우 예전처럼 그 노선에 붙이고 아니면 목록으로 알려준다.
async function uploadRouteFilesAuto(files) {
    const formData = new FormData();
    // 힌트(선택한 노선)는 파일보다 먼저 append — uploadOneRouteFile과 같은 이유.
    if (currentRoute) {
        formData.append('road_grade', currentRoute.road_rank_name || currentRoute.road_grade || '');
        formData.append('route_no', currentRoute.route_no || '');
    }
    files.forEach((f) => formData.append('files', f));
    const res = await fetch('/api/routes/files/auto', { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '자동 인식 업로드 실패');
    return data;
}

function sameRouteTarget(m) {
    if (!currentRoute) return false;
    const grade = currentRoute.road_rank_name || currentRoute.road_grade || '';
    return m.roadGrade === grade && Number(m.routeNo) === Number(currentRoute.route_no) &&
        (!currentRoute.sect || m.sect === currentRoute.sect);
}

async function uploadRouteFile() {
    if (!requireEditModeForUpload()) return;
    const isDrawingTab = currentRouteCategory === '도로' || currentRouteCategory === '도면종류';
    if (!currentRoute && !isDrawingTab) { uiAlert('먼저 데이터보기 트리에서 노선을 선택하세요.'); return; }
    const fileInput = document.getElementById('route-upload-file');
    if (!fileInput || !fileInput.files.length) return;

    const files = [...fileInput.files];
    document.body.classList.add('app-busy');
    const statusEl = document.getElementById('route-upload-status');
    let lastUploaded = null;
    const errors = [];
    let autoMatched = [];
    let toUploadOneByOne = files;
    let autoUnmatched = [];
    const dupNames = [];   // 같은 이름이 이미 있어 따로 빼 둔 파일
    const dupTokens = [];
    try {
        if (isDrawingTab) {
            if (statusEl) statusEl.textContent = `노선·구간 자동 인식 중... (${files.length}개)`;
            try {
                const result = await uploadRouteFilesAuto(files);
                autoMatched = result.matched || [];
                (result.duplicates || []).forEach((d) => dupNames.push(d.name));
                if (result.pendingToken) dupTokens.push(result.pendingToken);
                const unmatchedNames = new Set((result.unmatched || []).map((u) => u.name));
                // 노선을 골라 둔 경우 인식 못 한 낱개 파일은 예전처럼 그 노선에 붙인다.
                // (ZIP 안의 파일은 원본 File과 이름이 대응하지 않아 낱개 폴백 대상이 아니다.)
                toUploadOneByOne = currentRoute ? files.filter((f) => unmatchedNames.has(f.name)) : [];
                autoUnmatched = currentRoute
                    ? (result.unmatched || []).filter((u) => !files.some((f) => f.name === u.name))
                    : (result.unmatched || []);
            } catch (e) {
                errors.push(e.message);
                toUploadOneByOne = currentRoute ? files : [];
            }
        }
        for (let i = 0; i < toUploadOneByOne.length; i++) {
            if (statusEl) statusEl.textContent = `업로드 중... (${i + 1}/${toUploadOneByOne.length}) ${toUploadOneByOne[i].name}`;
            try {
                const r = await uploadOneRouteFile(toUploadOneByOne[i]);
                if (r.duplicate) { dupNames.push(r.duplicate.name); dupTokens.push(r.duplicate.pendingToken); } else lastUploaded = r.file;
            } catch (e) {
                errors.push(e.message);
            }
        }
    } finally {
        document.body.classList.remove('app-busy');
        if (statusEl) statusEl.textContent = '';
    }

    fileInput.value = '';
    updateRouteUploadName();
    await loadRouteFileList();
    // 자동 인식 결과 요약 — 선택한 노선 밖으로 간 파일이 있거나 못 붙인 파일이 있을 때만 알린다.
    const elsewhere = autoMatched.filter((m) => !sameRouteTarget(m));
    if (elsewhere.length || autoUnmatched.length) {
        const groups = new Map();
        elsewhere.forEach((m) => {
            const key = `${m.roadGrade} ${m.routeNo} ${m.routeName} ${m.sect}구간`;
            groups.set(key, (groups.get(key) || 0) + 1);
        });
        const lines = [];
        if (elsewhere.length) {
            lines.push(`파일명으로 노선·구간을 인식해 ${elsewhere.length}개를 분류했습니다:`);
            groups.forEach((n, key) => lines.push(`  · ${key}: ${n}개`));
        }
        if (autoUnmatched.length) {
            if (lines.length) lines.push('');
            lines.push(`올리지 못한 파일 ${autoUnmatched.length}개:`);
            autoUnmatched.slice(0, 10).forEach((u) => lines.push(`  · ${u.name} — ${u.reason}`));
            if (autoUnmatched.length > 10) lines.push(`  … 외 ${autoUnmatched.length - 10}개`);
        }
        uiAlert(lines.join('\n'));
    }
    if (errors.length) uiAlert(`${errors.length}건 실패:\n${errors.slice(0, 10).join('\n')}`);
    if (dupTokens.length) await resolveDuplicateRouteUploads(dupTokens, dupNames);
    if (!errors.length && !autoUnmatched.length && autoMatched.length + toUploadOneByOne.length === 1) {
        const single = autoMatched.length === 1 ? (sameRouteTarget(autoMatched[0]) ? autoMatched[0].file : null) : lastUploaded;
        if (single) openRouteFileInViewer(single);
    }
}

// 같은 구간에 같은 이름의 파일이 이미 있어 따로 빼 둔 새 파일을 어떻게 할지 묻는다.
// 기존 파일은 이 질문에 답하기 전까지 그대로이고, 교체해도 기존 파일은 보관함으로 옮겨져 [일괄등록 이력]의 "이 등록 취소"로 되돌릴 수 있다.
async function resolveDuplicateRouteUploads(tokens, names) {
    const list = names.slice(0, 10).map((n) => `  · ${n}`).join('\n') + (names.length > 10 ? `\n  … 외 ${names.length - 10}개` : '');
    const replace = await uiConfirm(
        `같은 이름의 도면이 이미 올라와 있어 따로 빼 두었습니다 (${names.length}개):\n${list}\n\n` +
        '[확인] 새 파일로 교체합니다. 기존 파일은 보관되어 [일괄등록 이력]에서 "이 등록 취소"로 되돌릴 수 있습니다.\n' +
        '[취소] 교체하지 않습니다. 기존 파일은 그대로 두고 새로 올린 파일은 버립니다.'
    );
    try {
        const res = await fetch('/api/routes/files/pending/resolve', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tokens, action: replace ? 'replace' : 'discard' }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '처리하지 못했습니다.');
        if (replace) { await loadRouteFileList(); uiAlert(`${data.replaced || 0}개를 교체했습니다.`); }
    } catch (e) {
        uiAlert(e.message || '처리하지 못했습니다.');
    }
}

function openRouteFileInViewer(file) {
    const ext = (file.original_name.split('.').pop() || '').toLowerCase();
    if (ext === 'dxf') {
        loadDxfFile(`/api/routes/files/${file.id}?inline=1`, file.original_name, file);
    } else if (ext === 'dwg') {
        if (file.has_preview) {
            loadDxfFile(`/api/routes/files/${file.id}?inline=1&variant=dxf`, file.original_name, file);
        } else {
            uiAlert('이 DWG 파일은 미리보기를 사용할 수 없습니다.\n(서버에 DWG 변환 도구가 설정되지 않았거나 변환에 실패했습니다)\n다운로드 버튼으로 원본 파일은 받을 수 있습니다.');
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
                .map((f) => `<div class="rff-row" data-id="${f.id}" data-name="${escapeHtml(f.original_name)}" data-table="${escapeHtml(f.facility_table || '')}" data-facility-rdid="${escapeHtml(f.facility_rdid || '')}"><span>${escapeHtml(f.file_kind)}</span><span>${escapeHtml(f.original_name)}</span><button type="button" class="rs-file-del-btn rff-del" title="${escapeHtml(f.original_name)} 삭제"><i class="fa-solid fa-trash"></i></button></div>`)
                .join('');
            bodyEl.querySelectorAll('.rff-row').forEach((row) => {
                row.addEventListener('click', () => openFacilityFileRowClick(row));
                row.querySelector('.rff-del').addEventListener('click', async (ev) => {
                    ev.stopPropagation();
                    if (typeof deleteFacilityFile !== 'function') return;
                    const { id, name, table, facilityRdid } = row.dataset;
                    if (await deleteFacilityFile(id, name, table, facilityRdid)) openFacilityFileList(label);
                });
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
                facilityInfo = { label: data.record.label, name: data.record.name, attributes: data.record.attributes, table: data.record.table, rdid: data.record.rdid };
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
        uiAlert('팝업이 차단되었습니다. 브라우저의 팝업 차단을 해제해주세요.');
    }
}

// ---------- DXF 캔버스 뷰어 ----------
// dxf-parser(순수 파싱)만 CDN에서 가져오고, 렌더링은 Canvas2D로 직접 구현했다.
// 지원: LINE/LWPOLYLINE/POLYLINE/CIRCLE/ARC/POINT/TEXT/MTEXT/SPLINE(직선 근사)/INSERT(블록)
// 미지원(생략): HATCH, DIMENSION 등 — 도면이 일부만 표시될 수 있음
// dxf-parser가 ACI 256색 팔레트/트루컬러(24bit RGB)를 이미 다 계산해서
// entity.color/layer.color에 정수(0xRRGGBB)로 넣어준다 — 그걸 그대로 쓴다.
// LWPOLYLINE/POLYLINE 정점의 그룹코드 42(bulge, "불지")는 그 정점에서 다음
// 정점까지를 직선이 아니라 원호로 그리라는 뜻이다 — 예전엔 이 값을 무시하고
// 항상 직선으로만 이어서, 도로 곡선부·연석 모서리 등 실제로는 부드러운 곡선인
// 부분이 원본보다 각지게 보였다(실제 파일 확인: LWPOLYLINE 정점의 76%가 0이
// 아닌 bulge를 가짐 — 예를 들어 0.41421356...=tan(22.5˚)는 90˚ 호를 뜻하고,
// 이런 값이 흔함. 도로 곡선 구간이 전부 이렇게 그려지고 있었다는 뜻).
//
// bulge = tan(사잇각/4)라는 DXF 표준 정의와, 반각공식으로 유도되는 항등식
// "sagitta(현의 중점에서 호까지의 수직거리) = bulge × (현의 길이)/2"(근사가
// 아니라 정확한 식)를 이용해 호 위의 세 번째 점(현의 중점에서 수직으로
// sagitta만큼 떨어진 점)을 구한 뒤, 세 점(양 끝점 + 이 중간점)의 외접원을
// 계산한다 — 호의 방향(시계/반시계)을 부호로 손수 따지다 실수하기 쉬운
// 방식 대신, 실제로 그 세 점을 지나는 원이라는 사실만으로 항상 올바른
// 결과가 나오게 만든 것(따로 방향 부호 처리를 할 필요가 없다).
function circumcircle(ax, ay, bx, by, cx, cy) {
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-9) return null; // 세 점이 거의 일직선 — 원을 못 만듦
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    return { cx: ux, cy: uy, r: Math.hypot(ax - ux, ay - uy) };
}

function bulgeArc(x1, y1, x2, y2, bulge) {
    if (!bulge) return null;
    const dx = x2 - x1, dy = y2 - y1;
    const chord = Math.hypot(dx, dy);
    if (chord < 1e-9) return null;
    const sagitta = (bulge * chord) / 2;
    const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
    const nx = -dy / chord, ny = dx / chord; // 진행방향(P1→P2) 기준 왼쪽 단위법선
    const mx = midX + nx * sagitta, my = midY + ny * sagitta; // 호 위의 중간점
    const circ = circumcircle(x1, y1, mx, my, x2, y2);
    if (!circ) return null;
    return {
        cx: circ.cx, cy: circ.cy, r: circ.r,
        a1: Math.atan2(y1 - circ.cy, x1 - circ.cx),
        a2: Math.atan2(y2 - circ.cy, x2 - circ.cx),
        aMid: Math.atan2(my - circ.cy, mx - circ.cx),
    };
}

function angleNorm01(a) { const t = a % (Math.PI * 2); return t < 0 ? t + Math.PI * 2 : t; }

// a1에서 반시계 방향으로 돌 때 aMid를 먼저 지나 a2에 닿는지(=반시계가 실제
// 호의 방향인지) 판단한다. bulgeArc()가 만든 세 각(a1/a2/aMid)에만 쓴다.
function bulgeSweepCCW(a1, a2, aMid) {
    const span = angleNorm01(a2 - a1);
    const midOff = angleNorm01(aMid - a1);
    return midOff <= span;
}

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
    // 오토캐드 TEXT/MTEXT 옛날 방식 특수문자 코드(%%x) — MTEXT의 \Cn; 같은
    // 서식코드와 별개로, TEXT는 이 %% 방식만 쓴다(실제 파일 확인: "%%%" 336개,
    // 전부 경사율 옆에 붙어 있음 — 그대로 두면 "-2.0%%%"처럼 %가 세 개로
    // 보이는데, 오토캐드에서 %%%는 "%% 다음에 오는 문자를 그대로 보여줘라"가
    // 아니라 "%%" 자체가 리터럴 %문자 하나를 뜻하는 예약 코드라 실제로는
    // "-2.0%" 한 글자만 보여야 한다). 각도(%%d)/플러스마이너스(%%p)/지름(%%c)도
    // 오토캐드 표준 코드라 같이 처리해둔다(이 프로젝트 파일엔 아직 없지만
    // 나중에 올라올 도면에 쓰일 수 있음). 밑줄(%%u)/윗줄(%%o) 토글은 캔버스
    // fillText로는 부분 밑줄을 표현할 수 없어 마커만 지운다(밑줄 자체는 생략).
    s = s.replace(/%%[dD]/g, '°');
    s = s.replace(/%%[pP]/g, '±');
    s = s.replace(/%%[cC]/g, '⌀');
    s = s.replace(/%%[uUoO]/g, '');
    s = s.replace(/%%%/g, '%');
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

const NO_DASH = [];

// 레이어 테이블에서 레이어별 선 종류(그룹코드 6)를 뽑는다 — dxf-parser는 이 값을 읽지 않는다.
// 레이어에 점선이 지정돼 있고 엔티티는 ByLayer인 경우가 대부분이라(중심선 CC-CNTL 등) 이게 없으면 전부 실선이 된다.
function extractLayerLineTypes(text) {
    const section = extractSectionText(text, 'TABLES');
    const out = {};
    if (!section) return out;
    const lines = section.split(/\r\n|\r|\n/);
    let inLayer = false; let name = null; let lt = null;
    const flush = () => { if (inLayer && name && lt) out[name] = lt; name = null; lt = null; };
    for (let i = 0; i + 1 < lines.length; i += 2) {
        const code = lines[i].trim(); const value = lines[i + 1].trim();
        if (code === '0') { flush(); inLayer = value === 'LAYER'; continue; }
        if (!inLayer) continue;
        if (code === '2' && name === null) name = value;
        else if (code === '6') lt = value;
    }
    flush();
    return out;
}

const dxfViewer = {
    canvas: null, ctx: null,
    entities: [], layers: {}, layerVisible: {}, blocks: {},
    lineTypes: {}, layerLineType: {}, ltScale: 1, _insertLt: null, // 선 종류 정의(LTYPE), 레이어별 선 종류, 전체 선 종류 축척
    bbox: null,
    scale: 1, panX: 0, panY: 0,
    bgDark: true,
    measureMode: null, // null | 'distance' | 'area'
    measurePoints: [], // 진행 중인 측정의 월드 좌표 점들
    measureCursor: null, // 마우스 현재 위치(월드 좌표) — 진행 중인 측정의 실시간 선/값 표시용
    _baseSnap: null, // 측정 중 마우스를 움직일 때 도면 전체를 다시 그리지 않으려고 둔 화면 캐시
    measurements: [], // 완료된 측정 결과들 { type, points, value }

    load(dxf) {
        this.entities = dxf.entities || [];
        this.layers = (dxf.tables && dxf.tables.layer && dxf.tables.layer.layers) || {};
        this.blocks = dxf.blocks || {};
        this.lineTypes = (dxf.tables && dxf.tables.lineType && dxf.tables.lineType.lineTypes) || {};
        this.ltScale = (dxf.header && Number(dxf.header.$LTSCALE)) || 1;
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
        this._fitOrRestoreView();
    },

    // loadDxfFile()이 새 파일을 열기 직전에, 지금 보고 있던 화면 중심의
    // 월드좌표와 배율을 기억해둔다 — 500m 구간 도면을 보다가 "전체 도면"을
    // 누르면 늘 전체보기로 리셋돼서 방금 보던 위치를 다시 찾아 확대해야 하는
    // 불편이 있었다(실사용 중 확인됨). 500m 구간 파일과 노선 전체 파일은
    // 같은 실세계 좌표계를 쓰기 때문에(둘 다 절대좌표), 새 도면에도 같은
    // 위치가 있으면 그 위치·배율 그대로 이어서 보여줄 수 있다.
    captureViewForRestore() {
        this._pendingRestoreView = null;
        if (!this.canvas || !this.bbox || !this.canvas.width || !this.canvas.height) return;
        const [wx, wy] = this._toWorld(this.canvas.width / 2, this.canvas.height / 2);
        this._pendingRestoreView = { worldX: wx, worldY: wy, scale: this.scale };
    },

    // 기억해둔 위치가 새로 불러온 도면의 bbox 안에 실제로 있을 때만 그 위치로
    // 이어서 보여주고(직전 배율 그대로 유지), 아니면(전혀 다른 도면으로
    // 전환한 경우) 평소처럼 전체보기로 맞춘다.
    _fitOrRestoreView() {
        const pending = this._pendingRestoreView;
        this._pendingRestoreView = null;
        if (pending && this.bbox && this.canvas &&
            pending.worldX >= this.bbox.minX && pending.worldX <= this.bbox.maxX &&
            pending.worldY >= this.bbox.minY && pending.worldY <= this.bbox.maxY) {
            this.scale = pending.scale;
            this.panX = this.canvas.width / 2 - pending.worldX * this.scale;
            this.panY = this.canvas.height / 2 - pending.worldY * this.scale;
            this.render();
            return;
        }
        this.fit();
    },

    // 엔티티 하나가 차지하는 점들(바운딩박스 계산용).
    _entityPoints(e) {
        const pts = [];
        const add = (x, y) => { if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]); };
        if (e.vertices) e.vertices.forEach((v) => add(v.x, v.y));
        if (e.center) { const r = e.radius || 0; add(e.center.x - r, e.center.y - r); add(e.center.x + r, e.center.y + r); }
        if (e.position) add(e.position.x, e.position.y);
        if (e.startPoint) add(e.startPoint.x, e.startPoint.y);
        if (e.controlPoints) e.controlPoints.forEach((v) => add(v.x, v.y));
        if (e.boundaryPaths) e.boundaryPaths.forEach((path) => path.forEach((v) => add(v.x, v.y)));
        if (e.points) e.points.forEach((v) => add(v.x, v.y));
        if (e.corners) e.corners.forEach((v) => add(v.x, v.y));
        return pts;
    },

    _computeBBox() {
        // TITLE 레이어는 실제 도면과 무관한 장식 요소(예: "장성로고" INSERT)가
        // 도면 본문에서 한참 떨어진 좌표에 박혀 있는 경우가 실제 파일에서
        // 확인됐다(도면 내용은 폭 ~540 범위인데 이 로고 하나 때문에 바운딩박스
        // 폭이 ~950으로 늘어나, "전체보기"/인쇄 모두에서 빈 배경이 크게 남았다).
        // 도면 프레임(CX-BORD-*)이나 실제 지형지물이 아니라 순수 장식이라
        // 바운딩박스 계산에서 제외한다. 꺼져 있는(동결/off) 레이어도 화면에 안 그려지니
        // 도면 위치를 잡는 데 쓰지 않는다(전부 꺼져 있으면 어쩔 수 없이 전체를 쓴다).
        const collect = (skipHidden) => {
            const groups = [];
            this.entities.forEach((e) => {
                if (e.layer === 'TITLE') return;
                if (skipHidden && this.layerVisible[e.layer] === false) return;
                const pts = this._entityPoints(e);
                if (pts.length) groups.push(pts);
            });
            return groups;
        };
        let groups = collect(true);
        if (!groups.length) groups = collect(false);
        if (!groups.length) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
        const [minX, minY, maxX, maxY] = this._robustBounds(groups);
        return { minX, minY, maxX, maxY };
    },

    // 도면 본문에서 터무니없이 떨어진 쓰레기 엔티티를 빼고 바운딩박스를 잡는다.
    // 실제 파일(DWG→DXF 변환본)에 좌표가 (-221526, 44)·(336962, 44)처럼 본문(약 18만, 30만
    // 부근)에서 수십만 떨어진 2점짜리 폴리선이 1개 섞여 있어서, 그 하나 때문에 "전체보기"가
    // 도면을 점처럼 작게 보여주거나 빈 곳으로 이동하는 문제가 있었다(헤더의 $EXTMIN/$EXTMAX는
    // 본문 범위로 정상). 점들의 2~98% 구간을 본문으로 보고, 그 구간 폭의 절반만큼 여유를 둔
    // 바깥에 점이 하나라도 있는 엔티티는 범위 계산에서만 뺀다(화면에는 그대로 그려진다).
    // 그런 엔티티가 전체의 1%(최소 3개)를 넘으면 쓰레기가 아니라 실제로 떨어진 도면 요소로
    // 보고 아무것도 빼지 않는다(예: 종단면도처럼 영역이 여러 곳인 도면).
    _robustBounds(groups) {
        const plain = (gs) => {
            let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
            for (const g of gs) for (const p of g) {
                if (p[0] < a) a = p[0]; if (p[0] > c) c = p[0];
                if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1];
            }
            return [a, b, c, d];
        };
        let total = 0;
        groups.forEach((g) => { total += g.length; });
        if (total < 20) return plain(groups);
        const xs = new Float64Array(total), ys = new Float64Array(total);
        let k = 0;
        for (const g of groups) for (const p of g) { xs[k] = p[0]; ys[k] = p[1]; k++; }
        xs.sort(); ys.sort();
        const q = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(f * arr.length))];
        const loX = q(xs, 0.02), hiX = q(xs, 0.98), loY = q(ys, 0.02), hiY = q(ys, 0.98);
        const m = Math.max(1, Math.max(hiX - loX, hiY - loY) * 0.5);
        const kept = [];
        let dropped = 0;
        for (const g of groups) {
            if (g.some((p) => p[0] < loX - m || p[0] > hiX + m || p[1] < loY - m || p[1] > hiY + m)) dropped++;
            else kept.push(g);
        }
        if (!kept.length || dropped > Math.max(3, groups.length * 0.01)) return plain(groups);
        return plain(kept);
    },

    fit() {
        if (!this.canvas || !this.bbox) return;
        const w = this.bbox.maxX - this.bbox.minX || 1;
        const h = this.bbox.maxY - this.bbox.minY || 1;
        const cw = this.canvas.width, ch = this.canvas.height;
        // 팝업 창 레이아웃이 아직 안 잡혀 캔버스 크기가 0이면 배율이 0이 돼 도면이 안 보인다 —
        // 크기가 정해지는 시점(resizeDxfCanvas)에 다시 맞추도록 표시만 해둔다.
        if (!cw || !ch) { this._needFit = true; return; }
        this._needFit = false;
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
        ctx.setLineDash([]);

        // 측정 모드일 때만 도면 그림을 캐시한다 — 마우스를 움직일 때마다 큰 도면을
        // 통째로 다시 그리면 느려서, 그 뒤엔 캐시 위에 측정선만 덧그린다(renderOverlay).
        this._baseSnap = this.measureMode ? ctx.getImageData(0, 0, this.canvas.width, this.canvas.height) : null;
        this._drawMeasurements();
    },

    renderOverlay() {
        if (!this._baseSnap || this._baseSnap.width !== this.canvas.width || this._baseSnap.height !== this.canvas.height) {
            this.render();
            return;
        }
        this.ctx.putImageData(this._baseSnap, 0, 0);
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

    // 엔티티의 선 종류 이름 — 자기 값 → (ByLayer면) 레이어 값 → (ByBlock이면) 이 엔티티를 담은 INSERT의 값.
    _ltNameOf(e) {
        const n = e.lineType;
        if (n && !/^bylayer$/i.test(n)) {
            if (/^byblock$/i.test(n)) return this._insertLt || 'Continuous';
            return n;
        }
        return (e.layer && this.layerLineType[e.layer]) || 'Continuous';
    },

    // 선 종류 패턴(양수=선, 음수=공백, 0=점)을 화면 픽셀 단위 점선 배열로 바꾼다. 연속 선이거나 너무 촘촘하면 빈 배열(실선).
    _dashFor(e, radiusScale) {
        const name = this._ltNameOf(e);
        if (!name || /^continuous$/i.test(name)) return NO_DASH;
        const lt = this.lineTypes[name];
        const pat = lt && lt.pattern;
        if (!pat || pat.length < 2) return NO_DASH;
        const k = (this.ltScale || 1) * (e.lineTypeScale || 1) * radiusScale * this.scale;
        const segs = [];
        for (const v of pat) {
            const isOn = v >= 0;
            const len = v === 0 ? 0.8 : Math.abs(v) * k; // 점(0)은 1픽셀 안팎의 점으로
            const last = segs[segs.length - 1];
            if (last && last.on === isOn) last.len += len; else segs.push({ on: isOn, len });
        }
        if (!segs.length) return NO_DASH;
        if (!segs[0].on) segs.unshift({ on: true, len: 0 });
        const out = segs.map((sg) => (sg.on ? Math.max(0.5, sg.len) : sg.len));
        if (out.length % 2) out.push(0);
        const total = out.reduce((x, y) => x + y, 0);
        if (!(total >= 2.5)) return NO_DASH; // 한 주기가 2.5px도 안 되면 점선이 아니라 회색 띠로 보이므로 실선으로
        return out;
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

        const prevLt = this._insertLt;
        this._insertLt = this._ltNameOf(e);
        try {
            block.entities.forEach((be) => {
                if (be.layer && this.layerVisible[be.layer] === false) return;
                const color = this._resolveColor(be, defaultColor, insertColor);
                this.ctx.strokeStyle = color;
                this.ctx.fillStyle = color;
                try { this._drawEntity(be, tf, radiusScale, rot, defaultColor, depth + 1, color); } catch (err) { /* 무시 */ }
            });
        } finally { this._insertLt = prevLt; }
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

        // 진행 중인 측정 — 찍은 점들에 마우스 위치까지 이어 실시간으로 보여준다.
        if (this.measurePoints.length > 0) {
            const live = this.measureCursor ? [...this.measurePoints, this.measureCursor] : this.measurePoints;
            const pts = live.map(([x, y]) => this._toScreen(x, y));
            const isArea = this.measureMode === 'area';
            ctx.strokeStyle = measureColor;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            pts.forEach(([sx, sy], i) => { if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); });
            if (isArea && pts.length >= 3) {
                ctx.closePath();
                ctx.fillStyle = 'rgba(255,149,0,0.15)';
                ctx.fill();
            }
            ctx.stroke();
            ctx.setLineDash([]);
            this.measurePoints.forEach(([x, y]) => drawPoint(this._toScreen(x, y)));

            if (this.measureCursor) {
                const [cx, cy] = pts[pts.length - 1];
                const [px, py] = this.measureCursor;
                const [lx, ly] = this.measurePoints[this.measurePoints.length - 1];
                const seg = Math.hypot(px - lx, py - ly);
                let label = `${seg.toFixed(2)} m`;
                if (isArea) {
                    label = pts.length >= 3 ? `${this._polygonArea(live).toFixed(2)} m²` : label;
                }
                ctx.fillStyle = measureColor;
                ctx.fillText(label, cx + 10, cy - 10);
            }
        }
    },

    _polygonArea(pts) {
        let sum = 0;
        for (let i = 0; i < pts.length; i++) {
            const [x1, y1] = pts[i];
            const [x2, y2] = pts[(i + 1) % pts.length];
            sum += x1 * y2 - x2 * y1;
        }
        return Math.abs(sum) / 2;
    },

    addMeasurePoint(worldX, worldY) {
        if (!this.measureMode || !(this.scale > 0)) return;
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
        if (this.measureMode !== 'area') return;
        // 더블클릭은 클릭 두 번이라 같은 자리에 점이 두 번 찍힌다 — 하나는 뺀다.
        const n = this.measurePoints.length;
        if (n >= 2 && this.measurePoints[n - 1][0] === this.measurePoints[n - 2][0] && this.measurePoints[n - 1][1] === this.measurePoints[n - 2][1]) {
            this.measurePoints.pop();
        }
        if (this.measurePoints.length < 3) return;
        const pts = this.measurePoints;
        const value = this._polygonArea(pts);
        this.measurements.push({ type: 'area', points: [...pts], value });
        this.measurePoints = [];
        updateMeasureResult(`면적: ${value.toFixed(2)} m²`);
        this.render();
    },

    clearMeasurements() {
        this.measurements = [];
        this.measurePoints = [];
        this.measureCursor = null;
        updateMeasureResult('');
        this.render();
    },

    // tf/radiusScale/rot: INSERT(블록) 내부 엔티티를 부모 블록의 위치/축척/회전으로
    // 변환해서 그리기 위한 값들. 최상위 엔티티는 tf=null(항등변환), radiusScale=1, rot=0.
    // ownColor: 호출부가 이미 이 엔티티 e에 대해 계산해 ctx에 적용해 둔 색 —
    // e가 INSERT일 때 그 안의 레이어 "0" 자식들에게 물려줄 색으로 그대로 전달된다.
    _drawEntity(e, tf, radiusScale, rot, defaultColor, depth, ownColor) {
        const ctx = this.ctx;
        ctx.setLineDash(this._dashFor(e, radiusScale));
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
                const verts = e.vertices;
                const vCount = verts.length;
                const segCount = e.shape ? vCount : vCount - 1;
                ctx.beginPath();
                const [x0, y0] = this._pt(tf, verts[0].x, verts[0].y);
                ctx.moveTo(x0, y0);
                for (let i = 0; i < segCount; i++) {
                    const v1 = verts[i];
                    const v2 = verts[(i + 1) % vCount];
                    const arc = v1.bulge ? bulgeArc(v1.x, v1.y, v2.x, v2.y, v1.bulge) : null;
                    if (arc) {
                        const [scx, scy] = this._pt(tf, arc.cx, arc.cy);
                        const ccw = bulgeSweepCCW(arc.a1, arc.a2, arc.aMid);
                        // 화면 Y축이 반전돼 있어 회전 방향도 반대로 뒤집힌다(ARC 케이스와 동일한 규칙)
                        ctx.arc(scx, scy, arc.r * radiusScale * this.scale, -(arc.a1 + rot), -(arc.a2 + rot), ccw);
                    } else {
                        const [x2, y2] = this._pt(tf, v2.x, v2.y);
                        ctx.lineTo(x2, y2);
                    }
                }
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
                    // MTEXT는 회전각(50) 대신 방향 벡터(11/21)로 기울기를 주는 경우가 있다
                    const angleRad = e.rotation != null ? (e.rotation * Math.PI) / 180
                        : (e.directionVector ? Math.atan2(e.directionVector.y, e.directionVector.x) : 0);
                    ctx.save();
                    ctx.translate(x, y);
                    ctx.rotate(-(angleRad + rot));
                    const isNarrowStyle = NARROW_DXF_STYLE_NAMES.has(e.textStyle);
                    if (isNarrowStyle) ctx.scale(NARROW_DXF_SCALE_X, 1); // romans.shx 근사 — 가로만 압축
                    if (e.type === 'TEXT' && e.xScale && e.xScale > 0 && e.xScale !== 1) ctx.scale(e.xScale, 1); // 글자 폭 비율(그룹코드 41)
                    ctx.font = `${size}px ${DXF_FONT_FAMILY_BY_STYLE[e.textStyle] || 'sans-serif'}`;
                    // halign 1=가운데, 2=우측(그 외 0/좌측이 기본) — canvas의
                    // textAlign이 그대로 대응돼서 계산 없이 바로 쓸 수 있다.
                    let hAlign; let vAlign;
                    if (e.type === 'MTEXT') {
                        // MTEXT 맞춤 기준점(71): 1~3 위, 4~6 가운데, 7~9 아래 / 각 줄에서 왼쪽·가운데·오른쪽
                        const ap = e.attachmentPoint || 1;
                        hAlign = ['left', 'center', 'right'][(ap - 1) % 3] || 'left';
                        vAlign = ['top', 'middle', 'bottom'][Math.floor((ap - 1) / 3)] || 'top';
                    } else {
                        // TEXT halign 4(가운데)는 가로·세로 모두 가운데 정렬이다
                        hAlign = e.halign === 2 ? 'right' : e.halign ? 'center' : 'left';
                        vAlign = e.valign === 3 ? 'top' : e.valign === 2 ? 'middle' : e.valign === 1 ? 'bottom' : (e.halign === 4 ? 'middle' : 'alphabetic');
                    }
                    ctx.textAlign = hAlign;
                    ctx.textBaseline = vAlign;
                    const textLines = decodeDxfText(formatSlopeAnnotationText(e.text, e.layer)).split('\n');
                    const lineH = size * 1.2;
                    // 여러 줄은 기준점이 아래면 위로, 가운데면 양쪽으로 쌓는다
                    const firstY = vAlign === 'bottom' ? -(textLines.length - 1) * lineH : vAlign === 'middle' ? -((textLines.length - 1) * lineH) / 2 : 0;
                    textLines.forEach((line, i) => {
                        ctx.fillText(line, 0, firstY + i * lineH);
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
                // 이 프로젝트 도면의 해치는 전부 SOLID(단색 채우기)라 오토캐드처럼 불투명하게 칠한다.
                // (예전엔 반투명 35%로 칠해서 표지판의 빨간 링이 검붉게 보였다.) 사선 같은 무늬 해치는 재현하지 않는다.
                if (!e.boundaryPaths || !e.boundaryPaths.length) return;
                ctx.save();
                ctx.globalAlpha = 1;
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
    // 패널이 숨겨져 크기가 0으로 잡히는 순간엔 건드리지 않는다(배율이 0으로 망가지는 것 방지).
    if (!newW || !newH) return;
    // 처음으로 제대로 된 크기를 받는 순간엔, 그 전에 맞춘 배율(기본 300x150 캔버스 기준)이
    // 의미가 없으니 비례 조정 대신 전체보기로 다시 맞춘다.
    const firstSize = !dxfViewer._sizedOnce;
    dxfViewer._sizedOnce = true;
    // 도면이 로드된 상태에서 캔버스 크기만 바꾸고 scale/pan을 그대로 두면(예전
    // 방식), 열었을 땐 창에 꽉 차 보이던 도면이 팝업 창을 최대화하거나 창
    // 크기를 조절할 때마다 캔버스만 커지고 도면은 이전 픽셀 크기 그대로 남아
    // "화면이 멀리서 축소된 것처럼" 보이는 문제가 있었다(실사용 중 확인됨).
    // 그래서 크기가 바뀌기 직전 화면 중심의 월드좌표를 기억해뒀다가, 크기가
    // 바뀐 뒤에도 그 좌표가 새 캔버스 중심에 오도록, 그리고 도면이 이전과 같은
    // 비율로 화면을 채우도록 scale/pan을 함께 비례 조정한다.
    if (dxfViewer.bbox && !firstSize && oldW > 0 && oldH > 0 && (newW !== oldW || newH !== oldH)) {
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
        if (dxfViewer.bbox && newW > 0 && newH > 0 && (firstSize || dxfViewer._needFit || !(dxfViewer.scale > 0))) dxfViewer.fit();
        else if (dxfViewer.bbox) dxfViewer.render();
    }
}

function initDxfCanvas() {
    const canvas = document.getElementById('cad-canvas');
    dxfViewer.canvas = canvas;
    dxfViewer.ctx = canvas.getContext('2d', { willReadFrequently: true });

    resizeDxfCanvas();
    window.addEventListener('resize', resizeDxfCanvas);
    // 창 resize 이벤트 없이 레이아웃만 늦게 잡히는 경우(팝업 첫 표시 등)도 따라가도록 크기를 지켜본다.
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resizeDxfCanvas).observe(document.getElementById('cad-viewer-wrap'));

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
    canvas.addEventListener('mousemove', (e) => {
        if (dragging || !dxfViewer.measureMode || dxfViewer.measurePoints.length === 0) return;
        const rect = canvas.getBoundingClientRect();
        dxfViewer.measureCursor = dxfViewer._toWorld(e.clientX - rect.left, e.clientY - rect.top);
        if (dxfViewer._rafPending) return;
        dxfViewer._rafPending = true;
        requestAnimationFrame(() => { dxfViewer._rafPending = false; dxfViewer.renderOverlay(); });
    });
    canvas.addEventListener('mouseleave', () => {
        if (!dxfViewer.measureCursor) return;
        dxfViewer.measureCursor = null;
        dxfViewer.renderOverlay();
    });
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dxfViewer.measureMode && dxfViewer.measurePoints.length > 0) {
            dxfViewer.measurePoints = [];
            dxfViewer.measureCursor = null;
            dxfViewer.render();
        }
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
    dxfViewer.measureCursor = null;
    dxfViewer.render();
    updateMeasureResult(dxfViewer.measureMode === 'area' ? '다각형 클릭 후 더블클릭으로 완료 (Esc: 취소)' : '');
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

// ATTRIB(블록 속성 값)도 포함한다. 블록 정의 안에서 다른 블록을 INSERT한 경우(예: 제한중량 표지 CMRS216을 감싼 익명 블록 A$C...),
// 그 속성 값(43, 2 같은 숫자)은 INSERT 바로 뒤의 ATTRIB 엔티티로 들어 있는데 dxf-parser가 읽지 않아 숫자가 통째로 빠졌다
// (구발선 1구간 평면도 1번 섹터에서 확인). ATTRIB 좌표는 그 INSERT가 들어 있는 블록 기준(로컬) 좌표라서, 블록 이름별로 모아 두면
// 바깥 INSERT의 위치/회전/축척이 _drawInsert에서 그대로 적용된다.
const BLOCK_SUPPLEMENTAL_BUILDERS = { HATCH: buildHatchEntity, LEADER: buildLeaderEntity, WIPEOUT: buildWipeoutEntity, ATTRIB: buildAttribEntity };

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

// 불지(bulge) 변을 호로 펼친 중간 점들(양 끝점 제외). bulge = tan(포함각/4), 양수면 반시계.
function tessellateBulge(p1, p2, bulge) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const chord = Math.hypot(dx, dy);
    if (!chord || !bulge) return [];
    const theta = 4 * Math.atan(bulge);
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    const h = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
    const sign = (bulge > 0 ? 1 : -1) * (Math.abs(theta) > Math.PI ? -1 : 1); // 작은 호면 중심이 진행 방향 왼쪽(반시계)/오른쪽(시계)
    const cx = (p1.x + p2.x) / 2 + (-dy / chord) * h * sign;
    const cy = (p1.y + p2.y) / 2 + (dx / chord) * h * sign;
    const a1 = Math.atan2(p1.y - cy, p1.x - cx);
    const steps = Math.max(2, Math.ceil(Math.abs(theta) / (Math.PI / 18)));
    const out = [];
    for (let k = 1; k < steps; k++) {
        const a = a1 + theta * (k / steps);
        out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    return out;
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
                let closed = true;
                if (tags[idx] && tags[idx][0] === 72) idx++; // 불지(bulge) 존재 여부 — 값 자체(42)를 읽는다
                if (tags[idx] && tags[idx][0] === 73) { closed = parseInt(tags[idx][1], 10) !== 0; idx++; } // 닫힘 여부
                let vcount = 0;
                if (tags[idx] && tags[idx][0] === 93) { vcount = parseInt(tags[idx][1], 10); idx++; }
                const verts = [];
                for (let v = 0; v < vcount && idx < tags.length; v++) {
                    let x = null, y = null, bulge = 0;
                    if (tags[idx] && tags[idx][0] === 10) { x = parseFloat(tags[idx][1]); idx++; }
                    if (tags[idx] && tags[idx][0] === 20) { y = parseFloat(tags[idx][1]); idx++; }
                    if (tags[idx] && tags[idx][0] === 42) { bulge = parseFloat(tags[idx][1]) || 0; idx++; }
                    if (x != null && y != null) verts.push({ x, y, bulge });
                }
                // 불지가 있는 변은 호로 펼친다(둥근 모서리, 두 점+불지로 그린 원 등이 직선으로 잘리지 않게)
                verts.forEach((vt, i) => {
                    pts.push({ x: vt.x, y: vt.y });
                    if (vt.bulge && (closed || i < verts.length - 1)) {
                        tessellateBulge(vt, verts[(i + 1) % verts.length], vt.bulge).forEach((p) => pts.push(p));
                    }
                });
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
                            if (ccw) { while (end < start) end += Math.PI * 2; } // 반시계: 끝각이 시작각보다 작으면 한 바퀴 넘겨서
                            else { while (end > start) end -= Math.PI * 2; }
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
// dxf-parser는 TEXT/MTEXT의 그룹코드 7(문자 스타일 이름)을 아예 안 읽는다
// (ATTDEF만 textStyle로 읽어줌 — 라이브러리 소스로 직접 확인함). 그런데
// 실제 파일은 스타일마다 다른 글꼴(STYLE 테이블 참고: 굴림체/돋움체=한글
// 고딕 트루타입, Standard=Arial, Legend=Calibri, NGSW/GHS/GHS1=romans.shx
// — 오토캐드 표준 스트로크 글꼴로 일반 산세리프보다 자간·폭이 훨씬 좁다)를
// 써서, 지금처럼 전부 "sans-serif" 하나로만 그리면 romans.shx 계열 글자
// (거리·측점 숫자 등 영문/숫자 위주)가 원본보다 넓게 퍼져 보인다(사용자
// 지적으로 확인). trim 복원과 같은 방식(핸들로 원문 재조회)으로 스타일
// 이름도 같이 모은다.
function buildUntrimmedTextByHandle(text) {
    const lines = text.split(/\r\n|\r|\n/);
    const textMap = {};
    const styleMap = {};
    let i = 0;
    let curHandle = null;
    let curText;
    let curStyle;
    const flush = () => {
        if (curHandle != null) {
            if (curText !== undefined) textMap[curHandle] = curText;
            if (curStyle !== undefined) styleMap[curHandle] = curStyle;
        }
        curHandle = null;
        curText = undefined;
        curStyle = undefined;
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
        } else if (code === '7') {
            curStyle = value.trim();
        }
        i += 2;
    }
    flush();
    return { textMap, styleMap };
}

function restoreUntrimmedText(dxf, { textMap, styleMap }) {
    const patch = (e) => {
        if (!e || !e.handle) return;
        if (e.text !== undefined && textMap[e.handle] !== undefined) e.text = textMap[e.handle];
        if (styleMap[e.handle] !== undefined) e.textStyle = styleMap[e.handle];
    };
    (dxf.entities || []).forEach(patch);
    Object.values(dxf.blocks || {}).forEach((b) => (b.entities || []).forEach(patch));
}

// STYLE 테이블에 실제로 적힌 글꼴에 최대한 맞춘 CSS 폰트 — 한글 고딕류는
// 파일마다 트루타입 폰트명이 있어도 "글꼴명(한글)" ↔ 실제 파일명이 깨져서
// 오는 경우가 많아(예: "援대┝泥�") 안전하게 계열별로만 묶는다.
const DXF_FONT_FAMILY_BY_STYLE = {
    '굴림체': "Gulim, '맑은 고딕', sans-serif",
    '굴림': "Gulim, '맑은 고딕', sans-serif",
    '돋움체': "Dotum, '맑은 고딕', sans-serif",
    'TB_TEXT': "Dotum, '맑은 고딕', sans-serif",
    'SIGNTXT': "Dotum, '맑은 고딕', sans-serif",
    'SIGNText': "Dotum, '맑은 고딕', sans-serif",
    'Legend': 'Calibri, sans-serif',
    'Standard': 'Arial, sans-serif',
};
// romans.shx(오토캐드 표준 스트로크 글꼴) 계열 — 실제 파일에서 이 세 스타일
// 이름으로 확인됨(STYLE 테이블의 그룹코드 3이 romans.shx). 트루타입 산세리프
// 대비 글자 폭이 눈에 띄게 좁아서, 어느 시스템에서 봐도 똑같이 보이도록
// 글꼴 대신 가로 폭 자체를 줄인다(설치된 글꼴에 기대지 않는 방식). 0.75는
// romans.shx 특유의 좁은 비율을 대략 흉내 낸 값 — 정확한 원본 자간 실측치는
// 아니다.
const NARROW_DXF_STYLE_NAMES = new Set(['NGSW', 'GHS', 'GHS1']);
const NARROW_DXF_SCALE_X = 0.75;

let currentDxfMeta = null; // 지금 열린 도면의 파일 정보(구간·500m 구간 번호 등) — 지도 겹치기가 어느 구간 도면인지 알 때 쓴다
async function loadDxfFile(url, filename, meta) {
    currentDxfMeta = meta || null;
    if (typeof stopDxfOverlay === 'function' && typeof dxfOverlay !== 'undefined' && dxfOverlay.image) stopDxfOverlay(); // 다른 도면을 열면 지도 겹치기는 끈다
    dxfViewer.captureViewForRestore(); // 새 파일을 받아오기 전, 지금 보던 위치를 기억해둔다
    currentDxfFileUrl = url;
    currentDxfFileName = filename;
    document.getElementById('cad-empty-msg').style.display = 'none';
    // 도면이 열리면 뷰어를 원래 크기로 — 도면이 없을 땐 빈 캔버스가 패널을 크게 차지하지 않게
    // 낮게 접어둔다(사이드바 내장형만, CSS #left-sidebar #cad-viewer-wrap:not(.has-drawing))
    document.getElementById('cad-viewer-wrap').classList.add('has-drawing');
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
            try { dxfViewer.layerLineType = extractLayerLineTypes(text); } catch (err) { dxfViewer.layerLineType = {}; }
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
    'CA-ALGN-HMS2': '선형 각도 표기 2',
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
    'CF-OILS-PIPE': '송유관',
    'CF-ROAD-BIKE': '자전거도로',
    'CF-RTWL-CONC': '콘크리트 옹벽',
    'CF-RTWL-STON': '석축형 옹벽',
    'CL-ADMN-NAME': '행정구역 명칭',
    'CL-ADMN-TOWN': '행정구역(읍면동) 경계',
    'CL-BOND-ROAD': '도로 경계선',
    'CL-LOTL': '지번선',
    'CL-LOTT': '지번 텍스트',
    'CM-LEAD': '인출선',
    'CM-LEAL': '인출선(선)',
    'CM-LEAT': '인출선(문자)',
    'CM-MISC': '기타',
    'CM-RDGS': '도로 기하',
    'CM-RDMK': '노면 표시',
    'CM-RDMK-LAND': '노면 표시(육상)',
    'CM-RDMK-WALK': '노면 표시(보도)',
    'CM-RDSB': '노면 표시 기호',
    'CM-RDSB-PATT-PAT1': '노면 표시 패턴 1',
    'CM-RDSB-PATT-PAT5': '노면 표시 패턴 5',
    'CM-RDSB-GRP2': '노면 표시 기호 그룹 2',
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
    'CX-LGND-LINE': '범례 선',
    'CX-LGND-TEXT': '범례 문자',
    'CX-MISC': '기타',
    'CW-WATR-VALV': '상수 밸브',
    'CWVALXX': '상수 밸브 계열',
    'TITLE': '표제',
    '0': '기본 레이어',
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
    initDxfOverlayControls();
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

// 전체자료(SHP/DBF) 다운로드가 쓰는 3단계 범위 규칙 — 데이터보기 트리에서
// 구간을 선택했으면 그 구간만(rdid), 구간 없이 호선만 선택했으면
// (currentRoute.rdid가 빈 문자열인 "노선 전체" 모드,
// selectRouteGroupForLeftSidebar 참고) 그 호선 전체를, 아무것도 선택 안
// 했으면(currentRoute가 아예 null) 빈 파라미터로 보내 서버가 로그인 계정의
// 관할 전체로 처리하게 한다(routes/sections.js의 resolveScopedSections와
// 대칭). 조서(엑셀)는 이제 새창 미리보기(script.js의
// openLedgerReportPreview, 구간 1개 전용)로만 받아서 이 3단계 규칙을 안
// 쓴다 — 조서의 "전체" 다운로드는 새창 안의 버튼이 항상 관할 전체(zip)만
// 받고, 호선 전체 단위의 조서 다운로드는 더 이상 없다.
function downloadScopeParams() {
    if (currentRoute && currentRoute.rdid) return { rdid: currentRoute.rdid };
    if (currentRoute && currentRoute.route_no) {
        return {
            road_grade: currentRoute.road_rank_name || currentRoute.road_grade || '',
            route_no: currentRoute.route_no || '',
            route_name: currentRoute.route_name || '',
        };
    }
    return {};
}

// 선택 범위(구간/호선/관할 전체)의 모든 자료(속성+지오메트리+사진+보고서+도면)를
// 일괄등록 때 받는 것과 같은 SHP/DBF 납품 폴더 구조의 zip으로 내려받는다.
// zip은 용량이 수 GB가 될 수 있어 파일 전체를 브라우저 메모리에 받았다가 저장하는 방식(fetch→blob)이 아니라,
// 브라우저의 일반 다운로드(스트리밍)로 받는다 — 서버가 만드는 대로 바로 디스크에 저장되고 다운로드 진행률도 브라우저가 보여준다.
// 먼저 check=1로 "받을 수 있는지"만 확인해서(구간 없음/권한 없음 등), 오류가 JSON 페이지로 화면을 덮지 않게 한다.
async function downloadSectionExport() {
    return downloadSectionExportWith(downloadScopeParams());
}

// 범위 파라미터를 직접 받아 내려받는다(여러 노선 선택 내려받기 등).
async function downloadSectionExportWith(scopeParams) {
    // 이 버튼은 index.html/cad-popup.html에서 서로 다른 위치(패널)에 있어
    // 공통으로 잡을 컨테이너가 없으므로 body 전체에 모래시계 커서를 건다.
    document.body.classList.add('app-busy');
    try {
        const params = new URLSearchParams(scopeParams);
        const base = '/api/sections/export?' + params.toString();
        const check = await fetch(base + (params.toString() ? '&' : '') + 'check=1');
        if (!check.ok) {
            const data = await check.json().catch(() => ({}));
            uiAlert(data.error || '다운로드에 실패했습니다.');
            return;
        }
        const info = await check.json();
        const a = document.createElement('a');
        a.href = base;
        a.download = info.filename || '전체자료.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
    } finally {
        // 다운로드는 브라우저가 이어서 진행하므로 모래시계는 바로 푼다.
        document.body.classList.remove('app-busy');
    }
}

// ---------- 도면을 지도 위에 겹쳐 보기 ----------
// DXF 도면은 보통 측량 좌표(구 TM 등 평면직각좌표, 단위 m)로 그려져 있다. 도면 전체를 투명 배경 이미지로 한 번 그려서
// 그 좌표계(EPSG)를 지정한 이미지 레이어로 지도에 얹으면, OpenLayers가 지도 좌표계로 재투영해 준다(직선 몇 개를 변환하는 것과 달리
// 글자·해치·블록까지 도면 뷰어와 똑같이 보인다). 좌표계는 도면 위치가 지금 보는 구간(없으면 지도 중심)과 가장 가까워지는 것을 자동으로 고른다.
const OVERLAY_CRS_LIST = [
    { id: 'EPSG:5186', label: 'Korea 2000 중부원점 (5186)', def: '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs' },
    { id: 'EPSG:5185', label: 'Korea 2000 서부원점 (5185)', def: '+proj=tmerc +lat_0=38 +lon_0=125 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs' },
    { id: 'EPSG:5187', label: 'Korea 2000 동부원점 (5187)', def: '+proj=tmerc +lat_0=38 +lon_0=129 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs' },
    { id: 'EPSG:5188', label: 'Korea 2000 동해원점 (5188)', def: '+proj=tmerc +lat_0=38 +lon_0=131 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs' },
    { id: 'EPSG:5174', label: '구 TM 중부원점 Bessel (5174)', def: '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43' },
    { id: 'EPSG:5173', label: '구 TM 서부원점 Bessel (5173)', def: '+proj=tmerc +lat_0=38 +lon_0=125.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43' },
    { id: 'EPSG:5176', label: '구 TM 동부원점 Bessel (5176)', def: '+proj=tmerc +lat_0=38 +lon_0=129.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43' },
    { id: 'EPSG:5177', label: '구 TM 동해원점 Bessel (5177)', def: '+proj=tmerc +lat_0=38 +lon_0=131.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43' },
    { id: 'BESSEL_TM600', label: '구 TM 중부원점 Bessel (북쪽 600000)', def: '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=600000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43' },
    { id: 'EPSG:5181', label: 'Korea 2000 중부원점 (구, 5181)', def: '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +units=m +no_defs' },
    { id: 'EPSG:5179', label: 'UTM-K (5179)', def: '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs' },
];
const OVERLAY_MAX_PX = 4096;

// ---------- 시트(도곽) 좌표 도면 맞춤 ----------
// 500m 구간 도면(평면도 등)은 측량 좌표가 아니라 "시트 좌표"로 그려져 있다: 구간 번호마다 가로로 500씩 옮겨 놓은 같은 크기의 도곽 안에,
// 도로를 돌려서(회전·이동) 앉힌 것이다. 이런 도면은 어떤 좌표계(EPSG)로도 지도에 맞지 않는다. 도면 안의 도로 중심선(CA-ALGN-CNTL 등)과
// 시스템에 등록된 같은 500m 구간의 선(road_sectors)을 겹치도록 위치·회전·배율을 구하면 지도에 정확히 얹을 수 있다.

// 선(점 배열)을 호 길이 기준 같은 간격의 n개 점으로 다시 뽑는다.
function resamplePolyline(pts, n) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[cum.length - 1];
    if (!(total > 0)) return null;
    const out = [];
    let j = 1;
    for (let k = 0; k < n; k++) {
        const d = (total * k) / (n - 1);
        while (j < pts.length - 1 && cum[j] < d) j++;
        const seg = cum[j] - cum[j - 1] || 1;
        const t = Math.min(1, Math.max(0, (d - cum[j - 1]) / seg));
        out.push([pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * t, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * t]);
    }
    return { pts: out, length: total };
}

// a(시트) → b(세계) 닮음 변환(회전·이동·균일 배율) 최소제곱 해. b = s·R(θ)·a + t. 반환: {s, cos, sin, tx, ty, rms}
function fitSimilarity(A, B) {
    const n = A.length;
    let ax = 0, ay = 0, bx = 0, by = 0;
    for (let i = 0; i < n; i++) { ax += A[i][0]; ay += A[i][1]; bx += B[i][0]; by += B[i][1]; }
    ax /= n; ay /= n; bx /= n; by /= n;
    let sxx = 0, sxy = 0, saa = 0;
    for (let i = 0; i < n; i++) {
        const x = A[i][0] - ax, y = A[i][1] - ay, u = B[i][0] - bx, v = B[i][1] - by;
        sxx += x * u + y * v; sxy += x * v - y * u; saa += x * x + y * y;
    }
    const theta = Math.atan2(sxy, sxx);
    const c = Math.cos(theta), sn = Math.sin(theta);
    const s = (sxx * c + sxy * sn) / (saa || 1);
    const tx = bx - s * (c * ax - sn * ay);
    const ty = by - s * (sn * ax + c * ay);
    let err = 0;
    for (let i = 0; i < n; i++) {
        const px = s * (c * A[i][0] - sn * A[i][1]) + tx, py = s * (sn * A[i][0] + c * A[i][1]) + ty;
        err += (px - B[i][0]) ** 2 + (py - B[i][1]) ** 2;
    }
    return { s, cos: c, sin: sn, tx, ty, rms: Math.sqrt(err / n) };
}

// 시트 중심선(sheetLine)을 세계 좌표(5186 미터) 구간 선(worldLine)에 맞춘다. 선의 방향이 반대일 수 있어 둘 다 해 보고 더 잘 맞는 쪽을 쓴다.
function fitSheetToWorld(sheetLine, worldLine) {
    const a = resamplePolyline(sheetLine, 120);
    const b = resamplePolyline(worldLine, 120);
    if (!a || !b) return null;
    const f1 = fitSimilarity(a.pts, b.pts);
    const f2 = fitSimilarity(a.pts, b.pts.slice().reverse());
    const best = f1.rms <= f2.rms ? f1 : f2;
    return { ...best, sheetLength: a.length, worldLength: b.length };
}

// 도면에서 도로 중심선을 찾는다: 레이어 이름에 CNTL이 들어 있고 선 길이 합이 가장 긴 레이어의 폴리선들을, 끝점이 맞닿는 대로 이어 붙인다
// (중심선이 곡선 구간별로 토막나 있는 도면이 있다). 못 찾으면 null.
function findSheetCenterline(entities) {
    const byLayer = new Map();
    for (const e of entities) {
        if (!/CNTL/i.test(e.layer || '') || (e.type !== 'LWPOLYLINE' && e.type !== 'POLYLINE') || !e.vertices || e.vertices.length < 2) continue;
        const pts = e.vertices.map((v) => [v.x, v.y]);
        let len = 0;
        for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (!byLayer.has(e.layer)) byLayer.set(e.layer, { total: 0, pieces: [] });
        const g = byLayer.get(e.layer);
        g.total += len; g.pieces.push({ pts, len });
    }
    let bestLayer = null;
    for (const [layer, g] of byLayer) if (!bestLayer || g.total > byLayer.get(bestLayer).total) bestLayer = layer;
    if (!bestLayer) return null;
    // 같은 선이 겹쳐 두 번 그려진 도면이 있어서(끝점·점 개수가 같은 조각) 하나만 남긴다
    const seen = new Set();
    const pieces = byLayer.get(bestLayer).pieces.slice().sort((x, y) => y.len - x.len).filter((pc) => {
        const f = pc.pts[0]; const l = pc.pts[pc.pts.length - 1];
        const k1 = [f[0].toFixed(1), f[1].toFixed(1), l[0].toFixed(1), l[1].toFixed(1), pc.pts.length].join(',');
        const k2 = [l[0].toFixed(1), l[1].toFixed(1), f[0].toFixed(1), f[1].toFixed(1), pc.pts.length].join(',');
        if (seen.has(k1) || seen.has(k2)) return false;
        seen.add(k1);
        return true;
    });
    let chain = pieces.shift().pts.slice();
    const TOL = 1.0; // 이어 붙일 끝점 허용 간격(도면 단위=m)
    const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= TOL;
    for (let grew = true; grew && pieces.length;) {
        grew = false;
        for (let i = 0; i < pieces.length; i++) {
            const p = pieces[i].pts;
            const head = chain[0]; const tail = chain[chain.length - 1];
            // 이미 이어 붙인 선과 양 끝이 모두 맞닿는 조각(같은 선이 한 번 더 그려진 것)은 버린다 — 붙이면 길이가 두 배가 된다
            if ((near(head, p[0]) && near(tail, p[p.length - 1])) || (near(head, p[p.length - 1]) && near(tail, p[0]))) { pieces.splice(i, 1); grew = true; break; }
            if (near(tail, p[0])) chain = chain.concat(p.slice(1));
            else if (near(tail, p[p.length - 1])) chain = chain.concat(p.slice(0, -1).reverse());
            else if (near(head, p[p.length - 1])) chain = p.slice(0, -1).concat(chain);
            else if (near(head, p[0])) chain = p.slice(1).reverse().concat(chain);
            else continue;
            pieces.splice(i, 1); grew = true; break;
        }
    }
    let total = 0;
    for (let i = 1; i < chain.length; i++) total += Math.hypot(chain[i][0] - chain[i - 1][0], chain[i][1] - chain[i - 1][1]);
    return total >= 20 ? { pts: chain, len: total, layer: bestLayer } : null;
}

const OVERLAY_MATCH_KM = 30; // 지금 보는 위치와 이 거리 안에 놓이는 좌표계만 "자동 판별 성공"으로 본다

const dxfOverlay = { layer: null, crsId: null, opacity: 0.7, dx: 0, dy: 0, image: null, bbox: null, fileName: '', sheetFit: null, focusExtent: null };
let overlayCrsRegistered = false;

function ensureOverlayCrs() {
    if (overlayCrsRegistered) return;
    OVERLAY_CRS_LIST.forEach((c) => proj4.defs(c.id, c.def));
    ol.proj.proj4.register(proj4);
    overlayCrsRegistered = true;
}

// 엔티티가 차지하는 범위(도면 좌표) — 보이는 영역 밖의 것을 건너뛰기 위한 캐시. 점이 없거나 블록 배치는 여유를 두고 본다.
const overlayBoundsCache = new WeakMap();
function overlayEntityBounds(e) {
    let b = overlayBoundsCache.get(e);
    if (b !== undefined) return b;
    const pts = dxfViewer._entityPoints(e);
    if (!pts.length) b = null;
    else {
        let a = Infinity, c = Infinity, d = -Infinity, g = -Infinity;
        for (const p of pts) { if (p[0] < a) a = p[0]; if (p[0] > d) d = p[0]; if (p[1] < c) c = p[1]; if (p[1] > g) g = p[1]; }
        const m = (e.type === 'INSERT' || e.type === 'TEXT' || e.type === 'MTEXT') ? 100 : 0; // 블록·글자는 점 하나라 크기를 모른다
        b = [a - m, c - m, d + m, g + m];
    }
    overlayBoundsCache.set(e, b);
    return b;
}

// cv 캔버스에 도면을 그린다. s: 도면 1단위당 픽셀, center: 캔버스 중앙에 올 도면 좌표, east: 지도의 동쪽이 도면 좌표에서 향하는 단위 벡터
// (TM과 웹 메르카토르는 북쪽 방향이 약간 달라서 그만큼 돌려 그린다), cull: 보이는 도면 범위 [minX,minY,maxX,maxY].
dxfViewer.renderViewport = function renderViewport(cv, s, center, east, cull) {
    const saved = { canvas: this.canvas, ctx: this.ctx, scale: this.scale, panX: this.panX, panY: this.panY, bgDark: this.bgDark };
    try {
        this.canvas = cv;
        this.ctx = cv.getContext('2d');
        this.scale = s;
        this.panX = -s * center[0];
        this.panY = cv.height - s * center[1];
        this.bgDark = true; // 지도 위에서는 밝은 선이 잘 보인다
        this.ctx.setTransform(east[0], east[1], -east[1], east[0], cv.width / 2, cv.height / 2);
        const defaultColor = '#f2f2f2';
        this.entities.forEach((e) => {
            if (e.layer && this.layerVisible[e.layer] === false) return;
            const b = overlayEntityBounds(e);
            if (b && (b[2] < cull[0] || b[0] > cull[2] || b[3] < cull[1] || b[1] > cull[3])) return;
            const color = this._resolveColor(e, defaultColor);
            this.ctx.strokeStyle = color;
            this.ctx.fillStyle = color;
            this.ctx.lineWidth = 1.3;
            try { this._drawEntity(e, null, 1, 0, defaultColor, 0, color); } catch (err) { /* 지원하지 않는 엔티티는 건너뜀 */ }
        });
        this.ctx.setLineDash([]);
    } finally {
        Object.assign(this, saved);
    }
};

// 겹칠 때 기준이 되는 위치: 500m 구간 도면이면 그 구간의 선(시트 좌표 도면을 맞출 때도 쓴다), 아니면 구간 선, 그것도 없으면 지도 중심.
// 반환: { pts: 경위도 점들, sector: 그 500m 구간 행(있을 때) }
async function overlayReference() {
    const meta = currentDxfMeta;
    const partsOf = (g) => (g && (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : null));
    let rec = null;
    const rdid = (meta && meta.section_rdid) || (currentRoute && currentRoute.rdid);
    if (rdid) {
        try { rec = (await fetch('/api/sections/' + encodeURIComponent(rdid)).then((r) => r.json())).record; } catch (e) { /* 아래에서 지도 중심으로 */ }
    }
    if (rec && meta && meta.seg_start_km != null) {
        try {
            const params = new URLSearchParams({ road_rank_name: rec.road_rank_name || '', route_no: rec.route_no || '', sect: rec.sect || '' });
            const data = await fetch('/api/sections/sectors?' + params.toString()).then((r) => r.json());
            const sector = (data.sectors || []).find((x) => x.sect === rec.sect && Math.abs(Number(x.sect_st) - Number(meta.seg_start_km)) < 0.01);
            const parts = sector && partsOf(sector.geom);
            if (parts && parts.length) return { pts: densifyLonLat(parts, 25, 3000), sector, section: rec };
        } catch (e) { /* 구간 선으로 */ }
    }
    const parts = rec && partsOf(rec.geom);
    if (parts && parts.length) return { pts: densifyLonLat(parts, 25, 3000), sector: null, section: rec };
    return { pts: [ol.proj.toLonLat(map.getView().getCenter())], sector: null, section: null };
}

// 경위도 선(들)을 대략 stepM(m) 간격의 점으로 채운다(최대 maxPts개).
function densifyLonLat(parts, stepM, maxPts) {
    const out = [];
    for (const part of parts) {
        for (let i = 0; i < part.length; i++) {
            out.push(part[i]);
            if (i === part.length - 1) break;
            const a = part[i]; const b = part[i + 1];
            const n = Math.floor((haversineKm(a, b) * 1000) / stepM);
            for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / (n + 1), a[1] + ((b[1] - a[1]) * k) / (n + 1)]);
        }
    }
    if (out.length <= maxPts) return out;
    const step = out.length / maxPts;
    return Array.from({ length: maxPts }, (_, i) => out[Math.floor(i * step)]);
}

function haversineKm(a, b) {
    const R = 6371;
    const dLat = ((b[1] - a[1]) * Math.PI) / 180;
    const dLon = ((b[0] - a[0]) * Math.PI) / 180;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

// 각 좌표계로 도면 중심을 경위도로 바꿔 보고, 기준 위치와 가장 가까운 것을 고른다.
function pickOverlayCrs(bbox, refPts) {
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    const scored = OVERLAY_CRS_LIST.map((c) => {
        let ll;
        try { ll = proj4(c.id, 'EPSG:4326', [cx, cy]); } catch (e) { return { c, km: Infinity }; }
        if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1]) || ll[0] < 120 || ll[0] > 135 || ll[1] < 32 || ll[1] > 40) return { c, km: Infinity };
        return { c, km: Math.min(...refPts.map((p) => haversineKm(ll, p))) };
    }).sort((a, b) => a.km - b.km);

    // 기준이 구간 선(점이 여럿)이면 도면의 레이어별 점들이 그 선에 얼마나 붙는지로 다시 가린다 — 도면 중심만으로는
    // 같은 지역을 가리키는 좌표계(GRS80/Bessel처럼 수백 m 차이)를 구별하지 못한다. 도로 중심선 레이어는 선에서 몇 m 안에 놓인다.
    if (refPts.length > 5) {
        const byLayer = new Map();
        dxfViewer.entities.forEach((e) => {
            if (e.layer === 'TITLE' || dxfViewer.layerVisible[e.layer] === false) return;
            const p = dxfViewer._entityPoints(e)[0];
            if (!p) return;
            if (!byLayer.has(e.layer)) byLayer.set(e.layer, []);
            const arr = byLayer.get(e.layer);
            if (arr.length < 400) arr.push(p);
        });
        const layers = [...byLayer.values()].filter((a) => a.length >= 10).map((a) => a.filter((_, i) => i % Math.ceil(a.length / 40) === 0));
        const lat0 = refPts[0][1]; const lon0 = refPts[0][0];
        const kx = 111320 * Math.cos((lat0 * Math.PI) / 180); const ky = 110574;
        const refXY = refPts.map((p) => [(p[0] - lon0) * kx, (p[1] - lat0) * ky]);
        scored.forEach((sc) => {
            if (!Number.isFinite(sc.km) || sc.km > OVERLAY_MATCH_KM) return;
            let bestLayer = Infinity;
            for (const pts of layers) {
                const ds = [];
                for (const p of pts) {
                    let ll; try { ll = proj4(sc.c.id, 'EPSG:4326', p); } catch (e) { continue; }
                    const x = (ll[0] - lon0) * kx; const y = (ll[1] - lat0) * ky;
                    let m = Infinity;
                    for (const r of refXY) { const d = (r[0] - x) ** 2 + (r[1] - y) ** 2; if (d < m) m = d; }
                    ds.push(Math.sqrt(m));
                }
                if (ds.length < 8) continue;
                ds.sort((a, b) => a - b);
                bestLayer = Math.min(bestLayer, ds[Math.floor(ds.length * 0.25)]);
            }
            sc.lineM = bestLayer;
        });
        scored.sort((a, b) => ((a.lineM ?? Infinity) - (b.lineM ?? Infinity)) || (a.km - b.km));
        // 선과의 거리가 확실히 가까운 것이 있으면(1km 이내) 그걸 우선한다
        if (Number.isFinite(scored[0].lineM) && scored[0].lineM < 1000) return { best: { ...scored[0], km: scored[0].lineM / 1000 }, scored };
    }
    return { best: scored[0], scored };
}

function overlayImageExtent() {
    const bb = dxfOverlay.bbox;
    return [bb.minX + dxfOverlay.dx, bb.minY + dxfOverlay.dy, bb.maxX + dxfOverlay.dx, bb.maxY + dxfOverlay.dy];
}

function applyOverlayLayer() {
    if (dxfOverlay.layer) { map.removeLayer(dxfOverlay.layer); dxfOverlay.layer = null; }
    if (!dxfOverlay.image || !dxfOverlay.crsId) return;
    const mapProj = map.getView().getProjection();
    const crsId = dxfOverlay.crsId;
    const fit = dxfOverlay.sheetFit;
    const toDrawing = (xy) => {
        const d = ol.proj.transform(xy, mapProj, crsId);
        const X = d[0] - dxfOverlay.dx; const Y = d[1] - dxfOverlay.dy;
        if (!fit) return [X, Y];
        const ux = X - fit.tx; const uy = Y - fit.ty;
        return [(fit.cos * ux + fit.sin * uy) / fit.s, (-fit.sin * ux + fit.cos * uy) / fit.s];
    };
    const source = new ol.source.ImageCanvas({
        projection: mapProj,
        ratio: 1,
        canvasFunction: (extent, resolution, pixelRatio, size) => {
            const cv = document.createElement('canvas');
            cv.width = Math.min(3000, Math.max(1, Math.round(size[0])));
            cv.height = Math.min(3000, Math.max(1, Math.round(size[1])));
            const mc = [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2];
            const dc = toDrawing(mc);
            const step = 500; // 지도 좌표 500m만큼 동쪽으로 간 점으로 방향과 축척을 잰다
            const de = toDrawing([mc[0] + step, mc[1]]);
            const vx = de[0] - dc[0]; const vy = de[1] - dc[1];
            const len = Math.hypot(vx, vy) || 1;
            const east = [vx / len, vy / len];
            const pxPerMapM = cv.width / (extent[2] - extent[0]);
            const s = (pxPerMapM * step) / len; // 도면 1단위(m)당 픽셀
            const corners = [[extent[0], extent[1]], [extent[2], extent[1]], [extent[0], extent[3]], [extent[2], extent[3]]].map(toDrawing);
            const cull = [Math.min(...corners.map((p) => p[0])), Math.min(...corners.map((p) => p[1])), Math.max(...corners.map((p) => p[0])), Math.max(...corners.map((p) => p[1]))];
            dxfViewer.renderViewport(cv, s, dc, east, cull);
            return cv;
        },
    });
    dxfOverlay.layer = new ol.layer.Image({ source, opacity: dxfOverlay.opacity, zIndex: 140 });
    map.addLayer(dxfOverlay.layer);
}

function overlayZoomToDrawing() {
    if (!dxfOverlay.layer) return;
    if (dxfOverlay.sheetFit && dxfOverlay.focusExtent) {
        map.getView().fit(dxfOverlay.focusExtent, { duration: 400, padding: [60, 60, 60, 60], maxZoom: 20 });
        return;
    }
    const ext = ol.proj.transformExtent(overlayImageExtent(), dxfOverlay.crsId, map.getView().getProjection());
    map.getView().fit(ext, { duration: 400, padding: [60, 60, 60, 60], maxZoom: 20 });
}

function setOverlayStatus(html) {
    const el = document.getElementById('cad-overlay-status');
    if (el) el.innerHTML = html;
}

async function startDxfOverlay() {
    if (!dxfViewer.entities.length || !dxfViewer.bbox) { uiAlert('먼저 도면(DXF)을 열어 주세요.'); return; }
    if (typeof map === 'undefined' || !map) return;
    ensureOverlayCrs();
    const panel = document.getElementById('cad-overlay-panel');
    panel.style.display = 'flex';
    setOverlayStatus('좌표계를 찾는 중…');
    await new Promise((r) => setTimeout(r, 30)); // 안내 문구가 먼저 보이게

    dxfOverlay.image = true; // 겹치기 사용 중 표시(그림은 지도 화면이 바뀔 때마다 보이는 부분만 그린다)
    dxfOverlay.bbox = { ...dxfViewer.bbox };
    dxfOverlay.fileName = (typeof currentDxfFileName !== 'undefined' && currentDxfFileName) || '';
    dxfOverlay.dx = 0; dxfOverlay.dy = 0;
    dxfOverlay.sheetFit = null; dxfOverlay.sheetFitSaved = null; dxfOverlay.focusExtent = null;
    document.getElementById('cad-overlay-dx').value = 0;
    document.getElementById('cad-overlay-dy').value = 0;
    if (dxfOverlay.layer) { map.removeLayer(dxfOverlay.layer); dxfOverlay.layer = null; }

    const ref = await overlayReference();
    const refPts = ref.pts;
    const { best, scored } = pickOverlayCrs(dxfOverlay.bbox, refPts);
    const sel = document.getElementById('cad-overlay-crs');
    const crsOptions = scored.filter((x) => Number.isFinite(x.km)).map((x) => `<option value="${x.c.id}">${x.c.label} — ${Number.isFinite(x.lineM) ? '구간 선과 ' + Math.round(x.lineM) + 'm' : '기준 위치에서 ' + (x.km < 1 ? Math.round(x.km * 1000) + 'm' : x.km.toFixed(1) + 'km')}</option>`).join('')
        + scored.filter((x) => !Number.isFinite(x.km)).map((x) => `<option value="${x.c.id}">${x.c.label} — 우리나라 밖</option>`).join('');
    sel.innerHTML = crsOptions;

    // 1) 시트 좌표 후보: 도면 안의 도로 중심선을 기준 선(500m 구간이면 그 구간, 아니면 구간 전체)에 맞춰 본다.
    const worldGeom = (ref.sector && ref.sector.geom) || (ref.section && ref.section.geom) || null;
    const worldCoords = worldGeom && (worldGeom.type === 'LineString' ? worldGeom.coordinates : worldGeom.type === 'MultiLineString' ? worldGeom.coordinates.flat() : null);
    let fit = null; let cl = null;
    if (worldCoords && worldCoords.length > 1) {
        cl = findSheetCenterline(dxfViewer.entities);
        const cand = cl && fitSheetToWorld(cl.pts, worldCoords.map((c) => proj4('EPSG:4326', 'EPSG:5186', c)));
        // 선 길이가 비슷하고(15% 이내) 배율이 1에 가깝고 중심선 오차가 작을 때만 인정
        if (cand && cand.rms < 25 && Math.abs(cand.s - 1) < 0.05 && Math.abs(cand.sheetLength / cand.worldLength - 1) < 0.15) fit = cand;
    }

    // 2) 측량 좌표(EPSG)로 그려진 도면인가: 기준 선이 있으면 도면의 선형이 그 선에 150m 안으로 붙는 좌표계가 있어야 인정한다.
    const lineBased = refPts.length > 5;
    const realOk = Number.isFinite(best.km) && best.km <= OVERLAY_MATCH_KM && (!lineBased || (Number.isFinite(best.lineM) && best.lineM < 150));
    // 좌표계가 구간 선과 6m 안으로 붙으면 좌표계를 쓴다. 그보다 어긋나는데 중심선 맞춤이 되면 맞춤이 더 정확하다
    // (시트 좌표 도면이 우연히 실제 위치 근처에 놓여 좌표계 하나가 10~20m 이내로 "비슷하게" 맞는 경우가 있다).
    const crsTight = realOk && (!lineBased || best.lineM < 6);
    if (realOk && (crsTight || !fit)) {
        dxfOverlay.crsId = best.c.id;
        sel.value = best.c.id;
        applyOverlayLayer();
        overlayZoomToDrawing();
        setOverlayStatus(`좌표계 <b>${escapeHtml(best.c.label)}</b>로 자동 판별했습니다(${Number.isFinite(best.lineM) ? '도면의 선형이 구간 선과 ' + Math.round(best.lineM) + 'm 이내로 일치' : '기준 위치와 ' + (best.km < 1 ? Math.round(best.km * 1000) + 'm' : best.km.toFixed(1) + 'km')}). 어긋나 보이면 좌표계를 바꾸거나 위치를 보정하세요.`);
        return;
    }
    if (fit) {
        const kind = ref.sector ? '500m 구간' : '구간';
        dxfOverlay.sheetFitSaved = fit;
        dxfOverlay.sheetFit = fit;
        dxfOverlay.crsId = 'EPSG:5186';
        dxfOverlay.focusExtent = ol.proj.transformExtent(ol.extent.boundingExtent(worldCoords), 'EPSG:4326', map.getView().getProjection());
        sel.innerHTML = `<option value="SHEET">시트 좌표 자동 맞춤 — 중심선 오차 평균 ${fit.rms.toFixed(1)}m</option>` + crsOptions;
        sel.value = 'SHEET';
        applyOverlayLayer();
        overlayZoomToDrawing();
        setOverlayStatus(`이 도면은 측량 좌표(EPSG)와 어긋나는 <b>시트(도곽) 좌표</b>로 그려져 있어 좌표계로는 지도에 맞지 않습니다. 도면의 도로 중심선(${escapeHtml(cl.layer)})을 시스템에 등록된 같은 ${kind} 선에 맞춰 위치와 회전을 자동으로 맞췄습니다(중심선 오차 평균 ${fit.rms.toFixed(1)}m, 도면 배율 ${fit.s.toFixed(3)}).`);
        return;
    }
    if (ref.sector) {
        dxfOverlay.crsId = null;
        sel.selectedIndex = -1;
        setOverlayStatus('<b>이 도면은 시트(도곽) 좌표로 그려져 있어 좌표계로는 지도에 맞지 않습니다.</b> 도로 중심선(CA-ALGN-CNTL 등)을 찾지 못하거나 구간 선과 모양이 달라 위치를 맞출 수 없습니다.');
        return;
    }
    dxfOverlay.crsId = null;
    sel.selectedIndex = -1;
    setOverlayStatus(lineBased
        ? '<b>이 도면이 지도의 어느 좌표계와도 맞지 않습니다.</b> 도면의 선형이 선택한 구간 선과 가장 가까운 좌표계에서도 150m 넘게 떨어집니다. 도면이 측량 좌표가 아닌 시트·임의 좌표로 그려졌거나, 다른 구간의 도면일 수 있습니다. 좌표계를 직접 골라 확인해 보세요.'
        : '<b>좌표계를 자동으로 찾지 못했습니다.</b> 도면 좌표가 지금 보는 위치 근처로 변환되는 좌표계가 없습니다. 도면이 측량 좌표가 아닌 임의 좌표(0,0 근처)로 그려졌거나 좌표 단위가 m가 아닐 수 있습니다. 아래에서 좌표계를 직접 골라 확인해 보세요.');
}

function stopDxfOverlay() {
    if (dxfOverlay.layer) { map.removeLayer(dxfOverlay.layer); dxfOverlay.layer = null; }
    dxfOverlay.image = null;
    dxfOverlay.sheetFit = null; dxfOverlay.sheetFitSaved = null; dxfOverlay.focusExtent = null;
    document.getElementById('cad-overlay-panel').style.display = 'none';
}

function initDxfOverlayControls() {
    const btn = document.getElementById('cad-overlay-btn');
    if (!btn) return; // 지도가 없는 화면(도면 팝업)
    btn.addEventListener('click', startDxfOverlay);
    document.getElementById('cad-overlay-close').addEventListener('click', stopDxfOverlay);
    document.getElementById('cad-overlay-crs').addEventListener('change', (e) => {
        if (e.target.value === 'SHEET' && dxfOverlay.sheetFitSaved) {
            dxfOverlay.crsId = 'EPSG:5186';
            dxfOverlay.sheetFit = dxfOverlay.sheetFitSaved;
            applyOverlayLayer();
            overlayZoomToDrawing();
            setOverlayStatus('시트 좌표 자동 맞춤으로 되돌렸습니다.');
            return;
        }
        dxfOverlay.sheetFit = null;
        dxfOverlay.crsId = e.target.value;
        applyOverlayLayer();
        overlayZoomToDrawing();
        const c = OVERLAY_CRS_LIST.find((x) => x.id === dxfOverlay.crsId);
        setOverlayStatus(`좌표계를 <b>${escapeHtml(c ? c.label : '')}</b>(으)로 바꿨습니다.`);
    });
    document.getElementById('cad-overlay-opacity').addEventListener('input', (e) => {
        dxfOverlay.opacity = Number(e.target.value) / 100;
        if (dxfOverlay.layer) dxfOverlay.layer.setOpacity(dxfOverlay.opacity);
    });
    const nudge = () => {
        dxfOverlay.dx = parseFloat(document.getElementById('cad-overlay-dx').value) || 0;
        dxfOverlay.dy = parseFloat(document.getElementById('cad-overlay-dy').value) || 0;
        applyOverlayLayer();
    };
    document.getElementById('cad-overlay-dx').addEventListener('change', nudge);
    document.getElementById('cad-overlay-dy').addEventListener('change', nudge);
    document.getElementById('cad-overlay-fit').addEventListener('click', overlayZoomToDrawing);
    // 레이어 목록에서 켜고 끈 것을 반영해 다시 그리기
    // 지도에 얹은 도면만 지운다(패널·좌표계 설정은 그대로 두어 "다시 그리기"로 바로 다시 얹을 수 있다)
    document.getElementById('cad-overlay-clear').addEventListener('click', () => {
        if (!dxfOverlay.layer) { setOverlayStatus('지도에 얹은 도면이 없습니다.'); return; }
        map.removeLayer(dxfOverlay.layer);
        dxfOverlay.layer = null;
        setOverlayStatus('지도에 얹은 도면을 지웠습니다. 다시 보려면 "다시 그리기"를 누르세요.');
    });
    document.getElementById('cad-overlay-redraw').addEventListener('click', () => {
        if (dxfOverlay.layer) dxfOverlay.layer.getSource().changed(); // 켜고 끈 레이어 반영
        else if (dxfOverlay.image && dxfOverlay.crsId) { applyOverlayLayer(); setOverlayStatus('도면을 다시 얹었습니다.'); }
        else startDxfOverlay();
    });
}
