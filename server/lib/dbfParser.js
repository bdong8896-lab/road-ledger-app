// dBASE III+ (.dbf) 바이너리 파서. 국토부 SHP/DBF 납품 표준이 EUC-KR
// 인코딩(.cpg)으로 오므로, 문자(C) 타입 필드만 iconv-lite로 EUC-KR→UTF-8
// 변환한다. 삭제 플래그(0x2A)가 찍힌 레코드는 건너뛴다(dBASE 자체의
// soft-delete 마커 — 납품 폴더 구조의 LAYER/삭제 개념과는 별개).
const iconv = require('iconv-lite');

const SUPPORTED_FIELD_TYPES = new Set(['C', 'N', 'F', 'D', 'L']);

function readFieldDescriptors(buf, offset) {
    const fields = [];
    let pos = offset;
    while (buf[pos] !== 0x0d) {
        const name = buf.slice(pos, pos + 11).toString('latin1').split('\0')[0];
        const type = buf.slice(pos + 11, pos + 12).toString('latin1');
        const length = buf.readUInt8(pos + 16);
        const decimals = buf.readUInt8(pos + 17);
        if (!SUPPORTED_FIELD_TYPES.has(type)) {
            throw new Error(`지원하지 않는 DBF 필드 타입입니다: ${name}(${type}) — Memo/General 필드는 처리할 수 없습니다.`);
        }
        fields.push({ name, type, length, decimals });
        pos += 32;
    }
    return { fields, headerEnd: pos + 1 };
}

// encoding: 문자(C) 필드를 디코딩할 인코딩(기본 euc-kr). buf: 파일 전체 Buffer.
function parseDbf(buf, encoding = 'euc-kr') {
    const numRecords = buf.readUInt32LE(4);
    const headerLen = buf.readUInt16LE(8);
    const recordLen = buf.readUInt16LE(10);
    const { fields } = readFieldDescriptors(buf, 32);

    const records = [];
    let pos = headerLen;
    for (let i = 0; i < numRecords; i++) {
        const recordBuf = buf.slice(pos, pos + recordLen);
        pos += recordLen;
        if (recordBuf.length < recordLen) break;
        const deleted = recordBuf[0] === 0x2a; // '*' = 삭제된 레코드
        if (deleted) continue;

        const row = {};
        let fieldOffset = 1;
        for (const field of fields) {
            const raw = recordBuf.slice(fieldOffset, fieldOffset + field.length);
            fieldOffset += field.length;
            if (field.type === 'C') {
                row[field.name] = iconv.decode(raw, encoding).trim();
            } else {
                const text = raw.toString('latin1').trim();
                if (field.type === 'N' || field.type === 'F') {
                    row[field.name] = text === '' ? null : Number(text);
                } else if (field.type === 'L') {
                    row[field.name] = /[YyTt]/.test(text) ? true : (/[NnFf]/.test(text) ? false : null);
                } else {
                    row[field.name] = text; // D(날짜)는 YYYYMMDD 문자열 그대로 둔다
                }
            }
        }
        records.push(row);
    }
    return { fields, records };
}

module.exports = { parseDbf };
