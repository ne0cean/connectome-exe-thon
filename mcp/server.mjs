#!/usr/bin/env node
// 검증소 MCP stdio 서버 — 의존성 0. MCP stdio 전송: 줄 단위 JSON-RPC 2.0, stdout 은 프로토콜 전용, 로그는 stderr.
// 도구: verify_price · verify_claim · court_claim · verify_done · check_receipt · agent_reputation · verifier_usage
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createVerifier, loadDotEnv } from '../src/index.mjs';

const SERVER_INFO = { name: 'agent-verifier', version: '0.1.0' };
export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const TOOLS = [
  {
    name: 'verify_price',
    description:
      '결제·추천 직전에 "최저가" 주장을 검증한다. phase=process 는 진행/정지 판정, phase=outcome 은 결과 영수증. ' +
      '작업 과정 기록(tool_calls: 본 판매처 URL 목록)을 주면 판매처를 충분히 비교했는지도 본다. 서명된 영수증을 돌려준다.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '상품명 (예: 에어팟 프로 3)' },
        price_krw: { type: 'number', description: '에이전트가 최저가라고 주장한 가격(원)' },
        seller_url: { type: 'string', description: '그 가격을 본 판매처 URL' },
        request_nonce: { type: 'string', description: '결제 요청 측이 준 1회용 값 — 영수증이 이 결제 건에만 쓰이게 묶는다' },
        phase: { type: 'string', enum: ['process', 'outcome'], default: 'process' },
        agent_id: { type: 'string' },
        reversible: { type: 'boolean', description: '되돌릴 수 있는 행동인가(기본 true)' },
        tool_calls: {
          type: 'array',
          description: '에이전트 작업 기록: 조회한 페이지들',
          items: { type: 'object', properties: { tool: { type: 'string' }, url: { type: 'string' } } },
        },
      },
      required: ['item', 'price_krw'],
    },
  },
  {
    name: 'verify_claim',
    description:
      '사실·인용 주장을 검증한다. 위험도는 검증소 운영자 정책(VERIFIER_POLICY)이 정한다 — 정책이 general 이면 mid(Liner AI 검색 → 판사 1명 → 채택 + 인용된 독립 출처 2곳 이상일 때만 확인), ' +
      '정책이 없거나 고위험이면 법정(court_claim). domain 은 등급을 올릴 수만 있다(medical/legal/finance 를 주면 법정).',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: '검증할 주장 한 문장' },
        citation: { type: 'boolean', description: '논문·연구 인용 주장인가' },
        domain: { type: 'string', enum: ['medical', 'legal', 'finance', 'other'], description: '올리기만 됨 — 운영자 정책보다 낮출 수 없다' },
        phase: { type: 'string', enum: ['process', 'outcome'], default: 'process' },
        agent_id: { type: 'string' },
      },
      required: ['statement'],
    },
  },
  {
    name: 'court_claim',
    description:
      '고위험 주장(의료·법률·금융, 큰 금액)을 법정 방식으로 검증한다: 검사(반증)·변호(근거) Deep Research → 서로 다른 계열 판사 2명 → 둘 다 채택하고 근거가 있을 때만 진행. 느리고 비싸다(건당 약 $0.45 — Deep Research 2건 $0.4 + 판사 토큰).',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: '검증할 주장 한 문장' },
        domain: { type: 'string', enum: ['medical', 'legal', 'finance', 'other'] },
        phase: { type: 'string', enum: ['process', 'outcome'], default: 'process' },
        agent_id: { type: 'string' },
      },
      required: ['statement'],
    },
  },
  {
    name: 'verify_done',
    description:
      '"게시했어요·배포했어요 — 여기 있어요(URL)" 완료 주장을 공개 웹 관측으로 확인한다: 검색 결과에 그 URL 이 실제로 나오고 제목이 과업을 가리킬 때만 확인. ' +
      '색인 전이면 확인불가(반박 아님). 한계: 이미 있던 남의 페이지도 확인된다 — 작성자·게시 시점은 증명하지 않는다.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '산출물 제목(과업을 가리키는 낱말)' },
        artifact_url: { type: 'string', description: '산출물의 공개 URL (http/https)' },
        phase: { type: 'string', enum: ['process', 'outcome'], default: 'outcome' },
        agent_id: { type: 'string' },
      },
      required: ['task', 'artifact_url'],
    },
  },
  {
    name: 'check_receipt',
    description: '검증소 영수증의 서명·무결성을 확인한다 (신뢰 목록 = 이 검증소의 공개키). expected_nonce 를 주면 그 결제 건에 묶인 영수증인지도 본다. ' +
      'valid 는 정지·사후 영수증에도 true 다 — 결제 허가는 authorizes 만 본다: 유효 + 과정 판정 + 진행 + 가격 영수증 + expected_nonce·expected_item·expected_price_krw·expected_seller_url 를 모두 주고 영수증과 일치 + 실조회 공급자. 하나라도 빠지면 false 이고 사유는 not_authorized 에 있다.',
    inputSchema: {
      type: 'object',
      properties: {
        receipt: { type: 'object' },
        expected_nonce: { type: 'string', description: '이 결제 건에 준 request_nonce — 주면 영수증의 nonce 와 다를 때 invalid(nonce_mismatch). 없으면 authorizes 는 항상 false' },
        expected_item: { type: 'string', description: '결제하려는 상품명 — 영수증의 주장과 같아야 authorizes' },
        expected_price_krw: { type: 'number', description: '결제하려는 금액(원) — 영수증의 주장가와 같아야 authorizes' },
        expected_seller_url: { type: 'string', description: '결제하려는 판매처 URL — 영수증의 판매처와 같은 사이트여야 authorizes' },
      },
      required: ['receipt'],
    },
  },
  {
    name: 'agent_reputation',
    description: '원장의 서명 유효 영수증으로 에이전트별 정확도(확인/(확인+반박))·정지 횟수·단계별 건수를 집계한다.',
    inputSchema: { type: 'object', properties: { agent_id: { type: 'string', description: '없으면 전체' } } },
  },
  {
    name: 'verifier_usage',
    description: '이 서버가 기동 후 쓴 API 별 호출 수와 비용(USD).',
    inputSchema: { type: 'object', properties: {} },
  },
];

