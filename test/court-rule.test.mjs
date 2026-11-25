import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideCourt } from '../src/court/rule.mjs';

// cited_defense = 판사가 인용한 변호 출처 수(court.mjs 가 제공 참조와 교집합해 센다)
const gpt = (verdict, extra = {}) => ({ family: 'gpt', verdict, cited_defense: 1, cited_prosecution: 1, ...extra });
const claude = (verdict, extra = {}) => ({ family: 'claude', verdict, cited_defense: 1, cited_prosecution: 1, ...extra });

test('채택: 두 계열 모두 adopt + 변호 출처 있음 → proceed', () => {
  assert.deepEqual(decideCourt([gpt('adopt'), claude('adopt')], { prosecution: 0, defense: 2, cited_defense_hosts: 2 }), { result: 'confirmed', decision: 'proceed', reasons: ['judges_unanimous_adopt'] });
});

test('채택 불가: 변호 출처 0 이면 만장일치여도 근거부족', () => {
  const r = decideCourt([gpt('adopt'), claude('adopt')], { prosecution: 0, defense: 0 });
  assert.equal(r.result, 'unverifiable');
  assert.ok(r.reasons.includes('no_defense_source'));
});

test('같은 계열 판사 둘이면 proceed 불가(single_family)', () => {
  const r = decideCourt([gpt('adopt'), { family: 'gpt', verdict: 'adopt', cited_defense: 1 }], { prosecution: 0, defense: 3 });
  assert.equal(r.decision, 'stop');
  assert.ok(r.reasons.includes('single_family'));
});

test('기각: 한 명이라도 reject + 검사 출처 → refuted (엄격 판정승)', () => {
  assert.equal(decideCourt([gpt('adopt'), claude('reject')], { prosecution: 1, defense: 3 }).result, 'refuted');
});

test('출처 없는 reject 는 기각이 아니라 근거부족', () => {
  const r = decideCourt([gpt('reject'), claude('adopt')], { prosecution: 0, defense: 3 });
  assert.equal(r.result, 'unverifiable');
  assert.ok(r.reasons.includes('reject_without_evidence'));
});

test('판사 오류·불일치 → 근거부족·정지', () => {
  const r1 = decideCourt([gpt('adopt'), claude(undefined, { error: 'timeout' })], { prosecution: 0, defense: 3 });
  assert.deepEqual([r1.result, r1.decision], ['unverifiable', 'stop']);
  assert.ok(r1.reasons.includes('judge_error'));
  const r2 = decideCourt([gpt('adopt'), claude('insufficient')], { prosecution: 0, defense: 3 });
  assert.ok(r2.reasons.includes('judges_split_or_insufficient'));
});

test('family 없음·대소문자 변형은 다른 계열로 세지 않는다', () => {
  // 인용 조건(cited_defense·cited_defense_hosts)을 채워 계열 판정만으로 갈리게 한다(리뷰 r5 H-2 — 전엔 인용 부족으로 stop 이라 공허했다)
  const src = { prosecution: 0, defense: 2, cited_defense_hosts: 2 };
  const caseVariant = decideCourt([{ family: 'GPT', verdict: 'adopt', cited_defense: 1 }, { family: 'gpt', verdict: 'adopt', cited_defense: 1 }], src);
  assert.equal(caseVariant.decision, 'stop');
  assert.ok(caseVariant.reasons.includes('single_family'));
  const noFamily = decideCourt([{ verdict: 'adopt', cited_defense: 1 }, { family: 'claude', verdict: 'adopt', cited_defense: 1 }], src);
  assert.equal(noFamily.decision, 'stop');
  assert.ok(noFamily.reasons.includes('judge_error'));
  // 대조: 같은 입력에서 서로 다른 계열이면 진행 — 위 정지가 계열 판정 때문임을 보인다
  assert.equal(decideCourt([{ family: 'gpt', verdict: 'adopt', cited_defense: 1 }, { family: 'claude', verdict: 'adopt', cited_defense: 1 }], src).decision, 'proceed');
});

test('리뷰 43b5e7b H3: 검사·변호 어느 쪽 조사든 오류면 판사 만장일치여도 근거부족·정지', () => {
  for (const errs of [['prosecution_error'], ['defense_error'], ['prosecution_error', 'defense_error']]) {
    const r = decideCourt([gpt('adopt'), claude('adopt')], { prosecution: 0, defense: 2 }, errs);
    assert.deepEqual([r.result, r.decision], ['unverifiable', 'stop'], errs.join());
    assert.ok(r.reasons.includes('investigation_error'));
  }
});

test('리뷰 43b5e7b H5: 변호 출처를 인용하지 않은 adopt 는 채택이 아니다', () => {
  const r = decideCourt([gpt('adopt'), claude('adopt', { cited_defense: 0 })], { prosecution: 0, defense: 2 });
  assert.deepEqual([r.result, r.decision], ['unverifiable', 'stop']);
  assert.ok(r.reasons.includes('adopt_without_cited_defense_source'));
});

test('리뷰 94ef08a H-D: 판사들이 인용한 변호 출처 합집합의 독립 호스트가 2곳 미만이면 채택 아님(mid 보다 약하지 않게)', () => {
  for (const hosts of [0, 1, undefined]) {
    const r = decideCourt([gpt('adopt'), claude('adopt')], { prosecution: 0, defense: 1, cited_defense_hosts: hosts });
    assert.deepEqual([r.result, r.decision], ['unverifiable', 'stop'], String(hosts));
    assert.ok(r.reasons.includes('too_few_cited_defense_hosts'));
  }
});

test('리뷰 94ef08a H-E: reject 판사가 실제 검사 출처를 인용하지 않으면 기각 아님', () => {
  const r = decideCourt([gpt('reject', { cited_prosecution: 0 }), claude('adopt')], { prosecution: 2, defense: 2, cited_defense_hosts: 2 });
  assert.deepEqual([r.result, r.decision], ['unverifiable', 'stop']);
  assert.ok(r.reasons.includes('reject_without_cited_source'));
});
