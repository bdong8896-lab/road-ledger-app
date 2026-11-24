// 레이어코드별로 정해진 도형 종류(점/선/면) — 국토교통부 「도로대장공간정보」 SHP 템플릿(shp템플릿_v2.3)의
// 49개 레이어 .shp 헤더에서 읽은 값을 그대로 옮겼다(템플릿이 곧 표준이므로 정의서 해석이 끼어들지 않는다).
// 납품 파일의 도형이 이 종류와 다르면(예: 선 레이어에 면이 들어 있음) 레이어를 잘못 내보냈거나 다른 레이어 파일일 가능성이 크다.
const GOV_LAYER_GEOM = {
    A0010000: 'Polygon', A0020000: 'Line', A0063321: 'Polygon', A0070000: 'Polygon', A0080000: 'Polygon',
    A0093351: 'Polygon', A0093352: 'Polygon', A0100000: 'Polygon', A0110020: 'Polygon', A9053327: 'Polygon',
    A9093353: 'Polygon', A9990001: 'Line', A9990002: 'Polygon', A9990003: 'Line', A9990004: 'Point',
    A9990005: 'Line', A9990006: 'Polygon', A9990007: 'Polygon', A9990008: 'Line', A9990009: 'Line',
    A9990010: 'Polygon', A9990011: 'Line', A9990012: 'Point', A9990013: 'Point', C0076117: 'Line',
    C0223367: 'Point', C0246120: 'Line', C0246341: 'Line', C0410000: 'Point', C0493376: 'Point',
    C0520000: 'Line', C0530000: 'Line', C0536114: 'Line', C9070001: 'Polygon', C9413426: 'Point',
    C9530001: 'Point', C9530002: 'Polygon', C9530003: 'Polygon', C9530004: 'Polygon', C9530005: 'Line',
    C9530006: 'Polygon', C9530007: 'Point', C9530008: 'Polygon', C9530009: 'Polygon', D0023372: 'Point',
    F9037221: 'Line', F9037222: 'Line', F9047224: 'Line', F9047226: 'Line',
};

const GEOM_KIND_LABEL = { Point: '점', Line: '선', Polygon: '면' };

// shpParser가 돌려주는 GeoJSON 도형 종류 → 점/선/면(Multi도 같은 종류로 본다)
function geomKindOf(geometry) {
    if (!geometry) return null;
    switch (geometry.type) {
        case 'Point': case 'MultiPoint': return 'Point';
        case 'LineString': case 'MultiLineString': return 'Line';
        case 'Polygon': case 'MultiPolygon': return 'Polygon';
        default: return null;
    }
}

module.exports = { GOV_LAYER_GEOM, GEOM_KIND_LABEL, geomKindOf };
