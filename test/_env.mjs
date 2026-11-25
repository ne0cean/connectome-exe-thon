// 모든 테스트 파일이 맨 먼저 import 한다(레인 r7 L-SR-2 — 같은 계열 3회째라 env 를 하나씩 비우는 대신 구조로):
// 검증소가 읽는 env(VERIFIER_*·LINER_*)를 전부 지우고 verifier/.env 도 읽지 않게 해서, 판정이 개발 셸·.env 의 함수가 되지 않게 한다.
// 하위 프로세스(CLI·MCP)는 { ...process.env } 를 물려받으므로 같이 깨끗해진다. 필요한 값은 각 테스트가 명시적으로 넣는다.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(VERIFIER|LINER)_/.test(k)) delete process.env[k];
process.env.VERIFIER_NO_DOTENV = '1';
// 원장을 지정하지 않은 테스트가 운영 기본 원장(verifier/data/ledger.jsonl)에 쓰지 않게(8차 레인 L-SH-7)
process.env.VERIFIER_LEDGER = join(mkdtempSync(join(tmpdir(), 'ver-test-')), 'ledger.jsonl');
