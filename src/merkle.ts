// R3 Merkle 투명로그 (RFC 6962) — 순수함수. node crypto 만·deps 0.
//
// 기존 해시체인(ledger.ts prevHash/entryHash)은 "내가 가진 선형 로그"의 변조를 탐지한다.
// Merkle 은 그 위에 두 가지를 더한다:
//   1) 포함증명(inclusion proof): 전체 로그 없이 "이 항목이 이 root 의 트리에 있다"를 O(log n) 로 제3자에게 증명.
//   2) 일관성증명(consistency proof): 두 시점의 root 를 비교해 로그 운영자가 히스토리를 몰래 갈아끼웠나(포크)
//      를 탐지 — Certificate Transparency 류 투명로그의 핵심. 경쟁 대비 유일 미달점이었다.
//
// 정직(회의 D1): 이건 투명로그 "자료구조"다. 공개 로그 운영자·가십 프로토콜 없이는 라이브 투명로그 서비스가 아니다.
// 도메인 분리(RFC6962 §2.1): leaf = SHA256(0x00 || data), node = SHA256(0x01 || left || right).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const sha256 = (b: Buffer): Buffer => createHash("sha256").update(b).digest();
const eq = (a: Buffer, b: Buffer): boolean => a.length === b.length && a.equals(b);
const toBuf = (d: Buffer | string): Buffer => (typeof d === "string" ? Buffer.from(d, "utf8") : d);

export function leafHash(data: Buffer | string): Buffer {
  return sha256(Buffer.concat([Buffer.from([0x00]), toBuf(data)]));
}
export function nodeHash(left: Buffer, right: Buffer): Buffer {
  return sha256(Buffer.concat([Buffer.from([0x01]), left, right]));
}

// 최대 2^k < n (k>=1). n>=2 에서만 호출.
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

