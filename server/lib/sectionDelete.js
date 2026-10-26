// 구간(road_sections) 하나를 부속시설·첨부파일·도면·500m 조각까지 통째로 삭제한다.
// 지우는 것은 바로 사라지지 않고 휴지통(lib/sectionTrash.js)에 보관돼, 보관 기간 안에는 관리 콘솔에서 복원할 수 있다.
// 데이터보기 트리의 구간 삭제(routes/sections.js)와 관리 콘솔의 노선 삭제
// (routes/adminSections.js)가 같이 쓴다. 호출한 쪽은 관리자 권한 확인을 이미 끝냈다고 본다.
const pool = require('../db');
const { GOV_LAYER_MAP } = require('./govLayerMap');
const { logAction } = require('./auditLog');
const sectionTrash = require('./sectionTrash');

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

    if (!(await sectionTrash.isReady())) {
        return { ok: false, status: 500, error: '삭제 휴지통 테이블이 없어 삭제할 수 없습니다. 서버에 db/schema.sql을 적용한 뒤 다시 시도하세요.' };
    }

    const client = await pool.connect();
    const moves = [];
    let trashId = null;
    const deletedCounts = {};
    try {
        await client.query('BEGIN');
        trashId = await sectionTrash.createEntry(client, section, rdid, user, section.sigungu_code);

        const routeFileRows = await client.query(
            'SELECT stored_path, converted_path FROM route_files WHERE section_rdid = $1',
            [rdid]
        );
        // DWG 미리보기용 변환 DXF(converted_path)도 같이 보관한다.
        for (const r of routeFileRows.rows) {
            for (const p of [r.stored_path, r.converted_path]) {
                const m = await sectionTrash.planFile(client, trashId, p);
                if (m) moves.push(m);
            }
        }
        if (routeFileRows.rows.length) deletedCounts.route_files = routeFileRows.rows.length;
        await sectionTrash.saveRows(client, trashId, 'route_files', 'id', 'section_rdid = $1', [rdid]);
        await client.query('DELETE FROM route_files WHERE section_rdid = $1', [rdid]);

        for (const { table, pkColumn } of Object.values(GOV_LAYER_MAP)) {
            const hasRoadRank = table !== 'gov_road_bound';
            let where = hasRoadRank
                ? 'road_rank = $1 AND road_no = $2 AND sect = $3'
                : 'road_no = $1 AND sect = $2';
            const params = hasRoadRank
                ? [section.road_rank_code, section.route_no, section.sect]
                : [section.route_no, section.sect];
            // 같은 업무키가 다른 시군구에도 있을 수 있어(예: 장성·화성 군도 8호선 1구간) 이 구간의 시군구 것만 지운다.
            params.push(section.sigungu_code || null);
            where += ` AND (sigungu_code IS NOT DISTINCT FROM $${params.length} OR sigungu_code IS NULL)`;

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
                for (const r of attFileRows.rows) {
                    const m = await sectionTrash.planFile(client, trashId, r.stored_path);
                    if (m) moves.push(m);
                }
                await sectionTrash.saveRows(client, trashId, table, pkColumn, where, params);
                await sectionTrash.saveRows(client, trashId, 'gov_facility_files', 'id', `facility_table = '${table}' AND facility_rdid = ANY($1)`, [pks]);
                await client.query(
                    'DELETE FROM gov_facility_files WHERE facility_table = $1 AND facility_rdid = ANY($2)',
                    [table, pks]
                );
                await client.query(`DELETE FROM ${table} WHERE ${where}`, params);
            }
        }

        // 500m 조각(road_sectors)은 구간과 같은 (도로종류, 노선번호, 구간) 키를 쓴다.
        const sectorWhere = 'road_rank_code = $1 AND road_no = $2 AND sect = $3 AND (sigungu_code IS NOT DISTINCT FROM $4 OR sigungu_code IS NULL)';
        const sectorParams = [section.road_rank_code, section.route_no, section.sect, section.sigungu_code || null];
        await sectionTrash.saveRows(client, trashId, 'road_sectors', 'id', sectorWhere, sectorParams);
        const sectorDel = await client.query(`DELETE FROM road_sectors WHERE ${sectorWhere}`, sectorParams);
        if (sectorDel.rowCount) deletedCounts.road_sectors = sectorDel.rowCount;

        await sectionTrash.saveRows(client, trashId, 'road_sections', 'rdid', 'rdid = $1', [rdid]);
        await client.query('DELETE FROM road_sections WHERE rdid = $1', [rdid]);
        await client.query('UPDATE section_trash SET counts = $2 WHERE id = $1', [trashId, JSON.stringify(deletedCounts)]);
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (e2) { /* 무시 */ }
        console.error('[sections/delete]', e);
        return { ok: false, status: 500, error: '삭제 중 오류가 발생했습니다.' };
    } finally {
        client.release();
    }

    await sectionTrash.moveToTrash(trashId, moves);
    await logAction(null, {
        action: 'delete', targetTable: 'road_sections', targetId: rdid,
        summary: `구간 삭제(휴지통 보관 ${sectionTrash.TRASH_DAYS}일): ${section.road_rank_name} ${section.route_no || ''} ${section.route_name || ''} ${section.sect || ''}구간 (부속시설 ${Object.values(deletedCounts).reduce((a, b) => a + b, 0)}건 함께 삭제)`.replace(/\s+/g, ' ').trim(),
        detail: { section, deletedCounts, trashId },
        sigunguCode: section.sigungu_code, user,
    });
    return { ok: true, deletedCounts };
}

module.exports = { deleteSection, outsideJurisdiction };
