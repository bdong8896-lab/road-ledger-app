// ESRI Shapefile(.shp) 바이너리 파서. Point/PolyLine/Polygon과 그 Z버전
// (11/13/15)을 지원한다. Z값은 읽어서 건너뛰기만 하고 저장하지 않는다(이
// 앱은 지금까지 2D 지오메트리만 다뤄왔음). 좌표계 변환은 하지 않는다 —
// crsRegistry.js가 별도로 담당(단일 책임 분리, 원좌표계 그대로 반환).
const SUPPORTED_SHAPE_TYPES = new Set([0, 1, 3, 5, 11, 13, 15]);

function readPoints(buf, offset, numPoints) {
    const points = [];
    let pos = offset;
    for (let i = 0; i < numPoints; i++) {
        points.push([buf.readDoubleLE(pos), buf.readDoubleLE(pos + 8)]);
        pos += 16;
    }
    return { points, nextOffset: pos };
}

// 부호 있는 면적으로 링 방향 판별: 시계방향(< 0, ESRI 기준 외곽선)이면 true.
function isClockwise(ring) {
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        sum += (x2 - x1) * (y2 + y1);
    }
    return sum > 0; // 이 식에서는 양수가 시계방향(화면 좌표계 기준)
}

// PolyLine/Polygon 공용: box + numParts + numPoints + parts[] + points[]
// (+ PolygonZ/PolyLineZ면 Z range/array가 뒤따르지만 건너뛴다).
function readPartsAndPoints(buf, offset, hasZ) {
    let pos = offset + 32; // bounding box(4 doubles) 건너뜀
    const numParts = buf.readInt32LE(pos); pos += 4;
    const numPoints = buf.readInt32LE(pos); pos += 4;
    const parts = [];
    for (let i = 0; i < numParts; i++) { parts.push(buf.readInt32LE(pos)); pos += 4; }
    const { points, nextOffset } = readPoints(buf, pos, numPoints);
    pos = nextOffset;
    if (hasZ) {
        pos += 16; // Z range(zmin,zmax)
        pos += 8 * numPoints; // Z array
    }
    const rings = parts.map((start, i) => {
        const end = i + 1 < parts.length ? parts[i + 1] : numPoints;
        return points.slice(start, end);
    });
    return rings;
}

function partsToGeometry(rings, closedRings) {
    if (rings.length === 1) {
        return closedRings
            ? { type: 'Polygon', coordinates: [rings[0]] }
            : { type: 'LineString', coordinates: rings[0] };
    }
    if (!closedRings) {
        return { type: 'MultiLineString', coordinates: rings };
    }
    // Polygon: 시계방향(외곽선)마다 새 폴리곤을 시작하고, 반시계방향(홀)은
    // 직전 폴리곤에 붙인다.
    const polygons = [];
    for (const ring of rings) {
        if (isClockwise(ring) || polygons.length === 0) {
            polygons.push([ring]);
        } else {
            polygons[polygons.length - 1].push(ring);
        }
    }
    return polygons.length === 1
        ? { type: 'Polygon', coordinates: polygons[0] }
        : { type: 'MultiPolygon', coordinates: polygons };
}

// buf: .shp 파일 전체 Buffer. 반환: GeoJSON geometry 배열(레코드 순서 그대로,
// DBF 레코드와 인덱스로 1:1 매칭된다 — SHP/DBF는 항상 같은 순서로 저장됨).
function parseShp(buf) {
    const fileShapeType = buf.readInt32LE(32);
    if (!SUPPORTED_SHAPE_TYPES.has(fileShapeType)) {
        throw new Error(`지원하지 않는 SHP 지오메트리 타입입니다: shapeType=${fileShapeType}`);
    }

    const geometries = [];
    let pos = 100; // 헤더 100바이트
    while (pos < buf.length) {
        // 레코드 헤더: 레코드번호(4, BE), 콘텐츠 길이(4, BE, 16비트 워드 단위)
        const contentWords = buf.readInt32BE(pos + 4);
        const contentLen = contentWords * 2; // bytes
        const contentStart = pos + 8;
        const shapeType = buf.readInt32LE(contentStart);
        const dataStart = contentStart + 4;

        let geometry = null;
        if (shapeType === 0) {
            geometry = null; // Null shape
        } else if (shapeType === 1 || shapeType === 11) {
            const x = buf.readDoubleLE(dataStart);
            const y = buf.readDoubleLE(dataStart + 8);
            geometry = { type: 'Point', coordinates: [x, y] };
        } else if (shapeType === 3 || shapeType === 13) {
            const rings = readPartsAndPoints(buf, dataStart, shapeType === 13);
            geometry = partsToGeometry(rings, false);
        } else if (shapeType === 5 || shapeType === 15) {
            const rings = readPartsAndPoints(buf, dataStart, shapeType === 15);
            geometry = partsToGeometry(rings, true);
        } else {
            throw new Error(`지원하지 않는 SHP 레코드 지오메트리 타입입니다: shapeType=${shapeType}`);
        }

        geometries.push(geometry);
        pos = contentStart + contentLen;
    }
    return geometries;
}

module.exports = { parseShp };
