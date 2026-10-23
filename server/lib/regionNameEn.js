// 시군구 이름 → 영문 표기(지도 하단 저작권 문구용, 예: "화성시" → "HWASEONG CITY").
//
// 프로젝트에 시군구 영문명 자료가 없어서, 국어의 로마자 표기법(문화체육관광부 고시)을 그대로
// 구현했다. 지명은 소리 나는 대로 적으므로 음운 변화도 반영한다:
//   연음(받침 + ㅇ: 신안 → Sinan, 밀양 → Miryang), 비음화(강릉 → Gangneung, 종로 → Jongno),
//   유음화(울릉 → Ulleung, 신라 → Silla), 받침 대표음(곡성 → Gokseong, 합천 → Hapcheon).
// 체언에서 ㄱ·ㄷ·ㅂ 뒤의 ㅎ은 밝혀 적는다는 규정에 따라 거센소리되기는 반영하지 않는다(북한 → Bukhan).
// 행정단위는 영문 관용 표기: 시 → CITY, 군 → COUNTY, 자치구 → -GU.
const SIGUNGU_CODES = require('./sigunguCodes.json');

const INITIAL = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const MEDIAL = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
// 받침(종성 인덱스 0~27) → 대표음 k/n/t/l/m/p/ng (0 = 받침 없음)
const FINAL_SOUND = [
    '', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l',
    'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't',
];
// 받침이 다음 음절의 ㅇ으로 넘어갈 때(연음)의 소리: 받침 인덱스 → 로마자
const FINAL_LIAISON = [
    '', 'g', 'kk', 'ks', 'n', 'nj', 'n', 'd', 'r', 'lg', 'lm', 'lb', 'ls', 'lt', 'lp', 'r',
    'm', 'b', 'ps', 's', 'ss', 'ng', 'j', 'ch', 'k', 't', 'p', '',
];
const INI = { G: 0, N: 2, R: 5, M: 6, NG: 11 }; // 자주 쓰는 초성 인덱스

function decompose(ch) {
    const code = ch.charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) return null;
    return { i: Math.floor(code / 588), m: Math.floor((code % 588) / 28), f: code % 28 };
}

function romanize(text) {
    const syl = [...text].map(decompose);
    let out = '';
    for (let k = 0; k < syl.length; k++) {
        const s = syl[k];
        if (!s) { out += text[k]; continue; }
        let initial = INITIAL[s.i];
        const prev = k > 0 ? syl[k - 1] : null;
        if (prev && prev.f) {
            const pf = FINAL_SOUND[prev.f];
            if (s.i === INI.R) {
                // ㄹ 앞: 받침 ㄴ·ㄹ → ll(유음화), 그 외 받침 → n(비음화)
                initial = (pf === 'n' || pf === 'l') ? 'l' : 'n';
            } else if (s.i === INI.N && pf === 'l') {
                initial = 'l'; // ㄹ + ㄴ → ll
            }
        } else if (s.i === INI.R && k > 0) {
            initial = 'r'; // 모음 뒤 ㄹ
        }
        out += initial + MEDIAL[s.m];
        if (s.f) {
            const next = syl[k + 1];
            if (next && next.i === INI.NG) {
                out += FINAL_LIAISON[s.f]; // 연음
            } else {
                let sound = FINAL_SOUND[s.f];
                if (next && (next.i === INI.N || next.i === INI.M || next.i === INI.R)) {
                    // 비음화: ㄱ→ng, ㄷ→n, ㅂ→m (뒤가 ㄴ·ㅁ·ㄹ)
                    if (sound === 'k') sound = 'ng';
                    else if (sound === 't') sound = 'n';
                    else if (sound === 'p') sound = 'm';
                    else if (sound === 'n' && next.i === INI.R) sound = 'l'; // ㄴ + ㄹ → ll
                }
                out += sound;
            }
        }
    }
    return out;
}

// "화성시" → "HWASEONG CITY", "장성군" → "JANGSEONG COUNTY", "종로구" → "JONGNO-GU"
function unitToEnglish(name) {
    const m = /^(.+?)(특별자치시|시|군|구)$/.exec(name);
    if (!m) return romanize(name).toUpperCase();
    const base = romanize(m[1]).toUpperCase();
    if (m[2] === '군') return `${base} COUNTY`;
    if (m[2] === '구') return `${base}-GU`;
    return `${base} CITY`;
}

// 자치구 이름 뒤에 붙일 광역시·특별시 영문명("중구"는 서울·부산·대구 등 여러 곳에 있다).
// 전남광주통합특별시의 자치구는 옛 광주광역시 구이므로 GWANGJU.
const METRO_EN_OVERRIDE = { 전남광주통합특별시: 'GWANGJU' };
function metroToEnglish(sido) {
    if (METRO_EN_OVERRIDE[sido]) return METRO_EN_OVERRIDE[sido];
    return romanize(sido.replace(/(특별자치시|특별시|광역시)$/, '')).toUpperCase();
}

// 시군구 코드 → 그 지자체의 영문명. 일반구(경기도 수원시 장안구 등)는 구가 아니라 시가
// 지자체이므로 시 이름을 쓰고, 특별시·광역시의 자치구는 "구, 도시"로 쓴다(JUNG-GU, SEOUL).
function regionNameEn(sigunguCode) {
    const entry = SIGUNGU_CODES.find((c) => c.code5 === String(sigunguCode || ''));
    if (!entry) return null;
    const parts = entry.full.split(/\s+/);
    if (parts.length >= 3) return unitToEnglish(parts[1]); // 도 + 시 + 일반구
    const name = unitToEnglish(entry.sgg || entry.sido);
    return /구$/.test(entry.sgg) ? `${name}, ${metroToEnglish(entry.sido)}` : name;
}

module.exports = { romanize, regionNameEn };
