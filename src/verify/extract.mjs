// 검색 결과 텍스트에서 원화 가격 추출.
// 읽는 형태: "최저287,490원" · "299,000원" · "₩287,490" · "KRW 259,000" · "259,000₩" · "36만 9천 원" · "36만 9,900원" · "29만9천900원" ·
//   "28만7490원" · "25.9만원" · "1,234만원" · "35만 원대"/"290,000원대"(=근사)
// anchored = 바로 앞에 '최저(가)' 가 붙은 값. 왼쪽 경계: 숫자·콤마·점 바로 뒤에서는 시작하지 않는다("12345,678원" 오독 방지).
//
// price-v4 원칙(리뷰 43b5e7b H1·불변식 6): 추출·관측은 어떤 값도 버리지 않는다. 문맥 표시(marks)만 붙이고,
// 그 값을 확인 근거로 쓸지·차단 근거로 쓸지는 판정부(price.mjs classify) 한 곳이 정한다.
const NUM = String.raw`\d{1,3}(?:,\d{3})+|\d+`;
const RE = new RegExp(
  String.raw`(?<anchor>최저\s*가?\s*[:：]?\s*)?(?<![\d,.])(?:` +
    String.raw`(?:₩|KRW)\s*(?<won>${NUM})` +
    String.raw`|(?<mandec>\d+\.\d+)\s*만\s*원(?<dae0>\s*대)?` +
    String.raw`|(?<man>${NUM})\s*만\s*(?:(?<cheon>\d)\s*천\s*)?(?<rest>\d{1,3}(?:,\d{3})?|\d{4})?\s*원(?<dae1>\s*대)?` +
    String.raw`|(?<num>\d{1,3}(?:,\d{3})+|\d{4,})\s*원(?<dae2>\s*대)?` +
    String.raw`|(?<wonsuf>\d{1,3}(?:,\d{3})+|\d{4,})\s*(?:₩|KRW)` +
  ')',
  'gi',
);
const n = (s) => Number(String(s).replaceAll(',', ''));
// 표시(marks) — 붙은 값은 '주장가 확인 근거'가 되지 못한다. 더 싸면 그대로 차단 근거다(판정부).
//  - conditional: 숫자 앞 16자 또는 뒤 12자 안에 할인·카드·쿠폰·적립 등 — 조건부일 수 있는 값("299,000원 (카드 할인 적용 시)", 리뷰 94ef08a H-B)
//  - range: 숫자 바로 뒤나 앞의 '~' — 범위의 한쪽 끝("259,000원~", "~299,000원")
//  - diff: 숫자 앞 8자 안에 차이·차액·절약 — 가격이 아니라 차액일 수 있는 값("가격 차이가 15만 원")
//  - threshold: 숫자 바로 뒤가 이상·이하·미만·초과·부터 — 기준액("30만원 이상 구매시 무료배송", 리뷰 H6)
//  - approx: '원대' — 근사값 / ambiguous: "36만 12,000원" 같은 자리 모순
//  - used: 같은 검색 결과(제목+설명)에 중고·리퍼·렌탈 등 — 다른 상품 상태(observe 가 붙임, 리뷰 M2)
const CONDITIONAL = /(할인|카드|쿠폰|적립|멤버십|회원가|청구)/;
const DIFF = /(차이|차액|절약|절감)/;
const THRESHOLD = /^\s*(이상|이하|미만|초과|부터)/;
const RANGE_AFTER = /^\s*[~∼〜～]/;
const RANGE_BEFORE = /[~∼〜～]\s*$/;
const AFTER = 12;
const USED = /(중고|리퍼|렌탈|렌트|대여|반품|전시\s*상품|전시품|B급)/i;

