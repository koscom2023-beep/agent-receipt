// SPEC.md → site/spec.html 생성 (단일 원천=SPEC.md·손 옮김 오류 0·no deps).
// receipt.promptia.kr/spec.html 로 서빙. 코드블록/표는 규범적이라 그대로 옮긴다.
// 재생성: `node scripts/build-spec-html.mjs`. 동기화 검증: test/spec-html.test.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function inline(s) {
  const codes = [];
  // 코드스팬을 @@C n@@ 토큰으로 임시 치환(실제 스펙 텍스트엔 @@C 없음 → 숫자와 충돌 없음).
  s = s.replace(/`([^`]+)`/g, (_m, c) => { codes.push(c); return "@@C" + (codes.length - 1) + "@@"; });
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_([^_\s][^_]*?)_/g, "$1<em>$2</em>");
  s = s.replace(/@@C(\d+)@@/g, (_m, k) => "<code>" + esc(codes[k]) + "</code>");
  return s;
}
const isTableSep = (row) => /^\s*\|?[\s:|-]+\|?\s*$/.test(row) && row.includes("-");

export function renderSpecHtml(md) {
  const lines = md.split("\n");
  const out = [];
  let i = 0;
  let list = null;
  const closeList = () => { if (list) { out.push("</" + list + ">"); list = null; } };

  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(esc(lines[i])); i++; }
      i++;
      out.push("<pre><code>" + buf.join("\n") + "</code></pre>");
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList();
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push("<div class='tw'><table><thead><tr>" + head.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>"
        + rows.map((r) => "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>");
      continue;
    }
    const m = /^(#{1,4})\s+(.*)$/.exec(line);
    if (m) { closeList(); const h = m[1].length; out.push("<h" + h + ">" + inline(m[2]) + "</h" + h + ">"); i++; continue; }
    if (/^---+\s*$/.test(line)) { closeList(); out.push("<hr>"); i++; continue; }
    if (/^>\s?/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(inline(lines[i].replace(/^>\s?/, ""))); i++; }
      out.push("<blockquote>" + buf.join("<br>") + "</blockquote>");
      continue;
    }
    const ul = /^(\s*)[-*]\s+(.*)$/.exec(line);
    const ol = /^(\s*)\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (list !== want) { closeList(); out.push("<" + want + ">"); list = want; }
      out.push("<li>" + inline((ul || ol)[2]) + "</li>");
      i++; continue;
    }
    if (/^\s*$/.test(line)) { closeList(); i++; continue; }
    closeList();
    out.push("<p>" + inline(line) + "</p>");
    i++;
  }
  const body = out.join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent Receipt Format Spec · agent-receipt</title>
<meta name="description" content="The open format specification for AI-work audit receipts: seal algorithm, proof bundle, DSSE signature, and verification procedure. Reproducible without trusting any tool.">
<style>
  :root{ --paper:#faf9f6;--raised:#fff;--ink:#211d18;--mut:#6b6459;--rule:#e6e1d8;--rule-soft:#efece5;--accent:#b5502a;
    --ui:-apple-system,BlinkMacSystemFont,"Segoe UI",Pretendard,"Apple SD Gothic Neo","Noto Sans KR",Roboto,sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  @media (prefers-color-scheme: dark){ :root{ --paper:#17150f;--raised:#211d15;--ink:#efe9dc;--mut:#a89f8c;--rule:#332d20;--rule-soft:#26221a;--accent:#e08a5a; } }
  *{box-sizing:border-box} body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--ui);line-height:1.65;-webkit-font-smoothing:antialiased}
  .wrap{max-width:860px;margin:0 auto;padding:40px 22px 72px}
  h1{font-size:30px;letter-spacing:-.01em;margin:0 0 4px} h2{font-size:22px;margin:38px 0 10px;padding-top:10px;border-top:1px solid var(--rule)} h3{font-size:17px;margin:22px 0 6px} h4{font-size:15px;margin:16px 0 6px}
  p{margin:10px 0} a{color:var(--accent)} strong{font-weight:600}
  code{font-family:var(--mono);font-size:.9em;background:var(--rule-soft);padding:1px 5px;border-radius:5px}
  pre{background:var(--raised);border:1px solid var(--rule);border-radius:10px;padding:14px 16px;overflow:auto} pre code{background:none;padding:0;font-size:12.5px;line-height:1.6}
  .tw{overflow-x:auto} table{border-collapse:collapse;width:100%;font-size:13.5px;margin:12px 0} th,td{border:1px solid var(--rule);padding:6px 10px;text-align:left;vertical-align:top} th{background:var(--rule-soft)}
  blockquote{margin:14px 0;padding:12px 16px;background:var(--rule-soft);border-left:3px solid var(--accent);border-radius:8px;color:var(--mut)}
  blockquote code{background:var(--paper)} hr{border:0;border-top:1px solid var(--rule);margin:26px 0}
  ul,ol{margin:10px 0;padding-left:24px} li{margin:4px 0}
  .top{color:var(--mut);font-size:13px;margin-bottom:24px} .top a{margin-right:16px}
</style>
</head>
<body>
<div class="wrap">
<div class="top"><a href="/">agent-receipt</a><a href="verify.html">봉인 검증</a><a href="https://github.com/koscom2023-beep/agent-receipt/blob/v0.1-verify-check-split/SPEC.md">GitHub 원문</a><a href="https://github.com/koscom2023-beep/agent-receipt/blob/v0.1-verify-check-split/test/vectors/vectors.json">test vectors</a></div>
${body}
</div>
</body>
</html>
`;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const page = renderSpecHtml(readFileSync(join(root, "SPEC.md"), "utf8"));
  writeFileSync(join(root, "site", "spec.html"), page);
  console.log("site/spec.html 생성 (SPEC.md 기계변환·규범 블록 그대로)");
}
