import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, lstatSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLinerProvider } from '../src/providers/liner.mjs';
import { createMockProvider } from '../src/providers/mock.mjs';
import { generateSigner } from '../src/receipt/keys.mjs';
import { createVerifier, loadDotEnv, fromRoot, loadPolicy } from '../src/index.mjs';
import { createProvider } from '../src/providers/index.mjs';
import { createHandler, TOOLS, SUPPORTED_PROTOCOLS } from '../mcp/server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── Liner 어댑터: 가짜 fetch 로 요청 모양·SSE 파싱만 검사 (외부 호출 0) ──
function fakeFetch(handler) {
  const seen = [];
  const f = async (url, init = {}) => { seen.push({ url, init }); return handler(url, init); };
  f.seen = seen;
  return f;
}
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const sse = (lines) => new Response(lines.map((l) => `data: ${l}\n`).join(''), { status: 200 });

test('liner web: 엔드포인트·헤더·include_knowledge=false, 미터 기록', async () => {
  const f = fakeFetch(() => json({ results: [{ title: 't', url: 'https://x.example' }] }));
  const p = createLinerProvider({ apiKey: 'k-test', baseUrl: 'https://api.test', fetchImpl: f });
  const r = await p.web('q', { max: 3 });
  assert.equal(r.results.length, 1);
  assert.equal(f.seen[0].url, 'https://api.test/tools/search/web');
  assert.equal(f.seen[0].init.headers['x-api-key'], 'k-test');
  assert.deepEqual(JSON.parse(f.seen[0].init.body), { query: 'q', max_results: 3, include_knowledge: false });
  assert.deepEqual(p.meter.snapshot(), { calls: { 'search.web': 1 }, usd: 0.001 });
});

test('liner quick: SSE text-delta·references 누적, [DONE] 에서 종료', async () => {
  const f = fakeFetch(() => sse([
    JSON.stringify({ type: 'text-delta', delta: '최저 ' }),
    JSON.stringify({ type: 'data-search-references', data: { references: [{ url: 'https://a.example', title: 'A' }, { url: 'https://a.example' }] } }),
    JSON.stringify({ type: 'text-delta', delta: '287,490원' }),
    '[DONE]',
  ]));
  const p = createLinerProvider({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl: f });
  const out = await p.quick('q');
  assert.equal(out.answer, '최저 287,490원');
  assert.equal(out.references.length, 1);
  assert.equal(f.seen[0].url, 'https://api.test/agents/quick-answer');
  assert.equal(JSON.parse(f.seen[0].init.body).stream, true);
});

test('liner: data-error·[DONE] 누락·HTTP 오류·키 없음은 실패', async () => {
  const mk = (h) => createLinerProvider({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl: fakeFetch(h) });
  await assert.rejects(mk(() => sse([JSON.stringify({ type: 'data-error', data: { code: 'X', message: 'boom' } })])).search('q'), /boom/);
  await assert.rejects(mk(() => sse([JSON.stringify({ type: 'text-delta', delta: 'a' })])).deep('q'), /DONE/);
  await assert.rejects(mk(() => new Response('nope', { status: 401 })).web('q'), /401/);
  assert.throws(() => createLinerProvider({ apiKey: '' }), /LINER_API_KEY/);
});

test('liner balance: balance_usd 문자열 파싱', async () => {
  const p = createLinerProvider({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl: fakeFetch(() => json({ balance: 196970593, balance_usd: '196.970593' })) });
  assert.deepEqual(await p.balance(), { usd: 196.970593 });
});

