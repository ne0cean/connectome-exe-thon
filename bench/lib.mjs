// 벤치 러너의 순수 부분: 이어 달리기, 동시 실행 풀, JSONL 입출력, 정지 판단. 네트워크·공급자를 모른다(테스트는 mock 으로).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** JSONL 읽기. 깨진 줄(쓰다 끊긴 마지막 줄 등)은 건너뛴다. 파일이 없으면 []. */
export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 깨진 줄 무시 */ }
  }
  return out;
}

export function appendJsonl(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(obj)}\n`);
}

/** id 별 마지막 기록만 남긴다(오류 뒤 재시도 성공이면 성공 기록이 이긴다). */
export function latestById(records) {
  const m = new Map();
  for (const r of records) if (r && r.id !== undefined) m.set(r.id, r);
  return [...m.values()];
}

/** 끝난 id 집합: 오류 기록은 끝난 것으로 치지 않는다(다시 달리면 재시도). */
export function doneIds(records) {
  const done = new Set();
  for (const r of latestById(records)) if (r.status !== 'error') done.add(r.id);
  return done;
}

/** 이미 끝난 것을 빼고 limit 개까지. limit 은 '이번 실행에서 새로 할 건수'다. */
export function pendingItems(items, done, limit) {
  const todo = items.filter((it) => !done.has(it.id));
  return Number.isFinite(limit) && limit >= 0 ? todo.slice(0, limit) : todo;
}

/**
 * 동시 실행 풀. worker(item) 의 반환값을 onResult 로 넘긴다. 던진 예외는 {id, status:'error', error} 로 바꿔 기록하고 계속한다.
 * shouldStop() 이 참이 되면 새 건을 시작하지 않는다(진행 중인 건은 끝까지). 20건마다(checkEvery) onCheck() 를 부른다.
 * 반환: { started, completed, stopped }
 */
export async function runPool(items, worker, { concurrency = 4, onResult, shouldStop = () => false, onCheck, checkEvery = 20 } = {}) {
  let next = 0;
  let completed = 0;
  let started = 0;
  let stopped = false;
  const lane = async () => {
    for (;;) {
      if (shouldStop()) { stopped = true; return; }
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      started++;
      let rec;
      try { rec = await worker(item); } catch (e) { rec = { id: item.id, status: 'error', error: errText(e) }; }
      await onResult?.(rec);
      completed++;
      if (completed % checkEvery === 0) await onCheck?.(completed);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
  return { started, completed, stopped };
}

/** 오류 문장에서 긴 영숫자 덩어리(키로 보일 만한 것)를 지운다 — 기록에 비밀이 새지 않게. */
export function errText(e) {
  return String(e?.message ?? e).replace(/[A-Za-z0-9_\-]{32,}/g, '[redacted]').slice(0, 300);
}

/** 잔액 하한 판단: 잔액이 숫자가 아니면 안전하게 멈춘다. */
export function belowFloor(usd, floor = 25) {
  return !(typeof usd === 'number' && Number.isFinite(usd)) || usd < floor;
}

/** 가격 부풀리기: ×1.15, 백원 단위 반올림. */
export function inflate(price, rate = 1.15) {
  return Math.round((price * rate) / 100) * 100;
}

/** court-repeat 입력: court.json 에서 참 5·거짓 5(도메인이 고루 섞이게)를 골라 rep 번씩 — rep 우선 순서라 중간에 멈춰도 균형이 맞는다. */
export function repeatItems(court, reps = 10) {
  const pick = (label) => court.filter((c) => c.label === label).filter((_, i) => i % 3 === 0 || i === 1).slice(0, 5);
  const base = [...pick(true), ...pick(false)];
  const out = [];
  for (let r = 1; r <= reps; r++) for (const b of base) out.push({ ...b, id: `${b.id}#r${r}`, base: b.id, rep: r });
  return out;
}

/** 판정이 아니라 호출 실패(조사·판사 오류)로 닫힌 건인지 — 이런 건은 측정이 아니므로 오류로 기록해 다시 달리게 한다. */
export const INFRA_REASONS = ['provider_error', 'judge_error', 'investigation_error', 'prosecution_error', 'defense_error', 'scholar_error'];
export const infraReasons = (reasons = []) => reasons.filter((r) => INFRA_REASONS.includes(r));
