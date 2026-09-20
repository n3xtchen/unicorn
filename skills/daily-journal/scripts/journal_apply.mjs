#!/usr/bin/env node
// daily-journal · 分类判定 / 追加写入 / 审计
//
// 三种模式：
//   --classify            只做分类判定，不写盘
//   --audit               扫描日期区间内所有 unsorted/- 条目
//   (默认)                追加一条捕获：dry-run 出 diff，--write 才落盘
//
// 写入一律通过 `obsidian eval` 在 Obsidian 进程内用 app.vault.process() 完成，
// 避免与其内存缓冲区互相覆盖；Obsidian 未运行时直接中止，不回退到文件系统。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(HERE);

// registry.json 是 vault 内「分类词表」的派生物，按 vault 各自生成。
// 解析顺序见 registryCandidates()；仓库里只有 references/registry.template.json。
const LEGACY_REGISTRY_PATH = path.join(SKILL_DIR, "references", "registry.json");
const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
  "daily-journal"
);

const OBSIDIAN_BIN = process.env.DJ_OBSIDIAN_BIN || "obsidian";
const OBSIDIAN_PROC_RE = process.env.DJ_OBSIDIAN_PROC_RE || "MacOS/Obsidian$";
const DEFAULT_VAULT = "nextlink";

// parseArgs 的结果在 main 里落到这里，供不接 args 的调用点（如 runProofread）取用。
let CLI_ARGS = {};

const SECTIONS = {
  thinking: "今日的思考",
  derived: "今日分类与关联",
  related: "关联笔记",
};

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function fail(msg, code = 1) {
  process.stderr.write("daily-journal: " + msg + "\n");
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
    if (!m) {
      out._.push(a);
      continue;
    }
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function localParts(d = new Date()) {
  const h = pad2(d.getHours());
  const m = pad2(d.getMinutes());
  return {
    ymd: String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()),
    hm: h + m, // 块 id 用紧凑形式：20260916-1547-8c95
    hms: h + ":" + m, // 派生层「时间」列用 HH:MM：15:47
    date: String(d.getFullYear()) + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()),
  };
}

function preflight() {
  try {
    execFileSync("which", [OBSIDIAN_BIN], { stdio: "pipe" });
  } catch {
    fail("找不到 obsidian CLI（" + OBSIDIAN_BIN + "）", 127);
  }
  try {
    execFileSync("pgrep", ["-f", OBSIDIAN_PROC_RE], { stdio: "pipe" });
  } catch {
    fail(
      "Obsidian 未运行。请先启动 Obsidian；本 skill 不回退到文件系统写入，以免覆盖其未保存缓冲区。",
      2
    );
  }
}

