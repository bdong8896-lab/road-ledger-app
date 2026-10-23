// 업로드된 ZIP을 여는 공용 함수 — 한국어 Windows ZIP의 파일명(CP949)을 제대로 읽는다.
//
// 한국어 Windows(탐색기·반디집 등)로 만든 ZIP은 파일명을 UTF-8이 아니라 CP949로 저장하는데,
// adm-zip은 기본적으로 UTF-8로 읽어서 한글 이름이 전부 깨진다("신규/" → "����/").
// adm-zip 0.6.1부터는 같은 이름의 항목이 둘 이상이면 ZIP 자체를 거부하는 보안 검사가
// 생겼는데(GHSA-p634-w6r4-rjp2), 깨진 결과 "삭제/·신규/·원본/·통합/"이 모두 같은 "����/"가
// 되어 "중복"으로 판정 → 실제 납품 ZIP의 일괄등록이 아예 실패했다(2026-10 확인).
// 그래서 이름이 올바른 UTF-8이면 UTF-8로, 아니면 CP949로 읽는다(보안 검사는 그대로 유지).
const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');

const KOREAN_AWARE_DECODER = {
    efs: false,
    encode: (str) => iconv.encode(str, 'cp949'),
    decode: (buf) => {
        const utf8 = buf.toString('utf8');
        return Buffer.from(utf8, 'utf8').equals(buf) ? utf8 : iconv.decode(buf, 'cp949');
    },
};

function openZip(zipPath) {
    return new AdmZip(zipPath, { decoder: KOREAN_AWARE_DECODER });
}

module.exports = { openZip };
