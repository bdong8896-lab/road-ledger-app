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
//   - "도로" 카테고리(500m 단위, seg_variant 있음): P=평면도, Y=용지도
//     (500_U 폴더도 실제 납품에 존재하지만 대응되는 유형이 아직 없어 미분류로 둔다)
//   - "도면종류" 카테고리(노선 전체 단위 파일, 파일명 접두어로 구분):
//     TOP=지적도(용지 관련 내용이라 "용지도"로 묶음), CON=노선 전체 평면도
//     ("평면도"로 묶음). 매설물도/구조물도는 아직 실제로 확인된 파일명 규칙이
//     없어 항상 미분류(null) — 탭 구조는 만들어두되 채워지는 파일은 없다.
function classifyDrawingType(file) {
    if (file.file_category === '도로') {
        if (file.seg_variant === 'P') return '평면도';
        if (file.seg_variant === 'Y') return '용지도';
        return null;
    }
    if (file.file_category === '도면종류') {
        if (/^TOP/i.test(file.original_name)) return '용지도';
        if (/^CON/i.test(file.original_name)) return '평면도';
        return null;
    }
    return null;
}

const DRAWING_TYPES = ['평면도', '용지도', '매설물도', '구조물도'];

module.exports = { parseStationFilename, classifyDrawingType, DRAWING_TYPES };
