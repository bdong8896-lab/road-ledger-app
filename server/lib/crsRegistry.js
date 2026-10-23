// .prj(WKT) 텍스트에서 좌표계를 판별하고 EPSG:4326으로 재투영한다. 벤더가
// 첨부하는 체크리스트 문서의 좌표계 표기(예: "UTM-K")는 신뢰하지 않고, 매
// 레이어 파일마다 실제 .prj를 직접 읽어 판별한다 — 실제로 "UTM-K"라고 적힌
// 문서와 달리 첨부된 .prj가 EPSG:3857(Web Mercator)인 사례를 확인했다.
const proj4 = require('proj4');

// 알려진 한국 좌표계 정의. WKT 텍스트의 특징적인 문자열로 매칭한다.
const CRS_REGISTRY = [
    {
        epsg: 'EPSG:3857',
        label: 'Web Mercator (Auxiliary Sphere)',
        test: /Web_Mercator/i,
        def: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
    },
    {
        epsg: 'EPSG:5179',
        label: 'Korea 2000 / Unified CS (UTM-K)',
        test: /(GRS_1980|GRS80).*?(Korea|Katech|Unified)/is,
        def: '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs',
    },
    {
        epsg: 'EPSG:5174',
        label: 'Korean 1985 / Modified Central Belt (Bessel)',
        test: /Bessel.*?(Korea|Central)/is,
        def: '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43 +units=m +no_defs',
    },
    {
        epsg: 'EPSG:4326',
        label: 'WGS84 경위도',
        test: /GCS_WGS_1984|WGS_1984(?!.*Mercator)/i,
        def: '+proj=longlat +datum=WGS84 +no_defs',
    },
];

// Korea 2000(GRS80) 횡메르카토르 계열 — 이름 문자열이 아니라 투영 파라미터(중앙자오선·
// 원점 가산값·축척)로 구별한다. 예전엔 위 정규식 하나("GRS_1980 뒤에 Korea")로 5179를
// 판별했는데, 표준 ESRI .prj는 "Korea_2000..." 이름이 GRS_1980보다 앞에 오기 때문에
// 정상적인 5179 파일조차 "인식할 수 없는 좌표계"가 되어 지오메트리가 버려졌고, 국내에서
// 흔한 중부원점(5186) 등은 아예 구별할 수 없었다(2026-10 확인).
const KOREA_2000_TM = [
    { epsg: 'EPSG:5179', label: 'Korea 2000 / Unified CS (UTM-K)', lon0: 127.5, k: 0.9996, x0: 1000000, y0: 2000000 },
    { epsg: 'EPSG:5185', label: 'Korea 2000 / West Belt 2010 (서부원점)', lon0: 125, k: 1, x0: 200000, y0: 600000 },
    { epsg: 'EPSG:5186', label: 'Korea 2000 / Central Belt 2010 (중부원점)', lon0: 127, k: 1, x0: 200000, y0: 600000 },
    { epsg: 'EPSG:5187', label: 'Korea 2000 / East Belt 2010 (동부원점)', lon0: 129, k: 1, x0: 200000, y0: 600000 },
    { epsg: 'EPSG:5188', label: 'Korea 2000 / East Sea Belt 2010 (동해원점)', lon0: 131, k: 1, x0: 200000, y0: 600000 },
    { epsg: 'EPSG:5180', label: 'Korea 2000 / West Belt (서부원점)', lon0: 125, k: 1, x0: 200000, y0: 500000 },
    { epsg: 'EPSG:5181', label: 'Korea 2000 / Central Belt (중부원점)', lon0: 127, k: 1, x0: 200000, y0: 500000 },
    { epsg: 'EPSG:5183', label: 'Korea 2000 / East Belt (동부원점)', lon0: 129, k: 1, x0: 200000, y0: 500000 },
    { epsg: 'EPSG:5184', label: 'Korea 2000 / East Sea Belt (동해원점)', lon0: 131, k: 1, x0: 200000, y0: 500000 },
];

for (const entry of CRS_REGISTRY) {
    proj4.defs(entry.epsg, entry.def);
}
for (const e of KOREA_2000_TM) {
    proj4.defs(e.epsg, `+proj=tmerc +lat_0=38 +lon_0=${e.lon0} +k=${e.k} +x_0=${e.x0} +y_0=${e.y0} +ellps=GRS80 +units=m +no_defs`);
}

// KRRIS(국가 도로대장 검수) 제출 기준 좌표계 — 도로대장 작성지침에 명시(EPSG:5179).
const KRRIS_REQUIRED_EPSG = 'EPSG:5179';

// WKT의 PARAMETER["이름",값] 목록 → { 소문자이름: 숫자 } (ESRI/OGC 표기 모두 같은 이름).
function wktParams(wkt) {
    const out = {};
    for (const m of wkt.matchAll(/PARAMETER\s*\[\s*"([^"]+)"\s*,\s*(-?[\d.]+(?:[eE][-+]?\d+)?)\s*\]/g)) {
        out[m[1].toLowerCase()] = Number(m[2]);
    }
    return out;
}