// r5(리뷰 0e6acfa 적대 H1·불변식 6 — 같은 계열 5회째): 형식을 하나씩 더하는 대신 구조를 바꾼다.
//  ① 스캔 전 정규화를 한 곳에서(NFKC·태그·엔티티·폭 0 문자·타 문자권 숫자) ② 위 정규식이 읽지 못한 숫자 덩어리도 버리지 않고
//  unparsed 표시 관측으로 남긴다 — 표시 붙은 값은 확인 근거가 못 되고, 주장가보다 작게 읽히면 차단 근거다(정지 쪽 실패).
const asciiDigit = (ch) => {
  const cp = ch.codePointAt(0);
  if (cp < 128) return ch;
  let z = cp;
  while (z > cp - 9 && /\p{Nd}/u.test(String.fromCodePoint(z - 1))) z--;
  return String((cp - z) % 10);
};
const ENTITY = { comma: ',', period: '.', lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const fromCp = (n) => { try { return String.fromCodePoint(n); } catch { return ''; } };
// 정규화는 한 가지 답이 없다(리뷰 5~8차: 태그를 지우면 꺾쇠 안 값·표시가 사라지고, 남기면 태그 이름이 문맥 창을 밀어낸다).
// 그래서 한 가지를 고르지 않고 여러 보기를 모두 읽어 합친다(scanPrices). 어느 보기도 단독으로는 믿지 않는다:
//   keep  = 아무 글자도 지우지 않고 꺾쇠만 공백으로      ("<SALE 259,000원>" 의 값이 남는다)
//   space = 진짜 HTML 태그를 공백 하나로                  ("<b>359,000</b>원", "359,000원</b><span>카드할인가" 의 표시)
//   join  = 진짜 HTML 태그를 빈 글로(앞뒤를 붙임)         ("259,<b>000</b>원" — 숫자 안에 낀 태그, 8차 적대 H1)
//   cut   = '<…>' 를 통째로 빈 글로                       ("259,<할인>000원" 처럼 태그 꼴이 아닌 꺾쇠가 숫자 안에 낀 경우)
//   bare  = 태그를 뺀 뒤 남은 꺾쇠 글자만 빈 글로(2종)     ("이<상 구매" 처럼 짝 없는 꺾쇠가 표시 낱말을 쪼갠 경우)
const entities = (text) => String(text ?? '')
  .replace(/&#x([0-9a-f]+);/gi, (_m, h) => fromCp(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_m, d) => fromCp(Number(d)))
  .replace(/&([a-z]+);/gi, (_m, name) => ENTITY[name.toLowerCase()] ?? ' ');
const finish = (s) => entities(s.replace(/[<>]/g, ' ')).normalize('NFKC').replace(/[​-‍⁠﻿­]/g, '').replace(/\p{Nd}/gu, asciiDigit);
const TAG = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/gi;
const viewKeep = (text) => finish(String(text ?? ''));
const DEBRIS = /<[\/a-z][\/a-z0-9="'_-]*|(?<![\/a-z0-9="'_-])[\/a-z0-9="'_-]*>|[<>]/gi; // 뒤보기: 긴 영숫자 글에서 자리마다 다시 훑지 않게(선형)
// 한 번만 치환한다 — 겹친 태그 조각("</spa</span>n>")은 아래 DEBRIS 보기가 읽는다(되풀이 벗기기는 중복이고 깊게 겹치면 이차 시간이라 뺐다, 10차 L-SH-2·12)
const strip = (t, re, to) => t.replace(re, to);
const VIEWS = [
  (t) => finish(strip(t, TAG, ' ')),
  (t) => finish(strip(t, TAG, '')),
  (t) => finish(strip(t, /<[^<>]*>/g, '')),
  // 짝 없는 꺾쇠가 낱말·숫자 사이에 낀 경우("이<상 구매", "259,<000원") — 꺾쇠를 공백이 아니라 빈 글로
  (t) => finish(strip(t, TAG, '').replace(/[<>]/g, '')),
  (t) => finish(strip(t, TAG, ' ').replace(/[<>]/g, '')),
  // 깨진 태그 조각("~<br</></b>299,000원"): 꺾쇠와 거기 붙은 마크업 부스러기(영문·/·=·따옴표)를 함께 뺀다 — 빈 글로 / 공백으로
  (t) => finish(strip(t, DEBRIS, '')),
  (t) => finish(strip(t, DEBRIS, ' ')),
  (t) => finish(t),
];
/** 글의 모든 보기(중복 제거) — 표시 낱말(중고 등)은 어느 보기에서든 보이면 본 것으로 친다 */
// 엔티티·전각으로 적힌 꺾쇠(&lt;b&gt;·＜b＞)도 같은 보기를 거치게, 먼저 풀어 놓은 글에도 한 번 더 적용한다(9차 레인 L-SH-1)
const decoded = (text) => entities(String(text ?? '')).normalize('NFKC');
export const viewsOf = (text) => [...new Set([String(text ?? ''), decoded(text)].flatMap((t) => VIEWS.map((v) => v(t))))];
/**
 * 평문인가 — 진행 근거로 써도 되는 글의 **허용 목록**(10차). 9차의 '꺾쇠가 있으면 마크업' 은 막을 것을 열거하는 방식이라
 * 다른 인코딩(%3C · < · 세미콜론 없는 &lt · 〈〉 · 폭 0 글자)이 그대로 지나갔다. 그래서 뒤집는다: 아래 글자만으로 된 글만 평문이다.
 *   한글 완성형 음절(가~힣 — 자모·채움 문자 U+115F 같은 보이지 않는 한글 문자는 제외) · 영문 · ASCII 숫자 · 공백/줄바꿈 · , . ( ) [ ] - : ; / · ~ + | ! ? ' " # * = _ @ ₩ – — ‘ ’ “ ” · '%'(뒤에 16진 두 자리가 오지 않을 때만)
 * 꺾쇠·&·\·폭 0 글자·한자·이모지·그 밖의 기호는 전부 평문이 아니다.
 * 평문이 아닌 글도 읽기는 한다(더 싼 값 차단·사람 확인 후보) — 다만 확인 근거도 반박 근거도 되지 못하고, 조회 결과에 하나라도 있으면 판정부가 정지한다.
 */
const PLAIN = /^(?:[\uAC00-\uD7A3A-Za-z0-9 \n,.()[\]\-:;/·~+|!?'"#*=_@₩–—‘’“”]|%(?![0-9A-Fa-f]{2}))*$/u;
function strictPlain(text) {
  const s = String(text ?? '');
  return PLAIN.test(s); // 허용 글자는 전부 NFKC 로 바뀌지 않는 글자라 정규화 대조는 따로 필요 없다(전수 테스트가 지킨다)
}
// 말줄임표 '…' 는 검색 발췌 끝에 흔하다 — NFKC 가 '...' 로 바꾸지만 보이는 그대로라 평문으로 친다(먼저 '...' 로 바꿔 놓고 판별)
export function isPlain(text) {
  return strictPlain(String(text ?? '').replaceAll('…', '...'));
}
export const resultsAllPlain = (results) => (results ?? []).every((r) => isPlain(r?.title) && isPlain(r?.description));
/** 아무 글자도 지우지 않는 보기 — 표시(중고 등) 찾기·발췌용 */
export const normalizeText = viewKeep;
// 읽지 못한 숫자 덩어리: 만·천·백 표기(원 없음 포함) · k · 자리 구분(쉼표·점·공백) · 4자리 이상 · 숫자+원/won/圓 · 한글 수사+원
const HAN_UNITS = '십백천만억十百千万萬億';
const HAN = `일이삼사오육칠팔구一二三四五六七八九${HAN_UNITS}`;
// 연도처럼 생긴 숫자(쉼표·원 없는 19xx·20xx 네 자리)는 버리지 않고 yearlike 표시만 붙인다 — 차단에서 뺄지는 판정부(price.mjs classify)가 주장가와 견줘 정한다.
// (8차 레인: 추출 단계에서 '2025-11' 꼴을 건너뛰었더니 "행사 2000/1팩" 의 진짜 가격이 사라졌다. 날짜 형식 열거도 끝이 없었다.)
const YEARLIKE = /^(?:19|20)\d\d$/;
const UNIT_AFTER = /^\s*(?:원|圓|won)/i; // 화폐 단위가 붙은 값은 연도가 아니다("2000won", 9차 레인 L-SR-3) — 느슨한 읽기 한 곳에서만 본다: 같은 값의 관측 중 하나라도 yearlike 가 아니면 판정부가 차단한다
const LOOSE = new RegExp(
  String.raw`(?<man>\d+(?:\.\d+)?)\s*만(?:\s*(?<mc>\d)\s*천)?(?:\s*(?<mb>\d)\s*백)?(?:\s*(?<mr>\d{1,4})(?![\d,.]))?` +
    String.raw`|(?<c>\d)\s*천(?:\s*(?<cb>\d)\s*백)?` +
    String.raw`|(?<k>\d+(?:\.\d+)?)\s*(?:k(?![a-z])|thousand)` +
    String.raw`|(?<grp>\d{1,3}(?:[.,\s_'’]\d{3})+)` +
    String.raw`|(?<long>\d{4,})` +
    String.raw`|(?<unit>\d+)\s*(?:원|圓|won)` +
    String.raw`|(?<han>[${HAN}]*[${HAN_UNITS}][${HAN}]*)\s*(?:원|圓|円|元)|(?<han4>[${HAN}]*[${HAN_UNITS}][${HAN}]*)`,
  'giu',
);
const HAN_D = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const HAN_U = { 십: 10, 백: 100, 천: 1000, 十: 10, 百: 100, 千: 1000 };
function hanNumber(s) {
  let total = 0, sec = 0, d = 0;
  for (const ch of s) {
    if (HAN_D[ch]) d = HAN_D[ch];
    else if (HAN_U[ch]) { sec += (d || 1) * HAN_U[ch]; d = 0; }
    else { total += (sec + d || 1) * ('만万萬'.includes(ch) ? 1e4 : 1e8); sec = 0; d = 0; }
  }
  return total + sec + d;
}
/** 덩어리 하나의 가능한 읽기 전부 — 붙여 읽은 값이 실제보다 커져 차단을 비켜 가지 않게("3 259,000" → 3,259,000 과 3·259,000 모두). */
function looseReadings(g) {
  if (g.man) return [Math.round(Number(g.man) * 1e4) + Number(g.mc ?? 0) * 1000 + Number(g.mb ?? 0) * 100 + Number(g.mr ?? 0), Math.round(Number(g.man) * 1e4)];
  if (g.c) return [Number(g.c) * 1000 + Number(g.cb ?? 0) * 100];
  if (g.k) return [Math.round(Number(g.k) * 1000)];
  if (g.grp) return [Number(g.grp.replace(/[.,\s_'’]/g, '')), ...g.grp.split(/[.\s_'’]+/).map((x) => Number(x.replaceAll(',', '')))];
  if (g.long) return [Number(g.long)];
  if (g.unit) return [Number(g.unit)];
  // 원 없는 수사: 4자 이상이거나 만·억 단위가 든 것("삼십만에 샀어요"·"이십만 초반", 8차 적대 L4). '백'·'천' 같은 낱말 조각은 읽지 않는다.
  if (g.han4) return [...g.han4].length >= 4 || /.[만万萬억億]/u.test(g.han4) ? [hanNumber(g.han4)] : [];
  return [hanNumber(g.han)];
}

export function extractPrices(text = '') {
  return scanPrices(text).map(({ at: _a, end: _e, text: _t, ...p }) => p);
}

/** extractPrices + 값이 나온 위치(at·end) — observe 가 원문 발췌(snippet)를 붙일 때 쓴다. */
function scanView(s) {
  const out = [];
  let rest0 = s; // 정규식이 읽은 자리를 가린 나머지 — 읽지 못한 숫자를 여기서 찾는다
  for (const m of s.matchAll(RE)) {
    rest0 = rest0.slice(0, m.index) + '§'.repeat(m[0].length) + rest0.slice(m.index + m[0].length);
    const g = m.groups;
    const at = m.index;
    const end = m.index + m[0].length;
    const after = s.slice(end, end + AFTER);
    const flags = {
      anchored: Boolean(g.anchor),
      conditional: CONDITIONAL.test(s.slice(Math.max(0, at - 16), at)) || CONDITIONAL.test(after),
      diff: DIFF.test(s.slice(Math.max(0, at - 8), at)),
      threshold: THRESHOLD.test(s.slice(end, end + 6)),
      range: RANGE_AFTER.test(after) || RANGE_BEFORE.test(s.slice(Math.max(0, at - 2), at)),
    };
    const push = (p) => out.push({ ...p, ...flags, at, end, text: s });
    if (g.won) { push({ value: n(g.won), approx: false }); continue; }
    if (g.wonsuf) { push({ value: n(g.wonsuf), approx: false }); continue; }
    if (g.num) { push({ value: n(g.num), approx: Boolean(g.dae2) }); continue; }
    if (g.mandec) { push({ value: Math.round(Number(g.mandec) * 10_000), approx: Boolean(g.dae0) }); continue; }
    const cheon = g.cheon ? Number(g.cheon) : 0;
    const rest = g.rest ? n(g.rest) : 0;
    // "36만 12,000원" 같은 자리 모순: 버리지 않고 만·천 자리만 읽어 ambiguous 표시(확인 근거 불가, 더 싸면 차단)
    // 뒤 숫자가 따로 선 가격일 수 있다("정가 33만 259,000원", 적대 r6 H2) — 만 단위 읽기와 뒤 숫자 단독 읽기를 둘 다 남긴다
    if (rest >= (g.cheon ? 1_000 : 10_000)) { push({ value: n(g.man) * 10_000 + cheon * 1_000, approx: false, ambiguous: true }); push({ value: rest, approx: false, ambiguous: true }); continue; }
    push({ value: n(g.man) * 10_000 + cheon * 1_000 + rest, approx: Boolean(g.dae1) });
  }
  // 숫자 덩어리(쉼표 묶음·4자리 이상)는 정규식이 다른 표기의 일부로 읽었더라도 단독 값으로 한 번 더 남긴다 — 읽힌 자리에 가려 삼켜지는 값이 없게(r6 H2 구조 수리).
  // 대가: "36만 9,900원" 은 369,900 과 9,900 둘 다 관측된다(정지 쪽).
  const have = new Set(out.map((p) => p.value));
  for (const m of s.matchAll(/(?<![\d,.])(?:\d{1,3}(?:,\d{3})+|\d{4,})/g)) {
    const value = n(m[0]);
    if (!have.has(value)) { have.add(value); out.push({ value, approx: false, anchored: false, unparsed: true, yearlike: YEARLIKE.test(m[0]), at: m.index, end: m.index + m[0].length, text: s }); }
  }
  for (const m of rest0.matchAll(LOOSE)) {
    for (const value of new Set(looseReadings(m.groups))) {
      if (Number.isFinite(value)) out.push({ value, approx: false, anchored: false, unparsed: true, yearlike: Boolean(m.groups.long && YEARLIKE.test(m.groups.long)) && !UNIT_AFTER.test(rest0.slice(m.index + m.groups.long.length + m[0].indexOf(m.groups.long))), at: m.index, end: m.index + m[0].length, text: s });
    }
  }
  return out;
}

const CONTEXT_MARKS = ['conditional', 'diff', 'threshold', 'range', 'approx', 'ambiguous'];
/**
 * 모든 보기를 읽어 합친다 — 어느 쪽으로도 '덜 조심스러운' 결과가 나오지 않게:
 *  - 값: 어느 보기에서든 읽힌 값은 전부 남는다.
 *  - 표시: 같은 값에 어느 보기에서든 붙은 문맥 표시(조건부·범위 등)는 그 값의 모든 관측에 붙인다.
 *  - unparsed: 다른 보기가 제대로 읽은 값이면 그 unparsed 사본은 넣지 않는다(같은 값이 이미 있으므로 버려지는 값은 없다).
 */
function scanPrices(text) {
  const texts = viewsOf(text); // 꺾쇠가 없는 글은 보기가 하나로 접힌다
  const all = texts.map(scanView);
  const flat = all.flat();
  const parsed = new Set(flat.filter((p) => !p.unparsed).map((p) => p.value));
  const taint = new Map();
  for (const p of flat) for (const k of CONTEXT_MARKS) if (p[k]) taint.set(p.value, (taint.get(p.value) ?? new Set()).add(k));
  const seen = new Set();
  const out = [];
  for (const view of all) {
    const fresh = view.filter((p) => !seen.has(p.value) && !(p.unparsed && parsed.has(p.value)));
    for (const p of fresh) out.push(p);
    for (const p of fresh) seen.add(p.value);
  }
  for (const p of out) for (const k of taint.get(p.value) ?? []) p[k] = true;
  return out;
}

const SNIPPET_MAX = 80;
/** 값이 나온 필드 원문 발췌(최대 80자, 값을 가운데쯤에) — 사람이 '같은 상품인가'를 판단하는 재료(의장 결정 D2). */
function snippetOf(field, at, end) {
  const s = String(field); // 값이 읽힌 보기의 글(at·end 는 그 글의 위치)
  if (s.length <= SNIPPET_MAX) return s;
  const room = Math.max(0, SNIPPET_MAX - (end - at));
  let from = Math.max(0, at - Math.floor(room / 2));
  from = Math.min(from, s.length - SNIPPET_MAX);
  return s.slice(from, from + SNIPPET_MAX).toWellFormed(); // 짝 없는 서로게이트를 남기지 않는다(레인 L-SH-5 — 다른 언어 JCS 구현에서 서명이 깨짐)
}

/**
 * 결과 제목이 상품명을 가리키는가(리뷰 94ef08a M-A): 상품명 첫 낱말이 제목에 있고, 상품명 낱말의 절반 이상이 제목에 있음.
 * 띄어쓰기 차이("에어팟 프로 3" ↔ "에어팟 프로3")는 공백을 지운 제목에서 찾는다. 낱말이 없으면 거짓(확인할 수 없음).
 */
export function titleMatchesItem(title, item) {
  if (!isPlain(title)) return false; // 평문이 아닌 제목은 같은 상품으로 치지 않는다(폭 0 글자로 쪼갠 '케이스' — 10차 L-SR-1·L-SH-3)
  // r5(레인 L-SH-2): '절반 이상' 이면 "에어팟 프로 2" 가 "에어팟 프로 3" 의 출처가 됐다 — 상품명 낱말 전부, 숫자 낱말은 제목의 독립 토큰으로만
  // (가격 "359,000" 안의 3 은 모델 번호 3 이 아니다). 제목에만 있는 부속품 낱말(케이스 등)은 다른 상품으로 본다. 같은 상품인지의 완전한 판별은 아니다(README 한계).
  // r6 L3: 낱말이 흩어져 있거나 다른 낱말 안에 있으면("에어팟 프로 2 정품 3개월", "에어팟 3세대 프로모션") 같은 상품이 아니다 —
  // 상품명 낱말이 제목에 순서대로 이어져 나와야 하고(붙여 쓴 "에어팟프로3" 은 낱말로 갈라 본다), 끝 숫자 바로 뒤가 수량·기간 단위면 모델 번호가 아니다.
  const keys = tokensOf(item);
  if (!keys.length) return false;
  // 제목 토큰을 상품명 낱말들로 남김없이 가를 수 있으면 가른다 — 정규식 `^(?:a|b)+$` 는 낱말이 서로 이어 붙는 상품명에서 지수 역추적이 났다(8차 적대 L1). 위치마다 한 번만 보는 분해로 바꿨다.
  const uniq = [...new Set(keys)].sort((a, b) => b.length - a.length);
  const split = (t) => {
    const dead = new Set();
    const go = (i) => {
      if (i === t.length) return [];
      if (dead.has(i)) return null;
      for (const k of uniq) if (t.startsWith(k, i)) { const tail = go(i + k.length); if (tail) return [k, ...tail]; }
      dead.add(i);
      return null;
    };
    return t.length <= 200 ? go(0) : null;
  };
  const seq = tokensOf(title).flatMap((t) => split(t) ?? [`\0${t}`]); // \0 = 상품명 낱말이 아닌 토큰
  const hit = seq.findIndex((_x, i) => keys.every((k, j) => seq[i + j] === k));
  if (hit < 0) return false;
  if (/^\p{N}+$/u.test(keys.at(-1)) && COUNT_UNIT.test(seq[hit + keys.length] ?? '')) return false;
  return !(ACCESSORY.test(String(title)) && !ACCESSORY.test(String(item)));
}
const COUNT_UNIT = /^\0(개월|개|일|년|원|만|천|매|박스|팩|종|인용|회|주)$/;
const tokensOf = (s) => String(s ?? '').normalize('NFKC').toLowerCase().match(/\p{L}+|\p{N}+/gu) ?? [];
const ACCESSORY = /(케이스|커버|필름|스트랩|이어팁|충전기|케이블|거치대|호환|전용|부품|액세서리|악세사리|스티커|파우치)/;

/** 값의 표시 목록 — 비어 있어야 확인 근거가 될 수 있다. */
export function marksOf(p) {
  return ['approx', 'ambiguous', 'conditional', 'diff', 'threshold', 'range', 'unparsed', 'yearlike', 'used', 'off_item', 'nonplain'].filter((k) => p[k]);
}

// 공개 접미사 전체 목록은 싣지 않는다(의존성 0) — 자주 나오는 2단 접미사만. 목록 밖(예: github.io 하위 사이트)은 한 곳으로 접혀 정지 쪽으로 틀린다(README 한계).
const MULTI_SLD = new Set(['co.kr', 'or.kr', 'go.kr', 'ne.kr', 'ac.kr', 're.kr', 'pe.kr', 'co.jp', 'go.jp', 'ac.jp', 'or.jp', 'ne.jp', 'co.uk', 'ac.uk', 'org.uk', 'gov.uk', 'nhs.uk', 'com.au', 'gov.au', 'edu.au', 'org.au', 'com.cn', 'gov.cn', 'edu.cn', 'com.tw', 'com.hk', 'com.sg', 'co.nz', 'co.in']);
/** 판매처 단위 호스트: m.·www.·하위 도메인을 접어 같은 판매처를 한 곳으로 센다 (prod.danawa.com = m.danawa.com = danawa.com). */
export function hostOf(url) {
  const h = siteOf(url);
  if (!h) return null;
  if (/^[\d.]+$/.test(h) || h.includes(':')) return h; // IP 는 접지 않는다(리뷰 N9)
  const labels = h.split('.');
  const keep = MULTI_SLD.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/** 판매처 비교용 전체 호스트(www.·m. 만 제거, 끝 점 제거). 공유 플랫폼(smartstore.naver.com vs blog.naver.com)을 접지 않는다(리뷰 N6). */
export function siteOf(url) {
  let h;
  try { h = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
  if (!h) return null;
  return h.replace(/^(www|m)\./, '');
}

/**
 * 결과 목록 → 관측치 [{value, url, source, anchored, marks[], group, api, snippet}]. 어떤 값도 버리지 않는다(price-v4).
 * group = 같은 검색 결과 한 건. source = 판매처 단위 호스트, 출처 URL 이 없으면(LLM 답) `api:<이름>`.
 * 제목·설명은 따로 읽는다(문맥이 이어지지 않게). 단 중고·리퍼 표시는 결과 한 건 전체에 붙인다(상품 상태는 결과 단위).
 * item 을 주면 제목이 그 상품을 가리키지 않는 결과의 값에 off_item 표시를 붙인다(2차 '가격으로 찾기' 검색용, 리뷰 94ef08a M-A).
 */
export function observe(results, { api, item }) {
  const obs = [];
  results.forEach((r, i) => {
    const used = viewsOf(`${r.title ?? ''} ${r.description ?? ''}`).some((v) => USED.test(v));
    const offItem = item !== undefined && !titleMatchesItem(r.title, item);
    const source = (r.url && hostOf(r.url)) || `api:${api}`;
    for (const field of [r.title, r.description]) {
      const nonplain = !isPlain(field); // 평문이 아닌 글에서 읽은 값은 표시가 붙는다 — 확인·반박 근거가 못 되고, 더 싸면 차단만 한다
      for (const p of scanPrices(field ?? '')) {
        obs.push({ value: p.value, url: r.url ?? null, source, anchored: p.anchored, marks: marksOf({ ...p, used, off_item: offItem, nonplain }), group: `${api}#${i}`, api, snippet: snippetOf(p.text, p.at, p.end) });
      }
    }
  });
  return obs;
}
