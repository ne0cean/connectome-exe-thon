import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, buildQuery, readAtlas, missingNumbers, makeChart } from '../demo/chart.mjs';

const sse = (html) => [
  ':ping', '', 'event:data', 'data:{"type":"start"}', '', 'event:data',
  `data:${JSON.stringify({ type: 'data-atlas', data: { atlasArtifact: { html, theme: 'distribution' } } })}`,
  '', 'data:[DONE]',
].join('\n');
const fakeFetch = (body, ok = true, status = 200) => async () => ({ ok, status, text: async () => body });

test('chart: 인자 — 이름=숫자, 이름에 = 가 있어도 마지막 = 로 나눈다', () => {
  const o = parseArgs(['--out', 'x.html', '--title', '제목', '확인=35', 'a=b=2.5']);
  assert.deepEqual(o.pairs, [['확인', 35], ['a=b', 2.5]]);
  assert.throws(() => parseArgs(['--out', 'x', '--title', 't', '확인=많음']), /알아볼 수 없는 인자/);
  assert.throws(() => parseArgs(['--title', 't', 'a=1']), /필요합니다/);
});

test('chart: 질의에 제목과 값이 그대로 들어간다', () => {
  const q = buildQuery({ title: '분포', kind: '막대', pairs: [['확인', 35], ['반박', 54]] });
  assert.match(q, /"분포"/);
  assert.match(q, /확인: 35, 반박: 54/);
});

test('chart: SSE 에서 차트 HTML 을 꺼낸다 (data: 뒤 공백 유무 모두)', () => {
  assert.equal(readAtlas(sse('<p>35</p>')).html, '<p>35</p>');
  assert.equal(readAtlas(sse('<p>1</p>').replaceAll('data:{', 'data: {')).html, '<p>1</p>');
  assert.throws(() => readAtlas('data:{"type":"finish"}\ndata:[DONE]'), /차트가 없습니다/);
  assert.throws(() => readAtlas('data:{"type":"data-error","data":{"code":"moderation"}}'), /차트 생성 거부/);
});

test('chart: 빠진 값 찾기 — 다른 숫자의 일부로만 나오면 빠진 것', () => {
  assert.deepEqual(missingNumbers('값 35건, 54건', [['a', 35], ['b', 54]]), []);
  assert.deepEqual(missingNumbers('값 135건, 3.54', [['a', 35], ['b', 54]]).map((p) => p[0]), ['a', 'b']);
  assert.deepEqual(missingNumbers('값 350', [['a', 35]]).map((p) => p[0]), ['a']);
  assert.deepEqual(missingNumbers('비율 47.4%', [['a', 47.4]]), []);
  assert.deepEqual(missingNumbers('비율 47.45%', [['a', 47.4]]).map((p) => p[0]), ['a']);
  assert.deepEqual(missingNumbers('[35, 54]', [['a', 35], ['b', 54]]), []);
});

test('chart: 값이 빠진 차트는 실패, 키 없음·HTTP 오류도 실패', async () => {
  const opt = { title: 't', kind: '막대', pairs: [['a', 35], ['b', 54]] };
  const ok = await makeChart(opt, { apiKey: 'k', fetchImpl: fakeFetch(sse('<i>35</i><i>54</i>')) });
  assert.match(ok.html, /35/);
  await assert.rejects(makeChart(opt, { apiKey: 'k', fetchImpl: fakeFetch(sse('<i>35</i><i>55</i>')) }), /빠진 값: b=54/);
  await assert.rejects(makeChart(opt, { apiKey: '', fetchImpl: fakeFetch('') }), /LINER_API_KEY/);
  await assert.rejects(makeChart(opt, { apiKey: 'k', fetchImpl: fakeFetch('no', false, 402) }), /402/);
});
