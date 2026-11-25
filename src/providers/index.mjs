// 공급자 선택: VERIFIER_PROVIDER=liner|mock. liner 인데 키가 없으면 mock 으로 내려가고 그 사실을 알린다.
// 내려간 공급자 이름은 'mock-fallback' — 실제 키로 서명돼도 영수증 method.provider 에서 실조회가 아니었음이 드러난다(리뷰 94ef08a L-SR-4).
import { createLinerProvider, DEFAULT_BASE } from './liner.mjs';
import { createMockProvider } from './mock.mjs';
import { createLinerModel, createMockModel } from './liner-model.mjs';

/** 판사 모델: 검색 공급자와 같은 쪽(mock↔mock, liner↔liner)·같은 미터로 묶는다 — 사용 집계가 한 곳에 모인다. */
// 판사도 공급자와 같은 키·주소·타임아웃으로 만든다(9차 L-SH-5 · 10차 L-SH-5: 검색은 주입 키로, 판사는 셸 키로 나가던 것). 설정은 공급자 객체가 싣고 다닌다.
export function createModelFor(provider, { env } = {}) {
  if (provider.name === 'liner') {
    const c = env ? { apiKey: env.LINER_API_KEY, baseUrl: env.LINER_BASE_URL || DEFAULT_BASE, timeoutMs: env.LINER_TIMEOUT_MS } : provider.config;
    if (!c?.apiKey) throw new Error('createModelFor: liner 공급자에 설정(키)이 없습니다 — createProvider/createLinerProvider 가 만든 객체를 그대로 넘기거나 LINER_API_KEY 가 든 env 를 주세요'); // 조용히 셸 키로 떨어지지 않는다(11차 L2: 키 없는 env 포함)
    return createLinerModel({ ...c, timeoutMs: c.timeoutMs ?? null, meter: provider.meter });
  }
  return createMockModel({ meter: provider.meter });
}

export function createProvider({ env = process.env, name = env.VERIFIER_PROVIDER, onNotice = () => {} } = {}) {
  // 이름·키·주소·타임아웃을 모두 주입된 env 에서 읽는다 — 없는 값은 null 로 넘겨 하위 생성자가 process.env 로 되돌아가지 않게(레인 r7 L-SR-2·r8 L-SH-6)
  const want = name || (env.LINER_API_KEY ? 'liner' : 'mock');
  if (want === 'mock') {
    if (!name) onNotice('알림: LINER_API_KEY·VERIFIER_PROVIDER 없음 → mock 공급자(가상 표본)로 실행 — 영수증은 실조회가 아니며 결제 허가(authorizes)가 되지 않음');
    return createMockProvider();
  }
  if (want === 'liner') {
    if (!env.LINER_API_KEY) { onNotice('경고: LINER_API_KEY 없음 → mock 공급자(mock-fallback)로 실행 — 영수증은 실조회가 아님'); return createMockProvider({ name: 'mock-fallback' }); }
    return createLinerProvider({ apiKey: env.LINER_API_KEY, baseUrl: env.LINER_BASE_URL || DEFAULT_BASE, timeoutMs: env.LINER_TIMEOUT_MS ?? null });
  }
  throw new Error(`알 수 없는 공급자: ${want}`);
}