// MTH(D[n]) — RFC6962 §2.1. 입력 = raw leaf 데이터(내부에서 leafHash). 빈 트리 = SHA256().
export function merkleRoot(leaves: Array<Buffer | string>): Buffer {
  const n = leaves.length;
  if (n === 0) return sha256(Buffer.alloc(0));
  if (n === 1) return leafHash(leaves[0] as Buffer | string);
  const k = splitPoint(n);
  return nodeHash(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}
export const merkleRootHex = (leaves: Array<Buffer | string>): string => merkleRoot(leaves).toString("hex");

// PATH(m, D[n]) — RFC6962 §2.1.1 포함증명(감사 경로).
export function inclusionProof(index: number, leaves: Array<Buffer | string>): Buffer[] {
  const n = leaves.length;
  if (!Number.isInteger(index) || index < 0 || index >= n) throw new Error(`inclusionProof: index ${index} out of [0, ${n})`);
  if (n === 1) return [];
  const k = splitPoint(n);
  return index < k
    ? [...inclusionProof(index, leaves.slice(0, k)), merkleRoot(leaves.slice(k))]
    : [...inclusionProof(index - k, leaves.slice(k)), merkleRoot(leaves.slice(0, k))];
}

// 포함증명 검증 — RFC6962 §2.1.1 알고리즘. leaf = 이미 leafHash 된 값.
export function verifyInclusion(leaf: Buffer, index: number, treeSize: number, proof: Buffer[], root: Buffer): boolean {
  if (index < 0 || index >= treeSize) return false;
  let fn = index;
  let sn = treeSize - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(p, r);
      if ((fn & 1) === 0) {
        while ((fn & 1) === 0 && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && eq(r, root);
}

// SUBPROOF(m, D[n], b) — RFC6962 §2.1.2 일관성증명 생성.
function subproof(m: number, leaves: Array<Buffer | string>, b: boolean): Buffer[] {
  const n = leaves.length;
  if (m === n) return b ? [] : [merkleRoot(leaves)];
  const k = splitPoint(n);
  return m <= k
    ? [...subproof(m, leaves.slice(0, k), b), merkleRoot(leaves.slice(k))]
    : [...subproof(m - k, leaves.slice(k), false), merkleRoot(leaves.slice(0, k))];
}
export function consistencyProof(m: number, leaves: Array<Buffer | string>): Buffer[] {
  const n = leaves.length;
  if (!Number.isInteger(m) || m <= 0 || m > n) throw new Error(`consistencyProof: m ${m} out of (0, ${n}]`);
  if (m === n) return [];
  return subproof(m, leaves, true);
}

// 일관성증명 검증 — RFC6962 §2.1.2 (Trillian 형). 두 root 를 재구성해 대조 → 포크(히스토리 개찬) 탐지.
export function verifyConsistency(m: number, n: number, proof: Buffer[], oldRoot: Buffer, newRoot: Buffer): boolean {
  if (m < 0 || n < 0 || m > n) return false;
  if (m === n) return proof.length === 0 && eq(oldRoot, newRoot);
  if (m === 0) return proof.length === 0; // 빈 트리는 어떤 트리와도 일관
  if (proof.length === 0) return false;

  let node = m - 1;
  let last = n - 1;
  let idx = 0;
  while (node % 2 === 1) {
    node >>= 1;
    last >>= 1;
  }

  let n1: Buffer;
  let n2: Buffer;
  if (node > 0) {
    if (idx >= proof.length) return false;
    n1 = proof[idx] as Buffer;
    n2 = proof[idx] as Buffer;
    idx++;
  } else {
    n1 = oldRoot;
    n2 = oldRoot;
  }

  while (node > 0) {
    if (idx >= proof.length) return false;
    if (node % 2 === 1) {
      n1 = nodeHash(proof[idx] as Buffer, n1);
      n2 = nodeHash(proof[idx] as Buffer, n2);
      idx++;
    } else if (node < last) {
      n2 = nodeHash(n2, proof[idx] as Buffer);
      idx++;
    }
    node >>= 1;
    last >>= 1;
  }

  if (!eq(n1, oldRoot)) return false;
  while (last > 0) {
    if (idx >= proof.length) return false;
    n2 = nodeHash(n2, proof[idx] as Buffer);
    idx++;
    last >>= 1;
  }
  return eq(n2, newRoot) && idx === proof.length;
}

// ── CLI surface ──
const line = "─".repeat(56);
function loadLeaves(opts: { file?: string; dir?: string }): { leaves: Buffer[]; src: string } {
  if (opts.file) {
    const p = isAbsolute(opts.file) ? opts.file : join(process.cwd(), opts.file);
    const raw = readFileSync(p, "utf8");
    const leaves = raw.split(/\r?\n/).filter((l) => l.length > 0).map((l) => Buffer.from(l, "utf8"));
    return { leaves, src: `${opts.file} (${leaves.length} 줄=leaf)` };
  }
  if (opts.dir) {
    const d = isAbsolute(opts.dir) ? opts.dir : join(process.cwd(), opts.dir);
    const names = readdirSync(d).filter((f) => statSync(join(d, f)).isFile()).sort();
    const leaves = names.map((f) => readFileSync(join(d, f)));
    return { leaves, src: `${opts.dir} (${leaves.length} 파일=leaf·이름순)` };
  }
  throw new Error("no-input");
}

/**
 * `agent-receipt merkle <root|prove|consistency> (--file <jsonl>|--dir <d>) [--index N] [--old-size M] [--old-root <hex>]`
 *  RFC6962 Merkle 투명로그: root / 포함증명 / 일관성증명(포크 탐지).
 *  exit 2=입력오류 · 1=검증 실패(포크/불일치) · 0=정상.
 */
export function runMerkle(sub: string | undefined, opts: { file?: string; dir?: string; index?: number; oldSize?: number; oldRoot?: string }): never {
  let loaded: { leaves: Buffer[]; src: string };
  try {
    loaded = loadLeaves(opts);
  } catch (e) {
    console.error((e as Error).message === "no-input" ? "merkle: --file <jsonl> 또는 --dir <경로> 가 필요합니다." : `merkle: 입력을 못 읽음: ${(e as Error).message}`);
    process.exit(2);
  }
  const { leaves, src } = loaded;
  const n = leaves.length;
  const root = merkleRoot(leaves);
  console.log("");
  console.log(line);
  console.log(`merkle ${sub ?? "root"} · RFC6962 · ${src}`);
  console.log(line);
  console.log(`tree size : ${n}`);
  console.log(`root      : ${root.toString("hex")}`);

  if (sub === "prove") {
    const i = opts.index;
    if (i === undefined || !Number.isInteger(i) || i < 0 || i >= n) {
      console.error(`merkle prove: --index 0..${n - 1} 필요.`);
      process.exit(2);
    }
    const proof = inclusionProof(i, leaves);
    const lh = leafHash(leaves[i] as Buffer);
    const ok = verifyInclusion(lh, i, n, proof, root);
    console.log(`leaf[${i}]  : ${lh.toString("hex")}`);
    console.log(`proof(${proof.length}) : ${proof.map((p) => p.toString("hex").slice(0, 12) + "…").join(" · ") || "(단일 leaf)"}`);
    console.log(`포함검증  : ${ok ? "✅ 이 leaf 는 root 의 트리에 있음(O(log n) 증명)" : "❌ 검증 실패"}`);
    console.log(line);
    console.log("");
    process.exit(ok ? 0 : 1);
  }

  if (sub === "consistency") {
    const m = opts.oldSize;
    if (m === undefined || !Number.isInteger(m) || m <= 0 || m > n) {
      console.error(`merkle consistency: --old-size 1..${n} 필요.`);
      process.exit(2);
    }
    const proof = consistencyProof(m, leaves);
    const newRoot = root;
    // --old-root(이전에 게시한 root) 주어지면 그걸로 검증=포크 탐지. 없으면 현재 leaves 로 self-check.
    const oldRootBuf = opts.oldRoot ? Buffer.from(opts.oldRoot, "hex") : merkleRoot(leaves.slice(0, m));
    const ok = verifyConsistency(m, n, proof, oldRootBuf, newRoot);
    console.log(`old size  : ${m}${opts.oldRoot ? " (--old-root 로 대조=포크 탐지)" : " (현재 leaves 기준 self-check)"}`);
    console.log(`old root  : ${oldRootBuf.toString("hex")}`);
    console.log(`proof(${proof.length}) : ${proof.map((p) => p.toString("hex").slice(0, 12) + "…").join(" · ") || "(빈 증명)"}`);
    console.log(`일관성    : ${ok ? "✅ 로그가 append-only 로 확장됨(히스토리 개찬 없음)" : "❌ 불일치 — 포크/개찬 의심(게시된 old-root 와 다름)"}`);
    console.log("  정직: 라이브 투명로그 서비스가 아니라 투명로그 자료구조 — 공개 로그 운영자·가십 없이는 제3자 신뢰의 뿌리는 별개.");
    console.log(line);
    console.log("");
    process.exit(ok ? 0 : 1);
  }

  // 기본: root
  console.log("  포함증명=prove --index N · 일관성증명=consistency --old-size M [--old-root <hex>]");
  console.log(line);
  console.log("");
  process.exit(0);
}
