import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVerifier } from '../src/index.mjs';
import { createMockProvider } from '../src/providers/mock.mjs';
import { generateSigner } from '../src/receipt/keys.mjs';

process.env.VERIFIER_AUTHORIZE_PROVIDERS = '';
const policy = { claim_domain: 'general' }; // 의뢰자 정책(D1) — 일반 사실 주장은 mid

test('평판: 유효 영수증만 집계, 위조·깨진 줄은 rejected, 정확도 = 확인/(확인+반박)', async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'ver-led-')), 'l.jsonl');
  const v = createVerifier({ provider: createMockProvider(), signer: generateSigner(), ledgerPath, policy });
  const tc = { tool_calls: [{ url: 'https://compare-a.example/x' }, { url: 'https://shop-b.example/y' }] };
  await v.verifyPrice({ claim: { item: '에어팟 프로 3', price_krw: 287490, seller_url: 'https://compare-a.example/x' }, process: tc, agentId: 'honest' });
  await v.verifyPrice({ claim: { item: '에어팟 프로 3', price_krw: 299000, seller_url: 'https://shop-b.example/y' }, process: tc, agentId: 'hasty' });
  await v.verifyClaim({ statement: '만리장성은 우주에서 맨눈으로 보인다', agentId: 'hasty' });
  await v.verifyClaim({ statement: '근거 없는 주장', agentId: 'hasty' });
  // 다른 키로 서명한 위조 영수증 + 깨진 줄
  const forger = createVerifier({ provider: createMockProvider(), signer: generateSigner(), ledgerPath: null, policy });
  const fake = await forger.verifyClaim({ statement: '에펠탑은 1889년에 완공되었다', agentId: 'hasty' });
  appendFileSync(ledgerPath, `${JSON.stringify(fake.receipt)}\n{broken\n`);

  const all = v.reputation();
  assert.equal(all.rejected, 2);
  // 과정(process) 영수증뿐이면 정확도는 아직 없음(rep-v2: 사후 영수증만으로 계산)
  assert.deepEqual([all.agents.honest.confirmed, all.agents.honest.accuracy], [1, null]);
  const h = v.reputation('hasty');
  assert.deepEqual([h.total, h.confirmed, h.refuted, h.unverifiable, h.stops, h.accuracy], [3, 0, 2, 1, 3, null]);
  assert.deepEqual(h.by_tier, { low: 1, mid: 2 });
  await v.verifyPrice({ claim: { item: '에어팟 프로 3', price_krw: 287490 }, phase: 'outcome', agentId: 'honest' });
  await v.verifyPrice({ claim: { item: '에어팟 프로 3', price_krw: 299000 }, phase: 'outcome', agentId: 'hasty' });
  assert.equal(v.reputation('honest').accuracy, 1);
  assert.equal(v.reputation('hasty').accuracy, 0);
});

test('리뷰 43b5e7b M5: 같은 영수증을 여러 줄 붙여도 한 번만 센다', async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'ver-led-')), 'l.jsonl');
  const v = createVerifier({ provider: createMockProvider(), signer: generateSigner(), ledgerPath });
  const { receipt } = await v.verifyPrice({ claim: { item: '에어팟 프로 3', price_krw: 287490 }, phase: 'outcome', agentId: 'a' });
  appendFileSync(ledgerPath, `${JSON.stringify(receipt)}\n`.repeat(4));
  const rep = v.reputation();
  assert.deepEqual([rep.agents.a.total, rep.agents.a.outcome.confirmed, rep.duplicates], [1, 1, 4]);
});

test('리뷰 94ef08a M-B: 같은 주장의 사후 영수증은 에이전트별 최신 1건만(nonce 바꿔도) · __proto__ 같은 agent_id 도 집계를 깨지 않는다', async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'ver-led-')), 'l.jsonl');
  const v = createVerifier({ provider: createMockProvider(), signer: generateSigner(), ledgerPath, policy });
  const claim = { item: '에어팟 프로 3', price_krw: 287490 };
  for (const n of ['a', 'b', 'c']) await v.verifyPrice({ claim: { ...claim, request_nonce: n }, phase: 'outcome', agentId: 'farmer' });
  await v.verifyPrice({ claim: { item: '에어팟 프로 3', price_krw: 299000 }, phase: 'outcome', agentId: 'farmer' });
  const rep = v.reputation();
  assert.deepEqual([rep.agents.farmer.outcome.confirmed, rep.agents.farmer.outcome.refuted, rep.agents.farmer.accuracy, rep.superseded], [1, 1, 0.5, 2]);
  for (const id of ['__proto__', 'constructor', 'toString']) await v.verifyPrice({ claim, phase: 'outcome', agentId: id });
  const all = v.reputation();
  assert.equal(Object.getPrototypeOf(all.agents), Object.prototype);
  assert.deepEqual(['__proto__', 'constructor', 'toString'].map((id) => Object.hasOwn(all.agents, id) && all.agents[id].outcome.confirmed), [1, 1, 1]);
  assert.deepEqual([v.reputation('__proto__').total, v.reputation('nobody').total], [1, 0]);
});
