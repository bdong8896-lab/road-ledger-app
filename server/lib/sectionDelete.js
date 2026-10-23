// 구간(road_sections) 하나를 부속시설·첨부파일·도면·500m 조각까지 통째로 삭제한다.
// 데이터보기 트리의 구간 삭제(routes/sections.js)와 관리 콘솔의 노선 삭제
// (routes/adminSections.js)가 같이 쓴다. 호출한 쪽은 관리자 권한 확인을 이미 끝냈다고 본다.
const fs = require('fs');
const pool = require('../db');
const { GOV_LAYER_MAP } = require('./govLayerMap');
const { logAction } = require('./auditLog');

function outsideJurisdiction(userSigungu, rowSigungu) {
    return !!userSigungu && !!rowSigungu && userSigungu !== rowSigungu;
}

// 반환: { ok: true } 또는 { ok: false, status, error }
async function deleteSection(rdid, user) {
    const { rows } = await pool.query(
        'SELECT sigungu_code, road_rank_code, road_rank_name, route_no, route_name, sect FROM road_sections WHERE rdid = $1',
        [rdid]
    );
    const section = rows[0];
    if (!section) return { ok: false, status: 404, error: '구간을 찾을 수 없습니다.' };
    if (outsideJurisdiction(user.sigunguCode, section.sigungu_code)) {
        return { ok: false, status: 403, error: '관할 시군구 밖의 구간입니다.' };
    }

    const client = await pool.connect();
    const filesToUnlink = [];
    const deletedCounts = {};
    try {
        await client.query('BEGIN');

        const routeFileRows = await client.query(
            'SELECT stored_path, converted_path FROM route_files WHERE section_rdid = $1',
            [rdid]
        );
        // DWG 미리보기용 변환 DXF(converted_path)도 같이 지운다.
        routeFileRows.rows.forEach((r) => filesToUnlink.push(r.stored_path, ...(r.converted_path ? [r.converted_path] : [])));
        if (routeFileRows.rows.length) deletedCounts.route_files = routeFileRows.rows.length;
        await client.query('DELETE FROM route_files WHERE section_rdid = $1', [rdid]);

        for (const { table, pkColumn } of Object.values(GOV_LAYER_MAP)) {
            const hasRoadRank = table !== 'gov_road_bound';
            const where = hasRoadRank
                ? 'road_rank = $1 AND road_no = $2 AND sect = $3'
                : 'road_no = $1 AND sect = $2';
            const params = hasRoadRank
                ? [section.road_rank_code, section.route_no, section.sect]
                : [section.route_no, section.sect];

            let pkRows;
            try {
                // 컬럼이 없는 테이블에서 쿼리가 실패해도 트랜잭션이 깨지지 않게 SAVEPOINT로 감싼다.
                await client.query('SAVEPOINT layer_probe');
                pkRows = await client.query(`SELECT ${pkColumn} FROM ${table} WHERE ${where}`, params);
                await client.query('RELEASE SAVEPOINT layer_probe');
            } catch (e) {
                await client.query('ROLLBACK TO SAVEPOINT layer_probe');
                continue; // 테이블에 해당 컬럼이 없는 등 예외 케이스는 건너뜀
            }
            const pks = pkRows.rows.map((r) => r[pkColumn]);
            if (pks.length) {
                deletedCounts[table] = pks.length;
                const attFileRows = await client.query(
                    'SELECT stored_path FROM gov_facility_files WHERE facility_table = $1 AND facility_rdid = ANY($2)',
                    [table, pks]
                );
                filesToUnlink.push(...attFileRows.rows.map((r) => r.stored_path));
                await client.query(
                    'DELETE FROM gov_facility_files WHERE facility_table = $1 AND facility_rdid = ANY($2)',
                    [table, pks]
                );
                await client.query(`DELETE FROM ${table} WHERE ${where}`, params);
            }
        }

        // 500m 조각(road_sectors)은 구간과 같은 (도로종류, 노선번호, 구간) 키를 쓴다.
        const sectorDel = await client.query(
            'DELETE FROM road_sectors WHERE road_rank_code = $1 AND road_no = $2 AND sect = $3',
            [section.road_rank_code, section.route_no, section.sect]
        );
        if (sectorDel.rowCount) deletedCounts.road_sectors = sectorDel.rowCount;

        await client.query('DELETE FROM road_sections WHERE rdid = $1', [rdid]);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[sections/delete]', e);
        return { ok: false, status: 500, error: '삭제 중 오류가 발생했습니다.' };
    } finally {
        client.release();
    }

    for (const p of filesToUnlink) if (p) fs.promises.unlink(p).catch(() => {});
    await logAction(null, {
        action: 'delete', targetTable: 'road_sections', targetId: rdid,
        summary: `구간 삭제: ${section.road_rank_name} ${section.route_no || ''} ${section.route_name || ''} ${section.sect || ''}구간 (부속시설 ${Object.values(deletedCounts).reduce((a, b) => a + b, 0)}건 함께 삭제)`.replace(/\s+/g, ' ').trim(),
        detail: { section, deletedCounts },
        sigunguCode: section.sigungu_code, user,
    });
    return { ok: true, deletedCounts };
}

module.exports = { deleteSection, outsideJurisdiction };
