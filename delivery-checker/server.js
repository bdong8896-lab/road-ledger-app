// 도로대장 납품 검수 프로그램 — 이 PC에서만 열리는 작은 웹 화면(127.0.0.1)이다. 서버/DB/로그인이 필요 없다.
// 실행: 검수프로그램.bat 더블클릭(브라우저가 자동으로 열린다) 또는  node delivery-checker/server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { inspect, defectsToCsv } = require('./checker');

const START_PORT = Number(process.env.CHECKER_PORT) || 8765;
const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
let last = null; // 마지막 검수 결과(CSV 다운로드용)
let busy = false;

function sendJson(res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
        req.on('error', reject);
    });
}

// 윈도우 기본 "폴더/파일 선택" 창을 띄워 경로를 받는다(이 PC에서 직접 고르므로 경로를 외워 칠 필요가 없다).
// - 보이지 않는 맨 앞 창(소유 창)을 먼저 띄워서, 선택 창이 브라우저 뒤에 숨어 안 보이는 일을 막는다.
// - 스크립트는 -EncodedCommand(UTF-16 base64)로 넘겨서 한글이 PC의 코드페이지에 상관없이 깨지지 않는다.
// - 실패하면(PowerShell 차단 등) 이유를 화면에 알려서, 경로를 직접 붙여넣도록 안내한다.
function buildPickScript(type, skipDialog) {
    const dialog = type === 'zip'
        ? `$d = New-Object System.Windows.Forms.OpenFileDialog; $d.Filter = 'ZIP (*.zip)|*.zip'; $d.Title = '납품 ZIP 파일 선택'; if ($d.ShowDialog($f) -eq 'OK') { $d.FileName }`
        : `$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '납품 폴더(관리번호 폴더가 들어 있는 폴더) 선택'; if ($d.ShowDialog($f) -eq 'OK') { $d.SelectedPath }`;
    return [
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
        'Add-Type -AssemblyName System.Windows.Forms',
        '[System.Windows.Forms.Application]::EnableVisualStyles()',
        '$f = New-Object System.Windows.Forms.Form',
        "$f.TopMost = $true; $f.ShowInTaskbar = $false; $f.FormBorderStyle = 'None'; $f.Opacity = 0; $f.StartPosition = 'CenterScreen'",
        '$f.Show(); $f.Activate()',
        skipDialog ? "'TEST_OK'" : dialog,
        '$f.Close(); $f.Dispose()',
    ].join('; ');
}

function pickPath(type, skipDialog = false) {
    const script = buildPickScript(type, skipDialog);
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return new Promise((resolve, reject) => {
        let ps;
        try {
            ps = spawn(fs.existsSync(psExe) ? psExe : 'powershell.exe', ['-NoProfile', '-NoLogo', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
        } catch (e) { return reject(new Error('선택 창을 열 수 없습니다(PowerShell 실행 실패): ' + e.message)); }
        let out = '', err = '';
        ps.stdout.on('data', (d) => { out += d.toString('utf8'); });
        ps.stderr.on('data', (d) => { err += d.toString('utf8'); });
        ps.on('error', (e) => reject(new Error('선택 창을 열 수 없습니다(PowerShell 실행 실패): ' + e.message)));
        // 5분 안에 고르지 않으면 포기(선택 창이 어딘가에 남아 있어도 서버가 멈춰 있지 않게)
        const timer = setTimeout(() => { ps.kill(); reject(new Error('선택 창 응답이 없어 취소했습니다. 경로를 직접 입력해도 됩니다.')); }, 5 * 60 * 1000);
        ps.on('close', (code) => {
            clearTimeout(timer);
            if (!out.trim() && code !== 0) {
                return reject(new Error('선택 창을 열 수 없습니다' + (err ? ': ' + err.split('\n')[0].trim().slice(0, 160) : '') + ' — 경로를 직접 입력해 주세요.'));
            }
            resolve(out.trim());
        });
    });
}

const server = http.createServer(async (req, res) => {
    try {
        // 이 PC의 로컬 프로그램이라, 다른 웹사이트가 브라우저를 통해 몰래 요청을 보내는 것(교차 출처 요청, DNS 리바인딩)을 막는다:
        // 주소(Host)가 이 PC 주소가 아니거나, 출처(Origin)가 이 프로그램 화면이 아니면 거절한다.
        const host = String(req.headers.host || '');
        const hostName = host.split(':')[0];
        const origin = req.headers.origin;
        if ((hostName !== '127.0.0.1' && hostName !== 'localhost') || (origin && origin !== `http://${host}`)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('허용되지 않은 요청입니다.');
        }
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(indexHtml);
        }
        if (req.method === 'POST' && url.pathname === '/api/pick') {
            const { type } = await readBody(req);
            return sendJson(res, 200, { path: await pickPath(type === 'zip' ? 'zip' : 'folder') });
        }
        if (req.method === 'POST' && url.pathname === '/api/check') {
            if (busy) return sendJson(res, 409, { error: '이미 검수 중입니다. 끝난 뒤에 다시 시도하세요.' });
            const { path: p } = await readBody(req);
            if (!p) return sendJson(res, 400, { error: '검수할 폴더 또는 ZIP을 선택하세요.' });
            busy = true;
            try {
                const result = await inspect(String(p).trim().replace(/^"|"$/g, ''));
                last = result;
                const { _allDefects, ...forScreen } = result;
                return sendJson(res, 200, forScreen);
            } finally { busy = false; }
        }
        if (req.method === 'GET' && url.pathname === '/api/defects.csv') {
            if (!last) { res.writeHead(404); return res.end('검수 결과가 없습니다.'); }
            const code = (last.deliveryCodes || []).slice(0, 3).join('_') || 'delivery';
            const name = `KRRIS사전검사_${code}_${new Date().toISOString().slice(0, 10)}.csv`;
            res.writeHead(200, {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            });
            return res.end(defectsToCsv(last._allDefects));
        }
        res.writeHead(404); res.end('Not found');
    } catch (e) {
        console.error('[검수 오류]', e);
        sendJson(res, 500, { error: e.message || '검수 중 오류가 발생했습니다.' });
    }
});

function listen(port, tries) {
    server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && tries > 0) listen(port + 1, tries - 1);
        else { console.error('시작 실패:', e.message); process.exit(1); }
    });
    // 127.0.0.1에만 열어서 같은 네트워크의 다른 PC에서는 접속할 수 없다.
    server.listen(port, '127.0.0.1', () => {
        const addr = `http://127.0.0.1:${port}/`;
        console.log('============================================');
        console.log(' 도로대장 납품 검수 프로그램');
        console.log(' 주소: ' + addr);
        console.log(' 이 창을 닫으면 프로그램이 종료됩니다.');
        console.log('============================================');
        if (!process.env.CHECKER_NO_OPEN) exec(`start "" "${addr}"`);
    });
}
listen(START_PORT, 10);
