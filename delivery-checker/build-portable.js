// 검수 프로그램을 "설치 없이 폴더째 복사해서 쓰는" 형태로 묶는다.
//   node delivery-checker/build-portable.js            → delivery-checker/dist/검수프로그램/ 폴더
//   node delivery-checker/build-portable.js --zip      → 위 폴더 + delivery-checker/dist/도로대장_납품검수프로그램.zip
// 이 PC에 설치된 node.exe를 폴더 안(runtime)에 같이 넣으므로, 받는 PC에는 Node.js를 설치할 필요가 없다.
// DB 스키마(server/db/gov_facility_schema.sql)가 바뀌었으면 먼저 build-schema-snapshot.js를 다시 실행할 것.
const fs = require('fs');
const path = require('path');
const AdmZip = require('../server/node_modules/adm-zip');

const repo = path.join(__dirname, '..');
const outRoot = path.join(__dirname, 'dist');
const outDir = path.join(outRoot, '검수프로그램');

// 검수에 실제로 쓰는 서버 코드(server/lib)와 그 DB 파일 — 서버와 같은 코드를 그대로 복사한다.
const LIB_FILES = [
    'bulkImportParse.js', 'dbfParser.js', 'shpParser.js', 'crsRegistry.js', 'bulkImportSectors.js',
    'bulkImportAttachments.js', 'bulkImportRank.js', 'routeFileNaming.js', 'zipOpen.js', 'govLayerMap.js', 'schemaLabels.js',
];
const MODULES = ['iconv-lite', 'proj4', 'adm-zip'];

function copy(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
}

// 패키지와 그 의존 패키지를 server/node_modules에서 재귀로 모은다.
function collectModules(names, seen = new Set()) {
    for (const name of names) {
        if (seen.has(name)) continue;
        const dir = path.join(repo, 'server', 'node_modules', name);
        if (!fs.existsSync(dir)) throw new Error('모듈을 찾을 수 없습니다: ' + name + ' (server에서 npm install 필요)');
        seen.add(name);
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        collectModules(Object.keys(pkg.dependencies || {}), seen);
    }
    return seen;
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const f of ['server.js', 'checker.js', 'schema-snapshot.json']) copy(path.join(__dirname, f), path.join(outDir, 'delivery-checker', f));
copy(path.join(__dirname, 'public'), path.join(outDir, 'delivery-checker', 'public'));
for (const f of LIB_FILES) copy(path.join(repo, 'server', 'lib', f), path.join(outDir, 'server', 'lib', f));
copy(path.join(repo, 'server', 'db', 'gov_facility_schema.sql'), path.join(outDir, 'server', 'db', 'gov_facility_schema.sql'));
for (const m of collectModules(MODULES)) copy(path.join(repo, 'server', 'node_modules', m), path.join(outDir, 'node_modules', m));
copy(process.execPath, path.join(outDir, 'runtime', 'node.exe'));
copy(path.join(__dirname, '검수프로그램.bat'), path.join(outDir, '검수프로그램.bat'));
copy(path.join(__dirname, '사용방법.txt'), path.join(outDir, '사용방법.txt'));
console.log('폴더 생성:', outDir);

if (process.argv.includes('--zip')) {
    const zip = new AdmZip();
    zip.addLocalFolder(outDir, '검수프로그램');
    const zipPath = path.join(outRoot, '도로대장_납품검수프로그램.zip');
    zip.writeZip(zipPath);
    console.log('ZIP 생성:', zipPath, `(${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB)`);
}
