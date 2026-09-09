// dBASE III+ (.dbf) 바이너리 작성기. dbfParser.js를 읽는 그대로 거꾸로 쓴다 —
// 실제 납품 샘플 파일을 hex 덤프해서 확인한 바이트 레이아웃을 그대로 따른다
// (헤더 32바이트 + 필드기술자 32바이트×N + 종결자 0x0D + 고정폭 레코드).
// 문자(C) 필드는 EUC-KR로 인코딩한다(원본 납품 .cpg 인코딩과 동일하게 맞춤).
const iconv = require('iconv-lite');

// fields: [{ name(<=10자, 대문자 DBF 필드명), dbColumn(row 조회용 키), type('C'|'N'|'F'|'L'|'D'), length, decimals }]
// rows: [{ [dbColumn]: value, ... }] — pg 드라이버가 반환하는 그대로(소문자 컬럼명 키).
function writeDbf(fields, rows) {
    const recordLen = 1 + fields.reduce((sum, f) => sum + f.length, 0);
    const headerLen = 32 + 32 * fields.length + 1;

    const header = Buffer.alloc(32);
    header.writeUInt8(0x03, 0); // dBASE III+, no memo
    const now = new Date();
    header.writeUInt8(Math.max(0, now.getFullYear() - 1900), 1);
    header.writeUInt8(now.getMonth() + 1, 2);
    header.writeUInt8(now.getDate(), 3);
    header.writeUInt32LE(rows.length, 4);
    header.writeUInt16LE(headerLen, 8);
    header.writeUInt16LE(recordLen, 10);

    const fieldDescs = fields.map((f) => {
        const buf = Buffer.alloc(32);
        Buffer.from(f.name.slice(0, 10), 'latin1').copy(buf, 0);
        buf.write(f.type, 11, 1, 'latin1');
        buf.writeUInt8(f.length, 16);
        buf.writeUInt8(f.decimals || 0, 17);
        return buf;
    });
    const terminator = Buffer.from([0x0d]);

    const records = rows.map((row) => {
        const buf = Buffer.alloc(recordLen, 0x20); // 공백으로 미리 채움 = 우측패딩 기본 처리
        let offset = 1; // byte0 = 삭제 플래그(공백 = 삭제 안 됨), 이미 0x20으로 채워짐
        for (const f of fields) {
            writeFieldValue(buf, offset, f, row[f.dbColumn]);
            offset += f.length;
        }
        return buf;
    });

    return Buffer.concat([header, ...fieldDescs, terminator, ...records, Buffer.from([0x1a])]);
}

function writeFieldValue(buf, offset, field, raw) {
    if (field.type === 'C' || field.type === 'D') {
        if (raw == null) return; // 공백 유지
        const encoded = iconv.encode(String(raw), 'euc-kr');
        encoded.slice(0, field.length).copy(buf, offset); // 초과분은 자름, 나머지는 이미 공백
    } else if (field.type === 'N' || field.type === 'F') {
        if (raw == null || raw === '') return; // 공백 유지
        const num = Number(raw);
        if (!Number.isFinite(num)) return;
        const text = num.toFixed(field.decimals || 0);
        const fitted = text.length > field.length ? text.slice(0, field.length) : text.padStart(field.length, ' ');
        Buffer.from(fitted, 'latin1').copy(buf, offset);
    } else if (field.type === 'L') {
        const ch = raw === true ? 'T' : raw === false ? 'F' : '?';
        buf.write(ch, offset, 1, 'latin1');
    }
}

module.exports = { writeDbf };
