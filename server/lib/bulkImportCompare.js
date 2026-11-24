// 일괄등록 미리보기에서 "이번 납품"을 "서버에 이미 있는 데이터"와 견준다(서버 전용 — DB가 필요해서 별도 검수 프로그램에는 없다).
//   덮어쓰기 : 이번 납품의 ID가 서버에 이미 있음 → 등록하면 그 값으로 바뀐다(ON CONFLICT DO UPDATE)
//   새 ID    : 서버에 없는 ID → 새로 추가된다
//   기존에만 : 같은 노선·구간의 서버 데이터인데 이번 납품에는 없는 ID(삭제 파일에 있는 것은 제외) → 일부만 다시 납품했거나 빠뜨린 것일 수 있다
// 같은 구간에 이미 데이터가 있는데 ID가 하나도 겹치지 않으면, 다시 납품하면서 ID를 새로 매긴 경우라 등록 후 시설물이 두 배로 보인다.
const pool = require('../db');

const ONLY_WARN_MIN = 3;      // "기존에만 있음"을 경고하는 최소 건수
const ONLY_WARN_RATIO = 0.2;  // 그리고 서버 기존 건수 대비 비율

function pkOf(rec, pkColumn) {
    const v = rec.row[pkColumn];
    return v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim();
}

// 시군구를 정하는 순서: 사용자가 정해져 있으면 그것 → 겹친 기존 행의 시군구 → 구간에 시군구가 하나뿐이면 그것. 정할 수 없으면 null(비교 생략).
function chooseSigungu(given, overlapBuckets, routeBuckets) {
    if (given) return { code: given, known: true };
    if (overlapBuckets.length) {
        const top = [...overlapBuckets].sort((a, b) => b.n - a.n)[0];
        return { code: top.sigungu_code, known: true };
    }
    if (routeBuckets.length === 1) return { code: routeBuckets[0].sigungu_code, known: true };
    if (routeBuckets.length === 0) return { code: null, known: true }; // 서버에 이 구간 데이터가 아예 없음
    return { code: null, known: false };
}

async function compareWithServer(parsed, sigunguCode) {
    const secByCode = new Map(parsed.integrity.sections.map((s) => [s.deliveryCode, s]));
    // 납품 루트 -> 레이어 -> { pks, delPks }
    const roots = new Map();
    const slot = (root, layer) => {
        if (!roots.has(root)) roots.set(root, new Map());
        const m = roots.get(root);
        if (!m.has(layer.code)) m.set(layer.code, { layer, pks: new Set(), delPks: new Set(), newCount: 0 });
        return m.get(layer.code);
    };
    for (const layer of parsed.layers) {
        for (const rec of layer.newRecords) {
            const s = slot(rec.deliveryRoot, layer);
            s.newCount++;
            const pk = rec.skipNnNull ? null : pkOf(rec, layer.pkColumn); // 저장되지 않는 레코드는 견주지 않는다
            if (pk) s.pks.add(pk);
        }
        for (const rec of layer.deleteRecords) {
            const pk = pkOf(rec, layer.pkColumn);
            if (pk) slot(rec.deliveryRoot, layer).delPks.add(pk);
        }
    }
    // 루트 -> 관리번호(요약표와 같은 키)
    const codeOfRoot = new Map();
    for (const sec of parsed.integrity.sections) codeOfRoot.set(sec._root, sec.deliveryCode);

    const warnings = [];
    const sections = [];
    for (const [root, byLayer] of roots) {
        const deliveryCode = codeOfRoot.get(root) || '';
        const sec = secByCode.get(deliveryCode) || {};
        const out = [];
        for (const { layer, pks, delPks, newCount } of [...byLayer.values()].sort((a, b) => a.layer.code.localeCompare(b.layer.code))) {
            const table = layer.table;
            const pkCol = layer.pkColumn;
            const pkList = [...pks];
            let overlapBuckets = [];
            if (pkList.length) {
                const r = await pool.query(`SELECT sigungu_code, count(*)::int AS n FROM ${table} WHERE ${pkCol} = ANY($1::text[]) GROUP BY sigungu_code`, [pkList]);
                overlapBuckets = r.rows;
            }
            const overlap = overlapBuckets.reduce((s, b) => s + b.n, 0);

            let existing = null; let existingOnly = null; let sigunguKnown = true;
            if (layer.routeCols && sec.roadNo && sec.sect) {
                const rb = await pool.query(`SELECT sigungu_code, count(*)::int AS n FROM ${table} WHERE road_no = $1 AND sect = $2 GROUP BY sigungu_code`, [sec.roadNo, sec.sect]);
                const pick = chooseSigungu(sigunguCode, overlapBuckets, rb.rows);
                sigunguKnown = pick.known;
                if (pick.known) {
                    existing = (rb.rows.find((b) => b.sigungu_code === pick.code) || { n: 0 }).n;
                    if (existing > 0) {
                        const accounted = [...new Set([...pkList, ...delPks])];
                        const r2 = await pool.query(
                            `SELECT count(*)::int AS n FROM ${table} WHERE road_no = $1 AND sect = $2 AND sigungu_code IS NOT DISTINCT FROM $3 AND NOT (${pkCol} = ANY($4::text[]))`,
                            [sec.roadNo, sec.sect, pick.code, accounted]);
                        existingOnly = r2.rows[0].n;
                    } else existingOnly = 0;
                }
            }
            const row = { code: layer.code, koreanName: layer.koreanName, newCount, overwrite: overlap, added: Math.max(0, pkList.length - overlap), existing, existingOnly, sigunguKnown };
            out.push(row);

            const where = `납품 ${deliveryCode}의 ${layer.koreanName}(${layer.code})`;
            if (existing > 0 && overlap === 0 && pkList.length > 0) {
                warnings.push(`${where}: 서버의 같은 노선·구간에 이미 ${existing.toLocaleString()}건이 있는데 이번 납품 ${pkList.length.toLocaleString()}건의 ID가 하나도 겹치지 않습니다 — 그대로 등록하면 같은 시설물이 중복으로 쌓일 수 있습니다. 다시 납품한 데이터라면 ID가 이전과 같아야 덮어써집니다.`);
            } else if (overlap > 0 && existingOnly >= ONLY_WARN_MIN && existing > 0 && existingOnly / existing >= ONLY_WARN_RATIO) {
                warnings.push(`${where}: 서버에 있는 ${existing.toLocaleString()}건 중 ${existingOnly.toLocaleString()}건(${Math.round((existingOnly / existing) * 100)}%)이 이번 납품에 없습니다 — 일부만 다시 납품했거나 빠진 것이 아닌지 확인하세요(삭제 파일에 든 것은 제외했습니다).`);
            }
        }
        sections.push({
            deliveryCode, roadName: sec.roadName || '', roadNo: sec.roadNo || '', sect: sec.sect || '',
            layers: out,
            overwriteTotal: out.reduce((s, l) => s + l.overwrite, 0),
            addedTotal: out.reduce((s, l) => s + l.added, 0),
            existingOnlyTotal: out.reduce((s, l) => s + (l.existingOnly || 0), 0),
            isNewSection: out.length > 0 && out.every((l) => l.overwrite === 0 && !l.existing),
        });
    }
    sections.sort((a, b) => a.deliveryCode.localeCompare(b.deliveryCode));
    return { sections, warnings, sigunguGiven: !!sigunguCode };
}

module.exports = { compareWithServer };
