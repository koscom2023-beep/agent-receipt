// ⚠️ 자동 생성 파일 — 편집 금지. scripts/build-site-kernel.mjs 가 dist/evidencekernel.js 에서 생성.
// [generated] browser shim — crypto 종류(hash·signature·fingerprint·receipt)는 브라우저 플레이그라운드 범위 밖(CLI 에서 실행).
const __noCrypto = (what) => { throw new Error(what + " 는 브라우저 플레이그라운드에서 지원하지 않습니다 — CLI(agent-receipt)에서 실행하세요"); };
const createHash = () => __noCrypto("hash/fingerprint");
const cryptoVerify = () => __noCrypto("signature");
const createPublicKey = () => __noCrypto("signature");

// Evidence Specification 버전 — 검증 포맷(claim/check)의 표준 버전. 남이 채택할 수 있는 표면.
export const SCHEMA_VERSION = "evidence/1";
// ── Evidence Kernel (코어·순수 검증) ──
// 피드백(2026-07-01): 코어가 하는 일은 단순 verify 가 아니라 capture→normalize→verify→reconcile→
//   ledger→replay 의 증거처리다. 그 중 "주장이 출처에 실재하나"를 모델 밖 결정론으로 대조하는
//   순수 커널을 여기 모은다. research verify·council verify·(향후) eval verify 가 전부 이걸 재사용.
// 불변식: LLM 판단 0·순수 함수·surface(research/council 등) 를 import 하지 않는다(core ↛ surface).
// ── Claim fingerprint v1 (시간축 동일성 키 · 결정론) ──
// "같은 주장"을 시간축으로 묶는 식별키 — 증명이 아니라 파생 계산값(tier 개념 비적용).
// 구성: NFC+공백정규화 statement + NUL + sourceUrl(없으면 "") + NUL + 정렬된 checkKinds.
// 표기: `cfp1:<sha256hex>` — 값 자체가 버전을 자기기술(v2 가 나오면 cfp2: 병기·기존 의미 변경 금지).
// 정직 한계(v1): 텍스트 기반 — 문구가 바뀌면 다른 주장으로 취급(의미적 동일성 보장 아님).
//   check 종류 집합이 포함되므로 도구가 검사 종류를 확장하면 같은 주장의 fp 가 갈라질 수 있음(스펙 명시).
export const CLAIM_FINGERPRINT_VERSION = 1;
export function claimFingerprintV1(o) {
    const norm = o.statement.normalize("NFC").replace(/\s+/g, " ").trim();
    const kinds = [...o.checkKinds].sort().join(",");
    const h = createHash("sha256").update([norm, o.sourceUrl ?? "", kinds].join("\u0000")).digest("hex"); // NUL 구분자(필드 충돌 방지)
    return `cfp1:${h}`;
}
// 공백 정규화(비교 전) — LLM 의견이 아니라 문자열 연산.
export function normalizeForCitation(s) {
    return s.replace(/\s+/g, " ").trim();
}
// 결정론 커널: quotedText 가 source 의 리터럴(정규화) 부분문자열인지.
export function verifyCitationInText(quote, source) {
    const q = normalizeForCitation(quote);
    if (q === "")
        return false;
    return normalizeForCitation(source).includes(q);
}
// source 해석은 호출부가 주입(파일 IO 는 커널 밖) — 커널은 순수 유지.
export function citationStatus(quote, source) {
    if (source === null || normalizeForCitation(quote) === "")
        return "no-source";
    return verifyCitationInText(quote, source) ? "verified" : "not-found";
}
// 텍스트에서 숫자 토큰 추출(천단위 콤마 제거·소수·음수). 퍼센트/단위 기호는 무시하고 수만 뽑음.
export function parseNumbersFromText(text) {
    const out = [];
    const re = /-?\d[\d,]*(?:\.\d+)?/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const n = Number(m[0].replace(/,/g, ""));
        if (Number.isFinite(n))
            out.push(n);
    }
    return out;
}
export function numbersClose(a, b, eps) {
    return Math.abs(a - b) <= eps;
}
const NUMBER_OPS = ["sum", "mean", "product", "diff", "ratio", "percent", "min", "max", "median", "count", "abs", "pow", "mod", "variance", "stddev", "floor", "ceil", "round"];
export function isNumberOp(s) {
    return typeof s === "string" && NUMBER_OPS.includes(s);
}
// 결정론 재계산. 알 수 없는 op / 잘못된 피연산자 → null.
export function recompute(op, operands) {
    const xs = operands.filter((x) => typeof x === "number" && Number.isFinite(x));
    if (!xs.length)
        return null;
    switch (op) {
        case "sum": return xs.reduce((a, b) => a + b, 0);
        case "mean": return xs.reduce((a, b) => a + b, 0) / xs.length;
        case "product": return xs.reduce((a, b) => a * b, 1);
        case "diff": return xs.reduce((a, b) => a - b);
        case "ratio": return xs.length >= 2 && xs[1] !== 0 ? xs[0] / xs[1] : null;
        case "percent": return xs.length >= 2 && xs[1] !== 0 ? (xs[0] / xs[1]) * 100 : null;
        case "min": return Math.min(...xs);
        case "max": return Math.max(...xs);
        // R7 추가(전부 params-free·단일 정의·결정론):
        case "median": {
            const s = [...xs].sort((a, b) => a - b);
            const m = s.length >> 1;
            return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
        }
        case "count": return xs.length;
        case "abs": return Math.abs(xs[0]);
        case "pow": return xs.length >= 2 ? xs[0] ** xs[1] : null;
        case "mod": return xs.length >= 2 && xs[1] !== 0 ? xs[0] % xs[1] : null;
        case "variance": {
            const mv = xs.reduce((a, b) => a + b, 0) / xs.length;
            return xs.reduce((a, b) => a + (b - mv) ** 2, 0) / xs.length;
        } // 모집단(÷n)
        case "stddev": {
            const ms = xs.reduce((a, b) => a + b, 0) / xs.length;
            return Math.sqrt(xs.reduce((a, b) => a + (b - ms) ** 2, 0) / xs.length);
        } // 모집단
        case "floor": return Math.floor(xs[0]);
        case "ceil": return Math.ceil(xs[0]);
        case "round": return Math.round(xs[0]); // half-up
    }
}
// stated 수치 판정. 모드 B(op+operands 재계산) 우선 → 없으면 모드 A(source 에 실재) → 둘 다 없으면 no-basis.
export function numberStatus(stated, opts) {
    if (stated === null || !Number.isFinite(stated))
        return "no-basis";
    const eps = typeof opts.eps === "number" && opts.eps >= 0 ? opts.eps : 1e-9;
    if (isNumberOp(opts.op) && Array.isArray(opts.operands) && opts.operands.length) {
        const r = recompute(opts.op, opts.operands);
        if (r === null)
            return "no-basis";
        return numbersClose(stated, r, eps) ? "verified" : "mismatch";
    }
    if (typeof opts.source === "string") {
        const nums = parseNumbersFromText(opts.source);
        if (!nums.length)
            return "no-basis";
        return nums.some((n) => numbersClose(stated, n, eps)) ? "verified" : "mismatch";
    }
    return "no-basis";
}
const MONTHS = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
const pad2 = (s) => (s.length === 1 ? "0" + s : s);
// 지원 형식만 결정론 정규화 → "YYYY-MM-DD". 그 외 → null(파싱 불가·검증 안 함).
export function canonicalizeDate(s) {
    const t = s.trim();
    let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m)
        return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
    m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/); // Jan 5, 2026 / January 5 2026
    if (m) {
        const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
        if (mo)
            return `${m[3]}-${mo}-${pad2(m[2])}`;
    }
    m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/); // 5 Jan 2026
    if (m) {
        const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
        if (mo)
            return `${m[3]}-${mo}-${pad2(m[1])}`;
    }
    return null;
}
// 텍스트에서 날짜형 토큰을 뽑아 정규화한 집합.
export function datesInText(text) {
    const out = new Set();
    const pats = [
        /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g,
        /\b[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\b/g,
        /\b\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}\b/g,
    ];
    for (const re of pats) {
        let m;
        while ((m = re.exec(text)) !== null) {
            const c = canonicalizeDate(m[0]);
            if (c)
                out.add(c);
        }
    }
    return [...out];
}
export function dateStatus(statedDate, source) {
    if (!statedDate)
        return "no-basis";
    const c = canonicalizeDate(statedDate);
    if (!c || typeof source !== "string")
        return "no-basis";
    const found = datesInText(source);
    if (!found.length)
        return "no-basis";
    return found.includes(c) ? "verified" : "mismatch";
}
export function linkStatus(url) {
    try {
        const u = new URL(url);
        return u.protocol === "http:" || u.protocol === "https:" ? "valid" : "invalid";
    }
    catch {
        return "invalid";
    }
}
const HASH_ALGOS = ["sha256", "sha1", "sha512", "md5"];
export function hashStatus(statedHash, content, algo = "sha256") {
    if (!statedHash || content === null)
        return "no-basis";
    const a = HASH_ALGOS.includes(algo) ? algo : "sha256";
    const h = createHash(a).update(content).digest("hex");
    return h.toLowerCase() === statedHash.trim().toLowerCase() ? "verified" : "mismatch";
}
export function signatureStatus(content, signature, publicKey) {
    if (content === null || typeof signature !== "string" || !signature || typeof publicKey !== "string" || !publicKey)
        return "no-basis";
    let key;
    try {
        key = createPublicKey(publicKey); // PEM(SPKI) 공개키
    }
    catch {
        return "no-basis"; // 키 형식 불가 → 검증 불가
    }
    try {
        return cryptoVerify(null, Buffer.from(content, "utf8"), key, Buffer.from(signature, "base64")) ? "verified" : "invalid";
    }
    catch {
        return "invalid"; // 서명 형식 깨짐 = 유효하지 않은 서명
    }
}
// resolvedExists: surface 가 미리 조회한 사실. null=조회 불가(레포 없음 등) → no-basis(거짓 판정 없음).
export function commitStatus(claimedCommit, resolvedExists) {
    if (!claimedCommit)
        return "no-basis";
    if (resolvedExists === null)
        return "no-basis";
    return resolvedExists ? "verified" : "mismatch";
}
// changedFiles: surface 가 조회한 변경파일 목록(줄바꿈 구분 텍스트). 인용 커널과 같은 부분문자열 판정 재사용.
export function fileChangedStatus(claimedFile, changedFiles) {
    if (!claimedFile || changedFiles === null)
        return "no-basis";
    return verifyCitationInText(claimedFile, changedFiles) ? "verified" : "not-found";
}
// diffText: surface 가 조회한 커밋 diff 텍스트. 마찬가지로 부분문자열 판정.
export function diffContainsStatus(claimedText, diffText) {
    if (!claimedText || diffText === null)
        return "no-basis";
    return verifyCitationInText(claimedText, diffText) ? "verified" : "not-found";
}
function schemaWalk(data, schema, path, out) {
    if (typeof schema.type === "string") {
        const actual = data === null ? "null" : Array.isArray(data) ? "array" : typeof data;
        if (actual !== schema.type) {
            out.push({ path, reason: `type ${schema.type} 기대 · 실제 ${actual}` });
            return;
        }
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((v) => v === data)) {
        out.push({ path, reason: `enum ${JSON.stringify(schema.enum)} 중 하나 기대 · 실제 ${JSON.stringify(data)}` });
    }
    if (schema.type === "object" && data && typeof data === "object" && !Array.isArray(data)) {
        const obj = data;
        if (Array.isArray(schema.required)) {
            for (const key of schema.required)
                if (typeof key === "string" && !(key in obj))
                    out.push({ path: `${path}.${key}`, reason: "required 필드 없음" });
        }
        if (schema.properties && typeof schema.properties === "object") {
            for (const [key, sub] of Object.entries(schema.properties)) {
                if (key in obj && sub && typeof sub === "object")
                    schemaWalk(obj[key], sub, `${path}.${key}`, out);
            }
        }
    }
    if (schema.type === "array" && Array.isArray(data) && schema.items && typeof schema.items === "object") {
        data.forEach((item, i) => schemaWalk(item, schema.items, `${path}[${i}]`, out));
    }
}
// 재계산 가능(캐시 아님) — evidenceFor 가 mismatch 상세를 얻을 때 다시 호출.
export function schemaMismatches(data, schema) {
    if (data === undefined || !schema || typeof schema !== "object")
        return [];
    const out = [];
    schemaWalk(data, schema, "$", out);
    return out;
}
export function schemaStatus(data, schema) {
    if (data === undefined || !schema || typeof schema !== "object")
        return "no-basis";
    return schemaMismatches(data, schema).length ? "mismatch" : "verified";
}
function stripRangePrefix(v) {
    return v.trim().replace(/^[\^~>=<]+\s*/, "");
}
// "x.y.z" → [x,y,z] (빠진 자리 0). prerelease/빌드메타/비숫자 → null.
export function parseSemver(v) {
    const t = v.trim();
    if (t.includes("-") || t.includes("+"))
        return null; // prerelease/build → 판정 안 함
    const m = t.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
    if (!m)
        return null;
    return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}