function obsidian(vault, args) {
  return execFileSync(OBSIDIAN_BIN, ["vault=" + vault, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function evalInObsidian(vault, code) {
  const raw = obsidian(vault, ["eval", "code=" + code]);
  const m = raw.match(/^=> (.*)$/m);
  if (!m) throw new Error("eval 无返回值:\n" + raw.slice(0, 800));
  return JSON.parse(m[1]);
}

function dailyPath(vault) {
  const out = obsidian(vault, ["daily:path"]);
  const p = out.replace(/^=> /, "").trim().split("\n")[0];
  if (!p) fail("daily:path 返回空路径", 3);
  return p;
}

function ensureDaily(vault) {
  obsidian(vault, ["daily:read"]);
  return dailyPath(vault);
}

// ---------------------------------------------------------------------------
// 在 Obsidian 进程内执行的 payload
// 注意：payload 内不得出现 ${ 或反引号（外层用 String.raw 模板字面量承载）。
// ---------------------------------------------------------------------------

const WRITE_PAYLOAD = String.raw`
(async () => {
  const P = globalThis.__DJ_P;
  const NL = "\n";
  const BT = String.fromCharCode(96);
  const file = app.vault.getAbstractFileByPath(P.path);
  if (!file) return JSON.stringify({ ok: false, error: "note-not-found", path: P.path });

  const before = await app.vault.read(file);
  const lines = before.split(NL);

  const head = function (s) {
    const m = s.match(/^(#{1,6})\s+(.*?)\s*$/);
    return m ? { level: m[1].length, text: m[2] } : null;
  };

  let rawStart = -1, related = -1, derived = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = head(lines[i]);
    if (!h) continue;
    if (rawStart < 0 && h.level === 2 && h.text === P.sections.thinking) { rawStart = i; continue; }
    if (rawStart >= 0) {
      if (related < 0 && h.level === 3 && h.text === P.sections.related) related = i;
      if (derived < 0 && h.level === 2 && h.text === P.sections.derived) derived = i;
    }
  }
  if (rawStart < 0) return JSON.stringify({ ok: false, error: "section-missing", detail: P.sections.thinking, path: P.path });
  if (related < 0) return JSON.stringify({ ok: false, error: "section-missing", detail: P.sections.related, path: P.path });
  if (derived >= 0 && !(derived > rawStart && derived < related)) derived = -1;

  const beginRe = /^<!--\s*jc:begin\s+id=([A-Za-z0-9._-]+)\s*-->$/;
  const endRe = /^<!--\s*jc:end\s+id=([A-Za-z0-9._-]+)\s*-->$/;
  const idxBeginRe = /^<!--\s*jc:index:begin\s*-->$/;
  const idxEndRe = /^<!--\s*jc:index:end\s*-->$/;
  const norm = function (s) { return s.replace(/\s+$/, ""); };
  const bodyOf = function (arr) { return arr.map(norm).join(NL).trim(); };

  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(beginRe);
    if (!m) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const e = lines[j].match(endRe);
      if (e && e[1] === m[1]) { blocks.push({ id: m[1], from: i, to: j, body: lines.slice(i + 1, j) }); break; }
    }
  }

  const incoming = bodyOf(P.content.split(NL));

  const clash = blocks.find(function (b) { return b.id === P.id && bodyOf(b.body) !== incoming; });
  if (clash) return JSON.stringify({ ok: false, error: "id-collision", id: P.id, existingBody: clash.body.join(NL), path: P.path });

  const dup = blocks.find(function (b) { return bodyOf(b.body) === incoming; });
  if (dup) return JSON.stringify({ ok: true, status: "duplicate", path: P.path, id: dup.id, blockCount: blocks.length });

  const block = ["<!-- jc:begin id=" + P.id + " -->", ""].concat(P.content.split(NL), ["", "<!-- jc:end id=" + P.id + " -->"]);

  const rawEnd = derived >= 0 ? derived : related;
  const rawBody = lines.slice(rawStart + 1, rawEnd);

  const insertion = [];
  if (rawBody.length === 0 || rawBody[rawBody.length - 1].trim() !== "") insertion.push("");
  for (let i = 0; i < block.length; i++) insertion.push(block[i]);
  insertion.push("");

  const newRaw = rawBody.concat(insertion);

  let tail = lines.slice(rawEnd);
  const iBegin = tail.findIndex(function (l) { return idxBeginRe.test(l); });
  const iEnd = tail.findIndex(function (l) { return idxEndRe.test(l); });

  // 分类列写成**裸标签**（不裹反引号），这样 Obsidian 才会把它当标签。
  // 块 id 仍是不可读的 opaque id，继续裹反引号。
  const linkCell = P.links && P.links.length > 0 ? P.links : "\u2014";
  const row = "| " + P.time + " | " + BT + P.id + BT + " | " + P.category + " | " + linkCell + " |";

  if (derived >= 0 && iBegin >= 0 && iEnd > iBegin) {
    tail = tail.slice(0, iEnd).concat([row], tail.slice(iEnd));
  } else if (derived < 0) {
    if (iBegin >= 0 || iEnd >= 0) return JSON.stringify({ ok: false, error: "orphan-index-markers", path: P.path });
    tail = [
      "## " + P.sections.derived,
      "",
      "<!-- jc:index:begin -->",
      "| 时间 | 块 id | 分类 | 关联 |",
      "| --- | --- | --- | --- |",
      row,
      "<!-- jc:index:end -->",
      ""
    ].concat(tail);
  } else {
    return JSON.stringify({ ok: false, error: "index-markers-missing", path: P.path });
  }

  const after = lines.slice(0, rawStart + 1).concat(newRaw, tail).join(NL);

  const afterLines = after.split(NL);
  const vBegin = afterLines.filter(function (l) { return beginRe.test(l); }).length;
  const vEnd = afterLines.filter(function (l) { return endRe.test(l); }).length;

  let sub = 0;
  for (let j = 0; j < afterLines.length && sub < lines.length; j++) {
    if (lines[sub] === afterLines[j]) sub++;
  }
  const originalsPreserved = sub === lines.length;

  const verify = {
    marksBalanced: vBegin === vEnd,
    oneBlockAdded: vBegin === blocks.length + 1,
    hasNewBlock: after.indexOf("<!-- jc:begin id=" + P.id + " -->") >= 0,
    bodyExact: after.indexOf(P.content) >= 0,
    originalsPreserved: originalsPreserved
  };
  verify.allOk = verify.marksBalanced && verify.oneBlockAdded && verify.hasNewBlock && verify.bodyExact && verify.originalsPreserved;
  if (!verify.allOk) {
    return JSON.stringify({ ok: false, error: "pre-write-verify-failed", verify: verify, path: P.path, before: before, after: after });
  }

  const base = {
    ok: true, path: P.path, id: P.id, category: P.category, links: P.links,
    blockCountBefore: blocks.length, blockCountAfter: vBegin, verify: verify
  };

  if (!P.write) {
    base.status = "dry-run";
    base.before = before;
    base.after = after;
    return JSON.stringify(base);
  }

  await app.vault.process(file, function () { return after; });
  const readBack = await app.vault.read(file);
  const readBackExact = readBack === after;
  base.status = readBackExact ? "written" : "readback-mismatch";
  base.ok = readBackExact;
  base.readBackExact = readBackExact;
  if (!readBackExact) base.readBack = readBack;
  base.before = before;
  base.after = after;
  return JSON.stringify(base);
})()
`;

const FILES_PAYLOAD = String.raw`
(async () => {
  const P = globalThis.__DJ_P;
  const all = [];
  const paths = [];
  const aliases = [];
  const files = app.vault.getFiles();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    all.push(f.basename);
    paths.push(f.path);
    if (f.extension === "md") {
      paths.push(f.path.slice(0, f.path.length - 3));
      let c = null;
      try { c = app.metadataCache.getFileCache(f); } catch (e) { c = null; }
      const al = c && c.frontmatter ? c.frontmatter.aliases : null;
      if (al) {
        const list = Array.isArray(al) ? al : String(al).split(",");
        for (let k = 0; k < list.length; k++) aliases.push(String(list[k]).trim());
      }
    }
  }
  return JSON.stringify({ ok: true, all: all, paths: paths, aliases: aliases });
})()
`;

// 标签词表按 Obsidian 的实时索引生成，**不落配置文件**（配置会过期）。
// 只扫限定目录，避免把 Evernote / 999-待整理 这类「待整合区」的标签混进来。
// 返回 { ok, roots, counted, tags: { "#t": { count, samples } } }
const TAGS_PAYLOAD = String.raw`
(async () => {
  const P = globalThis.__DJ_P;
  const roots = P.roots;
  const out = Object.create(null);
  const files = app.vault.getMarkdownFiles();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let ok = false;
    for (let r = 0; r < roots.length; r++) {
      if (f.path.indexOf(roots[r]) === 0) { ok = true; break; }
    }
    if (!ok) continue;
    let c = null;
    try { c = app.metadataCache.getFileCache(f); } catch (e) { c = null; }
    if (!c) continue;
    const seen = Object.create(null);
    if (c.tags) {
      for (let k = 0; k < c.tags.length; k++) seen[c.tags[k].tag] = 1;
    }
    const fm = c.frontmatter ? c.frontmatter.tags : null;
    if (fm) {
      const list = Array.isArray(fm) ? fm : String(fm).split(",");
      for (let k = 0; k < list.length; k++) {
        let t = String(list[k]).trim();
        if (t === "") continue;
        if (t.charAt(0) !== "#") t = "#" + t;
        seen[t] = 1;
      }
    }
    for (const t in seen) {
      if (!out[t]) out[t] = { count: 0, samples: [] };
      out[t].count = out[t].count + 1;
      if (out[t].samples.length < 2) out[t].samples.push(f.path);
    }
  }
  return JSON.stringify({ ok: true, roots: roots, counted: Object.keys(out).length, tags: out });
})()
`;

const AUDIT_PAYLOAD = String.raw`
(async () => {
  const P = globalThis.__DJ_P;
  const NL = "\n";
  const prefix = P.folder + "/";
  const rows = [];
  const files = app.vault.getMarkdownFiles();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.indexOf(prefix) !== 0) continue;
    const m = f.basename.match(P.nameRe);
    if (!m) continue;
    const day = m[1] + "-" + m[2] + "-" + m[3];
    if (day < P.from || day > P.to) continue;
    const text = await app.vault.read(f);
    const lines = text.split(NL);
    for (let j = 0; j < lines.length; j++) {
      if (lines[j].indexOf("unsorted/-") < 0) continue;
      rows.push({ date: day, path: f.path, line: j + 1, row: lines[j] });
    }
  }
  rows.sort(function (a, b) { return a.date === b.date ? a.line - b.line : (a.date < b.date ? -1 : 1); });
  return JSON.stringify({ ok: true, from: P.from, to: P.to, folder: P.folder, count: rows.length, rows: rows });
})()
`;

// ---------------------------------------------------------------------------
// 分类判定
// ---------------------------------------------------------------------------

function normalize(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

function boundaryOk(text, idx, token) {
  const edge = (c) => c !== "" && /[A-Za-z0-9_]/.test(c);
  const headChar = token[0];
  const tailChar = token[token.length - 1];
  const headAscii = /[A-Za-z0-9_]/.test(headChar);
  const tailAscii = /[A-Za-z0-9_]/.test(tailChar);
  const before = idx > 0 ? text[idx - 1] : "";
  const after = idx + token.length < text.length ? text[idx + token.length] : "";
  if (headAscii && edge(before)) return false;
  if (tailAscii && edge(after)) return false;
  return true;
}

// 3 = 精确, 2 = 前缀, 1 = 包含, 0 = 未命中
function matchTier(text, token) {
  const t = normalize(text);
  const k = normalize(token);
  if (k.length < 2) return 0;
  if (t === k) return 3;
  if (t.startsWith(k) && boundaryOk(t, 0, k)) return 2;
  let from = 0;
  while (true) {
    const i = t.indexOf(k, from);
    if (i < 0) return 0;
    if (boundaryOk(t, i, k)) return 1;
    from = i + 1;
  }
}


// ---------------------------------------------------------------------------
// 校对
//
// 只产出「疑似问题 + 机械修正结果」，不改写原意。所有修正都是可枚举的字符级
// 替换，由本脚本执行；模型不得参与改写。原文层只写入用户确认后的那一版。
// ---------------------------------------------------------------------------

// 代码围栏与行内代码：其中的内容不参与文字校对
const CODE_MASK_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;

function codeRanges(content) {
  const ranges = [];
  let m;
  CODE_MASK_RE.lastIndex = 0;
  while ((m = CODE_MASK_RE.exec(content))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function inRanges(ranges, i) {
  for (const r of ranges) if (i >= r[0] && i < r[1]) return true;
  return false;
}

// 相邻换位算 1 步（Damerau / OSA）。
// 这一点很关键：sprak -> spark 是换位，Levenshtein 距离是 2，
// 若只允许 1 就会漏掉最常见的输入错误。
function damerau(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const la = a.length;
  const lb = b.length;
  let prev2 = null;
  let prev = new Array(lb + 1);
  let cur;
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur = new Array(lb + 1);
    cur[0] = i;
    let best = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[lb];
}

function levenshtein(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const lb = b.length;
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let best = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[lb];
}

// 词表 = 注册表的锚点与关键词，**仅此**。
//
// 试过把 1161 个白名单笔记名也当词表，结果在真实日记上 6 条报全部是误报：
// 「代理->管理」「花了->花费」「尝试->面试」——笔记名里大量是常用词，
// 拿它们判错字等于把对的改成错的。宁可漏，不能错。
// （链接目标另有一套 wikilink-missing 检查，那个有硬约束，不怕误报。）
function buildVocabulary(registry) {
  const vocab = new Map();
  const add = (term, src) => {
    const t = String(term).trim();
    if (t.length < 2) return;
    if (/^[\d\s._-]+$/.test(t)) return;
    if (!vocab.has(t)) vocab.set(t, src);
  };
  for (const a of registry.anchors) {
    add(a.anchor, "registry");
    for (const kw of a.keywords) add(kw, "registry");
  }
  return vocab;
}

// 常见英文词：它们本身就是合法写法。data/date、code/mode 这类高频短词只差一个
// 字母，不做停用会导致大量误报，而且风险远大于收益（把对的改成错的）。
const ASCII_STOPWORDS = new Set([
  "data", "date", "code", "mode", "time", "file", "name", "type", "user", "page",
  "list", "test", "item", "line", "node", "path", "link", "size", "note", "text",
  "form", "host", "port", "main", "base", "read", "write", "true", "false", "null",
  "case", "call", "work", "life", "self", "idea", "tool", "output", "learn", "family",
  "map", "key", "value", "table", "index", "sort", "count", "group", "order", "join",
  "left", "right", "inner", "outer", "view", "query", "load", "dump", "push", "pull",
  "merge", "commit", "branch", "repo", "issue", "stage", "task", "goal", "plan", "done",
  "todo", "next", "open", "close", "start", "end", "stop", "run", "build", "dev",
  "prod", "env", "role", "server", "client", "local", "remote", "cloud", "logs", "warn",
  "info", "debug", "trace", "error", "fatal", "admin", "root", "guest", "auth", "token",
  "shell", "bash", "java", "json", "http", "html", "word", "page", "sale", "cost",
]);
const REPEAT_WORDS = new Set(["的的", "了了", "是是", "在在", "和和", "与与", "我我", "你你", "他他", "就就", "不不", "也也"]);

// 单次相邻换位（sprak -> spark）。这是最常见的输入错误，值得单独放行；
// 而短词上的 substitution（prime->price、teat->team）几乎全是误报，不再放行。
function isTranspositionOnly(x, y) {
  if (x.length !== y.length) return false;
  const diff = [];
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) diff.push(i);
  return diff.length === 2 && diff[1] === diff[0] + 1 && x[diff[0]] === y[diff[1]] && x[diff[1]] === y[diff[0]];
}

function proofread(content, vocab, linkIndex, skipKinds) {
  const findings = [];
  const ranges = codeRanges(content);
  const lines = content.split("\n");

  if (content.trim() === "") {
    findings.push({ kind: "empty", severity: "high", autoFix: false, blocking: true, found: "(空)", suggestion: "", reason: "内容为空或只有空白，没有可写入的原文。" });
  }

  // wikilink 区间：链接内部的内容（如 02-Done、[[spark]]）不该再被拆成英文单词
  // 或重复虚词去查，否则 [[02-Done/...]] 里的 Done 会变成一条 ascii-case 误报。
  const linkSpans = [];
  const linkScanRe = /!?\[\[[^\]]*\]\]/g;
  let ls;
  while ((ls = linkScanRe.exec(content))) linkSpans.push([ls.index, ls.index + ls[0].length]);
  const skipRanges = ranges.concat(linkSpans);

  // 1. 行尾空白
  let lineStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const mm = l.match(/[ \t]+$/);
    if (mm) {
      const start = lineStart + l.length - mm[0].length;
      findings.push({ kind: "trailing-space", severity: "low", autoFix: true, line: i + 1, start: start, end: lineStart + l.length, replace: "", found: "行尾空白", suggestion: "删除", reason: "行尾有多余空格，Markdown 中无意义。" });
    }
    lineStart += l.length + 1;
  }

  // 2. ASCII 词：大小写与拼写
  const wordRe = /[A-Za-z][A-Za-z0-9_.-]*/g;
  const lower = new Map();
  for (const t of vocab.keys()) lower.set(t.toLowerCase(), t);
  const asciiTerms = [...vocab.keys()].filter((t) => /^[\x00-\x7F]+$/.test(t));
  let m;
  const seenAscii = new Set();
  while ((m = wordRe.exec(content))) {
    const w = m[0];
    if (inRanges(skipRanges, m.index)) continue;
    if (vocab.has(w)) continue;
    if (seenAscii.has(w)) continue;

    const canonical = lower.get(w.toLowerCase());
    if (canonical && canonical !== w) {
      seenAscii.add(w);
      findings.push({ kind: "ascii-case", severity: "low", autoFix: true, start: m.index, end: m.index + w.length, replace: canonical, found: w, suggestion: canonical, reason: "词表中的规范写法是 " + canonical + "。" });
      continue;
    }
    if (canonical) continue;
    if (ASCII_STOPWORDS.has(w.toLowerCase())) continue;
    if (w.length < 5) continue;

    // 实测：拿 155 个注册表词做「编辑距离近似」，在真语料上约一半是误报
    // （none->done、gate->date、rate->date、best->Bert、team->term）——
    // 因为这些领域词本身就是常见英文词。只保留两类真正可靠的：
    //   len >= 7 的长词，允许距离 2
    //   len 5-6 的短词，只允许「单次相邻换位」
    // 真阳性（obsidan->obsidian、iceborg->iceberg、sprak->spark）全落在其中。
    const lw = w.toLowerCase();
    const short = w.length <= 6;
    const max = short ? 1 : 2;
    let best = null;
    for (const t of asciiTerms) {
      if (Math.abs(t.length - w.length) > max) continue;
      const lt = t.toLowerCase();
      if (short && !isTranspositionOnly(lw, lt)) continue;
      const d = damerau(lw, lt, max);
      if (d < 1 || d > max) continue;
      if (!best || d < best.d || (d === best.d && Math.abs(t.length - w.length) < Math.abs(best.t.length - w.length))) {
        best = { t: t, d: d };
      }
    }
    if (best) {
      seenAscii.add(w);
      findings.push({ kind: "ascii-typo", severity: "medium", autoFix: true, start: m.index, end: m.index + w.length, replace: best.t, found: w, suggestion: best.t, reason: "与本库词表「" + best.t + "」相差 " + best.d + " 个字符，疑似拼写错误。" });
    }
  }

  // 3. 相邻重复虚词
  // 4. 相邻重复虚词
  for (const rw of REPEAT_WORDS) {
    let from = 0;
    while (true) {
      const i = content.indexOf(rw, from);
      if (i < 0) break;
      from = i + 1;
      if (inRanges(skipRanges, i)) continue;
      findings.push({ kind: "repeat-char", severity: "low", autoFix: true, start: i + 1, end: i + 2, replace: "", found: rw, suggestion: rw[0], reason: "虚词重复，疑似多打了一个字。" });
    }
  }

  // 5. == 高亮
  const hl = (content.match(/==/g) || []).length;
  if (hl % 2 !== 0) {
    findings.push({ kind: "highlight-unclosed", severity: "medium", autoFix: false, found: "==", suggestion: "补一个 ==", reason: "== 高亮标记出现 " + hl + " 次（奇数），有未闭合的高亮。" });
  }

  // 6. 代码围栏
  const fences = lines.filter((l) => /^\s*(```|~~~)/.test(l)).length;
  if (fences % 2 !== 0) {
    findings.push({ kind: "fence-unclosed", severity: "medium", autoFix: false, found: "```", suggestion: "补一个围栏", reason: "代码围栏出现 " + fences + " 次（奇数），有未闭合的围栏。" });
  }

  // 7. wikilink
  //
  // 只检查「完整的 [[目标]] 能否解析」，不再做 [[ / ]] 成对匹配：
  // 正则分不清 [[白话解析] Flink...](url) 这种 markdown 链接文本，
  // 也无法处理代码里的 [1]]，在全库上产生 111 处纯误报。
  // 解析必须按 Obsidian 的真实规则来：路径 / 文件名 / 别名，且 #标题 与 #^块 合法。
  const linkRe = /!?\[\[([^\]]*)\]\]/g;
  let lm;
  while ((lm = linkRe.exec(content))) {
    if (inRanges(ranges, lm.index)) continue;    const raw = lm[1];
    const spec = raw.split("|")[0].trim();
    const pathPart = spec.split("#")[0].trim();
    if (pathPart === "") {
      // [[#标题]] / [[#^块]] 是同文档引用，完全合法；只有 [[]] / [[|x]] 才是错的
      if (spec.indexOf("#") < 0) {
        findings.push({ kind: "wikilink-empty", severity: "high", autoFix: false, start: lm.index, end: lm.index + lm[0].length, found: lm[0], suggestion: "删除或补全", reason: "空的 wikilink，指向不了任何东西。" });
      }
      continue;
    }
    const key = pathPart.toLowerCase();
    if (linkIndex.targets.has(key)) continue;
    if (linkIndex.targets.has(key.replace(/\.md$/, ""))) continue;

    let near = null;
    const max = key.length >= 8 ? 3 : key.length >= 5 ? 2 : 1;
    for (const [lo, canon] of linkIndex.names) {
      if (Math.abs(canon.length - pathPart.length) > max) continue;
      const d = damerau(key, lo, max);
      if (d >= 1 && d <= max && (!near || d < near.d)) near = { t: canon, d: d };
    }
    findings.push({
      kind: "wikilink-missing",
      severity: "high",
      autoFix: false,
      start: lm.index,
      end: lm.index + lm[0].length,
      found: lm[0],
      suggestion: near ? "[[" + near.t + "]]" : "库中无此笔记",
      reason: near
        ? "链接目标「" + pathPart + "」不存在，最接近的是「" + near.t + "」。"
        : "链接目标「" + pathPart + "」在库中不存在。",
    });
  }

  // 8. 过滤 + 编号 + 严重度排序
  const kept = skipKinds && skipKinds.size > 0 ? findings.filter((f) => !skipKinds.has(f.kind)) : findings;
  const order = { high: 0, medium: 1, low: 2 };
  kept.sort((a, b) => (order[a.severity] - order[b.severity]) || ((a.start ?? -1) - (b.start ?? -1)));
  kept.forEach((f, i) => { f.id = "f" + (i + 1); });

  const fixable = kept.filter((f) => f.autoFix);
  const safe = applyFixes(content, kept, safeIds(kept));
  return { findings: kept, fixableCount: fixable.length, corrected: safe.text, applied: safe.applied };
}

// 默认自动修正的范围：只含「无损」类
//   - trailing-space / repeat-char：纯删除多余字符
//   - ascii-case：只是大小写规范
// 不含 ascii-typo：那是「改字」，必须显式确认。
const SAFE_KINDS = new Set(["trailing-space", "repeat-char", "ascii-case"]);

function safeIds(findings) {
  return findings.filter((f) => f.autoFix && SAFE_KINDS.has(f.kind)).map((f) => f.id);
}

function applyFixes(content, findings, ids) {
  const chosen = findings.filter((f) => f.autoFix && f.start !== undefined && f.end !== undefined && (ids === "all" || (Array.isArray(ids) && ids.includes(f.id))));
  const sorted = chosen.slice().sort((a, b) => b.start - a.start);
  let out = content;
  const applied = [];
  for (const f of sorted) {
    out = out.slice(0, f.start) + (f.replace || "") + out.slice(f.end);
    applied.push(f.id);
  }
  return { text: out, applied: applied.reverse() };
}

function unifiedDiff(a, b) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dj-diff-"));
  const fa = path.join(dir, "before.md");
  const fb = path.join(dir, "after.md");
  fs.writeFileSync(fa, a);
  fs.writeFileSync(fb, b);
  let out = "";
  try {
    out = execFileSync("diff", ["-u", "--label", "before", "--label", "after", fa, fb], {
      encoding: "utf8",
    });
  } catch (e) {
    out = e.stdout || "";
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function loadRegistry(vault, args) {
  args = args || CLI_ARGS;
  // 显式指定就得说话算数：指错了直接报错，不静默回退到自动探测（避免读到别的实例）。
  const explicit = (args && args.registry) || process.env.DJ_REGISTRY;
  if (explicit) {
    const via = args && args.registry ? "--registry" : "$DJ_REGISTRY";
    if (!fs.existsSync(explicit)) {
      fail(via + " \u6307\u5b9a\u7684 registry \u4e0d\u5b58\u5728\uff1a" + explicit, 3);
    }
    const parsed = JSON.parse(fs.readFileSync(explicit, "utf8"));
    parsed.__source = explicit;
    parsed.__sourceWhy = via;
    return parsed;
  }
  // 缺失就自己重建 —— registry 是机械派生物，不该让用户手抄命令。
  const found = readRegistry(vault, args) || (rebuildRegistry(vault), readRegistry(vault, args));
  if (!found) fail("registry.json \u91cd\u5efa\u540e\u4ecd\u8bfb\u4e0d\u5230\uff0c\u5df2\u4e2d\u6b62", 3);
  return found;
}

function readRegistry(vault, args) {
  for (const cand of registryCandidates(vault, args)) {
    if (fs.existsSync(cand.path)) {
      const parsed = JSON.parse(fs.readFileSync(cand.path, "utf8"));
      parsed.__source = cand.path;
      parsed.__sourceWhy = cand.why;
      return parsed;
    }
  }
  return null;
}

// registry 落点按优先级解析。
function registryCandidates(vault, args) {
  const list = [];
  const root = vaultRoot(vault, { optional: true });
  if (root) {
    list.push({ path: path.join(root, ".daily-journal", "registry.json"), why: "vault \u5185 .daily-journal/" });
    list.push({ path: path.join(root, "registry.json"), why: "vault \u6839" });
  }
  list.push({ path: path.join(STATE_DIR, vault + ".registry.json"), why: "\u672c\u673a\u72b6\u6001\u76ee\u5f55" });
  list.push({ path: LEGACY_REGISTRY_PATH, why: "skill \u5185\u65e7\u5e03\u5c40" });
  return list;
}

// vault 根一律向 Obsidian 索取，不自行拼接 iCloud 路径。
// evalInObsidian 要求返回值本身是 JSON，故路径要在 Obsidian 侧先 stringify。
function vaultRoot(vault, opts = {}) {
  try {
    const root = evalInObsidian(vault, "JSON.stringify(app.vault.adapter.basePath)");
    return typeof root === "string" && root ? root : null;
  } catch (err) {
    if (opts.optional) return null;
    throw err;
  }
}

// 生成器优先用 skill 自带的那份（<skill>/tools/build-registry.mjs）—— 它跟脚本同版本、被 git 管着。
// vault 里可能还留着一份旧副本，仅作兜底，并且会提示你它被忽略了。
const SKIP_DIRS = new Set([".git", ".obsidian", ".trash", ".daily-journal", "node_modules"]);

function findGenerators(root) {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const candidate = path.join(full, "tools", "build-registry.mjs");
      if (fs.existsSync(candidate)) hits.push(candidate);
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return hits;
}

function findGenerator(root) {
  const env = process.env.DJ_REGISTRY_GENERATOR;
  if (env) {
    if (!fs.existsSync(env)) fail("$DJ_REGISTRY_GENERATOR 指向的生成器不存在：" + env, 3);
    return env;
  }

  const local = path.join(HERE, "..", "tools", "build-registry.mjs");
  const localExists = fs.existsSync(local);
  const inVault = findGenerators(root);

  if (localExists) {
    if (inVault.length > 0) {
      process.stderr.write(
        "daily-journal: 提示 vault 内还有 " + inVault.length + " 份生成器副本，已忽略（用的是 skill 自带的）：\n" +
          inVault.map((g) => "  - " + g).join("\n") +
          "\n"
      );
    }
    return local;
  }

  if (inVault.length === 1) return inVault[0];
  if (inVault.length > 1) {
    fail(
      [
        "registry.json 不存在，且 vault 内发现多个生成器，无法确定用哪个：",
        ...inVault.map((g) => "  - " + g),
      ].join("\n"),
      3
    );
  }
  fail(
    [
      "registry.json 不存在，且找不到生成器 build-registry.mjs。",
      "  找过 skill 自带位置：" + local,
      "  也找过 vault：" + root,
    ].join("\n"),
    3
  );
}

function rebuildRegistry(vault) {
  const root = vaultRoot(vault);
  const target = path.join(root, ".daily-journal", "registry.json");
  const generator = findGenerator(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    execFileSync(process.execPath, [generator, "--vault-root=" + root, "--out=" + target], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    fail("\u91cd\u5efa registry \u5931\u8d25\uff1a" + generator + "\n" + String(err.stderr || err.message).trim(), 3);
  }
  if (!fs.existsSync(target)) fail("\u751f\u6210\u5668\u672a\u4ea7\u51fa " + target, 3);

  process.stderr.write(
    "daily-journal: registry.json \u7f3a\u5931\uff0c\u5df2\u7528 " + generator + " \u91cd\u5efa -> " + target + "\n"
  );
}

function buildLinkIndex(listed) {
  // 按 Obsidian 的真实解析规则建立索引：
  //   - 文件名（basename）
  //   - 全路径（带/不带 .md）
  //   - frontmatter aliases
  // 少了任何一类都会把合法链接判成坏链接（实测路径式链接占误报的绝大多数）。
  const targets = new Set();
  const names = new Map();
  for (const b of listed.all) {
    if (!b) continue;
    const k = b.toLowerCase();
    targets.add(k);
    if (!names.has(k)) names.set(k, b);
  }
  for (const p of listed.paths) if (p) targets.add(p.toLowerCase());
  for (const a of listed.aliases) if (a) targets.add(a.toLowerCase());
  return { targets: targets, names: names };
}

function skipSet(args) {
  if (typeof args.skip !== "string") return null;
  const s = new Set(args.skip.split(",").map((x) => x.trim()).filter(Boolean));
  return s.size ? s : null;
}

// 关联列只允许指向库里真实存在的文件（A3）。
// 没有实际文档，关联就没有意义 —— 所以这条在写盘前机械拦下，不靠模型自觉。
function parseWikilinkTargets(s) {
  const out = [];
  if (typeof s !== "string") return out;
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    // 去掉别名（|）与标题/块锚点（#）
    const t = m[1].split("|")[0].split("#")[0].trim();
    if (t) out.push(t);
  }
  return out;
}

// returns { checked, missing[], malformed }
function checkLinks(vault, links) {
  if (typeof links !== "string") return { checked: 0, missing: [], malformed: false };
  const stripped = links.replace(/[\s\u3001,\uFF0C]+/g, "");
  if (!stripped || stripped === "\u2014" || stripped === "-") {
    return { checked: 0, missing: [], malformed: false };
  }
  const targets = parseWikilinkTargets(links);
  if (targets.length === 0) return { checked: 0, missing: [], malformed: true };
  const idx = buildLinkIndex(listFiles(vault));
  const missing = targets.filter((t) => !idx.targets.has(t.toLowerCase()));
  return { checked: targets.length, missing: missing, malformed: false };
}

function listFiles(vault) {
  const code = "globalThis.__DJ_P = " + JSON.stringify({}) + ";\n" + FILES_PAYLOAD;
  return evalInObsidian(vault, code);
}

// 分类现在是**标签**：没有「域/锚点」，也不再要求锚点必须是库里真实存在的笔记。
// 词表实时来自 Obsidian（TAGS_PAYLOAD），不落配置文件，所以不会过期。
const DEFAULT_TAG_ROOTS = [
  "00-InBox&FleetNote",
  "02-Done",
  "09-Note4LLM",
  "10-GTD",
  "11-Knowledge",
];
// 占位就是骨架里的一级标签 unsorted，不另造词
const PLACEHOLDER_TAG = "#unsorted";

// 剔除规则是机械的，不是需要维护的配置：
//   - #gtd/* 是任务状态（next-action / wait-for / calendar…），不是主题分类
//   - 纯数字标签来自 GitHub 链接标题（"Issue #2672"），Obsidian 会把它们当标签
function tagDropped(tag) {
  const body = tag.slice(1);
  if (body === "gtd" || body.indexOf("gtd/") === 0) return "gtd";
  if (/^\d+$/.test(body)) return "numeric";
  // 单字符标签几乎必是代码或链接噪声（例：#n 来自 Jupyter 笔记里的 JSON）
  if (body.length <= 1) return "short";
  return null;
}

function tagRoots(args) {
  if (args && typeof args.scope === "string" && args.scope.trim() !== "") {
    return args.scope.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_TAG_ROOTS;
}

// 词表 = 「文档里维护的一二级骨架」 ∪ 「限定目录内实有的库标签」。
// 前者稳定、可审阅（来自 vault 里那份分类词表的机械派生），后者实时、不用维护。
function loadTags(vault, args) {
  const roots = tagRoots(args);
  const registry = loadRegistry(vault, args);
  const sk = registry.tagSkeleton || { level1: [], level2: {}, all: [], paths: {} };

  const code = "globalThis.__DJ_P = " + JSON.stringify({ roots: roots }) + ";\n" + TAGS_PAYLOAD;
  const res = evalInObsidian(vault, code);

  const dropped = { gtd: 0, numeric: 0, short: 0 };
  const liveMap = new Map();
  for (const t in res.tags) {
    const why = tagDropped(t);
    if (why) {
      dropped[why] = (dropped[why] || 0) + 1;
      continue;
    }
    liveMap.set(t, { count: res.tags[t].count, samples: res.tags[t].samples });
  }

  // 锚点关键词也跟着骨架走：这样「销量」能命中 #work/sales，恢复到旧 classify 的能力
  const kwMap = new Map();
  for (const a of registry.anchors || []) {
    kwMap.set("#" + a.domain + "/" + a.anchor, Array.isArray(a.keywords) ? a.keywords : []);
  }

  const tags = [];
  const known = new Set();
  for (const t of sk.all) {
    const lv = liveMap.get(t);
    tags.push({
      tag: t,
      source: "skeleton",
      level: t.indexOf("/") < 0 ? 1 : 2,
      count: lv ? lv.count : 0,
      samples: lv ? lv.samples : [],
      notePath: (sk.paths && sk.paths[t]) || "",
      keywords: kwMap.get(t) || [],
    });
    known.add(t);
  }
  const extra = [];
  for (const [t, v] of liveMap) {
    if (known.has(t)) continue;
    extra.push({
      tag: t,
      source: "vault",
      level: t.split("/").length,
      count: v.count,
      samples: v.samples,
      notePath: "",
      keywords: [],
    });
  }
  extra.sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1));

  return {
    ok: true,
    roots: roots,
    level1Count: sk.level1.length,
    level2Count: sk.all.length - sk.level1.length,
    skeletonCount: sk.all.length,
    liveCount: liveMap.size,
    dropped: dropped,
    count: tags.length + extra.length,
    tags: tags.concat(extra),
  };
}

// 只按词表做机械匹配，命中的是标签名还是锚点关键词会分开报告。
// 候选**只是候选**：最终要用户点头（D5）。
function suggestTags(content, tagList) {
  const out = [];
  for (const t of tagList) {
    const body = t.tag.slice(1);
    const segs = body.split("/");
    const leaf = segs[segs.length - 1];
    let matched = "";
    let kind = "";
    if (matchTier(content, body) > 0) {
      matched = body;
      kind = "tag";
    } else if (leaf !== body && matchTier(content, leaf) > 0) {
      matched = leaf;
      kind = "tag";
    } else {
      for (const kw of t.keywords || []) {
        if (matchTier(content, kw) > 0) {
          matched = kw;
          kind = "keyword";
          break;
        }
      }
    }
    if (matched !== "") {
      out.push({
        tag: t.tag,
        source: t.source,
        kind: kind,
        matched: matched,
        count: t.count,
        notePath: t.notePath || "",
        samples: t.samples || [],
      });
    }
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "tag" ? -1 : 1;
    const sa = a.source === "skeleton" ? 0 : 1;
    const sb = b.source === "skeleton" ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return b.count - a.count || (a.tag < b.tag ? -1 : 1);
  });
  return out;
}

// 标签格式校验。合法即可写，**不要求标签已存在**——这正是标签相对文件锚点的好处。
// D5 要求「不静默降级」，所以这一关必须在写盘前过；五项写盘校验只管**原文**，
// 管不到派生层的分类列。
const TAG_INVALID_CHARS = /[\s#,.;:!?()[\]{}|"']/;
function validateTags(category, known) {
  const raw = String(category).trim();
  if (raw === "") return { ok: false, reason: "分类为空。" };
  const toks = raw.split(/\s+/);
  const novel = [];
  for (const t of toks) {
    if (t.charAt(0) !== "#") {
      return { ok: false, reason: "分类必须是标签，每个都以 # 开头，收到 " + JSON.stringify(t) };
    }
    const body = t.slice(1);
    if (body === "") return { ok: false, reason: "空标签 #。" };
    if (TAG_INVALID_CHARS.test(body)) {
      return { ok: false, reason: "标签含非法字符（空白或标点）：" + JSON.stringify(t) };
    }
    if (body.charAt(0) === "/" || body.charAt(body.length - 1) === "/" || body.indexOf("//") >= 0) {
      return { ok: false, reason: "层级分隔符 / 的位置不对：" + JSON.stringify(t) };
    }
    const why = tagDropped(t);
    if (why === "numeric") {
      return { ok: false, reason: "纯数字标签（多来自 GitHub 链接的 Issue #123）不能当分类：" + JSON.stringify(t) };
    }
    if (why === "gtd") {
      return { ok: false, reason: "#gtd/* 是任务状态，不是主题分类：" + JSON.stringify(t) };
    }
    if (why === "short") {
      return { ok: false, reason: "单字符标签不能当分类：" + JSON.stringify(t) };
    }
    // 骨架与库内实有之外的标签 = 新建。**允许**，但必须走 --allow-new-tag，
    // 也就是必须先问过用户（D5）。
    if (known) {
      const inSkeleton = known.skeleton.has(t);
      const inLive = known.live.has(t);
      if (!inSkeleton && !inLive) novel.push(t);
    }
  }
  return { ok: true, tags: toks, novel: novel };
}

function runProofread(vault, content, skipKinds) {
  const registry = loadRegistry(vault);
  const listed = listFiles(vault);
  const vocab = buildVocabulary(registry);
  const linkIndex = buildLinkIndex(listed);
  return proofread(content, vocab, linkIndex, skipKinds);
}

function readContent(args) {
  if (typeof args["content-file"] === "string") {
    return fs.readFileSync(args["content-file"], "utf8").replace(/\n$/, "");
  }
  if (typeof args.content === "string") return args.content;
  if (args.stdin) return fs.readFileSync(0, "utf8").replace(/\n$/, "");
  return null;
}

// ---------------------------------------------------------------------------
// 改写**已写入**的原文（R3 的显式例外）
//
// R3「原文逐字不改」的作用是禁止 agent 擅自改写用户的话。事后改错字不是放宽
// R3，而是同一件事的另一面：用户自己事后发现了错字要求修。所以本模式沿用
// 写入路径上的那三条约束，一字不变：
//   1. 只能由脚本机械执行，模型不产出最终文本；
//   2. 必须给定「错→对」对，且命中数被验证；
//   3. 只动 jc:begin/jc:end 之间，块外一个字节都不改。
// 另外：改完正文后它的 sha1 与块 id 就不再一致，所以 id 必须跟着重算，
// 否则「同内容 → 同 id」这个幂等前提就断了（索引行里的 id 一起改）。
// ---------------------------------------------------------------------------

const SEARCHID_PAYLOAD = String.raw`
(async () => {
  const P = globalThis.__DJ_P;
  const found = [];
  for (const f of app.vault.getMarkdownFiles()) {
    const c = await app.vault.cachedRead(f);
    for (const id of P.ids) {
      if (c.indexOf("<!-- jc:begin id=" + id + " -->") >= 0) {
        found.push({ id: id, path: f.path });
      }
    }
  }
  return JSON.stringify({ ok: true, found: found, root: app.vault.adapter.basePath });
})()
`;

const READFILE_PAYLOAD = String.raw`
(async () => {
  const P = globalThis.__DJ_P;
  const f = app.vault.getAbstractFileByPath(P.path);
  if (!f) return JSON.stringify({ ok: false, error: "file-missing", path: P.path });
  return JSON.stringify({ ok: true, path: P.path, content: await app.vault.read(f) });
})()
`;

// 写入前先确认文件仍是读到的那个字节序列（乐观并发）：
// 若期间 Obsidian 那边改过，就原样返回、不落盘，由上层报 readback-mismatch。
const FIXWRITTEN_PAYLOAD = String.raw`
(async () => {
  const P = globalThis.__DJ_P;
  const f = app.vault.getAbstractFileByPath(P.path);
  if (!f) return JSON.stringify({ ok: false, error: "file-missing", path: P.path });
  let seen = "";
  await app.vault.process(f, (data) => {
    seen = data;
    if (data !== P.expectBefore) return data;
    return P.after;
  });
  const after = await app.vault.read(f);
  return JSON.stringify({
    ok: true,
    path: P.path,
    beforeMatched: seen === P.expectBefore,
    written: seen === P.expectBefore,
    readBackExact: after === P.after
  });
})()
`;

function parseReplaceList(spec, flag = "--replace") {
  if (typeof spec !== "string" || spec.trim() === "") {
    throw new Error(flag + " 为空（写法：" + flag + "='便宜→漂移'）");
  }
  const out = [];
  for (const part of spec.split(",")) {
    const s = part.trim();
    if (s === "") continue;
    const i = s.indexOf("→");
    if (i < 0) throw new Error(flag + " 缺少箭头 →：" + JSON.stringify(s));
    const from = s.slice(0, i);
    const to = s.slice(i + 1);
    if (from === "") throw new Error(flag + " 左侧为空：" + JSON.stringify(s));
    if (to === "") throw new Error(flag + " 右侧为空：" + JSON.stringify(s));
    if (from === to) throw new Error("--replace 两侧相同：" + JSON.stringify(s));
    out.push({ from: from, to: to });
  }
  if (out.length === 0) throw new Error("--replace 为空");
  return out;
}

function countOf(hay, needle) {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n += 1;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

function replaceAllText(hay, from, to) {
  return hay.split(from).join(to);
}

// 块体 = begin 标记之后 "\n\n" 与 end 标记之前 "\n\n" 之间的内容
function blockSpans(content, id) {
  const begin = "<!-- jc:begin id=" + id + " -->";
  const end = "<!-- jc:end id=" + id + " -->";
  const i = content.indexOf(begin);
  const j = content.indexOf(end);
  if (i < 0 || j < 0 || j < i) return null;
  return { bStart: i, bEnd: i + begin.length, eStart: j, eEnd: j + end.length };
}

function cmdFixWritten(vault, args) {
  const ids = String(typeof args.id === "string" ? args.id : "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    fail("--fix-written 需要 --id=<块 id>（可逗号分隔多个）。块 id 见 jc:begin 标记，形如 20260916-1549-0882");
  }
  let pairs;
  try {
    pairs = parseReplaceList(args.replace);
  } catch (e) {
    fail(String((e && e.message) || e));
  }

  // 块 id 里已经含日期，不必自己算 ISO 周，直接全库找标记
  const search = evalInObsidian(
    vault,
    "globalThis.__DJ_P = " + JSON.stringify({ ids: ids }) + ";\n" + SEARCHID_PAYLOAD,
  );
  const byPath = new Map();
  for (const f of search.found) {
    if (!byPath.has(f.path)) byPath.set(f.path, []);
    byPath.get(f.path).push(f.id);
  }
  const missing = ids.filter((id) => !search.found.some((f) => f.id === id));
  if (missing.length > 0) {
    fail("这些块 id 在库里找不到：" + missing.join("、") + "\n  （用 grep -rn 'jc:begin id=' 核对一下）");
  }

  const reports = [];
  const plans = [];
  for (const [rel, fileIds] of byPath) {
    const rr = evalInObsidian(
      vault,
      "globalThis.__DJ_P = " + JSON.stringify({ path: rel }) + ";\n" + READFILE_PAYLOAD,
    );
    if (!rr.ok) fail("读不到 " + rel + "：" + rr.error);
    let content = rr.content;
    let after = content;
    const changed = [];

    for (const id of fileIds) {
      const sp = blockSpans(after, id);
      if (!sp) fail("块标记不成对：" + id + " in " + rel + "（orphan-index-markers）");
      const oldBody = after.slice(sp.bEnd + 2, sp.eStart - 2);
      let newBody = oldBody;
      const hits = [];
      for (const p of pairs) {
        const n = countOf(newBody, p.from);
        if (n > 0) {
          newBody = replaceAllText(newBody, p.from, p.to);
          hits.push({ from: p.from, to: p.to, n: n });
        }
      }
      if (hits.length === 0) {
        reports.push({ id: id, path: rel, hits: [], skipped: "该块内没有命中" });
        continue;
      }

      // 反向回代必须逐字节回到原文 —— 这是「除了这些对，什么都没动」的硬证据
      let back = newBody;
      for (const h of hits) back = replaceAllText(back, h.to, h.from);
      if (back !== oldBody) {
        fail(
          "回代校验失败：" + id + "\n  替换不是干净的字面替换（右值在原文中也出现过，会互相干扰）。" +
            "\n  请换更长的上下文再试，不要用会撞车的对。",
        );
      }

      const oldId = id;
      const newHash = crypto.createHash("sha1").update(newBody, "utf8").digest("hex").slice(0, 4);
      const newId = id.slice(0, id.length - 5) + "-" + newHash;

      after =
        after.slice(0, sp.bStart) +
        "<!-- jc:begin id=" + newId + " -->\n\n" +
        newBody +
        "\n\n<!-- jc:end id=" + newId + " -->" +
        after.slice(sp.eEnd);

      changed.push({ id: oldId, newId: newId, hits: hits, before: oldBody, after: newBody });
      reports.push({ id: oldId, newId: newId, path: rel, hits: hits, before: oldBody, after: newBody });
    }

    if (changed.length === 0) continue;

    // 索引行里的 id 一起换（旧格式裹反引号，新格式也是）
    for (const c of changed) {
      after = replaceAllText(after, "`" + c.id + "`", "`" + c.newId + "`");
    }

    // 块外必须逐字节不变：把块内替换全部还原后，应正好等于原文
    let restored = after;
    for (const c of changed) {
      restored = replaceAllText(restored, c.after, c.before);
      restored = replaceAllText(restored, "<!-- jc:begin id=" + c.newId + " -->", "<!-- jc:begin id=" + c.id + " -->");
      restored = replaceAllText(restored, "<!-- jc:end id=" + c.newId + " -->", "<!-- jc:end id=" + c.id + " -->");
      restored = replaceAllText(restored, "`" + c.newId + "`", "`" + c.id + "`");
    }
    const outsideUntouched = restored === content;

    plans.push({ rel: rel, expectBefore: content, after: after, outsideUntouched: outsideUntouched, changed: changed });
  }

  const anyHit = reports.some((r) => (r.hits || []).length > 0);
  if (!anyHit) {
    process.stdout.write("改写：没有命中任何待改内容，未落盘。\n");
    return;
  }

  const bad = plans.filter((p) => !p.outsideUntouched);
  if (bad.length > 0) {
    fail(
      "块外内容被牵连：" + bad.map((p) => p.rel).join("、") +
        "\n  这是脚本的 bug，已中止未落盘。请把现场报给用户看。",
    );
  }

  if (!args.write) {
    if (args.json) process.stdout.write(JSON.stringify({ ok: true, dryRun: true, plans: reports }, null, 2) + "\n");
    else {
      process.stdout.write("改写已写入的原文（未落盘）\n\n");
      for (const r of reports) {
        if ((r.hits || []).length === 0) continue;
        process.stdout.write("  " + r.path + "  " + r.id + " -> " + r.newId + "\n");
        for (const h of r.hits) {
          process.stdout.write("    命中 " + h.n + " 次：" + h.from + " → " + h.to + "\n");
        }
        process.stdout.write("    改前: " + r.before.replace(/\n/g, "\\n") + "\n");
        process.stdout.write("    改后: " + r.after.replace(/\n/g, "\\n") + "\n\n");
      }
      process.stdout.write("块外逐字节未动。确认后加 --write 重跑。\n");
    }
    return;
  }

  // 落盘前留一份字节级备份（.daily-journal/ 是隐藏目录，Obsidian 不索引）
  const bdir = path.join(search.root, ".daily-journal", "backup");
  fs.mkdirSync(bdir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const p of plans) {
    const b = path.join(bdir, path.basename(p.rel) + "." + stamp + ".bak");
    fs.writeFileSync(b, p.expectBefore);
    p.backup = b;
  }

  const written = [];
  for (const p of plans) {
    const res = evalInObsidian(
      vault,
      "globalThis.__DJ_P = " + JSON.stringify({ path: p.rel, expectBefore: p.expectBefore, after: p.after }) + ";\n" + FIXWRITTEN_PAYLOAD,
    );
    if (!res.ok) fail("落盘失败 " + p.rel + "：" + res.error);
    if (!res.beforeMatched) fail("落盘前比对失败 " + p.rel + "：文件在读取后被改过，未写入（readback-mismatch）");
    if (!res.readBackExact) fail("回读不一致 " + p.rel + "：写入未按预期生效。备份在 " + p.backup);
    written.push({ path: p.rel, backup: p.backup, changed: p.changed.length });
  }

  if (args.json) process.stdout.write(JSON.stringify({ ok: true, status: "written", written: written, plans: reports }, null, 2) + "\n");
  else {
    process.stdout.write("改写完成\n\n");
    for (const w of written) {
      process.stdout.write("  " + w.path + "  改了 " + w.changed + " 个块\n    备份: " + w.backup + "\n");
    }
    for (const r of reports) {
      if ((r.hits || []).length === 0) continue;
      process.stdout.write("  " + r.id + " -> " + r.newId + "  " + r.hits.map((h) => h.from + "→" + h.to).join("、") + "\n");
    }
  }
}

// ---------------------------------------------------------------------------
// 迁移：把派生层索引里的历史「分类」还原成裸标签
//
// 早期版本把分类写成 `work/sales`（裹反引号）。反引号让它成了行内代码而不是
// 标签，于是这些分类从来没进过图谱。本模式只动**派生层**（agent 维护、可重建），
// 一个字节的原文都不碰；改完每个标签仍要过 validateTags 那道闸。
// ---------------------------------------------------------------------------

const MIGRATE_LIST_PAYLOAD = String.raw`
(async () => {
  const P = globalThis.__DJ_P;
  const out = [];
  const prefix = P.folder + "/";
  for (const f of app.vault.getMarkdownFiles()) {
    if (f.path.indexOf(prefix) !== 0) continue;
    if (f.path.slice(prefix.length).indexOf("/") >= 0) continue;
    out.push({ path: f.path, content: await app.vault.cachedRead(f) });
  }
  return JSON.stringify({ ok: true, files: out, root: app.vault.adapter.basePath });
})()
`;

const BT_CHAR = String.fromCharCode(96);

// 索引行 = "| 时间 | 块 id | 分类 | 关联 |"
function splitIndexRow(line) {
  if (line.charAt(0) !== "|" || line.charAt(line.length - 1) !== "|") return null;
  const parts = line.slice(1, -1).split("|").map((s) => s.trim());
  if (parts.length !== 4) return null;
  if (!/^\d{2}:\d{2}$/.test(parts[0])) return null;
  if (parts[1].length < 3 || parts[1].charAt(0) !== BT_CHAR || parts[1].charAt(parts[1].length - 1) !== BT_CHAR) return null;
  return parts;
}

// 只认「每一段都裘了反引号」的旧格式；混写（已经是裸标签）直接返回 null，不动它
function unwrapLegacyCategory(cat) {
  const toks = cat.split(/\s+/).filter(Boolean);
  if (toks.length === 0) return null;
  const out = [];
  for (const t of toks) {
    if (t.length < 2 || t.charAt(0) !== BT_CHAR || t.charAt(t.length - 1) !== BT_CHAR) return null;
    out.push(t.slice(1, -1));
  }
  return out;
}

function cmdMigrateTags(vault, args) {
  let map = [];
  if (typeof args.map === "string" && args.map.trim() !== "") {
    try {
      map = parseReplaceList(args.map, "--map");
    } catch (e) {
      fail(String((e && e.message) || e));
    }
  }

  const dp = dailyPath(vault);
  const slash = dp.lastIndexOf("/");
  const folder = slash > 0 ? dp.slice(0, slash) : "";
  if (folder === "") fail("定位不到日记目录（daily:path = " + dp + "）");

  const listed = evalInObsidian(
    vault,
    "globalThis.__DJ_P = " + JSON.stringify({ folder: folder }) + ";\n" + MIGRATE_LIST_PAYLOAD,
  );

  const tagVocab = loadTags(vault, args);
  const known = {
    skeleton: new Set(tagVocab.tags.filter((t) => t.source === "skeleton").map((t) => t.tag)),
    live: new Set(tagVocab.tags.filter((t) => t.source === "vault").map((t) => t.tag)),
  };

  const plans = [];
  const rows = [];
  for (const f of listed.files) {
    const lines = f.content.split("\n");
    let touched = false;
    for (let i = 0; i < lines.length; i++) {
      const parts = splitIndexRow(lines[i]);
      if (!parts) continue;
      const legacy = unwrapLegacyCategory(parts[2]);
      if (!legacy) continue;

      // 先套映射，再加 # ，再校验
      const mapped = legacy.map((t) => {
        let v = t;
        for (const p of map) if (v === p.from) v = p.to;
        return v;
      });
      const tags = mapped.map((t) => "#" + t);
      const check = validateTags(tags.join(" "), known);
      if (!check.ok) fail("迁移后不合法：" + f.path + " 第 " + (i + 1) + " 行 " + JSON.stringify(tags.join(" ")) + "\n  " + check.reason);
      if (check.novel && check.novel.length > 0) {
        fail(
          "迁移后出现词表外的新标签（D5：必须先问用户）：" + check.novel.join("、") + "\n" + "  在 " + f.path + " 第 " + (i + 1) + " 行。若已确认，用 --map='旧→新' 指定，或加 --allow-new-tag。",
        );
      }

      lines[i] = "| " + parts[0] + " | " + parts[1] + " | " + tags.join(" ") + " | " + parts[3] + " |";
      touched = true;
      rows.push({ path: f.path, line: i + 1, id: parts[1].slice(1, -1), from: parts[2], to: tags.join(" ") });
    }
    if (touched) plans.push({ rel: f.path, expectBefore: f.content, after: lines.join("\n") });
  }

  if (rows.length === 0) {
    process.stdout.write("迁移：没有找到裹反引号的历史分类，无需迁移。\n");
    return;
  }

  if (!args.write) {
    if (args.json) process.stdout.write(JSON.stringify({ ok: true, dryRun: true, rows: rows }, null, 2) + "\n");
    else {
      process.stdout.write("迁移历史分类为裸标签（未落盘）\n\n");
      for (const r of rows) {
        process.stdout.write("  " + r.path + ":" + r.line + "  " + r.id + "\n    " + r.from + "  →  " + r.to + "\n");
      }
      process.stdout.write("\n只改派生层索引行的分类列，原文与关联列不动。确认后加 --write 重跑。\n");
    }
    return;
  }

  const bdir = path.join(listed.root, ".daily-journal", "backup");
  fs.mkdirSync(bdir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const p of plans) {
    const b = path.join(bdir, path.basename(p.rel) + "." + stamp + ".bak");
    fs.writeFileSync(b, p.expectBefore);
    p.backup = b;
    const res = evalInObsidian(
      vault,
      "globalThis.__DJ_P = " + JSON.stringify({ path: p.rel, expectBefore: p.expectBefore, after: p.after }) + ";\n" + FIXWRITTEN_PAYLOAD,
    );
    if (!res.ok) fail("落盘失败 " + p.rel + "：" + res.error);
    if (!res.beforeMatched) fail("落盘前比对失败 " + p.rel + "：文件在读取后被改过，未写入");
    if (!res.readBackExact) fail("回读不一致 " + p.rel + "：备份在 " + p.backup);
  }

  if (args.json) process.stdout.write(JSON.stringify({ ok: true, status: "written", rows: rows }, null, 2) + "\n");
  else {
    process.stdout.write("迁移完成：" + rows.length + " 行\n\n");
    for (const r of rows) process.stdout.write("  " + r.path + ":" + r.line + "  " + r.from + "  →  " + r.to + "\n");
    for (const p of plans) process.stdout.write("  备份: " + p.backup + "\n");
  }
}

// ---------------------------------------------------------------------------
// 自检：块 id 是否仍与正文自洽
//
// id = <YYYYMMDD>-<HHmm>-<sha1(正文) 前 4 位>。只要有人动过正文而没重算 id，
// 这个等式就断了。它是「原文有没有被静静改过」最便宜的一条证据。
// 注意：id 是 agent 自己生成的 opaque 锚点，不是用户写的话，所以重算它
// 不碰 R3。本模式只改 jc:begin/jc:end 两行与索引行里的 id 字符串。
// ---------------------------------------------------------------------------

const ID_BEGIN_RE = /^<!-- jc:begin id=(\d{8}-\d{4}-([0-9a-f]{4})) -->$/;

function cmdVerifyIds(vault, args) {
  const dp = dailyPath(vault);
  const slash = dp.lastIndexOf("/");
  const folder = slash > 0 ? dp.slice(0, slash) : "";
  if (folder === "") fail("定位不到日记目录（daily:path = " + dp + "）");
  const listed = evalInObsidian(
    vault,
    "globalThis.__DJ_P = " + JSON.stringify({ folder: folder }) + ";\n" + MIGRATE_LIST_PAYLOAD,
  );

  const rows = [];
  const plans = [];
  for (const f of listed.files) {
    const lines = f.content.split("\n");
    const stale = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(ID_BEGIN_RE);
      if (!m) continue;
      const endLine = "<!-- jc:end id=" + m[1] + " -->";
      let j = -1;
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k] === endLine) {
          j = k;
          break;
        }
      }
      if (j < 0) {
        rows.push({ path: f.path, line: i + 1, id: m[1], ok: false, reason: "end 标记缺失" });
        continue;
      }
      const body = lines.slice(i + 2, j - 1).join("\n");
      const got = crypto.createHash("sha1").update(body, "utf8").digest("hex").slice(0, 4);
      rows.push({ path: f.path, line: i + 1, id: m[1], stored: m[2], computed: got, ok: got === m[2] });
      if (got !== m[2]) {
        stale.push({ id: m[1], newId: m[1].slice(0, m[1].length - 5) + "-" + got, from: i, to: j });
      }
    }
    if (stale.length === 0) continue;
    for (const s of stale) {
      lines[s.from] = "<!-- jc:begin id=" + s.newId + " -->";
      lines[s.to] = "<!-- jc:end id=" + s.newId + " -->";
    }
    let after = lines.join("\n");
    for (const s of stale) after = replaceAllText(after, BT_CHAR + s.id + BT_CHAR, BT_CHAR + s.newId + BT_CHAR);
    // 块外必须逐字节未动：把上面三处 id 字符串全推回去，应正好等于原文
    let restored = after;
    for (const s of stale) {
      restored = replaceAllText(restored, "<!-- jc:begin id=" + s.newId + " -->", "<!-- jc:begin id=" + s.id + " -->");
      restored = replaceAllText(restored, "<!-- jc:end id=" + s.newId + " -->", "<!-- jc:end id=" + s.id + " -->");
      restored = replaceAllText(restored, BT_CHAR + s.newId + BT_CHAR, BT_CHAR + s.id + BT_CHAR);
    }
    plans.push({ rel: f.path, expectBefore: f.content, after: after, stale: stale, untouched: restored === f.content });
  }

  const bad = rows.filter((r) => !r.ok);
  const staleCount = plans.reduce((n, p) => n + p.stale.length, 0);

  if (bad.length === 0) {
    if (args.json) process.stdout.write(JSON.stringify({ ok: true, status: "consistent", blocks: rows.length, rows: rows }, null, 2) + "\n");
    else process.stdout.write("id 自检：" + rows.length + " 个块全部与正文自洽 ✅\n");
    return;
  }

  if (!args.write) {
    if (args.json) process.stdout.write(JSON.stringify({ ok: false, status: "stale", blocks: rows.length, stale: bad, rows: rows }, null, 2) + "\n");
    else {
      process.stdout.write("id 自检：" + rows.length + " 个块，其中 " + bad.length + " 个与正文对不上\n\n");
      for (const r of bad) {
        process.stdout.write(
          "  " + r.path + ":" + r.line + "  " + r.id + "\n    id 里的 hash " + (r.stored || "—") + "，正文实算 " + (r.computed || "—") + (r.reason ? "  " + r.reason : "") + "\n",
        );
      }
      process.stdout.write("\n含义：这些块的正文在写入后被改过，或由旧版脚本写入。\n加 --write 把 id 重算成与正文一致（只改 id 字符串，正文一个字节不动）。\n");
    }
    process.exit(1);
  }

  const broken = plans.filter((p) => !p.untouched);
  if (broken.length > 0) fail("块外内容被牵连：" + broken.map((p) => p.rel).join("、") + "\n  脚本 bug，已中止未落盘。");

  const bdir = path.join(listed.root, ".daily-journal", "backup");
  fs.mkdirSync(bdir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const healed = [];
  for (const p of plans) {
    const b = path.join(bdir, path.basename(p.rel) + "." + stamp + ".bak");
    fs.writeFileSync(b, p.expectBefore);
    const res = evalInObsidian(
      vault,
      "globalThis.__DJ_P = " + JSON.stringify({ path: p.rel, expectBefore: p.expectBefore, after: p.after }) + ";\n" + FIXWRITTEN_PAYLOAD,
    );
    if (!res.ok) fail("落盘失败 " + p.rel + "：" + res.error);
    if (!res.beforeMatched) fail("落盘前比对失败 " + p.rel + "：文件在读取后被改过，未写入");
    if (!res.readBackExact) fail("回读不一致 " + p.rel + "：备份在 " + b);
    for (const s of p.stale) healed.push({ path: p.rel, id: s.id, newId: s.newId });
  }

  if (args.json) process.stdout.write(JSON.stringify({ ok: true, status: "healed", healed: healed, rows: rows }, null, 2) + "\n");
  else {
    process.stdout.write("id 已重算：" + staleCount + " 个块\n\n");
    for (const h of healed) process.stdout.write("  " + h.path + "  " + h.id + " -> " + h.newId + "\n");
    process.stdout.write("\n正文一个字节未动，只换了 id 字符串。\n");
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  CLI_ARGS = args;
  const vault = typeof args.vault === "string" ? args.vault : DEFAULT_VAULT;

  // registry 是派生物，缺失时自建；显式要求重建时无条件重建，然后收工。
  if (args["rebuild-registry"]) {
    rebuildRegistry(vault);
    const reg = readRegistry(vault, args) || {};
    const sk = reg.tagSkeleton || {};
    const l1 = (sk.level1 || []).length;
    const all = (sk.all || []).length;
    process.stdout.write(
      "registry 已重建 ✅  一级 " + l1 + " + 二级 " + (all - l1) + " = " + all +
        " 个标签；锚点 " + (reg.anchors || []).length + " 条\n"
    );
    return;
  }

  if (args.help || args.h) {
    process.stdout.write(
      [
        "用法: journal_apply.mjs [选项]",
        "",
        "  写入（默认 dry-run）:",
        "    --content=<文本> | --content-file=<路径> | --stdin",
        "    --category=<#标签...>     必填，分类列写裸标签，多个用空格分隔",
        "    --links=<[[a]]、[[b]]>    可选；目标必须在库里真实存在，否则退出 7",
        "    --time=HH:MM              可选，默认当前（也接受 HHmm）",
        "    --date=YYYY-MM-DD         可选，默认今天（用于块 id）",
        "    --write                   落盘；缺省只出 diff",
        "  校对（不改写，只给建议）:",
        "    --proofread               检查输入准确性，列出疑似问题与建议",
        "  改写已写入的原文（R3 的显式例外，默认 dry-run）:",
        "    --fix-written             需要 --id 与 --replace；只动 jc:begin/jc:end 之间",
        "    --id=<块 id>              可逗号分隔多个，形如 20260916-1549-0882",
        "    --replace='错→对'          可逗号分隔多对；命中数会被验证，且必须能反向回代",
        "    --write                   落盘（会先备份到 .daily-journal/backup/）",
        "  迁移派生层的历史分类（默认 dry-run）:",
        "    --migrate-tags            把索引里裹反引号的分类还原成裸标签",
        "    --map='旧→新'             可逗号分隔多对，用于个别改写（如 life/HomeLab→life）",
        "  自检:",
        "    --verify-ids              校 jc 块的 id 是否仍与正文自洽；不一致退 1",
        "    --write                   把对不上的 id 重算回一致（正文不动）",
        "    --fix=safe                写入时自动套用无损修正（行尾空白/重复虚词/大小写）",
        "    --fix=all                 写入时套用全部可机械修正项（含改字，需用户确认）",
        "    --fix=f1,f5               只套用指定项",
        "    --fix-pair='错→对'        模型提的中文修正（脚本查不出别字）；每对必须命中，且必须能反向回代",
        "    --skip=wikilink-missing   屏蔽某类检查（逗号分隔，如 wikilink-missing,token）",
        "  分类（标签，词表实时来自 Obsidian，不落配置）:",
        "    --tags                    列出限定目录内的实时标签词表，不写盘",
        "    --scope=<d1,d2,...>       限定目录；默认 " + DEFAULT_TAG_ROOTS.join(","),
        "    --classify                对 --content 做标签候选判定，不写盘",
        "  审计:",
        "    --audit --from=YYYY-MM-DD --to=YYYY-MM-DD",
        "  通用:",
        "    --vault=<库名>            默认 nextlink",
        "    --registry=<路径>         registry.json 实例；默认按 vault/状态目录探测",
        "    --rebuild-registry        重新生成 registry（缺失时也会自动重建）",
        "    --path=<库内相对路径>     默认由 daily:path 得到",
        "    --json                    以 JSON 输出",
        "",
      ].join("\n")
    );
    return;
  }

  // 审计模式不写盘，只需能调用 eval
  if (args["fix-written"]) {
    cmdFixWritten(vault, args);
    return;
  }

  if (args["migrate-tags"]) {
    cmdMigrateTags(vault, args);
    return;
  }

  if (args["verify-ids"]) {
    cmdVerifyIds(vault, args);
    return;
  }

  if (args.audit) {
    const registry = loadRegistry(vault, args);
    const p = localParts();
    const from = typeof args.from === "string" ? args.from : p.date;
    const to = typeof args.to === "string" ? args.to : from;
    const folder = typeof args.path === "string" ? path.dirname(args.path) : path.dirname(dailyPath(vault));
    const code =
      "globalThis.__DJ_P = " +
      JSON.stringify({ from, to, folder, nameRe: "^(\\d{4})-(\\d{2})-\\d{2}w-(\\d{2})$" }) +
      ";\n" +
      AUDIT_PAYLOAD;
    const res = evalInObsidian(vault, code);
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  const content = readContent(args);

  if (args.tags) {
    const res = loadTags(vault, args);
    if (args.json) process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    else {
      const sk = res.tags.filter((t) => t.source === "skeleton");
      const lv = res.tags.filter((t) => t.source === "vault");
      process.stdout.write("标签词表（限定目录 " + res.roots.join(" / ") + "）\n");
      process.stdout.write(
        "  骨架 " + res.skeletonCount + " 个（一级 " + res.level1Count + " + 二级 " + res.level2Count +
          "）· 库内实有 " + res.liveCount + " 个 · 合计 " + res.count + " 个\n"
      );
      process.stdout.write(
        "  剔除 #gtd/* " + (res.dropped.gtd || 0) + " 个、纯数字 " + (res.dropped.numeric || 0) +
          " 个、单字符 " + (res.dropped.short || 0) + " 个\n\n"
      );
      process.stdout.write("【骨架 · 一级】\n");
      for (const t of sk) {
        if (t.level === 1) process.stdout.write("  " + t.tag + "\n");
      }
      process.stdout.write("\n【骨架 · 二级】\n");
      for (const t of sk) {
        if (t.level !== 2) continue;
        process.stdout.write(
          "  " + t.tag + (t.count > 0 ? "  (" + t.count + ")" : "") +
            (t.notePath !== "" ? "  -> " + t.notePath : "") + "\n"
        );
      }
      if (lv.length > 0) {
        process.stdout.write("\n【库内实有 · 不在骨架】（分类可复用，但写盘要 --allow-new-tag）\n");
        for (const t of lv) {
          process.stdout.write(
            "  " + t.tag + "  (" + t.count + ")" + (t.samples[0] ? "  " + t.samples[0] : "") + "\n"
          );
        }
      }
    }
    return;
  }

  if (args.classify) {
    if (content === null) fail("--classify 需要 --content / --content-file / --stdin");
    const vocab = loadTags(vault, args);
    const cands = suggestTags(content, vocab.tags);
    const res = {
      ok: true,
      roots: vocab.roots,
      vocabularyCount: vocab.count,
      candidates: cands,
      placeholder: PLACEHOLDER_TAG,
      needsUser: true,
      note:
        cands.length === 0
          ? "词表内没有可命中的标签。标签可以新建，但必须先把建议的标签给用户确认（D5）。"
          : "命中来自「骨架 ∪ 库内实有」词表。按 D5 逐条给用户确认，不要静默挑一个。",
    };
    if (args.json) process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    else if (cands.length === 0) {
      process.stdout.write("分类候选: 无（限定目录内没有可命中的现成标签，可新建，但要用户点头）\n");
    } else {
      process.stdout.write("分类候选 " + cands.length + " 个（词表 " + res.vocabularyCount + " 个）:\n");
      for (const c of cands) {
        process.stdout.write(
          "  - " + c.tag + "  [" + c.source + "/" + c.kind + ":" + c.matched + "]" +
            (c.count > 0 ? "  (" + c.count + ")" : "") +
            (c.notePath !== "" ? "  -> " + c.notePath : (c.samples[0] ? "  " + c.samples[0] : "")) + "\n"
        );
      }
    }
    process.stdout.write("需要用户确认: 是（D5：候选也要用户点头）\n");
    return;
  }

  if (args.proofread) {
    if (content === null) fail("--proofread 需要 --content / --content-file / --stdin");
    const res = runProofread(vault, content, skipSet(args));
    const out = {
      ok: true,
      findingCount: res.findings.length,
      fixableCount: res.fixableCount,
      blocking: res.findings.some((f) => f.blocking),
      changedBySafeFixes: res.corrected !== content,
      findings: res.findings,
      safeFixedText: res.corrected,
    };
    if (args.json) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    else if (res.findings.length === 0) process.stdout.write("校对：未发现可疑之处。\n");
    else {
      process.stdout.write("校对：发现 " + res.findings.length + " 处，其中可机械修正 " + res.fixableCount + " 处\n\n");
      for (const f of res.findings) {
        const auto = f.autoFix ? (SAFE_KINDS.has(f.kind) ? "[建议直改]" : "[需确认]") : "[只能手改]";
        process.stdout.write(
          "  " + f.id + "  " + f.severity.padEnd(6) + auto + "  " + f.kind + "\n" +
            "       发现: " + f.found + "\n" +
            "       建议: " + (f.suggestion === "" ? "(删除)" : f.suggestion) + "\n" +
            "       理由: " + f.reason + "\n\n"
        );
      }
    }
    return;
  }

  // 写入模式
  if (content === null) fail("缺少内容：请给 --content / --content-file / --stdin");
  if (typeof args.category !== "string" || args.category.length === 0) {
    fail("缺少 --category=<#标签...>（分类列写裸标签，可多个）");
  }
  const tagVocab = loadTags(vault, args);
  const knownTags = {
    skeleton: new Set(tagVocab.tags.filter((t) => t.source === "skeleton").map((t) => t.tag)),
    live: new Set(tagVocab.tags.filter((t) => t.source === "vault").map((t) => t.tag)),
  };
  const catCheck = validateTags(args.category, knownTags);
  if (!catCheck.ok) {
    fail(
      "--category 不合法：" +
        catCheck.reason +
        "\n  （D5：不静默降级。先跑 --tags 看词表、--classify 看候选）",
    );
  }
  if (catCheck.novel.length > 0 && !args["allow-new-tag"]) {
    fail(
      "--category 里有词表外的新标签：" + catCheck.novel.join("、") +
        "\n  新标签是允许的，但**必须先问用户**。用户点头后加 --allow-new-tag 重跑。" +
        "\n  （D5：不静默降级，也不静默扩张词表）",
    );
  }

  // 关联列只能链真实存在的文件；没有实际文档，关联就没有意义（A3）。
  if (typeof args.links === "string" && args.links.trim()) {
    const lc = checkLinks(vault, args.links);
    if (lc.malformed) {
      fail(
        "--links 必须是 wikilink 形式，例：--links='[[🎁]]、[[🐱]]'" +
          "\n  （关联列只放真实文件的链接，裸文字会变成无效关联）",
        7,
      );
    }
    if (lc.missing.length > 0) {
      fail(
        "--links 里有库里找不到的目标：" + lc.missing.map((t) => "[[" + t + "]]").join("、") +
          "\n  关联列只允许链真实存在的文件（没有实际文档，关联就没有意义）。" +
          "\n  要么去掉这些链接，要么先把对应笔记建好。" +
          "\n  （解析规则同 Obsidian：全路径/文件名/frontmatter aliases 都算命中）",
        7,
      );
    }
  }

  let finalContent = content;

  // 模型提的「错→对」对（W1）。脚本查不出的中文别字走这条通道：
  // 模型只出对与理由，替换由脚本做；每一对都必须命中，命中不到即拒绝 ——
  // 那说明模型读错了原文，不能默默放过。
  // 顺序在 --fix 之前：模型读的是原始文本，机械修正会先动它。
  let pairReport = null;
  if (typeof args["fix-pair"] === "string") {
    let pairs;
    try {
      pairs = parseReplaceList(args["fix-pair"], "--fix-pair");
    } catch (e) {
      fail(String((e && e.message) || e));
    }
    const before = finalContent;
    let after = before;
    const applied = [];
    for (const p of pairs) {
      const n = countOf(after, p.from);
      if (n === 0) {
        fail(
          "--fix-pair 没有命中：" + p.from + " → " + p.to +
            "\n  原文里找不到「" + p.from + "」。这通常意味着模型读错了原文 —— 核对后重来，不要默默放过。",
        );
      }
      after = replaceAllText(after, p.from, p.to);
      applied.push({ from: p.from, to: p.to, n: n });
    }
    // 反向回代必须逐字节回到原文 —— 与 --fix-written 同一条硬证据
    let back = after;
    for (const a of applied) back = replaceAllText(back, a.to, a.from);
    if (back !== before) {
      fail(
        "回代校验失败：--fix-pair 不是干净的字面替换（右值在原文中也出现过，会互相干扰）。" +
          "\n  请换更长的上下文再试，不要用会撞车的对。",
      );
    }
    pairReport = { applied: applied.map((a) => a.from + "→" + a.to), changed: after !== before };
    finalContent = after;
  }

  let fixReport = null;
  if (typeof args.fix === "string") {
    const pf = runProofread(vault, finalContent, skipSet(args));
    let ids;
    if (args.fix === "safe") ids = safeIds(pf.findings);
    else if (args.fix === "all") ids = "all";
    else ids = args.fix.split(",").map((s) => s.trim()).filter(Boolean);
    const r = applyFixes(finalContent, pf.findings, ids);
    const byId = new Map(pf.findings.map((f) => [f.id, f]));
    fixReport = {
      requested: args.fix,
      applied: r.applied.map((id) => (byId.get(id) || {}).found).filter(Boolean),
      appliedIds: r.applied,
      changed: r.text !== finalContent,
    };
    finalContent = r.text;
  }

  const parts = localParts();
  const t =
    typeof args.time === "string" ? parseTime(args.time) : { compact: parts.hm, display: parts.hms };
  const idBase =
    (typeof args.date === "string" ? args.date.replace(/-/g, "") : parts.ymd) + "-" + t.compact;
  const hash = crypto.createHash("sha1").update(finalContent, "utf8").digest("hex").slice(0, 4);
  const id = idBase + "-" + hash;

  const rel = typeof args.path === "string" ? args.path : ensureDaily(vault);
  const payload = {
    path: rel,
    content: finalContent,
    id,
    time: t.display,
    category: args.category,
    links: typeof args.links === "string" ? args.links : "",
    write: !!args.write,
    sections: SECTIONS,
  };

  const code = "globalThis.__DJ_P = " + JSON.stringify(payload) + ";\n" + WRITE_PAYLOAD;
  const res = evalInObsidian(vault, code);

  if (fixReport) res.fixReport = fixReport;
  if (pairReport) res.pairReport = pairReport;

  if (!res.ok && res.status !== "duplicate") {
    process.stderr.write(JSON.stringify(res, null, 2) + "\n");
    process.exit(res.error === "id-collision" ? 5 : 6);
  }

  if (res.status === "duplicate") {
    process.stdout.write(
      (args.json ? JSON.stringify(res, null, 2) : "重复：相同内容已在 " + res.path + " 中（id=" + res.id + "），未写入。") + "\n"
    );
    return;
  }

  const diff = res.before !== undefined && res.after !== undefined ? unifiedDiff(res.before, res.after) : "";
  delete res.before;
  delete res.after;
  res.diff = diff;

  if (args.json) process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  else {
    process.stdout.write("目标: " + res.path + "\n");
    process.stdout.write("状态: " + res.status + "  id: " + res.id + "  分类: " + res.category + "\n");
    if (res.fixReport && res.fixReport.changed) {
      process.stdout.write("修正: 已套用 " + res.fixReport.applied.length + " 处 -> " + res.fixReport.applied.join("、") + "\n");
    }
    if (res.pairReport && res.pairReport.changed) {
      process.stdout.write("中文修正: 已套用 " + res.pairReport.applied.length + " 处 -> " + res.pairReport.applied.join("、") + "\n");
    }
    process.stdout.write("校验: " + JSON.stringify(res.verify) + "\n");
    if (diff) {
      process.stdout.write("\n--- diff ---\n");
      process.stdout.write(diff.endsWith("\n") ? diff : diff + "\n");
    }
    if (res.status === "dry-run") process.stdout.write("\n未落盘。确认后加 --write 重跑。\n");
  }
}

// 接受 HH:MM 或 HHMM，返回 { compact: "1547", display: "15:47" }
function parseTime(v) {
  const m = String(v).match(/^(\d{1,2}):?(\d{2})$/);
  if (!m) fail("--time 需为 HH:MM 或 HHMM");
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) fail("--time 超出范围: " + v);
  return { compact: pad2(h) + pad2(mi), display: pad2(h) + ":" + pad2(mi) };
}

preflight();
main();
