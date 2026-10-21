// 업로드 파일을 브라우저에서 바로 열어보는(?inline=1) 응답을 안전하게 보낸다.
// 업로드는 확장자 제한이 없고 같은 도메인에서 서빙되므로, .html/.svg 같은 "실행되는" 문서를
// inline으로 내려주면 올린 사람의 스크립트가 다른 사용자(관리자 포함)의 로그인 세션으로
// 실행된다(저장형 XSS). 그런 형식은 inline 요청이어도 다운로드로만 내려준다.
// 이미지·PDF·DXF 미리보기 등 나머지는 기존처럼 inline.
const path = require('path');

const ACTIVE_CONTENT_EXT = new Set([
    '.html', '.htm', '.xhtml', '.shtml', '.svg', '.svgz', '.xml', '.xsl', '.xslt',
    '.js', '.mjs', '.hta', '.mht', '.mhtml', '.swf',
]);

function sendInlineSafely(res, filePath, displayName) {
    const resolved = path.resolve(filePath);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (ACTIVE_CONTENT_EXT.has(path.extname(displayName || resolved).toLowerCase())
        || ACTIVE_CONTENT_EXT.has(path.extname(resolved).toLowerCase())) {
        return res.download(resolved, displayName);
    }
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(displayName)}`);
    return res.sendFile(resolved);
}

module.exports = { sendInlineSafely };
