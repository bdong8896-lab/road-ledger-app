// 도로대장 시스템 — 프론트엔드
// 지도 엔진 패턴은 DS-LandInfo(resources/app/public/script.js)의 구조를 참고해
// 필요한 부분만(기본/위성 전환, 연속지적도 WFS, 필지 클릭 식별, 주소 검색) 재구현했다.

let VWORLD_KEY = '';
let currentUser = null;
let registeredPnuSet = new Set();

// ---------- VWorld 프록시 헬퍼 (모든 VWorld 요청은 우리 서버를 거친다) ----------
function vworldProxyUrl(targetUrl) {
    return '/api/vworld?url=' + encodeURIComponent(targetUrl);
}
async function vworldFetchJson(targetUrl) {
    const res = await fetch(vworldProxyUrl(targetUrl));
    return res.json();
}

// 경계/노선 WFS 페이지네이션(makeBoundaryLayer)이 도입되면서, 시군 하나가
// 보이는 정도로 축소했을 때 겹치는 타일 여러 개가 각자 페이지 요청을
// 동시다발로 쏟아내 431(Request Header Fields Too Large)/연결 끊김이 실제로
// 재현됐다(2026-09-04). 요청 자체는 정상인데 순간적으로 너무 많이 몰려서
// 나던 문제라, 동시 진행 개수를 전역으로 제한하는 간단한 큐로 눌러준다 —
// 이 큐를 거치는 모든 WFS 페이지 요청(경계 레이어 전체)에 공통 적용된다.
// 국가교통정보도(도로) 타일을 256px로 잘게 쪼갠 뒤(2000개 상한 회피) 타일 수가
// 16배 늘어 전체 로딩이 느려졌다 — 재시도를 이제 개별 페이지 단위로 짧게
// 제한했으니(무한 재시도로 폭주하던 예전과 다름) 동시 진행 개수를 2->4로 살짝
// 올려서 체감 로딩 속도를 개선한다.
let activeBoundaryFetches = 0;
const MAX_CONCURRENT_BOUNDARY_FETCHES = 4;
const boundaryFetchQueue = [];
function scheduleBoundaryFetch(fn) {
    return new Promise((resolve, reject) => {
        const run = () => {
            activeBoundaryFetches++;
            fn().then(resolve, reject).finally(() => {
                activeBoundaryFetches--;
                const next = boundaryFetchQueue.shift();
                if (next) next();
            });
        };
        if (activeBoundaryFetches < MAX_CONCURRENT_BOUNDARY_FETCHES) run();
        else boundaryFetchQueue.push(run);
    });
}

// ---------- 로그인 ----------
document.getElementById('login-submit').addEventListener('click', doLogin);
document.getElementById('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    errEl.style.color = '';
    errEl.textContent = '';

    if (!username || !password) {
        errEl.textContent = '아이디와 비밀번호를 입력하세요.';
        return;
    }

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        const data = await res.json();
        if (!res.ok) {
            errEl.textContent = data.error || '로그인에 실패했습니다.';
            return;
        }
        currentUser = data.user;
        // 관리자가 재설정해준 임시 비밀번호로 들어온 경우 — 새 비밀번호로 바꿔야만 앱이 열린다
        // (서버도 그 전까지 다른 API를 막는다).
        if (currentUser.mustChangePassword) {
            openPasswordModal({ forced: true, onDone: () => { currentUser.mustChangePassword = false; enterApp(); } });
            return;
        }
        await enterApp();
    } catch (err) {
        errEl.textContent = '서버에 연결할 수 없습니다.';
    }
}

async function enterApp() {
    document.getElementById('login-overlay').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    loadMapFooter();
    await initApp();
}

// ---------- 화면 테마(어둡게/밝게) ----------
// 기본은 어두운 테마. 해/달 버튼(.theme-toggle — 로그인 화면·상단 바)으로 바꾸고 브라우저에
// 기억한다. 첫 화면 깜빡임 방지용 적용은 index.html/cad-popup.html <head>의 인라인 스크립트가 한다.
function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function applyTheme(theme) {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('rl-theme', theme); } catch (e) { /* 저장 못 해도 이번 화면에는 적용됨 */ }
    syncThemeButtons();
}

function syncThemeButtons() {
    const light = currentTheme() === 'light';
    document.querySelectorAll('.theme-toggle').forEach((b) => {
        b.innerHTML = light ? '<i class="fa-solid fa-moon"></i>' : '<i class="fa-solid fa-sun"></i>';
        b.title = light ? '어두운 화면으로 전환' : '밝은 화면으로 전환';
        b.setAttribute('aria-label', b.title);
    });
}

document.querySelectorAll('.theme-toggle').forEach((b) => {
    b.addEventListener('click', () => applyTheme(currentTheme() === 'light' ? 'dark' : 'light'));
});
syncThemeButtons();

// ---------- 비밀번호 변경 ----------
let pwModalOnDone = null;
let pwModalForced = false;

function openPasswordModal({ forced = false, onDone = null } = {}) {
    pwModalForced = forced;
    pwModalOnDone = onDone;
    ['pw-current', 'pw-new', 'pw-new2'].forEach((id) => { document.getElementById(id).value = ''; });
    document.getElementById('pw-error').textContent = '';
    document.getElementById('pw-notice').textContent = forced
        ? '관리자가 재설정한 임시 비밀번호입니다. 새 비밀번호로 변경해야 사용할 수 있습니다.'
        : '변경하면 다른 기기에서 로그인된 세션은 모두 해제됩니다.';
    document.getElementById('pw-cancel').textContent = forced ? '로그아웃' : '취소';
    document.getElementById('pw-modal').classList.add('open');
    document.getElementById('pw-current').focus();
}

document.getElementById('pw-change-btn').addEventListener('click', () => openPasswordModal());
document.getElementById('pw-cancel').addEventListener('click', async () => {
    if (pwModalForced) {
        await fetch('/api/auth/logout', { method: 'POST' });
        location.reload();
        return;
    }
    document.getElementById('pw-modal').classList.remove('open');
});
document.getElementById('pw-submit').addEventListener('click', submitPasswordChange);
document.getElementById('pw-new2').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPasswordChange(); });

async function submitPasswordChange() {
    const errEl = document.getElementById('pw-error');
    errEl.textContent = '';
    const currentPassword = document.getElementById('pw-current').value;
    const newPassword = document.getElementById('pw-new').value;
    const newPassword2 = document.getElementById('pw-new2').value;
    if (!currentPassword || !newPassword) { errEl.textContent = '현재 비밀번호와 새 비밀번호를 입력하세요.'; return; }
    if (newPassword.length < 8) { errEl.textContent = '새 비밀번호는 8자 이상이어야 합니다.'; return; }
    if (newPassword !== newPassword2) { errEl.textContent = '새 비밀번호 확인이 일치하지 않습니다.'; return; }
    const btn = document.getElementById('pw-submit');
    btn.disabled = true;
    try {
        const res = await fetch('/api/auth/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, newPassword }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { errEl.textContent = data.error || '비밀번호 변경에 실패했습니다.'; return; }
        document.getElementById('pw-modal').classList.remove('open');
        ['pw-current', 'pw-new', 'pw-new2'].forEach((id) => { document.getElementById(id).value = ''; });
        if (!pwModalForced) uiAlert('비밀번호가 변경되었습니다.');
        if (pwModalOnDone) pwModalOnDone();
    } catch (e) {
        errEl.textContent = '서버에 연결할 수 없습니다.';
    } finally {
        btn.disabled = false;
    }
}

// ---------- 회원가입(신청) — 로그인 화면 ----------
// 관리자가 계정관리에서 승인하기 전까지는 로그인할 수 없다(서버 /api/auth/signup 참고).
let selectedSignupSigungu = null;

function showSignupForm(show) {
    document.getElementById('login-form').style.display = show ? 'none' : '';
    document.getElementById('signup-form').style.display = show ? '' : 'none';
    document.getElementById('signup-error').textContent = '';
    document.getElementById('login-error').textContent = '';
}

(function initSignup() {
    document.getElementById('show-signup-btn').addEventListener('click', () => showSignupForm(true));
    document.getElementById('show-login-btn').addEventListener('click', () => showSignupForm(false));
    document.getElementById('signup-submit').addEventListener('click', doSignup);
    attachSigunguAutocomplete(
        document.getElementById('signup-sigungu'),
        document.getElementById('signup-sigungu-suggest'),
        (picked) => { selectedSignupSigungu = picked; }
    );
})();

// 시군구 검색 자동완성 — 계정관리 "새 계정"(initAccountSigunguSearch)과 로그인 화면
// 회원가입이 같이 쓴다(서버도 같은 /api/auth/sigungu-search 하나). onSelect는 목록에서
// 고르면 {code5, sgg, full}, 다시 타이핑해서 선택이 무효가 되면 null을 받는다.
function attachSigunguAutocomplete(input, suggestEl, onSelect) {
    let debounceTimer = null;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    input.addEventListener('input', () => {
        onSelect(null);
        const q = input.value.trim();
        clearTimeout(debounceTimer);
        if (!q) { suggestEl.hidden = true; suggestEl.innerHTML = ''; return; }
        debounceTimer = setTimeout(async () => {
            try {
                const { items } = await fetch('/api/auth/sigungu-search?q=' + encodeURIComponent(q)).then((r) => r.json());
                suggestEl.innerHTML = items.length
                    ? items.map((it) => `<div class="sg-opt" data-code="${escapeHtml(it.code5)}" data-sgg="${escapeHtml(it.sgg)}" data-full="${escapeHtml(it.full)}">${escapeHtml(it.full)}</div>`).join('')
                    : '<div class="sg-empty">일치하는 시군구가 없습니다.</div>';
                suggestEl.hidden = false;
            } catch (e) { suggestEl.hidden = true; }
        }, 200);
    });
    suggestEl.addEventListener('click', (e) => {
        const opt = e.target.closest('.sg-opt');
        if (!opt) return;
        onSelect({ code5: opt.dataset.code, sgg: opt.dataset.sgg, full: opt.dataset.full });
        input.value = opt.dataset.full;
        suggestEl.hidden = true;
    });
    document.addEventListener('click', (e) => {
        if (e.target !== input && !suggestEl.contains(e.target)) suggestEl.hidden = true;
    });
}

async function doSignup() {
    const errEl = document.getElementById('signup-error');
    errEl.className = '';
    errEl.textContent = '';
    const username = document.getElementById('signup-username').value.trim();
    const password = document.getElementById('signup-password').value;
    const password2 = document.getElementById('signup-password2').value;
    const displayName = document.getElementById('signup-name').value.trim();

    if (!username || !password || !displayName) { errEl.textContent = '모든 항목을 입력하세요.'; return; }
    if (password.length < 8) { errEl.textContent = '비밀번호는 8자 이상으로 입력하세요.'; return; }
    if (password !== password2) { errEl.textContent = '비밀번호 확인이 일치하지 않습니다.'; return; }
    if (!selectedSignupSigungu) { errEl.textContent = '소속 시군구를 검색해서 목록에서 선택하세요.'; return; }
    const consentEl = document.getElementById('signup-consent');
    if (!consentEl.checked) { errEl.textContent = '개인정보 수집·이용에 동의해야 가입 신청을 할 수 있습니다.'; return; }

    const btn = document.getElementById('signup-submit');
    btn.disabled = true;
    try {
        const res = await fetch('/api/auth/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, displayName, sigunguCode: selectedSignupSigungu.code5, privacyConsent: true }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { errEl.textContent = data.error || '가입 신청에 실패했습니다.'; return; }
        ['signup-username', 'signup-password', 'signup-password2', 'signup-name', 'signup-sigungu']
            .forEach((id) => { document.getElementById(id).value = ''; });
        selectedSignupSigungu = null;
        consentEl.checked = false;
        showSignupForm(false);
        const loginErr = document.getElementById('login-error');
        loginErr.style.color = 'var(--success)';
        loginErr.textContent = '가입 신청이 접수되었습니다. 관리자 승인 후 로그인할 수 있습니다.';
        setTimeout(() => { loginErr.style.color = ''; }, 8000);
    } catch (e) {
        errEl.textContent = '서버에 연결할 수 없습니다.';
    } finally {
        btn.disabled = false;
    }
}

document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.reload();
});

// ---------- 앱 초기화 ----------
let map, base, satellite, kakaoBase, kakaoSat, kakaoSatLabels, wfsSource, wfsLayer, clickHighlightLayer;
let cctvLayer, siggLayer, emdLayer, myRegionEmdLayer, riLayer, roadNetLayer, routeHighlightLayer, zoningAreaLayer, roadCenterlineLayer, buildingLayer;
let sectionFacilityLayer;
// 지도에서 클릭으로 고른 500m 섹터(road_sectors) 강조선 — routeHighlightLayer
// (노선/구간 전체 강조)와 별개 레이어. selectedSector는 { sect, sect_st, sect_ed }.
let sectorHighlightLayer;
let selectedSector = null;
let facilityJumpLayer; // 부속시설 첨부파일을 클릭해 위치로 이동할 때 잠깐 강조하는 전용 레이어
let measureLayer, measureDrawInteraction;
let measureTooltips = []; // 완료된 측정마다 지도 위에 남는 라벨(오버레이) 목록 — "지우기" 전까지 유지
let routeBlinkTimer = null; // 데이터보기에서 노선을 선택하면 지도 위 강조선이 깜빡이도록 하는 타이머
let routeBlinkTimeout = null; // 깜빡임을 5초 후 자동으로 멈추는 타이머
let cadastralLineVisible = false; // 지적선 체크박스 기본값: 꺼짐(투명)
// 지도에 표시할 시설물 종류 라벨 집합. 기본은 전부 숨김(빈 집합) — 도로대장
// 트리의 "구간 전체 시설물" 눈 아이콘이나 시설물 패널의 종류별 눈 아이콘으로
// 켠 종류만 여기 들어간다(구간과 무관하게 종류 단위로 유지되는 필터).
let visibleFacilityLabels = new Set();

// 국가교통정보도(도로, lt_l_moctlink)를 도로등급(road_rank 101~107)별로 켜고
// 끌 수 있게 하는 필터 — 기본은 전부 켜짐(기존 동작과 동일). 알려진 7개
// 코드(101~107) 외의 값은 전부 'ETC'(기타/미분류) 하나로 묶는다.
const ROAD_NET_KNOWN_RANKS = ['101', '102', '103', '104', '105', '106', '107'];
let visibleRoadRanks = new Set([...ROAD_NET_KNOWN_RANKS, 'ETC']);
function roadNetRankBucket(feature) {
    const rank = feature.get('road_rank');
    return ROAD_NET_KNOWN_RANKS.includes(rank) ? rank : 'ETC';
}
// 등급별 도로 선 색상 — index.html 기본 레이어 패널의 .layer-toggle-swatch
// 인라인 색상과 반드시 같은 값으로 맞춰야 한다(색상표 역할을 하는 스와치라
// 지도 선 색과 달라지면 범례가 거짓말을 하게 됨).
const ROAD_RANK_COLORS = {
    101: '#e63946', 102: '#f3722c', 103: '#f2b705', 104: '#43aa8b',
    105: '#577590', 106: '#277da1', 107: '#9d4edd', ETC: '#8d99ae',
};
function roadNetRankColor(feature) {
    return ROAD_RANK_COLORS[roadNetRankBucket(feature)];
}
// 부속시설 호버 팝업이 도로를 피해야 하는지 판단할 때(initFacilityHoverPopup)와
// 도로 호버 팝업이 실제로 뜨는 조건(initRoadNetHoverPopup)이 서로 다른 hitTolerance를
// 쓰면, 두 값 사이 틈에서 "도로 위인데 시설물이 새어나오는" 간헐적 깜빡임이
// 생긴다(측구/석축처럼 도로 바로 옆에 나란히 있는 선형 시설물이 도로 판정보다
// 먼저/따로 걸릴 때 특히 그랬다). 반드시 같은 값을 써야 한다.
const ROAD_HOVER_HIT_TOLERANCE = 8;

// 로그인한 계정이 특정 시군구 소속이면, 그 지역 범위(EPSG:3857)로 지도를 기본
// 줌해준다. 예전엔 이 좌표를 여기(프론트엔드 코드)에 시군구마다 하나씩
// 손으로 추가해야 했는데(의왕시/강화군을 빠뜨려서 자동 줌이 안 됐던 문제로
// 확인됨), 이제 로그인 응답에 서버가 직접 계산해서 넣어주는
// currentUser.sigunguExtent를 그대로 쓴다(server/routes/auth.js의
// findSigunguExtent, VWorld 행정경계를 전국 격자로 미리 훑어 만든
// lib/sigunguExtents.json 기준) — 새 계정을 만들어도 코드를 더 이상 안
// 고쳐도 된다. 그 시군구가 이 표에 아직 없으면 null이라 그냥 예전처럼
// 전국 화면에서 시작한다(동작이 깨지는 게 아님).

// VWorld 경계/노선 WFS 레이어 공통 생성 헬퍼 (시군/읍면동/리경계, 국가교통정보도(도로)용).
// strokeColor는 고정 색(문자열) 또는 feature별 색을 돌려주는 함수 둘 다 받는다
// (국가교통정보도(도로)는 등급별로 색이 달라야 해서 함수로 넘긴다).
function makeBoundaryLayer(typeName, labelField, strokeColor, options = {}) {
    const { defaultVisible = false, minZoom, minLabelZoom, lineWidth = 2, visibilityFilter, tileSize = 1024 } = options;
    const tileGrid = ol.tilegrid.createXYZ({ tileSize });
    const source = new ol.source.Vector({
        // VWorld WFS는 한 요청에 maxFeatures 1000개까지만 돌려주고(그 이상
        // 요청하면 INVALID_RANGE), startIndex도 1000을 넘기면 똑같이
        // INVALID_RANGE로 거부한다(직접 확인: "STARTINDEX ... 유효한 범위:
        // 1000이하"). 즉 페이지네이션으로 한 bbox에서 받을 수 있는 건
        // 0/1000 두 페이지, 최대 2000개가 절대 상한이고 그 이상은 재시도해도
        // 영원히 안 된다 — 페이지를 더 많이 시도하는 방식으로는 못 늘린다.
        // 그래서 진짜 해법은 "타일 하나가 담당하는 땅 면적을 줄여서 그 안의
        // 도로 개수를 2000 밑으로 떨어뜨리는 것"뿐이다. 국가교통정보도(도로)는
        // 시군 하나가 보이는 낮은 줌까지 그려야 해서(minZoom 13->10) 기본
        // 1024px 타일로는 촘촘한 지역(9.8km 사방 타일에 2000개 이상 실측)에서
        // 계속 잘렸다 — roadNetLayer 생성 시 tileSize를 훨씬 작게(옵션으로)
        // 넘겨서 타일당 면적 자체를 줄인다(아래 roadNetLayer 생성부 참고).
        //
        // ⚠ 페이지를 여러 개(10개) 허용하고 실패 시 removeLoadedExtent로
        // 무한 재시도하게 했던 예전 버전은, 겹치는 타일들이 동시에 각자 여러 번
        // 재시도를 반복하며 요청이 폭주해 VWorld/우리 프록시가 431/연결
        // 끊김을 내는 것까지 실제로 재현됐었다(2026-09-04). 그래서 페이지는
        // 딱 유효 범위만큼(2개)만 시도한다. 다만 재시도를 아예 안 하면(첫 버전)
        // 타일 수가 16배 늘어난 뒤로(256px) 그중 한둘이 순간 네트워크 오류로
        // 실패할 확률도 그만큼 늘어서 도로가 군데군데 끊겨 보이는 원인이
        // 됐다 — "무한 재시도"와 "재시도 전혀 없음"의 중간으로, 이 페이지
        // 하나에 한해서만 짧게 텀을 두고 최대 2번 더 시도한다(다른 타일/페이지
        // 재시도를 유발하지 않으니 폭주로 이어지지 않는다).
        loader: async function (extent, resolution, projection, success) {
            const maxFeatures = 1000;
            const maxPages = 2; // VWorld의 절대 상한(startIndex<=1000)이라 이 이상은 의미 없음
            const maxRetriesPerPage = 2;
            const allFeatures = [];
            for (let page = 0; page < maxPages; page++) {
                let feats = null;
                for (let attempt = 0; attempt <= maxRetriesPerPage; attempt++) {
                    try {
                        const params = {
                            Service: 'WFS', Request: 'GetFeature', Version: '2.0.0',
                            typeName, outputFormat: 'application/json',
                            bbox: extent.join(',') + ',' + projection.getCode(),
                            apiKey: VWORLD_KEY, maxFeatures, startIndex: page * maxFeatures,
                        };
                        const url = 'https://api.vworld.kr/req/wfs?' + new URLSearchParams(params).toString();
                        const data = await scheduleBoundaryFetch(() => vworldFetchJson(url));
                        feats = new ol.format.GeoJSON().readFeatures(data, { featureProjection: projection });
                        break;
                    } catch (e) {
                        if (attempt < maxRetriesPerPage) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
                    }
                }
                if (feats === null) break; // 재시도까지 다 실패하면 이 타일은 지금까지 받은 페이지만 쓰고 멈춘다
                allFeatures.push(...feats);
                if (feats.length < maxFeatures) break;
            }
            source.addFeatures(allFeatures);
            if (success) success(allFeatures);
        },
        strategy: ol.loadingstrategy.tile(tileGrid),
    });
    // 도로 하나(예: "호남고속도로")가 짧은 링크 수백 개로 쪼개져 있어서, 링크마다
    // 라벨을 다 그리면 같은 이름이 화면에 수십~수백 번 겹쳐 찍혀 지저분하고
    // 렌더링도 느려졌다(요청사항). 화면 한 번 그릴 때(prerender~postrender
    // 사이) 이미 그린 이름은 Set에 기록해두고, 같은 이름이 또 나오면 선은
    // 그대로 그리되 글자는 생략한다 — 이름당 화면에 최초 1개만 남는다.
    // 'prerender'는 이 레이어가 매 프레임 다시 그려질 때마다 한 번씩 실행되므로
    // 여기서 Set을 비워야 프레임이 바뀔 때(팬/줌 등) 라벨이 다시 정상적으로 보인다.
    const shownLabelsThisFrame = new Set();
    const layer = new ol.layer.Vector({
        source,
        visible: defaultVisible,
        minZoom,
        style: (feature) => {
            if (visibilityFilter && !visibilityFilter(feature)) return undefined;
            const color = typeof strokeColor === 'function' ? strokeColor(feature) : strokeColor;
            const zoom = map.getView().getZoom();
            let labelText = '';
            if (minLabelZoom == null || zoom >= minLabelZoom) {
                const rawLabel = feature.get(labelField) || '';
                if (rawLabel && !shownLabelsThisFrame.has(rawLabel)) {
                    shownLabelsThisFrame.add(rawLabel);
                    labelText = rawLabel;
                }
            }
            return new ol.style.Style({
                stroke: new ol.style.Stroke({ color, width: lineWidth }),
                fill: new ol.style.Fill({ color: 'rgba(0,0,0,0)' }),
                text: new ol.style.Text({
                    text: labelText,
                    font: 'bold 12px sans-serif',
                    fill: new ol.style.Fill({ color }),
                    stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 }),
                }),
            });
        },
        zIndex: 90,
    });
    layer.on('prerender', () => shownLabelsThisFrame.clear());
    return layer;
}

async function initApp() {
    document.getElementById('user-display-name').textContent = currentUser.displayName || currentUser.username;
    if (currentUser.sigunguName) {
        // 지자체명과 시스템명을 두 줄로(좁은 사이드바에서 한 줄로 쓰면 "시스/템"처럼 중간에 끊겼다)
        document.getElementById('sidebar-title').innerHTML =
            `<img class="app-logo" src="favicon.svg" alt=""><span class="st-text"><span class="st-region">${escapeHtml(currentUser.sigunguName)}</span><span class="st-name">도로대장 시스템</span></span>`;
    }

    const keyRes = await fetch('/api/vworld/key').then((r) => r.json());
    VWORLD_KEY = keyRes.apiKey;

    initMap();
    initMapMeasure();
    initClickPopup();
    initBuildingPopup();
    initFacilityHoverPopup();
    initCctvHoverPopup();
    initRoadNetHoverPopup();
    initSidebarToggle();
    initLayerPanel();
    initRouteFacilitySection();
    initFacilityInfoResizer();
    initRoadviewPanelResizer();
    initLedgerTreeToolbar();
    initAdminMode();
    initBulkRegister();
    initSidebarTabs();
    initSearchCategoryTabs();
    initSplitView();
    initRoadview();
    initLeftSidebar();
    loadLedgerTree();
    loadManagingAgencyList();

    initRoadIssueDraw();
    initRoadIssueModal();
    initIssueDropzone();
    initIssueTreeToolbar();
    loadIssueTree();

    document.getElementById('save-btn').addEventListener('click', saveParcel);
    document.getElementById('analysis-toggle-btn').addEventListener('click', runZoningAnalysis);
}

// 시설물 종류(라벨) 문자열을 해시해서 항상 같은 색을 배정한다 — 22종을
// 일일이 색 지정하지 않고도 서로 구분되게 하기 위함.
function facilityColor(label) {
    let hash = 0;
    for (let i = 0; i < (label || '').length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
    return `hsl(${hash % 360}, 75%, 55%)`;
}

function initMap() {
    base = new ol.layer.Tile({
        source: new ol.source.XYZ({
            tileUrlFunction: (tileCoord) => {
                if (!tileCoord) return undefined;
                const [z, x, y] = tileCoord;
                return vworldProxyUrl(`https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_KEY}/Base/${z}/${y}/${x}.png`);
            },
            maxZoom: 19,
        }),
        visible: true,
    });
    satellite = new ol.layer.Tile({
        source: new ol.source.XYZ({
            tileUrlFunction: (tileCoord) => {
                if (!tileCoord) return undefined;
                const [z, x, y] = tileCoord;
                return vworldProxyUrl(`https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_KEY}/Satellite/${z}/${y}/${x}.jpeg`);
            },
            maxZoom: 19,
        }),
        visible: false,
    });
    kakaoBase = createKakaoBaseLayer();
    kakaoSat = createKakaoSkyviewLayer();
    kakaoSatLabels = createKakaoSkyviewLabelLayer();
    watchBaseMapTiles(base, '브이월드 일반');
    watchBaseMapTiles(satellite, '브이월드 위성');
    watchBaseMapTiles(kakaoBase, '카카오 일반');
    watchBaseMapTiles(kakaoSat, '카카오 위성');

    const wfsTileGrid = ol.tilegrid.createXYZ({ tileSize: 512 });
    wfsSource = new ol.source.Vector({
        loader: function (extent, resolution, projection, success, failure) {
            const params = {
                Service: 'WFS', Request: 'GetFeature', Version: '1.1.0',
                typeName: 'lp_pa_cbnd_bubun', outputFormat: 'application/json',
                bbox: extent.join(',') + ',' + projection.getCode(),
                apiKey: VWORLD_KEY, maxFeatures: 1000,
            };
            vworldFetchJson('https://api.vworld.kr/req/wfs?' + new URLSearchParams(params).toString())
                .then((data) => {
                    const feats = new ol.format.GeoJSON().readFeatures(data, { featureProjection: projection });
                    wfsSource.addFeatures(feats);
                    if (success) success(feats);
                    refreshRegisteredHighlight();
                })
                .catch(() => { wfsSource.removeLoadedExtent(extent); if (failure) failure(); });
        },
        strategy: ol.loadingstrategy.tile(wfsTileGrid),
    });

    wfsLayer = new ol.layer.Vector({
        source: wfsSource,
        minZoom: 15,
        properties: { isWFS: true },
        style: (feature) => {
            const zoom = map.getView().getZoom();
            const isSat = baseType === 'satellite';
            const pnu = feature.get('pnu');
            const isRegistered = pnu && registeredPnuSet.has(pnu);
            // 지적선 레이어는 항상 로드/표시 상태를 유지한다(등록 필지 초록색 강조,
            // 필지 클릭 보조 등은 지적선 on/off와 무관하게 계속 동작해야 하므로).
            // "지적선" 체크박스는 오직 경계선·라벨의 색상만 투명 ↔ 실제 색상으로 바꾼다.
            const strokeColor = cadastralLineVisible
                ? (isSat ? 'rgba(255,255,255,1)' : 'rgba(0,0,0,1)')
                : 'rgba(0,0,0,0)';
            const labelText = cadastralLineVisible && zoom >= 17 ? (feature.get('jibun') || '') : '';
            return new ol.style.Style({
                stroke: new ol.style.Stroke({ color: strokeColor, width: 0.6 }),
                fill: new ol.style.Fill({
                    color: isRegistered ? 'rgba(46,174,96,0.35)' : 'rgba(0,0,0,0.01)',
                }),
                text: new ol.style.Text({
                    text: labelText,
                    font: 'bold 13px sans-serif',
                    fill: new ol.style.Fill({ color: isSat ? '#ffffff' : '#222222' }),
                    stroke: new ol.style.Stroke({ color: isSat ? '#000000' : '#ffffff', width: 2 }),
                    overflow: true,
                }),
            });
        },
        zIndex: 100,
    });

    clickHighlightLayer = new ol.layer.Vector({
        source: new ol.source.Vector(),
        style: new ol.style.Style({
            stroke: new ol.style.Stroke({ color: '#ff3b30', width: 3 }),
            fill: new ol.style.Fill({ color: 'rgba(255,59,48,0.15)' }),
        }),
        zIndex: 200,
    });

    routeHighlightLayer = new ol.layer.Vector({
        source: new ol.source.Vector(),
        style: new ol.style.Style({
            stroke: new ol.style.Stroke({ color: '#ffcc00', width: 4 }),
            fill: new ol.style.Fill({ color: 'rgba(255,204,0,0.25)' }),
        }),
        zIndex: 150,
    });

    sectorHighlightLayer = new ol.layer.Vector({
        source: new ol.source.Vector(),
        style: new ol.style.Style({
            stroke: new ol.style.Stroke({ color: '#00e5ff', width: 6 }),
        }),
        zIndex: 160,
    });

    facilityJumpLayer = new ol.layer.Vector({
        source: new ol.source.Vector(),
        style: new ol.style.Style({
            image: new ol.style.Circle({
                radius: 12,
                fill: new ol.style.Fill({ color: 'rgba(255,59,48,0.35)' }),
                stroke: new ol.style.Stroke({ color: '#ff3b30', width: 3 }),
            }),
            stroke: new ol.style.Stroke({ color: '#ff3b30', width: 4 }),
            fill: new ol.style.Fill({ color: 'rgba(255,59,48,0.2)' }),
        }),
        zIndex: 250,
    });

    // CCTV: 데이터 연동 전이라 빈 레이어. 나중에 features만 채우면 바로 표시된다.
    cctvLayer = new ol.layer.Vector({
        source: new ol.source.Vector(),
        visible: false,
        style: new ol.style.Style({
            image: new ol.style.Circle({
                radius: 6,
                fill: new ol.style.Fill({ color: '#ff3b30' }),
                stroke: new ol.style.Stroke({ color: '#ffffff', width: 1.5 }),
            }),
        }),
        zIndex: 110,
    });

    // 선택한 구간의 부속시설(표지/가로등/교량 등 22종) 개별 지오메트리.
    // 시설물 종류(라벨)마다 색을 고정 배정(해시 기반)해서 서로 구분되게 표시한다.
    sectionFacilityLayer = new ol.layer.Vector({
        source: new ol.source.Vector(),
        style: (feature) => {
            const label = feature.get('label');
            if (!visibleFacilityLabels.has(label)) return undefined;
            // 종류(라벨) 필터를 통과해도, 이 피처가 속한 구간이 그 그룹(주요시설물/
            // 부대시설)을 따로 꺼뒀으면(구간별 아이콘) 숨긴다 — facilityLabelGroupMap/
            // sectionFacilityHiddenGroups 정의는 아래쪽(FACILITY_GROUPS 근처) 참고.
            const group = facilityLabelGroupMap.get(label);
            if (group && sectionFacilityHiddenGroups.has(facilityGroupKey(feature.get('sectionRdid'), group))) return undefined;
            const color = facilityColor(feature.get('label'));
            const type = feature.getGeometry().getType();
            if (type === 'Point' || type === 'MultiPoint') {
                return new ol.style.Style({
                    image: new ol.style.Circle({
                        radius: 5,
                        fill: new ol.style.Fill({ color }),
                        stroke: new ol.style.Stroke({ color: '#ffffff', width: 1.2 }),
                    }),
                });
            }
            if (type === 'Polygon' || type === 'MultiPolygon') {
                return new ol.style.Style({
                    stroke: new ol.style.Stroke({ color, width: 2 }),
                    fill: new ol.style.Fill({ color: color.replace('hsl', 'hsla').replace(')', ',0.25)') }),
                });
            }
            return new ol.style.Style({ stroke: new ol.style.Stroke({ color, width: 3 }) });
        },
        zIndex: 170,
    });

    siggLayer = makeBoundaryLayer('lt_c_adsigg', 'sig_kor_nm', '#ff9500');
    // 읍면동 경계는 시군구 필터를 걸지 않는다 — 로그인 시 기본으로 그 지역이
    // 보이는 건 아래 initMap 끝의 zoom-to-region(지도를 그 범위로 맞추는 것)
    // 만으로 이미 충분하고(화면 밖 타일은 애초에 안 불러옴), 레이어 자체에
    // 필터를 걸면 사용자가 다른 지역으로 이동해도 읍면동이 영영 안 보이게
    // 묶여버린다 — 기본레이어 패널의 다른 경계 레이어들처럼 독립적으로
    // 동작해야 한다(어디로 이동하든 그 자리의 읍면동을 보여줌).
    emdLayer = makeBoundaryLayer('lt_c_ademd', 'emd_kor_nm', '#5ac8fa');
    // 관할 읍면동 강조 — 기본레이어의 읍면동 경계(emdLayer, 체크박스로 켜고
    // 끄는 일반 레이어)와는 완전히 별개의 레이어다. 로그인 계정의 관할
    // 시군구만 다른 색으로 걸러서 토글 없이 항상 켜둔다 — "지금 보고 있는
    // 게 내 관할이다"를 계속 보여주는 용도라 emdLayer를 껐다 켰다 해도 이건
    // 영향받지 않는다. 관할이 없는(전체) 계정은 필터를 통과하는 피처가 없어
    // 사실상 아무것도 안 그린다.
    // emd_cd(법정동코드) 앞 4자리로 매칭한다(5자리 전체가 아니라) — 화성시처럼
    // 특례시가 되면서 행정구로 쪼개진 지역은 VWorld에 "41590" 하나가 아니라
    // 구별로 41591/41593/41595/41597 네 개 코드로 나뉘어 있어서, 관할 코드
    // 그대로(5자리) 비교하면 하나도 안 걸린다 — 앞 4자리("4159")까지만
    // 맞으면 그 시의 구 전부를 포함하게 되고, 장성군처럼 안 쪼개진 지역도
    // "12840"이 "1284"로 시작하니 그대로 잘 맞는다.
    myRegionEmdLayer = makeBoundaryLayer('lt_c_ademd', 'emd_kor_nm', '#ff2d55', {
        defaultVisible: true,
        lineWidth: 3,
        visibilityFilter: (feature) =>
            !!currentUser.sigunguCode &&
            String(feature.get('emd_cd') || '').startsWith(currentUser.sigunguCode.slice(0, 4)),
    });
    riLayer = makeBoundaryLayer('lt_c_adri', 'li_kor_nm', '#af52de');
    // 국가교통정보도(도로)(국가표준노드링크) — 예전엔 기본값 on이었으나, 초기
    // 구동 시 지도가 복잡해 보인다는 의견으로 기본값 off로 변경(사용자가 필요할
    // 때 레이어 패널에서 직접 켜는 방식). visibilityFilter로 도로등급(road_rank)별 개별 on/off를 지원한다(기본 레이어
    // 패널의 펼침 하위 체크박스, initLayerPanel 참고). lt_l_moctlink 자체엔
    // 시군구 코드 속성이 없어서(도로는 여러 시군을 가로지르므로) 행정경계처럼
    // 속성으로 거를 수 없다 — 대신 로그인 계정의 관할 범위(currentUser.sigunguExtent,
    // 아래 zoom-to-region과 같은 값)와 겹치는 도로만 그린다. 관할이 없는
    // 계정(전체 관리자)은 예전처럼 전국이 다 보인다.
    // minZoom: 예전엔 13이라 시군 하나를 한눈에 보는 정도의 축소 상태에서 이미
    // 레이어가 사라졌다 — 장성군 전체 경계(lt_c_adsigg)를 지도에 딱 맞게
    // fit()했을 때 실측 zoom이 11.36이 나와서(2026-09-04 확인), 그보다 살짝
    // 낮은 10을 기준으로 삼아 시군 하나를 보는 정도까지는 계속 보이게 했다.
    roadNetLayer = makeBoundaryLayer('lt_l_moctlink', 'road_name', roadNetRankColor, {
        minZoom: 10, minLabelZoom: 15, lineWidth: 2.5,
        // 시군 하나가 보이는 줌까지 그려야 해서 기본 1024px 타일(넓은 지역)로는
        // 촘촘한 곳에서 2000개 상한에 걸려 계속 잘렸다 — 256px로 훨씬 잘게
        // 쪼개 타일 하나당 도로 개수를 상한 밑으로 낮춘다(makeBoundaryLayer
        // 주석 참고). 타일이 많아져 요청 수는 늘지만 전역 동시 요청 제한
        // (scheduleBoundaryFetch)이 폭주를 막아준다.
        tileSize: 256,
        visibilityFilter: (feature) => {
            if (!visibleRoadRanks.has(roadNetRankBucket(feature))) return false;
            const sigunguExtent = currentUser.sigunguExtent;
            if (sigunguExtent && !ol.extent.intersects(sigunguExtent, feature.getGeometry().getExtent())) return false;
            return true;
        },
    });

    zoningAreaLayer = makeZoningLayer();

    // 도로중심선(국토지리정보원 연속수치지형도, lt_l_n3a0020000) — lt_l_moctlink(국가교통정보도)와
    // 달리 도로등급 속성 없이 순수 형태(중심선)만 있는 참고용 배경 자료. 소로/보행로까지
    // 포함돼 촘촘해서(실측 확인: 폭 1.5m대 좁은 길도 나옴) roadNetLayer와 같은 이유로
    // 256px 타일 + minZoom 10을 그대로 적용한다.
    roadCenterlineLayer = makeBoundaryLayer('lt_l_n3a0020000', 'rdnm', '#8b6f47', {
        minZoom: 10, lineWidth: 1.5, tileSize: 256,
    });

    buildingLayer = makeBuildingLayer();

    roadviewGuideLayer = createRoadviewGuideLayer();
    cadastralEditLayer = createCadastralEditLayer();

    issueVectorLayer = new ol.layer.Vector({
        source: new ol.source.Vector(),
        style: issueFeatureStyle,
        zIndex: 160,
    });

    // 지도 위 면적/거리/반경 재기용 스케치 레이어
    measureLayer = new ol.layer.Vector({
        source: new ol.source.Vector(),
        style: (feature) => {
            const styles = [
                new ol.style.Style({
                    stroke: new ol.style.Stroke({ color: '#00e5ff', width: 2, lineDash: [8, 6] }),
                    fill: new ol.style.Fill({ color: 'rgba(0,229,255,0.15)' }),
                }),
            ];
            if (feature.getGeometry().getType() === 'Point') {
                styles.push(new ol.style.Style({
                    image: new ol.style.Circle({ radius: 4, fill: new ol.style.Fill({ color: '#00e5ff' }) }),
                }));
            }
            return styles;
        },
        zIndex: 260,
    });

    map = new ol.Map({
        target: 'map',
        layers: [base, satellite, kakaoBase, kakaoSat, kakaoSatLabels, cadastralEditLayer, wfsLayer, zoningAreaLayer, buildingLayer, siggLayer, emdLayer, myRegionEmdLayer, riLayer, roadNetLayer, roadCenterlineLayer, cctvLayer, clickHighlightLayer, routeHighlightLayer, sectorHighlightLayer, sectionFacilityLayer, facilityJumpLayer, measureLayer, roadviewGuideLayer, issueVectorLayer],
        view: new ol.View({ center: ol.proj.fromLonLat([127.5, 36.0]), zoom: 7, minZoom: 6, maxZoom: 21 }),
        // OpenLayers 기본 확대/축소 컨트롤(좌상단 흰 배경 +/- 버튼)은 이미 있는
        // 커스텀 좌측 툴바(#left-toolbar)와 중복이라 끈다.
        controls: ol.control.defaults.defaults({ zoom: false, rotate: false }),
    });

    restoreBaseMapChoice(); // 저장된 배경지도(제공처·종류) 복원 — 처음이면 브이월드 일반
    map.on('moveend', () => { wfsLayer.changed(); refreshRegisteredHighlight(); refreshCctvMarkers(); });
    map.on('singleclick', onMapClick);
    window.addEventListener('resize', () => map.updateSize());

    // 로그인 계정의 관할 시군구 범위(currentUser.sigunguExtent, 서버가 로그인
    // 응답에 넣어줌)를 알고 있으면 지도를 그 범위로 맞춘다. 관할 읍면동
    // (myRegionEmdLayer)은 이미 항상 켜져 있으니 여기선 줌만 해주면 된다.
    if (currentUser.sigunguExtent) {
        map.getView().fit(currentUser.sigunguExtent, { padding: [40, 40, 40, 40], maxZoom: 13 });
    }

    map.getView().on('change:resolution', updateMapScale);
    updateMapScale();
}

// ---------- 지도 면적/거리/반경 재기 ----------
function formatMeasureDistance(lengthM) {
    return lengthM > 1000 ? `${(lengthM / 1000).toFixed(2)} km` : `${Math.round(lengthM)} m`;
}
function formatMeasureArea(areaM2) {
    return areaM2 > 1e6 ? `${(areaM2 / 1e6).toFixed(2)} km²` : `${Math.round(areaM2).toLocaleString()} m²`;
}
// Circle 지오메트리의 반경은 지도 투영좌표(EPSG:3857) 단위라 실제 지상거리와 다를 수
// 있어, 중심→둘레점 선분을 만들어 ol.sphere.getLength로 측지선 거리를 구한다.
function measureCircleRadiusM(circleGeom) {
    const center = circleGeom.getCenter();
    const edge = [center[0] + circleGeom.getRadius(), center[1]];
    return ol.sphere.getLength(new ol.geom.LineString([center, edge]));
}

function setActiveMeasureBtn(btnId) {
    document.querySelectorAll('#map-measure-toolbar button').forEach((b) => b.classList.remove('active'));
    if (btnId) document.getElementById(btnId).classList.add('active');
}

function addMeasureTooltip() {
    const el = document.createElement('div');
    el.className = 'measure-tooltip';
    const overlay = new ol.Overlay({
        element: el, offset: [0, -12], positioning: 'bottom-center', stopEvent: false,
    });
    map.addOverlay(overlay);
    measureTooltips.push(overlay);
    return { el, overlay };
}

function startMeasure(type, btnId) {
    if (measureDrawInteraction) map.removeInteraction(measureDrawInteraction);
    setActiveMeasureBtn(btnId);

    const { el, overlay } = addMeasureTooltip();
    measureDrawInteraction = new ol.interaction.Draw({ source: measureLayer.getSource(), type });
    map.addInteraction(measureDrawInteraction);

    let changeKey = null;
    measureDrawInteraction.on('drawstart', (evt) => {
        el.style.display = 'block';
        changeKey = evt.feature.getGeometry().on('change', (e) => {
            const geom = e.target;
            let text, coord;
            if (geom.getType() === 'Polygon') {
                text = formatMeasureArea(ol.sphere.getArea(geom));
                coord = geom.getInteriorPoint().getCoordinates();
            } else if (geom.getType() === 'LineString') {
                text = formatMeasureDistance(ol.sphere.getLength(geom));
                coord = geom.getLastCoordinate();
            } else if (geom.getType() === 'Circle') {
                text = `반경 ${formatMeasureDistance(measureCircleRadiusM(geom))}`;
                coord = geom.getCenter();
            }
            el.textContent = text;
            overlay.setPosition(coord);
        });
    });
    measureDrawInteraction.on('drawend', () => {
        el.classList.add('measure-tooltip-done');
        if (changeKey) ol.Observable.unByKey(changeKey);
        map.removeInteraction(measureDrawInteraction);
        measureDrawInteraction = null;
        setActiveMeasureBtn(null);
    });
}

function clearMeasure() {
    if (measureDrawInteraction) {
        map.removeInteraction(measureDrawInteraction);
        measureDrawInteraction = null;
    }
    measureLayer.getSource().clear();
    measureTooltips.forEach((overlay) => map.removeOverlay(overlay));
    measureTooltips = [];
    setActiveMeasureBtn(null);
}

function initMapMeasure() {
    document.getElementById('measure-dist-btn').addEventListener('click', () => startMeasure('LineString', 'measure-dist-btn'));
    document.getElementById('measure-area-btn').addEventListener('click', () => startMeasure('Polygon', 'measure-area-btn'));
    document.getElementById('measure-radius-btn').addEventListener('click', () => startMeasure('Circle', 'measure-radius-btn'));
    document.getElementById('measure-clear-btn').addEventListener('click', clearMeasure);

    document.getElementById('measure-toolbar-toggle').addEventListener('click', () => {
        const toolbar = document.getElementById('map-measure-toolbar');
        const collapsing = !toolbar.classList.contains('collapsed');
        if (collapsing) clearMeasure(); // 버튼이 숨겨진 채로 그리기가 진행중인 상태가 남지 않도록 접을 때 정리
        toolbar.classList.toggle('collapsed');
    });
}

// 좌측 하단 "축척 1 : N" 표시 — 화면 해상도(1픽셀당 지도 단위)를 실제 축척비로 환산한다.
// OpenLayers 공식 예제(Show Map Scale)와 같은 공식: OGC 표준 화면 해상도(0.28mm/px) 기준.
function updateMapScale() {
    const view = map.getView();
    const resolution = view.getResolution();
    const projection = view.getProjection();
    const dpi = 25.4 / 0.28;
    const mpu = projection.getMetersPerUnit();
    const scale = resolution * mpu * 39.3701 * dpi;
    const el = document.getElementById('map-scale');
    if (!el) return;
    el.textContent = `축척 1 : ${Math.round(scale).toLocaleString()}`;
}

// 배경지도 = 제공처(브이월드/카카오) × 종류(일반/위성). 고른 값은 브라우저별로 기억한다(localStorage 'rl-basemap').
let baseProvider = 'vworld';
let baseType = 'base';
const BASEMAP_KEY = 'rl-basemap';
function applyBaseMap() {
    const sat = baseType === 'satellite';
    const kakao = baseProvider === 'kakao';
    base.setVisible(!kakao && !sat);
    satellite.setVisible(!kakao && sat);
    kakaoBase.setVisible(kakao && !sat);
    kakaoSat.setVisible(kakao && sat);
    kakaoSatLabels.setVisible(kakao && sat);
    document.getElementById('btnBase').classList.toggle('active', !sat);
    document.getElementById('btnSatellite').classList.toggle('active', sat);
    document.getElementById('btnBase').setAttribute('aria-pressed', String(!sat));
    document.getElementById('btnSatellite').setAttribute('aria-pressed', String(sat));
    const prov = document.getElementById('btnProvider');
    if (prov) {
        const name = kakao ? '카카오' : '브이월드';
        const other = kakao ? '브이월드' : '카카오';
        prov.classList.toggle('is-kakao', kakao);
        prov.querySelector('span').textContent = name;
        prov.title = `지도 제공처: ${name} (누르면 ${other}맵으로 바꿉니다)`;
        prov.setAttribute('aria-label', prov.title);
    }
    renderMapFooter();
    hideMapNotice(); // 다른 배경지도로 바꾸면 이전 배경지도의 실패 안내는 닫는다(새 배경지도가 실패하면 다시 뜬다)
    try { localStorage.setItem(BASEMAP_KEY, JSON.stringify({ provider: baseProvider, type: baseType })); } catch (e) { /* 저장 못 해도 이번 화면에는 적용됨 */ }
    wfsLayer.changed();
}
function switchBase(type) {
    baseType = type === 'satellite' ? 'satellite' : 'base';
    applyBaseMap();
}
function switchBaseProvider(provider) {
    baseProvider = provider === 'kakao' ? 'kakao' : 'vworld';
    applyBaseMap();
}
function restoreBaseMapChoice() {
    try {
        const saved = JSON.parse(localStorage.getItem(BASEMAP_KEY) || 'null');
        if (saved) {
            baseProvider = saved.provider === 'kakao' ? 'kakao' : 'vworld';
            baseType = saved.type === 'satellite' ? 'satellite' : 'base';
        }
    } catch (e) { /* 저장값이 없거나 깨졌으면 기본값(브이월드 일반) */ }
    applyBaseMap();
}

// ---------- 등록된 필지 색상 표기 ----------
let highlightRefreshTimer = null;
function refreshRegisteredHighlight() {
    clearTimeout(highlightRefreshTimer);
    highlightRefreshTimer = setTimeout(async () => {
        const pnus = wfsSource.getFeatures().map((f) => f.get('pnu')).filter(Boolean);
        if (pnus.length === 0) return;
        const unique = [...new Set(pnus)];
        // 필지 번호를 GET 주소에 붙여 보내므로, 한 번에 너무 많으면(도심에서 수백 개) 주소가 길어 서버가 431로 거부한다.
        // 150개(약 3KB)씩 나눠 요청하고 합친다. 일부가 실패해도 성공한 것만으로 색을 칠한다.
        const CHUNK = 150;
        const chunks = [];
        for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK));
        const results = await Promise.all(chunks.map((c) => fetch('/api/parcels?pnus=' + c.join(','))
            .then((r) => (r.ok ? r.json() : { pnus: [] })).catch(() => ({ pnus: [] }))));
        registeredPnuSet = new Set(results.flatMap((r) => r.pnus || []));
        wfsLayer.changed();
    }, 300);
}

// ---------- CCTV ----------
let cctvRefreshTimer = null;
function refreshCctvMarkers() {
    if (!cctvLayer.getVisible()) return;
    clearTimeout(cctvRefreshTimer);
    cctvRefreshTimer = setTimeout(async () => {
        const extent = map.getView().calculateExtent(map.getSize());
        const [minX, minY, maxX, maxY] = ol.proj.transformExtent(extent, map.getView().getProjection(), 'EPSG:4326');
        const params = new URLSearchParams({ minX, maxX, minY, maxY });
        const { items } = await fetch('/api/cctv?' + params.toString()).then((r) => r.json());

        const features = (items || [])
            .filter((item) => item.coordx && item.coordy)
            .map((item) => new ol.Feature({
                geometry: new ol.geom.Point(ol.proj.fromLonLat([Number(item.coordx), Number(item.coordy)])),
                name: item.cctvname,
                url: item.cctvurl,
            }));

        cctvLayer.getSource().clear();
        cctvLayer.getSource().addFeatures(features);
    }, 400);
}

let hlsInstance = null;
function openCctvPreview(name, url) {
    if (!isSplitOpen) toggleSplitView();
    document.getElementById('sat_map').style.display = 'none';
    document.getElementById('roadview-wrap').style.display = 'none';
    // display:none만으로는 안 되고 비워야 한다 — 360도 영상이 열려있었다면 그
    // 렌더 루프가 컨테이너의 DOM 이탈(isConnected===false)을 감지해야 멈춘다.
    document.getElementById('file-preview-div').innerHTML = '';

    const cctvDiv = document.getElementById('cctv-preview-div');
    cctvDiv.style.display = 'flex';
    cctvDiv.innerHTML = `
        <div class="cctv-title"><i class="fa-solid fa-video"></i> ${escapeHtml(name || 'CCTV')}</div>
        <video id="cctv-video" controls autoplay muted playsinline></video>
    `;

    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    const video = document.getElementById('cctv-video');

    if (window.Hls && Hls.isSupported()) {
        hlsInstance = new Hls();
        hlsInstance.loadSource(url);
        hlsInstance.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
    } else {
        cctvDiv.innerHTML += '<div style="color:#fff;padding:12px;text-align:center;">이 브라우저에서는 CCTV 스트리밍을 재생할 수 없습니다.</div>';
    }
}

// ---------- 필지 클릭 식별 ----------
async function onMapClick(evt) {
    if (isRoadviewMode) return;
    if (isDrawingIssue || isEditingIssueRoute || issueDrawJustFinished) return; // 노선등록/경로수정 중에는 필지/도로망도 클릭 식별을 하지 않는다

    const cctvFeature = map.forEachFeatureAtPixel(
        evt.pixel,
        (feature) => feature,
        { layerFilter: (layer) => layer === cctvLayer, hitTolerance: 6 }
    );
    if (cctvFeature) {
        openCctvPreview(cctvFeature.get('name'), cctvFeature.get('url'));
        return;
    }

    // 부속시설 마커 클릭 — 첨부파일(사진/보고서)이 있으면 분할화면에 보여준다.
    // 그냥 두면 아래 도로망도 클릭(신규 구간 등록 폼)으로 흘러갈 수 있어 여기서 막는다.
    const facilityFeature = map.forEachFeatureAtPixel(
        evt.pixel,
        (feature) => feature,
        { layerFilter: (layer) => layer === sectionFacilityLayer, hitTolerance: 5 }
    );
    if (facilityFeature) {
        openFacilityMarkerFiles(facilityFeature);
        return;
    }

    // 사용자도로관리(임의 지점/노선/구역) 도형 클릭 → 바로 수정 모달
    const issueFeature = map.forEachFeatureAtPixel(
        evt.pixel,
        (feature) => feature,
        { layerFilter: (layer) => layer === issueVectorLayer, hitTolerance: 6 }
    );
    if (issueFeature && issueFeature.get('issueId') != null) {
        const { record } = await fetch(`/api/road-issues/${issueFeature.get('issueId')}`).then((r) => r.json());
        if (record) {
            setSelectedIssueFeature(issueFeature);
            openRoadIssueModal('edit', record);
        }
        return;
    }

    // 강조된 노선(routeHighlightLayer) 클릭 → 500m 섹터 선택/해제. 500m 데이터가
    // 있는 노선이면 아래 도로망도 클릭(신규 구간 등록)보다 이 동작이 우선한다 —
    // 이미 등록된 노선을 다시 클릭했을 때는 등록 폼이 아니라 섹터 선택이 자연스럽다.
    // 500m 데이터가 없는 노선(sector===null)은 return하지 않고 기존 흐름대로 둔다.
    const routeHitFeature = map.forEachFeatureAtPixel(
        evt.pixel,
        (feature) => feature,
        { layerFilter: (layer) => layer === routeHighlightLayer, hitTolerance: 5 }
    );
    if (routeHitFeature) {
        const sector = nearestRouteSector(evt.coordinate);
        if (sector) {
            const same = selectedSector && selectedSector.sect === sector.sect && selectedSector.sect_st === sector.sect_st;
            same ? clearSectorSelection() : selectSector(sector);
            return;
        }
    }

    // 도로망도(LT_L_MOCTLINK) 선분 클릭 → 신규 구간 등록 폼 (도로 단위 입력의 시작점)
    const roadFeature = map.forEachFeatureAtPixel(
        evt.pixel,
        (feature) => feature,
        { layerFilter: (layer) => layer === roadNetLayer, hitTolerance: 5 }
    );
    if (roadFeature && roadNetLayer.getVisible()) {
        const geojsonFormat = new ol.format.GeoJSON();
        stopRouteHighlightBlink();
        routeHighlightLayer.getSource().clear();
        routeHighlightLayer.getSource().addFeature(roadFeature);
        const geom = geojsonFormat.writeGeometryObject(roadFeature.getGeometry(), {
            featureProjection: map.getView().getProjection(), decimals: 7,
        });
        openNewSectionForm({
            road_rank_name: roadFeature.get('rd_rank_h') || '기타',
            route_name: roadFeature.get('road_name') || '',
            geom,
            link_ids: String(roadFeature.get('link_id') || ''),
        });
        return;
    }

    // 건물 레이어(buildingLayer)가 켜져 있을 때 건물 클릭 → 속성 팝업.
    // 레이어가 꺼져 있으면(minZoom 미만 등으로 안 보이는 상태 포함) 아예 검사하지
    // 않고 지적 클릭으로 넘어간다 — 꺼진 레이어의 피처를 클릭으로 주울 이유가 없다.
    if (buildingLayer.getVisible()) {
        const buildingFeature = map.forEachFeatureAtPixel(
            evt.pixel,
            (feature) => feature,
            { layerFilter: (layer) => layer === buildingLayer, hitTolerance: 3 }
        );
        if (buildingFeature) {
            showBuildingPopup(evt.coordinate, buildingFeature.getProperties());
            return;
        }
    }

    // 지적선 레이어가 꺼져 있으면(투명) 클릭으로 지적을 선택하지 않는다.
    if (!cadastralLineVisible) return;

    const [lon, lat] = ol.proj.toLonLat(evt.coordinate);
    await identifyParcel(lon, lat, evt.coordinate);
}

async function identifyParcel(lon, lat, mapCoordinate) {
    const params = new URLSearchParams({
        service: 'data', request: 'GetFeature', data: 'LP_PA_CBND_BUBUN',
        key: VWORLD_KEY, geomFilter: `POINT(${lon} ${lat})`, crs: 'EPSG:4326', size: '1',
    });
    const result = await vworldFetchJson('https://api.vworld.kr/req/data?' + params.toString());
    const feature = result?.response?.result?.featureCollection?.features?.[0];
    if (!feature) {
        hideClickPopup();
        return false;
    }

    const props = feature.properties;
    const geojsonFormat = new ol.format.GeoJSON();
    const olFeature = geojsonFormat.readFeature(
        { type: 'Feature', geometry: feature.geometry, properties: props },
        { featureProjection: map.getView().getProjection() }
    );
    clickHighlightLayer.getSource().clear();
    clickHighlightLayer.getSource().addFeature(olFeature);

    let popupCoordinate = mapCoordinate;
    if (mapCoordinate) {
        map.getView().animate({ center: mapCoordinate, duration: 300 });
    } else {
        const extent = olFeature.getGeometry().getExtent();
        map.getView().fit(extent, { duration: 400, maxZoom: 19 });
        popupCoordinate = ol.extent.getCenter(extent);
    }

    const parcelGeoJSON = { type: 'Feature', geometry: feature.geometry, properties: props };
    currentPopupParcel = { pnu: props.pnu, addr: props.addr, jibun: props.jibun, geojson: parcelGeoJSON, lonLat: [lon, lat] };

    let area = null;
    try { area = turf.area(parcelGeoJSON); } catch (e) { /* 계산 실패 시 면적 미표시 */ }
    showClickPopup(popupCoordinate, area, props.addr || props.jibun || '주소 정보 없음');
    return true;
}

// ---------- 지도 클릭 팝업 ----------
let clickPopupOverlay = null;
let currentPopupParcel = null;

function initClickPopup() {
    clickPopupOverlay = new ol.Overlay({
        element: document.getElementById('click-popup'),
        positioning: 'bottom-center',
        offset: [0, -12],
        autoPan: { animation: { duration: 250 } },
    });
    map.addOverlay(clickPopupOverlay);

    document.getElementById('popup-close-btn').addEventListener('click', hideClickPopup);
    document.getElementById('popup-analysis-btn').addEventListener('click', () => {
        openAnalysisTab();
        hideClickPopup();
    });
}

// 분석 결과를 팝업이 아니라 우측 [분석] 탭에 표시한다 (좁은 팝업 안에 표/드롭다운을
// 다 넣으면 레이아웃이 망가지는 문제가 있어 별도 탭으로 분리했다)
function openAnalysisTab() {
    if (!currentPopupParcel) return;
    document.getElementById('analysis-empty-msg').style.display = 'none';
    document.getElementById('analysis-panel').style.display = 'block';
    document.getElementById('az-addr').textContent =
        currentPopupParcel.addr || currentPopupParcel.jibun || '-';
    document.getElementById('zoning-analysis-result').style.display = 'none';
    document.getElementById('zoning-analysis-result').innerHTML = '';
    switchSidebarTab('analysisview-tab');
    runZoningAnalysis();
}

function showClickPopup(coordinate, area, addrText) {
    document.getElementById('click-popup-area').textContent =
        area != null ? `면적: ${area.toLocaleString(undefined, { maximumFractionDigits: 2 })} ㎡` : '면적: -';
    document.getElementById('click-popup-addr').textContent = addrText;
    document.getElementById('click-popup').style.display = 'block';
    clickPopupOverlay.setPosition(coordinate);
}

function hideClickPopup() {
    document.getElementById('click-popup').style.display = 'none';
    if (clickPopupOverlay) clickPopupOverlay.setPosition(undefined);
}

// ---------- 건물 레이어 클릭 팝업 ----------
// "분석보기"(필지 클릭 → 건물 종류 선택 → 조회)와 달리, 건물 레이어를 켠 상태에서
// 건물을 바로 클릭하면 그 건물 속성(lt_c_spbd)을 즉시 팝업으로 보여준다.
let buildingPopupOverlay = null;

function initBuildingPopup() {
    buildingPopupOverlay = new ol.Overlay({
        element: document.getElementById('building-popup'),
        positioning: 'bottom-center',
        offset: [0, -12],
        autoPan: { animation: { duration: 250 } },
    });
    map.addOverlay(buildingPopupOverlay);
    document.getElementById('building-popup-close-btn').addEventListener('click', hideBuildingPopup);
}

function showBuildingPopup(coordinate, props) {
    // lt_c_bldginfo엔 주소 필드(rd_nm/buld_no)가 없다 — 건물명, 없으면 동명칭
    // ("주건축물제1동" 등), 그것도 없으면 "건물"로 표시한다.
    document.getElementById('building-popup-title').textContent = props.bld_nm || props.dong_nm || '건물';
    // 실사용자에게 의미 있는 값만: 용도(코드를 건축법 시행령 별표1로 해석),
    // 층수, 면적, 높이, 건폐율/용적률, 사용승인일자. strct_cd(구조)는 공식
    // 코드표를 못 찾아 제외(showBuildingPopup 이전 버전 주석 참고 — buld_se_cd와
    // 같은 이유). pk/bd_mgt_sn/pnu/ufid/geoidn 등 내부 코드류도 제외.
    const rows = [];
    const usabilityLabel = buildingUsabilityLabel(props.usability);
    if (usabilityLabel) rows.push(['용도', usabilityLabel]);
    const gro = Number(props.grnd_flr) || 0;
    const und = Number(props.ugrnd_flr) || 0;
    if (gro || und) rows.push(['층수', `지상 ${gro}층${und ? ` · 지하 ${und}층` : ''}`]);
    if (props.archarea != null) rows.push(['건축면적', `${Number(props.archarea).toLocaleString()} ㎡`]);
    if (props.totalarea != null) rows.push(['연면적', `${Number(props.totalarea).toLocaleString()} ㎡`]);
    if (props.height != null) rows.push(['건물높이', `${props.height} m`]);
    if (props.bc_rat != null) rows.push(['건폐율', `${props.bc_rat} %`]);
    if (props.vl_rat != null) rows.push(['용적률', `${props.vl_rat} %`]);
    if (props.useapr_day) {
        const d = String(props.useapr_day);
        const formatted = d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
        rows.push(['사용승인일자', formatted]);
    }
    document.getElementById('building-popup-grid').innerHTML = rows.length
        ? rows.map(([label, value]) => `<div class="bpg-label">${escapeHtml(label)}</div><div class="bpg-value">${escapeHtml(String(value))}</div>`).join('')
        : '<div class="bpg-value" style="grid-column:1/-1;color:var(--text-muted);">추가 정보 없음</div>';
    document.getElementById('building-popup').style.display = 'block';
    buildingPopupOverlay.setPosition(coordinate);
}

function hideBuildingPopup() {
    document.getElementById('building-popup').style.display = 'none';
    if (buildingPopupOverlay) buildingPopupOverlay.setPosition(undefined);
}

// ---------- 부속시설 호버(마우스오버) 정보창 ----------
// 두 단계로 동작한다: 개별 부속시설(sectionFacilityLayer) 위에서는 그 시설물의
// 종류 이름만, 구간 강조선(routeHighlightLayer, 데이터보기에서 선택한 노선)
// 위에서는 부속시설 개수 그리드를 보여준다. 개수는 재조회하지 않고
// loadRouteFacilityCounts()/loadRouteSectors()가 이미 채워둔
// currentRouteFacilityCounts/currentRouteSectors/currentRouteSectorCounts를
// 재사용한다(cad-viewer.js). 500m 단위 구간(road_sectors)이 있는 노선은 지금
// 마우스가 가리키는 500m만, 없는 노선은 예전처럼 구간 전체 합계를 보여준다.
let facilityHoverOverlay = null;

// point(지도 좌표, EPSG:3857)에서 폴리라인 coords(같은 좌표계)까지의 최단거리
// 제곱값 — "어느 구간이 가장 가까운가"를 비교하는 용도라 sqrt는 생략한다.
function pointToLineDistanceSq(point, coords) {
    let best = Infinity;
    for (let i = 0; i < coords.length - 1; i++) {
        const x1 = coords[i][0], y1 = coords[i][1];
        const x2 = coords[i + 1][0], y2 = coords[i + 1][1];
        const dx = x2 - x1, dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq === 0 ? 0 : ((point[0] - x1) * dx + (point[1] - y1) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const px = x1 + t * dx, py = y1 + t * dy;
        const ddx = point[0] - px, ddy = point[1] - py;
        const d = ddx * ddx + ddy * ddy;
        if (d < best) best = d;
    }
    return best;
}

// currentRouteSectors(cad-viewer.js)는 위경도로 와 있어서 지도 좌표로 바꾼
// 캐시를 만들어둔다 — 마우스오버마다(픽셀당 여러 번) 매번 좌표변환하면 느리다.
// currentRouteSectors 배열 자체가 바뀔 때(새 노선 선택)만 다시 만든다.
let sectorHitCache = [];
let sectorHitCacheSource = null;
function nearestRouteSector(coordinate) {
    if (!currentRouteSectors || !currentRouteSectors.length) return null;
    if (sectorHitCacheSource !== currentRouteSectors) {
        sectorHitCache = currentRouteSectors.map((s) => ({
            sect: s.sect,
            sect_st: Number(s.sect_st),
            sect_ed: Number(s.sect_ed),
            coords3857: (s.geom.coordinates || []).map((c) => ol.proj.fromLonLat(c)),
        }));
        sectorHitCacheSource = currentRouteSectors;
    }
    let best = null;
    let bestDist = Infinity;
    for (const s of sectorHitCache) {
        const d = pointToLineDistanceSq(coordinate, s.coords3857);
        if (d < bestDist) { bestDist = d; best = s; }
    }
    // 너무 멀면(다른 노선을 잘못 짚거나 캐시가 갱신 전이면) 안 씀 — 픽셀 기준
    // hitTolerance(5)보다 넉넉하게 50m로 잡는다(지도 축척에 따라 화면 픽셀
    // 거리와 지도 좌표 거리가 달라지므로 여유를 둔다).
    return bestDist <= 50 * 50 ? best : null;
}

// 지도에서 500m 섹터를 클릭해 선택/해제 — 선택되면 sectorHighlightLayer에
// 그 조각만 강조하고, "도면" 탭(cad-viewer.js buildRouteFileSegmentTable)이
// selectedSector를 읽어 해당 seg_no 행에 선택 효과를 준다.
function selectSector(sector) {
    selectedSector = sector;
    sectorHighlightLayer.getSource().clear();
    sectorHighlightLayer.getSource().addFeature(new ol.Feature({ geometry: new ol.geom.LineString(sector.coords3857) }));
    if (typeof refreshRouteFilePanel === 'function') refreshRouteFilePanel();
}
function clearSectorSelection() {
    selectedSector = null;
    sectorHighlightLayer.getSource().clear();
    if (typeof refreshRouteFilePanel === 'function') refreshRouteFilePanel();
}

function initFacilityHoverPopup() {
    const el = document.getElementById('facility-hover-popup');
    const titleEl = document.getElementById('fhp-title');
    const subtitleEl = document.getElementById('fhp-subtitle');
    const gridEl = document.getElementById('fhp-grid');
    facilityHoverOverlay = new ol.Overlay({
        element: el,
        positioning: 'bottom-left',
        offset: [12, -12],
        stopEvent: false,
    });
    map.addOverlay(facilityHoverOverlay);

    map.on('pointermove', (evt) => {
        // 로드뷰 중이라도 "시설물 선택" 서브모드에서는 지도 클릭이 시설물
        // 선택 용도라 이름표 호버가 오히려 필요한데, 예전엔 로드뷰 중엔
        // 무조건 숨겼었다(시설물 위에 마우스를 올려도 제목이 안 보이던 원인).
        if (evt.dragging || (isRoadviewMode && !isFacilitySelectMode)) { el.style.display = 'none'; return; }

        // 국가교통정보도(도로) 위에서는 도로 속성 팝업(roadnet-hover-popup)을
        // 우선한다 — 개별 시설물 마커든 구간 강조선(전체 개수 그리드)이든
        // 이 지점에 도로 선이 있으면 부속시설 팝업은 띄우지 않는다(반대로
        // 부속시설을 우선했다가 요청으로 순서를 바꿈).
        const roadHit = map.forEachFeatureAtPixel(
            evt.pixel,
            (f) => f,
            { layerFilter: (layer) => layer === roadNetLayer, hitTolerance: ROAD_HOVER_HIT_TOLERANCE }
        );
        if (roadHit && roadNetLayer.getVisible()) { el.style.display = 'none'; return; }

        const facilityFeature = map.forEachFeatureAtPixel(
            evt.pixel,
            (f) => f,
            { layerFilter: (layer) => layer === sectionFacilityLayer, hitTolerance: 5 }
        );
        if (facilityFeature) {
            const fLabel = facilityFeature.get('label') || '시설물';
            const fName = facilityFeature.get('name');
            el.className = 'mode-single';
            titleEl.textContent = fName ? `${fName}(${fLabel})` : fLabel;
            el.style.display = 'block';
            facilityHoverOverlay.setPosition(evt.coordinate);
            return;
        }

        const routeFeature = map.forEachFeatureAtPixel(
            evt.pixel,
            (f) => f,
            { layerFilter: (layer) => layer === routeHighlightLayer, hitTolerance: 5 }
        );
        if (routeFeature) {
            const sector = nearestRouteSector(evt.coordinate);
            el.className = 'mode-grid';
            const routeName = currentRoute ? (currentRoute.route_name || '') : '';
            // sector.sect가 있으면(500m 섹터 데이터가 있는 노선) 지금 가리키는 그
            // 500m가 실제로 속한 구간번호를 보여준다 — currentRoute.sect는 호선
            // 전체보기일 때 비어있거나 다른 구간일 수 있어 sector.sect를 우선한다.
            titleEl.textContent = sector ? `${routeName}(${sector.sect}구간)` : routeName;
            let counts = currentRouteFacilityCounts;
            if (sector) {
                subtitleEl.textContent = `${sector.sect_st.toFixed(2)}~${sector.sect_ed.toFixed(2)}km 구간 시설 수`;
                counts = currentRouteSectorCounts[sector.sect_st.toFixed(1)] || {};
            } else {
                subtitleEl.textContent = '시설물 개수';
            }
            gridEl.innerHTML = ROAD_FACILITY_TYPES
                .map((name) => `<div class="fhp-item"><span>${escapeHtml(name)}</span><span>${Number(counts[name] || 0).toLocaleString()}</span></div>`)
                .join('');
            el.style.display = 'block';
            facilityHoverOverlay.setPosition(evt.coordinate);
            return;
        }

        el.style.display = 'none';
    });
}

// ---------- CCTV 마우스오버 정보창 ----------
let cctvHoverOverlay = null;

function initCctvHoverPopup() {
    const el = document.getElementById('cctv-hover-popup');
    cctvHoverOverlay = new ol.Overlay({
        element: el,
        positioning: 'bottom-center',
        offset: [0, -10],
        stopEvent: false,
    });
    map.addOverlay(cctvHoverOverlay);

    map.on('pointermove', (evt) => {
        if (evt.dragging || isRoadviewMode) { el.style.display = 'none'; return; }

        const feature = map.forEachFeatureAtPixel(
            evt.pixel,
            (f) => f,
            { layerFilter: (layer) => layer === cctvLayer, hitTolerance: 6 }
        );
        if (feature && cctvLayer.getVisible()) {
            document.getElementById('cctv-hp-name').textContent = feature.get('name') || 'CCTV';
            el.style.display = 'block';
            cctvHoverOverlay.setPosition(evt.coordinate);
        } else {
            el.style.display = 'none';
        }
    });
}

// ---------- 국가교통정보도(도로) 호버(마우스오버) 정보창 ----------
// 등급(뱃지, 선 색과 동일)+도로명을 헤더로, 차선수/제한속도/도로유형 등
// 값이 있는 속성만 그리드로 보여준다 — road_no/connect_h/rest_veh_h는
// "없음"에 해당하는 기본값일 땐 정보가 없는 거나 마찬가지라 생략한다.
let roadNetHoverOverlay = null;
function initRoadNetHoverPopup() {
    const el = document.getElementById('roadnet-hover-popup');
    const badgeEl = document.getElementById('rnhp-badge');
    const nameEl = document.getElementById('rnhp-name');
    const gridEl = document.getElementById('rnhp-grid');
    roadNetHoverOverlay = new ol.Overlay({
        element: el,
        positioning: 'bottom-left',
        offset: [12, -12],
        stopEvent: false,
    });
    map.addOverlay(roadNetHoverOverlay);

    map.on('pointermove', (evt) => {
        if (evt.dragging || isRoadviewMode) { el.style.display = 'none'; return; }

        const feature = map.forEachFeatureAtPixel(
            evt.pixel,
            (f) => f,
            { layerFilter: (layer) => layer === roadNetLayer, hitTolerance: ROAD_HOVER_HIT_TOLERANCE }
        );
        if (!feature || !roadNetLayer.getVisible()) { el.style.display = 'none'; return; }

        const roadName = feature.get('road_name');
        nameEl.textContent = (roadName && roadName !== '-') ? roadName : '(이름 없음)';
        badgeEl.textContent = feature.get('rd_rank_h') || '등급 미상';
        el.style.setProperty('--rnhp-accent', roadNetRankColor(feature));

        const items = [];
        if (feature.get('lanes') != null) items.push(['차선수', `${feature.get('lanes')}차로`]);
        if (feature.get('max_spd')) items.push(['제한속도', `${feature.get('max_spd')}km/h`]);
        if (feature.get('rd_type_h')) items.push(['도로유형', feature.get('rd_type_h')]);
        if (feature.get('road_no')) items.push(['도로번호', feature.get('road_no')]);
        if (feature.get('connect_h') && feature.get('connect_h') !== '없음') items.push(['연결로', feature.get('connect_h')]);
        if (feature.get('rest_veh_h') && feature.get('rest_veh_h') !== '모두통행가능') items.push(['통행제한', feature.get('rest_veh_h')]);
        gridEl.innerHTML = items.map(([k, v]) => `<div class="rnhp-item"><span>${escapeHtml(k)}</span><span>${escapeHtml(String(v))}</span></div>`).join('');

        el.style.display = 'block';
        roadNetHoverOverlay.setPosition(evt.coordinate);
    });
}

// ---------- 분석보기 (용도지역/용도지구/건물) ----------
// VWorld 용도지역 관련 레이어 — 도시지역/관리지역/농림지역/자연환경보전지역, 국토계획구역, 농업진흥지역
const ZONING_LAYERS = ['lt_c_uq111', 'lt_c_uq112', 'lt_c_uq113', 'lt_c_uq114', 'lt_c_uq141', 'lt_c_agrixue101'];
// 용도지구 관련 레이어 — 경관/고도/방화/보호/취락/개발진흥지구
const USE_DISTRICT_LAYERS = ['lt_c_uq121', 'lt_c_uq123', 'lt_c_uq124', 'lt_c_uq126', 'lt_c_uq128', 'lt_c_uq129'];
// 건물통합정보
const BUILDING_LAYERS = ['lt_c_spbd'];

const ANALYSIS_TYPES = {
    '용도지역': { layers: ZONING_LAYERS, nameOf: (p) => (p.uname || '').trim() },
    '용도지구': { layers: USE_DISTRICT_LAYERS, nameOf: (p) => (p.uname || '').trim() },
    '건물': {
        // 건물통합정보(lt_c_spbd)만으로는 도형이 빠진 건물이 있어 건축물정보(lt_c_bldginfo)도 같이 조회해 합친다(runZoningAnalysis 참고).
        layers: [...BUILDING_LAYERS, 'lt_c_bldginfo'],
        nameOf: (p) => {
            if (p.buld_nm) return p.buld_nm;
            const addr = [p.rd_nm, p.buld_no].filter(Boolean).join(' ');
            if (addr) return addr;
            // lt_c_bldginfo에는 주소 필드가 없다 — 건물명, 없으면 동명칭, 없으면 용도, 그것도 없으면 "건물"
            return p.bld_nm || p.dong_nm || buildingUsabilityLabel(p.usability) || '건물';
        },
    },
};

const ZONING_COLOR_MAP = [
    { keyword: '제1종전용주거지역', color: '#FFD0D0' }, { keyword: '제2종전용주거지역', color: '#FFB8B8' },
    { keyword: '제1종일반주거지역', color: '#FFAAAA' }, { keyword: '제2종일반주거지역', color: '#FF9090' },
    { keyword: '제3종일반주거지역', color: '#FF7575' }, { keyword: '준주거지역', color: '#FF6060' },
    { keyword: '중심상업지역', color: '#FF4C00' }, { keyword: '일반상업지역', color: '#FF6600' },
    { keyword: '근린상업지역', color: '#FF8800' }, { keyword: '유통상업지역', color: '#FFAA00' },
    { keyword: '전용공업지역', color: '#C8A0D8' }, { keyword: '일반공업지역', color: '#B88CC8' },
    { keyword: '준공업지역', color: '#A878B8' }, { keyword: '보전녹지지역', color: '#A0D8A0' },
    { keyword: '생산녹지지역', color: '#80C880' }, { keyword: '자연녹지지역', color: '#60B860' },
    { keyword: '보전관리지역', color: '#D4E8A0' }, { keyword: '생산관리지역', color: '#C4D890' },
    { keyword: '계획관리지역', color: '#B4C880' }, { keyword: '농림지역', color: '#A8C878' },
    { keyword: '자연환경보전지역', color: '#88B858' }, { keyword: '농업진흥', color: '#F8C8A0' },
    { keyword: '국토계획', color: '#D0D8F0' },
];
function zoningColor(name) {
    const entry = ZONING_COLOR_MAP.find((e) => name.includes(e.keyword));
    return entry ? entry.color : '#cccccc';
}

// 용도지역 색칠 레이어 — "분석보기"(필지 하나 클릭했을 때만 결과를 보여줌)와
// 달리, 지도를 훑어보며 전체 용도지역 분포를 항상 볼 수 있게 색칠된 면으로
// 보여준다. ZONING_LAYERS(용도지역, 6개 WFS 타입)만 쓰고 USE_DISTRICT_LAYERS
// (용도지구)는 포함하지 않는다(요청사항: "용도지역(지구 제외)"). makeBoundaryLayer는
// 타입 하나만 받는데 이건 6개를 한 레이어로 합쳐야 해서 별도 함수로 뺐다.
function makeZoningLayer() {
    const tileGrid = ol.tilegrid.createXYZ({ tileSize: 1024 });

    async function fetchTypeName(typeName, extent, projection) {
        const maxFeatures = 1000;
        const maxPages = 2; // VWorld의 절대 상한(startIndex<=1000) — makeBoundaryLayer와 동일한 이유
        const maxRetriesPerPage = 2;
        const collected = [];
        for (let page = 0; page < maxPages; page++) {
            let feats = null;
            for (let attempt = 0; attempt <= maxRetriesPerPage; attempt++) {
                try {
                    const params = {
                        Service: 'WFS', Request: 'GetFeature', Version: '2.0.0',
                        typeName, outputFormat: 'application/json',
                        bbox: extent.join(',') + ',' + projection.getCode(),
                        apiKey: VWORLD_KEY, maxFeatures, startIndex: page * maxFeatures,
                    };
                    const url = 'https://api.vworld.kr/req/wfs?' + new URLSearchParams(params).toString();
                    const data = await scheduleBoundaryFetch(() => vworldFetchJson(url));
                    feats = new ol.format.GeoJSON().readFeatures(data, { featureProjection: projection });
                    break;
                } catch (e) {
                    if (attempt < maxRetriesPerPage) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
                }
            }
            if (feats === null) break;
            collected.push(...feats);
            if (feats.length < maxFeatures) break;
        }
        return collected;
    }

    const source = new ol.source.Vector({
        // 6개 타입을 병렬로 요청(각각은 scheduleBoundaryFetch가 전역 동시요청
        // 제한을 걸어주므로 병렬로 보내도 폭주로 이어지지 않는다).
        loader: async function (extent, resolution, projection, success) {
            const results = await Promise.all(ZONING_LAYERS.map((t) => fetchTypeName(t, extent, projection)));
            source.addFeatures(results.flat());
            if (success) success();
        },
        strategy: ol.loadingstrategy.tile(tileGrid),
    });

    return new ol.layer.Vector({
        source,
        visible: false,
        minZoom: 11, // 용도지역 폴리곤은 넓은 지역을 덮어서, 너무 축소된 상태에선 안 그림(전국 단위 과다 로드 방지)
        style: (feature) => {
            const name = (feature.get('uname') || '').trim();
            const color = zoningColor(name);
            return new ol.style.Style({
                stroke: new ol.style.Stroke({ color, width: 1 }),
                fill: new ol.style.Fill({ color: color + '66' }), // 약 40% 투명도
            });
        },
        zIndex: 80, // 경계/도로망(zIndex 90) 아래에 깔려서 선/라벨이 위에 보이게
    });
}

// 건물 클릭 팝업용 레이어. 처음엔 BUILDING_LAYERS(lt_c_spbd, "분석보기"가 쓰는
// 것과 같은 데이터)를 그대로 썼는데, 그건 층수 말고는 쓸만한 속성이 없어서
// lt_c_bldginfo(건축물정보 — 면적/높이/용도/건폐율/용적률/사용승인일자 등 훨씬
// 풍부함)로 교체했다. 대신 lt_c_bldginfo엔 주소(rd_nm/buld_no) 필드가 없어서
// 팝업 제목은 건물명/동명칭 기준으로 바뀐다(showBuildingPopup 참고). "분석보기"
// 쪽 BUILDING_LAYERS(lt_c_spbd)는 이 변경과 무관하게 그대로 둔다 — 별개 기능.
//
// 지도 위에 건물 외곽을 항상 표시하는 참고용 레이어. 타입이 하나뿐이라
// makeZoningLayer처럼 여러 개를 합칠 필요는 없지만, 건물은 폴리곤을 채워 그려야
// 해서(makeBoundaryLayer는 선만 그림, 채우기 없음) 별도 함수로 뺐다. 건물은
// 도심에서 극도로 촘촘하므로(도로보다 훨씬 밀도가 높음) minZoom을 높게(16, 건물이
// 개별로 구분되는 정도의 확대) 잡고 타일도 256px로 잘게 쪼갠다.
const BUILDING_INFO_LAYER = 'lt_c_bldginfo';

// 건축법 시행령 [별표 1] 용도별 건축물의 종류(제3조의5 관련) — 법적으로 고정된
// 분류라 VWorld 버전이 바뀌어도 잘 안 바뀐다. lt_c_bldginfo의 usability 필드
// 앞 2자리가 이 번호와 대응한다(예: "01000" → 01 → 단독주택). 23의2(국방·군사시설)는
// 문자가 섞여 코드화하기 애매해서 실제 데이터에서 본 적 없어 생략.
const BUILDING_USABILITY_MAP = {
    '01': '단독주택', '02': '공동주택', '03': '제1종 근린생활시설', '04': '제2종 근린생활시설',
    '05': '문화 및 집회시설', '06': '종교시설', '07': '판매시설', '08': '운수시설',
    '09': '의료시설', '10': '교육연구시설', '11': '노유자시설', '12': '수련시설',
    '13': '운동시설', '14': '업무시설', '15': '숙박시설', '16': '위락시설',
    '17': '공장', '18': '창고시설', '19': '위험물 저장 및 처리 시설', '20': '자동차 관련 시설',
    '21': '동물 및 식물 관련 시설', '22': '자원순환 관련 시설', '23': '교정시설',
    '24': '방송통신시설', '25': '발전시설', '26': '묘지 관련 시설', '27': '관광 휴게시설',
    '28': '장례시설', '29': '야영장 시설',
};
function buildingUsabilityLabel(code) {
    if (!code) return null;
    const key = String(code).slice(0, 2);
    return BUILDING_USABILITY_MAP[key] || null;
}

function makeBuildingLayer() {
    const typeName = BUILDING_INFO_LAYER;
    // lt_c_bldginfo는 같은 건물을 두 번 내려준다: 정상 레코드(건물명/면적/용도 등)와,
    // ufid가 'NN'인 빈 레코드(속성 없음, 도형이 몇 m 어긋남). 둘이 겹쳐 그려지고 클릭 결과도
    // 위치마다 달라지므로, 같은 필지(pnu)에 정상 레코드가 있으면 빈 레코드는 그리지 않는다.
    // 정상 레코드가 없는 필지의 빈 레코드는 유일한 건물이라 그대로 보여준다.
    // 필지가 타일 경계에 걸리면 두 레코드가 다른 타일에서 올 수 있어 style에서 판정한다.
    const pnusWithRealRecord = new Set();
    let layer = null;
    const tileGrid = ol.tilegrid.createXYZ({ tileSize: 256 });
    const source = new ol.source.Vector({
        loader: async function (extent, resolution, projection, success) {
            const maxFeatures = 1000;
            const maxPages = 2;
            const maxRetriesPerPage = 2;
            const allFeatures = [];
            for (let page = 0; page < maxPages; page++) {
                let feats = null;
                for (let attempt = 0; attempt <= maxRetriesPerPage; attempt++) {
                    try {
                        const params = {
                            Service: 'WFS', Request: 'GetFeature', Version: '2.0.0',
                            typeName, outputFormat: 'application/json',
                            bbox: extent.join(',') + ',' + projection.getCode(),
                            apiKey: VWORLD_KEY, maxFeatures, startIndex: page * maxFeatures,
                        };
                        const url = 'https://api.vworld.kr/req/wfs?' + new URLSearchParams(params).toString();
                        const data = await scheduleBoundaryFetch(() => vworldFetchJson(url));
                        feats = new ol.format.GeoJSON().readFeatures(data, { featureProjection: projection });
                        break;
                    } catch (e) {
                        if (attempt < maxRetriesPerPage) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
                    }
                }
                if (feats === null) break;
                allFeatures.push(...feats);
                if (feats.length < maxFeatures) break;
            }
            allFeatures.forEach((f) => { if (f.get('ufid') !== 'NN') pnusWithRealRecord.add(f.get('pnu')); });
            source.addFeatures(allFeatures);
            if (layer) layer.changed();
            if (success) success(allFeatures);
        },
        strategy: ol.loadingstrategy.tile(tileGrid),
    });
    const buildingStyle = new ol.style.Style({
        stroke: new ol.style.Stroke({ color: '#5a5a5a', width: 1 }),
        fill: new ol.style.Fill({ color: 'rgba(120,120,120,0.45)' }),
    });
    layer = new ol.layer.Vector({
        source,
        visible: false,
        minZoom: 16,
        style: (feature) => (feature.get('ufid') === 'NN' && pnusWithRealRecord.has(feature.get('pnu')) ? null : buildingStyle),
        zIndex: 85, // 용도지역(80) 위, 경계/도로망(90) 아래
    });
    return layer;
}

// 필지와 겹치는 부분을 구한다. turf.intersect는 VWorld 도형이 조금만 꼬여 있어도(자기교차 등) 예외를 던지는데, 예전에는 그걸 삼키고 그 결과를 "정보 없음"으로
// 버려서 건물이 있는데도 없다고 나왔다. 실패하면 도형을 정리(buffer 0)해서 한 번 더 시도하고, 그래도 안 되면 "겹침 여부만" 확인해 면적 없이 포함시킨다.
function parcelOverlap(parcelFeature, zoneFeature) {
    const tries = [
        () => turf.intersect(parcelFeature, zoneFeature),
        () => turf.intersect(turf.buffer(parcelFeature, 0), turf.buffer(zoneFeature, 0)),
    ];
    for (const t of tries) {
        try {
            const r = t();
            return { ok: true, area: r ? turf.area(r) : 0 };
        } catch (e) { /* 다음 방법 */ }
    }
    try { return { ok: true, area: null, overlaps: turf.booleanIntersects(parcelFeature, zoneFeature) }; } catch (e) { /* noop */ }
    return { ok: false };
}

// 필지 전체를 덮는 사각형(BOX)으로 조회한다. 예전에는 "클릭한 점" 하나로만 조회해서, 건물이 필지 안에 있어도 클릭한 곳이 건물 밖이면 없다고 나왔고
// 필지가 용도지역 둘에 걸쳐도 클릭한 쪽만 나왔다. 사각형으로 가져온 뒤 필지와 실제로 겹치는 것만 남긴다(parcelOverlap).
async function fetchZoneFeatures(layer, parcelFeature) {
    const [minX, minY, maxX, maxY] = turf.bbox(parcelFeature);
    const out = [];
    let failed = false;
    for (let page = 1; page <= 3; page++) {
        const params = new URLSearchParams({
            service: 'data', request: 'GetFeature', data: layer, key: VWORLD_KEY,
            geomFilter: `BOX(${minX},${minY},${maxX},${maxY})`, size: '1000', page: String(page), crs: 'EPSG:4326',
        });
        let res;
        try { res = await vworldFetchJson('https://api.vworld.kr/req/data?' + params.toString()); } catch (e) { failed = true; break; }
        const status = res?.response?.status;
        if (status === 'NOT_FOUND') break;                    // 이 범위에 해당 레이어 자료가 없음(정상)
        if (status !== 'OK') { failed = true; break; }        // ERROR 등 — "없음"과 구분해서 알려준다
        const feats = res.response.result?.featureCollection?.features || [];
        out.push(...feats);
        const totalPages = parseInt(res.response.page?.total, 10) || 1;
        if (page >= totalPages) break;
    }
    return { feats: out, failed };
}

async function runZoningAnalysis() {
    if (!currentPopupParcel) return;
    const analysisType = document.getElementById('analysis-type-select').value;
    const config = ANALYSIS_TYPES[analysisType] || ANALYSIS_TYPES['용도지역'];

    const resultEl = document.getElementById('zoning-analysis-result');
    resultEl.style.display = 'block';
    resultEl.innerHTML = '<div class="za-empty">분석 중...</div>';

    const parcelFeature = currentPopupParcel.geojson;
    const responses = await Promise.all(config.layers.map((layer) => fetchZoneFeatures(layer, parcelFeature)));
    const failedLayers = responses.filter((r) => r.failed).length;

    const zones = [];
    responses.forEach((res) => {
        res.feats.forEach((f) => {
            const name = config.nameOf(f.properties || {});
            if (name) zones.push({ name, props: f.properties || {}, geojson: { type: 'Feature', geometry: f.geometry, properties: f.properties } });
        });
    });

    let parcelArea = null;
    try { parcelArea = turf.area(parcelFeature); } catch (e) { /* noop */ }

    let unmeasured = 0;
    let rows = [];
    zones.forEach((z) => {
        const o = parcelOverlap(parcelFeature, z.geojson);
        if (!o.ok) { unmeasured++; return; }
        if (o.area === null) { if (o.overlaps) rows.push({ name: z.name, props: z.props, area: null, rate: null, geojson: z.geojson }); return; }
        if (o.area <= 1) return; // 오차로 인한 극소 면적 제외
        rows.push({ name: z.name, props: z.props, area: o.area, rate: parcelArea ? (o.area / parcelArea) * 100 : null, geojson: z.geojson });
    });

    // 건물: 건물통합정보와 건축물정보가 같은 건물을 각각 내려주므로 겹치는 것은 하나로 합치고(이름이 있는 쪽을 남김),
    // 건축물정보의 속성 없는 빈 레코드(ufid NN)는 같은 자리에 정상 레코드가 있으면 버린다.
    if (analysisType === '건물') {
        const kept = [];
        rows.sort((x, y) => (y.props.ufid !== 'NN' ? 1 : 0) - (x.props.ufid !== 'NN' ? 1 : 0) || (y.area || 0) - (x.area || 0));
        rows.forEach((r) => {
            const dup = kept.some((k) => {
                const o = parcelOverlap(k.geojson, r.geojson);
                const small = Math.min(k.area || Infinity, r.area || Infinity);
                return o.ok && o.area != null && isFinite(small) && o.area >= small * 0.5;
            });
            if (!dup) kept.push(r);
        });
        rows = kept;
    }
    rows.sort((x, y) => (y.area || 0) - (x.area || 0));

    if (rows.length === 0) {
        // 조회에 실패한 것과 정말 없는 것을 구분해서 알려준다 — 예전에는 둘 다 "찾을 수 없습니다"로 나왔다.
        const note = failedLayers
            ? `<div class="za-empty">${escapeHtml(analysisType)} 정보를 불러오지 못했습니다(VWorld 응답 오류 ${failedLayers}건). 잠시 후 다시 시도하세요.</div>`
            : unmeasured
                ? `<div class="za-empty">${escapeHtml(analysisType)} 도형 ${unmeasured}건은 계산하지 못했습니다. 지도에서 직접 확인하세요.</div>`
                : `<div class="za-empty">이 필지에서 ${escapeHtml(analysisType)} 정보를 찾을 수 없습니다.</div>`;
        resultEl.innerHTML = note;
        return;
    }

    const totalText = parcelArea != null
        ? `${escapeHtml(analysisType)} 분석: ${parcelArea.toLocaleString(undefined, { maximumFractionDigits: 2 })} ㎡`
        : `${escapeHtml(analysisType)} 분석`;

    resultEl.innerHTML = `
        <div class="za-total">${totalText}</div>
        <table>
            <thead><tr><th>번호</th><th>색상</th><th>내용</th></tr></thead>
            <tbody>
                ${rows.map((r, i) => `
                    <tr>
                        <td>${String(i + 1).padStart(2, '0')}</td>
                        <td><span class="za-swatch" style="background:${zoningColor(r.name)};"></span></td>
                        <td>${escapeHtml(r.name)} (면적:${r.area != null ? r.area.toLocaleString(undefined, { maximumFractionDigits: 2 }) + '㎡' : '계산 불가'}, ${r.rate != null ? r.rate.toFixed(2) : '-'}%)</td>
                    </tr>`).join('')}
            </tbody>
        </table>
        ${failedLayers ? `<div class="za-empty">일부 자료(${failedLayers}건)는 불러오지 못해 빠졌을 수 있습니다.</div>` : ''}
    `;
}

// ---------- 도로대장 폼 (노선/구간 단위) ----------
const FIELD_IDS = [
    'route_no', 'route_name', 'sect', 'mco_name', 's_point', 'e_point',
    'length_m', 'width_m', 'lane_count', 'pavement_type', 'pavement_material',
    'has_sidewalk', 'has_drainage', 'completion_date', 'remarks',
];

let currentSectionRdid = null;   // 기존 구간을 편집 중이면 RDID, 신규 등록 중이면 null
let pendingSectionDraft = null;  // 신규 등록 중일 때 도로망도 클릭에서 가져온 정보

// ---------- 사용자도로관리 (공식 도로망도 밖의 임의 노선을 그려 업무 이력 등록) ----------
const ISSUE_CATEGORIES = ['도로구조(점용 등) 현황', '도로 보수 현황', '시설물 보수 현황'];
const ISSUE_STATUSES = ['공사중', '준공완료', '민원제기', '소송', '행정명령', '기타'];

let issueVectorLayer = null;         // initMap()에서 생성(레이어 자체는 지도 구성 순서상 위에 둠)
let isDrawingIssue = false;
let issueDrawGeomType = null;        // 'Point' | 'LineString' | 'Polygon' — 현재(또는 마지막) 그리기 유형
// 그리기를 완료시킨 바로 그 클릭이 지도의 singleclick 핸들러(onMapClick)에도
// 뒤이어 전달돼(OL이 더블클릭 여부를 가리기 위해 singleclick을 약간 지연 발생시킴)
// isDrawingIssue가 이미 false로 리셋된 뒤 필지 식별 등이 실행되는 문제가 있었다.
// drawend 직후 잠시 이 플래그를 켜 두어 그 뒤이은 클릭도 확실히 막는다.
let issueDrawJustFinished = false;
let isEditingIssueRoute = false;     // 경로수정(Modify) 진행 중 — 이 동안도 다른 지도 클릭을 막는다
let issueDrawInteraction = null;
let issueModifyInteraction = null;
let issueModifyFeature = null;       // 경로수정 중인 피처(ol.interaction.Modify엔 getFeatures()가 없어 직접 들고 있는다)
let issueModalMode = null;           // 'create' | 'edit'
let currentIssueId = null;           // 편집 중인 항목의 id, 신규면 null
let pendingIssueGeom = null;         // 신규 등록 중 방금 그린 geom
let pendingIssueFiles = [];          // 신규 등록 중 저장 전에 임시로 들고 있는 첨부파일(저장 성공 후 업로드)
let pendingIssuePreviewFeature = null; // 신규 등록 모달이 열려있는 동안 지도에 보여주는 미리보기 도형(취소 시 제거)

// 관리자 모드가 아니면 정보 탭 입력 필드를 편집할 수 없게 막는다 — 저장 버튼은
// 이미 CSS로 숨겨져 있지만(body.admin-mode #save-btn), 필드 자체는 계속
// 입력 가능한 상태였다. 실제 저장(POST/PUT)도 서버에서 requireAdmin으로
// 막혀 있으니(server/routes/sections.js) 이건 UI 일관성을 위한 것.
function applySectionFormEditability() {
    const isAdmin = document.body.classList.contains('admin-mode');
    // 편집 모드가 아니면 입력 양식이 아니라 "읽기 전용 정보"로 보이게 한다 — 안내 문구
    // ("예: 001", "번지 단위까지 입력")·"선택"·날짜칸의 "연도-월-일"이 그대로 보여서 값이
    // 빈 건지 입력하라는 건지 헷갈렸다. 빈 값은 "—"로 표시(CSS: #parcel-form.is-readonly).
    document.getElementById('parcel-form').classList.toggle('is-readonly', !isAdmin);
    FIELD_IDS.forEach((f) => {
        const el = document.getElementById('in-' + f);
        if (!el) return;
        el.disabled = !isAdmin;
        if (el.tagName === 'SELECT') {
            const emptyOpt = el.querySelector('option[value=""]');
            if (emptyOpt) emptyOpt.textContent = isAdmin ? '선택' : '—';
        } else {
            if (el.dataset.ph === undefined) el.dataset.ph = el.getAttribute('placeholder') || '';
            el.placeholder = isAdmin ? el.dataset.ph : '—';
            if (f === 'completion_date') el.type = isAdmin ? 'date' : 'text'; // 값(YYYY-MM-DD)은 그대로 유지됨
        }
    });
    const rankSelect = document.getElementById('road-rank-select');
    if (rankSelect) rankSelect.disabled = !isAdmin;
}

function fillSectionForm(record) {
    FIELD_IDS.forEach((f) => {
        const el = document.getElementById('in-' + f);
        const v = record ? record[f] : null;
        if (el.tagName === 'SELECT' && (f === 'has_sidewalk' || f === 'has_drainage')) {
            el.value = v === true ? 'true' : v === false ? 'false' : '';
        } else if (f === 'completion_date' && v) {
            el.value = String(v).slice(0, 10);
        } else {
            el.value = v ?? '';
        }
    });
}

// 기존 구간(rdid)을 정보 탭에 불러온다 — 데이터보기 트리에서 구간 클릭 시 호출
async function loadSectionPanel(rdid) {
    currentSectionRdid = rdid;
    pendingSectionDraft = null;
    document.getElementById('parcel-empty-msg').style.display = 'none';
    document.getElementById('parcel-form').style.display = 'block';
    document.getElementById('save-status').textContent = '';

    const { record } = await fetch(`/api/sections/${rdid}`).then((r) => r.json());
    document.getElementById('f-rdid').textContent = rdid;
    document.getElementById('f-road-rank').textContent = record?.road_rank_name || '-';
    document.getElementById('f-road-rank').style.display = '';
    document.getElementById('road-rank-select').style.display = 'none';
    document.getElementById('road-rank-hint').style.display = 'none';
    fillSectionForm(record);
    applySectionFormEditability();

    refreshRouteFilePanel();
}

// 도로망도 선분을 새로 클릭해 신규 구간 등록 폼을 연다
function openNewSectionForm(draft) {
    currentSectionRdid = null;
    pendingSectionDraft = draft; // { road_rank_name, route_name, geom, link_ids }
    document.getElementById('parcel-empty-msg').style.display = 'none';
    document.getElementById('parcel-form').style.display = 'block';
    document.getElementById('save-status').textContent = '신규 구간 — 저장하면 등록됩니다.';
    document.getElementById('f-rdid').textContent = '(신규 등록)';

    const rankTextEl = document.getElementById('f-road-rank');
    const rankSelectEl = document.getElementById('road-rank-select');
    const rankHintEl = document.getElementById('road-rank-hint');
    if (ROAD_GRADES.includes(draft.road_rank_name)) {
        rankTextEl.textContent = draft.road_rank_name;
        rankTextEl.style.display = '';
        rankSelectEl.style.display = 'none';
        rankHintEl.style.display = 'none';
    } else {
        // VWorld 도로망도가 "시·군도"처럼 시도/군도를 구분하지 않고 뭉뚱그려
        // 내려주는 경우가 있다 — 표준 코드(03.도로의종류)엔 없는 값이라 그대로
        // 저장할 수 없으므로 사용자가 직접 실제 등급을 선택하게 한다.
        rankSelectEl.innerHTML = '<option value="">선택</option>' + ROAD_GRADES.map((g) => `<option value="${g}">${g}</option>`).join('');
        rankSelectEl.value = '';
        rankTextEl.style.display = 'none';
        rankSelectEl.style.display = '';
        rankHintEl.style.display = 'block';
    }

    fillSectionForm({ route_name: draft.route_name });
    applySectionFormEditability();

    switchSidebarTab('infoview-tab');
    document.getElementById('route-file-list').innerHTML =
        '<div style="color:var(--text-muted);font-size:0.82rem;">저장 후 파일을 첨부할 수 있습니다.</div>';
}

async function saveParcel() {
    if (!currentSectionRdid && !pendingSectionDraft) return;
    const body = {};
    FIELD_IDS.forEach((f) => {
        const el = document.getElementById('in-' + f);
        let v = el.value;
        if (v === '') { body[f] = null; return; }
        if (f === 'has_sidewalk' || f === 'has_drainage') { body[f] = v === 'true'; return; }
        if (f === 'length_m' || f === 'width_m') { body[f] = parseFloat(v); return; }
        if (f === 'lane_count') { body[f] = parseInt(v, 10); return; }
        body[f] = v;
    });
    body.mco_code = mcoCodeByName(body.mco_name);

    const statusEl = document.getElementById('save-status');
    statusEl.textContent = '저장 중...';

    let res;
    if (currentSectionRdid) {
        res = await fetch(`/api/sections/${currentSectionRdid}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
    } else {
        const rankSelectEl = document.getElementById('road-rank-select');
        const usingRankSelect = rankSelectEl.style.display !== 'none';
        const roadRankName = usingRankSelect ? rankSelectEl.value : pendingSectionDraft.road_rank_name;
        if (usingRankSelect && !roadRankName) {
            statusEl.textContent = '도로등급을 선택하세요.';
            return;
        }
        body.road_rank_name = roadRankName;
        body.geom = pendingSectionDraft.geom;
        body.link_ids = pendingSectionDraft.link_ids;
        res = await fetch('/api/sections', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
    }

    if (res.ok) {
        const { record } = await res.json();
        statusEl.textContent = '저장되었습니다.';
        currentSectionRdid = record.rdid;
        pendingSectionDraft = null;
        document.getElementById('f-rdid').textContent = record.rdid;
        document.getElementById('f-road-rank').textContent = record.road_rank_name || '-';
        document.getElementById('f-road-rank').style.display = '';
        document.getElementById('road-rank-select').style.display = 'none';
        document.getElementById('road-rank-hint').style.display = 'none';
        loadLedgerTree();
        refreshRouteFilePanel();
    } else {
        const data = await res.json().catch(() => ({}));
        statusEl.textContent = data.error || '저장 실패';
    }
}

const PREVIEWABLE_IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'];
const PREVIEWABLE_VIDEO_EXT = ['mp4', 'webm', 'ogg', 'ogv', 'mov', 'm4v'];

// 파일명이 "..._360.mp4"처럼 "_360"으로 끝나면 360도(equirectangular) 촬영 영상으로
// 간주한다 — 500m 구간 도면의 파일명 규칙(routeFileNaming.js)과 같은 방식으로,
// 별도 업로드 폼/토글 없이 파일명만으로 구분한다.
function is360Video(originalName) {
    const ext = (originalName.split('.').pop() || '').toLowerCase();
    if (!PREVIEWABLE_VIDEO_EXT.includes(ext)) return false;
    const base = originalName.slice(0, -(ext.length + 1));
    return /_360$/i.test(base);
}
let video360Seq = 0;

// 파일 하나를 그 확장자에 맞는 미리보기 HTML로 바꾼다(이미지=img, PDF=iframe,
// 영상=video, 그 외=다운로드 안내) — openFilePreview(파일 1개를 전체화면으로)와
// openFacilityMarkerFiles(시설물에 첨부파일이 여러 개일 때 전부 쭉 이어서)가
// 이 로직을 그대로 같이 쓴다. sizeStyle로 각자 원하는 크기(인라인 스타일 문자열)를
// 넘긴다 — autoplay는 갤러리처럼 여러 개를 한 화면에 같이 띄울 때 전부 동시
// 재생되면 안 되니 기본 꺼둔다(단일 미리보기에서만 true로 켬).
function buildFilePreviewMediaHtml(originalName, viewUrl, downloadUrl, sizeStyle, autoplay) {
    const ext = (originalName.split('.').pop() || '').toLowerCase();
    if (PREVIEWABLE_IMAGE_EXT.includes(ext)) {
        // 시설물 사진은 작은 썸네일로 먼저 보여주고(약 1/5 크기), 누르면 원본을 새 탭에서 연다.
        if (/\/api\/sections\/facility-files\//.test(viewUrl)) {
            return `<a href="${viewUrl}" target="_blank" rel="noopener" title="클릭하면 원본 크기로 엽니다" style="display:block;"><img src="${viewUrl}&thumb=1" style="${sizeStyle}object-fit:contain;display:block;"></a>`;
        }
        return `<img src="${viewUrl}" style="${sizeStyle}object-fit:contain;display:block;">`;
    }
    if (ext === 'pdf') {
        // 시설물 PDF: 사진처럼 누르면 새 창에서 크게 연다. <iframe> 안은 클릭이 PDF 뷰어로 들어가 링크가 동작하지 않으므로,
        //  - 여러 파일을 쭉 보여주는 목록에서는 iframe 대신 눌러서 여는 카드로 보여주고(높이 지정 없는 iframe은 아주 작게 나오기도 함),
        //  - 파일 하나를 크게 보는 화면에서는 iframe 위에 "새 창으로 크게 보기" 버튼을 얹는다.
        if (/\/api\/sections\/facility-files\//.test(viewUrl)) {
            if (/height:100%/.test(sizeStyle)) {
                return `<div style="position:relative;${sizeStyle}"><iframe src="${viewUrl}" style="width:100%;height:100%;border:none;display:block;"></iframe>`
                    + `<a href="${viewUrl}" target="_blank" rel="noopener" class="pdf-open-btn" title="PDF를 새 창에서 크게 엽니다"><i class="fa-solid fa-up-right-from-square"></i> 새 창으로 크게 보기</a></div>`;
            }
            return `<a href="${viewUrl}" target="_blank" rel="noopener" class="pdf-open-card" title="클릭하면 PDF를 새 창에서 크게 엽니다">`
                + `<i class="fa-solid fa-file-pdf"></i><span class="pdf-open-name">${escapeHtml(originalName)}</span>`
                + `<span class="pdf-open-hint">클릭하면 새 창에서 크게 엽니다 <i class="fa-solid fa-up-right-from-square"></i></span></a>`;
        }
        return `<iframe src="${viewUrl}" style="${sizeStyle}border:none;"></iframe>`;
    }
    if (PREVIEWABLE_VIDEO_EXT.includes(ext)) {
        if (is360Video(originalName)) {
            // Three.js videosphere는 DOM에 실제로 꽂힌 뒤에야 초기화할 수 있어(캔버스
            // 크기를 컨테이너 기준으로 재야 함), 여기서는 컨테이너만 반환하고
            // innerHTML 대입 직후 initVideo360Containers()가 찾아서 띄운다.
            const id = `v360-${video360Seq++}`;
            return `<div id="${id}" class="video360-container" data-src="${viewUrl}" data-autoplay="${autoplay ? '1' : '0'}" style="${sizeStyle}background:#000;position:relative;overflow:hidden;"></div>`;
        }
        return `<video src="${viewUrl}" controls${autoplay ? ' autoplay' : ''} style="${sizeStyle}background:#000;display:block;"></video>`;
    }
    return `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:20px;color:var(--text-secondary);">
            <i class="fa-solid fa-file-circle-question" style="font-size:2.5rem;color:var(--text-muted);"></i>
            <div>이 파일 형식(.${escapeHtml(ext)})은 화면에서 미리보기를 지원하지 않습니다.<br>${escapeHtml(originalName)}</div>
            <a href="${downloadUrl}" class="btn-squared" style="width:auto;padding:8px 24px;text-decoration:none;display:inline-block;">다운로드</a>
        </div>`;
}

// ---------- 360도 영상 뷰어 (Three.js videosphere) ----------
// buildFilePreviewMediaHtml이 만들어둔 .video360-container(들)를 실제 DOM에 꽂은
// 직후 호출한다 — 렌더러 크기를 컨테이너 실측 크기로 잡아야 하므로 문자열 단계
// (buildFilePreviewMediaHtml)에서는 초기화할 수 없다.
function initVideo360Containers(rootEl) {
    if (typeof THREE === 'undefined') return; // CDN 로드 실패 시에도 나머지 화면은 그대로 동작
    rootEl.querySelectorAll('.video360-container').forEach((el) => {
        createVideo360Player(el, el.dataset.src, el.dataset.autoplay === '1');
    });
}

// 구체 안쪽에 영상을 입히고, 드래그로 시야(경도/위도)를 돌려볼 수 있게 한다.
// OrbitControls 애드온을 별도로 더 받아오는 대신(안쪽에서 둘러보는 용도라 궤도
// 회전용 OrbitControls와는 성격이 달라 어차피 안 맞음), three.js 파노라마 예제와
// 같은 방식으로 포인터 드래그 -> lon/lat 갱신 -> camera.lookAt()을 직접 구현한다.
function createVideo360Player(container, src, autoplay) {
    const video = document.createElement('video');
    video.src = src;
    video.loop = true;
    video.muted = true; // 브라우저 자동재생 정책상 처음엔 무조건 음소거 상태여야 함
    video.playsInline = true;
    video.crossOrigin = 'anonymous';

    const width = container.clientWidth || 640;
    const height = container.clientHeight || 360;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, width / height, 1, 1100);
    const geometry = new THREE.SphereGeometry(500, 60, 40);
    geometry.scale(-1, 1, 1); // 안쪽 면이 보이게 뒤집는다(바깥에서 보는 지구본이 아니라 안에서 보는 하늘/사방)
    const texture = new THREE.VideoTexture(video);
    const material = new THREE.MeshBasicMaterial({ map: texture });
    scene.add(new THREE.Mesh(geometry, material));

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    // devicePixelRatio를 안 정해주면 캔버스가 항상 배율 1로만 그려져서, 고해상도
    // (레티나/윈도우 확대배율 125~150% 등) 화면에서 원본 <video>보다 눈에 띄게
    // 흐리게 보인다 — 화질이 나빠 보인다는 문제의 원인.
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    // 컨트롤 오버레이 — 구체 뷰 위에는 네이티브 <video controls>를 얹을 수 없어
    // 재생/음소거/전체화면만 최소한으로 직접 만든다.
    const controlsBar = document.createElement('div');
    controlsBar.style.cssText = 'position:absolute;left:0;right:0;bottom:0;display:flex;gap:10px;padding:8px 10px;background:rgba(0,0,0,0.45);z-index:2;';
    controlsBar.innerHTML = `
        <button type="button" class="v360-play-btn" style="background:none;border:none;color:#fff;cursor:pointer;font-size:1rem;"><i class="fa-solid fa-pause"></i></button>
        <button type="button" class="v360-mute-btn" style="background:none;border:none;color:#fff;cursor:pointer;font-size:1rem;"><i class="fa-solid fa-volume-xmark"></i></button>
        <span style="flex:1;"></span>
        <span style="color:#fff;font-size:0.75rem;align-self:center;"><i class="fa-solid fa-arrows-up-down-left-right"></i> 드래그로 둘러보기</span>
        <button type="button" class="v360-fullscreen-btn" style="background:none;border:none;color:#fff;cursor:pointer;font-size:1rem;"><i class="fa-solid fa-expand"></i></button>
    `;
    container.appendChild(controlsBar);

    const playBtn = controlsBar.querySelector('.v360-play-btn');
    playBtn.addEventListener('click', () => {
        if (video.paused) { video.play(); playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>'; }
        else { video.pause(); playBtn.innerHTML = '<i class="fa-solid fa-play"></i>'; }
    });
    const muteBtn = controlsBar.querySelector('.v360-mute-btn');
    muteBtn.addEventListener('click', () => {
        video.muted = !video.muted;
        muteBtn.innerHTML = video.muted ? '<i class="fa-solid fa-volume-xmark"></i>' : '<i class="fa-solid fa-volume-high"></i>';
    });
    controlsBar.querySelector('.v360-fullscreen-btn').addEventListener('click', () => {
        if (container.requestFullscreen) container.requestFullscreen();
    });

    // 드래그로 경도(lon)/위도(lat) 갱신 — 위도는 카메라가 뒤집히지 않게 ±85도로 제한.
    let lon = 0, lat = 0, isDragging = false, dragStartX = 0, dragStartY = 0, dragStartLon = 0, dragStartLat = 0;
    const onPointerDown = (e) => {
        isDragging = true;
        dragStartX = e.clientX; dragStartY = e.clientY;
        dragStartLon = lon; dragStartLat = lat;
    };
    const onPointerMove = (e) => {
        if (!isDragging) return;
        lon = (dragStartX - e.clientX) * 0.15 + dragStartLon;
        lat = (e.clientY - dragStartY) * 0.15 + dragStartLat;
        lat = Math.max(-85, Math.min(85, lat));
    };
    const onPointerUp = () => { isDragging = false; };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    const resizeObserver = new ResizeObserver(() => {
        const w = container.clientWidth || width;
        const h = container.clientHeight || height;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    let rafId = null;
    function animate() {
        // 미리보기를 닫거나 다른 파일로 바꾸면 이 컨테이너가 DOM에서 사라진다 —
        // 매 프레임 확인해서, 사라졌으면 렌더 루프를 멈추고 리소스를 정리한다
        // (안 그러면 여러 번 열었다 닫을 때마다 백그라운드에 렌더 루프가 쌓임).
        if (!container.isConnected) {
            cancelAnimationFrame(rafId);
            resizeObserver.disconnect();
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            video.pause();
            video.src = '';
            renderer.dispose();
            geometry.dispose();
            material.dispose();
            texture.dispose();
            return;
        }
        rafId = requestAnimationFrame(animate);
        const phi = THREE.MathUtils.degToRad(90 - lat);
        const theta = THREE.MathUtils.degToRad(lon);
        camera.position.set(
            Math.sin(phi) * Math.cos(theta),
            Math.cos(phi),
            Math.sin(phi) * Math.sin(theta)
        );
        camera.lookAt(0, 0, 0);
        renderer.render(scene, camera);
    }
    animate();

    if (autoplay) video.play().catch(() => {}); // 자동재생이 브라우저 정책상 막혀도 조용히 무시(재생 버튼으로 시작 가능)
}

// facilityInfo(선택): { label, name, attributes:[{label,value}] } — 부속시설
// 파일을 열 때 분할화면 상단에 속성정보 바를 같이 보여주기 위함
// (openFacilityFileList, cad-viewer.js 참고). 없으면 기존과 동일하게 미리보기만.
function openFilePreview(pnu, fileId, originalName, baseUrl, facilityInfo) {
    if (!isSplitOpen) toggleSplitView();
    document.getElementById('sat_map').style.display = 'none';
    document.getElementById('roadview-wrap').style.display = 'none';
    document.getElementById('cctv-preview-div').style.display = 'none';
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; } // CCTV 보다가 바로 파일을 열면 스트림이 백그라운드에 계속 흐르지 않게 정지
    const previewDiv = document.getElementById('file-preview-div');
    previewDiv.style.display = 'flex';

    const base = baseUrl || `/api/parcels/${pnu}/files`;
    const viewUrl = `${base}/${fileId}?inline=1`;
    const downloadUrl = `${base}/${fileId}`;
    const mediaHtml = buildFilePreviewMediaHtml(originalName, viewUrl, downloadUrl, 'width:100%;height:100%;', true);

    // 시설물 파일을 하나만 열어 둔 경우에는 속성정보 바에서 그 파일을 지울 수 있게 파일 정보를 넘긴다
    const infoForBar = (facilityInfo && baseUrl === '/api/sections/facility-files') ? { ...facilityInfo, fileId, fileName: originalName } : facilityInfo;
    const infoBarHtml = infoForBar ? buildFacilityInfoBarHtml(infoForBar) : '';
    previewDiv.innerHTML = withFacilityInfoResizer(infoBarHtml, `<div class="facility-file-media">${mediaHtml}</div>`);
    initVideo360Containers(previewDiv);
}

// 속성정보 바가 있을 때만 그 아래에 드래그 리사이저를 끼워 넣는다(정보가
// 없으면 리사이즈할 대상 자체가 없으므로 media만 그대로 반환).
function withFacilityInfoResizer(infoBarHtml, mediaBlockHtml) {
    if (!infoBarHtml) return mediaBlockHtml;
    return `${infoBarHtml}<div class="facility-info-resizer" title="드래그로 높이 조절"><i class="fa-solid fa-grip-lines"></i></div>${mediaBlockHtml}`;
}

// #file-preview-div의 내용은 파일을 열 때마다 innerHTML로 통째로 교체되므로,
// 리사이저에 매번 새로 이벤트를 바인딩하지 않고 이벤트 위임으로 한 번만 등록한다.
//
// mousemove/mouseup 대신 Pointer Events + setPointerCapture를 쓴다 — PDF
// 미리보기는 <iframe>인데, mouse 이벤트는 드래그 중 커서가 iframe 위로
// 지나가는 순간 그 안의 별도 문서로 넘어가버려서 부모 페이지가 mouseup을
// 못 받는 경우가 있었다(그러면 dragging 플래그가 true로 눌어붙어 다음
// 조작부터 동작이 꼬임 — "처음엔 되는데 다시 조절하면 이상하다"는 증상의
// 원인). setPointerCapture는 무엇 위를 지나든 이벤트를 캡처한 요소로
// 계속 보내줘서 이 문제를 근본적으로 막는다.
function initFacilityInfoResizer() {
    const previewDiv = document.getElementById('file-preview-div');
    let dragging = false;
    let infoBarEl = null;
    previewDiv.addEventListener('pointerdown', (e) => {
        const resizer = e.target.closest('.facility-info-resizer');
        if (!resizer) return;
        infoBarEl = previewDiv.querySelector('.facility-info-bar');
        if (!infoBarEl) return;
        dragging = true;
        resizer.classList.add('active');
        // setPointerCapture가 (드물게) 실패해도 아래 로직은 그대로 진행돼야
        // dragging 플래그가 true로 눌어붙지 않는다.
        try { resizer.setPointerCapture(e.pointerId); } catch (err) { /* no-op */ }
        e.preventDefault();
    });
    previewDiv.addEventListener('pointermove', (e) => {
        if (!dragging || !infoBarEl) return;
        const top = previewDiv.getBoundingClientRect().top;
        const height = Math.min(previewDiv.clientHeight - 80, Math.max(80, e.clientY - top));
        infoBarEl.style.maxHeight = height + 'px';
    });
    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        const resizer = previewDiv.querySelector('.facility-info-resizer');
        if (resizer) {
            resizer.classList.remove('active');
            if (e && resizer.hasPointerCapture(e.pointerId)) resizer.releasePointerCapture(e.pointerId);
        }
        infoBarEl = null;
    };
    previewDiv.addEventListener('pointerup', endDrag);
    previewDiv.addEventListener('pointercancel', endDrag);
}

// 속성정보를 지도 팝업/정보창처럼 카드형으로 꾸민다 — 라벨은 알약(배지)+이름을
// 헤더에 크게 보여주고, 나머지 속성은 라벨을 값 위에 작게 얹은 "필드 카드"
// 그리드로 나열한다(옆으로 나란히 붙여 촘촘한 표보다 한눈에 읽기 쉽다).
// 배지 색은 지도 마커 색과 같은 facilityColor()를 재사용해 시각적으로 연결한다.
function buildFacilityInfoBarHtml(info) {
    const accent = facilityColor(info.label || '');
    const badge = escapeHtml(info.label || '시설물');
    const nameHtml = info.name
        ? `<span class="fib-name">${escapeHtml(info.name)}</span>`
        : '';
    // 사진·보고서 올리기 — 편집 모드(body.admin-mode)에서만 보인다. 서버도 관리자만 받는다.
    const uploadHtml = (info.table && info.rdid)
        ? `<label class="fib-upload" title="이 시설물에 사진·보고서 올리기 (편집 모드)"><i class="fa-solid fa-upload"></i> 파일 올리기<input type="file" class="fib-upload-input" data-table="${escapeHtml(info.table)}" data-rdid="${escapeHtml(info.rdid)}" multiple hidden accept=".jpg,.jpeg,.png,.gif,.bmp,.webp,.pdf,.hwp,.hwpx,.doc,.docx,.xls,.xlsx"></label>`
        : '';
    const delHtml = (info.table && info.rdid && info.fileId)
        ? `<button type="button" class="fib-del" data-id="${info.fileId}" data-name="${escapeHtml(info.fileName || '')}" data-table="${escapeHtml(info.table)}" data-rdid="${escapeHtml(info.rdid)}" title="지금 보고 있는 파일 삭제 (편집 모드)"><i class="fa-solid fa-trash"></i> 이 파일 삭제</button>`
        : '';
    const fields = (info.attributes || [])
        .map((a) => `<div class="fib-field"><div class="fib-k">${escapeHtml(a.label)}</div><div class="fib-v">${escapeHtml(String(a.value))}</div></div>`)
        .join('');
    // 점검·보수 이력과 변경 이력 보기(보기는 모두, 기록 추가·수정·삭제는 이력 창 안에서 편집 모드만)
    const histHtml = (info.table && info.rdid)
        ? `<button type="button" class="fib-hist" data-table="${escapeHtml(info.table)}" data-rdid="${escapeHtml(info.rdid)}" data-label="${escapeHtml(info.label || '')}" data-name="${escapeHtml(info.name || '')}" title="이 시설물의 점검·보수 이력과 변경 이력"><i class="fa-solid fa-clock-rotate-left"></i> 이력</button>`
        : '';
    return `
        <div class="facility-info-bar" style="--fib-accent:${accent};">
            <div class="fib-header"><span class="fib-badge">${badge}</span>${nameHtml}${histHtml}${uploadHtml}${delHtml}</div>
            <div class="fib-fields">${fields}</div>
        </div>`;
}

// ---------- 시설물 파일 올리기(속성정보 창 상단, 편집 모드) ----------
async function uploadFacilityFiles(table, rdid, files, replace) {
    const formData = new FormData();
    formData.append('table', table);
    formData.append('facility_rdid', rdid);
    if (replace) formData.append('replace', '1');
    files.forEach((f) => formData.append('files', f));
    const res = await fetch('/api/sections/facility-files', { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.conflicts && !replace) {
        if (!await uiConfirm(`같은 이름의 파일이 이미 있습니다:\n${data.conflicts.slice(0, 5).join('\n')}\n\n덮어쓰시겠습니까?(이전 파일은 지워집니다)`)) return false;
        return uploadFacilityFiles(table, rdid, files, true);
    }
    if (!res.ok) throw new Error(data.error || '업로드 실패');
    return true;
}

// 올린 뒤 그 시설물의 속성정보·파일 보기를 다시 연다(위치 정보가 없는 시설물도 연다)
async function refreshFacilityView(table, rdid) {
    const params = new URLSearchParams({ table, facility_rdid: rdid });
    const record = (await fetch('/api/sections/facility-detail?' + params.toString()).then((r) => r.json())).record;
    if (!record) return;
    const feature = record.geom
        ? new ol.format.GeoJSON().readFeature({ type: 'Feature', geometry: record.geom, properties: {} }, { featureProjection: map.getView().getProjection() })
        : new ol.Feature();
    feature.setProperties({ facilityTable: table, facilityRdid: rdid, label: record.label, name: record.name });
    await openFacilityMarkerFiles(feature);
}

// 시설물 파일 삭제 — 서버에서 지우고(30일은 서버 보관 폴더에 남음) 그 시설물의 파일 보기를 다시 연다
async function deleteFacilityFile(id, name, table, rdid) {
    if (!document.body.classList.contains('admin-mode')) { uiAlert('편집 모드에서만 파일을 지울 수 있습니다.'); return false; }
    if (!await uiConfirm(`'${name}' 파일을 삭제하시겠습니까?\n서버에서 지워지며, 30일 동안은 서버 보관 폴더에 남아 관리자가 복구할 수 있습니다.`)) return false;
    try {
        const res = await fetch('/api/sections/facility-files/' + encodeURIComponent(id), { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '삭제 실패');
    } catch (err) {
        uiAlert(err.message || '삭제 실패');
        return false;
    }
    if (table && rdid) await refreshFacilityView(table, rdid);
    return true;
}

document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.fm-file-del, .fib-del') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    deleteFacilityFile(btn.dataset.id, btn.dataset.name, btn.dataset.table, btn.dataset.rdid);
});

document.addEventListener('change', async (e) => {
    const input = e.target && e.target.classList && e.target.classList.contains('fib-upload-input') ? e.target : null;
    if (!input) return;
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    if (!document.body.classList.contains('admin-mode')) { uiAlert('편집 모드에서만 파일을 올릴 수 있습니다.'); return; }
    const label = input.closest('.fib-upload');
    if (label) label.classList.add('busy');
    try {
        const ok = await uploadFacilityFiles(input.dataset.table, input.dataset.rdid, files, false);
        if (ok) await refreshFacilityView(input.dataset.table, input.dataset.rdid);
    } catch (err) {
        uiAlert(err.message || '업로드 실패');
    } finally {
        if (label && label.isConnected) label.classList.remove('busy');
    }
});

// 지도의 부속시설 마커 클릭 — 그 시설물에 첨부된 사진/보고서(gov_facility_files)가
// 있으면 분할화면에 보여준다. 1건이면 바로 열고, 여러 건이면(예: 표지 하나에
// 원본사진+표지사진 둘 다 있는 경우) 목록을 먼저 보여준다. 없으면 아무 동작 안 함.
async function openFacilityMarkerFiles(feature) {
    const table = feature.get('facilityTable');
    const facilityRdid = feature.get('facilityRdid');
    if (!table || !facilityRdid) return;

    let files = [];
    let facilityInfo = null;
    try {
        const params = new URLSearchParams({ table, facility_rdid: facilityRdid });
        const [filesData, detailData] = await Promise.all([
            fetch('/api/sections/facility-files?' + params.toString()).then((r) => r.json()),
            fetch('/api/sections/facility-detail?' + params.toString()).then((r) => r.json()),
        ]);
        files = filesData.files || [];
        if (detailData.record) {
            facilityInfo = { label: detailData.record.label, name: detailData.record.name, attributes: detailData.record.attributes, table: detailData.record.table, rdid: detailData.record.rdid };
        }
    } catch (e) { return; }
    // 첨부파일이 없어도 속성정보(facilityInfo)만 있으면 그거라도 보여준다 —
    // 예전엔 여기서 그냥 return해서 첨부파일 없는 시설물은 클릭해도 아무 반응이
    // 없었다.
    if (!files.length && !facilityInfo) return;

    // 지도에서 마커를 직접 클릭한 경우도 파일 목록에서 클릭한 것과 동일하게
    // 3초 깜빡임으로 어떤 시설물을 선택했는지 확인시켜준다(이동은 필요 없음 —
    // 이미 그 위치를 보고 있는 상태라 highlightFacilityFeature만 호출).
    if (feature.getGeometry()) highlightFacilityFeature(new ol.Feature({ geometry: feature.getGeometry().clone() }));

    if (files.length === 1) {
        openFilePreview(null, files[0].id, files[0].original_name, '/api/sections/facility-files', facilityInfo);
        return;
    }

    if (!isSplitOpen) toggleSplitView();
    document.getElementById('sat_map').style.display = 'none';
    document.getElementById('roadview-wrap').style.display = 'none';
    document.getElementById('cctv-preview-div').style.display = 'none';
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    const previewDiv = document.getElementById('file-preview-div');
    previewDiv.style.display = 'flex';
    const infoBarHtml = facilityInfo ? buildFacilityInfoBarHtml(facilityInfo) : '';
    const fLabel = feature.get('label') || '시설물';
    const fName = feature.get('name');
    const title = fName ? `${fName}(${fLabel})` : fLabel;
    let mediaHtml;
    if (files.length) {
        // 예전엔 파일명 목록만 보여주고 하나씩 클릭해야 그때 열렸다 — 보고서(PDF)는
        // 파일이 1개뿐이라 열자마자 바로 전체 내용이 보였는데, 사진은 보통
        // 원본사진+표지사진처럼 여러 개라 매번 골라야 했다. 이제 PDF와 똑같이
        // 전부 바로 렌더링해서 쭉 이어 보여준다(요청사항).
        const itemsHtml = files.map((f) => {
            const viewUrl = `/api/sections/facility-files/${f.id}?inline=1`;
            const downloadUrl = `/api/sections/facility-files/${f.id}`;
            const media = buildFilePreviewMediaHtml(f.original_name, viewUrl, downloadUrl, 'width:100%;max-height:560px;');
            return `
                <div class="fm-gallery-item">
                    <div class="fm-gallery-item-label"><span>${escapeHtml(f.file_kind)}</span><span>${escapeHtml(f.original_name)}</span><button type="button" class="fm-file-del" data-id="${f.id}" data-name="${escapeHtml(f.original_name)}" data-table="${escapeHtml(table)}" data-rdid="${escapeHtml(facilityRdid)}" title="이 파일 삭제 (편집 모드)"><i class="fa-solid fa-trash"></i></button></div>
                    ${media}
                </div>`;
        }).join('');
        mediaHtml = `<div class="facility-file-media fm-gallery">
            <div class="fm-file-list-title">${escapeHtml(title)} 첨부파일 (${files.length})</div>
            ${itemsHtml}
        </div>`;
    } else {
        mediaHtml = `
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:14px;text-align:center;padding:20px;color:var(--text-secondary);">
                <i class="fa-solid fa-circle-info" style="font-size:2.5rem;color:var(--text-muted);"></i>
                <div>${escapeHtml(title)}<br>첨부된 사진·보고서가 없습니다.</div>
            </div>`;
    }
    previewDiv.innerHTML = withFacilityInfoResizer(infoBarHtml, mediaHtml);
    initVideo360Containers(previewDiv);
}

// ---------- 주소 검색 ----------
// ---------- 통합검색 (명칭/도로명/지번/노선을 한 화면에서, VWorld 통합검색 스타일) ----------
let currentSearchCategory = '전체';

function initSearchCategoryTabs() {
    document.querySelectorAll('.sc-tab-button').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.sc-tab-button').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            currentSearchCategory = btn.dataset.cat;
            if (document.getElementById('searchInput').value.trim()) runUnifiedSearch(1);
        });
    });
}

async function flyToPoint(point) {
    if (!point) return;
    const x = parseFloat(point.x);
    const y = parseFloat(point.y);
    const coord = ol.proj.fromLonLat([x, y]);
    map.getView().animate({ center: coord, zoom: 19, duration: 400 });
    // 검색결과는 위치 확인용 — 지도 이동 + 안내 팝업만 띄운다 (도로대장 입력은
    // 도로망도 선분을 직접 클릭해서 등록한다)
    await identifyParcel(x, y, coord);
}

async function fetchPlaceItems(query, size) {
    const params = new URLSearchParams({ service: 'search', request: 'search', key: VWORLD_KEY, query, type: 'place', format: 'json', size: String(size) });
    const data = await vworldFetchJson('https://api.vworld.kr/req/search?' + params.toString());
    return { total: Number(data?.response?.record?.total || 0), items: data?.response?.result?.items || [] };
}
async function fetchAddressItems(query, category, size) {
    const params = new URLSearchParams({ service: 'search', request: 'search', key: VWORLD_KEY, query, type: 'address', category, format: 'json', size: String(size) });
    const data = await vworldFetchJson('https://api.vworld.kr/req/search?' + params.toString());
    return { total: Number(data?.response?.record?.total || 0), items: data?.response?.result?.items || [] };
}

function renderPlaceRow(item, query) {
    const div = document.createElement('div');
    div.className = 'search-result-item';
    div.innerHTML = `
        <div><span class="sr-grade">[명칭]</span>${highlightMatch(item.title || '', query)}</div>
        <div class="sr-sub"><span>${escapeHtml(item.category || '')}</span><span class="sr-id">${escapeHtml(item.address?.road || item.address?.parcel || '')}</span></div>
    `;
    div.addEventListener('click', () => flyToPoint(item.point));
    return div;
}
function renderAddressRow(item, tag, query) {
    const div = document.createElement('div');
    div.className = 'search-result-item';
    const addrText = item.address?.road || item.address?.parcel || '(주소 없음)';
    const sub = [item.address?.zipcode ? `(${item.address.zipcode})` : '', item.address?.bldnm].filter(Boolean).join(' ');
    div.innerHTML = `
        <div><span class="sr-grade">[${escapeHtml(tag)}]</span>${highlightMatch(addrText, query)}</div>
        ${sub ? `<div class="sr-sub"><span>${escapeHtml(sub)}</span></div>` : ''}
    `;
    div.addEventListener('click', () => flyToPoint(item.point));
    return div;
}
// road_sections 검색 결과 한 줄. 클릭하면 데이터보기 트리에서 구간을 선택한 것과
// 동일하게 좌측 CAD 패널/부속시설/지도 강조가 전부 갱신된다(selectSectionForLeftSidebar 재사용).
function renderMyRouteRow(item, query) {
    const div = document.createElement('div');
    div.className = 'search-result-item';

    const lengthText = item.length_m != null ? `${Number(item.length_m).toLocaleString()}m` : '';
    const subParts = [item.route_no ? routeNoLabel(item.route_no) : '', lengthText].filter(Boolean).join(' · ');
    div.innerHTML = `
        <div><span class="sr-grade">[${escapeHtml(item.road_rank_name || '-')}]</span>${highlightMatch(item.route_name || '(노선명 없음)', query)}</div>
        <div class="sr-sub"><span>${escapeHtml(subParts)}</span><span class="sr-id">${escapeHtml(item.sect ? `${item.sect}구간` : '')}</span></div>
    `;
    div.addEventListener('click', () => {
        selectSectionForLeftSidebar({
            rdid: item.rdid, road_grade: item.road_rank_name, road_rank_name: item.road_rank_name,
            route_no: item.route_no, route_name: item.route_name, sect: item.sect,
            s_point: item.s_point, e_point: item.e_point, length_m: item.length_m,
        });
    });
    return div;
}

async function fetchMyRouteItems(query, page, size) {
    const params = new URLSearchParams({ q: query, page: String(page), size: String(size) });
    const data = await fetch('/api/sections/search?' + params.toString()).then((r) => r.json());
    return {
        status: 'OK',
        total: data.total || 0,
        totalPages: data.totalPages || 1,
        items: data.items || [],
    };
}

// 시설물 검색 결과 한 줄. 클릭하면 그 시설물 위치로 지도를 옮기고 속성정보/첨부파일을 보여준다.
function renderFacilityRow(item, query) {
    const div = document.createElement('div');
    div.className = 'search-result-item';
    const title = item.name ? `${item.name}` : `${item.kind} ${parseInt(item.serial, 10)}번`;
    const route = [item.roadName, item.roadNo ? routeNoLabel(item.roadNo) : '', item.sect ? `${item.sect}구간` : ''].filter(Boolean).join(' · ');
    div.innerHTML = `
        <div><span class="sr-grade">[${escapeHtml(item.kind)}]</span>${highlightMatch(title, query)}</div>
        <div class="sr-sub"><span>${escapeHtml(route)}</span><span class="sr-id">${highlightMatch(item.rdid, query)}</span></div>${item.hasGeom ? '' : '<div class="sr-sub"><span>위치 정보가 없어 지도로 이동할 수 없습니다.</span></div>'}`;
    div.addEventListener('click', () => goToFacility(item));
    return div;
}

async function goToFacility(item) {
    let record = null;
    try {
        const params = new URLSearchParams({ table: item.table, facility_rdid: item.rdid });
        record = (await fetch('/api/sections/facility-detail?' + params.toString()).then((r) => r.json())).record;
    } catch (e) { /* 아래에서 안내 */ }
    if (!record) { uiAlert('시설물 정보를 불러오지 못했습니다.'); return; }
    if (!record.geom) { uiAlert('이 시설물은 위치 정보가 없어 지도로 이동할 수 없습니다.'); return; }
    jumpToFacilityLocation(record.geom);
    const feature = new ol.format.GeoJSON().readFeature(
        { type: 'Feature', geometry: record.geom, properties: {} }, { featureProjection: map.getView().getProjection() }
    );
    feature.setProperties({ facilityTable: item.table, facilityRdid: item.rdid, label: record.label, name: record.name });
    openFacilityMarkerFiles(feature);
}

async function fetchFacilityItems(query) {
    const data = await fetch('/api/sections/facility-search?q=' + encodeURIComponent(query)).then((r) => r.json());
    return { total: data.total || 0, items: data.items || [], truncated: !!data.truncated };
}

function buildSection(label, total, rowEls, catKey) {
    const section = document.createElement('div');
    section.className = 'sr-section';
    const header = document.createElement('div');
    header.className = 'sr-section-header';
    header.innerHTML = `<span>${escapeHtml(label)} <b>${total.toLocaleString()}</b>건</span>${total > 0 ? '<span class="sr-more">더보기 ›</span>' : ''}`;
    section.appendChild(header);

    if (total === 0) {
        const empty = document.createElement('div');
        empty.className = 'sr-section-empty';
        empty.textContent = '결과 없음';
        section.appendChild(empty);
    } else {
        rowEls.forEach((el) => section.appendChild(el));
        const moreLink = header.querySelector('.sr-more');
        if (moreLink) {
            moreLink.addEventListener('click', () => {
                document.querySelectorAll('.sc-tab-button').forEach((b) => b.classList.toggle('active', b.dataset.cat === catKey));
                currentSearchCategory = catKey;
                runUnifiedSearch(1);
            });
        }
    }
    return section;
}

async function runUnifiedSearch(page) {
    const query = document.getElementById('searchInput').value.trim();
    if (!query) return;
    const wrapEl = document.getElementById('search-results-wrapper');
    const pagerEl = document.getElementById('search-results-pager');
    wrapEl.innerHTML = '<div style="color:var(--text-muted);padding:8px;">검색 중...</div>';
    pagerEl.innerHTML = '';

    if (currentSearchCategory === '전체') {
        const [place, road, parcel, myroutes, facility] = await Promise.all([
            fetchPlaceItems(query, 3).catch(() => ({ total: 0, items: [] })),
            fetchAddressItems(query, 'road', 3).catch(() => ({ total: 0, items: [] })),
            fetchAddressItems(query, 'parcel', 3).catch(() => ({ total: 0, items: [] })),
            fetchMyRouteItems(query, 1, 3).catch(() => ({ total: 0, items: [] })),
            fetchFacilityItems(query).catch(() => ({ total: 0, items: [] })),
        ]);
        wrapEl.innerHTML = '';
        if (place.total + road.total + parcel.total + myroutes.total + facility.total === 0) {
            wrapEl.innerHTML = `<div style="color:var(--text-muted);padding:8px;">'${escapeHtml(query)}' 검색결과가 없습니다.</div>`;
            return;
        }
        wrapEl.appendChild(buildSection('노선', myroutes.total, myroutes.items.map((it) => renderMyRouteRow(it, query)), '노선'));
        // 시설물은 ID·종류 번호·이름으로 찾을 때만 나오므로, 결과가 있을 때만 섹션을 보여준다(없는 게 정상인 경우가 많다).
        if (facility.total > 0) wrapEl.appendChild(buildSection('시설물', facility.total, facility.items.slice(0, 3).map((it) => renderFacilityRow(it, query)), '시설물'));
        wrapEl.appendChild(buildSection('도로명', road.total, road.items.map((it) => renderAddressRow(it, '도로명', query)), '도로명'));
        wrapEl.appendChild(buildSection('지번', parcel.total, parcel.items.map((it) => renderAddressRow(it, '지번', query)), '지번'));
        wrapEl.appendChild(buildSection('명칭', place.total, place.items.map((it) => renderPlaceRow(it, query)), '명칭'));
        return;
    }

    wrapEl.innerHTML = '';
    if (currentSearchCategory === '명칭') {
        const { total, items } = await fetchPlaceItems(query, 30);
        if (total === 0) { wrapEl.innerHTML = `<div style="color:var(--text-muted);padding:8px;">'${escapeHtml(query)}' 검색결과가 없습니다.</div>`; return; }
        items.map((it) => renderPlaceRow(it, query)).forEach((el) => wrapEl.appendChild(el));
    } else if (currentSearchCategory === '도로명' || currentSearchCategory === '지번') {
        const category = currentSearchCategory === '도로명' ? 'road' : 'parcel';
        const { total, items } = await fetchAddressItems(query, category, 30);
        if (total === 0) { wrapEl.innerHTML = `<div style="color:var(--text-muted);padding:8px;">'${escapeHtml(query)}' 검색결과가 없습니다.</div>`; return; }
        items.map((it) => renderAddressRow(it, currentSearchCategory, query)).forEach((el) => wrapEl.appendChild(el));
    } else if (currentSearchCategory === '시설물') {
        const { total, items, truncated } = await fetchFacilityItems(query);
        if (!items.length) {
            wrapEl.innerHTML = `<div style="color:var(--text-muted);padding:8px;">'${escapeHtml(query)}' 시설물 검색결과가 없습니다.<br>시설물 ID(일부 가능), '표지 12'처럼 종류와 번호, 또는 교량명으로 검색하세요.</div>`;
            return;
        }
        items.map((it) => renderFacilityRow(it, query)).forEach((el) => wrapEl.appendChild(el));
        if (truncated || total > items.length) {
            const more = document.createElement('div');
            more.style.cssText = 'color:var(--text-muted);padding:8px;font-size:0.78rem;';
            more.textContent = `결과가 많아 일부만 표시했습니다. 시설물 ID나 번호를 더 정확히 입력하세요.`;
            wrapEl.appendChild(more);
        }
    } else if (currentSearchCategory === '노선') {
        const { total, totalPages, items } = await fetchMyRouteItems(query, page, 20);
        if (items.length === 0) {
            wrapEl.innerHTML = `<div style="color:var(--text-muted);padding:8px;">'${escapeHtml(query)}' 검색결과가 없습니다.</div>`;
            return;
        }
        items.map((it) => renderMyRouteRow(it, query)).forEach((el) => wrapEl.appendChild(el));
        renderSearchResultsPager(total, page, totalPages);
    }
}

function renderSearchResultsPager(total, page, totalPages) {
    const pagerEl = document.getElementById('search-results-pager');
    pagerEl.innerHTML = `
        <button id="rs-prev-btn" ${page <= 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button>
        <span>${page.toLocaleString()} / ${totalPages.toLocaleString()} 페이지 (총 ${total.toLocaleString()}건)</span>
        <button id="rs-next-btn" ${page >= totalPages ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button>
    `;
    document.getElementById('rs-prev-btn').addEventListener('click', () => runUnifiedSearch(page - 1));
    document.getElementById('rs-next-btn').addEventListener('click', () => runUnifiedSearch(page + 1));
}

function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s ?? '';
    return div.innerHTML;
}

// route_no(4자리 0채움, 예: "0008")는 국토부 표준상 도로등급 내 노선번호다
// (예: 군도 제8호선). 화면에는 앞자리 0을 뗀 "N호선" 형태로 보여준다.
function routeNoLabel(routeNo) {
    const n = parseInt(routeNo, 10);
    return Number.isFinite(n) && n > 0 ? `${n}호선` : (routeNo || '');
}

// 검색어와 일치하는 부분에 포인트 색을 입혀준다 (결과 제목/주소 텍스트용)
function highlightMatch(text, query) {
    const escaped = escapeHtml(text || '');
    const q = (query || '').trim();
    if (!q) return escaped;
    const escapedQuery = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
        return escaped.replace(new RegExp(escapedQuery, 'gi'), (m) => `<mark class="sr-hl">${m}</mark>`);
    } catch (e) {
        return escaped;
    }
}

// 국토교통부 「도로대장공간정보 공통입력코드정의서」의 관리기관(MCO) 공식 코드 목록
let managingAgencyList = [];
async function loadManagingAgencyList() {
    try {
        managingAgencyList = await fetch('/data/managing_agencies.json').then((r) => r.json());
        const listEl = document.getElementById('managing-agency-list');
        listEl.innerHTML = managingAgencyList.map((a) => `<option value="${escapeHtml(a.name)}">`).join('');
    } catch (e) { /* 목록 로드 실패해도 자유 입력은 계속 가능 */ }
}
function mcoCodeByName(name) {
    const found = managingAgencyList.find((a) => a.name === name);
    return found ? found.code : null;
}

// ---------- 통합검색 '노선' 카테고리용 헬퍼 ----------
// 예전엔 VWorld 전국 도로망도(LT_L_MOCTLINK)를 정확일치로만 검색했는데, 실제로
// 우리 시스템에 등록/일괄등록된 노선명을 부분검색하는 방식으로 바꿨다
// (server/routes/sections.js GET /search, road_sections.route_name ILIKE).
// 국토교통부 「도로대장공간정보 공통입력코드정의서」 도로의종류(ROAD_RANK) 공식 코드
// 9개(고속국도~구도, 기타) + 우리 시스템 내부 비공식 확장 4개(면도/리도/농도/
// 도시계획도로, road_rank_code 1509~1512 — 공식 코드북엔 없음, server/routes/
// sections.js의 ROAD_RANK_CODES 주석 참고). 신규 구간 등록 폼(도로등급 선택지)과
// road_rank_code 매핑이 이 13개 기준으로 동작한다.
const ROAD_GRADES = [
    '고속국도', '일반국도', '특별시도', '광역시도', '지방도', '시도', '군도', '구도',
    '면도', '리도', '농도', '도시계획도로', '기타',
];
// 데이터보기 트리 그룹 목록 — 이제 ROAD_GRADES와 동일(예전엔 확장 4종이 등록 불가라
// 트리 모양만 미리 보여주려고 분리했었는데, 지금은 실제 등록도 가능해져서 분리할
// 이유가 없어짐).
const TREE_ROAD_GRADES = ROAD_GRADES;

// 좌표 → 전체 도로명주소 (정보 탭의 "도로명주소" 항목용)
const roadAddressCache = new Map();
async function reverseGeocodeRoadAddress(lon, lat) {
    const cacheKey = `${lon.toFixed(5)},${lat.toFixed(5)}`;
    if (roadAddressCache.has(cacheKey)) return roadAddressCache.get(cacheKey);

    const params = new URLSearchParams({
        service: 'address', request: 'getAddress', version: '2.0',
        crs: 'epsg:4326', point: `${lon},${lat}`, format: 'json', type: 'road',
        key: VWORLD_KEY,
    });
    const data = await vworldFetchJson('https://api.vworld.kr/req/address?' + params.toString());
    const addr = data?.response?.result?.[0]?.text || null;
    roadAddressCache.set(cacheKey, addr);
    return addr;
}

// ---------- 오른쪽(사이드바) 접기 ----------
// 분할화면이 열릴 때 화면이 복잡해지지 않게 오른쪽 사이드바를 접고, 분할화면이 닫히면 다시 펼친다.
// 분할화면이 접은 경우(사이드바가 펼쳐져 있었을 때)에만 되돌린다 — 이미 접어 둔 사용자의 선택은 그대로 둔다.
let sidebarCollapsedBySplit = false;
function setRightSidebarCollapsed(collapsed) {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebarToggle');
    if (!sidebar || !toggleBtn) return;
    sidebar.classList.toggle('collapsed', collapsed);
    toggleBtn.classList.toggle('collapsed', collapsed);
}

function initSidebarToggle() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebarToggle');
    toggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
        toggleBtn.classList.toggle('collapsed');
        sidebarCollapsedBySplit = false; // 사용자가 직접 접거나 펼쳤으면 분할화면이 닫힐 때 자동으로 되돌리지 않는다
        setTimeout(() => map.updateSize(), 220);
    });
    initSidebarResize();
}

// 오른쪽 사이드바는 화면 오른쪽에 붙어있어서, 리사이저를 왼쪽 가장자리에 두고
// (뷰포트 오른쪽 끝 - 마우스 X좌표)로 폭을 계산한다 — 왼쪽 사이드바(리사이저가
// 오른쪽 가장자리, 그냥 e.clientX)와는 계산 방향이 반대다.
function initSidebarResize() {
    const resizer = document.getElementById('sidebar-resizer');
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebarToggle');
    const root = document.documentElement;
    const MIN_WIDTH = 320, MAX_WIDTH = Math.round(window.innerWidth * 0.7);

    let dragging = false;
    resizer.addEventListener('mousedown', (e) => {
        dragging = true;
        resizer.classList.add('active');
        sidebar.classList.add('resizing');
        toggleBtn.classList.add('resizing');
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - e.clientX));
        root.style.setProperty('--sidebar-width', width + 'px');
    });
    window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove('active');
        sidebar.classList.remove('resizing');
        toggleBtn.classList.remove('resizing');
        map.updateSize();
    });
}

// ---------- 왼쪽 레이어 목록 패널 ----------
function initLayerPanel() {
    document.getElementById('layer-panel-toggle').addEventListener('click', () => {
        document.getElementById('layer-panel').classList.toggle('collapsed');
    });
    document.getElementById('layer-cadastral').addEventListener('change', (e) => {
        cadastralLineVisible = e.target.checked;
        wfsLayer.changed();
    });
    document.getElementById('layer-roadnet').addEventListener('change', (e) => { roadNetLayer.setVisible(e.target.checked); });
    const roadnetExpandBtn = document.getElementById('layer-roadnet-expand-btn');
    const roadnetGrades = document.getElementById('layer-roadnet-grades');
    roadnetExpandBtn.addEventListener('click', () => {
        const willOpen = roadnetGrades.hidden;
        roadnetGrades.hidden = !willOpen;
        roadnetExpandBtn.classList.toggle('open', willOpen);
    });
    document.querySelectorAll('.layer-roadnet-grade').forEach((cb) => {
        cb.addEventListener('change', (e) => {
            const rank = e.target.dataset.rank;
            if (e.target.checked) visibleRoadRanks.add(rank); else visibleRoadRanks.delete(rank);
            roadNetLayer.changed();
        });
    });
    document.getElementById('layer-cctv').addEventListener('change', (e) => {
        cctvLayer.setVisible(e.target.checked);
        if (e.target.checked) refreshCctvMarkers();
    });
    // 지적편집도 — 지도 왼쪽 툴바(로드뷰 위) 버튼으로 켜고 끈다. 켜지면 버튼이 강조색.
    document.getElementById('cadastral-edit-btn').addEventListener('click', (e) => {
        const on = !cadastralEditLayer.getVisible();
        cadastralEditLayer.setVisible(on);
        e.currentTarget.classList.toggle('active', on);
        e.currentTarget.setAttribute('aria-pressed', String(on));
    });
    document.getElementById('layer-zoning').addEventListener('change', (e) => { zoningAreaLayer.setVisible(e.target.checked); });
    document.getElementById('layer-building').addEventListener('change', (e) => { buildingLayer.setVisible(e.target.checked); });
    document.getElementById('layer-roadcenterline').addEventListener('change', (e) => { roadCenterlineLayer.setVisible(e.target.checked); });
    document.getElementById('layer-sigg').addEventListener('change', (e) => { siggLayer.setVisible(e.target.checked); });
    document.getElementById('layer-emd').addEventListener('change', (e) => { emdLayer.setVisible(e.target.checked); });
    document.getElementById('layer-ri').addEventListener('change', (e) => { riLayer.setVisible(e.target.checked); });
}

// ---------- 사이드바 탭 (데이터보기/검색보기) ----------
function initSidebarTabs() {
    // 탭 버튼은 index.html의 inline onclick="switchSidebarTab(...)"으로 연결된다.
}

function switchSidebarTab(tabId) {
    document.querySelectorAll('#sidebar-tabs .tab-button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    document.querySelectorAll('.sidebar-tab-content').forEach((el) => {
        el.style.display = el.id === tabId ? 'flex' : 'none';
    });
}

// ---------- 화면분할 (위성 미니맵 / 로드뷰 공용 우측 패널) ----------
let satMap = null;
let isSplitOpen = false;
let isDraggingSplit = false;
let isRightPaneExpanded = false;

function initSplitView() {
    satMap = new ol.Map({
        target: 'sat_map',
        layers: [new ol.layer.Tile({
            source: new ol.source.XYZ({
                tileUrlFunction: (tileCoord) => {
                    if (!tileCoord) return undefined;
                    const [z, x, y] = tileCoord;
                    return vworldProxyUrl(`https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_KEY}/Satellite/${z}/${y}/${x}.jpeg`);
                },
                maxZoom: 19,
            }),
        })],
        view: map.getView(), // 메인 지도와 뷰(중심/줌)를 공유해 자동 동기화
        controls: [],
    });

    // mousemove/mouseup 대신 Pointer Events + setPointerCapture를 쓴다 —
    // 우측 패널에 PDF 미리보기(iframe)가 떠 있는 상태로 분할선을 드래그하면
    // 커서가 iframe 위를 지나는 순간 그 이벤트가 부모 페이지로 안 넘어와
    // mouseup을 못 받아 isDraggingSplit이 true로 눌어붙는 문제가 있었다
    // ("처음엔 되는데 다시 조절하면 이상하다"의 원인). setPointerCapture는
    // 커서가 무엇 위에 있든 이벤트를 캡처한 요소로 계속 보내줘서 막아준다.
    const endSplitDrag = (evt) => {
        if (!isDraggingSplit) return;
        isDraggingSplit = false;
        const splitter = document.getElementById('splitter');
        if (evt && splitter.hasPointerCapture(evt.pointerId)) splitter.releasePointerCapture(evt.pointerId);
        map.updateSize();
        satMap.updateSize();
        updateMapFooterPosition();
    };
    window.addEventListener('pointermove', (evt) => {
        if (!isDraggingSplit) return;
        const rect = document.getElementById('left-pane').getBoundingClientRect();
        const newRightWidth = rect.right - evt.clientX;
        if (newRightWidth > 150 && newRightWidth < rect.width - 150) {
            document.getElementById('right-pane').style.width = newRightWidth + 'px';
        }
    });
    window.addEventListener('pointerup', endSplitDrag);
    window.addEventListener('pointercancel', endSplitDrag);
}

function startSplitDrag(evt) {
    isDraggingSplit = true;
    try { document.getElementById('splitter').setPointerCapture(evt.pointerId); } catch (err) { /* no-op */ }
    evt.preventDefault();
}

function toggleSplitView() {
    isSplitOpen = !isSplitOpen;
    const splitter = document.getElementById('splitter');
    const rightPane = document.getElementById('right-pane');
    const btn = document.getElementById('open-split-btn');

    if (isSplitOpen) {
        if (!document.getElementById('sidebar').classList.contains('collapsed')) {
            setRightSidebarCollapsed(true);
            sidebarCollapsedBySplit = true;
        }
        splitter.style.display = 'flex';
        rightPane.style.display = 'block';
        rightPane.style.width = '40%';
        btn.classList.add('active');
        if (!isRoadviewMode) document.getElementById('sat_map').style.display = 'block';
    } else {
        if (sidebarCollapsedBySplit) { setRightSidebarCollapsed(false); sidebarCollapsedBySplit = false; }
        splitter.style.display = 'none';
        rightPane.style.display = 'none';
        rightPane.style.width = '0';
        btn.classList.remove('active');
        if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
        // 업로드 파일 미리보기(mp4 등)나 CCTV로 재생 중인 video가 있으면 완전히 정지
        document.querySelectorAll('#file-preview-div video, #cctv-preview-div video').forEach((v) => {
            v.pause(); v.removeAttribute('src'); v.load();
        });
        // innerHTML을 비워야 한다 — 특히 360도 영상은 컨테이너가 실제로 DOM에서
        // 사라져야(isConnected === false) 렌더 루프가 스스로 멈춘다(initVideo360Containers
        // 참고). display:none만으로는 안 보이는 채로 계속 렌더링/재생되며 남아있는다.
        document.getElementById('file-preview-div').innerHTML = '';
        document.getElementById('cctv-preview-div').innerHTML = '';
        // 전체화면 상태로 닫으면 빈 화면이 전체화면으로 남으니 같이 빠져나간다
        // (fullscreenchange 리스너가 버튼 아이콘/isRightPaneExpanded 정리까지 처리).
        if (document.fullscreenElement) document.exitFullscreen();
    }
    setTimeout(() => {
        map.updateSize();
        if (satMap) satMap.updateSize();
        updateMapFooterPosition();
    }, 220);
}

// 분할화면 우측 상단의 공용 닫기 버튼(#right-pane-close-btn) — CCTV/로드뷰/도면·
// 사진 미리보기가 전부 한 슬롯을 같이 쓰는 구조라(toggleSplitView 주석 참고)
// 패널별로 따로 안 만들고 하나로 그때그때 떠 있는 걸 닫는다. 로드뷰 중이면
// isRoadviewMode/커서/시설물선택 서브모드까지 되돌려야 해서, 그 정리를 전부
// 하는 기존 "로드뷰" 툴바 버튼의 클릭 핸들러를 그대로 재사용한다(중복 구현 방지).
function closeSplitPanel() {
    if (isRoadviewMode) {
        document.getElementById('roadview-btn').click();
        return;
    }
    if (isSplitOpen) toggleSplitView();
}

// 분할화면 우측 상단의 "전체화면" 버튼(#right-pane-expand-btn) — 시설물
// 속성정보/첨부파일(사진·PDF·영상)처럼 좁은 40% 폭에서는 보기 불편한 내용을
// 볼 때, 브라우저 Fullscreen API로 지도/트리까지 다 가리고 화면 전체를 쓰게
// 한다(폭만 넓히던 이전 방식 대신 — 요청사항). #right-pane 자신을 전체화면
// 대상으로 삼으면 그 안의 닫기/전체화면 버튼도 그대로 같이 뜬다.
function toggleRightPaneExpand() {
    const rightPane = document.getElementById('right-pane');
    if (!document.fullscreenElement) {
        rightPane.requestFullscreen().catch(() => {});
    } else {
        document.exitFullscreen();
    }
}

// 전체화면 진입/종료(버튼뿐 아니라 Esc 키로 나가는 경우도 이 이벤트로 잡힌다)
// 때마다 버튼 아이콘/문구를 맞추고, 지도/캔버스 크기를 다시 잰다.
document.addEventListener('fullscreenchange', () => {
    const isFs = !!document.fullscreenElement;
    isRightPaneExpanded = isFs;
    const btn = document.getElementById('right-pane-expand-btn');
    if (btn) {
        btn.classList.toggle('active', isFs);
        btn.title = isFs ? '전체화면 종료' : '전체화면으로 보기';
        btn.innerHTML = isFs ? '<i class="fa-solid fa-compress"></i>' : '<i class="fa-solid fa-expand"></i>';
    }
    setTimeout(() => {
        map.updateSize();
        if (satMap) satMap.updateSize();
    }, 220);
});

// ---------- 카카오 로드뷰 ----------
// kakao_sdk.js는 index.html에서 <script src="./kakao_sdk.js">로 이미 로드되어 있다
// (DS-LandInfo와 동일한 방식 — appkey/도메인 등록 없이 동작하는 로컬 벤더 SDK).
let isRoadviewMode = false;
// 로드뷰 사용 중 "시설물 선택" 서브모드 — 켜져 있으면 지도 클릭이 로드뷰
// 이동이 아니라 그 위치의 시설물 정보/첨부파일 열기로 바뀐다.
let isFacilitySelectMode = false;
let rvVectorLayer = null;
let currentRv = null;

function createRvMarkerSvgUrl() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
<polygon points="24,2 31,16 17,16" fill="#FF6B00" opacity="0.9"/>
<circle cx="24" cy="26" r="13" fill="white" stroke="#FF6B00" stroke-width="2"/>
<circle cx="24" cy="26" r="9" fill="#FF6B00"/>
<circle cx="24" cy="26" r="3" fill="white"/>
</svg>`.trim();
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// 로드뷰 모드에서 지도 위에 뜨는 마우스 커서 — 카카오맵 로드뷰 배치 커서와
// 비슷한 느낌(파란 핀+흰 원)으로 별도 제작한 아이콘(카카오 원본 이미지를 직접
// 쓸 수는 없어 비슷한 스타일로 새로 그림). 핀 끝(뾰족한 아래쪽)이 실제 클릭
// 지점과 겹치도록 커서 hotspot을 핀 끝 좌표로 맞춘다.
const ROADVIEW_CURSOR = (() => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 34 44">
<ellipse cx="17" cy="39" rx="6" ry="2" fill="rgba(0,0,0,0.3)"/>
<path d="M17 2C9.27 2 3 8.27 3 16c0 10.5 14 24 14 24s14-13.5 14-24C31 8.27 24.73 2 17 2z" fill="#2f8ae0" stroke="#ffffff" stroke-width="2.5"/>
<circle cx="17" cy="16" r="6.5" fill="#ffffff"/>
</svg>`.trim();
    return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}") 17 39, crosshair`;
})();

function updateRvMarker(lat, lng, headingDeg) {
    const feature = rvVectorLayer.getSource().getFeatures()[0];
    feature.getGeometry().setCoordinates(ol.proj.fromLonLat([lng, lat]));
    feature.setStyle(new ol.style.Style({
        image: new ol.style.Icon({ src: createRvMarkerSvgUrl(), scale: 1, rotation: (headingDeg * Math.PI) / 180, anchor: [0.5, 0.54] }),
    }));
    rvVectorLayer.setVisible(true);
}

function initRoadview() {
    const rvFeature = new ol.Feature({ geometry: new ol.geom.Point([0, 0]) });
    rvVectorLayer = new ol.layer.Vector({ source: new ol.source.Vector({ features: [rvFeature] }), visible: false, zIndex: 210 });
    map.addLayer(rvVectorLayer);

    const btn = document.getElementById('roadview-btn');
    const facilitySelectMenu = document.getElementById('roadview-facility-select-menu');
    const facilitySelectBtn = document.getElementById('roadview-facility-select-btn');
    btn.addEventListener('click', () => {
        isRoadviewMode = !isRoadviewMode;
        btn.classList.toggle('active', isRoadviewMode);
        const btnText = btn.querySelector('span');

        if (isRoadviewMode) {
            if (btnText) btnText.textContent = '중단';
            map.getTargetElement().style.cursor = ROADVIEW_CURSOR;
            roadviewGuideLayer.setVisible(true);
            // "등록" 버튼의 드롭다운 메뉴와 같은 방식(로드뷰 오른쪽에 붙는 플라이아웃)으로
            // 시설물 선택 버튼을 보여준다.
            facilitySelectMenu.style.display = 'flex';
        } else {
            if (btnText) btnText.textContent = '로드뷰';
            map.getTargetElement().style.cursor = '';
            rvVectorLayer.setVisible(false);
            currentRv = null;
            closeRoadviewPane();
            roadviewGuideLayer.setVisible(false);
            // 로드뷰를 끄면 시설물 선택 서브모드도 같이 초기화한다.
            isFacilitySelectMode = false;
            facilitySelectBtn.classList.remove('active');
            facilitySelectMenu.style.display = 'none';
        }
    });

    facilitySelectBtn.addEventListener('click', () => {
        isFacilitySelectMode = !isFacilitySelectMode;
        facilitySelectBtn.classList.toggle('active', isFacilitySelectMode);
        map.getTargetElement().style.cursor = isFacilitySelectMode ? 'pointer' : ROADVIEW_CURSOR;
    });
    document.getElementById('roadview-facility-panel-close').addEventListener('click', closeRoadviewFacilityPanel);

    // DS-LandInfo와 동일한 패턴: SDK가 이미 로드되어 있으면 바로 실행,
    // 아니면 kakao.maps.load()로 초기화가 끝나길 기다렸다가 실행한다.
    map.on('singleclick', (evt) => {
        if (!isRoadviewMode) return;

        // "시설물 선택" 서브모드에서는 클릭이 로드뷰 이동이 아니라 그 지점의
        // 시설물 마커를 찾아 정보/첨부파일을 여는 데 쓰인다. 다만 로드뷰
        // 자체는 계속 그 위치를 따라가야 자연스러워서(특히 로드뷰를 아직
        // 한 번도 직접 클릭해서 놓아본 적 없는 경우 로드뷰 칸이 계속 빈
        // 채로 남는 문제가 있었다) 클릭한 지점으로 로드뷰도 같이 옮긴다.
        if (isFacilitySelectMode) {
            const feature = map.forEachFeatureAtPixel(evt.pixel, (f) => f, {
                layerFilter: (l) => l === sectionFacilityLayer,
                hitTolerance: 6,
            });
            if (!feature) return;
            openRoadviewFacilityInfo(feature);
            const [lng, lat] = ol.proj.toLonLat(evt.coordinate);
            if (typeof kakao !== 'undefined' && kakao.maps) {
                kakao.maps.load(() => openRoadviewAt(lat, lng));
            }
            return;
        }

        const [lng, lat] = ol.proj.toLonLat(evt.coordinate);

        if (typeof kakao !== 'undefined' && kakao.maps) {
            kakao.maps.load(() => openRoadviewAt(lat, lng));
        } else {
            uiAlert('카카오맵 SDK 로드 실패. 네트워크 연결을 확인해주세요.');
        }
    });
}

// 로드뷰의 "시설물 선택" 모드에서 지도의 시설물을 클릭했을 때 — 로드뷰를 끄지
// 않고 그 아래에 속성정보/첨부파일 패널을 붙여서(위아래 분할) 같이 보여준다.
// openFacilityMarkerFiles와 조회 로직은 동일하지만, 그쪽은 로드뷰/위성 패널을
// 닫고 파일미리보기 패널로 완전히 전환하는 반면 이 함수는 로드뷰 패널을 그대로
// 둔 채 그 아래에만 결과를 채운다.
async function openRoadviewFacilityInfo(feature) {
    const table = feature.get('facilityTable');
    const facilityRdid = feature.get('facilityRdid');
    if (!table || !facilityRdid) return;

    // 로드뷰를 아직 한 번도 직접 클릭해서 놓아본 적이 없으면 분할화면
    // 자체가 안 열려있는 상태다 — 이 함수 혼자서도(호출한 쪽이 로드뷰를
    // 먼저 열어줬는지와 무관하게) 패널이 반드시 보이도록 미리 열어둔다.
    if (!isSplitOpen) toggleSplitView();
    document.getElementById('roadview-wrap').style.display = 'flex';

    let files = [];
    let facilityInfo = null;
    try {
        const params = new URLSearchParams({ table, facility_rdid: facilityRdid });
        const [filesData, detailData] = await Promise.all([
            fetch('/api/sections/facility-files?' + params.toString()).then((r) => r.json()),
            fetch('/api/sections/facility-detail?' + params.toString()).then((r) => r.json()),
        ]);
        files = filesData.files || [];
        if (detailData.record) {
            facilityInfo = { label: detailData.record.label, name: detailData.record.name, attributes: detailData.record.attributes, table: detailData.record.table, rdid: detailData.record.rdid };
        }
    } catch (e) { return; }
    if (!files.length && !facilityInfo) return;

    highlightFacilityFeature(new ol.Feature({ geometry: feature.getGeometry().clone() }));

    const fLabel = feature.get('label') || '시설물';
    const fName = feature.get('name');
    const title = fName ? `${fName}(${fLabel})` : fLabel;

    let mediaHtml;
    if (files.length) {
        const itemsHtml = files.map((f) => {
            const viewUrl = `/api/sections/facility-files/${f.id}?inline=1`;
            const downloadUrl = `/api/sections/facility-files/${f.id}`;
            const media = buildFilePreviewMediaHtml(f.original_name, viewUrl, downloadUrl, 'width:100%;max-height:420px;');
            return `
                <div class="fm-gallery-item">
                    <div class="fm-gallery-item-label"><span>${escapeHtml(f.file_kind)}</span><span>${escapeHtml(f.original_name)}</span><button type="button" class="fm-file-del" data-id="${f.id}" data-name="${escapeHtml(f.original_name)}" data-table="${escapeHtml(table)}" data-rdid="${escapeHtml(facilityRdid)}" title="이 파일 삭제 (편집 모드)"><i class="fa-solid fa-trash"></i></button></div>
                    ${media}
                </div>`;
        }).join('');
        mediaHtml = `<div class="facility-file-media fm-gallery">
            <div class="fm-file-list-title">${escapeHtml(title)} 첨부파일 (${files.length})</div>
            ${itemsHtml}
        </div>`;
    } else {
        mediaHtml = `
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:30px 20px;color:var(--text-secondary);">
                <i class="fa-solid fa-circle-info" style="font-size:2.5rem;color:var(--text-muted);"></i>
                <div>${escapeHtml(title)}<br>첨부된 사진·보고서가 없습니다.</div>
            </div>`;
    }

    const infoBarHtml = facilityInfo ? buildFacilityInfoBarHtml(facilityInfo) : '';
    document.getElementById('roadview-facility-panel-title').textContent = title;
    const roadviewPanelBody = document.getElementById('roadview-facility-panel-body');
    roadviewPanelBody.innerHTML = infoBarHtml + mediaHtml;
    initVideo360Containers(roadviewPanelBody);
    document.getElementById('roadview-facility-panel').style.display = 'flex';
    document.getElementById('roadview-panel-resizer').style.display = 'flex';
    // 이 서브패널 자체 헤더에도 닫기(X)가 있어서, 우측 상단의 분할화면 공용
    // 닫기 버튼(#right-pane-close-btn)과 같은 자리에서 겹친다 — 열려있는
    // 동안엔 공용 버튼을 그 아래로 내린다(style.css 참고).
    document.getElementById('right-pane').classList.add('roadview-facility-open');
}

// ---------- 로드뷰 도로 가이드(파란선) 오버레이 ----------
// 다음(카카오) 로드뷰 커버리지 타일(PNGSD_RV02)을 우리 OpenLayers 지도의
// 네이티브 타일 레이어로 직접 붙인다. 다음 지도는 EPSG:5181(GRS80 TM,
// +proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80)
// 좌표계의 자체 타일 그리드를 쓰고, 우리 지도는 EPSG:3857(Web Mercator)이라
// 두 그리드가 서로 안 맞는다. 처음엔 "우리 타일 하나마다 그 중심에 해당하는
// 카카오 타일 하나를 늘려서 채우는" 방식으로 구현했는데, 이러면 (1) 위도에
// 따라 실제 지상 거리가 달라지는 Web Mercator 해상도를 그대로 카카오 실측
// 미터 해상도와 비교해서 줌 레벨을 잘못 고르고 (2) 타일 경계가 서로 안 맞아
// 타일 가장자리로 갈수록 어긋나는 문제가 있었다. 그래서 카카오 좌표계(TM)를
// OpenLayers에 정식 프로젝션으로 등록하고, 카카오의 실제 타일 그리드(원점/
// 해상도)를 그대로 정의한 뒤, OpenLayers의 표준 재투영(reproject) 기능이
// TM → Web Mercator 워핑을 제대로 처리하도록 한다. 재투영은 픽셀을 직접
// 읽지 않고 삼각분할된 조각을 canvas drawImage로 그리는 방식이라 다음
// CDN이 CORS 헤더를 안 보내도 문제없이 동작한다.
proj4.defs('KAKAOTM', '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +units=m +no_defs');
ol.proj.proj4.register(proj4);
ol.proj.get('KAKAOTM').setExtent([-100000, -100000, 600000, 900000]); // 대한민국 전역을 넉넉히 포함

// 다음 타일 그리드 원점(TM, 미터) — 서울(위도 37.5665, 경도 126.9780) 기준
// 카카오 level 4에서 실측한 타일(V=999,H=445) 내부의 정확한 world-pixel
// 위치로부터 역산. H는 동쪽으로, V는 "북쪽으로" 증가한다(표준 XYZ의 남쪽
// 증가와 반대) — 처음 역산할 때 이 축 반전을 놓쳐서 Y축 원점이 타일 약
// 0.55개(레벨4 기준 약 280m) 어긋나 있었다. 축소 상태에선 오차가 타일
// 하나보다 작아 안 드러나다가, 확대해서 개별 건물이 보일 정도가 되면
// 도로에서 눈에 띄게 벗어나 보였던 원인. 서울/부산/해남 세 지점을 레벨
// 1(가장 정밀)에서 실측 DOM 좌표와 대조해 1m 이내로 재검증함.
const KAKAO_RV_ORIGIN_X = -29999.63326297296;
const KAKAO_RV_ORIGIN_Y = -59998.969411283616;
const KAKAO_RV_MIN_LEVEL = 1; // 카카오 level: 작을수록 확대(표준 XYZ와 반대)
const KAKAO_RV_MAX_LEVEL = 14;
// level 7 이상(더 축소된 상태)에서는 다음 로드뷰 타일 자체가 개별 도로를
// 정밀하게 따라가지 않고 넓은 지역을 직선으로 뭉뚱그려 단순화해서 그린다
// (실제 카카오맵에서 같은 위치·줌으로 직접 띄워서 확인함 — 강/바다를 직선으로
// 가로지르는 것도 카카오 원본 타일 자체의 특성이지 좌표 변환 오류가 아니다).
// 안내선 용도에는 부적절하므로 이 줌보다 축소되면 레이어 자체를 숨긴다.
const KAKAO_RV_DISPLAY_MAX_LEVEL = 6;

function kakaoRvResolution(level) { return Math.pow(2, level - 3); } // m/px, TM 실측 미터 기준

let roadviewGuideLayer = null;
let cadastralEditLayer = null; // 지적편집도(카카오 PNGSD_CAD02) — 기본 레이어 패널에서 켜고 끔

// 로드뷰 안내선과 지적편집도가 같은 카카오 타일 그리드·좌표계를 쓰므로 공통으로 만든다.
// tilePath: 카카오 타일 종류/버전(kakao_sdk.js의 URI_FUNC 값), displayMaxLevel: 이보다 축소되면 숨김.
// 주소는 https — 로드뷰도 예전엔 http였는데 운영을 HTTPS로 바꾸면 혼합 콘텐츠로 막힐 수 있었다.
function createKakaoTileLayer({ tilePath, displayMaxLevel, opacity, zIndex, urlOf, visible }) {
    // z=0이 가장 축소(level=14, 해상도 큼), z가 커질수록 확대(level=1, 해상도 작음) —
    // OpenLayers TileGrid는 resolutions가 z 증가에 따라 감소해야 한다.
    const levelByZ = [];
    const resolutions = [];
    for (let level = KAKAO_RV_MAX_LEVEL; level >= KAKAO_RV_MIN_LEVEL; level--) {
        levelByZ.push(level);
        resolutions.push(kakaoRvResolution(level));
    }
    const tileGrid = new ol.tilegrid.TileGrid({
        origin: [KAKAO_RV_ORIGIN_X, KAKAO_RV_ORIGIN_Y],
        resolutions,
        tileSize: 256,
    });
    const source = new ol.source.TileImage({
        projection: 'KAKAOTM',
        tileGrid,
        tileUrlFunction: (tileCoord) => {
            if (!tileCoord) return undefined;
            const [z] = tileCoord;
            const level = levelByZ[z];
            const extent = tileGrid.getTileCoordExtent(tileCoord);
            const cell = resolutions[z] * 256;
            const H = Math.floor(((extent[0] + extent[2]) / 2 - KAKAO_RV_ORIGIN_X) / cell);
            const V = Math.floor(((extent[1] + extent[3]) / 2 - KAKAO_RV_ORIGIN_Y) / cell);
            return urlOf ? urlOf(level, V, H) : `https://mts.daumcdn.net/api/v1/tile/${tilePath}/latest/${level}/${V}/${H}.png`;
        },
    });
    // 카카오 level(displayMaxLevel)의 실측 지상 해상도를, 우리 지도의 명목
    // Web Mercator 해상도로 환산해 레이어 표시 상한으로 쓴다(위도에 따라 실제
    // 지상 거리가 달라지므로 투영법 기준위도(38도)로 환산 — 안전 마진용 근사치).
    const maxResolution = displayMaxLevel
        ? kakaoRvResolution(displayMaxLevel) / Math.cos(38 * Math.PI / 180)
        : undefined;

    return new ol.layer.Tile({ source, visible: !!visible, opacity, zIndex, maxResolution });
}

// ---------- 카카오 배경지도(일반/위성) ----------
// 기본 배경지도는 브이월드이고, 왼쪽 도구 모음의 제공처 버튼으로 카카오맵 일반·위성(스카이뷰)으로 바꿔 볼 수 있다.
// 지적편집도·로드뷰 안내선과 같은 카카오 타일 그리드를 쓰므로 같은 생성기(createKakaoTileLayer)를 쓴다.
//   일반   : PNGSD02 (kakao_sdk.js URI_FUNC.ROADMAP)
//   위성   : map_skyview 항공사진 + 지명·도로명 글자 타일(PNGSD_SKYH02, URI_FUNC.HYBRID)을 위에 겹친다
function createKakaoBaseLayer() {
    return createKakaoTileLayer({ tilePath: 'PNGSD02/v19_ktmbq', displayMaxLevel: null, opacity: 1, zIndex: 0, visible: false });
}
function createKakaoSkyviewLayer() {
    return createKakaoTileLayer({
        displayMaxLevel: null, opacity: 1, zIndex: 0, visible: false,
        urlOf: (level, V, H) => `https://map.daumcdn.net/map_skyview/L${level}/${V}/${H}.jpg?v=160114`,
    });
}
function createKakaoSkyviewLabelLayer() {
    return createKakaoTileLayer({ tilePath: 'PNGSD_SKYH02/v19_nzhdi', displayMaxLevel: null, opacity: 1, zIndex: 1, visible: false });
}

function createRoadviewGuideLayer() {
    return createKakaoTileLayer({ tilePath: 'PNGSD_RV02/v16_83b8i', displayMaxLevel: KAKAO_RV_DISPLAY_MAX_LEVEL, opacity: 0.6, zIndex: 15 });
}

// 지적편집도 — 용도지역 색과 지역 이름이 입혀진 카카오 지도 타일(반투명 배경 포함). 모든 축척에서
// 표시하고, 우리 데이터(용도지역 80·건물 85·경계/도로망 90·구간 100~)가 그 위에 보이도록 70에 깐다.
function createCadastralEditLayer() {
    return createKakaoTileLayer({ tilePath: 'PNGSD_CAD02/v17_sgbh6', displayMaxLevel: null, opacity: 0.8, zIndex: 70 });
}

function openRoadviewAt(lat, lng) {
    const rvDiv = document.getElementById('roadview-div');
    if (!isSplitOpen) toggleSplitView();
    document.getElementById('sat_map').style.display = 'none';
    document.getElementById('cctv-preview-div').style.display = 'none';
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    document.getElementById('file-preview-div').innerHTML = ''; // 360도 영상이 열려있었다면 렌더 루프 정리
    document.getElementById('roadview-wrap').style.display = 'flex';

    const rv = new kakao.maps.Roadview(rvDiv);
    const rvClient = new kakao.maps.RoadviewClient();
    const position = new kakao.maps.LatLng(lat, lng);

    rvClient.getNearestPanoId(position, 50, (panoId) => {
        if (panoId === null) {
            rvDiv.innerHTML = '<div style="display:flex;height:100%;align-items:center;justify-content:center;color:#555;font-weight:bold;padding:20px;text-align:center;">주변 50m 내에 로드뷰가 없습니다.</div>';
            rvVectorLayer.setVisible(false);
            return;
        }
        rv.setPanoId(panoId, position);
        currentRv = rv;
        updateRvMarker(lat, lng, 0);

        kakao.maps.event.addListener(rv, 'viewpoint_changed', () => {
            try {
                const vp = rv.getViewpoint();
                const pos = rv.getPosition();
                if (pos) updateRvMarker(pos.getLat(), pos.getLng(), vp.pan);
            } catch (e) { /* noop */ }
        });
        kakao.maps.event.addListener(rv, 'position_changed', () => {
            setTimeout(() => {
                try {
                    const pos = rv.getPosition();
                    if (!pos) return;
                    const vp = rv.getViewpoint();
                    updateRvMarker(pos.getLat(), pos.getLng(), vp ? vp.pan : 0);
                    map.getView().animate({ center: ol.proj.fromLonLat([pos.getLng(), pos.getLat()]), duration: 300 });
                } catch (e) { /* noop */ }
            }, 300);
        });
    });
}

function closeRoadviewPane() {
    const rvDiv = document.getElementById('roadview-div');
    rvDiv.innerHTML = '';
    document.getElementById('roadview-wrap').style.display = 'none';
    closeRoadviewFacilityPanel();
    if (isSplitOpen) toggleSplitView();
}

// 로드뷰 "시설물 선택" 모드에서 연 정보/첨부파일 패널을 닫는다 — 로드뷰
// 자체는 그대로 유지된다(로드뷰를 끄는 closeRoadviewPane과는 다름).
function closeRoadviewFacilityPanel() {
    document.getElementById('roadview-facility-panel').style.display = 'none';
    document.getElementById('roadview-facility-panel-body').innerHTML = '';
    document.getElementById('roadview-panel-resizer').style.display = 'none';
    // 다음에 다시 열 때는 기본 비율(42%)로 돌아가게 드래그로 바꿔둔 높이를 지운다.
    document.getElementById('roadview-facility-panel').style.flex = '';
    document.getElementById('right-pane').classList.remove('roadview-facility-open');
}

// 로드뷰 시설물 정보 패널과 로드뷰 사이의 드래그 리사이저 — file-preview-div의
// facility-info-resizer와 같은 이유로 mousemove/mouseup 대신 Pointer Events +
// setPointerCapture를 쓴다(로드뷰 위젯이 캔버스/iframe이라 커서가 그 위를
// 지나가면 일반 마우스 이벤트가 부모로 안 올라올 수 있음).
function initRoadviewPanelResizer() {
    const wrap = document.getElementById('roadview-wrap');
    const resizer = document.getElementById('roadview-panel-resizer');
    const panel = document.getElementById('roadview-facility-panel');
    let dragging = false;
    resizer.addEventListener('pointerdown', (e) => {
        dragging = true;
        resizer.classList.add('active');
        try { resizer.setPointerCapture(e.pointerId); } catch (err) { /* no-op */ }
        e.preventDefault();
    });
    resizer.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const top = wrap.getBoundingClientRect().top;
        const height = Math.min(wrap.clientHeight - 80, Math.max(80, e.clientY - top));
        panel.style.flex = `0 0 ${height}px`;
    });
    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove('active');
        if (e && resizer.hasPointerCapture(e.pointerId)) resizer.releasePointerCapture(e.pointerId);
    };
    resizer.addEventListener('pointerup', endDrag);
    resizer.addEventListener('pointercancel', endDrag);
}

// ---------- 관리자 기능 ----------
// 관리자 모드 토글(상단 방패 아이콘)은 지도에서 구간을 등록·수정·삭제하는 "편집 모드"만
// 켠다. 계정관리·접속/변경 이력·일괄등록은 지도 사이드바가 아니라 별도 전체 화면인
// 관리 콘솔(#admin-console)에서 한다 — 열 때 비밀번호 재인증을 받는다.
function initAdminMode() {
    const toggleBtn = document.getElementById('admin-mode-toggle');
    if (!currentUser || currentUser.role !== 'admin') return;

    toggleBtn.style.display = '';
    toggleBtn.addEventListener('click', () => {
        const isOn = document.body.classList.toggle('admin-mode');
        toggleBtn.classList.toggle('active', isOn);
        applySectionFormEditability();
    });

    initAdminConsole();
    document.getElementById('audit-log-refresh-btn').addEventListener('click', () => loadAuditLog(1));
    document.getElementById('audit-log-action-filter').addEventListener('change', () => loadAuditLog(1));
    document.getElementById('audit-log-from').addEventListener('change', () => loadAuditLog(1));
    document.getElementById('audit-log-to').addEventListener('change', () => loadAuditLog(1));
    document.getElementById('audit-log-export-btn').addEventListener('click', downloadAuditLog);
    document.getElementById('audit-retention-toggle').addEventListener('click', toggleAuditRetention);
    initAccountsTab();
}

// ---------- 관리 콘솔 + 재인증 ----------
// 서버는 관리 API(계정·이력·일괄등록)에 "최근 15분 안에 재인증했는지"를 검사하고, 관리
// 작업을 할 때마다 그 시간을 다시 늘린다(middleware/requireAuth.js). 화면은 콘솔을 열 때
// 미리 묻고, 작업 중에 만료되면(REAUTH_REQUIRED) adminFetch가 재인증 창을 띄운 뒤 같은
// 요청을 한 번 다시 보낸다.
const CONSOLE_DEFAULT_SECTION = 'dashboardview-tab';
let reauthWaiter = null; // 열려 있는 재인증 창의 { promise, resolve } — 동시에 여러 요청이 만료돼도 창은 하나

function initAdminConsole() {
    const btn = document.getElementById('admin-console-btn');
    btn.style.display = '';
    btn.addEventListener('click', () => openAdminConsole());
    document.getElementById('console-close-btn').addEventListener('click', closeAdminConsole);
    document.querySelectorAll('.console-nav-btn').forEach((b) => {
        b.addEventListener('click', () => showConsoleSection(b.dataset.section));
    });
    document.getElementById('console-user').textContent = currentUser.displayName || currentUser.username;
    document.getElementById('rp-stats-btn').addEventListener('click', downloadStatsExcel);
    document.getElementById('rp-checks-btn').addEventListener('click', runDataChecks);
    document.getElementById('datamgmt-refresh-btn').addEventListener('click', () => { loadDataMgmtList(); loadTrashList(); });
    document.querySelectorAll('.dm-mode-btn').forEach((b) => b.addEventListener('click', () => setDataMgmtMode(b.dataset.dm)));
    document.getElementById('dashboard-refresh-btn').addEventListener('click', loadDashboard);
    document.getElementById('quality-refresh-btn').addEventListener('click', loadQualitySummary);
    document.getElementById('importhistory-refresh-btn').addEventListener('click', loadImportHistory);
    document.getElementById('datamgmt-delete-btn').addEventListener('click', deleteSelectedRoutes);

    const pw = document.getElementById('reauth-password');
    document.getElementById('reauth-submit').addEventListener('click', submitReauth);
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitReauth(); });
    document.getElementById('reauth-cancel').addEventListener('click', () => finishReauth(false));
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (document.getElementById('reauth-modal').classList.contains('open')) finishReauth(false);
        else if (document.getElementById('admin-console').classList.contains('open')) closeAdminConsole();
    });
}

async function openAdminConsole(section) {
    let status = { valid: false };
    try { status = await fetch('/api/auth/reauth-status').then((r) => r.json()); } catch (e) { /* 아래에서 재인증 */ }
    if (!status.valid && !(await requestReauth())) return;
    document.getElementById('admin-console').classList.add('open');
    showConsoleSection(section || document.querySelector('.console-nav-btn.active')?.dataset.section || CONSOLE_DEFAULT_SECTION);
}

function closeAdminConsole() {
    document.getElementById('admin-console').classList.remove('open');
}

function showConsoleSection(sectionId) {
    document.querySelectorAll('.console-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.section === sectionId));
    document.querySelectorAll('.console-section').forEach((s) => { s.style.display = s.id === sectionId ? 'flex' : 'none'; });
    // 일괄등록은 진행 중인 검수 상태를 유지해야 해서 다시 불러오지 않는다.
    if (sectionId === 'accountsview-tab') loadAccountsList();
    else if (sectionId === 'auditlogview-tab') loadAuditLog(1);
    else if (sectionId === 'reportsview-tab') loadChecksStatus();
    else if (sectionId === 'datamgmtview-tab') { loadDataMgmtList(); loadTrashList(); }
    else if (sectionId === 'dashboardview-tab') loadDashboard();
    else if (sectionId === 'qualityview-tab') loadQualitySummary();
    else if (sectionId === 'importhistoryview-tab') loadImportHistory();
}

// 재인증 창을 띄우고 결과(true=성공, false=취소)를 돌려준다.
function requestReauth() {
    if (reauthWaiter) return reauthWaiter.promise;
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    reauthWaiter = { promise, resolve };
    document.getElementById('reauth-error').textContent = '';
    const pw = document.getElementById('reauth-password');
    pw.value = '';
    document.getElementById('reauth-modal').classList.add('open');
    setTimeout(() => pw.focus(), 0);
    return promise;
}

function finishReauth(ok) {
    document.getElementById('reauth-modal').classList.remove('open');
    document.getElementById('reauth-password').value = '';
    if (reauthWaiter) { reauthWaiter.resolve(ok); reauthWaiter = null; }
}

async function submitReauth() {
    const pw = document.getElementById('reauth-password');
    const errEl = document.getElementById('reauth-error');
    const btn = document.getElementById('reauth-submit');
    if (!pw.value) { errEl.textContent = '비밀번호를 입력하세요.'; return; }
    btn.disabled = true;
    try {
        const res = await fetch('/api/auth/reauth', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pw.value }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            errEl.textContent = data.error || '재인증에 실패했습니다.';
            pw.select();
            return;
        }
        finishReauth(true);
    } catch (e) {
        errEl.textContent = '서버에 연결할 수 없습니다.';
    } finally {
        btn.disabled = false;
    }
}

// 관리 API 호출용 fetch — 재인증이 만료됐으면 재인증 창을 띄우고, 성공하면 같은 요청을
// 한 번 다시 보낸다(취소하면 원래의 403 응답을 그대로 돌려줘 호출 측이 오류를 표시).
async function adminFetch(input, init) {
    const res = await fetch(input, init);
    if (res.status !== 403) return res;
    const data = await res.clone().json().catch(() => ({}));
    if (data.code !== 'REAUTH_REQUIRED') return res;
    return (await requestReauth()) ? fetch(input, init) : res;
}

// ---------- 지도 하단 저작권 문구 ----------
// 로그인한 계정의 관할 지자체 영문명으로 서버가 만든다(예: "copyright © 2026 HWASEONG CITY.
// All Rights Reserved."). 로그인 화면·관리 콘솔에는 표시하지 않는다. 빈 값이면 숨김.
let mapFooterText = '';
// 저작권 문구 + (카카오 배경지도를 쓸 때) 배경지도 출처 표시
function renderMapFooter() {
    const el = document.getElementById('map-footer');
    if (!el) return;
    const credit = baseProvider === 'kakao' ? '배경지도 © Kakao' : '';
    el.textContent = [mapFooterText, credit].filter(Boolean).join(' · ');
    updateMapFooterPosition();
}
async function loadMapFooter() {
    try {
        const { copyright } = await fetch('/api/auth/site-info').then((r) => r.json());
        mapFooterText = copyright || '';
        renderMapFooter();
    } catch (e) { /* 문구가 없어도 동작에는 영향 없음 */ }
}

// 저작권 문구는 평소 오른쪽 아래 구석에 두고, 왼쪽 아래의 축척·측정 도구와 겹칠 때만 한 줄 위로 올린다.
// 단, 분할 화면을 기본 비율(40%)로 연 상태에서는 겹쳐도 그대로 두고, 분할 비율을 늘려 지도가 더 좁아졌을 때만 올린다
// (예전엔 지도 폭이 640px 이하면 무조건 올려서 분할 화면을 기본 비율로 열기만 해도 문구가 올라갔다).
// 폭이 바뀔 때마다 직접 잰다 — 분할 열기·분할선 끌기·창 크기·측정 도구 접기·문구 길이(시군구 영문명) 모두 반영된다.
function updateMapFooterPosition() {
    const container = document.getElementById('map-container');
    const footer = document.getElementById('map-footer');
    const bar = document.getElementById('map-bottom-bar');
    if (!container || !footer || !bar || !footer.textContent) return;
    const c = container.getBoundingClientRect();
    const barRight = Math.max(...[...bar.children].map((el) => el.getBoundingClientRect().right), bar.getBoundingClientRect().left);
    const footerLeftIfLow = c.right - 12 - footer.offsetWidth; // 구석(오른쪽 12px)에 둘 때 문구의 왼쪽 끝
    const overlap = footerLeftIfLow < barRight + 8;
    const rightPane = document.getElementById('right-pane');
    const splitOpen = !!rightPane && rightPane.offsetWidth > 0 && rightPane.parentElement && rightPane.parentElement.clientWidth > 0;
    const widened = splitOpen && rightPane.offsetWidth / rightPane.parentElement.clientWidth > 0.41; // 기본 40%보다 넓힘
    container.classList.toggle('footer-raised', overlap && (!splitOpen || widened));
}
if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => updateMapFooterPosition());
    ['map-container', 'map-bottom-bar', 'map-footer'].forEach((id) => { const el = document.getElementById(id); if (el) ro.observe(el); });
}
window.addEventListener('resize', updateMapFooterPosition);

// ---------- 계정관리(관리자 전용) ----------
// 새 계정 폼에서 관리자가 시군구명을 검색해 실제로 고른 항목 — 코드를
// 손으로 입력하게 하지 않고, 고른 것만 신뢰해서 서버로 보낸다(직접 타이핑한
// 값을 그대로 믿고 코드를 추측하지 않음 — "중구"처럼 같은 이름이 여러
// 시도에 있어 이름만으로는 하나로 정할 수 없기 때문).
let selectedAccountSigungu = null; // { code5, sido, sgg, full } | null(전체)

function initAccountsTab() {
    document.getElementById('accounts-new-btn').addEventListener('click', () => {
        const form = document.getElementById('account-new-form');
        form.style.display = form.style.display === 'none' ? '' : 'none';
        document.getElementById('account-new-status').textContent = '';
    });
    document.getElementById('account-new-cancel-btn').addEventListener('click', () => {
        document.getElementById('account-new-form').style.display = 'none';
    });
    document.getElementById('account-new-save-btn').addEventListener('click', createAccount);
    initAccountSigunguSearch();
}

function initAccountSigunguSearch() {
    attachSigunguAutocomplete(
        document.getElementById('acc-sigungu-search'),
        document.getElementById('acc-sigungu-suggest'),
        (picked) => { selectedAccountSigungu = picked; }
    );
}

async function loadAccountsList() {
    const listEl = document.getElementById('accounts-list');
    listEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:8px;">불러오는 중...</div>';
    let accounts;
    try {
        const res = await adminFetch('/api/auth/accounts');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '불러오기 실패');
        ({ accounts } = data);
    } catch (e) {
        listEl.innerHTML = `<div style="color:var(--text-muted);font-size:0.8rem;padding:8px;">${escapeHtml(e.message || '불러오기 실패')}</div>`;
        return;
    }
    if (!accounts || !accounts.length) {
        listEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:8px;">등록된 계정이 없습니다.</div>';
        return;
    }
    listEl.innerHTML = '';
    accounts.forEach((acc) => listEl.appendChild(buildAccountRow(acc)));
}

function buildAccountRow(acc) {
    const row = document.createElement('div');
    row.className = 'account-row';
    const isAdmin = acc.role === 'admin';
    const sigungu = acc.sigungu_name || (acc.sigungu_code ? acc.sigungu_code : '전체');
    const created = acc.created_at ? new Date(acc.created_at).toLocaleDateString('ko-KR') : '';
    const isPending = acc.status === 'pending';
    // audit-log-row(변경이력 탭)와 같은 그리드: 배지 + 본문 한 줄, 그 아래
    // 흐린 메타 정보 한 줄 — 관리자용 탭들끼리 같은 디자인 언어를 쓰기 위함.
    row.innerHTML = `
        <div class="acr-top">
            <span class="acc-role${isAdmin ? ' acc-role-admin' : ''}">${isAdmin ? '관리자' : '일반'}</span>
            ${isPending ? '<span class="acc-role acc-role-pending">승인대기</span>' : ''}
            <span class="acc-username">${escapeHtml(acc.username)}</span>
            <span class="acc-display-name">${escapeHtml(acc.display_name || '')}</span>
            ${isPending ? '<button class="acc-approve-btn" title="가입 승인"><i class="fa-solid fa-check"></i> 승인</button>' : ''}
            ${acc.id !== currentUser.id ? '<button class="acc-reset-btn" title="비밀번호 재설정(임시 비밀번호 지정)"><i class="fa-solid fa-key"></i></button>' : ''}
            <button class="acc-del-btn" title="${isPending ? '가입 신청 거절(삭제)' : '계정 삭제'}"><i class="fa-solid fa-trash"></i></button>
        </div>
        <div class="acr-meta">관할: ${escapeHtml(sigungu)}${created ? ` · ${escapeHtml(created)} ${isPending ? '신청' : '생성'}` : ''}</div>
    `;
    const resetBtn = row.querySelector('.acc-reset-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
            const tmp = await uiPrompt(`"${acc.username}"의 임시 비밀번호를 입력하세요(영문·숫자·특수문자 3종류 이상 8자 이상).\n그 계정은 이 비밀번호로 로그인한 뒤 새 비밀번호로 바꿔야 하고, 지금 로그인돼 있는 세션은 모두 끊깁니다.`);
            if (tmp === null) return;
            const res = await adminFetch(`/api/auth/accounts/${acc.id}/reset-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ newPassword: tmp }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) { uiAlert(data.error || '비밀번호 재설정에 실패했습니다.'); return; }
            uiAlert(`재설정되었습니다. 임시 비밀번호를 "${acc.username}" 사용자에게 안전하게 전달하세요.`);
        });
    }
    const approveBtn = row.querySelector('.acc-approve-btn');
    if (approveBtn) {
        approveBtn.addEventListener('click', async () => {
            if (!await uiConfirm(`"${acc.username}" 계정의 가입을 승인하시겠습니까?\n승인하면 관할(${sigungu})의 데이터를 조회할 수 있게 됩니다.`)) return;
            const res = await adminFetch(`/api/auth/accounts/${acc.id}/approve`, { method: 'POST' });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                uiAlert(data.error || '승인에 실패했습니다.');
                return;
            }
            loadAccountsList();
        });
    }
    row.querySelector('.acc-del-btn').addEventListener('click', async () => {
        if (!await uiConfirm(`계정 "${acc.username}"을(를) 삭제하시겠습니까?`)) return;
        const res = await adminFetch(`/api/auth/accounts/${acc.id}`, { method: 'DELETE' });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            uiAlert(data.error || '삭제에 실패했습니다.');
            return;
        }
        loadAccountsList();
    });
    return row;
}

async function createAccount() {
    const username = document.getElementById('acc-username').value.trim();
    const password = document.getElementById('acc-password').value;
    const displayName = document.getElementById('acc-display-name').value.trim();
    const role = document.getElementById('acc-role').value;
    const sigunguSearchVal = document.getElementById('acc-sigungu-search').value.trim();
    const statusEl = document.getElementById('account-new-status');
    if (!username || !password) {
        statusEl.textContent = '아이디와 비밀번호를 입력하세요.';
        return;
    }
    // 검색창에 글자는 남아있는데 목록에서 실제로 고르지 않았으면(선택이
    // 비어있으면) 관할을 짐작해서 보내지 않는다 — 잘못된 코드로 등록되는
    // 것보다는 저장을 막고 다시 고르게 하는 게 안전하다.
    if (sigunguSearchVal && !selectedAccountSigungu) {
        statusEl.textContent = '목록에서 시군구를 선택하세요(비우면 전체 관할).';
        return;
    }
    statusEl.textContent = '저장 중...';
    const sigunguCode = selectedAccountSigungu ? selectedAccountSigungu.code5 : '';
    const res = await adminFetch('/api/auth/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, displayName, role, sigunguCode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        statusEl.textContent = data.error || '저장에 실패했습니다.';
        return;
    }
    document.getElementById('acc-username').value = '';
    document.getElementById('acc-password').value = '';
    document.getElementById('acc-display-name').value = '';
    document.getElementById('acc-role').value = 'user';
    document.getElementById('acc-sigungu-search').value = '';
    selectedAccountSigungu = null;
    document.getElementById('account-new-form').style.display = 'none';
    loadAccountsList();
}

const AUDIT_ACTION_LABELS = {
    create: '등록', update: '수정', delete: '삭제', bulk_import: '일괄등록', bulk_undo: '일괄등록 취소', restore: '복원',
    maint_create: '점검·보수 등록', maint_update: '점검·보수 수정', maint_delete: '점검·보수 삭제',
    login: '로그인', login_fail: '로그인 실패', logout: '로그아웃',
    signup: '가입 신청', approve: '가입 승인', account_create: '계정 생성', account_delete: '계정 삭제',
    password_change: '비밀번호 변경', password_reset: '비밀번호 재설정',
    log_export: '이력 다운로드', log_purge: '이력 정리', admin_reauth: '관리자 재인증', export: '자료 내려받기',
};

// 화면 목록과 다운로드가 같은 조건(작업 종류 + 기간)을 쓴다.
function auditLogFilterParams() {
    const params = new URLSearchParams();
    const action = document.getElementById('audit-log-action-filter').value;
    const from = document.getElementById('audit-log-from').value;
    const to = document.getElementById('audit-log-to').value;
    if (action) params.set('action', action);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return params;
}

// 지금 조건의 이력을 CSV(텍스트) 파일로 저장 — 서버가 내려받은 사실도 이력에 남긴다.
async function downloadAuditLog() {
    const btn = document.getElementById('audit-log-export-btn');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-hourglass-half"></i> 생성 중';
    try {
        const res = await adminFetch('/api/audit-log/export?' + auditLogFilterParams().toString());
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            uiAlert(data.error || '이력 다운로드에 실패했습니다.');
            return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const cd = res.headers.get('Content-Disposition') || '';
        const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
        a.download = m ? decodeURIComponent(m[1]) : '변경접속이력.csv';
        a.click();
        URL.revokeObjectURL(url);
        loadAuditLog(1); // 방금 남은 "이력 다운로드" 기록까지 목록에 반영
    } catch (e) {
        uiAlert('이력 다운로드 중 오류가 발생했습니다.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
}

// ---------- 이력 보관·정리 ----------
async function toggleAuditRetention() {
    const panel = document.getElementById('audit-retention-panel');
    if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
    panel.style.display = '';
    await renderAuditRetention();
}

async function renderAuditRetention() {
    const panel = document.getElementById('audit-retention-panel');
    panel.textContent = '불러오는 중...';
    let d;
    try {
        const res = await adminFetch('/api/audit-log/retention');
        d = await res.json();
        if (!res.ok) throw new Error(d.error || '불러오기 실패');
    } catch (e) { panel.textContent = e.message || '불러오기 실패'; return; }

    const files = (d.files || []).map((f) => `<div class="ar-file"><button type="button" data-name="${escapeHtml(f.name)}">${escapeHtml(f.name)}</button><span>${fmtBytes(f.bytes)} · ${fmtDateTimeKo(f.savedAt)}</span></div>`).join('');
    panel.innerHTML = `
        <div>접속·변경 이력은 <b>최소 ${d.minKeepDays}일(1년)</b> 보관해야 합니다. 1년이 지난 이력은 파일(CSV)로 안전하게 저장한 뒤 DB에서 정리해 목록을 가볍게 할 수 있습니다. 저장이 끝난 것을 확인한 뒤에만 지우며, 1년이 안 된 이력은 지울 수 없습니다.</div>
        <div class="ar-stats"><span>전체 ${d.total.toLocaleString()}건</span><span>가장 오래된 이력 ${escapeHtml(d.oldest || '-')}</span><span>정리 가능(${escapeHtml(d.latestCutoff)} 이전) ${d.eligible.toLocaleString()}건</span></div>
        ${d.canPurge ? `<div class="ar-run"><label>이 날짜 이전 이력을 <input type="date" id="ar-before" value="${escapeHtml(d.latestCutoff)}" max="${escapeHtml(d.latestCutoff)}"></label><button type="button" id="ar-run-btn"${d.eligible ? '' : ' disabled'}>파일로 보관하고 정리</button></div>` : '<div class="ar-dir">관할이 제한된 관리자는 이력을 정리할 수 없습니다(전체 권한 관리자만 가능).</div>'}
        ${d.canPurge ? `<div class="ar-dir">보관 폴더(서버): ${escapeHtml(d.archiveDir || '')}</div>` : ''}
        ${files ? `<div class="ar-files"><b>보관된 파일</b>${files}</div>` : ''}`;

    panel.querySelectorAll('.ar-file button').forEach((b) => b.addEventListener('click', () => downloadAuditArchive(b.dataset.name)));
    const run = document.getElementById('ar-run-btn');
    if (run) run.addEventListener('click', async () => {
        const before = document.getElementById('ar-before').value;
        if (!before) { uiAlert('날짜를 선택하세요.'); return; }
        if (!await uiConfirm(`${before} 이전의 변경·접속 이력을 파일로 저장한 뒤 DB에서 삭제합니다.\n저장된 파일은 서버 보관 폴더에 남습니다. 계속하시겠습니까?`)) return;
        run.disabled = true;
        run.textContent = '저장 중...';
        try {
            const res = await adminFetch('/api/audit-log/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ before }) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '정리 실패');
            uiAlert(`${data.saved.toLocaleString()}건을 ${data.fileName} 파일로 저장하고 DB에서 정리했습니다.`);
        } catch (e) { uiAlert(e.message || '정리 실패'); }
        await renderAuditRetention();
        loadAuditLog(1);
    });
}

async function downloadAuditArchive(name) {
    try {
        const res = await adminFetch('/api/audit-log/archive-files/' + encodeURIComponent(name));
        if (!res.ok) { const data = await res.json().catch(() => ({})); uiAlert(data.error || '다운로드 실패'); return; }
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = url; a.download = name; a.click();
        URL.revokeObjectURL(url);
    } catch (e) { uiAlert('다운로드 중 오류가 발생했습니다.'); }
}

async function loadAuditLog(page) {
    const listEl = document.getElementById('audit-log-list');
    listEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:8px;">불러오는 중...</div>';
    let data;
    try {
        const params = auditLogFilterParams();
        params.set('page', String(page));
        params.set('size', '30');
        const res = await adminFetch('/api/audit-log?' + params.toString());
        data = await res.json();
        if (!res.ok) throw new Error(data.error || '불러오기 실패');
    } catch (e) {
        listEl.innerHTML = `<div style="color:var(--text-muted);font-size:0.8rem;padding:8px;">${escapeHtml(e.message || '불러오기 실패')}</div>`;
        document.getElementById('audit-log-pagination').innerHTML = '';
        return;
    }
    const items = data.items || [];
    if (!items.length) {
        listEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:8px;">기록이 없습니다.</div>';
        document.getElementById('audit-log-pagination').innerHTML = '';
        return;
    }
    listEl.innerHTML = '';
    items.forEach((it) => listEl.appendChild(renderAuditLogRow(it)));
    renderAuditLogPager(data.total || 0, page, data.totalPages || 1);
}

function renderAuditLogRow(item) {
    const row = document.createElement('div');
    row.className = 'audit-log-row';
    const time = new Date(item.created_at).toLocaleString('ko-KR', { hour12: false });
    row.innerHTML = `
        <div class="alr-top">
            <span class="alr-badge action-${escapeHtml(item.action)}">${escapeHtml(AUDIT_ACTION_LABELS[item.action] || item.action)}</span>
            <span class="alr-summary">${escapeHtml(item.summary)}</span>
        </div>
        <div class="alr-meta">${escapeHtml(time)} · ${escapeHtml(item.username || '알 수 없음')}${item.sigungu_code ? ' · ' + escapeHtml(item.sigungu_code) : ''}${item.ip ? ' · IP ' + escapeHtml(item.ip) : ''}</div>
    `;
    return row;
}

function renderAuditLogPager(total, page, totalPages) {
    const pagerEl = document.getElementById('audit-log-pagination');
    pagerEl.innerHTML = `
        <button id="al-prev-btn" ${page <= 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button>
        <span>${page.toLocaleString()} / ${totalPages.toLocaleString()} 페이지 (총 ${total.toLocaleString()}건)</span>
        <button id="al-next-btn" ${page >= totalPages ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button>
    `;
    document.getElementById('al-prev-btn').addEventListener('click', () => loadAuditLog(page - 1));
    document.getElementById('al-next-btn').addEventListener('click', () => loadAuditLog(page + 1));
}

// ---------- 일괄등록 이력과 되돌리기 ----------
const IMPORT_STATUS = {
    running: ['진행 중', 'warn'], applied: ['적용됨', 'ok'], undone: ['취소됨', 'unknown'],
    expired: ['보관 기간 지남', 'unknown'], failed: ['저장된 것 없음', 'error'],
};

async function loadImportHistory() {
    const el = document.getElementById('importhistory-list');
    el.innerHTML = '<div class="dash-empty">불러오는 중...</div>';
    let d;
    try {
        const res = await adminFetch('/api/admin/imports');
        d = await res.json();
        if (!res.ok) throw new Error(d.error || '불러오기 실패');
    } catch (e) {
        el.innerHTML = `<div class="dash-empty">${escapeHtml(e.message || '불러오기 실패')}</div>`;
        return;
    }
    if (!d.batches.length) {
        el.innerHTML = '<div class="dash-empty">아직 일괄등록 이력이 없습니다. 이 기능 적용 이후의 등록부터 기록됩니다.</div>';
        return;
    }
    el.innerHTML = '';
    d.batches.forEach((b) => {
        const [label, cls] = IMPORT_STATUS[b.status] || [b.status, 'unknown'];
        const routes = (b.detail && b.detail.routes) || [];
        const failed = routes.filter((r) => !r.ok);
        const row = document.createElement('div');
        row.className = 'ih-row';
        row.innerHTML = `
            <div class="ih-top">
                <span class="dash-chip ${cls}">${label}</span>
                <b>#${b.id}</b>
                <span class="ih-source">${escapeHtml(b.source_label || '(출처 이름 없음)')}</span>
                <span class="ih-meta">${fmtDateTimeKo(b.created_at)} · ${escapeHtml(b.username || '')}</span>
                ${b.undoable ? '<button type="button" class="ih-undo">이 등록 취소</button>' : ''}
            </div>
            <div class="ih-summary">${escapeHtml(b.summary || '')}</div>
            ${routes.length ? `<div class="ih-routes">노선 ${routes.length}개 중 ${routes.length - failed.length}개 저장${failed.length ? ` · 실패: ${failed.map((r) => escapeHtml(r.code + (r.error ? '(' + r.error + ')' : ''))).join(', ')}` : ''}</div>` : ''}
            ${b.status === 'undone' ? `<div class="ih-routes">${fmtDateTimeKo(b.undone_at)}에 ${escapeHtml(b.undone_by || '')}님이 취소함</div>` : ''}`;
        const undoBtn = row.querySelector('.ih-undo');
        if (undoBtn) undoBtn.addEventListener('click', () => undoImportBatch(b));
        el.appendChild(row);
    });
}

async function undoImportBatch(b) {
    const typed = await uiPrompt(
        `일괄등록 #${b.id} (${b.source_label || '출처 이름 없음'})을 취소합니다.\n\n` +
        '- 이 등록이 덮어쓴 값은 등록 전 값으로 돌아가고, 이 등록으로 새로 생긴 데이터·사진·도면은 삭제됩니다.\n' +
        '- 등록 이후에 화면에서 직접 고친 값도 등록 전 값으로 돌아갑니다.\n\n' +
        '계속하려면 "취소"를 입력하세요.'
    );
    if (typed === null) return;
    if (typed.trim() !== '취소') { uiAlert('"취소"를 정확히 입력해야 진행됩니다. 되돌리지 않았습니다.'); return; }
    try {
        const res = await adminFetch(`/api/admin/imports/${b.id}/undo`, { method: 'POST' });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || '되돌리기 실패');
        uiAlert(d.missingFiles ? `되돌렸습니다. 다만 파일 ${d.missingFiles}개는 서버에서 찾지 못해 복원하지 못했습니다.` : '되돌렸습니다.');
    } catch (e) {
        uiAlert(e.message || '되돌리기 실패');
    }
    loadLedgerTree();
    loadImportHistory();
}

// ---------- 데이터 품질(KRRIS) — 필수 항목 빈 값 점검과 채우기 ----------
let qualityCurrent = null; // 지금 열어 둔 항목 { table, column, rows, total, choices, ... }

async function loadQualitySummary() {
    const el = document.getElementById('quality-summary');
    document.getElementById('quality-detail').hidden = true;
    qualityCurrent = null;
    el.innerHTML = '<div class="dash-empty">점검 중...</div>';
    let d;
    try {
        const res = await adminFetch('/api/admin/quality/summary');
        d = await res.json();
        if (!res.ok) throw new Error(d.error || '점검 실패');
    } catch (e) {
        el.innerHTML = `<div class="dash-empty">${escapeHtml(e.message || '점검 실패')}</div>`;
        return;
    }
    if (!d.items.length) {
        el.innerHTML = '<div class="dash-banner ok"><i class="fa-solid fa-circle-check"></i> 필수 항목이 비어 있는 곳이 없습니다.</div>';
        return;
    }
    el.innerHTML = `<div class="dash-banner warn"><i class="fa-solid fa-triangle-exclamation"></i> 필수 항목이 비어 있는 곳 <b>${d.total.toLocaleString()}건</b> (${d.items.length}개 항목)</div>
        <div class="scroll-x"><table class="dash-table quality-table"><thead><tr><th>레이어</th><th>항목</th><th class="num">빈 값</th><th></th></tr></thead><tbody>${d.items.map((it, i) =>
            `<tr><td>${escapeHtml(it.layerName)}</td><td>${escapeHtml(it.label)} <span class="mono-dim">(${escapeHtml(it.column)})</span></td><td class="num">${it.count.toLocaleString()}</td><td><button type="button" class="quality-open" data-i="${i}">보기·채우기</button></td></tr>`).join('')}</tbody></table></div>`;
    el.querySelectorAll('.quality-open').forEach((b) => b.addEventListener('click', () => {
        const it = d.items[Number(b.dataset.i)];
        openQualityItem(it.table, it.column, 0);
    }));
}

async function openQualityItem(table, column, offset) {
    const box = document.getElementById('quality-detail');
    box.hidden = false;
    if (!offset) box.innerHTML = '<div class="dash-empty">불러오는 중...</div>';
    let d;
    try {
        const res = await adminFetch(`/api/admin/quality/rows?table=${encodeURIComponent(table)}&column=${encodeURIComponent(column)}&offset=${offset}&limit=100`);
        d = await res.json();
        if (!res.ok) throw new Error(d.error || '불러오기 실패');
    } catch (e) {
        box.innerHTML = `<div class="dash-empty">${escapeHtml(e.message || '불러오기 실패')}</div>`;
        return;
    }
    if (!offset) qualityCurrent = { ...d, rows: [] };
    qualityCurrent.rows.push(...d.rows);
    const q = qualityCurrent;
    const valueInput = q.choices
        ? `<input list="quality-codes" id="quality-value" placeholder="코드를 고르세요" autocomplete="off"><datalist id="quality-codes">${q.choices.map((c) => `<option value="${escapeHtml(c.code)}">${escapeHtml(c.name)}</option>`).join('')}</datalist>`
        : `<input type="text" id="quality-value" placeholder="채울 값" autocomplete="off"${q.maxlen ? ` maxlength="${q.maxlen}"` : ''}>`;
    box.innerHTML = `
        <div class="quality-detail-head"><b>${escapeHtml(q.layerName)} · ${escapeHtml(q.label)}</b> <span class="mono-dim">(${escapeHtml(q.column)})</span> — 빈 값 ${q.total.toLocaleString()}건
            <button type="button" id="quality-close">닫기</button></div>
        <div class="quality-fill">
            ${valueInput}
            <button type="button" id="quality-fill-selected">선택한 행 채우기</button>
            <button type="button" id="quality-fill-all" title="이 항목의 빈 값 전부(관할 범위 안)에 같은 값을 채웁니다">빈 값 ${q.total.toLocaleString()}건 모두 채우기</button>
        </div>
        <div class="scroll-x"><table class="dash-table quality-table"><thead><tr><th><input type="checkbox" id="quality-all-check" title="화면에 보이는 행 전체 선택"></th><th>노선번호</th><th>구간</th><th>노선명</th><th>ID</th></tr></thead><tbody>${q.rows.map((r) =>
            `<tr><td><input type="checkbox" class="quality-row-check" value="${escapeHtml(r.pk)}"></td><td>${escapeHtml(r.road_no || '')}</td><td>${escapeHtml(r.sect || '')}</td><td>${escapeHtml(r.road_name || '')}</td><td class="mono-dim">${escapeHtml(r.pk)}</td></tr>`).join('')}</tbody></table></div>
        ${q.rows.length < q.total ? `<button type="button" id="quality-more" class="quality-open">더 보기 (${q.rows.length}/${q.total.toLocaleString()})</button>` : ''}`;
    document.getElementById('quality-close').addEventListener('click', () => { box.hidden = true; });
    document.getElementById('quality-all-check').addEventListener('change', (e) => {
        box.querySelectorAll('.quality-row-check').forEach((c) => { c.checked = e.target.checked; });
    });
    const more = document.getElementById('quality-more');
    if (more) more.addEventListener('click', () => openQualityItem(table, column, q.rows.length));
    document.getElementById('quality-fill-selected').addEventListener('click', () => submitQualityFix(false));
    document.getElementById('quality-fill-all').addEventListener('click', () => submitQualityFix(true));
}

async function submitQualityFix(all) {
    const q = qualityCurrent;
    if (!q) return;
    const value = document.getElementById('quality-value').value.trim();
    if (!value) { uiAlert('채울 값을 입력하세요.'); return; }
    const pks = [...document.querySelectorAll('#quality-detail .quality-row-check:checked')].map((c) => c.value);
    if (!all && !pks.length) { uiAlert('채울 행을 먼저 선택하세요.'); return; }
    const target = all ? `이 항목의 빈 값 ${q.total.toLocaleString()}건 모두` : `선택한 ${pks.length}건`;
    if (!await uiConfirm(`${q.layerName} · ${q.label}: ${target}에 "${value}"을(를) 채웁니다.\n이미 값이 있는 칸은 바뀌지 않습니다. 계속할까요?`)) return;
    try {
        const res = await adminFetch('/api/admin/quality/fix', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ table: q.table, column: q.column, value, all, pks }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || '저장 실패');
        uiAlert(`${d.updated.toLocaleString()}건을 채웠습니다.`);
    } catch (e) {
        uiAlert(e.message || '저장 실패');
        return;
    }
    await loadQualitySummary();
}

// ---------- 현황판 ----------
function fmtBytes(n) {
    if (n == null) return '확인 불가';
    if (n >= 1024 ** 4) return (n / 1024 ** 4).toFixed(2) + ' TB';
    if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
    if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
}
function fmtDateTimeKo(iso) {
    return iso ? new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '-';
}

async function loadDashboard() {
    const body = document.getElementById('dashboard-body');
    let d;
    try {
        const res = await adminFetch('/api/admin/dashboard');
        d = await res.json();
        if (!res.ok) throw new Error(d.error || '불러오기 실패');
    } catch (e) {
        body.innerHTML = `<div class="dash-empty">${escapeHtml(e.message || '불러오기 실패')}</div>`;
        return;
    }
    const c = d.counts;
    const stat = (n, label, extra) => `<div class="dash-stat"><b>${Number(n).toLocaleString()}</b><span>${label}</span>${extra || ''}</div>`;

    const b = d.backup || {};
    const backupLabel = { ok: '정상', warn: '주의', error: '위험', unknown: '확인 불가' }[b.state] || '확인 불가';
    const backupDetail = b.state === 'unknown' ? escapeHtml(b.message || '')
        : `마지막 백업 ${fmtDateTimeKo(b.lastAt)}${b.ageHours != null ? ` (${b.ageHours}시간 전)` : ''} · 보관 ${b.count || 0}개${b.lastResult === 'failed' ? `<br>최근 실행 실패: ${escapeHtml(b.lastError || '')}` : ''}${b.message ? `<br>${escapeHtml(b.message)}` : ''}`;

    const disk = d.disk || {};
    const usedPct = disk.totalBytes ? Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100) : null;
    const diskState = usedPct == null ? 'unknown' : usedPct >= 95 ? 'error' : usedPct >= 85 ? 'warn' : 'ok';

    const job = d.runningJob;
    const jobHtml = job
        ? `<div class="dash-banner running"><i class="fa-solid fa-hourglass-half bulk-spinner"></i> 일괄등록 진행 중 — ${escapeHtml(job.stage || '')}${job.total ? ` (노선 ${job.done}/${job.total}${job.currentRoute ? ' · ' + escapeHtml(job.currentRoute) : ''})` : ''}</div>`
        : '';
    const pendingHtml = d.pendingAccounts
        ? `<div class="dash-banner warn"><i class="fa-solid fa-user-clock"></i> 가입 승인 대기 계정이 <b>${d.pendingAccounts}</b>건 있습니다. <button type="button" class="dash-link" data-go="accountsview-tab">계정 관리로 이동</button></div>`
        : '';

    body.innerHTML = `
        ${jobHtml}${pendingHtml}
        <div class="dash-stats">
            ${stat(c.routes, '노선')}${stat(c.sections, '구간')}${stat(c.facilities, '시설물')}
            ${stat(c.drawings, '도면 파일')}${stat(c.attachments, '사진·보고서')}${stat(c.sectors, '500m 구간')}
        </div>
        <div class="dash-grid">
            <section class="dash-card">
                <h3>백업 <span class="dash-chip ${b.state || 'unknown'}">${backupLabel}</span></h3>
                <div class="dash-sub">${backupDetail}</div>
                ${b.root ? `<div class="dash-sub mono">${escapeHtml(b.root)}</div>` : ''}
            </section>
            <section class="dash-card">
                <h3>서버 디스크 <span class="dash-chip ${diskState}">${usedPct == null ? '확인 불가' : usedPct + '% 사용'}</span></h3>
                <div class="dash-bar"><div class="dash-bar-fill ${diskState}" style="width:${usedPct == null ? 0 : usedPct}%"></div></div>
                <div class="dash-sub">여유 ${fmtBytes(disk.freeBytes)} / 전체 ${fmtBytes(disk.totalBytes)}<br>업로드 자료(사진·도면 등) ${fmtBytes(disk.uploadsBytes)}</div>
            </section>
            <section class="dash-card">
                <h3>접속 (최근 24시간)</h3>
                <div class="dash-sub">로그인 성공 <b>${d.logins24h.ok}</b>건 · 실패 <b>${d.logins24h.fail}</b>건</div>
            </section>
            <section class="dash-card dash-wide">
                <h3>도로종류별 등록</h3>
                ${d.byGrade.length ? `<table class="dash-table"><thead><tr><th>도로종류</th><th class="num">노선</th><th class="num">구간</th></tr></thead><tbody>${d.byGrade.map((g) => `<tr><td>${escapeHtml(g.roadGrade || '-')}</td><td class="num">${g.routes}</td><td class="num">${g.sections}</td></tr>`).join('')}</tbody></table>` : '<div class="dash-sub">등록된 노선이 없습니다.</div>'}
            </section>
            <section class="dash-card dash-wide">
                <h3>최근 활동</h3>
                ${d.recent.length ? `<ul class="dash-recent">${d.recent.map((r) => `<li><span class="dash-time">${fmtDateTimeKo(r.created_at)}</span><span class="dash-user">${escapeHtml(r.username || '')}</span><span class="dash-sum">${escapeHtml(r.summary || '')}</span></li>`).join('')}</ul>` : '<div class="dash-sub">기록이 없습니다.</div>'}
            </section>
        </div>
        <div class="dash-foot">${fmtDateTimeKo(d.generatedAt)} 기준</div>`;
    body.querySelectorAll('.dash-link').forEach((btn) => btn.addEventListener('click', () => showConsoleSection(btn.dataset.go)));
}

// ---------- 등록 데이터 관리(노선 삭제) ----------
const RANK_NAMES_FOR_1599 = ['기타', '면도', '리도', '농도', '도시계획도로']; // 서버 lib/roadRank.js와 같은 목록
let dataMgmtRoutes = [];
const dataMgmtSelected = new Set(); // 선택한 노선의 키

function dataMgmtKey(r) { return `${r.roadGrade}|${r.routeNo}|${r.routeName}`; }

function updateDataMgmtFooter() {
    const picked = dataMgmtRoutes.filter((r) => dataMgmtSelected.has(dataMgmtKey(r)));
    const sections = picked.reduce((n, r) => n + r.sections.length, 0);
    document.getElementById('datamgmt-selected-info').textContent = picked.length
        ? `노선 ${picked.length}개(구간 ${sections}개) 선택` : '선택된 노선 없음';
    document.getElementById('datamgmt-delete-btn').disabled = !picked.length;
}

function renderDataMgmtList() {
    const listEl = document.getElementById('datamgmt-list');
    if (!dataMgmtRoutes.length) {
        listEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:8px;">등록된 노선이 없습니다.</div>';
        updateDataMgmtFooter();
        return;
    }
    listEl.innerHTML = '';
    dataMgmtRoutes.forEach((r) => {
        const key = dataMgmtKey(r);
        const row = document.createElement('label');
        row.className = 'dm-row' + (dataMgmtSelected.has(key) ? ' selected' : '');
        const km = r.lengthM ? (r.lengthM / 1000).toFixed(2) + ' km' : '연장 없음';
        const sects = r.sections.map((s) => s.sect).filter(Boolean).join(', ');
        row.innerHTML = `
            <input type="checkbox" ${dataMgmtSelected.has(key) ? 'checked' : ''}>
            <div class="dm-main">
                <div class="dm-top"><span class="dm-grade">${escapeHtml(r.roadGrade || '')}</span><span class="dm-name">${escapeHtml([r.routeNo, r.routeName].filter(Boolean).join(' '))}</span>${r.roadRankCode === '1599' ? `<select class="dm-rank-select" title="화면에 표시할 도로종류(저장 코드는 1599 그대로)">${RANK_NAMES_FOR_1599.map((n) => `<option${n === r.roadGrade ? ' selected' : ''}>${n}</option>`).join('')}</select>` : ''}</div>
                <div class="dm-meta">구간 ${r.sections.length}개(${escapeHtml(sects)}) · ${km} · 시설물 ${r.facilityCount.toLocaleString()}건 · 도면 ${r.drawingCount.toLocaleString()}건</div>
            </div>`;
        row.querySelector('input').addEventListener('change', (e) => {
            if (e.target.checked) dataMgmtSelected.add(key); else dataMgmtSelected.delete(key);
            row.classList.toggle('selected', e.target.checked);
            updateDataMgmtFooter();
        });
        const rankSel = row.querySelector('.dm-rank-select');
        if (rankSel) {
            // 행(label) 안의 셀렉트라 클릭이 체크박스 토글로 번지지 않게 막는다.
            rankSel.addEventListener('click', (e) => e.stopPropagation());
            rankSel.addEventListener('change', async () => {
                try {
                    const res = await adminFetch('/api/admin/sections/rank-name', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ rdids: r.sections.map((s) => s.rdid), name: rankSel.value }),
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || '변경 실패');
                } catch (e) {
                    uiAlert(e.message || '변경 실패');
                }
                loadLedgerTree();
                loadDataMgmtList();
            });
        }
        listEl.appendChild(row);
    });
    updateDataMgmtFooter();
}

async function loadDataMgmtList() {
    const listEl = document.getElementById('datamgmt-list');
    listEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:8px;">불러오는 중...</div>';
    try {
        const res = await adminFetch('/api/admin/sections');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '불러오기 실패');
        dataMgmtRoutes = data.routes || [];
    } catch (e) {
        listEl.innerHTML = `<div style="color:var(--text-muted);font-size:0.8rem;padding:8px;">${escapeHtml(e.message || '불러오기 실패')}</div>`;
        return;
    }
    // 목록에서 사라진 노선은 선택에서도 뺀다
    const keys = new Set(dataMgmtRoutes.map(dataMgmtKey));
    [...dataMgmtSelected].forEach((k) => { if (!keys.has(k)) dataMgmtSelected.delete(k); });
    renderDataMgmtList();
}

async function deleteSelectedRoutes() {
    const picked = dataMgmtRoutes.filter((r) => dataMgmtSelected.has(dataMgmtKey(r)));
    if (!picked.length) return;
    const sections = picked.flatMap((r) => r.sections);
    const facility = picked.reduce((n, r) => n + r.facilityCount, 0);
    const drawings = picked.reduce((n, r) => n + r.drawingCount, 0);
    const names = picked.slice(0, 8).map((r) => `  · ${r.roadGrade} ${[r.routeNo, r.routeName].filter(Boolean).join(' ')} (구간 ${r.sections.length}개)`);
    if (picked.length > 8) names.push(`  … 외 ${picked.length - 8}개 노선`);
    const typed = await uiPrompt(
        `다음 노선을 삭제합니다.\n\n${names.join('\n')}\n\n구간 ${sections.length}개, 시설물 ${facility.toLocaleString()}건, 도면 ${drawings.toLocaleString()}건이 함께 삭제 휴지통으로 옮겨지며, ${trashDays}일 안에는 '삭제 휴지통' 탭에서 복원할 수 있습니다.\n\n계속하려면 "삭제"를 입력하세요.`
    );
    if (typed === null) return;
    if (typed.trim() !== '삭제') { uiAlert('"삭제"를 정확히 입력해야 삭제됩니다. 삭제를 취소했습니다.'); return; }

    const btn = document.getElementById('datamgmt-delete-btn');
    btn.disabled = true;
    let data;
    try {
        const res = await adminFetch('/api/admin/sections/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rdids: sections.map((s) => s.rdid) }),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.error || '삭제 실패');
    } catch (e) {
        uiAlert(e.message || '삭제 실패');
        updateDataMgmtFooter();
        return;
    }

    // 지도/트리 쪽 상태도 정리한다
    const failedSet = new Set((data.failed || []).map((f) => f.rdid));
    sections.filter((s) => !failedSet.has(s.rdid)).forEach((s) => {
        if (currentSectionRdid === s.rdid) {
            currentSectionRdid = null;
            pendingSectionDraft = null;
            document.getElementById('parcel-form').style.display = 'none';
            document.getElementById('parcel-empty-msg').style.display = 'block';
            routeHighlightLayer.getSource().clear();
            stopRouteHighlightBlink();
            clearSectorSelection();
        }
        clearSectionFacilityGeoms(s.rdid);
    });
    dataMgmtSelected.clear();
    loadLedgerTree();
    loadTrashList();
    await loadDataMgmtList();
    if (data.failed && data.failed.length) {
        uiAlert(`구간 ${data.deleted}개를 삭제했고 ${data.failed.length}개는 삭제하지 못했습니다:\n${data.failed.slice(0, 5).map((f) => `  · ${f.rdid}: ${f.error}`).join('\n')}`);
    } else {
        uiAlert(`구간 ${data.deleted}개를 삭제했습니다. ${trashDays}일 안에는 '삭제 휴지통'에서 복원할 수 있습니다.`);
    }
}

// ---------- 통계·점검 ----------
async function downloadStatsExcel() {
    const btn = document.getElementById('rp-stats-btn');
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-hourglass-half"></i> 만드는 중';
    try {
        const res = await adminFetch('/api/admin/reports/stats.xlsx');
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || '엑셀을 만들지 못했습니다.'); }
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        const cd = res.headers.get('Content-Disposition') || '';
        const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
        a.href = url; a.download = m ? decodeURIComponent(m[1]) : '도로대장_현황통계.xlsx';
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) { uiAlert(e.message || '엑셀을 만들지 못했습니다.'); }
    finally { btn.disabled = false; btn.innerHTML = html; }
}

let checksTimer = null;
function renderChecksStatus(s) {
    const btn = document.getElementById('rp-checks-btn');
    const prog = document.getElementById('rp-progress');
    if (s.status === 'running') {
        btn.disabled = true;
        prog.textContent = `점검 중… ${s.stage || ''}`;
        return;
    }
    btn.disabled = false;
    prog.textContent = '';
    if (s.status === 'error') { document.getElementById('rp-results').innerHTML = `<div class="rp-hint">${escapeHtml(s.error || '점검 중 오류가 발생했습니다.')}</div>`; return; }
    if (s.status === 'done' && s.result) renderChecksResult(s.result);
}

async function pollChecks() {
    clearTimeout(checksTimer);
    try {
        const s = await (await adminFetch('/api/admin/reports/checks/status')).json();
        renderChecksStatus(s);
        if (s.status === 'running') checksTimer = setTimeout(pollChecks, 1200);
    } catch (e) { /* 다음 새로고침 때 다시 */ }
}

function loadChecksStatus() { pollChecks(); }

async function runDataChecks() {
    const thresholdM = parseInt(document.getElementById('rp-threshold').value, 10) || 200;
    document.getElementById('rp-results').innerHTML = '';
    try {
        const res = await adminFetch('/api/admin/reports/checks/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thresholdM }) });
        const d = await res.json();
        if (!res.ok && res.status !== 409) throw new Error(d.error || '점검을 시작하지 못했습니다.');
    } catch (e) { uiAlert(e.message || '점검을 시작하지 못했습니다.'); return; }
    pollChecks();
}

function rpGroup(title, total, hint, itemsHtml, capped) {
    const badge = total ? `<span class="rp-badge bad">${total.toLocaleString()}건</span>` : '<span class="rp-badge ok">이상 없음</span>';
    return `<div class="rp-group"><div class="rp-group-head">${escapeHtml(title)} ${badge}</div>
        <div class="rp-hint">${escapeHtml(hint)}${capped ? ' (앞쪽 일부만 표시)' : ''}</div>
        ${total ? `<div class="rp-list">${itemsHtml}</div>` : ''}</div>`;
}

function renderChecksResult(r) {
    const el = document.getElementById('rp-results');
    const dup = r.duplicateRoutes;
    const dupHtml = dup.items.map((g) => `<div class="rp-item"><b>${escapeHtml(g.reason)}</b>${g.sections.map((s) => `<div class="rp-sub">${escapeHtml(s.rank || '')} ${escapeHtml(s.routeNo || '')} ${escapeHtml(s.routeName || '')} · ${escapeHtml(s.sect || '')}구간${s.lengthM != null ? ' · ' + Math.round(s.lengthM).toLocaleString() + 'm' : ''} · ${escapeHtml(s.rdid)}</div>`).join('')}</div>`).join('');
    const off = r.offRoute;
    const offHtml = off.items.map((i) => `<div class="rp-item"><b>${escapeHtml(i.kind)}</b> ${escapeHtml(i.routeLabel)} — 노선에서 약 ${i.distanceM.toLocaleString()}m 떨어짐<button type="button" data-t="${escapeHtml(i.table)}" data-id="${escapeHtml(i.rdid)}" data-k="${escapeHtml(i.kind)}">지도에서 보기</button><div class="rp-sub">${escapeHtml(i.rdid)}</div></div>`).join('');
    const x = r.ids.crossTable;
    const xHtml = x.items.map((i) => `<div class="rp-item">${escapeHtml(i.rdid)}<div class="rp-sub">같은 ID가 ${i.kinds.map(escapeHtml).join(', ')} 에 있음</div></div>`).join('');
    const mm = r.ids.mismatch;
    const mmHtml = mm.items.map((i) => `<div class="rp-item"><b>${escapeHtml(i.kind)}</b> ${escapeHtml(i.rdid)}<div class="rp-sub">ID 안의 도로종류/노선/구간: ${escapeHtml(i.idKey)} ≠ 데이터 값: ${escapeHtml(i.rowKey)}</div></div>`).join('');
    const offHint = `기준 ${off.thresholdM}m · 점검한 시설물 ${off.checked.toLocaleString()}건${off.noGeomSections ? ` · 지도 선이 없어 점검하지 못한 구간 ${off.noGeomSections}개` : ''}${off.unmatched ? ` · 구간과 연결되지 않은 시설물 ${off.unmatched.toLocaleString()}건 제외` : ''}`;
    el.innerHTML = [
        rpGroup('중복 노선', dup.total, '같은 노선번호·이름·구간이 겹쳐 등록된 곳', dupHtml, dup.total > dup.items.length),
        rpGroup('노선에서 벗어난 시설물', off.total, offHint, offHtml, off.total > off.items.length),
        rpGroup('시설물 ID 중복', x.total, '같은 ID가 둘 이상의 시설물 종류에 있는 경우', xHtml, x.capped),
        rpGroup('시설물 ID 불일치', mm.total, 'ID에 들어 있는 도로종류·노선번호·구간이 데이터 값과 다른 경우', mmHtml, mm.total > mm.items.length),
        `<div class="rp-hint">점검 시각 ${fmtDateTimeKo(r.generatedAt)} · ${(r.elapsedMs / 1000).toFixed(1)}초</div>`,
    ].join('');
    el.querySelectorAll('.rp-item button').forEach((b) => b.addEventListener('click', () => {
        closeAdminConsole();
        goToFacility({ table: b.dataset.t, rdid: b.dataset.id, kind: b.dataset.k });
    }));
}

// ---------- 삭제 휴지통 ----------
let trashDays = 30;

function setDataMgmtMode(mode) {
    document.querySelectorAll('.dm-mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.dm === mode));
    document.getElementById('datamgmt-routes-pane').style.display = mode === 'routes' ? '' : 'none';
    document.getElementById('datamgmt-trash-pane').style.display = mode === 'trash' ? '' : 'none';
    if (mode === 'trash') loadTrashList();
}

function fmtTrashRemain(expiresIso) {
    const days = Math.ceil((new Date(expiresIso).getTime() - Date.now()) / 86400000);
    return days <= 1 ? '<span class="tr-warn">오늘 또는 내일 완전 삭제</span>' : `${days}일 뒤 완전 삭제`;
}

async function loadTrashList() {
    const listEl = document.getElementById('datamgmt-trash-list');
    const countEl = document.getElementById('datamgmt-trash-count');
    let data;
    try {
        const res = await adminFetch('/api/admin/sections/trash');
        data = await res.json();
        if (!res.ok) throw new Error(data.error || '불러오기 실패');
    } catch (e) {
        listEl.innerHTML = `<div style="color:var(--text-muted);font-size:0.8rem;padding:8px;">${escapeHtml(e.message || '불러오기 실패')}</div>`;
        return;
    }
    trashDays = data.days || 30;
    document.querySelectorAll('.datamgmt-days').forEach((el) => { el.textContent = trashDays; });
    const items = data.items || [];
    countEl.textContent = items.length ? `(${items.length})` : '';
    if (!data.ready) { listEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:8px;">서버에 db/schema.sql(삭제 휴지통 테이블)이 아직 적용되지 않았습니다.</div>'; return; }
    if (!items.length) { listEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:8px;">휴지통이 비어 있습니다.</div>'; return; }
    listEl.innerHTML = '';
    items.forEach((it) => {
        const row = document.createElement('div');
        row.className = 'tr-row';
        const counts = it.counts || {};
        const facility = Object.entries(counts).filter(([k]) => k.startsWith('gov_')).reduce((n, [, v]) => n + v, 0);
        const name = [it.road_rank_name, it.route_no, it.route_name].filter(Boolean).join(' ') + (it.sect ? ` · ${it.sect}구간` : '');
        row.innerHTML = `
            <div class="tr-main">
                <div class="tr-name">${escapeHtml(name)}</div>
                <div class="tr-meta">${fmtDateTimeKo(it.deleted_at)} 삭제 · ${escapeHtml(it.username || '알 수 없음')} · 시설물 ${facility.toLocaleString()}건 · 도면 ${(counts.route_files || 0).toLocaleString()}건 · 파일 ${fmtBytes(Number(it.file_bytes) || 0)} · ${fmtTrashRemain(it.expires_at)}${it.rdid_in_use ? ' · <span class="tr-warn">같은 구간번호가 다시 등록돼 있어 복원 불가</span>' : ''}</div>
            </div>
            <button type="button" class="tr-restore"${it.rdid_in_use ? ' disabled' : ''}>복원</button>
            <button type="button" class="tr-purge" title="지금 바로 완전히 지웁니다(되돌릴 수 없음)">비우기</button>`;
        row.querySelector('.tr-restore').addEventListener('click', () => restoreTrashItem(it, name));
        row.querySelector('.tr-purge').addEventListener('click', () => purgeTrashItem(it, name));
        listEl.appendChild(row);
    });
}

async function restoreTrashItem(it, name) {
    if (!await uiConfirm(`'${name}'을(를) 삭제 전 상태로 복원하시겠습니까?`)) return;
    try {
        const res = await adminFetch(`/api/admin/sections/trash/${it.id}/restore`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '복원 실패');
        uiAlert(`복원했습니다 (${data.restoredRows.toLocaleString()}건).${data.missingFiles ? `\n파일 ${data.missingFiles}개는 보관 폴더에서 찾지 못해 복원되지 않았습니다.` : ''}`);
    } catch (e) {
        uiAlert(e.message || '복원 실패');
    }
    loadLedgerTree();
    loadTrashList();
    loadDataMgmtList();
}

async function purgeTrashItem(it, name) {
    if (!await uiConfirm(`'${name}'을(를) 휴지통에서 지금 완전히 지웁니다.\n이후에는 복원할 수 없습니다. 계속하시겠습니까?`)) return;
    try {
        const res = await adminFetch(`/api/admin/sections/trash/${it.id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '삭제 실패');
    } catch (e) {
        uiAlert(e.message || '삭제 실패');
    }
    loadTrashList();
}


async function deleteSectionFromTree(rdid, label) {
    if (!await uiConfirm(`'${label}' 구간을 삭제하시겠습니까?\n삭제한 구간은 ${trashDays}일 동안 휴지통에 보관되며, 관리 콘솔 > 등록 데이터 관리 > 삭제 휴지통에서 복원할 수 있습니다.`)) return;
    const res = await fetch(`/api/sections/${rdid}`, { method: 'DELETE' });
    if (res.ok) {
        if (currentSectionRdid === rdid) {
            currentSectionRdid = null;
            pendingSectionDraft = null;
            document.getElementById('parcel-form').style.display = 'none';
            document.getElementById('parcel-empty-msg').style.display = 'block';
            routeHighlightLayer.getSource().clear();
            stopRouteHighlightBlink();
            clearSectorSelection();
        }
        clearSectionFacilityGeoms(rdid);
        loadLedgerTree();
    } else {
        const data = await res.json().catch(() => ({}));
        uiAlert(data.error || '삭제 실패');
    }
}

// ---------- 일괄등록 (관리자 전용, 레이아웃만 — 등록 로직은 추후 구현) ----------
function initBulkRegister() {
    const dropzone = document.getElementById('bulk-dropzone');
    const fileInput = document.getElementById('bulk-file-input');
    const folderInput = document.getElementById('bulk-folder-input');
    const incomingFolderInput = document.getElementById('bulk-incoming-folder-input');
    const fileListEl = document.getElementById('bulk-file-list');
    const modeBtns = document.querySelectorAll('.bulk-mode-btn');
    const modeZipEl = document.getElementById('bulk-mode-zip');
    const modeIncomingEl = document.getElementById('bulk-mode-incoming');
    const incomingListEl = document.getElementById('bulk-incoming-list');
    const incomingRefreshBtn = document.getElementById('bulk-incoming-refresh-btn');
    const incomingSelectAllCb = document.getElementById('bulk-incoming-select-all');
    const incomingBatchSigunguInput = document.getElementById('bulk-incoming-batch-sigungu-input');
    const incomingRegisterSelectedBtn = document.getElementById('bulk-incoming-register-selected-btn');
    const incomingRegisterAllBtn = document.getElementById('bulk-incoming-register-all-btn');
    const incomingBatchLogEl = document.getElementById('bulk-incoming-batch-log');
    const registerBtn = document.getElementById('bulk-register-btn');
    const statusEl = document.getElementById('bulk-upload-status');
    const uploadErrorEl = document.getElementById('bulk-upload-error');
    const uploadStep = document.getElementById('bulk-upload-step');
    const reviewPanel = document.getElementById('bulk-review-panel');
    const metaEl = document.getElementById('bulk-review-meta');
    const sigunguInput = document.getElementById('bulk-review-sigungu-input');
    const layersEl = document.getElementById('bulk-review-layers');
    const warningsEl = document.getElementById('bulk-review-warnings');
    const krrisEl = document.getElementById('bulk-review-krris');
    const confirmBtn = document.getElementById('bulk-confirm-btn');
    const cancelBtn = document.getElementById('bulk-cancel-btn');
    const resultEl = document.getElementById('bulk-review-result');
    const reviewErrorEl = document.getElementById('bulk-review-error');
    const bulkTabEl = document.getElementById('bulkview-tab');

    function showUploadError(message) {
        uploadErrorEl.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i>${escapeHtml(message)}`;
        uploadErrorEl.classList.add('show');
    }
    function hideUploadError() {
        uploadErrorEl.innerHTML = '';
        uploadErrorEl.classList.remove('show');
    }
    function showReviewError(message) {
        reviewErrorEl.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i>${escapeHtml(message)}`;
        reviewErrorEl.classList.add('show');
    }
    function hideReviewError() {
        reviewErrorEl.innerHTML = '';
        reviewErrorEl.classList.remove('show');
    }

    let bulkFile = null;
    let bulkFolderFiles = null; // webkitdirectory로 고른 폴더의 File[] (zip과 배타적)
    let currentPreview = null;
    let bulkMode = 'zip'; // 'zip' | 'incoming'
    let incomingFolders = []; // 마지막으로 불러온 목록 [{name, mtimeMs}]
    const selectedIncomingFolders = new Set();

    const modeRouteDrawingsEl = document.getElementById('bulk-mode-route-drawings');

    function setBulkMode(mode) {
        bulkMode = mode;
        modeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
        modeZipEl.style.display = mode === 'zip' ? '' : 'none';
        modeIncomingEl.style.display = mode === 'incoming' ? '' : 'none';
        modeRouteDrawingsEl.style.display = mode === 'route-drawings' ? '' : 'none';
        // "검수 시작" 버튼/상태표시는 zip·incoming 두 모드 전용 흐름(SHP/DBF 검수→확인)
        // 이라 노선 도면 업로드 모드에서는 숨긴다 — 이 모드는 자체 업로드 버튼과
        // 결과 영역을 따로 갖고 있다.
        registerBtn.style.display = mode === 'route-drawings' ? 'none' : '';
        hideUploadError();
        statusEl.textContent = '';
        if (mode === 'incoming') loadIncomingFolders();
        if (mode === 'route-drawings') loadRouteDrawingsRouteOptions();
    }
    modeBtns.forEach((btn) => btn.addEventListener('click', () => setBulkMode(btn.dataset.mode)));

    // ---------- 노선 도면 업로드(ZIP) ----------
    // 500m 단위 구간도면(500_P/500_Y)이나 구간현황 개요도(CON 등)를 zip으로
    // 통째로 올리면, 서버가 파일명으로 구간을 알아내 아래에서 고른 노선에 이미
    // 등록된 구간들에 자동으로 나눠 붙인다. 데이터보기 트리에서 노선을 미리
    // 선택해두지 않아도 되도록, 이 탭에 들어올 때마다 등록된 노선 전체를
    // 조회해서(/api/sections/tree, 데이터보기 트리와 같은 API) 목록으로
    // 보여준다 — 트리에서 노선을 이미 선택해뒀으면 그걸 기본값으로 잡아준다.
    const rdDropzone = document.getElementById('bulk-route-drawings-dropzone');
    const rdFileInput = document.getElementById('bulk-route-drawings-file-input');
    const rdFileNameEl = document.getElementById('bulk-route-drawings-file-name');
    const rdRouteSelect = document.getElementById('bulk-route-drawings-route-select');
    const rdUploadBtn = document.getElementById('bulk-route-drawings-upload-btn');
    const rdStatusEl = document.getElementById('bulk-route-drawings-status');
    const rdResultEl = document.getElementById('bulk-route-drawings-result');
    let rdFiles = [];

    async function loadRouteDrawingsRouteOptions() {
        rdRouteSelect.innerHTML = '<option value="">불러오는 중...</option>';
        let tree;
        try {
            ({ tree } = await fetch('/api/sections/tree').then((r) => r.json()));
        } catch (e) {
            rdRouteSelect.innerHTML = '<option value="">자동 인식 (파일명으로 노선·구간 찾기)</option>';
            return;
        }
        // 기본값은 "자동 인식"(노선을 고르지 않음). 노선을 고르면 그 노선 구간에만 붙인다.
        rdRouteSelect.innerHTML = '<option value="">자동 인식 (파일명으로 노선·구간 찾기)</option>' +
            (tree || []).flatMap((g) => g.routes.map((r) => {
                const key = `${g.road_grade}__${r.route_no}`;
                return `<option value="${escapeHtml(key)}" data-road-grade="${escapeHtml(g.road_grade)}" data-route-no="${escapeHtml(r.route_no || '')}" data-route-name="${escapeHtml(r.route_name || '')}">${escapeHtml(g.road_grade)} ${escapeHtml(r.route_no || '')} ${escapeHtml(r.route_name || '')}</option>`;
            })).join('');
    }

    function setRouteDrawingsFiles(fileList) {
        const files = [...(fileList || [])];
        if (!files.length) return;
        const ok = files.filter((f) => /\.(zip|dwg|dxf)$/i.test(f.name));
        if (ok.length !== files.length) uiAlert('ZIP, DWG, DXF 파일만 선택할 수 있습니다. 다른 파일은 제외했습니다.');
        if (!ok.length) return;
        rdFiles = ok;
        rdFileNameEl.textContent = ok.length === 1 ? ok[0].name : `${ok[0].name} 외 ${ok.length - 1}개`;
        rdFileNameEl.title = ok.map((f) => f.name).join('\n');
    }
    rdDropzone.addEventListener('click', () => rdFileInput.click());
    rdFileInput.addEventListener('change', () => { setRouteDrawingsFiles(rdFileInput.files); rdFileInput.value = ''; });
    rdDropzone.addEventListener('dragover', (e) => { e.preventDefault(); rdDropzone.classList.add('dragover'); });
    rdDropzone.addEventListener('dragleave', () => rdDropzone.classList.remove('dragover'));
    rdDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        rdDropzone.classList.remove('dragover');
        setRouteDrawingsFiles(e.dataTransfer.files);
    });

    rdUploadBtn.addEventListener('click', async () => {
        const opt = rdRouteSelect.selectedOptions[0];
        const routeChosen = !!(opt && opt.value);
        if (!rdFiles.length) { uiAlert('먼저 도면 파일 또는 ZIP을 선택하세요.'); return; }
        if (routeChosen && (rdFiles.length !== 1 || !/\.zip$/i.test(rdFiles[0].name))) {
            uiAlert('노선을 고른 경우에는 ZIP 파일 1개만 올릴 수 있습니다. 여러 파일은 "자동 인식"으로 올리세요.');
            return;
        }

        const formData = new FormData();
        if (routeChosen) {
            formData.append('road_grade', opt.dataset.roadGrade || '');
            formData.append('route_no', opt.dataset.routeNo || '');
            formData.append('route_name', opt.dataset.routeName || '');
            formData.append('file', rdFiles[0]);
        } else {
            rdFiles.forEach((f) => formData.append('files', f));
        }

        bulkTabEl.classList.add('bulk-loading');
        rdUploadBtn.disabled = true;
        rdStatusEl.innerHTML = '<i class="fa-solid fa-hourglass-half bulk-spinner"></i>도면을 처리하는 중입니다... (파일 수에 따라 시간이 걸릴 수 있습니다)';
        rdResultEl.innerHTML = '';
        let data;
        try {
            const res = await fetch(routeChosen ? '/api/routes/files/bulk-zip' : '/api/routes/files/auto', { method: 'POST', body: formData });
            data = await res.json();
            if (!res.ok) throw new Error(data.error || 'ZIP 업로드 실패');
        } catch (e) {
            rdStatusEl.textContent = '';
            uiAlert(e.message);
            return;
        } finally {
            bulkTabEl.classList.remove('bulk-loading');
            rdUploadBtn.disabled = false;
        }

        rdStatusEl.textContent = '';
        rdFiles = [];
        rdFileNameEl.textContent = '';
        rdFileNameEl.title = '';
        if (typeof refreshRouteFilePanel === 'function') refreshRouteFilePanel();

        const parts = [`<div class="bulk-rd-result-ok">${data.matched.length}건 등록됨</div>`];
        // 자동 인식 결과는 어느 노선·구간으로 갔는지 묶어서 보여준다(노선을 고른 경우는 matched에 그 정보가 없음).
        const groups = new Map();
        data.matched.forEach((m) => {
            if (!m.roadGrade) return;
            const key = `${m.roadGrade} ${m.routeNo} ${m.routeName} ${m.sect}구간`;
            groups.set(key, (groups.get(key) || 0) + 1);
        });
        if (groups.size) {
            parts.push(`<ul class="bulk-rd-unmatched-list">${[...groups].map(([k, n]) => `<li>${escapeHtml(k)} — ${n}건</li>`).join('')}</ul>`);
        }
        if (data.unmatched.length) {
            parts.push(`<div class="bulk-rd-result-warn">${data.unmatched.length}건은 올리지 못했습니다:</div>`);
            // bulk-zip은 파일명 문자열, auto는 { name, reason }
            parts.push(`<ul class="bulk-rd-unmatched-list">${data.unmatched.map((u) => (typeof u === 'string'
                ? `<li>${escapeHtml(u)}</li>`
                : `<li>${escapeHtml(u.name)} — ${escapeHtml(u.reason || '')}</li>`)).join('')}</ul>`);
        }
        rdResultEl.innerHTML = parts.join('');
    });

    function formatBytesShort(n) {
        if (n == null) return '';
        if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
        if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
        return Math.max(1, Math.round(n / 1024)) + ' KB';
    }
    function renderIncomingList(folders) {
        incomingFolders = folders;
        selectedIncomingFolders.forEach((name) => {
            if (!folders.some((f) => f.name === name)) selectedIncomingFolders.delete(name);
        });
        if (!folders.length) {
            incomingListEl.innerHTML = '<div class="bulk-empty">bulk-import-incoming에 올려둔 폴더 또는 ZIP 파일이 없습니다.</div>';
            incomingSelectAllCb.checked = false;
            return;
        }
        incomingListEl.innerHTML = '';
        folders.forEach((f) => {
            const row = document.createElement('div');
            row.className = 'bulk-incoming-row' + (selectedIncomingFolders.has(f.name) ? ' selected' : '');
            const when = new Date(f.mtimeMs).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
            row.innerHTML = `
                <input type="checkbox" ${selectedIncomingFolders.has(f.name) ? 'checked' : ''}>
                <i class="fa-solid ${f.isZip ? 'fa-file-zipper' : 'fa-folder'}"></i>
                <span class="bulk-incoming-name">${escapeHtml(f.name)}</span>
                <span class="bulk-incoming-meta">${f.isZip ? formatBytesShort(f.sizeBytes) + ' · ' : ''}${when}</span>
            `;
            const cb = row.querySelector('input[type="checkbox"]');
            const toggle = () => {
                if (selectedIncomingFolders.has(f.name)) selectedIncomingFolders.delete(f.name);
                else selectedIncomingFolders.add(f.name);
                cb.checked = selectedIncomingFolders.has(f.name);
                row.classList.toggle('selected', selectedIncomingFolders.has(f.name));
                incomingSelectAllCb.checked = selectedIncomingFolders.size === incomingFolders.length;
            };
            cb.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
            row.addEventListener('click', toggle);
            incomingListEl.appendChild(row);
        });
        incomingSelectAllCb.checked = selectedIncomingFolders.size === folders.length;
    }

    incomingSelectAllCb.addEventListener('change', () => {
        selectedIncomingFolders.clear();
        if (incomingSelectAllCb.checked) incomingFolders.forEach((f) => selectedIncomingFolders.add(f.name));
        renderIncomingList(incomingFolders);
    });

    async function loadIncomingFolders() {
        incomingListEl.innerHTML = '<div class="bulk-empty">불러오는 중...</div>';
        try {
            const res = await adminFetch('/api/bulk-import/incoming');
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '목록을 불러오지 못했습니다.');
            renderIncomingList(data.folders || []);
        } catch (e) {
            incomingListEl.innerHTML = `<div class="bulk-empty">${escapeHtml(e.message)}</div>`;
        }
    }
    incomingRefreshBtn.addEventListener('click', loadIncomingFolders);

    // ---- 일괄등록(여러 폴더를 한 시군구로 순서대로 자동 등록) ----
    function addBatchLogRow(name) {
        const row = document.createElement('div');
        row.className = 'bib-row pending';
        row.innerHTML = `<i class="fa-solid fa-circle-notch"></i><span class="bib-name">${escapeHtml(name)}</span><span class="bib-msg">처리 중...</span>`;
        incomingBatchLogEl.appendChild(row);
        return row;
    }
    function setBatchLogRow(row, ok, message) {
        row.className = 'bib-row ' + (ok ? 'ok' : 'error');
        row.querySelector('i').className = ok ? 'fa-solid fa-circle-check' : 'fa-solid fa-circle-exclamation';
        row.querySelector('.bib-msg').textContent = message;
    }

    async function runIncomingBatch(folderNames) {
        if (!folderNames.length) {
            showUploadError('등록할 폴더가 없습니다.');
            return;
        }
        const sigunguCode = mcoCodeByName(incomingBatchSigunguInput.value.trim());
        if (!sigunguCode) {
            showUploadError('일괄등록 대상 시군구를 목록에서 정확히 선택하세요.');
            return;
        }
        hideUploadError();
        incomingBatchLogEl.innerHTML = '';
        incomingRegisterSelectedBtn.disabled = true;
        incomingRegisterAllBtn.disabled = true;
        bulkTabEl.classList.add('bulk-loading');
        let okCount = 0;
        for (const name of folderNames) {
            const row = addBatchLogRow(name);
            try {
                const pRes = await adminFetch('/api/bulk-import/preview-from-folder', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: name }),
                });
                const pData = await pRes.json();
                if (!pRes.ok) throw new Error(pData.error || '검수 실패');
                const cData = await confirmAndWait(
                    pData.uploadId,
                    { sigunguCode, acknowledgeUnrecognizedCrs: true, roadRankDisplayName: document.getElementById('bulk-incoming-rank-name').value, sourceLabel: name },
                    (job) => { row.querySelector('.bib-msg').textContent = job.total ? `${job.stage} ${job.done}/${job.total}${job.currentRoute ? ' — ' + job.currentRoute : ''}` : job.stage; }
                );
                const insertedTotal = Object.values(cData.inserted || {}).reduce((sum, n) => sum + n, 0);
                const sectorPart = cData.sectorsInserted ? `, 500m 구간 ${cData.sectorsInserted}건` : '';
                const da = cData.drawingsAuto || {};
                const looseDrawingPart = da.failed ? ', 도면 자동 분류 실패'
                    : (da.matchedCount || da.unmatchedCount) ? `, 구간도면 ${da.matchedCount || 0}건${da.unmatchedCount ? `(인식 못함 ${da.unmatchedCount}건)` : ''}` : '';
                const resultText = `${insertedTotal}건 저장, 첨부 ${cData.facilityFilesAttached || 0}건, 도면 ${cData.drawingFilesAttached || 0}건${looseDrawingPart}${sectorPart}`;
                if (cData.failedRoutes && cData.failedRoutes.length) {
                    // 일부 노선만 실패: 성공한 노선은 저장됐고, 서버 폴더는 다시 시도할 수 있게 그대로 남아 있다.
                    setBatchLogRow(row, false, `${resultText} — 실패한 노선 ${cData.failedRoutes.length}개: ${failedRoutesText(cData)} (서버 폴더는 남아 있습니다)`);
                } else {
                    setBatchLogRow(row, true, resultText);
                    okCount++;
                }
            } catch (e) {
                setBatchLogRow(row, false, e.message);
            }
        }
        incomingRegisterSelectedBtn.disabled = false;
        incomingRegisterAllBtn.disabled = false;
        bulkTabEl.classList.remove('bulk-loading');
        selectedIncomingFolders.clear();
        loadLedgerTree();
        loadIncomingFolders(); // 등록 완료된 폴더는 서버에서 이미 삭제됨 — 목록 다시 불러오기
        statusEl.textContent = `일괄등록 완료: ${okCount}/${folderNames.length}건 성공`;
    }

    incomingRegisterSelectedBtn.addEventListener('click', () => runIncomingBatch([...selectedIncomingFolders]));
    incomingRegisterAllBtn.addEventListener('click', () => runIncomingBatch(incomingFolders.map((f) => f.name)));

    function renderBulkFileList() {
        if (bulkFolderFiles) {
            fileListEl.innerHTML = '';
            const totalSize = bulkFolderFiles.reduce((s, f) => s + f.size, 0);
            const row = document.createElement('div');
            row.className = 'bulk-file-row';
            row.innerHTML = `
                <i class="fa-solid fa-folder"></i>
                <span class="bulk-file-name">${escapeHtml(bulkFolderFiles[0].webkitRelativePath.split('/')[0])} (${bulkFolderFiles.length}개 파일)</span>
                <span class="bulk-file-size">${(totalSize / 1024 / 1024).toFixed(1)} MB</span>
            `;
            const removeBtn = document.createElement('button');
            removeBtn.className = 'bulk-file-remove';
            removeBtn.title = '제거';
            removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            removeBtn.addEventListener('click', () => { bulkFolderFiles = null; renderBulkFileList(); });
            row.appendChild(removeBtn);
            fileListEl.appendChild(row);
            return;
        }
        if (!bulkFile) {
            fileListEl.innerHTML = '<div class="bulk-empty">선택된 파일이 없습니다.</div>';
            return;
        }
        fileListEl.innerHTML = '';
        const row = document.createElement('div');
        row.className = 'bulk-file-row';
        row.innerHTML = `
            <i class="fa-solid fa-file-zipper"></i>
            <span class="bulk-file-name">${escapeHtml(bulkFile.name)}</span>
            <span class="bulk-file-size">${(bulkFile.size / 1024 / 1024).toFixed(1)} MB</span>
        `;
        const removeBtn = document.createElement('button');
        removeBtn.className = 'bulk-file-remove';
        removeBtn.title = '제거';
        removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        removeBtn.addEventListener('click', () => { bulkFile = null; renderBulkFileList(); });
        row.appendChild(removeBtn);
        fileListEl.appendChild(row);
    }

    function setFile(file) {
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.zip')) {
            showUploadError('ZIP 파일만 업로드할 수 있습니다.');
            return;
        }
        hideUploadError();
        statusEl.textContent = '';
        bulkFolderFiles = null; // zip과 폴더 선택은 배타적
        bulkFile = file;
        renderBulkFileList();
    }

    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { setFile(fileInput.files[0]); fileInput.value = ''; });
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        setFile(e.dataTransfer.files[0]);
    });

    folderInput.addEventListener('change', () => {
        const files = Array.from(folderInput.files);
        folderInput.value = '';
        if (!files.length) return;
        hideUploadError();
        statusEl.textContent = '';
        bulkFile = null; // zip과 폴더 선택은 배타적
        bulkFolderFiles = files;
        // 최상위 폴더명(브라우저가 고른 폴더 그 자체의 이름)을 "사전 업로드
        // 폴더명"에 자동으로 채운다 — SFTP로 미리 올려둔 대용량 파일 폴더와
        // 같은 이름으로 맞추면 자동 연동되므로, 관리자가 로컬 폴더 이름을
        // bulk-import-incoming의 폴더명과 동일하게만 만들면 된다.
        const topName = files[0].webkitRelativePath.split('/')[0];
        if (topName) incomingFolderInput.value = topName;
        renderBulkFileList();
    });

    function renderReview(data) {
        const sigunguName = data.suggestedSigunguCode
            ? ((managingAgencyList.find((a) => a.code === data.suggestedSigunguCode) || {}).name || '')
            : '';
        sigunguInput.value = sigunguName;

        const codes = data.deliveryCodes && data.deliveryCodes.length ? data.deliveryCodes : [data.deliveryCode];
        const deliveryLabel = codes.length > 1
            ? `${codes.length}개 노선 — ${escapeHtml(codes.join(', '))}`
            : escapeHtml(codes[0] || '-');
        metaEl.innerHTML = `
            <div class="meta-row"><span class="meta-label">관리번호</span><span>${deliveryLabel}</span></div>
            <div class="meta-row"><span class="meta-label">DBF 원본 관리기관코드</span><span>${escapeHtml(data.dbfMcoCode || '-')} (참고용, 시군구 판정에 미사용)</span></div>
            <div class="meta-row"><span class="meta-label">신규/삭제 레코드</span><span>${data.totalNew}건 / ${data.totalDelete}건</span></div>
            ${data.mergedLargeFiles ? `<div class="meta-row"><span class="meta-label">사전 업로드 파일</span><span>${data.largeFileCount}건 병합됨(사진·보고서·도면)</span></div>` : ''}
            ${data.sectorCount ? `<div class="meta-row"><span class="meta-label">500m 구간 정보</span><span>${data.sectorCount}건 발견(도면/500SHP)</span></div>` : ''}
            ${(data.rankNameHints || []).length ? `<div class="meta-row"><span class="meta-label">도로종류(파일명 인식)</span><span>${(data.rankNameHints || []).map((h) => `${escapeHtml(h.deliveryCode)} → ${escapeHtml(h.name)}`).join(', ')}</span></div>` : ''}
        `;

        layersEl.innerHTML = '';
        data.layers.forEach((l) => {
            const row = document.createElement('div');
            const hasWarning = !l.fieldMatch.ok || l.warnings.length > 0;
            row.className = 'layer-row' + (hasWarning ? ' has-warning' : '');
            const crsLabel = l.crs ? (l.crs.matched ? l.crs.label : '좌표계 인식 실패') : '지오메트리 없음';
            row.innerHTML = `
                ${hasWarning ? '<i class="fa-solid fa-triangle-exclamation"></i>' : '<i class="fa-solid fa-check" style="color:var(--accent-hover);"></i>'}
                <span class="layer-name">${escapeHtml(l.koreanName)} (${l.code})</span>
                <span class="layer-count">${l.newCount}건${l.deleteCount ? ' / 삭제 ' + l.deleteCount + '건' : ''} · ${escapeHtml(crsLabel)}</span>
            `;
            layersEl.appendChild(row);
        });

        renderKrrisChecks(data);

        const allWarnings = [];
        if (data.unknownLayerCodes.length) allWarnings.push(`알 수 없는 레이어코드: ${data.unknownLayerCodes.join(', ')}`);
        data.layers.forEach((l) => l.warnings.forEach((w) => allWarnings.push(w)));
        if (allWarnings.length) {
            warningsEl.innerHTML = allWarnings.map((w) => escapeHtml(w)).join('<br>');
            warningsEl.classList.add('show');
        } else {
            warningsEl.innerHTML = '';
            warningsEl.classList.remove('show');
        }

        resultEl.textContent = '';
        hideReviewError();
    }

    // KRRIS(국가 도로대장 검수) 사전검사 결과 — C-1 좌표계, M-1 필수항목 빈 값, V-1 코드표에 없는 값.
    // 등록을 막지는 않고(업체 데이터를 일단 받아두고 보완 요청하는 흐름), 결함 목록을
    // CSV로 내려받아 업체에 그대로 보낼 수 있게 한다. 서버 lib/bulkImportParse.js 참고.
    function renderKrrisChecks(data) {
        const k = data.krris;
        if (!k) { krrisEl.innerHTML = ''; return; }
        const crsBad = k.crs.length;
        const crsByEpsg = {};
        k.crs.forEach((c) => {
            const key = c.status === 'mismatch' ? `${c.label} (${c.epsg})` : (c.status === 'no-prj' ? '.prj 없음' : '인식 불가');
            crsByEpsg[key] = (crsByEpsg[key] || 0) + 1;
        });
        const crsDetail = crsBad
            ? Object.entries(crsByEpsg).map(([lbl, n]) => `${escapeHtml(lbl)} — ${n}개 레이어`).join('<br>')
            : `SHP ${k.checkedShpLayers}개 레이어 모두 ${escapeHtml(k.requiredEpsg)}`;
        const nnRows = k.nn.map((n) => `
            <tr>
                <td>${escapeHtml(n.koreanName)}</td>
                <td>${escapeHtml(n.label)}<span class="kr-field">${escapeHtml(n.field)}</span></td>
                <td class="kr-num">${(n.emptyCount + n.nullCount).toLocaleString()}${n.nullCount ? '<span class="kr-skip">저장 제외 ' + n.nullCount + '</span>' : ''}</td>
            </tr>`).join('');
        // V-1: 코드표에 없는 코드값 — 필드별로 어떤 값이 몇 건인지(많은 순 일부)
        const hasCodeCheck = typeof k.codesTotal === 'number'; // 서버가 V-1을 아직 모르는 옛 버전이면 항목 자체를 숨긴다
        const codesTotal = k.codesTotal || 0;
        const codeRows = (k.codes || []).map((c) => `
            <tr>
                <td>${escapeHtml(c.koreanName)}</td>
                <td>${escapeHtml(c.label)}<span class="kr-field">${escapeHtml(c.field)}</span></td>
                <td class="kr-num">${c.total.toLocaleString()}</td>
                <td>${c.values.map((v) => `<span class="kr-code">${escapeHtml(v.value)}<i>${v.count.toLocaleString()}건</i></span>`).join(' ')}${c.distinct > c.values.length ? ` 외 ${c.distinct - c.values.length}종` : ''}</td>
            </tr>`).join('');
        const anyDefect = crsBad || k.nnTotal || codesTotal;
        krrisEl.innerHTML = `
            <div class="kr-head">
                <span>KRRIS 사전검사</span>
                ${anyDefect ? '<button type="button" id="bulk-krris-download" class="kr-dl"><i class="fa-solid fa-download"></i> 결함 목록</button>' : ''}
            </div>
            <div class="kr-item ${crsBad ? 'fail' : 'pass'}">
                <i class="fa-solid ${crsBad ? 'fa-triangle-exclamation' : 'fa-circle-check'}"></i>
                <div><b>C-1 좌표계</b> ${crsBad ? `<span class="kr-msg">제출 기준 ${escapeHtml(k.requiredEpsg)}(UTM-K) 아님</span>` : '<span class="kr-msg">적합</span>'}
                <div class="kr-sub">${crsDetail}</div></div>
            </div>
            <div class="kr-item ${k.nnTotal ? 'fail' : 'pass'}">
                <i class="fa-solid ${k.nnTotal ? 'fa-triangle-exclamation' : 'fa-circle-check'}"></i>
                <div><b>M-1 필수항목</b> <span class="kr-msg">${k.nnTotal ? `빈 값 ${k.nnTotal.toLocaleString()}건` : '누락 없음'}</span>
                ${k.nnTotal ? `<table class="kr-table"><thead><tr><th>레이어</th><th>항목</th><th>건수</th></tr></thead><tbody>${nnRows}</tbody></table>` : ''}</div>
            </div>
            ${hasCodeCheck ? `<div class="kr-item ${codesTotal ? 'fail' : 'pass'}">
                <i class="fa-solid ${codesTotal ? 'fa-triangle-exclamation' : 'fa-circle-check'}"></i>
                <div><b>V-1 코드표</b> <span class="kr-msg">${codesTotal ? `코드표에 없는 값 ${codesTotal.toLocaleString()}건` : '이상 없음'}</span>
                ${codesTotal ? `<div class="kr-sub">공통입력코드정의서(v2.6)의 코드가 아닌 값입니다. 등록은 되지만 원본 수정이 필요한지 확인하세요. 관리기관(MCO)은 대조하지 않으며, 정의서 주석이 인정하는 표기(표지명칭 406 = 40600 등)는 오류로 보지 않습니다.</div>
                <table class="kr-table"><thead><tr><th>레이어</th><th>항목</th><th>건수</th><th>코드표에 없는 값 (건수)</th></tr></thead><tbody>${codeRows}</tbody></table>` : ''}</div>
            </div>` : ''}
            ${anyDefect ? '<div class="kr-note">등록은 그대로 진행할 수 있습니다. 이 원본을 KRRIS에 제출하면 위 항목이 결함으로 지적됩니다.</div>' : ''}
        `;
        const dl = document.getElementById('bulk-krris-download');
        if (dl) dl.addEventListener('click', () => downloadKrrisReport(data.uploadId, dl));
    }

    async function downloadKrrisReport(uploadId, btn) {
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-hourglass-half"></i> 생성 중';
        try {
            const res = await adminFetch(`/api/bulk-import/${encodeURIComponent(uploadId)}/krris-report`);
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                uiAlert(err.error || '결함 목록을 만들지 못했습니다.');
                return;
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const m = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('Content-Disposition') || '');
            a.download = m ? decodeURIComponent(m[1]) : 'KRRIS사전검사.csv';
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            uiAlert('결함 목록 다운로드 중 오류가 발생했습니다.');
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    }

    function resetToUploadStep() {
        bulkFile = null;
        bulkFolderFiles = null;
        currentPreview = null;
        renderBulkFileList();
        statusEl.textContent = '';
        hideUploadError();
        incomingFolderInput.value = '';
        uploadStep.style.display = '';
        reviewPanel.style.display = 'none';
    }

    registerBtn.addEventListener('click', async () => {
        if (bulkMode === 'zip' && !bulkFile && !bulkFolderFiles) {
            showUploadError('먼저 ZIP 파일이나 폴더를 선택하세요.');
            return;
        }
        if (bulkMode === 'incoming' && selectedIncomingFolders.size !== 1) {
            showUploadError(
                selectedIncomingFolders.size === 0
                    ? '먼저 서버에 올려둔 폴더를 하나 선택하세요.'
                    : '검수 화면은 폴더 1개만 지원합니다 — 여러 개는 아래 "선택 항목 일괄등록"을 이용하세요.'
            );
            return;
        }
        hideUploadError();
        statusEl.innerHTML = '<i class="fa-solid fa-hourglass-half bulk-spinner"></i>업로드 및 파싱 중입니다... (파일 크기에 따라 시간이 걸릴 수 있습니다)';
        registerBtn.disabled = true;
        bulkTabEl.classList.add('bulk-loading');
        try {
            let res;
            if (bulkMode === 'zip' && bulkFolderFiles) {
                const fd = new FormData();
                bulkFolderFiles.forEach((f) => fd.append('files', f, f.webkitRelativePath));
                fd.append('incomingFolderName', incomingFolderInput.value.trim());
                res = await adminFetch('/api/bulk-import/preview-folder-upload', { method: 'POST', body: fd });
            } else if (bulkMode === 'zip') {
                const fd = new FormData();
                fd.append('file', bulkFile);
                fd.append('incomingFolderName', incomingFolderInput.value.trim());
                res = await adminFetch('/api/bulk-import/preview', { method: 'POST', body: fd });
            } else {
                res = await adminFetch('/api/bulk-import/preview-from-folder', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: [...selectedIncomingFolders][0] }),
                });
            }
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '검수에 실패했습니다.');
            statusEl.textContent = '';
            // 일괄등록 이력에 "무엇을 올렸는지" 남기기 위한 이름
            data.sourceName = bulkMode === 'zip'
                ? (bulkFolderFiles ? bulkFolderFiles[0].webkitRelativePath.split('/')[0] : (bulkFile ? bulkFile.name : ''))
                : [...selectedIncomingFolders][0];
            currentPreview = data;
            renderReview(data);
            uploadStep.style.display = 'none';
            reviewPanel.style.display = 'block';
        } catch (e) {
            statusEl.textContent = '';
            showUploadError(e.message);
        } finally {
            registerBtn.disabled = false;
            bulkTabEl.classList.remove('bulk-loading');
        }
    });

    cancelBtn.addEventListener('click', async () => {
        if (currentPreview) {
            await adminFetch(`/api/bulk-import/${currentPreview.uploadId}`, { method: 'DELETE' });
        }
        resetToUploadStep();
    });

    confirmBtn.addEventListener('click', async () => {
        if (!currentPreview) return;
        const sigunguCode = mcoCodeByName(sigunguInput.value.trim());
        if (!sigunguCode) {
            showReviewError('대상 시군구를 목록에서 정확히 선택하세요.');
            return;
        }
        hideReviewError();
        confirmBtn.disabled = true;
        resultEl.innerHTML = '<i class="fa-solid fa-hourglass-half bulk-spinner"></i>저장 중입니다...';
        bulkTabEl.classList.add('bulk-loading');
        try {
            const data = await confirmAndWait(
                currentPreview.uploadId,
                {
                    sigunguCode,
                    acknowledgeUnrecognizedCrs: currentPreview.blockingWarnings.length > 0,
                    roadRankDisplayName: document.getElementById('bulk-review-rank-name').value,
                    sourceLabel: currentPreview.sourceName || '',
                },
                (job) => {
                    resultEl.innerHTML = `<i class="fa-solid fa-hourglass-half bulk-spinner"></i>${escapeHtml(job.stage)}${job.total ? ` (노선 ${job.done}/${job.total}${job.currentRoute ? ' — ' + escapeHtml(job.currentRoute) : ''})` : ''}`;
                }
            );
            const insertedTotal = Object.values(data.inserted || {}).reduce((sum, n) => sum + n, 0);
            let msg = `등록 완료: ${insertedTotal}건 저장, 노선 ${data.roadSectionsUpserted}건이 데이터보기 트리에 동기화됐습니다.`;
            if (data.facilityFilesAttached || data.drawingFilesAttached) {
                msg += ` 첨부파일 ${data.facilityFilesAttached}건, 도면 ${data.drawingFilesAttached}건이 자동 연결됐습니다.`;
            }
            const da = data.drawingsAuto || {};
            if (da.failed) {
                msg += ' 구간 도면(500_P/CONT 등) 자동 분류 중 오류가 났습니다 — 도면 업로드 탭에서 다시 올려 주세요.';
            } else if (da.matchedCount || da.unmatchedCount) {
                msg += ` 구간 도면 ${da.matchedCount || 0}건을 파일명으로 노선·구간에 자동 분류했습니다.`;
                if (da.unmatchedCount) {
                    msg += ` 인식 못한 ${da.unmatchedCount}건: ${da.unmatched.slice(0, 5).map((u) => u.name).join(', ')}${da.unmatchedCount > 5 ? ' 외' : ''} (도면 업로드 탭에서 노선을 골라 올리세요).`;
                }
            }
            if (data.sectorsInserted) {
                msg += ` 500m 구간 정보 ${data.sectorsInserted}건이 저장됐습니다.`;
            }
            const unmatched = data.facilityFilesUnmatched || [];
            if (unmatched.length) {
                msg += ` (연결 안 된 파일 ${unmatched.length}건: ${unmatched.slice(0, 5).join(', ')}${unmatched.length > 5 ? ' 외' : ''})`;
            }
            if (data.incomingFolderRemoved) msg += ' 서버 폴더는 등록 완료 후 삭제됐습니다.';
            resultEl.textContent = msg;
            loadLedgerTree();
            if (data.incomingFolderRemoved) { selectedIncomingFolders.clear(); loadIncomingFolders(); }
            if (data.failedRoutes && data.failedRoutes.length) {
                // 일부 노선이 실패: 성공한 노선은 저장됐다. 검수 화면을 닫지 않고 남겨 두어 확인한 뒤 다시 시도할 수 있게 한다.
                showReviewError(`노선 ${data.failedRoutes.length}개는 저장하지 못했습니다: ${failedRoutesText(data)}. 나머지 노선은 저장됐습니다. 원인을 해결한 뒤 같은 납품을 다시 등록하면 이어서 저장됩니다.`);
            } else {
                setTimeout(resetToUploadStep, unmatched.length ? 6000 : 2500);
            }
        } catch (e) {
            resultEl.textContent = '';
            showReviewError(e.message);
        } finally {
            confirmBtn.disabled = false;
            bulkTabEl.classList.remove('bulk-loading');
        }
    });

    renderBulkFileList();
}

// 일괄등록 확정: 서버가 백그라운드로 저장하는 작업(job)을 시작하고, 끝날 때까지 진행 상황을 조회해서 최종 결과를 돌려준다.
// 노선이 많아도 요청 하나가 오래 걸리지 않아 프록시 시간 제한에 걸리지 않는다. onProgress(job): 진행 중 호출(화면 표시용).
async function confirmAndWait(uploadId, body, onProgress) {
    const res = await adminFetch(`/api/bulk-import/${uploadId}/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const start = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(start.error || '등록에 실패했습니다.');
    let netFailures = 0;
    for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        let job;
        try {
            const r = await adminFetch(`/api/bulk-import/jobs/${start.jobId}`);
            job = await r.json();
            if (!r.ok) throw new Error(job.error || '진행 상황을 확인하지 못했습니다.');
        } catch (e) {
            // 네트워크가 잠깐 끊긴 정도는 몇 번 더 시도한다(서버 작업은 계속 진행 중이다).
            if (++netFailures > 5 || /찾을 수 없습니다/.test(e.message)) throw e;
            continue;
        }
        netFailures = 0;
        if (onProgress) onProgress(job);
        if (job.status === 'done') return job.result;
        if (job.status === 'error') throw new Error(job.error || '등록에 실패했습니다.');
    }
}

// 실패한 노선 안내 문구: "415902026201001(필수 값이 비어 있는…), …"
function failedRoutesText(data) {
    const f = (data && data.failedRoutes) || [];
    return f.slice(0, 5).map((r) => `${r.code}(${r.error})`).join(', ') + (f.length > 5 ? ` 외 ${f.length - 5}개` : '');
}

function initLedgerTreeToolbar() {
    document.getElementById('ledger-tree-header').addEventListener('click', () => {
        document.getElementById('ledger-tree-section').classList.toggle('collapsed');
    });
    document.getElementById('tree-expand-all-btn').addEventListener('click', () => {
        document.querySelectorAll('#ledger-tree .tree-node:not(.tree-leaf)').forEach((n) => n.classList.add('open'));
    });
    document.getElementById('tree-collapse-all-btn').addEventListener('click', () => {
        document.querySelectorAll('#ledger-tree .tree-node:not(.tree-leaf)').forEach((n) => n.classList.remove('open'));
    });
    document.getElementById('tree-refresh-btn').addEventListener('click', () => loadLedgerTree());
    document.getElementById('tree-export-btn').addEventListener('click', downloadSectionExport);
    document.getElementById('tree-multi-btn').addEventListener('click', () => setTreeMultiMode(!treeMultiMode));
    document.getElementById('tree-multi-cancel-btn').addEventListener('click', () => setTreeMultiMode(false));
    document.getElementById('tree-multi-download-btn').addEventListener('click', downloadCheckedRoutes);
    document.getElementById('ledger-report-preview-btn').addEventListener('click', openLedgerReportPreview);
    document.getElementById('fit-all-routes-btn').addEventListener('click', fitAllRegisteredRoutes);
}

// 조서 새창 미리보기 — 다운로드(zip, 여러 구간 가능)와 달리 구간을 정확히
// 하나 선택했을 때만 된다(currentRoute.rdid가 있는 경우 — cad-viewer.js의
// downloadScopeParams와 같은 판단 기준). 서버가 돌려준 xlsx 원본을 SheetJS로
// 브라우저에서 직접 해석해 표(HTML)로 그려서 새 창에 띄운다 — 다운로드 없이
// "열어서 바로 보기"가 목적이라 파일로 저장되지 않는다.
async function openLedgerReportPreview() {
    if (!currentRoute || !currentRoute.rdid) {
        uiAlert('조서 미리보기는 구간을 하나 선택했을 때만 가능합니다.');
        return;
    }
    // window.open()은 반드시 클릭 핸들러 안에서 await 없이(동기적으로) 바로
    // 불러야 브라우저 팝업 차단에 안 걸린다 — fetch를 먼저 기다린 뒤에 열면
    // "사용자 제스처"로 인정 안 돼 실제 사용자 클릭에서도 차단당할 수 있다
    // (직접 테스트로 확인함). 그래서 창부터 빈 채로 열어 로딩 문구를 띄워두고,
    // 데이터가 준비되면 그 창에 내용을 채워 넣는 순서로 바꿨다.
    const win = window.open('', '_blank');
    if (!win) {
        uiAlert('팝업이 차단되었습니다 — 브라우저의 팝업 차단을 해제해주세요.');
        return;
    }
    win.document.write('<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>조서 불러오는 중...</title></head><body style="font-family:\'Malgun Gothic\',sans-serif;padding:40px;color:#555;">불러오는 중...</body></html>');
    win.document.close();

    const btn = document.getElementById('ledger-report-preview-btn');
    document.body.classList.add('app-busy');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-hourglass-half bulk-spinner"></i> 조서';
    try {
        const res = await fetch('/api/sections/ledger-report-preview?rdid=' + encodeURIComponent(currentRoute.rdid));
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            win.close();
            uiAlert(data.error || '조서 생성에 실패했습니다.');
            return;
        }
        const buf = await res.arrayBuffer();
        const workbook = XLSX.read(buf, { type: 'array' });
        const sheetNames = workbook.SheetNames;
        const tabsHtml = sheetNames.map((name, i) =>
            `<button class="lrp-tab${i === 0 ? ' active' : ''}" data-idx="${i}">${escapeHtml(name)}</button>`
        ).join('');
        const panelsHtml = sheetNames.map((name, i) =>
            `<div class="lrp-panel" data-idx="${i}" style="${i === 0 ? '' : 'display:none;'}">${XLSX.utils.sheet_to_html(workbook.Sheets[name], { editable: false })}</div>`
        ).join('');
        const title = `도로대장 조서 - ${currentRoute.route_name || currentRoute.rdid}`;
        // "선택 구간" 다운로드는 이미 미리보기용으로 받아둔 xlsx(buf)를 그대로
        // 쓴다(재요청 안 함) — Blob URL로 만들어 팝업 창에 넘기면 된다. opener
        // 탭(지금 이 탭)이 열려있는 동안은 팝업에서도 그대로 유효하다.
        const singleBlobUrl = URL.createObjectURL(new Blob([buf], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }));
        const singleFileName = `${(currentRoute.route_name || currentRoute.rdid).replace(/[/\\:*?"<>|]/g, '_')}_도로대장_${new Date().toISOString().slice(0, 10)}.xlsx`;
        // "호선 다운로드"용 쿼리 — downloadScopeParams(cad-viewer.js)의 2번째
        // 분기(road_grade+route_no)와 같은 규칙. 트리에서 구간을 선택해도
        // currentRoute에 route_no/road_rank_name이 같이 들어있어(script.js의
        // sectionInfo 병합 참고) 여기서 그대로 쓸 수 있다.
        const routeQs = new URLSearchParams({
            road_grade: currentRoute.road_rank_name || currentRoute.road_grade || '',
            route_no: currentRoute.route_no || '',
            route_name: currentRoute.route_name || '',
        }).toString();
        win.document.open();
        win.document.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; font-family: 'Malgun Gothic', sans-serif; background: #e8e8e8; }
  #lrp-toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; background: #2c2c2c; padding: 8px 8px 0; position: sticky; top: 0; z-index: 10; }
  #lrp-toolbar-buttons { display: flex; gap: 6px; margin: 0 4px 8px auto; }
  #lrp-toolbar-buttons button { border: none; border-radius: 4px; padding: 7px 12px; font-size: 0.8rem; font-weight: 700; cursor: pointer; }
  #lrp-download-selected { background: #2e6fae; color: #fff; }
  #lrp-download-route { background: #5a7a4a; color: #fff; }
  #lrp-download-all { background: #4a4a4a; color: #ddd; }
  #lrp-toolbar-buttons button:disabled { opacity: 0.6; cursor: default; }
  #lrp-tabs { display: flex; flex-wrap: wrap; gap: 2px; }
  .lrp-tab { border: none; background: #4a4a4a; color: #ccc; padding: 8px 14px; font-size: 0.82rem; cursor: pointer; border-radius: 4px 4px 0 0; }
  .lrp-tab.active { background: #e8e8e8; color: #111; font-weight: 700; }
  .lrp-panel { padding: 16px; overflow-x: auto; }
  table { border-collapse: collapse; background: #fff; }
  td, th { border: 1px solid #999; padding: 4px 8px; font-size: 0.82rem; white-space: nowrap; }
</style></head><body>
<div id="lrp-toolbar">
  <div id="lrp-tabs">${tabsHtml}</div>
  <div id="lrp-toolbar-buttons">
    <button id="lrp-download-selected" title="지금 보고 있는 이 구간만 xlsx로 저장"><i class="fa-solid fa-file-excel"></i> 선택 구간 다운로드</button>
    <button id="lrp-download-route" title="이 구간이 속한 호선(${escapeHtml(currentRoute.route_name || '')}) 전체를 zip으로 저장"><i class="fa-solid fa-road"></i> 호선 다운로드</button>
    <button id="lrp-download-all" title="관할 전체 구간을 국토부 표준서식 zip으로 저장"><i class="fa-solid fa-file-zipper"></i> 전체 자료 다운로드</button>
  </div>
</div>
${panelsHtml}
<script>
document.getElementById('lrp-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.lrp-tab');
    if (!btn) return;
    document.querySelectorAll('.lrp-tab').forEach((t) => t.classList.toggle('active', t === btn));
    document.querySelectorAll('.lrp-panel').forEach((p) => { p.style.display = p.dataset.idx === btn.dataset.idx ? '' : 'none'; });
});
document.getElementById('lrp-download-selected').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = ${JSON.stringify(singleBlobUrl)};
    a.download = ${JSON.stringify(singleFileName)};
    a.click();
});
async function lrpDownloadZip(btnId, url, originalLabel, busyLabel, errorLabel) {
    const btn = document.getElementById(btnId);
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-hourglass-half"></i> ' + busyLabel;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            uiAlert(data.error || '조서 생성에 실패했습니다.');
            return;
        }
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const cd = res.headers.get('Content-Disposition') || '';
        const m = /filename\\*=UTF-8''([^;]+)/.exec(cd);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = m ? decodeURIComponent(m[1]) : '도로대장_조서.zip';
        a.click();
        URL.revokeObjectURL(blobUrl);
    } catch (e) {
        uiAlert(errorLabel);
    } finally {
        btn.disabled = false;
        btn.innerHTML = original;
    }
}
document.getElementById('lrp-download-route').addEventListener('click', () => {
    lrpDownloadZip('lrp-download-route', '/api/sections/ledger-report?' + ${JSON.stringify(routeQs)}, '호선 다운로드', '생성 중...', '호선 다운로드 중 오류가 발생했습니다.');
});
document.getElementById('lrp-download-all').addEventListener('click', () => {
    lrpDownloadZip('lrp-download-all', '/api/sections/ledger-report', '전체 자료 다운로드', '생성 중...', '전체 자료 다운로드 중 오류가 발생했습니다.');
});
<\/script>
</body></html>`);
        win.document.close();
    } catch (e) {
        console.error('[ledger-report-preview]', e);
        uiAlert('조서 미리보기 중 오류가 발생했습니다.');
    } finally {
        document.body.classList.remove('app-busy');
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
}

// ---------- 데이터보기: 도로대장 트리 ----------
async function loadLedgerTree() {
    const container = document.getElementById('ledger-tree');
    container.innerHTML = '<div class="tree-empty">불러오는 중...</div>';

    let tree;
    try {
        const res = await fetch('/api/sections/tree');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        ({ tree } = await res.json());
    } catch (e) {
        container.innerHTML = `<div class="tree-empty">불러오기 실패: ${escapeHtml(e.message)}<br>서버 콘솔(pm2 logs) 확인 필요</div>`;
        return;
    }
    const dataByGrade = new Map((tree || []).map((g) => [g.road_grade, g.routes]));

    container.innerHTML = '';
    // 데이터가 없는 등급도 항상 목록에 보이도록, 실제 등록된 데이터와 무관하게
    // 국토부 표준 도로등급 9종 + 아직 코드/테이블 설계 전인 확장 목록(면도/리도/
    // 농도/도시계획도로, TREE_ROAD_GRADES 선언부 주석 참고)을 고정 목록으로 표시한다.
    TREE_ROAD_GRADES.forEach((grade) => {
        const routes = dataByGrade.get(grade) || [];
        const totalSections = routes.reduce((sum, r) => sum + r.sections.length, 0);
        const gradeNode = buildTreeGroup(grade, totalSections);
        // 도로 종류 제목을 누르면(펴기/접기와 함께) 그 종류의 노선 전부를 지도에 표시한다
        if (totalSections > 0) gradeNode.node.querySelector('.tree-node-label').addEventListener('click', () => showGradeRoutesOnMap(grade));
        if (routes.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'tree-node-empty';
            empty.textContent = '등록된 노선 없음';
            gradeNode.children.appendChild(empty);
        }
        routes.forEach((route) => {
            const routeLabel = route.route_no
                ? `${routeNoLabel(route.route_no)}${route.route_name ? ' : ' + route.route_name : ''}`
                : (route.route_name || '(미지정)');
            const routeNode = buildTreeGroup(routeLabel, route.sections.length, true);
            // 여러 노선 선택 내려받기용: 이 노선의 구간 rdid 목록과 표시 이름
            routeNode.node.querySelector('.tree-node-label').dataset.rdids = route.sections.map((s) => s.rdid).join(',');
            routeNode.node.querySelector('.tree-node-label').dataset.routeTitle = routeLabel;
            routeNode.node.querySelector('.tree-node-label').addEventListener('click', (e) => {
                if (e.target.closest('.tree-route-check')) return; // 체크박스는 선택용 — 노선 선택(지도 이동)과 별개
                if (e.target.closest('.tree-caret')) return; // 화살표는 위에서 펴기/접기만 처리
                document.querySelectorAll('.tree-leaf.selected').forEach((el) => el.classList.remove('selected'));
                selectRouteGroupForLeftSidebar(grade, route);
                selectRouteGroup(grade, route);
            });
            route.sections.forEach((section) => {
                const leafLabel = section.sect ? `${section.sect}구간` : '(구간번호 미지정)';
                const sectionInfo = {
                    rdid: section.rdid, road_grade: grade, road_rank_name: grade,
                    route_no: route.route_no, route_name: route.route_name, sect: section.sect,
                    s_point: section.s_point, e_point: section.e_point, length_m: section.length_m,
                };
                const leaf = buildTreeLeaf(leafLabel, sectionInfo);
                leaf.addEventListener('click', () => {
                    document.querySelectorAll('.tree-leaf.selected').forEach((el) => el.classList.remove('selected'));
                    leaf.classList.add('selected');
                    selectSectionForLeftSidebar(sectionInfo);
                });
                routeNode.children.appendChild(leaf);
            });
            gradeNode.children.appendChild(routeNode.node);
        });
        container.appendChild(gradeNode.node);
    });
    if (treeMultiMode) applyTreeMultiCheckboxes(); // 선택 모드가 켜진 채로 목록이 다시 그려지면 체크박스를 다시 붙인다
    applyTreeFilter();
}

// ---------- 여러 노선 골라서 내려받기 ----------
// 도로대장 트리의 [목록 체크] 버튼으로 선택 모드를 켜면 노선마다 체크박스가 나타난다. 고른 노선들의 구간을
// 한 번에 "관리번호 폴더별 ZIP"으로 받는다(서버가 스트리밍으로 보내므로 용량이 커도 된다).
let treeMultiMode = false;
const TREE_MULTI_MAX_SECTIONS = 300; // 서버(sections.js MAX_EXPORT_RDIDS)와 같은 값

function applyTreeMultiCheckboxes() {
    document.querySelectorAll('#ledger-tree .tree-node-label[data-rdids]').forEach((label) => {
        if (label.querySelector('.tree-route-check')) return;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'tree-route-check';
        cb.title = '이 노선 선택';
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', updateTreeMultiBar);
        label.insertBefore(cb, label.firstChild);
    });
    updateTreeMultiBar();
}

function checkedTreeRoutes() {
    return [...document.querySelectorAll('#ledger-tree .tree-route-check:checked')].map((cb) => cb.closest('.tree-node-label'));
}

function updateTreeMultiBar() {
    const checked = checkedTreeRoutes();
    const sections = checked.reduce((n, l) => n + l.dataset.rdids.split(',').filter(Boolean).length, 0);
    document.getElementById('tree-multi-info').textContent = checked.length
        ? `노선 ${checked.length}개 · 구간 ${sections}개 선택` : '내려받을 노선을 체크하세요';
    document.getElementById('tree-multi-download-btn').disabled = !checked.length;
}

function setTreeMultiMode(on) {
    treeMultiMode = on;
    document.getElementById('tree-multi-btn').classList.toggle('active', on);
    document.getElementById('tree-multi-btn').setAttribute('aria-pressed', String(on));
    document.getElementById('tree-multi-bar').hidden = !on;
    if (on) {
        applyTreeMultiCheckboxes();
    } else {
        document.querySelectorAll('#ledger-tree .tree-route-check').forEach((cb) => cb.remove());
    }
}

function downloadCheckedRoutes() {
    const rdids = checkedTreeRoutes().flatMap((l) => l.dataset.rdids.split(',').filter(Boolean));
    if (!rdids.length) return;
    if (rdids.length > TREE_MULTI_MAX_SECTIONS) {
        uiAlert(`한 번에 구간 ${TREE_MULTI_MAX_SECTIONS}개까지만 내려받을 수 있습니다. 지금 ${rdids.length}개를 골랐으니 나누어 받아 주세요.`);
        return;
    }
    downloadSectionExportWith({ rdids: rdids.join(',') });
}

// caretOnlyToggle: true면 화살표(.tree-caret)를 눌렀을 때만 펴고 접힌다 —
// 라벨(글자) 클릭은 토글하지 않고 호출한 쪽에서 별도 동작(노선 선택 등)에
// 쓸 수 있게 비워둔다. false(기본)는 기존처럼 라벨 전체 클릭이 토글.
function buildTreeGroup(label, count, caretOnlyToggle) {
    const node = document.createElement('div');
    // 0건 항목은 흐리게(도로등급 13종 중 실제 데이터가 있는 것만 눈에 띄게) — count는 숫자 또는 "1,234" 문자열
    node.className = 'tree-node' + (Number(String(count).replace(/,/g, '')) === 0 ? ' is-empty' : '');
    const labelEl = document.createElement('div');
    labelEl.className = 'tree-node-label';
    labelEl.innerHTML = `<i class="fa-solid fa-caret-right tree-caret"></i><span>${escapeHtml(label)}</span><span class="tree-count">${count}</span>`;
    const children = document.createElement('div');
    children.className = 'tree-children';
    if (caretOnlyToggle) {
        labelEl.querySelector('.tree-caret').addEventListener('click', (e) => {
            e.stopPropagation();
            node.classList.toggle('open');
        });
    } else {
        labelEl.addEventListener('click', () => node.classList.toggle('open'));
    }
    node.appendChild(labelEl);
    node.appendChild(children);
    return { node, children };
}

function buildTreeLeaf(label, sectionInfo) {
    const rdid = sectionInfo?.rdid;
    const node = document.createElement('div');
    node.className = 'tree-node tree-leaf';
    const labelEl = document.createElement('div');
    labelEl.className = 'tree-node-label';
    labelEl.innerHTML = `<i class="fa-solid fa-road" style="width:12px;font-size:0.75rem;"></i><span>${escapeHtml(label)}</span>`;
    node.appendChild(labelEl);

    if (rdid) {
        node.dataset.rdid = rdid;
        const delBtn = document.createElement('button');
        delBtn.className = 'tree-delete-btn';
        delBtn.title = '구간 삭제';
        delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteSectionFromTree(rdid, label); });
        labelEl.appendChild(delBtn);

        // 주요시설물/부대시설을 따로 켜고 끌 수 있게 아이콘 2개로 분리했다.
        // 구간을 선택해도 둘 다 자동으로 켜지지 않는다 — 필요할 때만 이 아이콘으로 켠다.
        const toggleGroup = document.createElement('span');
        toggleGroup.className = 'tree-facility-toggle-group';
        FACILITY_TOGGLE_GROUP_DEFS.forEach(({ name, className, icon }) => {
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = `tree-facility-toggle ${className}`;
            toggle.innerHTML = `<i class="${icon}"></i>`;
            toggle.dataset.group = name;
            paintFacilityGroupToggle(toggle, name, sectionFacilityActiveGroups.has(facilityGroupKey(facilitySectionKey(sectionInfo), name)));
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                const nowActive = sectionFacilityActiveGroups.has(facilityGroupKey(facilitySectionKey(sectionInfo), name));
                setSectionFacilityGroupActive(sectionInfo, name, !nowActive, toggle);
            });
            toggleGroup.appendChild(toggle);
        });
        labelEl.appendChild(toggleGroup);
    }
    return node;
}

// ---------- 부속시설(데이터보기 탭) ----------
// 국토교통부 「도로대장공간정보 테이블정의서 v2.3」의 "시설물분류" 시트 기준
// (주요시설물/부대시설/기타시설물 3단 분류, 일부는 기하구조·토공및배수시설·
// 안전시설 하위그룹 포함) — 이 앱이 실제로 다루는 22종만 대입해 정리한 것.
// 표준은 부대시설 > 안전시설 아래 방호울타리/충격흡수시설을 따로 두지만,
// 이 시스템은 둘을 gov_defence 테이블 하나("차량방호안전시설")로 합쳐서 관리한다.
const FACILITY_GROUPS = [
    {
        group: '주요시설물',
        items: ['교량', '터널', '육교', '지하차도', '고가도로', '인터체인지(IC)', '지하보도'],
        subgroups: [
            { name: '기하구조', items: ['교차시설', '오르막차로', '정차대'] },
            { name: '토공및배수시설', items: ['측구', '석축', '옹벽', '도로절개면', '도로성토면', '배수암거및배수관'] },
        ],
    },
    {
        group: '부대시설',
        items: ['방음시설', '가로수', '지하매설물', '과적검문소', '제설시설', '공동구', '통로박스', '생태통로', '긴급제동시설', '과속방지턱', '졸음쉼터'],
        subgroups: [
            { name: '안전시설', items: ['중앙분리대', '차량방호안전시설', '충격흡수시설', '낙석방지시설', '표지', '전광표지', '가로등', '신호등'] },
        ],
    },
];

// 도로대장 트리(구간 리프)의 시설물 표시 아이콘 2개 정의 — FACILITY_GROUPS의
// 그룹명과 1:1로 대응한다(buildTreeLeaf에서 사용).
const FACILITY_TOGGLE_GROUP_DEFS = [
    { name: '주요시설물', className: 'group-main', icon: 'fa-solid fa-landmark' },
    { name: '부대시설', className: 'group-aux', icon: 'fa-solid fa-signs-post' },
];

// FACILITY_GROUPS의 한 그룹(주요시설물/부대시설)에 속한 시설물 종류를 소그룹까지
// 다 펼쳐 하나의 배열로 돌려준다 — 그룹 단위 지도 표시 on/off에 쓴다.
function facilityGroupTypeList(groupName) {
    const g = FACILITY_GROUPS.find((x) => x.group === groupName);
    if (!g) return [];
    return [...g.items, ...g.subgroups.flatMap((sg) => sg.items)];
}

// 시설물 종류(라벨) -> 소속 그룹명 역인덱스. sectionFacilityLayer 스타일 함수와
// setSectionFacilityGroupActive가 함께 쓴다.
const facilityLabelGroupMap = new Map();
FACILITY_GROUPS.forEach(({ group }) => {
    facilityGroupTypeList(group).forEach((label) => facilityLabelGroupMap.set(label, group));
});

// "구간 rdid::그룹명" 조합이 이 안에 있으면 그 구간의 그 그룹은 지도에서 숨김
// 상태다(sectionFacilityLayer 스타일 함수가 검사). visibleFacilityLabels(종류
// 단위 전역 필터)만으로는 "같은 종류를 다른 구간이 아직 켜둔 경우, 이 구간
// 하나만 끌" 방법이 없어서(버그: 여러 구간을 연달아 선택하면 주요시설물이
// 계속 자동으로 켜지고, 그중 하나만 꺼도 다른 구간이 여전히 그 종류를 쓰고
// 있으니 지도에서 안 사라졌다) 구간별 예외를 별도로 둔다. 이 Set에 있다고
// 해서 데이터(피처)를 지우지는 않는다 — 표시만 가린다. 그래야 나중에 다시
// 켤 때 재요청 없이 즉시 다시 보인다.
const sectionFacilityHiddenGroups = new Set();
// 반대로 "이 구간의 이 그룹은 지도에 켜 둔 상태"를 기록한다. 트리 리프의 아이콘 상태는 이 Set에서 그려서,
// 트리가 다시 그려지거나(loadLedgerTree) 검색으로 구간을 골라 리프 아이콘을 못 찾는 경우에도
// 아이콘이 지도의 실제 상태와 어긋나지 않는다(예전엔 아이콘 클래스만 믿어서, 트리를 다시 그린 뒤
// 눌러도 "끄기"가 아니라 "켜기"로 처리돼 지도에서 안 꺼졌다).
const sectionFacilityActiveGroups = new Set();
function facilityGroupKey(sectionKey, groupName) {
    return `${sectionKey}::${groupName}`;
}
// 트리 리프의 시설물 그룹 아이콘 하나의 겉모습을 상태에 맞춘다.
function paintFacilityGroupToggle(toggleBtn, groupName, active) {
    toggleBtn.classList.toggle('active', active);
    toggleBtn.title = active ? `지도에서 ${groupName} 숨기기` : `지도에 ${groupName} 표시`;
}
// 이 구간의 이 그룹 아이콘을 트리에서 찾아 맞춘다(리프가 그려져 있을 때만).
function syncFacilityGroupToggle(sectionKey, groupName, active) {
    document.querySelectorAll(`.tree-leaf[data-rdid="${CSS.escape(sectionKey)}"] .tree-facility-toggle`).forEach((b) => {
        if (b.dataset.group === groupName) paintFacilityGroupToggle(b, groupName, active);
    });
}

// 구간 하나의 시설물 그룹(주요시설물/부대시설) 하나를 지도에 켜거나 끈다.
function setSectionFacilityGroupActive(section, groupName, active, toggleBtn) {
    const types = facilityGroupTypeList(groupName);
    const key = facilitySectionKey(section);
    const groupKey = facilityGroupKey(key, groupName);
    if (active) sectionFacilityActiveGroups.add(groupKey); else sectionFacilityActiveGroups.delete(groupKey);
    if (active) {
        sectionFacilityHiddenGroups.delete(groupKey);
        types.forEach((label) => visibleFacilityLabels.add(label));
        ensureSectionFacilityLoaded(section).then(() => sectionFacilityLayer.changed());
    } else {
        sectionFacilityHiddenGroups.add(groupKey);
        // 이 종류를 실제로(숨기지 않고) 보여주는 구간이 이제 하나도 없으면
        // 전역 필터/시설물 패널 표시에서도 지운다 — 있으면 그대로 둔다(다른
        // 구간의 표시나 패널의 개별 눈 아이콘 상태를 건드리지 않기 위함).
        const source = sectionFacilityLayer.getSource();
        types.forEach((label) => {
            const stillVisible = source.getFeatures().some((f) => (
                f.get('label') === label
                && !sectionFacilityHiddenGroups.has(facilityGroupKey(f.get('sectionRdid'), groupName))
            ));
            if (!stillVisible) visibleFacilityLabels.delete(label);
        });
        sectionFacilityLayer.changed();
    }
    if (toggleBtn) paintFacilityGroupToggle(toggleBtn, groupName, active);
    syncFacilityGroupToggle(key, groupName, active);
    // 시설물 탭이 지금 이 구간(또는 다른 구간)을 보여주고 있다면, 방금 바뀐
    // visibleFacilityLabels를 기준으로 개별 눈 아이콘들을 다시 그려서 실제
    // 지도 표시 상태와 항상 일치하게 만든다.
    if (typeof renderRouteFacilityTree === 'function') renderRouteFacilityTree(currentRouteFacilityCounts);
}

// count>0인 시설물 종류에는 이름표 옆에 지도 표시 on/off 눈 아이콘을 붙인다.
// 기본은 꺼짐 — 누르면 그 종류만 지도에 켜진다. 도로대장 트리에서 구간
// 전체를 켜지 않았어도(즉 sectionFacilityLayer에 이 구간 데이터가 아직 없어도)
// 여기서 개별로 누르면 ensureSectionFacilityLoaded가 그 구간 데이터를 알아서
// 받아온다 — 구간 전체 켜기와 완전히 독립적으로 동작한다.
function buildFacilityLeaf(name, count) {
    const node = document.createElement('div');
    const clickable = count > 0;
    node.className = 'tree-node facility-leaf' + (clickable ? ' rf-clickable' : ' is-empty');
    const labelEl = document.createElement('div');
    labelEl.className = 'tree-node-label';
    labelEl.innerHTML = `<span>${escapeHtml(name)}</span><span class="tree-count">${count.toLocaleString()}</span>`;
    if (clickable) {
        labelEl.addEventListener('click', () => openFacilityFileList(name));

        const visToggle = document.createElement('button');
        visToggle.type = 'button';
        visToggle.className = 'facility-vis-toggle';
        const setToggleState = (visible) => {
            visToggle.innerHTML = visible ? '<i class="fa-solid fa-eye"></i>' : '<i class="fa-regular fa-eye-slash"></i>';
            visToggle.title = visible ? `지도에서 ${name} 숨기기` : `지도에 ${name} 표시`;
            visToggle.classList.toggle('hidden-state', !visible);
        };
        // 지금 보고 있는 구간에서 이 종류가 실제로 지도에 보이는지: 전역 필터에 있고, 이 구간의 그룹을 따로 꺼 두지 않았을 때.
        const shownOnMap = () => {
            if (!visibleFacilityLabels.has(name)) return false;
            const group = facilityLabelGroupMap.get(name);
            return !(currentRoute && group && sectionFacilityHiddenGroups.has(facilityGroupKey(facilitySectionKey(currentRoute), group)));
        };
        setToggleState(shownOnMap());
        visToggle.addEventListener('click', async (e) => {
            e.stopPropagation();
            const nowVisible = !shownOnMap();
            if (nowVisible) {
                visibleFacilityLabels.add(name);
                // 이 구간의 그룹이 꺼져 있었다면 지도에 안 나타나므로 같이 켠다(구간 리프의 그룹 아이콘도 맞춘다).
                const group = facilityLabelGroupMap.get(name);
                if (currentRoute && group) {
                    const gk = facilityGroupKey(facilitySectionKey(currentRoute), group);
                    if (sectionFacilityHiddenGroups.delete(gk) || !sectionFacilityActiveGroups.has(gk)) {
                        sectionFacilityActiveGroups.add(gk);
                        syncFacilityGroupToggle(facilitySectionKey(currentRoute), group, true);
                    }
                }
            } else {
                visibleFacilityLabels.delete(name);
                // 이 그룹의 종류가 하나도 안 남았으면 구간 리프의 그룹 아이콘도 "꺼짐"으로 맞춘다
                // (아니면 아이콘은 켜져 있는데 지도엔 아무것도 없어, 누르면 한 번 더 눌러야 켜진다).
                const group = facilityLabelGroupMap.get(name);
                if (group && !facilityGroupTypeList(group).some((l) => visibleFacilityLabels.has(l))) {
                    [...sectionFacilityActiveGroups].filter((k) => k.endsWith('::' + group)).forEach((k) => {
                        sectionFacilityActiveGroups.delete(k);
                        syncFacilityGroupToggle(k.slice(0, -(group.length + 2)), group, false);
                    });
                }
            }
            setToggleState(nowVisible);
            if (nowVisible && currentRoute) await ensureSectionFacilityLoaded(currentRoute);
            sectionFacilityLayer.changed();
        });
        labelEl.appendChild(visToggle);
    }
    node.appendChild(labelEl);
    return node;
}

// 선택된 노선/구간의 부속시설 개수(counts)를 주요시설물/부대시설 그룹 트리로
// 그려서 #route-facility-tree에 표시한다. loadRouteFacilityCounts()(cad-viewer.js)가
// 개수를 조회한 뒤 이 함수를 호출한다 — cad-popup.html은 이 함수가 없어(별도
// 스크립트 로드) typeof 체크로 안전하게 건너뛴다.
function renderRouteFacilityTree(counts) {
    const container = document.getElementById('route-facility-tree');
    if (!container) return;
    container.innerHTML = '';

    FACILITY_GROUPS.forEach(({ group, items, subgroups }) => {
        const groupTotal = items.reduce((sum, n) => sum + Number(counts[n] || 0), 0)
            + subgroups.reduce((sum, sg) => sum + sg.items.reduce((s, n) => s + Number(counts[n] || 0), 0), 0);
        // 주요시설물/부대시설과 그 하위그룹은 기본 접힌 상태로 시작한다 —
        // 눌러서 펼쳐야 목록이 보인다(예전엔 항상 펼쳐진 채로 시작했음).
        const groupNode = buildTreeGroup(group, groupTotal.toLocaleString(), false);
        items.forEach((name) => groupNode.children.appendChild(buildFacilityLeaf(name, Number(counts[name] || 0))));
        subgroups.forEach((sg) => {
            const sgTotal = sg.items.reduce((s, n) => s + Number(counts[n] || 0), 0);
            const sgNode = buildTreeGroup(sg.name, sgTotal.toLocaleString(), false);
            sg.items.forEach((name) => sgNode.children.appendChild(buildFacilityLeaf(name, Number(counts[name] || 0))));
            groupNode.children.appendChild(sgNode.node);
        });
        container.appendChild(groupNode.node);
    });

    // 이미 전역으로 켜둔 종류가 있으면(다른 구간에서 켰던 것) 지금 보고 있는
    // 구간으로도 그 데이터를 받아와서 지도에 이어서 표시한다.
    if (visibleFacilityLabels.size > 0 && currentRoute) {
        ensureSectionFacilityLoaded(currentRoute).then(() => sectionFacilityLayer.changed());
    }
}

function initRouteFacilitySection() {
    document.getElementById('route-facility-header').addEventListener('click', () => {
        document.getElementById('route-facility-section').classList.toggle('collapsed');
    });
}

// 지도를 범위에 맞춘다 — 구간/노선/전체보기/도로 종류 선택이 모두 이 함수를 쓴다.
//  · 맞추기 직전에 지도 크기를 다시 잰다(사이드바를 열고 닫은 직후의 옛 크기로 계산해 엉뚱한 곳·엉뚱한 줌으로 가는 것을 막는다).
//  · 지도가 숨겨져 크기가 0이면 fit 계산이 깨지므로 중심만 옮긴다.
//  · 지도가 좁아도 여백이 화면을 넘지 않게 줄인다.
//  · 애니메이션이 다른 렌더링에 끊겨 중간에 멈추면(사용자가 직접 움직인 게 아닐 때만) 같은 범위로 즉시 다시 맞춘다.
let mapFitToken = 0;
function fitMapToExtent(extent, maxZoom) {
    if (!extent || extent.some((v) => !isFinite(v))) return;
    const view = map.getView();
    const token = ++mapFitToken;
    map.updateSize();
    view.cancelAnimations();
    const size = map.getSize();
    if (!size || size[0] < 50 || size[1] < 50) {
        view.setCenter(ol.extent.getCenter(extent));
        view.setZoom(Math.min(maxZoom, 13));
        return;
    }
    const pad = Math.max(10, Math.min(60, Math.floor(Math.min(size[0], size[1]) / 4)));
    const opts = { padding: [pad, pad, pad, pad], maxZoom };
    view.fit(extent, Object.assign({
        duration: 500,
        callback: (done) => {
            if (done || token !== mapFitToken || view.getInteracting()) return;
            view.fit(extent, opts);
        },
    }, opts));
    // 사이드바가 열리거나 닫히는 중(0.2초 전환)에 맞춘 경우 — 전환이 끝나 지도 크기가 달라졌으면 한 번 더 맞춘다
    setTimeout(() => {
        if (token !== mapFitToken || view.getInteracting()) return;
        map.updateSize();
        const now = map.getSize();
        if (now && (now[0] !== size[0] || now[1] !== size[1])) {
            view.cancelAnimations();
            view.fit(extent, { padding: [pad, pad, pad, pad], maxZoom });
        }
    }, 320);
}

async function highlightSectionGeom(rdid) {
    const seq = ++routeFocusSeq;
    routeHighlightLayer.getSource().clear();
    const { record } = await fetch(`/api/sections/${rdid}`).then((r) => r.json());
    if (seq !== routeFocusSeq) return; // 그 사이 다른 구간·노선·전체보기를 눌렀다 — 늦게 도착한 응답이 지도를 되돌리지 않게 한다
    if (!record?.geom) { stopRouteHighlightBlink(); return; }
    const geojsonFormat = new ol.format.GeoJSON();
    const feature = geojsonFormat.readFeature(
        { type: 'Feature', geometry: record.geom, properties: {} },
        { featureProjection: map.getView().getProjection() }
    );
    routeHighlightLayer.getSource().addFeature(feature);
    const extent = feature.getGeometry().getExtent();
    fitMapToExtent(extent, 18);
    startRouteHighlightBlink();
}

// 데이터보기 트리에서 노선(호선) 그룹 라벨을 클릭하면 그 노선에 속한 구간
// 전부를 지도에 강조 표시하고, 전체를 한 번에 보여주도록 범위를 맞춘다.
// 구간별 강조(highlightSectionGeom)와 같은 레이어를 쓰되 여러 구간의
// 지오메트리를 한꺼번에 추가한다는 점만 다르다.
// 데이터보기 트리에서 노선(호선) 라벨을 선택했을 때의 본 동작 — 소속 구간
// 전부의 지오메트리를 한 번에 가져와서 (1) 지도 강조+범위 맞춤, (2) 오른쪽
// "정보" 탭에도 같은 규칙(공통 필드는 표시, 다른 필드는 공란, 연장은 합산)을
// 적용해 보여준다. 왼쪽 구간정보 패널은 selectRouteGroupForLeftSidebar가
// 트리 데이터만으로 먼저 즉시 갱신해두고, 여기서는 fetch가 필요한 지도/오른쪽
// 패널만 담당한다.
async function selectRouteGroup(grade, route) {
    const rdids = (route.sections || []).map((s) => s.rdid).filter(Boolean);
    if (!rdids.length) return;
    const seq = ++routeFocusSeq;
    const results = await Promise.all(
        rdids.map((rdid) => fetch(`/api/sections/${rdid}`).then((r) => r.json()))
    );
    if (seq !== routeFocusSeq) return;
    const records = results.map((r) => r.record).filter(Boolean);

    routeHighlightLayer.getSource().clear();
    const geojsonFormat = new ol.format.GeoJSON();
    let combinedExtent = null;
    records.forEach((record) => {
        if (!record.geom) return;
        const feature = geojsonFormat.readFeature(
            { type: 'Feature', geometry: record.geom, properties: {} },
            { featureProjection: map.getView().getProjection() }
        );
        routeHighlightLayer.getSource().addFeature(feature);
        const extent = feature.getGeometry().getExtent();
        combinedExtent = combinedExtent ? ol.extent.extend(combinedExtent, extent) : extent;
    });
    if (combinedExtent) {
        fitMapToExtent(combinedExtent, 18);
        startRouteHighlightBlink();
    } else {
        stopRouteHighlightBlink();
    }

    loadRouteGroupInfoPanel(grade, route, records);
}

// 오른쪽 "정보" 탭에 노선 전체 정보를 보여준다 — FIELD_IDS 중 소속 구간
// 전부에서 값이 똑같은 필드만 그대로 표시하고, 하나라도 다르면 공란으로
// 둔다(구간번호/시점/종점처럼 구간마다 다른 게 당연한 값들이 여기 해당).
// 연장만 예외로 합산값을 보여준다. 특정 구간 하나가 아니므로 저장은 막는다
// (currentSectionRdid를 null로 둬서 saveParcel()의 기존 가드가 막아줌).
function loadRouteGroupInfoPanel(grade, route, records) {
    currentSectionRdid = null;
    pendingSectionDraft = null;
    document.getElementById('parcel-empty-msg').style.display = 'none';
    document.getElementById('parcel-form').style.display = 'block';
    document.getElementById('f-rdid').textContent = `(${route.sections.length}개 구간 — 개별 구간을 선택하면 상세 정보가 표시됩니다)`;
    document.getElementById('f-road-rank').textContent = grade || '-';
    document.getElementById('f-road-rank').style.display = '';
    document.getElementById('road-rank-select').style.display = 'none';
    document.getElementById('road-rank-hint').style.display = 'none';

    const SPECIAL_FIELDS = new Set(['route_no', 'route_name', 'length_m']);
    const values = {};
    FIELD_IDS.forEach((f) => {
        if (SPECIAL_FIELDS.has(f)) return;
        const vals = records.map((r) => r[f]);
        const allSame = vals.every((v) => String(v ?? '') === String(vals[0] ?? ''));
        values[f] = allSame ? vals[0] : null;
    });
    values.route_no = route.route_no;
    values.route_name = route.route_name;
    values.length_m = records.reduce((sum, r) => sum + (Number(r.length_m) || 0), 0);
    fillSectionForm(values);

    FIELD_IDS.forEach((f) => {
        const el = document.getElementById('in-' + f);
        if (el) el.disabled = true;
    });
    document.getElementById('save-status').textContent = '노선 전체보기 — 개별 구간을 선택해야 저장할 수 있습니다.';
}

// 좌측 툴바 "전체보기" 버튼 — 등록된 노선(구간) 전부를 한 번에 볼 수 있게
// 지도 범위를 맞춘다. 노선이 많아질 걸 감안해 구간마다 개별 요청하지 않고
// 전용 API(/api/sections/all-geoms)로 한 번에 받아온다. 강조 표시는 안 함
// (routeHighlightLayer는 노란 강조선 하나를 위한 스타일이라 여러 구간을
// 한꺼번에 켜면 지도가 지저분해짐) — 범위만 맞춘다.
let routeFocusSeq = 0; // 지도에 노선을 맞추는 요청 번호(마지막 요청만 반영)
async function fitAllRegisteredRoutes() {
    const seq = ++routeFocusSeq;
    const { items } = await fetch('/api/sections/all-geoms').then((r) => r.json());
    if (seq !== routeFocusSeq) return;
    drawRoutesOnMap(items, '등록된 노선이 없습니다.');
}

// 트리의 도로 종류(군도 등) 제목을 눌렀을 때 — 그 종류의 등록된 노선을 지도에 전부 표시한다.
async function showGradeRoutesOnMap(grade) {
    try {
        const seq = ++routeFocusSeq;
        const res = await fetch('/api/sections/all-geoms?grade=' + encodeURIComponent(grade));
        if (!res.ok) return;
        const { items } = await res.json();
        if (seq !== routeFocusSeq) return;
        if (!items || !items.length) return; // 노선 없는 종류는 조용히 넘어간다(0건 표시로 충분)
        document.querySelectorAll('.tree-leaf.selected').forEach((el) => el.classList.remove('selected'));
        drawRoutesOnMap(items);
    } catch (e) { /* 지도 표시만 못 할 뿐 — 트리 펴기/접기는 그대로 동작 */ }
}

function drawRoutesOnMap(items, emptyMessage) {
    if (!items || !items.length) {
        if (emptyMessage) uiAlert(emptyMessage);
        return;
    }
    // 노선 하나 선택할 때 쓰는 것과 같은 강조 레이어(routeHighlightLayer)를
    // 재사용해서, 등록된 노선 전부를 지도에 노란 선으로 그려 보이게 한다
    // (여러 개를 한꺼번에 켜는 거라 깜빡임은 끄고 정적으로 표시).
    stopRouteHighlightBlink();
    routeHighlightLayer.getSource().clear();
    const geojsonFormat = new ol.format.GeoJSON();
    let combinedExtent = null;
    items.forEach(({ geom }) => {
        if (!geom) return;
        const feature = geojsonFormat.readFeature(
            { type: 'Feature', geometry: geom, properties: {} },
            { featureProjection: map.getView().getProjection() }
        );
        routeHighlightLayer.getSource().addFeature(feature);
        const extent = feature.getGeometry().getExtent();
        combinedExtent = combinedExtent ? ol.extent.extend(combinedExtent, extent) : extent;
    });
    if (!combinedExtent) return;
    fitMapToExtent(combinedExtent, 16);
}

// 노선을 선택했을 때 지도 위 강조선(routeHighlightLayer)이 5초간 깜빡여서
// 한눈에 찾기 쉽도록 한다. 엔티티 스타일을 바꾸는 대신 레이어 전체의 투명도만
// 주기적으로 토글하는 방식이라 가볍다 — 5초가 지나거나 다른 구간을 선택하거나
// 강조를 지우면 멈춘다(강조선 자체는 지워지지 않고 계속 표시된 채로 남는다).
function startRouteHighlightBlink() {
    stopRouteHighlightBlink();
    let visible = true;
    routeBlinkTimer = setInterval(() => {
        visible = !visible;
        routeHighlightLayer.setOpacity(visible ? 1 : 0.2);
    }, 500);
    routeBlinkTimeout = setTimeout(stopRouteHighlightBlink, 5000);
}

function stopRouteHighlightBlink() {
    if (routeBlinkTimer) {
        clearInterval(routeBlinkTimer);
        routeBlinkTimer = null;
    }
    if (routeBlinkTimeout) {
        clearTimeout(routeBlinkTimeout);
        routeBlinkTimeout = null;
    }
    routeHighlightLayer.setOpacity(1);
}

// 부속시설(표지/가로등/교량 등)은 기본적으로 지도에 표시하지 않는다 — 전부
// 켜두면 지도가 너무 복잡해지므로, 데이터보기 트리에서 구간별 체크박스로
// 개별적으로 켜고 끌 수 있게 한다(buildTreeLeaf의 .tree-facility-toggle).
// 여러 구간을 동시에 켤 수 있어 sectionFacilityLayer 전체를 비우지 않고,
// 각 지오메트리에 sectionRdid를 태깅해서 그 구간 것만 추가/제거한다.
// 종류별 색은 facilityColor()로 고정 배정되고, 마우스오버 정보는
// initFacilityHoverPopup()이 처리한다.
// 구간은 rdid로 구분되지만, 호선 전체보기(시설물 패널에서 sect='' 상태로
// 볼 때)는 rdid가 없다 — 그런 경우 노선 조건으로 대신 키를 만들어서 서로
// 다른 호선의 로드 상태가 뒤섞이지 않게 한다.
function facilitySectionKey(section) {
    return section.rdid || `group:${section.road_rank_name || section.road_grade || ''}:${section.route_no || ''}`;
}

async function loadSectionFacilityGeoms(section) {
    const key = facilitySectionKey(section);
    clearSectionFacilityGeoms(key);
    const params = new URLSearchParams({
        road_rank_name: section.road_rank_name || section.road_grade || '',
        route_no: section.route_no || '', sect: section.sect || '',
    });
    let items = [];
    try {
        const data = await fetch('/api/sections/facility-geoms?' + params.toString()).then((r) => r.json());
        items = data.items || [];
    } catch (e) { /* 조회 실패 시 그냥 비워둠 */ }

    const geojsonFormat = new ol.format.GeoJSON();
    const features = items.map((item) => {
        const feature = geojsonFormat.readFeature(
            { type: 'Feature', geometry: item.geom, properties: {} },
            { featureProjection: map.getView().getProjection() }
        );
        feature.set('label', item.label);
        feature.set('name', item.name);
        feature.set('facilityRdid', item.rdid);
        feature.set('facilityTable', item.table);
        feature.set('sectionRdid', key);
        return feature;
    });
    sectionFacilityLayer.getSource().addFeatures(features);
}

function clearSectionFacilityGeoms(rdid) {
    const source = sectionFacilityLayer.getSource();
    source.getFeatures()
        .filter((f) => f.get('sectionRdid') === rdid)
        .forEach((f) => source.removeFeature(f));
}

// 이미 이 구간(또는 호선 전체)의 마커가 로드돼 있으면 다시 불러오지 않는다 —
// 시설물 패널에서 종류 하나만 켜도 그 구간의 전체 시설물 데이터는 한 번만
// 받아오고, 화면에 어떤 종류를 보여줄지는 visibleFacilityLabels가 결정한다.
async function ensureSectionFacilityLoaded(section) {
    const key = facilitySectionKey(section);
    const alreadyLoaded = sectionFacilityLayer.getSource().getFeatures().some((f) => f.get('sectionRdid') === key);
    if (!alreadyLoaded) await loadSectionFacilityGeoms(section);
}

// ---------- 사용자도로관리: 그리기 ----------
// 지점(Point)/노선(LineString)/구역(Polygon) 3가지 지오메트리 타입 공용 스타일.
// road_issues.geom은 JSONB라 타입 제약이 없으므로 서버 변경 없이 프론트에서만 분기한다.
// feature.get('selected')가 true면(지도/트리에서 선택된 도형) 다른 색으로 표시한다.
const ISSUE_COLOR = { solid: '#ff9500', fillRgba: 'rgba(255, 149, 0, 0.25)' };
const ISSUE_SELECTED_COLOR = { solid: '#00c2ff', fillRgba: 'rgba(0, 194, 255, 0.3)' };

function issueFeatureStyle(feature) {
    const type = feature.getGeometry().getType();
    const c = feature.get('selected') ? ISSUE_SELECTED_COLOR : ISSUE_COLOR;
    if (type === 'Point') {
        return new ol.style.Style({
            image: new ol.style.Circle({
                radius: 5,
                fill: new ol.style.Fill({ color: c.solid }),
                stroke: new ol.style.Stroke({ color: '#fff', width: 1.5 }),
            }),
        });
    }
    if (type === 'Polygon') {
        return new ol.style.Style({
            fill: new ol.style.Fill({ color: c.fillRgba }),
            stroke: new ol.style.Stroke({ color: c.solid, width: 3 }),
        });
    }
    return new ol.style.Style({ stroke: new ol.style.Stroke({ color: c.solid, width: 4 }) });
}

// 지도/트리에서 도형을 선택했을 때(수정 모달이 열리거나 트리에서 클릭) 호출.
// 이전 선택은 해제하고, 새 선택 도형은 숨김 상태였다면 보이도록 전환한다.
function setSelectedIssueFeature(feature) {
    issueVectorLayer.getSource().getFeatures().forEach((f) => {
        if (f !== feature && f.get('selected')) f.set('selected', false);
    });
    if (feature) {
        feature.set('selected', true);
        if (feature.getStyle() === ISSUE_HIDDEN_STYLE) feature.setStyle(undefined);
    }
}

const ISSUE_DRAW_ICONS = { Point: 'fa-location-dot', LineString: 'fa-route', Polygon: 'fa-draw-polygon' };

function initRoadIssueDraw() {
    const mainBtn = document.getElementById('issue-draw-btn');
    const menu = document.getElementById('issue-draw-menu');

    mainBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isDrawingIssue) { stopIssueDraw(); return; }
        menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
    });

    document.querySelectorAll('.issue-draw-option').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.style.display = 'none';
            startIssueDraw(btn.dataset.geomType);
        });
    });

    document.addEventListener('click', () => { menu.style.display = 'none'; });
}

function startIssueDraw(geomType) {
    if (isDrawingIssue) stopIssueDraw();
    isDrawingIssue = true;
    issueDrawGeomType = geomType;
    document.getElementById('issue-draw-btn').classList.add('active');
    document.getElementById('issue-draw-btn-icon').className = `fa-solid ${ISSUE_DRAW_ICONS[geomType]}`;
    map.getTargetElement().style.cursor = 'crosshair';

    // source를 넘기지 않는다: Draw 인터랙션은 자체 스케치 오버레이로 그리는 동안의
    // 미리보기를 표시하므로, 완료된 도형을 issueVectorLayer에 자동으로 커밋할 필요가
    // 없다. source를 넘기면 drawend가 발생한 "이후"에 source에 추가되기 때문에,
    // drawend 핸들러 안에서 removeFeature를 호출해도 저장하지 않고 취소했을 때
    // 도형이 지도에 남는 문제가 있었다.
    // style에 issueFeatureStyle을 그대로 재사용해, 그리는 동안의 스케치가
    // 저장 후 실제 표시되는 모양(색/두께/점 크기)과 동일하게 실시간으로 보이도록 한다.
    issueDrawInteraction = new ol.interaction.Draw({ type: geomType, style: issueFeatureStyle });
    issueDrawInteraction.on('drawend', (evt) => {
        const geom = new ol.format.GeoJSON().writeGeometryObject(evt.feature.getGeometry(), {
            featureProjection: map.getView().getProjection(), decimals: 7,
        });
        issueDrawJustFinished = true;
        setTimeout(() => { issueDrawJustFinished = false; }, 350);
        stopIssueDraw();
        // 등록창이 열려있는 동안에도 방금 그린 도형이 지도에 보이도록 미리보기로
        // 추가한다. issueId가 없으므로 저장 전까지는 클릭해도 수정 모달이 열리지
        // 않고, 취소하면 closeRoadIssueModal()에서 지운다.
        pendingIssuePreviewFeature = evt.feature;
        issueVectorLayer.getSource().addFeature(evt.feature);
        openRoadIssueModal('create', { geom });
    });
    map.addInteraction(issueDrawInteraction);
}

function stopIssueDraw() {
    isDrawingIssue = false;
    document.getElementById('issue-draw-btn').classList.remove('active');
    document.getElementById('issue-draw-btn-icon').className = 'fa-solid fa-shapes';
    map.getTargetElement().style.cursor = '';
    if (issueDrawInteraction) {
        map.removeInteraction(issueDrawInteraction);
        issueDrawInteraction = null;
    }
}

const ISSUE_HIDDEN_STYLE = new ol.style.Style({});

// 트리 그룹 데이터(tree)에 담긴 전체 등록 항목의 geom을 지도에 로드한다. 트리의
// 항목별 체크박스로 개별 표시/숨김을 제어하므로, 새로 불러올 때는 항상 숨김
// 상태(기본값 꺼짐)로 시작한다.
function loadIssueMapFeatures(tree) {
    const format = new ol.format.GeoJSON();
    issueVectorLayer.getSource().clear();
    (tree || []).forEach((group) => {
        group.items.forEach((item) => {
            if (!item.geom) return;
            const feature = format.readFeature(
                { type: 'Feature', geometry: item.geom, properties: {} },
                { featureProjection: map.getView().getProjection() }
            );
            feature.set('issueId', item.id);
            feature.setStyle(ISSUE_HIDDEN_STYLE);
            issueVectorLayer.getSource().addFeature(feature);
        });
    });
}

function blinkIssueFeature(feature, times = 4, intervalMs = 250) {
    let count = 0;
    const tick = () => {
        feature.setStyle(count % 2 === 0 ? ISSUE_HIDDEN_STYLE : undefined);
        count += 1;
        if (count < times * 2) {
            setTimeout(tick, intervalMs);
        } else {
            feature.setStyle(undefined);
        }
    };
    tick();
}

// ---------- 사용자도로관리: 경로수정(Modify) ----------
function startEditRoute() {
    const feature = issueVectorLayer.getSource().getFeatures().find((f) => f.get('issueId') === currentIssueId);
    if (!feature) { uiAlert('경로 정보를 불러오지 못했습니다.'); return; }
    const geomType = feature.getGeometry().getType();
    const hint = geomType === 'Point' ? '지도에서 지점을 드래그해 위치를 수정하세요'
        : geomType === 'Polygon' ? '지도에서 정점을 드래그해 구역을 수정하세요'
        : '지도에서 정점을 드래그해 경로를 수정하세요';
    document.getElementById('issue-editroute-hint').textContent = hint;

    document.getElementById('issue-modal-overlay').style.display = 'none';
    document.getElementById('issue-editroute-bar').style.display = 'flex';
    isEditingIssueRoute = true;
    issueModifyFeature = feature;
    issueModifyInteraction = new ol.interaction.Modify({ features: new ol.Collection([feature]) });
    map.addInteraction(issueModifyInteraction);
}

async function finishEditRoute(save) {
    document.getElementById('issue-editroute-bar').style.display = 'none';
    isEditingIssueRoute = false;
    const feature = issueModifyFeature;
    issueModifyFeature = null;
    if (issueModifyInteraction) {
        map.removeInteraction(issueModifyInteraction);
        issueModifyInteraction = null;
    }
    if (save && feature && currentIssueId) {
        const geom = new ol.format.GeoJSON().writeGeometryObject(feature.getGeometry(), {
            featureProjection: map.getView().getProjection(), decimals: 7,
        });
        await fetch(`/api/road-issues/${currentIssueId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                category: document.getElementById('im-category').value,
                team: document.getElementById('im-team').value || null,
                status: document.getElementById('im-status').value,
                title: document.getElementById('im-title').value,
                content: document.getElementById('im-content').value || null,
                geom,
            }),
        });
        loadIssueTree();
    }
    document.getElementById('issue-modal-overlay').style.display = 'flex';
}

// ---------- 사용자도로관리: 등록/수정 모달 ----------
function openRoadIssueModal(mode, record) {
    issueModalMode = mode;
    currentIssueId = mode === 'edit' ? record.id : null;
    pendingIssueGeom = mode === 'create' ? record.geom : null;
    pendingIssueFiles = [];

    document.getElementById('issue-modal-title').textContent = mode === 'create' ? '업무 이력 등록' : '업무 이력 수정';
    document.getElementById('im-team').value = record.team || '';
    document.getElementById('im-category').value = record.category || ISSUE_CATEGORIES[0];
    document.getElementById('im-status').value = record.status || '민원제기';
    document.getElementById('im-title').value = record.title || '';
    document.getElementById('im-content').value = record.content || '';
    document.getElementById('im-created-at').value = (mode === 'edit' && record.created_at)
        ? new Date(record.created_at).toLocaleString('ko-KR')
        : new Date().toLocaleString('ko-KR');
    document.getElementById('issue-modal-status').textContent = '';

    document.getElementById('issue-save-btn').querySelector('.btn-text').textContent = mode === 'create' ? '등록' : '수정';
    document.getElementById('issue-edit-route-btn').style.display = mode === 'edit' ? '' : 'none';
    document.getElementById('issue-delete-btn').style.display =
        (mode === 'edit' && document.body.classList.contains('admin-mode')) ? '' : 'none';

    if (mode === 'edit') {
        loadIssueFileList(record.id);
    } else {
        renderIssueFileList([], []);
    }

    document.getElementById('issue-modal-overlay').style.display = 'flex';
}

function closeRoadIssueModal() {
    document.getElementById('issue-modal-overlay').style.display = 'none';
    setSelectedIssueFeature(null);
    if (pendingIssuePreviewFeature) {
        issueVectorLayer.getSource().removeFeature(pendingIssuePreviewFeature);
        pendingIssuePreviewFeature = null;
    }
}

async function saveRoadIssue() {
    const body = {
        category: document.getElementById('im-category').value,
        team: document.getElementById('im-team').value || null,
        status: document.getElementById('im-status').value,
        title: document.getElementById('im-title').value.trim(),
        content: document.getElementById('im-content').value || null,
    };
    const statusEl = document.getElementById('issue-modal-status');
    if (!body.title) { statusEl.textContent = '제목을 입력해주세요.'; return; }
    statusEl.textContent = '저장 중...';

    let res;
    if (issueModalMode === 'create') {
        body.geom = pendingIssueGeom;
        res = await fetch('/api/road-issues', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
    } else {
        res = await fetch(`/api/road-issues/${currentIssueId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
    }
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        statusEl.textContent = data.error || '저장 실패';
        return;
    }
    const { record } = await res.json();

    for (const file of pendingIssueFiles) {
        const fd = new FormData();
        fd.append('file', file);
        await fetch(`/api/road-issues/${record.id}/files`, { method: 'POST', body: fd });
    }
    pendingIssueFiles = [];

    closeRoadIssueModal();
    loadIssueTree();
}

async function deleteRoadIssueConfirm() {
    if (!currentIssueId) return;
    const title = document.getElementById('im-title').value || '';
    if (!await uiConfirm(`'${title}' 항목을 삭제하시겠습니까?\n삭제된 데이터는 복구할 수 없습니다.`)) return;
    const res = await fetch(`/api/road-issues/${currentIssueId}`, { method: 'DELETE' });
    if (res.ok) {
        issueVectorLayer.getSource().clear();
        closeRoadIssueModal();
        loadIssueTree();
    } else {
        const data = await res.json().catch(() => ({}));
        uiAlert(data.error || '삭제 실패');
    }
}

function initRoadIssueModal() {
    document.getElementById('issue-modal-close-btn').addEventListener('click', closeRoadIssueModal);
    document.getElementById('issue-cancel-btn').addEventListener('click', closeRoadIssueModal);
    document.getElementById('issue-save-btn').addEventListener('click', saveRoadIssue);
    document.getElementById('issue-delete-btn').addEventListener('click', deleteRoadIssueConfirm);
    document.getElementById('issue-edit-route-btn').addEventListener('click', startEditRoute);
    document.getElementById('issue-editroute-done-btn').addEventListener('click', () => finishEditRoute(true));
    document.getElementById('issue-editroute-cancel-btn').addEventListener('click', () => finishEditRoute(false));
}

// ---------- 사용자도로관리: 첨부파일 ----------
function initIssueDropzone() {
    const dropzone = document.getElementById('issue-dropzone');
    const fileInput = document.getElementById('issue-file-input');
    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { handleIssueFileSelected(fileInput.files[0]); fileInput.value = ''; });
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        handleIssueFileSelected(e.dataTransfer.files[0]);
    });
}

async function handleIssueFileSelected(file) {
    if (!file) return;
    if (currentIssueId) {
        // 기존 항목 편집 중 — 바로 업로드
        const statusEl = document.getElementById('issue-modal-status');
        statusEl.textContent = '파일 업로드 중...';
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch(`/api/road-issues/${currentIssueId}/files`, { method: 'POST', body: fd });
        statusEl.textContent = res.ok ? '' : '파일 업로드 실패';
        if (res.ok) await loadIssueFileList(currentIssueId);
    } else {
        // 신규 등록 중 — 저장 후 업로드할 파일을 잠시 보관
        pendingIssueFiles = [file];
        renderIssueFileList([], pendingIssueFiles);
    }
}

async function loadIssueFileList(issueId) {
    const { files } = await fetch(`/api/road-issues/${issueId}/files`).then((r) => r.json());
    renderIssueFileList(files, []);
}

function renderIssueFileList(existingFiles, pending) {
    const el = document.getElementById('issue-file-list');
    el.innerHTML = '';
    (existingFiles || []).forEach((f) => {
        const row = document.createElement('div');
        row.className = 'issue-file-row';
        row.innerHTML = `<i class="fa-solid fa-paperclip"></i><span class="issue-file-name">${escapeHtml(f.original_name)}</span>`;
        row.querySelector('.issue-file-name').addEventListener('click', () => {
            window.open(`/api/road-issues/files/${f.id}`, '_blank');
        });
        const rm = document.createElement('button');
        rm.className = 'issue-file-remove';
        rm.title = '삭제';
        rm.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        rm.addEventListener('click', async () => {
            await fetch(`/api/road-issues/files/${f.id}`, { method: 'DELETE' });
            loadIssueFileList(currentIssueId);
        });
        row.appendChild(rm);
        el.appendChild(row);
    });
    (pending || []).forEach((file, idx) => {
        const row = document.createElement('div');
        row.className = 'issue-file-row';
        row.innerHTML = `<i class="fa-solid fa-file-lines"></i><span class="issue-file-name">${escapeHtml(file.name)} (저장 후 업로드됨)</span>`;
        const rm = document.createElement('button');
        rm.className = 'issue-file-remove';
        rm.title = '제거';
        rm.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        rm.addEventListener('click', () => { pendingIssueFiles.splice(idx, 1); renderIssueFileList([], pendingIssueFiles); });
        row.appendChild(rm);
        el.appendChild(row);
    });
}

// ---------- 사용자도로관리: 데이터보기 트리 ----------
function initIssueTreeToolbar() {
    document.getElementById('issue-tree-header').addEventListener('click', () => {
        document.getElementById('issue-tree-section').classList.toggle('collapsed');
    });
    document.getElementById('issue-tree-expand-all-btn').addEventListener('click', () => {
        document.querySelectorAll('#issue-tree .tree-node:not(.tree-leaf)').forEach((n) => n.classList.add('open'));
    });
    document.getElementById('issue-tree-collapse-all-btn').addEventListener('click', () => {
        document.querySelectorAll('#issue-tree .tree-node:not(.tree-leaf)').forEach((n) => n.classList.remove('open'));
    });
    document.getElementById('issue-tree-refresh-btn').addEventListener('click', () => loadIssueTree());
    document.getElementById('issue-tree-download-btn').addEventListener('click', downloadIssueGeoJson);
}

async function downloadIssueGeoJson() {
    const checkedIds = Array.from(document.querySelectorAll('#issue-tree .issue-leaf-visibility:checked'))
        .map((cb) => cb.dataset.issueId);
    if (checkedIds.length === 0) {
        uiAlert('다운로드할 항목의 체크박스를 먼저 선택하세요.');
        return;
    }
    const res = await fetch(`/api/road-issues/geojson?ids=${checkedIds.join(',')}`);
    if (!res.ok) { uiAlert('다운로드에 실패했습니다.'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `사용자도로관리_${new Date().toISOString().slice(0, 10)}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
}

async function loadIssueTree() {
    const container = document.getElementById('issue-tree');
    container.innerHTML = '<div class="tree-empty">불러오는 중...</div>';

    let tree;
    try {
        const res = await fetch('/api/road-issues/tree');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        ({ tree } = await res.json());
    } catch (e) {
        container.innerHTML = `<div class="tree-empty">불러오기 실패: ${escapeHtml(e.message)}</div>`;
        return;
    }
    const byCategory = new Map((tree || []).map((g) => [g.category, g.items]));
    loadIssueMapFeatures(tree);

    container.innerHTML = '';
    ISSUE_CATEGORIES.forEach((category) => {
        const items = byCategory.get(category) || [];
        const groupNode = buildTreeGroup(category, items.length);
        if (items.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'tree-node-empty';
            empty.textContent = '등록된 항목 없음';
            groupNode.children.appendChild(empty);
        }
        items.forEach((item) => {
            const leaf = buildIssueTreeLeaf(`[${item.status}] ${item.title}`, item.id, item.geomType);
            leaf.addEventListener('click', () => {
                document.querySelectorAll('.tree-leaf.selected').forEach((el) => el.classList.remove('selected'));
                leaf.classList.add('selected');
                // 트리에서는 위치 이동 + 깜빡임만 한다. 수정 모달은 지도 위의
                // 도형을 직접 클릭했을 때만 연다(onMapClick 참고).
                const feature = issueVectorLayer.getSource().getFeatures().find((f) => f.get('issueId') === item.id);
                if (!feature) return;
                // 이 항목이 꺼져 있으면 깜빡임이 안 보이므로 자동으로 켠다.
                leaf.querySelector('.issue-leaf-visibility').checked = true;
                // fit()에 duration(애니메이션)을 주면, 바로 이어지는 blinkIssueFeature의
                // setStyle 호출(레이어 재렌더 트리거)이 진행 중인 뷰 애니메이션을
                // 멈춰버리는 문제가 있어(OL 뷰 애니메이션과 레이어 changed()의 상호작용
                // 이슈) 이동은 애니메이션 없이 즉시 이동시킨다.
                map.getView().fit(feature.getGeometry().getExtent(), { padding: [60, 60, 60, 60], maxZoom: 18 });
                setSelectedIssueFeature(feature);
                blinkIssueFeature(feature);
            });
            groupNode.children.appendChild(leaf);
        });
        container.appendChild(groupNode.node);
    });
}

function buildIssueTreeLeaf(label, id, geomType) {
    const icon = geomType === 'Point' ? 'fa-location-dot' : geomType === 'Polygon' ? 'fa-draw-polygon' : 'fa-route';
    const node = document.createElement('div');
    node.className = 'tree-node tree-leaf';
    const labelEl = document.createElement('div');
    labelEl.className = 'tree-node-label';

    const visToggle = document.createElement('input');
    visToggle.type = 'checkbox';
    visToggle.className = 'issue-leaf-visibility';
    visToggle.title = '지도에 표시';
    visToggle.dataset.issueId = id;
    visToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const feature = issueVectorLayer.getSource().getFeatures().find((f) => f.get('issueId') === id);
        if (feature) feature.setStyle(e.target.checked ? undefined : ISSUE_HIDDEN_STYLE);
    });
    labelEl.appendChild(visToggle);
    labelEl.insertAdjacentHTML('beforeend', `<i class="fa-solid ${icon}" style="width:12px;font-size:0.75rem;"></i><span>${escapeHtml(label)}</span>`);
    node.appendChild(labelEl);

    const delBtn = document.createElement('button');
    delBtn.className = 'tree-delete-btn';
    delBtn.title = '삭제';
    delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!await uiConfirm(`'${label}' 항목을 삭제하시겠습니까?\n삭제된 데이터는 복구할 수 없습니다.`)) return;
        const res = await fetch(`/api/road-issues/${id}`, { method: 'DELETE' });
        if (res.ok) {
            if (currentIssueId === id) closeRoadIssueModal();
            loadIssueTree();
        } else {
            const data = await res.json().catch(() => ({}));
            uiAlert(data.error || '삭제 실패');
        }
    });
    labelEl.appendChild(delBtn);
    return node;
}

// ---------- 왼쪽 사이드바 (도면/CAD 뷰어) ----------
// 실제 도면 렌더링/파일목록/부속시설 로직은 cad-viewer.js(공용 모듈, 팝업창과 공유)에 있다.
function initLeftSidebar() {
    const sidebar = document.getElementById('left-sidebar');
    const toggleBtn = document.getElementById('leftSidebarToggle');
    toggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
        toggleBtn.classList.toggle('collapsed');
        setTimeout(() => { map.updateSize(); resizeDxfCanvas(); }, 220);
    });

    initLeftSidebarResize();

    initRouteFileTabs();
    initRouteInfoCard();

    document.getElementById('route-upload-btn').addEventListener('click', uploadRouteFile);
    // 기본 파일 입력은 좁은 패널에서 파일명이 "선…"처럼 잘려서, 숨기고 "파일 선택" 버튼 옆에 이름을 따로 보여준다
    document.getElementById('route-upload-file').addEventListener('change', updateRouteUploadName);

    initCadToolbarButtons();
    initDxfCanvas();
}

function initLeftSidebarResize() {
    const resizer = document.getElementById('left-sidebar-resizer');
    const sidebar = document.getElementById('left-sidebar');
    const toggleBtn = document.getElementById('leftSidebarToggle');
    const root = document.documentElement;
    const MIN_WIDTH = 260, MAX_WIDTH = Math.round(window.innerWidth * 0.7);

    let dragging = false;
    resizer.addEventListener('mousedown', (e) => {
        dragging = true;
        resizer.classList.add('active');
        sidebar.classList.add('resizing');
        toggleBtn.classList.add('resizing');
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX));
        root.style.setProperty('--left-sidebar-width', width + 'px');
        resizeDxfCanvas();
    });
    window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove('active');
        sidebar.classList.remove('resizing');
        toggleBtn.classList.remove('resizing');
        map.updateSize();
        resizeDxfCanvas();
    });
}


// 구간정보 카드(.ri-card) — 값이 "-"(없음)인 칸에 is-blank를 붙여 흐리게(구간 칩은 숨김).
// 값을 채우는 곳이 여러 군데(노선 선택·구간 선택·cad-viewer.js)라 각자 고치지 않고 변화를 지켜본다.
function initRouteInfoCard() {
    const card = document.querySelector('#left-sidebar .ri-card');
    if (!card) return;
    const ids = ['ri-road-grade', 'ri-route-name', 'ri-segment-name', 'ri-length', 'ri-start-point', 'ri-end-point'];
    const sync = () => ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('is-blank', el.textContent.trim() === '-' || !el.textContent.trim());
    });
    new MutationObserver(sync).observe(card, { childList: true, characterData: true, subtree: true });
    sync();
}

// 데이터보기 트리에서 개별 구간이 아니라 노선(호선) 라벨을 클릭했을 때 —
// 구간정보 패널에 그 노선의 정보를 보여준다. 도로등급/노선명처럼 소속 구간
// 전부에 공통인 값은 그대로 표시하고, 구간명/시점/종점처럼 구간마다 다른
// 값은 공란("-")으로 둔다. 연장만은 예외로 소속 구간 전체의 합산값을 보여준다.
// CAD 뷰어(도면/시설물 등)는 특정 구간 하나를 전제로 하는 화면이라 노선
// 선택으로는 건드리지 않는다(마지막으로 선택했던 구간 내용이 그대로 남는다).
function selectRouteGroupForLeftSidebar(grade, route) {
    clearSectorSelection();
    document.getElementById('ri-road-grade').textContent = grade || '-';
    document.getElementById('ri-route-name').textContent = route.route_name || '-';
    document.getElementById('ri-segment-name').textContent = '-';
    document.getElementById('ri-start-point').textContent = '-';
    document.getElementById('ri-end-point').textContent = '-';
    const totalLength = (route.sections || []).reduce((sum, s) => sum + (Number(s.length_m) || 0), 0);
    document.getElementById('ri-length').textContent = formatLengthM(totalLength);

    const sidebar = document.getElementById('left-sidebar');
    const toggleBtn = document.getElementById('leftSidebarToggle');
    if (sidebar.classList.contains('collapsed')) {
        sidebar.classList.remove('collapsed');
        toggleBtn.classList.remove('collapsed');
        setTimeout(() => { map.updateSize(); resizeDxfCanvas(); }, 220);
    }

    // currentRoute를 구간(rdid/sect) 없이 노선 단위로만 채운다 — 파일 목록
    // API(/api/routes/files)는 section_rdid가 비어있으면 노선(도로등급+노선번호
    // +노선명) 전체 파일을 돌려주고, 부속시설 개수/파일 API도 sect가 비어있으면
    // 노선 전체 구간을 합산해서 돌려주도록 서버를 같이 고쳤다 — 그래서 이
    // 값들만 바꿔주면 기존 loadRouteFileList/loadRouteFacilityCounts가 그대로
    // "노선 전체 합산" 모드로 동작한다.
    currentRoute = {
        road_rank_name: grade, road_grade: grade,
        route_no: route.route_no, route_name: route.route_name,
        sect: '', rdid: '', s_point: '', e_point: '',
    };
    refreshRouteFilePanel();
    loadRouteFacilityCounts(currentRoute);
    loadRouteSectors(currentRoute);
}

function selectSectionForLeftSidebar(section) {
    clearSectorSelection();
    currentRoute = section;
    document.getElementById('ri-road-grade').textContent = section.road_rank_name || section.road_grade || '-';
    document.getElementById('ri-route-name').textContent = section.route_name || '-';
    document.getElementById('ri-segment-name').textContent = section.sect ? `${section.sect}구간` : '-';
    // 구간정보 카드에서 시점·종점은 한 줄 전체를 쓰므로 번지 앞에서 줄을 바꾸지 않는다
    document.getElementById('ri-start-point').textContent = section.s_point || '-';
    document.getElementById('ri-end-point').textContent = section.e_point || '-';
    document.getElementById('ri-length').textContent = formatLengthM(section.length_m);

    const sidebar = document.getElementById('left-sidebar');
    const toggleBtn = document.getElementById('leftSidebarToggle');
    if (sidebar.classList.contains('collapsed')) {
        sidebar.classList.remove('collapsed');
        toggleBtn.classList.remove('collapsed');
        setTimeout(() => { map.updateSize(); resizeDxfCanvas(); }, 220);
    }

    refreshRouteFilePanel();
    loadRouteFacilityCounts(section);
    loadRouteSectors(section);
    // 시설물(주요시설물·부대시설)은 구간을 선택해도 자동으로 켜지 않는다 — 필요할 때 트리의 아이콘으로 켠다.
    if (section.rdid) {
        highlightSectionGeom(section.rdid);
        loadSectionPanel(section.rdid);
    }
}

// ============================================================================
// 화면 다듬기 — 글씨 크기, 배경지도 불러오기 실패 안내, 노선 트리 찾기/등록된 것만 보기, 접근성(키보드·화면낭독 이름)
// ============================================================================

// ---------- 글씨 크기(보통/크게/아주 크게) ----------
// 모든 글자가 rem 기준이라 <html>의 글자 크기만 바꾸면 화면 전체가 같이 커진다. 브라우저별로 기억한다(localStorage 'rl-fs').
const FONT_SIZE_STEPS = [['', '보통'], ['lg', '크게'], ['xl', '아주 크게']];
function currentFontStep() {
    const v = document.documentElement.getAttribute('data-fs') || '';
    return FONT_SIZE_STEPS.findIndex((s) => s[0] === v) < 0 ? 0 : FONT_SIZE_STEPS.findIndex((s) => s[0] === v);
}
function applyFontStep(idx) {
    const [val, label] = FONT_SIZE_STEPS[idx];
    if (val) document.documentElement.setAttribute('data-fs', val); else document.documentElement.removeAttribute('data-fs');
    try { localStorage.setItem('rl-fs', val); } catch (e) { /* 저장 못 해도 이번 화면에는 적용됨 */ }
    const next = FONT_SIZE_STEPS[(idx + 1) % FONT_SIZE_STEPS.length][1];
    const btn = document.getElementById('font-size-btn');
    if (btn) {
        btn.title = `글씨 크기: ${label} (누르면 ${next})`;
        btn.setAttribute('aria-label', btn.title);
        btn.dataset.step = String(idx);
    }
    if (typeof map !== 'undefined' && map && map.updateSize) setTimeout(() => map.updateSize(), 50);
}
function initFontSizeButton() {
    const btn = document.getElementById('font-size-btn');
    if (!btn) return;
    applyFontStep(currentFontStep());
    btn.addEventListener('click', () => applyFontStep((currentFontStep() + 1) % FONT_SIZE_STEPS.length));
}

// ---------- 배경지도 불러오기 실패 안내 ----------
// VWorld 인증키나 등록 주소(Referer)가 맞지 않거나 업무망에서 막히면 지도가 빈 화면으로만 보여 원인을 알 수 없었다.
// 타일이 연속으로 실패하고 하나도 성공하지 못했을 때만 지도 위에 안내를 띄우고, 다시 불러와지면 스스로 닫는다.
function showMapNotice(html, onRetry) {
    const el = document.getElementById('map-notice');
    if (!el) return;
    el.innerHTML = html + (onRetry ? ' <button type="button" class="map-notice-retry">다시 불러오기</button>' : '') +
        ' <button type="button" class="map-notice-close" aria-label="안내 닫기"><i class="fa-solid fa-xmark"></i></button>';
    el.hidden = false;
    const retry = el.querySelector('.map-notice-retry');
    if (retry) retry.addEventListener('click', () => { el.hidden = true; onRetry(); });
    el.querySelector('.map-notice-close').addEventListener('click', () => { el.hidden = true; });
}
function hideMapNotice() {
    const el = document.getElementById('map-notice');
    if (el) el.hidden = true;
}
function watchBaseMapTiles(layer, label) {
    const source = layer.getSource();
    let ok = 0;
    let fail = 0;
    source.on('tileloadend', () => {
        ok++;
        fail = 0;
        if (layer.getVisible()) hideMapNotice();
    });
    source.on('tileloaderror', () => {
        fail++;
        if (ok === 0 && fail >= 4 && layer.getVisible()) {
            const keyMissing = !VWORLD_KEY;
            showMapNotice(
                `<i class="fa-solid fa-triangle-exclamation"></i> <b>${label} 배경지도를 불러오지 못했습니다.</b> ` +
                (keyMissing ? 'VWorld 인증키가 설정되지 않았습니다(서버 .env의 VWORLD_API_KEY).'
                    : '인터넷 연결, VWorld 인증키와 등록 주소(서버 .env의 VWORLD_REFERER)를 확인하세요.') +
                ' 도로·시설물 자료는 그대로 사용할 수 있습니다.',
                () => { fail = 0; source.refresh(); }
            );
        }
    });
}

// ---------- 노선 트리: 찾기 + 등록된 것만 보기 ----------
// 도로 종류 13개를 항상 다 보여주면 목록이 길어서, 기본으로 등록된 노선이 있는 종류만 보여 준다(체크를 끄면 전부 표시).
// 글자를 입력하면 노선·구간 이름에 맞는 것만 남기고 해당 도로 종류를 펼친다.
const TREE_ONLY_KEY = 'rl-tree-only';
function treeOnlyRegistered() {
    const cb = document.getElementById('tree-only-registered');
    return !cb || cb.checked;
}
function applyTreeFilter() {
    const container = document.getElementById('ledger-tree');
    if (!container) return;
    const q = ((document.getElementById('tree-filter-input') || {}).value || '').trim().toLowerCase();
    const onlyReg = treeOnlyRegistered();
    let anyVisible = false;
    container.querySelectorAll(':scope > .tree-node').forEach((grade) => {
        const isEmpty = grade.classList.contains('is-empty');
        let visible = !(onlyReg && isEmpty);
        if (q) {
            // 도로 종류 이름이 맞으면 그 아래 노선을 전부, 아니면 노선·구간 이름이 맞는 것만 보여 준다
            const gradeName = ((grade.querySelector(':scope > .tree-node-label > span') || {}).textContent || '').toLowerCase();
            const gradeMatch = gradeName.includes(q);
            let routeVisible = 0;
            grade.querySelectorAll(':scope > .tree-children > .tree-node').forEach((route) => {
                if (route.classList.contains('tree-node-empty')) return;
                const routeLabel = ((route.querySelector(':scope > .tree-node-label') || {}).textContent || '').toLowerCase();
                const leaves = [...route.querySelectorAll('.tree-leaf')];
                let leafMatch = 0;
                leaves.forEach((leaf) => {
                    const hit = gradeMatch || routeLabel.includes(q) || (leaf.textContent || '').toLowerCase().includes(q);
                    leaf.classList.toggle('tree-filtered-out', !hit);
                    if (hit) leafMatch++;
                });
                const show = gradeMatch || routeLabel.includes(q) || leafMatch > 0;
                route.classList.toggle('tree-filtered-out', !show);
                if (show) { routeVisible++; if (leafMatch && !gradeMatch && !routeLabel.includes(q)) route.classList.add('open'); }
            });
            visible = (gradeMatch || routeVisible > 0) && !(onlyReg && isEmpty);
            if (visible) grade.classList.add('open');
        } else {
            grade.querySelectorAll('.tree-filtered-out').forEach((n) => n.classList.remove('tree-filtered-out'));
        }
        grade.classList.toggle('tree-filtered-out', !visible);
        if (visible) anyVisible = true;
    });
    let msg = container.querySelector(':scope > .tree-filter-empty');
    if (!anyVisible && container.children.length && !container.querySelector(':scope > .tree-empty')) {
        if (!msg) {
            msg = document.createElement('div');
            msg.className = 'tree-empty tree-filter-empty';
            container.appendChild(msg);
        }
        msg.textContent = q ? `"${q}"에 해당하는 노선·구간이 없습니다.` : '등록된 노선이 없습니다. "등록된 것만" 체크를 끄면 모든 도로 종류가 보입니다.';
    } else if (msg) {
        msg.remove();
    }
}
function initTreeFilter() {
    const input = document.getElementById('tree-filter-input');
    const cb = document.getElementById('tree-only-registered');
    if (!input || !cb) return;
    try { cb.checked = localStorage.getItem(TREE_ONLY_KEY) !== '0'; } catch (e) { /* 기본값 사용 */ }
    let timer = null;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(applyTreeFilter, 120); });
    cb.addEventListener('change', () => {
        try { localStorage.setItem(TREE_ONLY_KEY, cb.checked ? '1' : '0'); } catch (e) { /* 무시 */ }
        applyTreeFilter();
    });
}

// ---------- 접근성: 이름 없는 버튼에 이름 붙이기, 키보드로 누르기 ----------
// 아이콘만 있는 버튼은 화면낭독기가 "버튼"이라고만 읽는다. 눈에 보이는 글자가 없고 title(풍선 도움말)이 있으면 그것을 이름(aria-label)으로 쓴다.
// <div>로 만든 클릭 요소(사이드바 접기 탭 등)는 버튼 역할과 키보드 포커스를 준다. 나중에 화면에 추가되는 버튼도 같이 처리한다.
function polishAccessibility(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('button:not([aria-label]), [role="button"]:not([aria-label])').forEach((el) => {
        const hasText = (el.textContent || '').trim().length > 0 && !el.querySelector(':scope > i:only-child');
        const title = el.getAttribute('title');
        if (title && (!hasText || (el.textContent || '').trim().length < 2)) el.setAttribute('aria-label', title);
    });
    ['sidebarToggle', 'leftSidebarToggle'].forEach((id) => {
        const el = document.getElementById(id);
        if (el && !el.hasAttribute('role')) { el.setAttribute('role', 'button'); el.setAttribute('tabindex', '0'); if (el.title) el.setAttribute('aria-label', el.title); }
    });
    scope.querySelectorAll('.tree-node-label:not([tabindex])').forEach((el) => {
        el.setAttribute('tabindex', '0');
        el.setAttribute('role', 'button');
    });
    const sidebarEl = document.getElementById('sidebarToggle');
    if (sidebarEl && !sidebarEl.getAttribute('aria-label')) sidebarEl.setAttribute('aria-label', '오른쪽 패널 접기/펴기');
}
function initAccessibility() {
    polishAccessibility(document);
    // Enter/Space로 role="button" 요소 누르기
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const t = e.target;
        if (!t || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.tagName === 'A') return;
        if (t.getAttribute && t.getAttribute('role') === 'button') { e.preventDefault(); t.click(); }
    });
    let timer = null;
    new MutationObserver((muts) => {
        if (timer) return;
        timer = setTimeout(() => { timer = null; polishAccessibility(document); }, 400);
    }).observe(document.body, { childList: true, subtree: true });
}

initFontSizeButton();
initTreeFilter();
initAccessibility();
(function initBaseMapProviderButton() {
    const btn = document.getElementById('btnProvider');
    if (btn) btn.addEventListener('click', () => switchBaseProvider(baseProvider === 'kakao' ? 'vworld' : 'kakao'));
})();

// ============================================================================
// 시설물 점검·보수 이력 + 변경 이력 (속성정보 창 위쪽의 "이력" 버튼)
//   점검·보수 : 시설물마다 점검/보수 기록을 쌓는다. 보기는 모두, 추가·수정·삭제는 편집 모드(관리자)에서만 — 서버도 관리자만 받는다.
//   변경 이력 : 점검·보수 기록 변경, 사진·보고서 올리기/삭제, 일괄등록으로 새로 들어오거나 값이 바뀐 것을 시간순으로 보여 준다.
// API: /api/facility-history (routes/facilityHistory.js)
// ============================================================================
const FH_RESULTS = { 점검: ['양호', '보통', '불량', '조치필요'], 보수: ['예정', '진행중', '완료'] };
const FH_RESULT_CLASS = { 양호: 'ok', 보통: 'mid', 불량: 'bad', 조치필요: 'bad', 예정: 'mid', 진행중: 'mid', 완료: 'ok' };
const FH_TYPE_ICON = {
    maint: 'fa-screwdriver-wrench', file: 'fa-paperclip', import_new: 'fa-file-import', import_update: 'fa-file-circle-check', edit: 'fa-pen',
};
let fhCtx = null; // { table, rdid, label, name, tab, editingId }

function fhTodayKst() {
    const d = new Date(Date.now() + 9 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
}
function fhDaysBetween(fromYmd, toYmd) {
    return Math.round((Date.parse(toYmd + 'T00:00:00Z') - Date.parse(fromYmd + 'T00:00:00Z')) / 86400000);
}
function fhMoney(n) {
    return n == null ? '' : Number(n).toLocaleString() + '원';
}

function fhEnsureModal() {
    let back = document.getElementById('fh-backdrop');
    if (back) return back;
    back = document.createElement('div');
    back.id = 'fh-backdrop';
    back.className = 'fh-backdrop';
    back.hidden = true;
    back.innerHTML = `
        <div id="fh-modal" role="dialog" aria-modal="true" aria-labelledby="fh-title">
            <div class="fh-head">
                <span class="fh-badge" id="fh-badge"></span>
                <b id="fh-title"></b>
                <span class="fh-rdid" id="fh-rdid"></span>
                <button type="button" class="fh-close" id="fh-close" aria-label="이력 창 닫기"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="fh-tabs" role="tablist">
                <button type="button" role="tab" data-tab="maint" class="active">점검·보수 이력 <span class="fh-count" id="fh-count-maint"></span></button>
                <button type="button" role="tab" data-tab="changes">변경 이력</button>
            </div>
            <div class="fh-body" id="fh-body"></div>
        </div>`;
    document.body.appendChild(back);
    back.addEventListener('mousedown', (e) => { if (e.target === back) closeFacilityHistory(); });
    back.querySelector('#fh-close').addEventListener('click', closeFacilityHistory);
    back.querySelectorAll('.fh-tabs button').forEach((b) => b.addEventListener('click', () => fhShowTab(b.dataset.tab)));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !back.hidden && !(typeof uiModalOpen === 'function' && uiModalOpen())) closeFacilityHistory();
    });
    return back;
}

function closeFacilityHistory() {
    const back = document.getElementById('fh-backdrop');
    if (back) back.hidden = true;
    fhCtx = null;
}

async function openFacilityHistory(table, rdid, label, name) {
    const back = fhEnsureModal();
    fhCtx = { table, rdid, label: label || '시설물', name: name || '', tab: 'maint', editingId: null, adding: false };
    document.getElementById('fh-badge').textContent = fhCtx.label;
    document.getElementById('fh-badge').style.setProperty('--fh-accent', facilityColor(fhCtx.label));
    document.getElementById('fh-title').textContent = fhCtx.name || fhCtx.label;
    document.getElementById('fh-rdid').textContent = rdid;
    back.hidden = false;
    await fhShowTab('maint');
    const first = back.querySelector('.fh-tabs button.active');
    if (first) first.focus();
}

async function fhShowTab(tab) {
    if (!fhCtx) return;
    fhCtx.tab = tab;
    fhCtx.editingId = null;
    fhCtx.adding = false;
    document.querySelectorAll('#fh-modal .fh-tabs button').forEach((b) => {
        const on = b.dataset.tab === tab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
    });
    const body = document.getElementById('fh-body');
    body.innerHTML = '<div class="state-msg"><i class="fa-solid fa-spinner fa-spin"></i> 불러오는 중...</div>';
    const ctx = fhCtx;
    try {
        if (tab === 'maint') {
            const params = new URLSearchParams({ table: ctx.table, rdid: ctx.rdid });
            const res = await fetch('/api/facility-history/maintenance?' + params.toString());
            const data = await res.json();
            if (fhCtx !== ctx || ctx.tab !== 'maint') return; // 그 사이 다른 시설물을 열거나 탭을 바꿈
            ctx.maint = data;
            fhRenderMaint();
        } else {
            const params = new URLSearchParams({ table: ctx.table, rdid: ctx.rdid });
            const res = await fetch('/api/facility-history/changes?' + params.toString());
            const data = await res.json();
            if (fhCtx !== ctx || ctx.tab !== 'changes') return;
            fhRenderChanges(data.items || []);
        }
    } catch (e) {
        if (fhCtx !== ctx) return;
        body.innerHTML = '<div class="state-msg is-error">이력을 불러오지 못했습니다.<button type="button" class="state-retry">다시 시도</button></div>';
        body.querySelector('.state-retry').addEventListener('click', () => fhShowTab(tab));
    }
}

function fhNextDueBadge(nextDue) {
    if (!nextDue) return '';
    const days = fhDaysBetween(fhTodayKst(), nextDue);
    if (days < 0) return `<span class="fh-due is-over">기한 ${-days}일 지남</span>`;
    if (days <= 30) return `<span class="fh-due is-soon">${days === 0 ? '오늘' : days + '일 남음'}</span>`;
    return `<span class="fh-due">${days}일 남음</span>`;
}

function fhRenderMaint() {
    const body = document.getElementById('fh-body');
    const { items = [], summary } = fhCtx.maint || {};
    document.getElementById('fh-count-maint').textContent = items.length ? `(${items.length})` : '';
    const last = summary && summary.lastInspection;
    const chips = [
        `<span class="fh-chip">점검 <b>${summary ? summary.inspections : 0}</b>건</span>`,
        `<span class="fh-chip">보수 <b>${summary ? summary.repairs : 0}</b>건</span>`,
        last ? `<span class="fh-chip">최근 점검 <b>${escapeHtml(last.performed_on)}</b>${last.result ? ` <span class="fh-result is-${FH_RESULT_CLASS[last.result] || 'mid'}">${escapeHtml(last.result)}</span>` : ''}</span>` : '<span class="fh-chip is-none">점검 기록 없음</span>',
        summary && summary.nextDue ? `<span class="fh-chip">다음 점검 예정 <b>${escapeHtml(summary.nextDue)}</b> ${fhNextDueBadge(summary.nextDue)}</span>` : '',
    ].join('');
    const cards = items.map((r) => `
        <article class="fh-card" data-id="${r.id}">
            <div class="fh-card-top">
                <span class="fh-kind is-${r.kind === '점검' ? 'insp' : 'repair'}">${escapeHtml(r.kind)}</span>
                <b class="fh-date">${escapeHtml(r.performed_on)}</b>
                ${r.result ? `<span class="fh-result is-${FH_RESULT_CLASS[r.result] || 'mid'}">${escapeHtml(r.result)}</span>` : ''}
                <span class="fh-card-actions fh-admin-only">
                    <button type="button" class="fh-edit" data-id="${r.id}" aria-label="이 기록 수정"><i class="fa-solid fa-pen"></i></button>
                    <button type="button" class="fh-del" data-id="${r.id}" aria-label="이 기록 삭제"><i class="fa-solid fa-trash"></i></button>
                </span>
            </div>
            <div class="fh-card-title">${escapeHtml(r.title)}</div>
            ${r.detail ? `<div class="fh-card-detail">${escapeHtml(r.detail)}</div>` : ''}
            <div class="fh-card-meta">
                ${r.contractor ? `<span><i class="fa-solid fa-building-user"></i> ${escapeHtml(r.contractor)}</span>` : ''}
                ${r.cost_won != null ? `<span><i class="fa-solid fa-won-sign"></i> ${escapeHtml(fhMoney(r.cost_won))}</span>` : ''}
                ${r.next_due ? `<span><i class="fa-solid fa-calendar-check"></i> 다음 점검 ${escapeHtml(r.next_due)} ${fhNextDueBadge(r.next_due)}</span>` : ''}
                <span class="fh-by">${escapeHtml(r.updated_by_name || r.created_by_name || '')} · ${escapeHtml(typeof fmtDateTimeKo === 'function' ? fmtDateTimeKo(r.updated_at || r.created_at) : '')}</span>
            </div>
        </article>`).join('');
    body.innerHTML = `
        <div class="fh-summary">${chips}</div>
        <div class="fh-toolbar fh-admin-only"><button type="button" class="fh-add"><i class="fa-solid fa-plus"></i> 점검·보수 기록 추가</button></div>
        <div id="fh-form-slot"></div>
        <div class="fh-list">${cards || '<div class="state-msg">아직 점검·보수 기록이 없습니다.<br><span class="fh-admin-only-text">편집 모드에서 기록을 추가할 수 있습니다.</span></div>'}</div>`;
    body.querySelector('.fh-add').addEventListener('click', () => fhOpenForm(null));
    body.querySelectorAll('.fh-edit').forEach((b) => b.addEventListener('click', () => fhOpenForm(Number(b.dataset.id))));
    body.querySelectorAll('.fh-del').forEach((b) => b.addEventListener('click', () => fhDelete(Number(b.dataset.id))));
}

function fhOpenForm(id) {
    const slot = document.getElementById('fh-form-slot');
    if (!slot) return;
    const rec = id ? (fhCtx.maint.items || []).find((r) => String(r.id) === String(id)) : null; // bigint는 문자열로 온다
    fhCtx.editingId = id;
    const kind = rec ? rec.kind : '점검';
    const resultOpts = (k, sel) => `<option value="">(선택 안 함)</option>` + FH_RESULTS[k].map((x) => `<option value="${x}"${x === sel ? ' selected' : ''}>${x}</option>`).join('');
    slot.innerHTML = `
        <form class="fh-form" novalidate>
            <div class="fh-form-title">${rec ? '기록 수정' : '새 점검·보수 기록'}</div>
            <div class="fh-row">
                <label>구분
                    <select name="kind">${['점검', '보수'].map((k) => `<option value="${k}"${k === kind ? ' selected' : ''}>${k}</option>`).join('')}</select>
                </label>
                <label>일자 <input type="date" name="performed_on" value="${escapeHtml(rec ? rec.performed_on : fhTodayKst())}" required></label>
                <label>결과 <select name="result">${resultOpts(kind, rec && rec.result)}</select></label>
            </div>
            <label class="fh-wide">내용 (한 줄) <input type="text" name="title" maxlength="200" value="${escapeHtml(rec ? rec.title : '')}" placeholder="예: 정기 안전점검, 난간 도장 보수" required></label>
            <label class="fh-wide">상세 <textarea name="detail" rows="3" maxlength="5000" placeholder="점검 내용·조치 사항·특이사항">${escapeHtml(rec && rec.detail ? rec.detail : '')}</textarea></label>
            <div class="fh-row">
                <label>비용(원) <input type="number" name="cost_won" min="0" step="1" value="${rec && rec.cost_won != null ? rec.cost_won : ''}"></label>
                <label>업체·담당 <input type="text" name="contractor" maxlength="100" value="${escapeHtml(rec && rec.contractor ? rec.contractor : '')}"></label>
                <label>다음 점검 예정일 <input type="date" name="next_due" value="${escapeHtml(rec && rec.next_due ? rec.next_due : '')}"></label>
            </div>
            <div class="fh-form-error" role="alert"></div>
            <div class="fh-form-buttons">
                <button type="button" class="fh-cancel">취소</button>
                <button type="submit" class="fh-save">저장</button>
            </div>
        </form>`;
    const form = slot.querySelector('form');
    form.elements.kind.addEventListener('change', () => { form.elements.result.innerHTML = resultOpts(form.elements.kind.value, ''); });
    slot.querySelector('.fh-cancel').addEventListener('click', () => { slot.innerHTML = ''; fhCtx.editingId = null; });
    form.addEventListener('submit', (e) => { e.preventDefault(); fhSave(form); });
    form.elements.title.focus();
}

async function fhSave(form) {
    const errEl = form.querySelector('.fh-form-error');
    errEl.textContent = '';
    const f = form.elements;
    const payload = {
        table: fhCtx.table, rdid: fhCtx.rdid, kind: f.kind.value, performed_on: f.performed_on.value, result: f.result.value,
        title: f.title.value, detail: f.detail.value, cost_won: f.cost_won.value, contractor: f.contractor.value, next_due: f.next_due.value,
    };
    const id = fhCtx.editingId;
    const btn = form.querySelector('.fh-save');
    btn.disabled = true;
    try {
        const res = await fetch(id ? `/api/facility-history/maintenance/${id}` : '/api/facility-history/maintenance', {
            method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { errEl.textContent = data.error || '저장하지 못했습니다.'; return; }
        uiToast(id ? '기록을 수정했습니다.' : '기록을 추가했습니다.', 'success');
        await fhShowTab('maint');
    } catch (e) {
        errEl.textContent = '저장하지 못했습니다. 네트워크 연결을 확인하세요.';
    } finally {
        btn.disabled = false;
    }
}

async function fhDelete(id) {
    const rec = (fhCtx.maint.items || []).find((r) => String(r.id) === String(id));
    if (!rec) return;
    if (!await uiConfirm(`${rec.performed_on} ${rec.kind} 기록 "${rec.title}"을(를) 삭제하시겠습니까?\n삭제하면 되돌릴 수 없지만, 삭제했다는 사실은 변경 이력에 남습니다.`)) return;
    try {
        const res = await fetch(`/api/facility-history/maintenance/${id}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '삭제하지 못했습니다.');
        uiToast('기록을 삭제했습니다.', 'success');
        await fhShowTab('maint');
    } catch (e) {
        uiAlert(e.message || '삭제하지 못했습니다.');
    }
}

function fhRenderChanges(items) {
    const body = document.getElementById('fh-body');
    if (!items.length) {
        body.innerHTML = '<div class="state-msg">기록된 변경 이력이 없습니다.<br>이 시설물이 처음 등록된 일괄등록 기록은 보관 기간(30일, 최근 10건)이 지나면 사라질 수 있습니다.</div>';
        return;
    }
    body.innerHTML = '<ol class="fh-timeline">' + items.map((it) => {
        const fields = (it.fields || []).length
            ? `<ul class="fh-fields">${it.fields.map((f) => `<li><span class="fh-fk">${escapeHtml(f.label)}</span> <span class="fh-before">${escapeHtml(f.before)}</span> <i class="fa-solid fa-arrow-right"></i> <span class="fh-after">${escapeHtml(f.after)}</span></li>`).join('')}</ul>`
            : '';
        return `<li class="fh-tl-item is-${escapeHtml(it.type)}">
            <span class="fh-tl-dot"><i class="fa-solid ${FH_TYPE_ICON[it.type] || 'fa-circle'}"></i></span>
            <div class="fh-tl-main">
                <div class="fh-tl-time">${escapeHtml(typeof fmtDateTimeKo === 'function' ? fmtDateTimeKo(it.at) : it.at)}${it.who ? ` · ${escapeHtml(it.who)}` : ''}</div>
                <div class="fh-tl-text">${escapeHtml(it.text)}</div>
                ${fields}
                ${it.note ? `<div class="fh-tl-note">${escapeHtml(it.note)}</div>` : ''}
            </div>
        </li>`;
    }).join('') + '</ol>';
}

// 속성정보 창의 "이력" 버튼
document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.fib-hist') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    openFacilityHistory(btn.dataset.table, btn.dataset.rdid, btn.dataset.label, btn.dataset.name);
});
