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

for (const entry of CRS_REGISTRY) {
    proj4.defs(entry.epsg, entry.def);
}

// .prj WKT 텍스트 → { matched, epsg, label } 판별. GCS_WGS_1984는 Web_Mercator
// WKT 안에도 등장하므로(내부 GEOGCS 정의) Web_Mercator를 먼저 검사해야 한다
// (배열 순서가 우선순위 — 위에서부터 순서대로 시도).
function detectCrs(wktText) {
    for (const entry of CRS_REGISTRY) {
        if (entry.test.test(wktText)) {
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

// 노선 내보내기가 쓰는 고정 타깃 좌표계 — 장성군 실제 납품 .prj를 직접 읽어
// 확인한 값(문서상 "UTM-K"라 적혀 있어도 실제 .prj는 EPSG:3857이었다, 위
// 클래스 코멘트 참고). WKT는 그 실제 .prj 파일 내용을 그대로 재사용한다.
const EXPORT_TARGET_EPSG = 'EPSG:3857';
const EXPORT_PRJ_WKT = 'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]';

module.exports = {
    detectCrs, reprojectGeometry, reprojectFromWgs84, CRS_REGISTRY,
    EXPORT_TARGET_EPSG, EXPORT_PRJ_WKT,
};
