// 데모용 쇼핑 에이전트 — 검증 "대상". 도구는 Liner 공식 MCP 의 search_web(키 없으면 mock 검색).
// 두 성격: careful = '최저' 표시 값 중 최솟값 + 본 판매처 전부 기록 / hasty = 처음 눈에 띈 가격을 바로 '최저가'로 주장.
// 이해당사자 분리: 에이전트(MCP)와 검증소(REST)가 같은 Liner 를 보면 같은 오류를 공유할 수 있다 → 독립 출처 확인이 필요하다.
import { createLinerMcp } from '../src/providers/liner-mcp.mjs';
import { createMockProvider } from '../src/providers/mock.mjs';
import { extractPrices } from '../src/verify/extract.mjs';

/** 검색 도구: { name, search(query) → results[{title,url,description}] } */
export function createSearchTool({ env = process.env } = {}) {
  if (env.VERIFIER_PROVIDER !== 'mock' && env.LINER_API_KEY) {
    const mcp = createLinerMcp({ apiKey: env.LINER_API_KEY });
    return { name: 'liner-mcp:search_web', async search(query) { return JSON.parse((await mcp.call('search_web', { query, limit: 8 })).text).results ?? []; } };
  }
  const mock = createMockProvider();
  return { name: 'mock:web', async search(query) { return (await mock.web(query)).results; } };
}

/** 에이전트 한 번의 조사 → 검증소에 낼 주장 + 작업 기록. 가격을 못 찾으면 null. */
export async function shop(item, { tool, style = 'careful' }) {
  const results = await tool.search(`${item} 최저가`);
  const seen = results.flatMap((r) => extractPrices(`${r.title ?? ''} ${r.description ?? ''}`).filter((p) => !p.approx && !p.unparsed).map((p) => ({ ...p, url: r.url }))); // 단위 없이 읽힌 숫자(연도 등)는 가격으로 주장하지 않는다
  if (!seen.length) return null;
  let pick;
  if (style === 'hasty') pick = seen[0];
  else {
    // '최저' 표시 값 우선 — 검증소의 조건 표시는 뒤 문맥까지 보므로('최저 N원 · 할인율…') 에이전트는 표시 여부만 본다
    const anchored = seen.filter((p) => p.anchored);
    // 배송비·적립금 같은 부가 금액을 최저가로 집지 않게, 본 값들의 중앙값의 30% 미만은 후보에서 뺀다(실호출에서 '4,000원' 을 주장했다)
    const sorted = seen.map((p) => p.value).sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length / 2)] * 0.3;
    const sane = (list) => list.filter((p) => p.value >= floor);
    pick = (sane(anchored).length ? sane(anchored) : sane(seen.filter((p) => !p.conditional))).sort((a, b) => a.value - b.value)[0] ?? seen[0];
  }
  const visited = style === 'hasty' ? [pick.url] : [...new Set(results.map((r) => r.url).filter(Boolean))];
  return { claim: { item, price_krw: pick.value, seller_url: pick.url }, tool_calls: [{ tool: tool.name, url: null }, ...visited.map((url) => ({ tool: 'browse', url }))] };
}