const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b));

function detectKorea2000Tm(wkt) {
    if (!/Transverse_Mercator/i.test(wkt) || !/GRS[_ ]?1980|GRS80|Korea_2000|Korean_Datum_2000/i.test(wkt)) return null;
    const p = wktParams(wkt);
    const k = p.scale_factor !== undefined ? p.scale_factor : 1;
    const lat0 = p.latitude_of_origin !== undefined ? p.latitude_of_origin : 38;
    return KOREA_2000_TM.find((e) =>
        near(p.central_meridian, e.lon0) && near(p.false_easting, e.x0) && near(p.false_northing, e.y0) &&
        near(k, e.k) && near(lat0, 38)) || null;
}

// .prj WKT 텍스트 → { matched, epsg, label } 판별. 순서: Web Mercator(내부에 GCS_WGS_1984가
// 들어 있어 WGS84보다 먼저) → Korea 2000 횡메르카토르(파라미터 대조) → 나머지 이름 정규식.
function detectCrs(wktText) {
    const wkt = String(wktText || '');
    if (CRS_REGISTRY[0].test.test(wkt)) {
        return { matched: true, epsg: CRS_REGISTRY[0].epsg, label: CRS_REGISTRY[0].label };
    }
    const tm = detectKorea2000Tm(wkt);
    if (tm) return { matched: true, epsg: tm.epsg, label: tm.label };
    for (const entry of CRS_REGISTRY.slice(1)) {
        // 5179는 위 파라미터 대조로만 판별한다(이 정규식은 다른 Korea 2000 좌표계도 5179로
        // 오인할 수 있어 이제 쓰지 않음).
        if (entry.epsg === 'EPSG:5179') continue;
        if (entry.test.test(wkt)) {
            return { matched: true, epsg: entry.epsg, label: entry.label };
        }
    }
    return { matched: false, epsg: null, label: null };
}

// GeoJSON 좌표 배열(재귀적으로 [x,y] 또는 [x,y,z] 리스트)을 EPSG:4326으로
// 변환한다. Z값은 버린다(이 앱은 지금까지 2D 지오메트리만 다뤄왔음).
function reprojectCoords(coords, sourceEpsg) {
    if (typeof coords[0] === 'number') {
        const [x, y] = proj4(sourceEpsg, 'EPSG:4326', [coords[0], coords[1]]);
        return [Number(x.toFixed(7)), Number(y.toFixed(7))];
    }
    return coords.map((c) => reprojectCoords(c, sourceEpsg));
}

// GeoJSON 지오메트리 객체({type, coordinates}) 전체를 재투영한다.
function reprojectGeometry(geometry, sourceEpsg) {
    if (!geometry || sourceEpsg === 'EPSG:4326') return geometry;
    return { type: geometry.type, coordinates: reprojectCoords(geometry.coordinates, sourceEpsg) };
}

// reprojectCoords/reprojectGeometry의 역방향(4326 -> targetEpsg). 노선 내보내기
// (SHP/DBF zip 다운로드)에서, DB엔 항상 4326으로 저장된 geom을 원본 납품
// 좌표계로 되돌리는 데 쓴다.
function reprojectCoordsFromWgs84(coords, targetEpsg) {
    if (typeof coords[0] === 'number') {
        const [x, y] = proj4('EPSG:4326', targetEpsg, [coords[0], coords[1]]);
        return [x, y];
    }
    return coords.map((c) => reprojectCoordsFromWgs84(c, targetEpsg));
}

function reprojectFromWgs84(geometry, targetEpsg) {
    if (!geometry || targetEpsg === 'EPSG:4326') return geometry;
    return { type: geometry.type, coordinates: reprojectCoordsFromWgs84(geometry.coordinates, targetEpsg) };
}

// 노선 내보내기(SHP/DBF zip)가 쓰는 고정 타깃 좌표계 — KRRIS 제출 기준인 EPSG:5179(UTM-K).
// 예전엔 장성군 실제 납품 .prj(EPSG:3857)에 맞췄는데, 그 형식 자체가 KRRIS에서 C-1(좌표계)
// 결함으로 지적되는 것이라 우리 내보내기로 만든 파일을 제출하면 같은 결함이 나왔다(2026-10 변경).
// WKT는 ArcGIS가 5179에 쓰는 표준 ESRI .prj 표기.
const EXPORT_TARGET_EPSG = KRRIS_REQUIRED_EPSG;
const EXPORT_PRJ_WKT = 'PROJCS["Korea_2000_Korea_Unified_Coordinate_System",GEOGCS["GCS_Korea_2000",DATUM["D_Korea_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",1000000.0],PARAMETER["False_Northing",2000000.0],PARAMETER["Central_Meridian",127.5],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",38.0],UNIT["Meter",1.0]]';

module.exports = {
    detectCrs, reprojectGeometry, reprojectFromWgs84, CRS_REGISTRY,
    EXPORT_TARGET_EPSG, EXPORT_PRJ_WKT, KRRIS_REQUIRED_EPSG,
};
