// 키 없이 도는 결정적 가짜 공급자 — 테스트·심사용 오프라인 시연. 외부 호출 0.
// 데이터는 가상(판매처 *.example)이며, '에어팟 프로 3' 한 건만 2026-11-21 Liner web 실호출 응답의 모양을 본떴다.
// price-v4 부터 더 싼 값은 전부 차단 근거라, 실응답에 있던 '4,000원'(배송비·옵션가로 보이는 값)은 진행 시연용 표본에서 뺐다.
// 실데이터에서는 이런 값 때문에 정지가 잦다(README 알려진 한계).
import { createMeter } from './meter.mjs';

const WEB = [
  {
    match: /에어팟 프로 ?3/,
    results: [
      { title: '에어팟 프로3 (정품) : 가격비교', url: 'https://compare-a.example/airpods-pro-3', hostname: 'compare-a.example', description: '에어팟 프로3 (정품) 최저287,490원 가격비교 211 최저가 … 할인 전 가격 287,500원', date: null },
      { title: '에어팟 프로 3 가격과 달라진 점', url: 'https://blog.example/airpods-review', hostname: 'blog.example', description: '공식가는 36만 9천 원이지만 실제 판매 가격은 시기에 따라 달라질 수 있으니', date: '2026-09-28' },
      { title: '에어팟 프로3 최저가 299,000원', url: 'https://shop-b.example/ap3', hostname: 'shop-b.example', description: '오늘만 특가 최저가 299,000원 무료배송', date: null },
      { title: 'APPLE 에어팟 프로3 정품', url: 'https://market-c.example/item/ap3', hostname: 'market-c.example', description: '판매가 287,490원 무료배송', date: null },
    ],
  },
  {
    match: /무선 ?청소기 ?X1/i,
    results: [
      { title: '무선청소기 X1 최저가', url: 'https://compare-a.example/x1', hostname: 'compare-a.example', description: '무선청소기 X1 최저 412,000원 · 카드 5% 할인', date: null },
      { title: '무선청소기 X1 공식몰', url: 'https://maker.example/x1', hostname: 'maker.example', description: '정가 529,000원', date: null },
    ],
  },
  {
    match: /로봇 ?청소기 ?R9/i,
    results: [{ title: '로봇청소기 R9 리뷰', url: 'https://blog.example/r9', hostname: 'blog.example', description: '흡입력과 맵핑 성능 비교 후기', date: null }],
  },
];

const QUICK = [
  { match: /로봇 ?청소기 ?R9/i, answer: '로봇청소기 R9 의 현재 최저가는 약 689,000원입니다.', references: [{ title: '로봇청소기 R9 가격비교', url: 'https://compare-a.example/r9' }] },
];

// mid 사실 주장용 Agent search 가짜. [mock:*] 는 mock 판사가 읽는 입장 표식.
const SEARCH = [
  { match: /에펠탑.*1889/, answer: '[mock:adopt] 에펠탑은 1889년 파리 만국박람회에 맞춰 완공되었다.', references: ['https://encyclopedia.example/eiffel', 'https://museum.example/eiffel-history'] },
  { match: /만리장성.*우주/, answer: '[mock:reject] 만리장성은 저궤도에서도 맨눈으로 거의 보이지 않는다는 우주비행사 증언이 다수다.', references: ['https://space-agency.example/great-wall', 'https://science.example/myth'] },
  { match: /트랜스포머.*2017/, answer: '[mock:adopt] Transformer 는 2017년 논문 Attention Is All You Need 에서 제안되었다.', references: ['https://arxiv.example/1706.03762'] },
];
const SCHOLAR = [
  { match: /트랜스포머.*2017/, results: [{ title: 'Attention Is All You Need', url: 'https://papers.example/attention-2017' }] },
];

// 법정용 Deep Research 가짜: 질의에 '반증' 이 있으면 검사, 아니면 변호. 결정적 시나리오 2개(채택·기각).
const DEEP = [
  { match: /아세트아미노펜.*4\s*g/, prosecution: [], defense: ['https://label.example/acetaminophen', 'https://journal.example/apap-dose'] },
  { match: /비타민\s*C.*감기.*예방/, prosecution: ['https://review.example/vitc-cochrane', 'https://journal.example/vitc-rct'], defense: [] },
];

export function createMockProvider({ meter = createMeter(), name = 'mock' } = {}) {
  const pick = (table, q) => table.find((t) => t.match.test(q));
  return {
    name,
    meter,
    async web(query, { max = 10 } = {}) {
      meter.record('search.web');
      return { results: (pick(WEB, query)?.results ?? []).slice(0, max) };
    },
    async scholar(q, { max = 10 } = {}) {
      meter.record('search.scholar');
      return { results: (pick(SCHOLAR, q)?.results ?? []).slice(0, max) };
    },
    async quick(q) {
      meter.record('agent.quick');
      const hit = pick(QUICK, q);
      return hit ? { answer: hit.answer, references: hit.references } : { answer: '확인할 수 있는 가격 정보를 찾지 못했습니다.', references: [] };
    },
    async search(q) {
      meter.record('agent.search');
      const hit = pick(SEARCH, q);
      return hit ? { answer: hit.answer, references: hit.references.map((url) => ({ title: url, url })) } : { answer: `(mock) ${q} 에 대한 근거를 찾지 못했습니다.`, references: [] };
    },
    async deep(q) {
      meter.record('agent.deep');
      const hit = pick(DEEP, q);
      const urls = hit ? (/반증/.test(q) ? hit.prosecution : hit.defense) : [];
      return { answer: urls.length ? `(mock) 출처 ${urls.length}건 보고서` : `(mock) ${q} 보고서 없음`, references: urls.map((url) => ({ title: url, url })) };
    },
    async balance() {
      return { usd: 200 - meter.snapshot().usd };
    },
  };
}