const cmpSemver = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
// 단일 비교자 range 를 stated 구체버전이 충족하는가. 판정 불가(복합/와일드카드/prerelease) → null.
export function semverSatisfies(stated, range) {
    const v = parseSemver(stated);
    if (!v)
        return null;
    const r = range.trim();
    if (/[|]|[\s]/.test(r) || /[xX*]/.test(r))
        return null; // 복합·와일드카드 → v1 범위 밖
    const m = r.match(/^(\^|~|>=|<=|>|<)?\s*(.+)$/);
    if (!m)
        return null;
    const op = m[1] ?? "";
    const base = parseSemver(m[2]);
    if (!base)
        return null;
    const c = cmpSemver(v, base);
    switch (op) {
        case "": return c === 0;
        case ">=": return c >= 0;
        case ">": return c > 0;
        case "<=": return c <= 0;
        case "<": return c < 0;
        case "~": { // [base, base.minor+1)
            const upper = [base[0], base[1] + 1, 0];
            return c >= 0 && cmpSemver(v, upper) < 0;
        }
        case "^": { // npm 규약: 최좌측 非0 자리 고정
            let upper;
            if (base[0] > 0)
                upper = [base[0] + 1, 0, 0];
            else if (base[1] > 0)
                upper = [0, base[1] + 1, 0];
            else
                upper = [0, 0, base[2] + 1];
            return c >= 0 && cmpSemver(v, upper) < 0;
        }
        default: return null;
    }
}
export function versionStatus(pkg, claimedVersion, depMap) {
    if (!pkg || !claimedVersion || !depMap)
        return "no-basis";
    const actual = depMap[pkg];
    if (typeof actual !== "string")
        return "no-basis";
    const stated = stripRangePrefix(claimedVersion); // 주장은 구체버전이어야 — 접두 오면 벗김
    const sat = semverSatisfies(stated, actual);
    if (sat === null) {
        // 범위판정 불가 → 구버전 동작(접두 벗긴 문자열 상등)으로 정직 폴백 — 기존 결과 보존.
        return stripRangePrefix(actual) === stated ? "verified" : "no-basis";
    }
    return sat ? "verified" : "mismatch";
}
export function fileStatus(statedFile, exists) {
    if (!statedFile)
        return "no-basis";
    if (exists === null)
        return "no-basis";
    return exists ? "verified" : "not-found";
}
export function receiptStatus(statedReceiptId, facts) {
    if (!statedReceiptId || statedReceiptId.trim().length < 8)
        return "no-basis"; // 접두 8자 미만=모호
    if (facts === null)
        return "no-basis"; // 인용 파일 미지정
    if (!facts.found)
        return "mismatch"; // 인용한 영수증이 없음 — citation not-found 와 같은 원칙(인용 정확성은 인용자 책임)
    if (!facts.isVerificationReceipt)
        return "no-basis"; // v1 미지원 종류 — 거짓판정 대신 무판정
    if (typeof facts.actualReceiptId !== "string" || !facts.actualReceiptId.startsWith(statedReceiptId.trim()))
        return "mismatch";
    if (facts.contentHashOk !== true || facts.receiptIdOk !== true)
        return "mismatch"; // 봉인 재계산 불일치=변조
    return "verified";
}
export function artifactStatus(statedArtifact, c, facts) {
    if (!statedArtifact)
        return "no-basis";
    const hasConstraint = typeof c.minBytes === "number" || typeof c.maxBytes === "number" || (typeof c.sha256 === "string" && c.sha256.length > 0);
    if (!hasConstraint)
        return "no-basis"; // 경로만=file 체크의 일 — 여긴 형태 제약이 있어야 의미
    if (facts === null)
        return "no-basis";
    if (!facts.exists)
        return "not-found";
    if (typeof c.minBytes === "number" && (facts.sizeBytes === null || facts.sizeBytes < c.minBytes))
        return "mismatch";
    if (typeof c.maxBytes === "number" && (facts.sizeBytes === null || facts.sizeBytes > c.maxBytes))
        return "mismatch";
    if (typeof c.sha256 === "string" && c.sha256) {
        if (typeof facts.sha256 !== "string")
            return "no-basis"; // 계산 불가 → 무판정(거짓 mismatch 금지)
        if (facts.sha256.toLowerCase() !== c.sha256.trim().toLowerCase())
            return "mismatch";
    }
    return "verified";
}
function parseStated(v) {
    if (typeof v === "number" && Number.isFinite(v))
        return v;
    if (typeof v === "string") {
        const n = Number(v.replace(/,/g, ""));
        return Number.isFinite(n) ? n : null;
    }
    return null;
}
export const GRADE_RANK = { A: 3, B: 2, C: 1 };
export const CHECK_REGISTRY = [
    { kind: "citation", positive: true, grade: "B", run: (c, s) => (typeof c.quotedText === "string" && c.quotedText ? citationStatus(c.quotedText, s) : null) },
    { kind: "number", positive: true, grade: "A", run: (c, s) => (c.statedValue !== undefined ? numberStatus(parseStated(c.statedValue), { source: s, op: c.op, operands: Array.isArray(c.operands) ? c.operands : undefined, eps: typeof c.eps === "number" ? c.eps : undefined }) : null) },
    { kind: "date", positive: true, grade: "B", run: (c, s) => (c.statedDate !== undefined ? dateStatus(typeof c.statedDate === "string" ? c.statedDate : null, s) : null) },
    { kind: "hash", positive: true, grade: "A", run: (c) => (c.statedHash !== undefined ? hashStatus(typeof c.statedHash === "string" ? c.statedHash : null, typeof c.content === "string" ? c.content : null, typeof c.algo === "string" ? c.algo : "sha256") : null) },
    { kind: "signature", positive: true, grade: "A", run: (c) => (c.signature !== undefined || c.publicKey !== undefined ? signatureStatus(typeof c.content === "string" ? c.content : null, typeof c.signature === "string" ? c.signature : null, typeof c.publicKey === "string" ? c.publicKey : null) : null) },
    { kind: "link", positive: false, grade: "C", run: (c) => (typeof c.link === "string" ? linkStatus(c.link) : null) },
    { kind: "commit", positive: true, grade: "B", run: (c) => (typeof c.statedCommit === "string" ? commitStatus(c.statedCommit, typeof c.commitExists === "boolean" ? c.commitExists : null) : null) },
    { kind: "fileChanged", positive: true, grade: "B", run: (c) => (typeof c.statedChangedFile === "string" ? fileChangedStatus(c.statedChangedFile, typeof c.changedFiles === "string" ? c.changedFiles : null) : null) },
    { kind: "diffContains", positive: true, grade: "B", run: (c) => (typeof c.statedDiffText === "string" ? diffContainsStatus(c.statedDiffText, typeof c.diffText === "string" ? c.diffText : null) : null) },
    { kind: "schema", positive: true, grade: "B", run: (c) => (c.schemaData !== undefined && c.schemaDef !== undefined ? schemaStatus(c.schemaData, c.schemaDef) : null) },
    { kind: "version", positive: true, grade: "B", run: (c) => (typeof c.statedPackage === "string" ? versionStatus(c.statedPackage, typeof c.statedPackageVersion === "string" ? c.statedPackageVersion : null, c.dependencyMap && typeof c.dependencyMap === "object" ? c.dependencyMap : null) : null) },
    { kind: "file", positive: true, grade: "B", run: (c) => (typeof c.statedFile === "string" ? fileStatus(c.statedFile, typeof c.fileExists === "boolean" ? c.fileExists : null) : null) },
    { kind: "receipt", positive: true, grade: "B", run: (c) => (typeof c.statedReceiptId === "string" ? receiptStatus(c.statedReceiptId, c.receiptFacts && typeof c.receiptFacts === "object" ? c.receiptFacts : null) : null) },
    { kind: "artifact", positive: true, grade: "B", run: (c) => (typeof c.statedArtifact === "string" ? artifactStatus(c.statedArtifact, { minBytes: typeof c.artifactMinBytes === "number" ? c.artifactMinBytes : undefined, maxBytes: typeof c.artifactMaxBytes === "number" ? c.artifactMaxBytes : undefined, sha256: typeof c.artifactSha256 === "string" ? c.artifactSha256 : undefined }, c.artifactFacts && typeof c.artifactFacts === "object" ? c.artifactFacts : null) : null) },
];
export const CHECK_KINDS = CHECK_REGISTRY.map((d) => d.kind);
export const CHECK_GRADES = Object.fromEntries(CHECK_REGISTRY.map((d) => [d.kind, d.grade]));
const FAILED_STATUSES = new Set(["not-found", "mismatch", "invalid"]);
// 실패 check 의 evidence(expected/actual) 생산 — 결정론(커널이 이미 가진 입력·재계산으로). 추정 없음.
function evidenceFor(c, source, results) {
    const ev = {};
    const s = source ?? "";
    if (results.citation === "not-found" && typeof c.quotedText === "string") {
        ev.citation = { expected: c.quotedText, actual: "출처 텍스트에 없음 (not present in source)" };
    }
    if (results.number === "mismatch") {
        const stated = parseStated(c.statedValue);
        let actual = "출처에서 확인 불가";
        if (isNumberOp(c.op) && Array.isArray(c.operands)) {
            const r = recompute(c.op, c.operands);
            if (r !== null)
                actual = `재계산 ${String(r)}`;
        }
        else {
            const nums = parseNumbersFromText(s);
            if (nums.length)
                actual = `출처의 수치 ${nums.slice(0, 5).join(", ")}`;
        }
        ev.number = { expected: stated !== null ? String(stated) : String(c.statedValue), actual };
    }
    if (results.date === "mismatch" && typeof c.statedDate === "string") {
        const found = datesInText(s);
        ev.date = { expected: canonicalizeDate(c.statedDate) ?? c.statedDate, actual: found.length ? `출처의 날짜 ${found.join(", ")}` : "출처에 날짜 없음" };
    }
    if (results.hash === "mismatch" && typeof c.statedHash === "string" && typeof c.content === "string") {
        const algo = typeof c.algo === "string" ? c.algo : "sha256";
        let actual = "계산 실패";
        try {
            actual = createHash(algo).update(c.content).digest("hex");
        }
        catch {
            /* 알 수 없는 알고리즘 */
        }
        ev.hash = { expected: c.statedHash.trim().slice(0, 24), actual: actual.slice(0, 24) };
    }
    if (results.signature === "invalid") {
        ev.signature = { expected: "유효한 ed25519 서명", actual: "검증 실패 (does not verify)" };
    }
    if (results.link === "invalid" && typeof c.link === "string") {
        ev.link = { expected: "http(s) URL", actual: c.link };
    }
    if (results.commit === "mismatch" && typeof c.statedCommit === "string") {
        ev.commit = { expected: c.statedCommit, actual: "레포에 이 커밋 없음 (commit not found in repo)" };
    }
    if (results.fileChanged === "not-found" && typeof c.statedChangedFile === "string") {
        const cf = typeof c.changedFiles === "string" ? c.changedFiles : "";
        ev.fileChanged = { expected: c.statedChangedFile, actual: cf ? `그 커밋의 변경파일: ${cf.split("\n").filter(Boolean).slice(0, 5).join(", ")}` : "그 커밋은 파일을 안 바꿈" };
    }
    if (results.diffContains === "not-found" && typeof c.statedDiffText === "string") {
        ev.diffContains = { expected: c.statedDiffText, actual: "그 커밋의 diff 에 없음 (not present in diff)" };
    }
    if (results.schema === "mismatch") {
        const mism = schemaMismatches(c.schemaData, c.schemaDef);
        ev.schema = { expected: "schemaDef 를 만족하는 데이터", actual: mism.map((m) => `${m.path}: ${m.reason}`).join(" · ") };
    }
    if (results.version === "mismatch" && typeof c.statedPackage === "string" && c.dependencyMap && typeof c.dependencyMap === "object") {
        const actual = c.dependencyMap[c.statedPackage];
        ev.version = { expected: String(c.statedPackageVersion), actual: typeof actual === "string" ? actual : "의존성 맵에 없음" };
    }
    if (results.file === "not-found" && typeof c.statedFile === "string") {
        ev.file = { expected: c.statedFile, actual: "디스크에 없음 (file does not exist)" };
    }
    if ((results.artifact === "mismatch" || results.artifact === "not-found") && typeof c.statedArtifact === "string") {
        const f = c.artifactFacts;
        const constraints = [];
        if (typeof c.artifactMinBytes === "number")
            constraints.push(`min ${c.artifactMinBytes}B`);
        if (typeof c.artifactMaxBytes === "number")
            constraints.push(`max ${c.artifactMaxBytes}B`);
        if (typeof c.artifactSha256 === "string")
            constraints.push(`sha256 ${c.artifactSha256.slice(0, 12)}…`);
        ev.artifact = {
            expected: `${c.statedArtifact} (${constraints.join(" · ")})`,
            actual: !f?.exists ? "산출물 없음 (artifact does not exist)" : `크기 ${f.sizeBytes ?? "?"}B${f.sha256 ? ` · sha256 ${f.sha256.slice(0, 12)}…` : ""}`,
        };
    }
    if (results.receipt === "mismatch" && typeof c.statedReceiptId === "string") {
        const f = c.receiptFacts;
        let actual = "인용한 영수증 파일 없음 (cited receipt not found)";
        if (f?.found) {
            if (typeof f.actualReceiptId === "string" && !f.actualReceiptId.startsWith(c.statedReceiptId.trim()))
                actual = `실제 receiptId ${f.actualReceiptId.slice(0, 16)}…`;
            else
                actual = "봉인 재계산 불일치 (replay mismatch — 변조 의심)";
        }
        ev.receipt = { expected: c.statedReceiptId, actual };
    }
    return ev;
}
// 표준 포맷의 단일 의미론: 레지스트리를 디스패치해 한 주장의 모든 typed 근거를 판정.
export function evaluateClaim(c, source) {
    const results = {};
    let failed = false;
    let positiveVerified = false;
    let bestGrade = null;
    for (const d of CHECK_REGISTRY) {
        const st = d.run(c, source);
        results[d.kind] = st;
        if (st && FAILED_STATUSES.has(st))
            failed = true;
        if (d.positive && st === "verified") {
            positiveVerified = true;
            if (bestGrade === null || GRADE_RANK[d.grade] > GRADE_RANK[bestGrade])
                bestGrade = d.grade;
        }
    }
    return {
        citation: results.citation ?? null,
        number: results.number ?? null,
        date: results.date ?? null,
        link: results.link ?? null,
        hash: results.hash ?? null,
        signature: results.signature ?? null,
        commit: results.commit ?? null,
        fileChanged: results.fileChanged ?? null,
        diffContains: results.diffContains ?? null,
        schema: results.schema ?? null,
        version: results.version ?? null,
        file: results.file ?? null,
        receipt: results.receipt ?? null,
        artifact: results.artifact ?? null,
        results,
        evidence: evidenceFor(c, source, results),
        failed,
        verified: !failed && positiveVerified,
        assuranceGrade: positiveVerified ? bestGrade : null,
        abstain: !failed && !positiveVerified,
    };
}
export function decomposeClaim(ev) {
    const out = [];
    for (const d of CHECK_REGISTRY) {
        const st = ev.results[d.kind];
        if (st == null)
            continue; // 미적용 검사 = 이 주장의 assertion 아님
        const verdict = FAILED_STATUSES.has(st) ? "failed" : st === "verified" ? "verified" : "abstain";
        out.push({ kind: d.kind, positive: d.positive, grade: d.grade, status: st, verdict });
    }
    return out;
}
// Evidence Specification: 레지스트리에서 기계판독 JSON Schema 생성(코드가 곧 스펙 — 남이 채택할 표면).
export function claimSchema() {
    return {
        $schema: "http://json-schema.org/draft-07/schema#",
        title: "agent-receipt Evidence Claim",
        schemaVersion: SCHEMA_VERSION,
        description: "검증 가능한 근거를 담은 주장. 각 typed check 는 결정론·비-LLM. 판단(결론 옳음)은 보증하지 않음.",
        type: "object",
        checkKinds: CHECK_KINDS,
        properties: {
            statement: { type: "string", description: "주장(표시용·미검증)" },
            sourceUrl: { type: "string", description: "출처 URL(provenance·--fetch 시 라이브 대조)" },
            sourceText: { type: "string" },
            sourceFile: { type: "string" },
            quotedText: { type: "string", description: "citation: 출처의 리터럴 부분문자열인가" },
            statedValue: { type: ["number", "string"], description: "number: 출처의 수 또는 재계산과 상등" },
            op: { type: "string", enum: [...NUMBER_OPS] },
            operands: { type: "array", items: { type: "number" } },
            eps: { type: "number" },
            statedDate: { type: "string", description: "date: 출처의 날짜와 형식무관 상등" },
            link: { type: "string", description: "link: URL well-formedness(valid=advisory)" },
            statedHash: { type: "string", description: "hash: content 의 해시와 상등(무결성)" },
            content: { type: "string" },
            algo: { type: "string", enum: [...HASH_ALGOS] },
            signature: { type: "string", description: "signature: content 에 대한 base64 ed25519 서명" },
            publicKey: { type: "string", description: "signature 검증용 PEM(SPKI) 공개키" },
            statedCommit: { type: "string", description: "commit: 이 해시가 레포에 실재하나(surface 가 git 으로 사전조회)" },
            statedChangedFile: { type: "string", description: "fileChanged: statedCommit 이 이 파일을 변경했나" },
            statedDiffText: { type: "string", description: "diffContains: statedCommit 의 diff 가 이 텍스트를 포함하나" },
            schemaData: { description: "schema: 이 데이터가(임의 JSON 값)" },
            schemaDef: { type: "object", description: "schema: 이 JSON Schema 서브셋(type/required/properties/enum/items)을 만족하나 — 그 외 키워드는 무시" },
            statedPackage: { type: "string", description: "version: 이 패키지명이" },
            statedPackageVersion: { type: "string", description: "이 버전인가(단일 비교자 ^ ~ >= > <= < 범위충족 판정 · prerelease/복합범위=no-basis)" },
            statedFile: { type: "string", description: "file: 이 파일이 디스크에 실재하나(존재만 — 내용 대조는 citation/hash)" },
            statedReceiptId: { type: "string", description: "receipt: 인용한 Verification Receipt 의 id 접두(≥8자) — 실재+봉인 재계산 일치 판정(Work Receipt 는 v1 미지원=no-basis)" },
            statedArtifact: { type: "string", description: "artifact: 산출물 경로 — 형태 제약(artifactMinBytes/MaxBytes/Sha256) ≥1 필수(제약 정합이지 산출물 정당성 보증 아님)" },
            artifactMinBytes: { type: "number" },
            artifactMaxBytes: { type: "number" },
            artifactSha256: { type: "string" },
        },
    };
}
