// [기존 부분] connectome k6 영수증 v0.2 (experiments/k6/receipt/jcs.mjs) 에서 복사 — import 아님(분리 가능성 유지).
// RFC 8785 (JCS) 직렬화 — 의존성 0. 영수증에 쓰는 값(문자열·유한 수·불리언·null·배열·객체)만 지원.
// 숫자는 ECMAScript Number->String(= JSON.stringify)이 JCS 규정과 같고, 키 정렬은 UTF-16 코드 유닛 순(기본 sort)이다.
export function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  throw new Error(`JCS: unsupported type ${typeof value}`);
}
