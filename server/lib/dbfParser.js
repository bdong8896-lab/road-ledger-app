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
        // 필드명도 한글이 올 수 있다(예: "사진", "일련번호") — 값과 같은 EUC-KR로 읽는다.
        // 영문/숫자 이름은 어느 인코딩으로 읽어도 같다.
        let nameEnd = pos;
        while (nameEnd < pos + 11 && buf[nameEnd] !== 0) nameEnd++;
        const name = iconv.decode(buf.slice(pos, nameEnd), 'euc-kr');
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

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
// UTF-8로 온전히 읽히고 그 안에 한글(또는 한자)이 있으면 "UTF-8로 저장된 한글"로 본다. EUC-KR 글자 한두 개가 우연히 UTF-8 규칙에
// 맞는 경우(라틴 기호로 읽힘)는 한글이 나오지 않으므로 여기서 걸러진다.
function isValidUtf8(raw) {
    try { return /[가-힣ㄱ-ㆎ一-鿿]/.test(utf8Strict.decode(raw)); } catch (e) { return false; }
}
function hasHighByte(raw) {
    for (let i = 0; i < raw.length; i++) if (raw[i] >= 0x80) return true;
    return false;
}

// 문자(C) 필드의 인코딩 점검용 집계 — 한글이 EUC-KR이 아닌 방식(UTF-8 등)으로 저장됐거나, 저장 중 글자가 깨졌는지 본다.
//   utf8Like : 한글(비ASCII) 값 중 UTF-8로 읽어도 온전한 값 — EUC-KR 한글은 UTF-8로는 거의 항상 깨지므로, 이 값이 많으면 UTF-8로 저장된 파일이다.
//   invalid  : EUC-KR로 읽을 수 없는 바이트가 섞인 값(디코딩하면 � 가 나온다)
//   question : 글자가 '?'로 바뀐 것으로 보이는 값('??' 이상 연속) — 내보내기 때 코드페이지가 맞지 않아 글자가 사라진 경우
const ENCODING_SAMPLE_LIMIT = 5;
function newEncodingStats() {
    return { nonAscii: 0, utf8Like: 0, invalid: 0, question: 0, samples: [] };
}

// encoding: 문자(C) 필드를 디코딩할 인코딩(기본 euc-kr). buf: 파일 전체 Buffer.
// 반환: { fields, records, encodingStats, languageDriver } — languageDriver는 DBF 머리의 언어 드라이버 바이트(참고용).
function parseDbf(buf, encoding = 'euc-kr') {
    const numRecords = buf.readUInt32LE(4);
    const headerLen = buf.readUInt16LE(8);
    const recordLen = buf.readUInt16LE(10);
    const { fields } = readFieldDescriptors(buf, 32);
    const encodingStats = newEncodingStats();

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
                const text = iconv.decode(raw, encoding).trim();
                row[field.name] = text;
                if (hasHighByte(raw)) {
                    encodingStats.nonAscii++;
                    // UTF-8로 온전히 읽히는지를 먼저 본다 — UTF-8 한글을 EUC-KR로 읽으면 � 가 섞여 나오므로 순서가 바뀌면 "깨짐"으로 오판한다.
                    const bad = isValidUtf8(raw) ? 'utf8Like' : (text.includes('�') ? 'invalid' : null);
                    if (bad) {
                        encodingStats[bad]++;
                        if (encodingStats.samples.length < ENCODING_SAMPLE_LIMIT) encodingStats.samples.push({ row: records.length + 1, field: field.name, value: text });
                    }
                } else if (text.includes('??')) {
                    encodingStats.question++;
                    if (encodingStats.samples.length < ENCODING_SAMPLE_LIMIT) encodingStats.samples.push({ row: records.length + 1, field: field.name, value: text });
                }
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
    return { fields, records, encodingStats, languageDriver: buf[29] };
}

module.exports = { parseDbf };
