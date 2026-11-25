// 법정 엄격 판정승 규칙 (docs/COURT.md §6). 순수 함수 — 공급자·모델 호출 없음.
// 입력: 두 판사 판정 + 검사·변호 출처 수 + 조사 오류. high 단계에서 proceed 는
// "검사·변호 조사 모두 성공 + 두 계열 판사 모두 adopt + 각 판사가 변호 출처를 1개 이상 인용 + 인용된 변호 출처 합집합의 독립 호스트 ≥ 2" 하나뿐.
// court-v3(리뷰 94ef08a H-D·H-E): high 가 mid(인용 호스트 ≥ 2)보다 약하지 않게, reject 도 adopt 처럼 실제 제공된 검사 출처를 인용해야 기각.
// court-v4(리뷰 0e6acfa): 판정 규칙은 그대로, 법정 조사가 바뀜 — 인용 주장이면 변호 쪽에 scholar 논문 조회(L-SH-4), 조사 질의는 주장문을 JSON 문자열로 가둠(T1),
//   문자·숫자 없는·2,000자 초과 주장문 거절(L-SH-13). 버전 상수는 영수증 method.rule 로 법정 전체를 가리켜 여기서 올린다.
export const COURT_RULE_VERSION = 'court-v4';
export const MIN_CITED_DEFENSE_HOSTS = 2;
export const JUDGE_VERDICTS = ['adopt', 'reject', 'insufficient'];

/**
 * judges: [{ family, verdict, error?, cited_defense?, cited_prosecution? }, ...] (2명, 서로 다른 family)
 *   cited_defense·cited_prosecution = 그 판사의 decisive_sources 중 실제로 제공된 변호·검사 참조와 일치한 수(court.mjs 가 센다). 없으면 0.
 * sources: { prosecution: n, defense: n, cited_defense_hosts: n } — cited_defense_hosts = 판사들이 인용한 변호 출처 합집합의 독립 호스트 수
 * sideErrors: 조사 오류 코드 목록(prosecution_error·defense_error) — 하나라도 있으면 판사와 무관하게 근거부족·정지(리뷰 43b5e7b H3)
 * 반환 { result, decision, reasons[] }
 */
export function decideCourt(judges, sources, sideErrors = []) {
  if (sideErrors.length) return { result: 'unverifiable', decision: 'stop', reasons: [...new Set([...sideErrors, 'investigation_error'])] };
  const reasons = [];
  // family 가 없거나 대소문자만 다른 판사를 별도 계열로 세지 않는다(리뷰 86d4f1d 참고 소견)
  const valid = judges
    .filter((j) => !j.error && JUDGE_VERDICTS.includes(j.verdict) && typeof j.family === 'string' && j.family.trim())
    .map((j) => ({ ...j, family: j.family.trim().toLowerCase() }));
  if (valid.length < judges.length) reasons.push('judge_error');
  const families = new Set(valid.map((j) => j.family));
  if (valid.length >= 2 && families.size < 2) reasons.push('single_family');

  const allAdopt = valid.length >= 2 && families.size >= 2 && valid.every((j) => j.verdict === 'adopt');
  const anyReject = valid.some((j) => j.verdict === 'reject');
  const citedReject = valid.some((j) => j.verdict === 'reject' && j.cited_prosecution >= 1);

  // 판사가 근거로 든 출처가 실제 변호 참조여야 한다 — 프롬프트 밖 URL·인용 없음은 채택으로 치지 않는다(리뷰 43b5e7b H5)
  const uncited = allAdopt && valid.some((j) => !(j.cited_defense >= 1));
  if (uncited) reasons.push('adopt_without_cited_defense_source');
  else if (allAdopt && !(sources.cited_defense_hosts >= MIN_CITED_DEFENSE_HOSTS)) reasons.push('too_few_cited_defense_hosts');
  if (allAdopt && sources.defense >= 1 && !reasons.length) return { result: 'confirmed', decision: 'proceed', reasons: ['judges_unanimous_adopt'] };
  if (citedReject && sources.prosecution >= 1) return { result: 'refuted', decision: 'stop', reasons: [...reasons, 'judge_reject_with_evidence'] };
  if (allAdopt && sources.defense < 1) reasons.push('no_defense_source');
  if (anyReject && sources.prosecution < 1) reasons.push('reject_without_evidence');
  else if (anyReject && !citedReject) reasons.push('reject_without_cited_source');
  if (!allAdopt && !anyReject) reasons.push('judges_split_or_insufficient');
  return { result: 'unverifiable', decision: 'stop', reasons: [...new Set(reasons)] };
}
