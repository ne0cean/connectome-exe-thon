// [기존 부분] connectome k6 영수증 v0.2 (experiments/k6/receipt/keys.mjs) 의 Ed25519 키 처리를 복사·축약.
// 신뢰 목록 = 검증기 내장 { kid: publicJwk } — 영수증이 스스로 알려 주는 키는 믿지 않는다.
import { generateKeyPairSync, createPublicKey, createPrivateKey } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const ISSUER_DID = 'did:web:verifier.connectome.invalid';
export const PRIMARY_KID = `${ISSUER_DID}#key-1`;

export function generateSigner(kid = PRIMARY_KID) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { kid, privateKey, publicJwk: publicKey.export({ format: 'jwk' }) };
}
export const publicKeyOf = (jwk) => createPublicKey({ key: jwk, format: 'jwk' });
export const makeTrustList = (signers) => Object.fromEntries(signers.map((s) => [s.kid, s.publicJwk]));

export function saveSigner(path, signer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ kid: signer.kid, privateJwk: signer.privateKey.export({ format: 'jwk' }), publicJwk: signer.publicJwk }), { mode: 0o600 });
}
export function loadSigner(path) {
  const o = JSON.parse(readFileSync(path, 'utf8'));
  return { kid: o.kid, privateKey: createPrivateKey({ key: o.privateJwk, format: 'jwk' }), publicJwk: o.publicJwk };
}
/** 키 파일이 없으면 새로 만들고 알린다 — 조용한 재생성은 기존 영수증을 전부 '서명 불일치'로 만든다(리뷰 N7). */
export function loadOrCreateSigner(path, kid = PRIMARY_KID, { onNotice = (m) => process.stderr.write(`[verifier] ${m}\n`) } = {}) {
  if (existsSync(path)) return loadSigner(path);
  const s = generateSigner(kid);
  saveSigner(path, s);
  onNotice(`서명 키가 없어 새로 만들었습니다: ${path} — 이전 키로 발급한 영수증은 이 키로 검증되지 않습니다`);
  return s;
}
