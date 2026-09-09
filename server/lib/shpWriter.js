// ESRI Shapefile(.shp/.shx) 바이너리 작성기. shpParser.js가 읽는 포맷 그대로
// 거꾸로 쓴다. 이 앱은 2D Point/PolyLine/Polygon만 다룬다(Z변형 불필요).
const SHAPE_TYPE_BY_GEOJSON = {
    Point: 1,
    LineString: 3,
    MultiLineString: 3,
    Polygon: 5,
    MultiPolygon: 5,
};

// shpParser.js의 isClockwise()와 동일한 부호면적 공식(대칭 — 판별만 하고 안 뒤집음).
function isClockwise(ring) {
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        sum += (x2 - x1) * (y2 + y1);
    }
    return sum > 0;
}

// LineString/MultiLineString -> parts(선 배열의 배열)
function collectLineParts(geometry) {
    return geometry.type === 'MultiLineString' ? geometry.coordinates : [geometry.coordinates];
}

// Polygon/MultiPolygon -> ESRI 링 방향 규칙(외곽선=시계방향, 홀=반시계방향)을
// 강제한 parts. GeoJSON(RFC7946)은 반대 관례라 필요시 뒤집는다.
function collectPolygonRings(geometry) {
    const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
    const rings = [];
    for (const poly of polygons) {
        poly.forEach((ring, i) => {
            const wantClockwise = i === 0; // 첫 링 = 외곽선
            const cw = isClockwise(ring);
            rings.push(cw === wantClockwise ? ring : [...ring].reverse());
        });
    }
    return rings;
}

function buildPointContent(coord, shapeType) {
    const buf = Buffer.alloc(4 + 16);
    buf.writeInt32LE(shapeType, 0);
    buf.writeDoubleLE(coord[0], 4);
    buf.writeDoubleLE(coord[1], 12);
    return buf;
}

// parts: 링/선 배열의 배열(각각 [x,y] 좌표 배열). PolyLine/Polygon 공용.
function buildPartsContent(parts, shapeType) {
    const points = parts.flat();
    const numParts = parts.length;
    const numPoints = points.length;
    let offset = 0;
    const partOffsets = parts.map((part) => {
        const start = offset;
        offset += part.length;
        return start;
    });
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];

    const buf = Buffer.alloc(4 + 32 + 4 + 4 + 4 * numParts + 16 * numPoints);
    let pos = 0;
    buf.writeInt32LE(shapeType, pos); pos += 4;
    bbox.forEach((v) => { buf.writeDoubleLE(v, pos); pos += 8; });
    buf.writeInt32LE(numParts, pos); pos += 4;
    buf.writeInt32LE(numPoints, pos); pos += 4;
    partOffsets.forEach((o) => { buf.writeInt32LE(o, pos); pos += 4; });
    points.forEach(([x, y]) => { buf.writeDoubleLE(x, pos); pos += 8; buf.writeDoubleLE(y, pos); pos += 8; });
    return buf;
}

function collectAllPoints(geometry, out) {
    if (geometry.type === 'Point') { out.push(geometry.coordinates); return; }
    const walk = (coords) => {
        if (typeof coords[0] === 'number') { out.push(coords); return; }
        coords.forEach(walk);
    };
    walk(geometry.coordinates);
}

function buildFileHeader(shapeType, bbox, fileLengthWords) {
    const buf = Buffer.alloc(100);
    buf.writeInt32BE(9994, 0); // 파일 코드
    buf.writeInt32BE(fileLengthWords, 24);
    buf.writeInt32LE(1000, 28); // 버전
    buf.writeInt32LE(shapeType, 32);
    buf.writeDoubleLE(bbox[0], 36); // xmin
    buf.writeDoubleLE(bbox[1], 44); // ymin
    buf.writeDoubleLE(bbox[2], 52); // xmax
    buf.writeDoubleLE(bbox[3], 60); // ymax
    // 68-99: Zmin/Zmax/Mmin/Mmax = 0(2D만 다룸, 이미 alloc으로 0)
    return buf;
}

// geometries: GeoJSON geometry 객체 배열(레코드 순서 그대로, null 허용 =
// Null Shape). 반환: { shpBuffer, shxBuffer }.
function writeShp(geometries) {
    let shapeType = 1;
    for (const g of geometries) {
        if (g) { shapeType = SHAPE_TYPE_BY_GEOJSON[g.type] || 1; break; }
    }

    const contents = geometries.map((g) => {
        if (!g) return Buffer.alloc(4); // Null Shape(shapeType=0, 이미 0으로 채워짐)
        if (shapeType === 1) return buildPointContent(g.coordinates, shapeType);
        if (shapeType === 3) return buildPartsContent(collectLineParts(g), shapeType);
        return buildPartsContent(collectPolygonRings(g), shapeType);
    });

    const shpParts = [];
    const shxEntries = [];
    let wordOffset = 50; // .shp 헤더 100바이트 = 50워드
    let bodyBytes = 0;
    contents.forEach((content, i) => {
        const contentWords = content.length / 2;
        const recHeader = Buffer.alloc(8);
        recHeader.writeInt32BE(i + 1, 0);
        recHeader.writeInt32BE(contentWords, 4);
        shpParts.push(recHeader, content);
        shxEntries.push({ offsetWords: wordOffset, contentWords });
        wordOffset += 4 + contentWords; // 레코드헤더(4워드) + 콘텐츠
        bodyBytes += 8 + content.length;
    });

    const allPoints = [];
    geometries.forEach((g) => { if (g) collectAllPoints(g, allPoints); });
    const bbox = allPoints.length
        ? [
            Math.min(...allPoints.map((p) => p[0])), Math.min(...allPoints.map((p) => p[1])),
            Math.max(...allPoints.map((p) => p[0])), Math.max(...allPoints.map((p) => p[1])),
        ]
        : [0, 0, 0, 0];

    const shpHeader = buildFileHeader(shapeType, bbox, 50 + bodyBytes / 2);
    const shxBody = Buffer.concat(shxEntries.map((e) => {
        const b = Buffer.alloc(8);
        b.writeInt32BE(e.offsetWords, 0);
        b.writeInt32BE(e.contentWords, 4);
        return b;
    }));
    const shxHeader = buildFileHeader(shapeType, bbox, 50 + shxEntries.length * 4);

    return {
        shpBuffer: Buffer.concat([shpHeader, ...shpParts]),
        shxBuffer: Buffer.concat([shxHeader, shxBody]),
    };
}

module.exports = { writeShp };
