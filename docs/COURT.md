# 법정 (high 단계) — 설계 초안 (2026-11-21, 구현 11-23, court-v3 11-22, court-v4 11-22: 인용 주장이면 변호 쪽 논문 조회 1회 추가·조사 질의에 주장문을 자료로만 넣음)

high 단계는 틀렸을 때 피해가 큰 주장(300만원+·되돌릴 수 없는 100만원+·의료/법률/금융)이다. 한 번의 검색으로 "확인"을 내주지 않는다.

## 누가 법정으로 보내는가 (신뢰 경계, 의장 결정 D1)
- 사실 주장의 영역은 **의뢰자**(검증소 운영자)가 정한다: `createVerifier({ policy: { claim_domain } })` / env `VERIFIER_POLICY`(JSON 파일).
- 검증받는 **에이전트**의 domain·override 는 올리기만 한다(medical 정책을 other 로 내리지 못함).
- 정책이 없으면 사실 주장은 전부 법정(fail-safe). 주장문 키워드 추정은 없앴다.
- 영수증 `method.domain_source`: `policy` | `agent_raise` | `default_high`. `court_claim` 을 직접 부르면 정책이 high 가 아닌 한 `agent_raise` + 사유 `court_requested`.

## 흐름
1. **주장 추출** (Model API `liner-gpt-router`, routing_strategy=cost): 에이전트 발언 → 검증할 명제 1~3개 + 영역(medical|legal|finance|general). 원문은 영수증에 다이제스트로만.
2. **검사** (Agent deep research 1건): "이 명제가 틀렸다는 근거를 찾아라" — 반증 수집.
3. **변호** (Agent deep research 1건): "이 명제를 뒷받침하는 1차 출처를 찾아라" — 근거 수집.
   - 영역이 medical·legal·finance 면 Liner vertical 검색(search_medical·legal·finance, REST 경로 확인 후)으로 1차 출처 보강.
4. **1심 판사** (Model API, liner-gpt-router quality): 검사·변호 보고서만 보고 판정문 JSON `{verdict, decisive_sources[], reason_codes[]}`.
5. **2심 판사** (Messages API, liner-claude-router — 다른 모델 계열): 같은 입력으로 독립 판정.
6. **엄격 판정승 규칙**:
   - 검사·변호 조사 중 하나라도 실패 → 판사를 부르지 않고 **근거부족**(unverifiable, stop) (court-v2)
   - 두 판사 모두 `adopt` 이고 변호 측 1차 출처 ≥ 1, 각 판사의 decisive_sources 가 실제 제공된 변호 출처를 1개 이상 포함, **인용된 변호 출처 합집합의 독립 호스트 ≥ 2** → **채택**(confirmed, proceed) (court-v3 — mid 의 2곳 기준보다 약하지 않게)
   - 하나라도 `reject` 이고 검사 측 출처 ≥ 1, **그 판사가 실제 제공된 검사 출처를 1개 이상 인용** → **기각**(refuted, stop) (court-v3 — 인용 없는 reject 는 근거부족)
   - 그 외(불일치·출처 부족·판사 오류) → **근거부족**(unverifiable, stop = 행동 정지)
   - 즉 high 에서 proceed 는 "두 계열 판사 일치 + 출처 있음" 하나뿐.

## 비용 상한 (실측 전 추정)
deep 2건 $0.40 + 판사·추출 토큰 수 센트 → 건당 약 $0.42. 데모 1~2건만 실호출, 나머지 mock.

## 이해당사자 분리 (기획서에서 다룰 것)
- 데모 쇼핑 에이전트도 Liner(MCP), 검증도 Liner → 같은 공급자가 행위·판정을 겸한다.
- 완화: (a) 검증소 판정 규칙은 코드로 공개·고정(영수증 method 에 버전) (b) 판사를 서로 다른 모델 계열 2개로 (c) 공급자는 providers/ 한 곳이라 다른 검색 공급자로 교체 가능 (d) 영수증에 provider 기록 — 평판 집계 때 공급자별로 나눠 볼 수 있음.
