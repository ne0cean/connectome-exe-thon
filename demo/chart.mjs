// 집계 숫자를 Liner Visualization API 로 차트(HTML 한 벌)로 만든다.
// 쓰는 법: node demo/chart.mjs --out docs/charts/x.html --title "제목" 확인=35 반박=54 확인불가=25
// 차트는 모델이 그리므로, 넘긴 숫자가 결과 HTML 에 전부 들어 있는지 확인하고 하나라도 빠지면 저장하지 않는다.
// 검색을 붙이지 않는 모드만 쓴다(넘긴 숫자만으로 그린다 — 검색 원문이 결과에 섞이지 않는다).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDotEnv } from '../src/index.mjs';

const BASE = 'https://platform.liner.com/api/v1';

export function parseArgs(argv) {
  const o = { out: null, title: null, kind: '막대', pairs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--title') o.title = argv[++i];
    else if (a === '--kind') o.kind = argv[++i];
    else {
      const k = a.lastIndexOf('=');
      const v = Number(a.slice(k + 1));
      if (k < 1 || !Number.isFinite(v)) throw new Error(`알아볼 수 없는 인자: ${a} (이름=숫자 꼴이어야 합니다)`);
      o.pairs.push([a.slice(0, k), v]);
    }
  }
  if (!o.out || !o.title || o.pairs.length === 0) throw new Error('--out, --title, 이름=숫자 가 필요합니다');
  return o;
}

export function buildQuery({ title, kind, pairs }) {
  const rows = pairs.map(([k, v]) => `${k}: ${v}`).join(', ');
  return `다음 표를 ${kind} 차트 하나로 그려 주세요. 표에 없는 숫자나 항목을 더하지 말고, 값을 그대로 표시해 주세요. 제목은 "${title}". 표 — ${rows}`;
}

// SSE 본문에서 차트 HTML 을 꺼낸다. 오류 조각이 있으면 던진다.
export function readAtlas(sse) {
  for (const line of String(sse).split('\n')) {
    if (!line.startsWith('data:')) continue;
    const body = line.slice(5).trim();
    if (body === '[DONE]') continue;
    let j;
    try { j = JSON.parse(body); } catch { continue; }
    if (j.type === 'data-error') throw new Error(`차트 생성 거부: ${JSON.stringify(j.data ?? j).slice(0, 200)}`);
    if (j.type === 'data-atlas' && j.data?.atlasArtifact?.html) return j.data.atlasArtifact;
  }
  throw new Error('응답에 차트가 없습니다');
}

// 넘긴 숫자 가운데 HTML 에 통째로 나오지 않는 것(앞뒤가 숫자·소수점이 아닌 자리).
export function missingNumbers(html, pairs) {
  return pairs.filter(([, v]) => !new RegExp(`(?<![\\d.])${String(v).replace('.', '\\.')}(?![\\d.]*\\d)`).test(html));
}

export async function makeChart(opt, { apiKey = process.env.LINER_API_KEY, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error('LINER_API_KEY 가 없습니다');
  const res = await fetchImpl(`${BASE}/tools/visualization`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ query: buildQuery(opt) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Visualization API ${res.status}: ${text.slice(0, 200)}`);
  const atlas = readAtlas(text);
  const missing = missingNumbers(atlas.html, opt.pairs);
  if (missing.length) throw new Error(`차트에 빠진 값: ${missing.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return atlas;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  loadDotEnv();
  const opt = parseArgs(process.argv.slice(2));
  const atlas = await makeChart(opt);
  mkdirSync(dirname(opt.out), { recursive: true });
  writeFileSync(opt.out, atlas.html);
  console.log(`차트 저장: ${opt.out} (${atlas.html.length}자, 값 ${opt.pairs.length}개 대조 통과)`);
}
