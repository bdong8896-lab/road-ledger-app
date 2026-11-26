# 코드표 대조(V-1)용 "레이어·칸별 코드 목록"(server/lib/govColumnCodes.js)을 만든다.
#
#   python server/db/build-gov-column-codes.py <테이블정의서_v2.3.xlsx> <공통입력코드정의서_v2.6.xlsx>
#
# 왜 필요한가: 코드정의서의 코드는 같은 칸 이름(예: TYPE)이라도 레이어마다 다른 코드 목록을 쓴다
#   (가로수 TYPE = 36xx, 신호등 TYPE = 41xx ...). 칸 이름만으로 합쳐 둔 lib/govCodebook.js 로 대조하면
#   다른 레이어의 코드가 들어가도 통과하고, 코드가 아닌 칸(제설시설 구분 등)은 오류로 잡는다.
#   테이블정의서는 칸마다 "코드설계서 NN 참조"라고 어느 코드 목록을 쓰는지 적어 두므로,
#   그 번호의 코드 목록(코드정의서 "NN. 제목" 섹션의 코드/코드내역 표)을 칸에 직접 연결한다.
# 번호 01, 02, 01-1, 02-1 은 코드 목록이 아니라 ID 형식(관리번호, 구조물코드 등)이라 연결하지 않는다.
import json
import re
import sys
import warnings

import openpyxl

warnings.filterwarnings('ignore')
if len(sys.argv) < 3:
    sys.exit(__doc__)
table_xlsx, code_xlsx = sys.argv[1], sys.argv[2]

ID_FORMAT_REFS = {'01', '02', '01-1', '02-1'}

# ---- 코드정의서: 섹션 번호 -> 코드 목록 ----
wb = openpyxl.load_workbook(code_xlsx, data_only=True)
sections = {}
for ws in wb.worksheets:
    if ws.title[:2] not in ('02', '03', '04', '05', '06', '07', '08'):
        continue
    rows = list(ws.iter_rows(values_only=False))
    cur = None
    r = 0
    while r < len(rows):
        row = rows[r]
        b = row[1].value if len(row) > 1 else None
        if isinstance(b, str):
            m = re.match(r'^\s*(\d+(?:-\d+)?)(?:\.\s*|\s+)(\D.*)', b)
            if m:
                cur = m.group(1)
                sections.setdefault(cur, {'title': m.group(2).strip(), 'codes': []})
        c = row[2].value if len(row) > 2 else None
        if c == '코드명칭' and cur:
            # 코드 표는 "코드 | 코드내역" 한 쌍이 기본이고, 03 도로의종류처럼 옆에 한 쌍이 더 붙는 것도 있다(신규추가 코드).
            # 머리 줄("코드" 칸)에서 쌍의 열 위치를 찾는다.
            code_cols = []
            gappy = False
            rr = r + 1
            while rr < len(rows) and rr <= r + 4:
                hdr = [x.value for x in rows[rr]]
                if hdr[2:3] == ['코드']:
                    code_cols = [j for j in range(len(hdr) - 1) if hdr[j] == '코드' and hdr[j + 1] == '코드내역']
                    if not code_cols:
                        code_cols = [2]  # 66 충격흡수시설 등급처럼 코드 옆에 다른 설명 열이 붙은 표 — 코드는 C열뿐이고 사이사이 빈 줄이 있다
                        gappy = True
                    break
                rr += 1
            rr += 1
            while code_cols and rr < len(rows):
                vals = [rows[rr][j].value for j in code_cols]
                if rows[rr][2].value == '코드명칭' or (gappy and rows[rr][1].value is not None):
                    break  # 다음 표/다음 섹션
                if all(v is None for v in vals):
                    if gappy:
                        rr += 1
                        continue
                    break
                for v in vals:
                    if v is not None:
                        sections[cur]['codes'].append(str(v).strip())
                rr += 1
            r = rr - 1
        r += 1

# ---- 테이블정의서: 레이어코드 -> 칸 -> 참조 번호 ----
wb = openpyxl.load_workbook(table_xlsx, data_only=True)
columns = {}   # 레이어코드 -> { 칸이름(대문자) -> 참조 번호 목록 }
for ws in wb.worksheets[4:]:
    layer = None
    for row in ws.iter_rows(values_only=True):
        c = [x for x in row if x is not None]
        txt = [str(x) for x in c]
        if '레이어 코드' in txt:
            layer = txt[txt.index('레이어 코드') + 1].strip()
        if layer and len(c) >= 4 and isinstance(c[0], int) and isinstance(c[1], str) and isinstance(c[3], str):
            note = ' '.join(str(x) for x in c[4:])
            refs = [x for x in re.findall(r'코드설계서\s*([\d\-]+)', note) if x not in ID_FORMAT_REFS]
            if refs:
                columns.setdefault(layer, {})[c[1].upper()] = refs

# ---- 같은 목록은 한 번만 담는다 ----
sets, set_ids, col_map, problems = {}, {}, {}, []
for layer, cols in columns.items():
    for col, refs in cols.items():
        codes = []
        for ref in refs:
            if ref not in sections or not sections[ref]['codes']:
                problems.append(f'{layer}.{col}: 코드설계서 {ref} 섹션을 찾지 못함')
                continue
            codes += [x for x in sections[ref]['codes'] if x not in codes]
        if not codes:
            continue
        key = json.dumps(codes, ensure_ascii=False)
        if key not in set_ids:
            set_ids[key] = 's%d' % (len(set_ids) + 1)
            sets[set_ids[key]] = codes
        col_map.setdefault(layer, {})[col] = set_ids[key]

js = '''// 레이어·칸별 코드 목록 — 테이블정의서(v2.3)가 칸마다 적어 둔 "코드설계서 NN 참조"를 따라
// 코드정의서(v2.6)의 해당 코드 목록을 칸에 직접 연결한 것이다. server/db/build-gov-column-codes.py 로 만든다(직접 고치지 말 것).
// 같은 칸 이름(예: TYPE)이라도 레이어마다 목록이 다르므로(가로수 36xx, 신호등 41xx ...) 코드표 대조(V-1)는 이 목록을 우선 쓴다.
// SETS: 코드 목록(중복 제거) / COLUMNS: 레이어코드 -> 칸이름(대문자) -> 목록 번호
const SETS = %s;
const COLUMNS = %s;

const cache = new Map();
// 이 레이어의 이 칸이 쓰는 코드 목록(Set). 정의서에 코드 칸으로 적혀 있지 않으면 null.
function columnCodeSet(layerCode, column) {
    const id = (COLUMNS[layerCode] || {})[String(column).toUpperCase()];
    if (!id) return null;
    if (!cache.has(id)) cache.set(id, new Set(SETS[id]));
    return cache.get(id);
}

module.exports = { columnCodeSet, SETS, COLUMNS };
''' % (json.dumps(sets, ensure_ascii=False, separators=(',', ':')), json.dumps(col_map, ensure_ascii=False, separators=(',', ':')))

dest = sys.argv[3] if len(sys.argv) > 3 else 'server/lib/govColumnCodes.js'
with open(dest, 'w', encoding='utf-8', newline='\n') as f:
    f.write(js)
print('저장:', dest, '- 코드 목록', len(sets), '개, 칸', sum(len(v) for v in col_map.values()), '개')
for p in problems:
    print('주의:', p)
