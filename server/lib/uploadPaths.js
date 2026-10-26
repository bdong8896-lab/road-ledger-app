// 업로드 폴더 구조 — 서버에 쌓이는 파일은 시군구별로 나눠 둔다(시군구별 용량 확인·백업·정리가 쉽고, 다른 시군구 파일과 섞이지 않는다).
//   uploads/gov-facility-files/<시군구>/<시설물 테이블>/   시설물 사진·보고서
//   uploads/routes/<시군구>/<도로종류__노선번호__노선명>/     노선·구간 도면
//   uploads/road-issues/<시군구>/<항목 번호>/               사용자도로관리 첨부
//   uploads/parcels/<시군구>/<PNU>/                         필지 첨부(PNU 앞 5자리가 시군구)
//   uploads/_deleted-facility-files/<시군구>/               지운 시설물 파일 30일 보관
// 시군구를 알 수 없으면 'unassigned'. 파일의 실제 위치는 DB(stored_path)가 기억하므로 폴더 배치를 바꿔도 기존 파일은 그대로 열린다
// (기존 파일은 db/migrate-upload-folders.js로 옮긴다).
// 시군구에 속하지 않는 임시·캐시 폴더(…-tmp, _thumbs, _section-trash, _import-trash, bulk-import*)는 일부러 나누지 않았다.
const path = require('path');
const config = require('../config');

function sigunguFolder(code) {
    const c = String(code || '').trim();
    return /^\d{5}$/.test(c) ? c : 'unassigned';
}

// 노선 폴더 이름. 앞쪽 점은 제거한다 — 노선명이 ".."이면 업로드 폴더 한 단계 위로 올라가 저장되는 경로 조작을 막는다.
function routeDirName(roadGrade, routeNo, routeName) {
    const safe = (s) => String(s || '').replace(/[/\\:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
    return [safe(roadGrade), safe(routeNo), safe(routeName)].filter(Boolean).join('__') || 'unspecified';
}

const routeFilesDir = (sigunguCode, roadGrade, routeNo, routeName) =>
    path.join(config.uploadDir, 'routes', sigunguFolder(sigunguCode), routeDirName(roadGrade, routeNo, routeName));
const roadIssueDir = (sigunguCode, issueId) => path.join(config.uploadDir, 'road-issues', sigunguFolder(sigunguCode), String(issueId));
const parcelDir = (pnu) => path.join(config.uploadDir, 'parcels', sigunguFolder(String(pnu).slice(0, 5)), String(pnu));
const facilityFilesDir = (sigunguCode, table) => path.join(config.uploadDir, 'gov-facility-files', sigunguFolder(sigunguCode), table);
const deletedFacilityDir = (sigunguCode) => path.join(config.uploadDir, '_deleted-facility-files', sigunguFolder(sigunguCode));

// 기존(시군구로 안 나뉜) 경로를 새 구조로 바꾼 경로를 돌려준다. 바꿀 필요가 없거나 업로드 폴더 밖이면 null.
// 마이그레이션(db/migrate-upload-folders.js)과, 옮긴 뒤에도 남아 있는 이력 기록(되돌리기·휴지통)의 경로 갱신이 같이 쓴다.
function relocate(storedPath, sigunguCode, kind) {
    if (!storedPath) return null;
    const rel = path.relative(config.uploadDir, storedPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const parts = rel.split(path.sep);
    const sg = sigunguFolder(sigunguCode);
    const root = (...p) => path.join(config.uploadDir, ...p);
    if (kind === 'route' && parts[0] === 'routes' && parts.length === 3) return root('routes', sg, parts[1], parts[2]);
    if (kind === 'issue' && parts[0] === 'road-issues' && parts.length === 3) return root('road-issues', sg, parts[1], parts[2]);
    if (kind === 'parcel' && parts.length === 2 && /^\d{19}$/.test(parts[0])) return root('parcels', parts[0].slice(0, 5), parts[0], parts[1]);
    if (kind === 'facility' && parts[0] === 'gov-facility-files' && parts.length === 4 && sg !== 'unassigned' && parts[1] !== sg) return root('gov-facility-files', sg, parts[2], parts[3]);
    return null;
}

module.exports = { sigunguFolder, routeDirName, routeFilesDir, roadIssueDir, parcelDir, facilityFilesDir, deletedFacilityDir, relocate };
