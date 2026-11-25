#!/usr/bin/env node
// CLI:
//   verifier price "<상품>" <가격원> [--seller URL] [--visited URL,URL] [--nonce N] [--phase process|outcome] [--agent ID] [--irreversible] [--json]
//   verifier check <영수증.json> [--nonce N --item "<상품>" --price <원> --seller URL]   (결제 허가는 출력의 authorizes 만 본다 — 넷을 모두 주고 영수증과 일치할 때만 true)
//   사실 주장 위험도는 의뢰자 정책 env VERIFIER_POLICY(JSON 파일, 예 {"claim_domain":"general"}) — 없으면 법정(high)
//   verifier done "<산출물 제목>" <URL> [--phase process|outcome] [--agent ID] [--json]   (완료 주장: 그 URL 이 공개 웹에 제목과 함께 보이는가)
//   verifier balance            (Liner 잔액, liner 공급자일 때만)
import { readFileSync } from 'node:fs';
import { createVerifier, loadDotEnv } from '../src/index.mjs';

// 입력 오류 등은 스택트레이스 대신 한 줄로(레인 L-SH-12·L-SR-6)
process.on('uncaughtException', (e) => { console.error(`오류: ${e?.message ?? e}`); process.exit(1); });
loadDotEnv();
const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (['json', 'irreversible', 'citation'].includes(k)) flags[k] = true;
    // 값 없는 --nonce 가 무음으로 빠지거나 다음 플래그(--json)를 값으로 삼키지 않게(리뷰 94ef08a M-F)
    else if (i + 1 >= rest.length || rest[i + 1].startsWith('--')) { console.error(`--${k} 에 값이 필요합니다`); process.exit(1); }
    else flags[k] = rest[++i];
  } else pos.push(a);
}
const v = createVerifier({ onNotice: (m) => console.error(`[verifier] ${m}`) });

if (cmd === 'price') {
  const [item, price] = pos;
  if (!item || !price) { console.error('사용법: verifier price "<상품>" <가격원> [--seller URL] [--visited URL,URL] [--phase outcome]'); process.exit(1); }
  const out = await v.verifyPrice({
    claim: { item, price_krw: price, seller_url: flags.seller, request_nonce: flags.nonce },
    process: flags.visited ? { tool_calls: flags.visited.split(',').map((url) => ({ tool: 'browse', url })) } : undefined,
    phase: flags.phase ?? 'process',
    agentId: flags.agent,
    tierCtx: flags.irreversible ? { reversible: false } : undefined,
  });
  console.log(flags.json ? JSON.stringify(out.receipt, null, 2) : out.summary);
} else if (cmd === 'claim') {
  if (!pos[0]) { console.error('사용법: verifier claim "<주장>" [--citation] [--domain ...] [--phase outcome] [--json]'); process.exit(1); }
  const out = await v.verifyClaim({ statement: pos[0], citation: Boolean(flags.citation), domain: flags.domain, phase: flags.phase ?? 'process', agentId: flags.agent });
  console.log(flags.json ? JSON.stringify(out.receipt, null, 2) : out.summary);
} else if (cmd === 'court') {
  if (!pos[0]) { console.error('사용법: verifier court "<주장>" [--domain medical|legal|finance] [--phase outcome] [--json]'); process.exit(1); }
  const out = await v.courtClaim({ statement: pos[0], domain: flags.domain, phase: flags.phase ?? 'process', agentId: flags.agent });
  console.log(flags.json ? JSON.stringify(out.receipt, null, 2) : out.summary);
} else if (cmd === 'done') {
  if (!pos[0] || !pos[1]) { console.error('사용법: verifier done "<산출물 제목>" <URL> [--phase process] [--json]'); process.exit(1); }
  const out = await v.verifyDone({ task: pos[0], artifact_url: pos[1], phase: flags.phase ?? 'outcome', agentId: flags.agent });
  console.log(flags.json ? JSON.stringify(out.receipt, null, 2) : out.summary);
} else if (cmd === 'check') {
  const expected = flags.item !== undefined || flags.price !== undefined || flags.seller !== undefined ? { item: flags.item, price_krw: Number(String(flags.price ?? '').replaceAll(',', '')), seller_url: flags.seller } : undefined;
  console.log(JSON.stringify(v.checkReceipt(JSON.parse(readFileSync(pos[0], 'utf8')), { expectedNonce: flags.nonce, expected })));
} else if (cmd === 'rep') {
  console.log(JSON.stringify(v.reputation(pos[0]), null, 2));
} else if (cmd === 'balance') {
  console.log(JSON.stringify(await v.provider.balance()));
} else {
  console.error('명령: price | claim | court | done | rep | check | balance');
  process.exit(1);
}