// 검증 대상 에이전트에게 공급자 오류 본문을 넘기지 않는다(리뷰 M10) — 입력 오류만 그대로, 나머지는 일반화.
class InputError extends Error {}

export function createHandler(verifier, { log = () => {} } = {}) {
  async function callTool(name, args = {}) {
    if (name === 'verify_price') {
      if (!args || typeof args.item !== 'string' || !args.item || args.price_krw === undefined) throw new InputError('item(문자열)과 price_krw 가 필요합니다');
      if (args.agent_id !== undefined && (typeof args.agent_id !== 'string' || args.agent_id.length > 100)) throw new InputError('agent_id 는 100자 이하 문자열이어야 합니다');
      // nonce 를 줬는데 문자열이 아니면 조용히 버리지 않는다 — 묶이지 않은 proceed 영수증이 나가면 안 된다(리뷰 43b5e7b H8)
      if (args.request_nonce !== undefined && (typeof args.request_nonce !== 'string' || !args.request_nonce.trim())) throw new InputError('request_nonce 는 비어 있지 않은 문자열이어야 합니다');
      const out = await verifier.verifyPrice({
        claim: { item: args.item, price_krw: args.price_krw, seller_url: args.seller_url, request_nonce: args.request_nonce },
        process: args.tool_calls ? { tool_calls: args.tool_calls } : undefined,
        phase: args.phase ?? 'process',
        agentId: args.agent_id,
        tierCtx: args.reversible === false ? { reversible: false } : undefined,
      });
      return { summary: out.summary, receipt: out.receipt };
    }
    if (name === 'court_claim' || name === 'verify_claim') {
      if (!args || typeof args.statement !== 'string' || !args.statement.trim()) throw new InputError('statement(문자열)가 필요합니다');
      if (args.phase !== undefined && !['process', 'outcome'].includes(args.phase)) throw new InputError('phase 는 process|outcome');
      const input = { statement: args.statement, domain: args.domain, phase: args.phase ?? 'process', agentId: args.agent_id };
      const out = name === 'court_claim' ? await verifier.courtClaim(input) : await verifier.verifyClaim({ ...input, citation: args.citation === true });
      return { summary: out.summary, receipt: out.receipt };
    }
    if (name === 'verify_done') {
      if (!args || typeof args.task !== 'string' || !args.task.trim() || args.task.length > 300 || typeof args.artifact_url !== 'string' || args.artifact_url.length > 2000) throw new InputError('task(300자 이하 문자열)와 artifact_url(문자열)이 필요합니다');
      if (args.phase !== undefined && !['process', 'outcome'].includes(args.phase)) throw new InputError('phase 는 process|outcome');
      if (args.agent_id !== undefined && (typeof args.agent_id !== 'string' || args.agent_id.length > 100)) throw new InputError('agent_id 는 100자 이하 문자열이어야 합니다');
      const out = await verifier.verifyDone({ task: args.task, artifact_url: args.artifact_url, phase: args.phase ?? 'outcome', agentId: args.agent_id });
      return { summary: out.summary, receipt: out.receipt };
    }
    if (name === 'check_receipt') {
      if (!args?.receipt || typeof args.receipt !== 'object') throw new InputError('receipt 객체가 필요합니다');
      if (args.expected_nonce !== undefined && typeof args.expected_nonce !== 'string') throw new InputError('expected_nonce 는 문자열이어야 합니다');
      const given = [args.expected_item, args.expected_price_krw, args.expected_seller_url].filter((x) => x !== undefined).length;
      if (given && (typeof args.expected_item !== 'string' || !Number.isSafeInteger(args.expected_price_krw) || typeof args.expected_seller_url !== 'string')) throw new InputError('expected_item(문자열)·expected_price_krw(정수)·expected_seller_url(문자열)은 셋을 함께 줘야 합니다');
      return verifier.checkReceipt(args.receipt, { expectedNonce: args.expected_nonce, expected: given ? { item: args.expected_item, price_krw: args.expected_price_krw, seller_url: args.expected_seller_url } : undefined });
    }
    if (name === 'verifier_usage') return verifier.usage();
    if (name === 'agent_reputation') return verifier.reputation(typeof args?.agent_id === 'string' ? args.agent_id : undefined);
    throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  }

  return async function handle(msg) {
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
      return { jsonrpc: '2.0', id: msg && typeof msg === 'object' && !Array.isArray(msg) ? msg.id ?? null : null, error: { code: -32600, message: 'invalid request' } };
    }
    const { id, method, params } = msg;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (id === undefined) return null; // 알림(notifications/initialized 등)은 응답하지 않는다
    try {
      switch (method) {
        case 'initialize': {
          const want = params?.protocolVersion;
          const protocolVersion = SUPPORTED_PROTOCOLS.includes(want) ? want : SUPPORTED_PROTOCOLS[0];
          return reply({ protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
        }
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools: TOOLS });
        case 'tools/call': {
          try {
            const data = await callTool(params?.name, params?.arguments);
            return reply({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
          } catch (e) {
            if (e.code === -32602) return fail(-32602, e.message);
            // 도구 실행 오류는 프로토콜 오류가 아니라 isError 결과로 돌려 에이전트가 읽게 한다.
            // 입력 오류(검증소가 만든 문구)만 그대로, 그 밖은 stderr 로만 남기고 일반 문구로.
            const text = e instanceof InputError || /^claim[ :]|^phase /.test(e.message) ? `입력 오류: ${e.message}` : '검증 실패: internal_error';
            if (!(e instanceof InputError)) log(`tools/call ${params?.name} 실패: ${e.message}`);
            return reply({ content: [{ type: 'text', text }], isError: true });
          }
        }
        default:
          return fail(-32601, `method not found: ${method}`);
      }
    } catch (e) {
      return fail(-32603, e.message);
    }
  };
}

// bin 심링크(verifier-mcp)로 실행돼도 진입점으로 인식하도록 실경로로 비교한다(리뷰 M6).
function isMain() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) {
  loadDotEnv();
  const log = (m) => process.stderr.write(`[verifier] ${m}\n`);
  const verifier = createVerifier({ onNotice: log });
  log(`MCP stdio ready · provider=${verifier.provider.name}`);
  const handle = createHandler(verifier, { log });
  const write = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    try {
      let msg;
      try { msg = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
      const out = await handle(msg);
      if (out) write(out);
    } catch (e) {
      // 어떤 한 줄도 서버를 죽이지 못한다(리뷰 M5)
      log(`line 처리 실패: ${e.message}`);
      write({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } });
    }
  });
}
