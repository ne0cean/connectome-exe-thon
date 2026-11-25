import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDone } from '../src/verify/done.mjs';
import { createMeter } from '../src/providers/meter.mjs';
import { generateSigner, makeTrustList } from '../src/receipt/keys.mjs';
import { verifyReceipt } from '../src/receipt/receipt.mjs';

const signer = generateSigner();
const web = (results) => ({ name: 'fake', meter: createMeter(), web: async () => ({ results }) });
const post = { url: 'https://www.blog.example/posts/agent-verifier/', title: '에이전트 검증소 출시 노트', description: '위험도 3단 검증' };

test('완료 주장: 주장 URL 이 제목과 함께 관측되면 확인, 영수증 유효(mid·사후)', async () => {
  const { receipt } = await verifyDone({ task: '에이전트 검증소 출시 노트', artifact_url: 'https://blog.example/posts/agent-verifier' }, { provider: web([post]), signer });
  assert.deepEqual([receipt.tier, receipt.phase, receipt.verdict.result], ['mid', 'outcome', 'confirmed']);
  assert.equal(verifyReceipt(receipt, { trust: makeTrustList([signer]) }).valid, true);
});

test('완료 주장: 색인 전=확인불가 / 다른 URL 에 같은 제목=url_mismatch / 과정 판정은 확인 아니면 정지', async () => {
  const none = await verifyDone({ task: '에이전트 검증소 출시 노트', artifact_url: 'https://blog.example/posts/x' }, { provider: web([]), signer });
  assert.deepEqual(none.receipt.verdict.reasons, ['artifact_not_indexed']);
  const other = await verifyDone({ task: '에이전트 검증소 출시 노트', artifact_url: 'https://blog.example/posts/x', phase: 'process' }, { provider: web([post]), signer });
  assert.deepEqual([other.receipt.verdict.reasons[0], other.receipt.verdict.decision], ['url_mismatch', 'stop']);
  const titleOff = await verifyDone({ task: '완전히 다른 산출물 제목', artifact_url: post.url }, { provider: web([post]), signer });
  assert.deepEqual(titleOff.receipt.verdict.reasons, ['artifact_title_mismatch']);
  await assert.rejects(verifyDone({ task: 'x', artifact_url: 'not a url' }, { provider: web([]), signer }));
});

test('리뷰 94ef08a M-C: URL 쿼리까지 비교(순서 무관) · 공급자 오류도 비용 기록', async () => {
  const yt = { url: 'https://www.youtube.com/watch?v=OTHER', title: '에이전트 검증소 데모 영상', description: '' };
  const mine = await verifyDone({ task: '에이전트 검증소 데모 영상', artifact_url: 'https://youtube.com/watch?v=MINE' }, { provider: web([yt]), signer });
  assert.deepEqual([mine.receipt.verdict.result, mine.receipt.verdict.reasons], ['unverifiable', ['url_mismatch']]);
  const order = await verifyDone({ task: '에이전트 검증소 데모 영상', artifact_url: 'https://youtube.com/watch?t=1&v=OTHER' }, { provider: web([{ ...yt, url: 'https://youtube.com/watch?v=OTHER&t=1' }]), signer });
  assert.equal(order.receipt.verdict.result, 'confirmed');
  const down = { name: 'fake', meter: createMeter(), web: async () => { throw new Error('503'); } };
  const e = await verifyDone({ task: 'x 산출물', artifact_url: 'https://a.example/x' }, { provider: down, signer });
  assert.deepEqual([e.receipt.verdict.reasons, e.receipt.cost.calls], [['provider_error'], { 'search.web:failed': 1 }]);
});
