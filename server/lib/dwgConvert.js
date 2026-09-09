// DWG → DXF 변환. 기본은 함께 배포되는 LibreDWG(dwg2dxf, GPL)를 쓴다 —
// server/vendor/libredwg-win64/ 참고. 변환기가 설정되어 있지 않거나 실패해도
// 예외를 던지지 않고 false만 반환한다 — DWG 원본 업로드 자체는 변환 성공
// 여부와 무관하게 항상 성공해야 하기 때문이다.
//
// 다른 변환기(ODA File Converter 등)로 바꾸려면 이 파일의 convertDwgToDxf()
// 내부만 그 변환기의 CLI 문법에 맞게 고치면 된다 — 호출하는 쪽(routeFiles.js)은
// convertDwgToDxf(dwgPath, outDxfPath) 시그니처만 알면 되므로 영향 없음.
const fs = require('fs');
const { execFile } = require('child_process');
const config = require('../config');

const CONVERT_TIMEOUT_MS = 45000;

function isConverterConfigured() {
    return !!config.dwgConverterPath && fs.existsSync(config.dwgConverterPath);
}

// dwgPath 파일을 DXF로 변환해서 outDxfPath에 저장한다. 성공하면 true.
async function convertDwgToDxf(dwgPath, outDxfPath) {
    if (!isConverterConfigured()) return false;
    if (!fs.existsSync(dwgPath)) return false;

    try {
        // dwg2dxf -o <출력파일> -y(덮어쓰기) <입력파일>
        await new Promise((resolve, reject) => {
            const args = ['-o', outDxfPath, '-y', dwgPath];
            execFile(config.dwgConverterPath, args, { timeout: CONVERT_TIMEOUT_MS }, (err) => {
                if (err) reject(err); else resolve();
            });
        });
        return fs.existsSync(outDxfPath);
    } catch (err) {
        return false;
    }
}

module.exports = { convertDwgToDxf, isConverterConfigured };
