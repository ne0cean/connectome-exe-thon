// '완료' 주장 검증 (mid, done-v1): "게시했어요/배포했어요 — 여기 있어요(URL)" 를 공개 웹 관측으로 확인한다.
// 확인 = 검색 결과에 주장 URL(호스트+경로 일치)이 실제로 나오고, 그 결과 제목·설명에 주장 제목의 핵심어가 절반 이상 들어 있음.
// 못 찾으면 확인불가(게시 직후는 색인 전일 수 있다 — 반박이 아니다). 다른 URL 이 같은 제목으로만 보이면 url_mismatch 로 정지.
// done-v2(리뷰 94ef08a M-C): URL 비교에 쿼리를 포함(키 정렬) — watch?v=MINE ≠ watch?v=OTHER. 공급자 오류는 `search.web:failed` 로 비용 기록.
// done-v3(리뷰 0e6acfa 적대 L3): http/https·기본 포트만 — javascript:·ftp:·:8080 주장 URL 은 조회 없이 확인불가(과정이면 정지), 검색 결과 쪽도 같은 것으로 치지 않는다.
// 한계(배선 전 설계 필요): '이미 있던 남의 페이지'도 확인된다 — 게시 시점·작성자를 증명하지 않는다(README 알려진 한계).
import { classifyTier, TIER_RULES_VERSION } from '../tiers.mjs';
import { issueReceipt, PHASES } from '../receipt/receipt.mjs';
import { createMeter } from '../providers/meter.mjs';
import { siteOf } from './extract.mjs';

export const DONE_RULE_VERSION = 'done-v3';

const WEB_SCHEMES = ['http:', 'https:'];
const parse = (u) => { try { return new URL(u); } catch { return null; } };
/** 비교용 정규형. 웹 URL(http/https, 기본 포트 — URL 이 :80·:443 은 '' 로 접는다)이 아니면 null. */
const norm = (u) => {
  try {
    const x = new URL(u);
    if (!WEB_SCHEMES.includes(x.protocol) || x.port) return null;
    x.searchParams.sort();
    return `${siteOf(u)}${x.pathname.replace(/\/+$/, '')}${x.searchParams.size ? `?${x.searchParams}` : ''}`;
  } catch { return null; }
};
const words = (s) => [...new Set(String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2))];

/** input: { task, artifact_url, phase?, agentId? } · deps: { provider, signer, now? } */
export async function verifyDone(input, { provider, signer, now }) {
  const phase = input.phase ?? 'outcome';
  if (!PHASES.includes(phase)) throw new Error(`phase 는 process|outcome 이어야 합니다: ${phase}`);
  const task = String(input.task ?? '').trim();
  if (!task || !parse(input.artifact_url)) throw new Error('claim: task(산출물 제목)와 올바른 artifact_url 이 필요합니다');
  const target = norm(input.artifact_url);

  const t = classifyTier({ claimType: 'done' });
  const local = createMeter();
  const reasons = [];
  let results = [];
  // 웹 URL 이 아니면 조회하지 않는다(비용 0) — 판정 자리에서 확인불가로 닫는다
  if (!target) reasons.push('artifact_url_not_web');
  else {
    try { results = (await provider.web(task, { max: 10 })).results ?? []; local.record('search.web'); } catch { local.record('search.web:failed', 0); reasons.push('provider_error'); }
  }

  const key = words(task);
  const overlap = (r) => { const w = new Set(words(`${r.title ?? ''} ${r.description ?? ''}`)); return key.length ? key.filter((k) => w.has(k)).length / key.length : 0; };
  const hit = results.find((r) => norm(r.url) === target);
  const lookalikes = results.filter((r) => norm(r.url) !== target && overlap(r) >= 0.5);

  let result = 'unverifiable';
  if (reasons.length) { /* 웹 URL 아님 · 공급자 오류 */ }
  else if (hit && overlap(hit) >= 0.5) { result = 'confirmed'; reasons.push('artifact_observed'); }
  else if (hit) reasons.push('artifact_title_mismatch');
  else if (lookalikes.length) reasons.push('url_mismatch');
  else reasons.push('artifact_not_indexed');

  const receipt = issueReceipt({
    phase, tier: t.tier, agentId: input.agentId, claimType: 'done',
    claim: { task, artifact_url: String(input.artifact_url) },
    verdict: { result, decision: phase === 'process' ? (result === 'confirmed' ? 'proceed' : 'stop') : undefined, reasons },
    evidence: [...(hit ? [hit] : []), ...lookalikes].slice(0, 5).map((r) => ({ url: r.url, title: r.title ?? null, matches_claim_url: r === hit })),
    cost: local.snapshot(),
    method: { rule: DONE_RULE_VERSION, tiers: TIER_RULES_VERSION, tier_reasons: t.reasons, provider: provider.name },
    now,
  }, signer);
  const label = { confirmed: '확인', refuted: '반박', unverifiable: '확인불가' }[result];
  return { receipt, summary: `[${t.tier}/${phase}] 완료 주장: ${label} · 사유 ${reasons.join(',')} · 비용 $${receipt.cost.usd}` };
}
