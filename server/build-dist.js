// public/(원본 소스)을 그대로 두고, 배포용 난독화 버전을 public-dist/에 새로
// 만든다. public/은 언제나 원본 그대로이고 이 스크립트가 손대지 않으므로,
// 원복은 그냥 SERVE_DIR을 다시 'public'으로 바꾸고(또는 .env에서 지우고)
// 서버만 재시작하면 끝난다(config.js 참고) — 파일을 따로 되돌릴 필요가 없다.
//
// script.js와 cad-viewer.js는 <script src> 여러 개로 나눠 실행되지만 모듈이
// 아니라서 전역변수(let currentRoute, let map 등)로 서로 참조한다. 따로따로
// 난독화하면 도구가 그 연결을 몰라서 한쪽에서만 이름이 바뀌어 깨지기 때문에,
// index.html이 쓰는 조합(cad-viewer.js+script.js)은 하나로 합친 뒤 한 번에
// 난독화한다. cad-popup.html은 script.js를 안 쓰고 cad-viewer.js만 쓰므로
// 그건 따로(단독으로) 난독화한다 — 팝업창은 별도 전역 스코프라 index.html
// 쪽 결과물과 이름이 달라도 서로 영향 없다.
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'public');
const DIST_DIR = path.join(ROOT, 'public-dist');

// index.html의 onclick="..."이 직접 부르는 이름들 — 난독화로 이름이 바뀌면
// HTML은 그 사실을 모르니 옛 이름을 계속 불러서 깨진다.
const RESERVED_FOR_INDEX_BUNDLE = [
    'map', 'switchBase', 'toggleSplitView', 'switchSidebarTab', 'runUnifiedSearch', 'startSplitDrag',
];
// cad-popup.html의 인라인 <script>가 cad-viewer.js 쪽 이름을 직접 부르는 것들.
const RESERVED_FOR_CAD_VIEWER_ALONE = [
    'resetFacilityGridPlaceholder', 'initRouteFileTabs', 'initCadToolbarButtons',
    'initDxfCanvas', 'currentRoute', 'currentRouteCategory', 'formatLengthM', 'loadRouteFileList',
    'loadRouteFacilityCounts', 'loadDxfFile', 'refreshRouteFilePanel',
];

// 지도/도면 렌더링처럼 매 프레임 도는 코드가 있어서, 가장 강한 옵션(특히
// controlFlowFlattening/deadCodeInjection을 전 구간에 다 걸기)은 체감 성능을
// 떨어뜨릴 수 있다 — threshold를 중간 정도로 낮춰 "많이 느려지지 않으면서
// 확실히 알아보기 어렵게"를 목표로 했다. 변수명 난독화(기본 hexadecimal)와
// 문자열 배열화는 성능 영향이 거의 없어 그대로 최대로 켠다.
function obfuscate(code, reservedNames) {
    return JavaScriptObfuscator.obfuscate(code, {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.4,
        deadCodeInjection: true,
        deadCodeInjectionThreshold: 0.2,
        stringArray: true,
        stringArrayEncoding: ['base64'],
        stringArrayThreshold: 0.75,
        selfDefending: true,
        // 실사용자(관공서 직원)도 문제 생기면 개발자도구로 콘솔 에러를 봐야 하니
        // debugProtection/disableConsoleOutput은 끈다 — 너무 공격적으로 막으면
        // 정상적인 문제 진단까지 막혀버린다.
        debugProtection: false,
        disableConsoleOutput: false,
        reservedNames: reservedNames.map((n) => `^${n}$`),
    }).getObfuscatedCode();
}

// public/dxf-core는 실제 서비스 코드가 아니라 three-dxf-viewer를 IIFE
// 번들로 만들어보는 격리된 실험용 서브프로젝트다(package.json에 "public의
// 나머지 파일들과 배포 파이프라인에는 영향 없음"이라고 직접 적혀 있고,
// index.html/cad-popup.html 어디서도 실제로 참조하지 않음 — 확인함). 그
// node_modules만 3,400개가 넘는 파일이라 복사할 때마다 백신 실시간 검사와
// 겹쳐 몇 분씩 멈춘 것처럼 보이는 원인이었다. 배포 결과물과 무관하니
// 통째로 건너뛴다.
const SKIP_TOP_LEVEL_DIRS = new Set(['dxf-core']);

function copyRecursive(src, dest, isTopLevel) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (isTopLevel && entry.isDirectory() && SKIP_TOP_LEVEL_DIRS.has(entry.name)) continue;
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyRecursive(s, d, false);
        else fs.copyFileSync(s, d);
    }
}

function build() {
    console.log('[build-dist] public/ -> public-dist/ 생성 중 (원본은 그대로 유지)');
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    copyRecursive(SRC_DIR, DIST_DIR, true);

    const cadViewerSrc = fs.readFileSync(path.join(SRC_DIR, 'cad-viewer.js'), 'utf8');
    const scriptSrc = fs.readFileSync(path.join(SRC_DIR, 'script.js'), 'utf8');

    // 1) index.html용: 둘을 합쳐서 한 번에 난독화 -> app.bundle.js 하나로
    console.log('[build-dist] index.html용 번들 난독화 중...');
    const bundleSrc = `${cadViewerSrc}\n;\n${scriptSrc}`;
    const bundleOut = obfuscate(bundleSrc, RESERVED_FOR_INDEX_BUNDLE);
    fs.writeFileSync(path.join(DIST_DIR, 'app.bundle.js'), bundleOut);
    fs.unlinkSync(path.join(DIST_DIR, 'script.js'));

    // 2) cad-popup.html용: cad-viewer.js 단독 난독화(같은 파일명으로 덮어씀)
    console.log('[build-dist] cad-popup.html용 cad-viewer.js 단독 난독화 중...');
    const cadViewerOnlyOut = obfuscate(cadViewerSrc, RESERVED_FOR_CAD_VIEWER_ALONE);
    fs.writeFileSync(path.join(DIST_DIR, 'cad-viewer.js'), cadViewerOnlyOut);

    // 3) index.html의 <script src> 두 줄을 번들 하나로 교체
    const indexHtmlPath = path.join(DIST_DIR, 'index.html');
    let indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
    const before = indexHtml;
    indexHtml = indexHtml.replace(
        /<script src="cad-viewer\.js"><\/script>\s*<script src="script\.js"><\/script>/,
        '<script src="app.bundle.js"></script>'
    );
    if (indexHtml === before) {
        throw new Error('index.html의 <script src="cad-viewer.js">/<script src="script.js"> 태그를 못 찾았습니다 — 원본 구조가 바뀌었는지 확인하세요.');
    }
    fs.writeFileSync(indexHtmlPath, indexHtml);

    console.log('[build-dist] 완료:', DIST_DIR);
    console.log('[build-dist] 적용하려면 server/.env에 SERVE_DIR=public-dist 추가 후 서버 재시작');
    console.log('[build-dist] 원복하려면 SERVE_DIR을 지우거나 public으로 바꾸고 서버만 재시작(파일 변경 불필요)');
}

build();
