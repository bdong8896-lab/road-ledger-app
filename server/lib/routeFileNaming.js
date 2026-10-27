// "도로" 카테고리 중 500m 단위로 쪼갠 구간 도면(평면도 등)의 파일명 규칙을
// 해석한다. 실제 원본 벤더 데이터(NDB\장성군.mDB의 DWG_INFO 테이블)를 hex/텍스트로
// 직접 대조해서 확인한 패턴이다:
//   {노선번호 4자리}{구간 2자리}{측점 6자리}{P|Y}.dwg   예) 000801100500P.dwg
// 측점 6자리는 "100000 + 시점(km)*1000" 형식 — 예) 100500 → 시점 0.5km.
// 한 구간(500m)은 시점~시점+0.5km이며, DWG_INFO 실 데이터로 검증 완료
// (SECT_ST=0.5,SECT_ED=1.0 행의 DWG_NAME이 정확히 000801100500).
const STATION_FILE_RE = /^(\d{4})(\d{2})(\d{6})([A-Za-z])\.(dwg|dxf)$/i;

// segEndKm: 다음 500m 경계가 기본이지만, 구간 총연장(sectionLengthKm)을 넘으면
// 실제 종점까지만(마지막 조각은 500m보다 짧을 수 있음 — 실사례: 5.0~5.023km).
function parseStationFilename(originalName, sectionLengthKm) {
    const m = STATION_FILE_RE.exec(originalName);
    if (!m) return null;
    const [, routeNo, sect, stationRaw, variant] = m;
    const station = parseInt(stationRaw, 10);
    if (station < 100000) return null; // 예상 범위를 벗어나면 오탐으로 보고 무시
    const segStartKm = (station - 100000) / 1000;
    let segEndKm = segStartKm + 0.5;
    if (sectionLengthKm != null && segEndKm > sectionLengthKm) segEndKm = sectionLengthKm;
    const segNo = Math.round(segStartKm / 0.5) + 1;
    return {
        routeNo, sect, segNo,
        segStartKm: Math.round(segStartKm * 1000) / 1000,
        segEndKm: Math.round(segEndKm * 1000) / 1000,
        segVariant: variant.toUpperCase(),
    };
}

// "도면종류" 탭이 도로 탭(500m 구간 평면도/용지도)을 포함하는 상위 개념으로
// 바뀌면서, 파일 하나가 "평면도/용지도/매설물도/구조물도" 중 어디에 속하는지
// 판정하는 규칙이 필요해졌다. 실사용자 확인 기준:
//   - "도로" 카테고리(500m 단위, seg_variant 있음): P=평면도, Y=용지도, U=매설물도
//     (500_U 폴더 = 매설물도: 2026-10-27 사용자 확인)
//   - "도면종류" 카테고리(노선 전체 단위 파일, 파일명 접두어로 구분):
//     TOP=지적도(용지 관련 내용이라 "용지도"로 묶음; 접두어 없는 000501.DXF 형태도 TOP), CON=노선 전체 평면도
//     ("평면도"로 묶음). 구조물도는 아직 실제로 확인된 파일명 규칙이
//     없어 항상 미분류(null) — 탭 구조는 만들어두되 채워지는 파일은 없다.
function classifyDrawingType(file) {
    if (file.file_category === '도로') {
        if (file.seg_variant === 'P') return '평면도';
        if (file.seg_variant === 'Y') return '용지도';
        if (file.seg_variant === 'U') return '매설물도';
        return null;
    }
    if (file.file_category === '도면종류') {
        if (/^TOP/i.test(file.original_name)) return '용지도';
        // ETC/TOP 폴더의 파일이 접두어 없이 {노선4}{구간2}.dxf(예: 000501.DXF)로 오는 납품이 있다(2026-10-23 장성 납품).
        // 이름에 TOP이 없다는 이유로 미분류가 되어 용지도 탭에서 빠지던 것 — 숫자만으로 된 노선·구간 도면은 TOP 폴더 규칙으로 본다.
        // 구간이 한 자리 모자란 5자리 이름(00802.DXF)도 실제 납품에 있어 5~6자리를 허용한다.
        if (/^\d{5,6}\.(dxf|dwg)$/i.test(file.original_name)) return '용지도';
        if (/^CON/i.test(file.original_name)) return '평면도';
        // SE{노선4}{구간2}{측점5}: 신규 납품의 노선·구간 전체 평면도(CONT 폴더, 장성/화성 납품으로 확인)
        if (/^SE\d/i.test(file.original_name)) return '평면도';
        return null;
    }
    return null;
}

const DRAWING_TYPES = ['평면도', '용지도', '매설물도', '구조물도'];

// 도면 파일명에서 노선번호/구간을 읽는 규칙들(도면 자동 인식 업로드와 별도 검수 프로그램이 같이 쓴다).
//   2) 노선·구간 도면:      [영문접두어]{노선4}{구간2}            예) TOP010101.dxf, 010101.dxf
//   3) 구간 전체 도면(CONT): {영문접두어}{노선4}{구간2}{측점5}      예) SE01010100000.dxf
// (1) 500m 단위 구간도면은 위 parseStationFilename.
const ROUTE_SECT_FILE_RE = /^[A-Za-z]*(\d{4})(\d{2})\.(dwg|dxf)$/i;
const SECTION_WHOLE_FILE_RE = /^[A-Za-z]+(\d{4})(\d{2})\d{5}\.(dwg|dxf)$/i;

// DB 없이 파일명만으로 읽을 수 있는 정보. 못 읽으면 null. sect는 3자리로 맞춰 돌려준다.
function parseDrawingFilename(base) {
    const st = parseStationFilename(base, null);
    if (st) return { kind: 'station', routeNo: st.routeNo, sect: st.sect.padStart(3, '0'), category: '도로', variant: st.segVariant };
    let m = ROUTE_SECT_FILE_RE.exec(base);
    if (m) return { kind: 'route-sect', routeNo: m[1], sect: m[2].padStart(3, '0'), category: '도면종류' };
    m = SECTION_WHOLE_FILE_RE.exec(base);
    if (m) return { kind: 'section-whole', routeNo: m[1], sect: m[2].padStart(3, '0'), category: '도면종류' };
    return null;
}

module.exports = { parseStationFilename, classifyDrawingType, DRAWING_TYPES, ROUTE_SECT_FILE_RE, SECTION_WHOLE_FILE_RE, parseDrawingFilename };