// ── MCP ──
const tmp = mkdtempSync(join(tmpdir(), 'verifier-test-'));
process.env.VERIFIER_POLICY = '';
process.env.VERIFIER_AUTHORIZE_PROVIDERS = ''; // 레인 r6 L-SR-2: 시연용 env 가 셸에 있어도 테스트 결과가 바뀌지 않게 // 레인 L-SH-6: 개발 셸·verifier/.env 의 정책이 테스트 결과를 바꾸지 않게(하위 프로세스에도 빈 값으로 전달)
const mkVerifier = () => createVerifier({ provider: createMockProvider(), signer: generateSigner(), ledgerPath: join(tmp, 'ledger.jsonl'), authorizeProviders: ['mock'] });
const core3 = ({ valid, reasons, authorizes }) => ({ valid, reasons, authorizes });
const EXPECT = { expected_item: '에어팟 프로 3', expected_price_krw: 287490, expected_seller_url: 'https://compare-a.example/a' };

test('MCP 핸들러: initialize·tools/list·tools/call·알림 무응답·없는 메서드', async () => {
  const h = createHandler(mkVerifier());
  const init = await h({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  assert.equal(await h({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await h({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  const call = await h({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'verify_price', arguments: { item: '에어팟 프로 3', price_krw: 299000 } } });
  assert.equal(call.result.structuredContent.receipt.verdict.result, 'refuted');
  const chk = await h({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'check_receipt', arguments: { receipt: call.result.structuredContent.receipt } } });
  // 리뷰 94ef08a H-F: 정지 영수증도 valid 지만 결제 허가(authorizes)는 아니다
  assert.deepEqual([chk.result.structuredContent.valid, chk.result.structuredContent.authorizes], [true, false]);
  const bad = await h({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'verify_price', arguments: { item: '' , price_krw: 0 } } });
  assert.equal(bad.result.isError, true);
  assert.equal((await h({ jsonrpc: '2.0', id: 6, method: 'nope' })).error.code, -32601);
});

test('MCP 핸들러: 잘못된 요청 모양은 -32600, 모르는 protocolVersion 은 지원 목록 최신으로', async () => {
  const h = createHandler(mkVerifier());
  for (const bad of [null, 1, 'x', [], { id: 1 }]) assert.equal((await h(bad)).error.code, -32600);
  const init = await h({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-bogus' } });
  assert.equal(init.result.protocolVersion, SUPPORTED_PROTOCOLS[0]);
});

test('MCP 핸들러: 공급자 오류 문구는 에이전트에게 넘기지 않는다', async () => {
  const v = mkVerifier();
  v.verifyPrice = async () => { throw new Error('Liner 500 secret-ish body'); };
  const logs = [];
  const h = createHandler(v, { log: (m) => logs.push(m) });
  const r = await h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verify_price', arguments: { item: 'x', price_krw: 1 } } });
  assert.equal(r.result.isError, true);
  assert.doesNotMatch(r.result.content[0].text, /secret/);
  assert.match(logs[0], /secret/);
});

test('MCP stdio 서버: 실제 프로세스로 줄 단위 JSON-RPC 왕복 + 원장 기록 + null 줄에 안 죽음 + 심링크 실행', { timeout: 15_000 }, async () => {
  const link = join(tmp, 'verifier-mcp');
  symlinkSync(join(ROOT, 'mcp/server.mjs'), link);
  const ledger = join(tmp, 'stdio-ledger.jsonl');
  const child = spawn(process.execPath, [link], {
    env: { ...process.env, VERIFIER_PROVIDER: 'mock', LINER_API_KEY: '', VERIFIER_LEDGER: ledger, VERIFIER_KEY_FILE: join(tmp, 'k.json') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  let buf = '';
  const got = new Promise((res) => child.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
    if (lines.length >= 5) res();
  }));
  const send = (o) => child.stdin.write(`${typeof o === 'string' ? o : JSON.stringify(o)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send('null');
  send('{not json');
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'verify_price', arguments: { item: '에어팟 프로 3', price_krw: 287490, seller_url: 'https://compare-a.example/a', tool_calls: [{ url: 'https://compare-a.example/a' }, { url: 'https://shop-b.example/b' }] } } });
  await got;
  child.kill();
  const byId = Object.fromEntries(lines.filter((l) => l.id !== null).map((l) => [l.id, l]));
  assert.deepEqual(lines.filter((l) => l.id === null).map((l) => l.error.code).sort((a, b) => a - b), [-32700, -32600]);
  assert.equal(byId[1].result.serverInfo.name, 'agent-verifier');
  assert.equal(byId[3].result.structuredContent.receipt.verdict.decision, 'proceed');
  assert.equal(readFileSync(ledger, 'utf8').trim().split('\n').length, 1);
});

test('CLI: price 는 영수증 JSON, check 는 그 영수증을 유효로 판정', { timeout: 15_000 }, () => {
  const env = { ...process.env, VERIFIER_PROVIDER: 'mock', LINER_API_KEY: '', VERIFIER_LEDGER: join(tmp, 'cli.jsonl'), VERIFIER_KEY_FILE: join(tmp, 'cli-key.json') };
  const run = (args) => spawnSync(process.execPath, [join(ROOT, 'bin/verifier.mjs'), ...args], { env, encoding: 'utf8' });
  const p = run(['price', '에어팟 프로 3', '299,000', '--seller', 'https://shop-b.example/ap3', '--visited', 'https://shop-b.example/ap3', '--json']);
  assert.equal(p.status, 0, p.stderr);
  const receipt = JSON.parse(p.stdout);
  assert.equal(receipt.verdict.result, 'refuted');
  const f = join(tmp, 'r.json');
  writeFileSync(f, p.stdout);
  assert.deepEqual(core3(JSON.parse(run(['check', f]).stdout)), { valid: true, reasons: [], authorizes: false });
  assert.notEqual(run(['nope']).status, 0);
});

test('리뷰 43b5e7b H8 배선: MCP verify_price 의 nonce 가 영수증에 묶이고, 문자열 아닌 nonce 는 거절, check_receipt 가 nonce 를 대조', async () => {
  const h = createHandler(mkVerifier());
  const args = { item: '에어팟 프로 3', price_krw: 287490, seller_url: 'https://compare-a.example/a', tool_calls: [{ url: 'https://compare-a.example/a' }, { url: 'https://shop-b.example/b' }] };
  const call = (id, name, a) => h({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: a } });
  const ok = await call(1, 'verify_price', { ...args, request_nonce: 'pay-123' });
  const receipt = ok.result.structuredContent.receipt;
  assert.deepEqual([receipt.claim.request_nonce, receipt.verdict.decision], ['pay-123', 'proceed']);
  for (const bad of [123, { n: 1 }, '', null, true]) {
    const r = await call(2, 'verify_price', { ...args, request_nonce: bad });
    assert.equal(r.result.isError, true, JSON.stringify(bad));
    assert.match(r.result.content[0].text, /request_nonce/);
  }
  const same = await call(3, 'check_receipt', { receipt, expected_nonce: 'pay-123', ...EXPECT });
  assert.deepEqual(same.result.structuredContent, { valid: true, reasons: [], authorizes: true, not_authorized: [] });
  const other = await call(4, 'check_receipt', { receipt, expected_nonce: 'pay-999' });
  assert.deepEqual(core3(other.result.structuredContent), { valid: false, reasons: ['nonce_mismatch'], authorizes: false });
  // 리뷰 94ef08a H-F: 같은 nonce 로 묶인 사후(outcome) 영수증·정지 영수증은 valid 여도 허가가 아니다
  const outcome = (await call(8, 'verify_price', { ...args, request_nonce: 'pay-123', phase: 'outcome' })).result.structuredContent.receipt;
  assert.deepEqual(core3((await call(9, 'check_receipt', { receipt: outcome, expected_nonce: 'pay-123', ...EXPECT })).result.structuredContent), { valid: true, reasons: [], authorizes: false });
  const stop = (await call(10, 'verify_price', { ...args, price_krw: 299000, request_nonce: 'pay-124' })).result.structuredContent.receipt;
  assert.deepEqual(core3((await call(11, 'check_receipt', { receipt: stop, expected_nonce: 'pay-124', ...EXPECT, expected_price_krw: 299000 })).result.structuredContent), { valid: true, reasons: [], authorizes: false });
  const unbound = await call(5, 'verify_price', args);
  assert.equal((await call(6, 'check_receipt', { receipt: unbound.result.structuredContent.receipt, expected_nonce: 'pay-123' })).result.structuredContent.valid, false);
  assert.equal((await call(7, 'check_receipt', { receipt, expected_nonce: 5 })).result.isError, true);
});

test('리뷰 43b5e7b H8 배선: CLI --nonce 가 영수증에 묶이고 check --nonce 가 대조, 값 없는 --nonce 는 거절', { timeout: 15_000 }, () => {
  const env = { ...process.env, VERIFIER_PROVIDER: 'mock', LINER_API_KEY: '', VERIFIER_LEDGER: join(tmp, 'cli-n.jsonl'), VERIFIER_KEY_FILE: join(tmp, 'cli-n-key.json'), VERIFIER_AUTHORIZE_PROVIDERS: 'mock' };
  const exp = ['--item', '에어팟 프로 3', '--price', '287490', '--seller', 'https://compare-a.example/a'];
  const run = (args) => spawnSync(process.execPath, [join(ROOT, 'bin/verifier.mjs'), ...args], { env, encoding: 'utf8' });
  const p = run(['price', '에어팟 프로 3', '287490', '--seller', 'https://compare-a.example/a', '--visited', 'https://compare-a.example/a,https://shop-b.example/b', '--nonce', 'cli-7', '--json']);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(JSON.parse(p.stdout).claim.request_nonce, 'cli-7');
  const f = join(tmp, 'rn.json');
  writeFileSync(f, p.stdout);
  assert.deepEqual(JSON.parse(run(['check', f, '--nonce', 'cli-7', ...exp]).stdout), { valid: true, reasons: [], authorizes: true, not_authorized: [] });
  assert.deepEqual(JSON.parse(run(['check', f, '--nonce', 'cli-7']).stdout).authorizes, false); // 기대 주장 없이는 허가 아님(r5)
  assert.deepEqual(core3(JSON.parse(run(['check', f, '--nonce', 'other', ...exp]).stdout)), { valid: false, reasons: ['nonce_mismatch'], authorizes: false });
  assert.notEqual(run(['price', '에어팟 프로 3', '287490', '--nonce']).status, 0);
  // 리뷰 94ef08a M-F: --nonce 뒤가 다른 플래그면 값으로 삼키지 않고 오류
  for (const args of [['check', f, '--nonce', '--json'], ['price', '에어팟 프로 3', '287490', '--nonce', '--json']]) {
    const r = run(args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr, /--nonce 에 값이 필요합니다/);
  }
});

test('의장 결정 D1: VERIFIER_POLICY 파일 읽기 — 없으면 {}(법정 기본), 형식·값이 틀리면 기동 거절', () => {
  assert.deepEqual(loadPolicy(''), {});
  const good = join(tmp, 'policy.json');
  writeFileSync(good, JSON.stringify({ claim_domain: 'general' }));
  assert.deepEqual(loadPolicy(good), { claim_domain: 'general' });
  const bad = join(tmp, 'policy-bad.json');
  writeFileSync(bad, JSON.stringify({ claim_domain: 'genral' }));
  assert.throws(() => loadPolicy(bad), /claim_domain/);
  writeFileSync(bad, '{nope');
  assert.throws(() => loadPolicy(bad), /VERIFIER_POLICY/);
  assert.throws(() => loadPolicy(join(tmp, 'missing.json')), /VERIFIER_POLICY/);
  assert.throws(() => createVerifier({ provider: createMockProvider(), signer: generateSigner(), ledgerPath: null, policy: { claim_domain: 'x' } }), /claim_domain/);
});

test('리뷰 94ef08a L-SR-4: VERIFIER_PROVIDER=liner 인데 키가 없으면 mock-fallback 으로 이름을 남기고 경고', () => {
  const notes = [];
  const p = createProvider({ name: 'liner', env: {}, onNotice: (m) => notes.push(m) });
  assert.equal(p.name, 'mock-fallback');
  assert.match(notes[0], /경고/);
});

test('loadDotEnv:미정의만 채움(빈 문자열 명시는 존중), 인라인 주석 제거 / 상대 키 경로는 verifier/ 기준', () => {
  const f = join(tmp, '.env');
  writeFileSync(f, 'A_KEY=val # 주석\nB_KEY="q v" # c\nC_KEY=keep\n');
  const env = { C_KEY: '' };
  loadDotEnv(f, env);
  assert.deepEqual(env, { A_KEY: 'val', B_KEY: 'q v', C_KEY: '' });
  assert.equal(fromRoot('.keys/issuer.json'), join(ROOT, '.keys/issuer.json'));
});

// ── 자기완결: verifier/ 밖 import 0건, 외부 패키지 0건, 밖을 가리키는 심링크 0건 ──
const REAL_ROOT = realpathSync(ROOT);
function* walk(dir) {
  for (const n of readdirSync(dir)) {
    if (['node_modules', '.keys', 'data', '.git'].includes(n)) continue;
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) { yield { symlink: p }; continue; }
    if (st.isDirectory()) yield* walk(p);
    else if (p.endsWith('.mjs') || p.endsWith('.js') || p.endsWith('.cjs')) yield { file: p };
  }
}
const CREATE_REQ = new RegExp(`\\bcreate${'Require'}\\b`); // 이 파일 자신이 걸리지 않게 조립
const SPEC_RE =/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*|\brequire\s*\(\s*)(['"`])([^'"`]+)\1/gm;
test('자기완결: import·export from·require 는 node: 내장이거나 verifier/ 안 상대경로, 동적 지정자 금지', () => {
  const bad = [];
  for (const e of walk(ROOT)) {
    if (e.symlink) {
      const target = realpathSync(e.symlink);
      if (relative(REAL_ROOT, target).startsWith('..')) bad.push(`symlink ${relative(ROOT, e.symlink)} → 밖`);
      continue;
    }
    const src = readFileSync(e.file, 'utf8');
    for (const m of src.matchAll(SPEC_RE)) {
      const spec = m[2];
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.') && !spec.includes('${') && !relative(ROOT, resolve(dirname(e.file), spec)).startsWith('..')) continue;
      bad.push(`${relative(ROOT, e.file)} → ${spec}`);
    }
    // 문자열 리터럴이 아닌 동적 import, 그리고 모듈 require 생성기는 정적으로 검사할 수 없으니 금지
    if (/\bimport\s*\(\s*[^'"`\s]/.test(src) || CREATE_REQ.test(src)) bad.push(`${relative(ROOT, e.file)} → 동적 import/require`);
  }
  assert.deepEqual(bad, []);
});

test('자기완결: package.json 에 의존성 없음', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) assert.equal(pkg[k], undefined, k);
});

test('자기완결 검사기 자체: export from·require·밖 상대경로를 잡는다', () => {
  // 표본은 조립해서 만든다 — 리터럴로 두면 위 검사가 이 파일을 잡는다
  const F = 'fr' + 'om';
  const R = 'requ' + 'ire';
  const sample = `export { a } ${F} "../../lib/x.mjs";\nexport * ${F} 'lodash';\nconst r = ${R}('fs-extra');\nimport x ${F} './ok.mjs';`;
  assert.deepEqual([...sample.matchAll(SPEC_RE)].map((m) => m[2]), ['../../lib/x.mjs', 'lodash', 'fs-extra', './ok.mjs']);
});
