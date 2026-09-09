// gov_facility_schema.sql의 컬럼 정의 줄 끝에 달린 "-- 한글 설명" 주석을
// 파싱해서 {table: {column: 한글라벨}} 맵을 만든다. 49개 시설물 테이블의
// 컬럼마다 한글 라벨을 따로 유지보수하지 않기 위해, 이미 있는 스키마 파일의
// 주석을 그대로 재사용한다(스키마 정의서 자체가 원본이므로 이중 관리 없음).
const fs = require('fs');
const path = require('path');

let cache = null;

function parse() {
    const sqlPath = path.join(__dirname, '..', 'db', 'gov_facility_schema.sql');
    const text = fs.readFileSync(sqlPath, 'utf8');
    const result = {};
    let currentTable = null;
    for (const line of text.split('\n')) {
        const tableMatch = line.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
        if (tableMatch) {
            currentTable = tableMatch[1];
            result[currentTable] = {};
            continue;
        }
        if (!currentTable) continue;
        if (/^\s*\)\s*;\s*$/.test(line)) {
            currentTable = null;
            continue;
        }
        const colMatch = line.match(/^\s*(\w+)\s+\S.*?--\s*(.+?)\s*$/);
        if (colMatch) {
            result[currentTable][colMatch[1].toLowerCase()] = colMatch[2];
        }
    }
    return result;
}

function getTableLabels(table) {
    if (!cache) cache = parse();
    return cache[table] || {};
}

module.exports = { getTableLabels };
