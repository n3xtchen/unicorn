#!/usr/bin/env node
// daily-journal · 分类判定 / 追加写入 / 审计
//
// 三种模式：
//   --classify            只做分类判定，不写盘
//   --audit               扫描日期区间内分类仍是占位标签（#unsorted）的条目
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
// 本机特定的配置一律走环境变量，不写死在逻辑里。
const DEFAULT_VAULT = process.env.DJ_VAULT || "nextlink";
// obsidian CLI 偶发无响应，挂住的子进程会让本脚本永久等待；超时即杀掉并退出 4。
const OBSIDIAN_TIMEOUT_MS = (() => {
  const n = Number(process.env.DJ_TIMEOUT_MS || 30000);
  return Number.isFinite(n) && n > 0 ? n : 30000;
})();

// parseArgs 的结果在 main 里落到这里，供不接 args 的调用点（如 runProofread）取用。
let CLI_ARGS = {};

const SECTIONS = {
  thinking: "今日的思考",
  todo: "今日待办",
  derived: "今日分类与关联",
  related: "关联笔记",
};

// 日记笔记名形如 2026-09-38w-19（= date "+%G-%Vw-%d"），由此推出「这条笔记是哪天」。
// ➕ 必须等于**笔记日期**而不是脚本运行日（D22）：补记昨天时错一天，行本身仍完全合法，
// 五项校验全绿，没有任何机械守卫能拦住 —— 只能靠这里取对值。
const DAILY_BASENAME_RE = /^(\d{4})-(\d{2})-\d{2}w-(\d{2})$/;

// 块尾锚点 ` ^<块 id>`，钉在正文最后一行的末尾，让 [[笔记#^id]] 能跳到这段思考。
// Obsidian 只认落在一段**真文本**里的锚点（整行只有 ^id，或跟在别的字后面都行）；
// HTML 注释行认不认没实测过，不赌它，所以锚点不挂在 <!-- jc:end … --> 上，只挤进正文。
// 代价与口径：**锚点不算正文** —— 算 sha1、比对幂等之前一律先剥掉，
// 否则锚点里的 id 会自指进 hash（id 是 sha1(正文)，锚点又是 id）。
const TAIL_ANCHOR_RE = / \^[A-Za-z0-9._-]+$/;
const stripTailAnchor = function (s) { return s.replace(TAIL_ANCHOR_RE, ""); };

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
  try {
    return execFileSync(OBSIDIAN_BIN, ["vault=" + vault, ...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: OBSIDIAN_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch (e) {
    // 只有 ETIMEDOUT 才是「本脚本自己超时杀的」。signal 单独出现 = 被外部（系统回收 /
    // Obsidian 崩溃）杀掉，不能冒充「偶发无响应、重跑即可」，否则会盖住真实崩溃。
    const timedOut = !!(e && e.code === "ETIMEDOUT");
    const killedBy =
      e && (e.signal === "SIGKILL" || e.signal === "SIGTERM") ? e.signal : null;
    const where = "obsidian vault=" + vault + " " + args.join(" ").slice(0, 200);
    if (timedOut) {
      fail(
        "obsidian CLI 超过 " + OBSIDIAN_TIMEOUT_MS + "ms 无响应（子进程已超时杀掉）：" + where +
          "\n  这是 Obsidian 侧偶发无响应，重跑通常即可；重复出现请重启 Obsidian（可用 DJ_TIMEOUT_MS 调阈值）。",
        4
      );
    }
    if (killedBy) {
      fail(
        "obsidian CLI 子进程被 " + killedBy + " 终止（不是超时）：" + where +
          "\n  多为 Obsidian 崩溃或被系统回收内存。先重跑一次；反复出现请重启 Obsidian 并查看崩溃报告。",
        4
      );
    }
    throw e;
  }
}

// obsidian CLI 解析 code= 入参时，约每 8192 字节会吃掉几个**多字节字符**（中文/emoji 变成
// U+FFFD，纯 ASCII 不受影响；同一载荷逐字节可复现；回程 stdout 测到 240KB 无损）。
// 所以进 code= 前把非 ASCII 全部写成 \\uXXXX 转义——语义完全等价，但入参变成纯 ASCII，
// 不再有可被切坏的多字节序列。另见 FIXWRITTEN_PAYLOAD 里的 afterSum 落盘前自查。
function escapeNonAsciiForCli(code) {
  return code.replace(/[\u007f-\uffff]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

function evalInObsidian(vault, code) {
  const raw = obsidian(vault, ["eval", "code=" + escapeNonAsciiForCli(code)]);
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
  const sumOf = function (s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  };
  // 落盘前先拿 Node 算的 len/sum 自查（C11）：载荷在 code= 入参上被改写就一个字都不写。
  // 字段顺序必须与 Node 侧 captureStampSrc() 逐字对应；捕获通道由此不再只剩「字符串相等」一层。
  const stampSrc = [P.content, P.anchor, P.id, P.time, P.noteDate, P.createdDateSource, P.category, P.links, P.sections.thinking, P.sections.todo, P.sections.derived, P.sections.related].join("\u0000");
  if (stampSrc.length !== P.stampLen || sumOf(stampSrc) !== P.stampSum) {
    return JSON.stringify({
      ok: false,
      error: "transport-corrupt",
      path: P.path,
      gotLen: stampSrc.length,
      wantLen: P.stampLen
    });
  }
  const file = app.vault.getAbstractFileByPath(P.path);
  if (!file) return JSON.stringify({ ok: false, error: "note-not-found", path: P.path });

  const before = await app.vault.read(file);
  const lines = before.split(NL);

  const head = function (s) {
    const m = s.match(/^(#{1,6})\s+(.*?)\s*$/);
    return m ? { level: m[1].length, text: m[2] } : null;
  };

  let rawStart = -1, related = -1, derived = -1, todo = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = head(lines[i]);
    if (!h) continue;
    if (rawStart < 0 && h.level === 2 && h.text === P.sections.thinking) { rawStart = i; continue; }
    if (rawStart >= 0) {
      if (related < 0 && h.level === 3 && h.text === P.sections.related) related = i;
      if (derived < 0 && h.level === 2 && h.text === P.sections.derived) derived = i;
      if (todo < 0 && h.level === 2 && h.text === P.sections.todo) todo = i;
    }
  }
  if (rawStart < 0) return JSON.stringify({ ok: false, error: "section-missing", detail: P.sections.thinking, path: P.path });
  if (related < 0) return JSON.stringify({ ok: false, error: "section-missing", detail: P.sections.related, path: P.path });
  if (derived >= 0 && !(derived > rawStart && derived < related)) derived = -1;
  // 待办节必须在思考层与派生层（或关联笔记）之间；被拖到别处就当它不存在，
  // 退回改动前的行为 —— 不报错，也不把块写进去。与 derived 的守卫同一条口径。
  const todoEnd = derived >= 0 ? derived : related;
  if (todo >= 0 && !(todo > rawStart && todo < todoEnd)) todo = -1;
  const isTodo = P.kind === "todo";

  const beginRe = /^<!--\s*jc:begin\s+id=([A-Za-z0-9._-]+)\s*-->$/;
  const endRe = /^<!--\s*jc:end\s+id=([A-Za-z0-9._-]+)\s*-->$/;
  const idxBeginRe = /^<!--\s*jc:index:begin\s*-->$/;
  const idxEndRe = /^<!--\s*jc:index:end\s*-->$/;
  const norm = function (s) { return s.replace(/\s+$/, ""); };
  const tailAnchorRe = / \^[A-Za-z0-9._-]+$/;
  const stripTailAnchor = function (s) { return s.replace(tailAnchorRe, ""); };
  // 比对正文（撞 id / 幂等）时先剥锚点：不剥，同一段思考第二次捕获就对不上，会被当新块重复写。
  const bodyOf = function (arr) { return stripTailAnchor(arr.map(norm).join(NL).trim()); };

  // 落盘 / 读回是两条写入通道（思考 / 待办）共用的尾段。口径只能有一处，
  // 否则就会出现「写盘会并发守卫、另一条不会」这类两个入口两个口径的缺陷（D18）。
  const commit = async function (out, after) {
    if (!P.write) {
      out.status = "dry-run";
      out.before = before;
      out.after = after;
      return JSON.stringify(out);
    }
    let concurrent = false;
    await app.vault.process(file, function (data) {
      if (data !== before) { concurrent = true; return data; }
      return after;
    });
    if (concurrent) {
      out.ok = false;
      out.status = "concurrent-edit";
      out.error = "concurrent-edit";
      return JSON.stringify(out);
    }
    const readBack = await app.vault.read(file);
    const readBackExact = readBack === after;
    out.status = readBackExact ? "written" : "readback-mismatch";
    out.ok = readBackExact;
    out.readBackExact = readBackExact;
    if (!readBackExact) out.readBack = readBack;
    out.before = before;
    out.after = after;
    return JSON.stringify(out);
  };

  if (isTodo) {
    const tBeginRe = /^<!--\s*jt:begin\s*-->$/;
    const tEndRe = /^<!--\s*jt:end\s*-->$/;

    // jt 区整节唯一、无 id（D20）：一对标记，且必须都落在待办节里。
    const bIdx = [], eIdx = [];
    for (let i = 0; i < lines.length; i++) {
      if (tBeginRe.test(lines[i])) bIdx.push(i);
      if (tEndRe.test(lines[i])) eIdx.push(i);
    }
    if (bIdx.length > 1 || eIdx.length > 1 || bIdx.length !== eIdx.length) {
      return JSON.stringify({ ok: false, error: "orphan-jt-markers", detail: "jt:begin " + bIdx.length + " 个 / jt:end " + eIdx.length + " 个", path: P.path });
    }
    const jtFrom = bIdx.length === 1 ? bIdx[0] : -1;
    const jtTo = eIdx.length === 1 ? eIdx[0] : -1;
    if (jtFrom >= 0 && (todo < 0 || jtFrom <= todo || jtTo >= todoEnd)) {
      return JSON.stringify({ ok: false, error: "orphan-jt-markers", detail: "jt 标记不在 ## " + P.sections.todo + " 节内", path: P.path });
    }

    const todoLines = P.content.split(NL).map(norm);
    const adds = todoLines;
    const addsNonBlank = adds.filter(function (s) { return s !== ""; });
    const region = jtFrom >= 0 ? lines.slice(jtFrom + 1, jtTo).map(norm) : [];
    const have = Object.create(null);
    for (const l of region) have[l] = 1;
    const dup = [], fresh = [];
    for (const l of addsNonBlank) {
      if (have[l] === 1) { if (dup.indexOf(l) < 0) dup.push(l); } else fresh.push(l);
    }
    if (dup.length > 0 && fresh.length === 0) {
      return JSON.stringify({ ok: true, status: "duplicate", kind: "todo", path: P.path, duplicateLines: dup, taskCountBefore: addsNonBlank.length, taskCountAfter: region.filter(function (s) { return s !== ""; }).length });
    }
    // 部分重复不能静默跳过 —— 那就成了一条静默失效（D18）：用户以为三条都记上了，实际只落两条。
    if (dup.length > 0) {
      return JSON.stringify({ ok: false, error: "task-line-duplicate", duplicateLines: dup, newLines: fresh, path: P.path });
    }

    let after;
    if (jtFrom >= 0) {
      after = lines.slice(0, jtTo).concat(adds, lines.slice(jtTo)).join(NL);
    } else if (todo >= 0) {
      // 节在、标记不在：把标记对补在节体末尾，用户写在节里的内容原样留在上方。
      // 前后各留一个空行：body 末尾那个空行正好当 jt:begin 前的分隔，但 jt:end 后面
      // 卸下的是下一个 H2，不自己补一个就会把标题顶上去（MD022）。
      const body = lines.slice(todo + 1, todoEnd);
      const ins = [];
      if (body.length === 0 || body[body.length - 1].trim() !== "") ins.push("");
      ins.push("<!-- jt:begin -->");
      for (const l of adds) ins.push(l);
      ins.push("<!-- jt:end -->", "");
      after = lines.slice(0, todoEnd).concat(ins, lines.slice(todoEnd)).join(NL);
    } else {
      // 节也不在：整节建出来，插在派生层（或关联笔记）之前
      const sec = ["## " + P.sections.todo, "", "<!-- jt:begin -->"].concat(adds, ["<!-- jt:end -->", ""]);
      after = lines.slice(0, todoEnd).concat(sec, lines.slice(todoEnd)).join(NL);
    }

    const aLines = after.split(NL);
    let ab = -1, ae = -1, nB = 0, nE = 0, hIdx = -1;
    for (let i = 0; i < aLines.length; i++) {
      if (tBeginRe.test(aLines[i])) { nB++; if (ab < 0) ab = i; }
      if (tEndRe.test(aLines[i])) { nE++; if (ae < 0) ae = i; }
      const h = head(aLines[i]);
      if (hIdx < 0 && h && h.level === 2 && h.text === P.sections.todo) hIdx = i;
    }
    // 区内容纯净：区内每一行要么是子项（缩进），要么是列表项，不能夹着裸文字。
    let clean = ab >= 0 && ae > ab;
    for (let i = ab + 1; clean && i < ae; i++) {
      const l = aLines[i];
      if (l.trim() === "") continue;
      if (/^[ \t]/.test(l)) continue;
      if (/^[-*+](\s|$)/.test(l)) continue;
      clean = false;
    }
    const regionAfter = ab >= 0 ? aLines.slice(ab + 1, ae).map(norm) : [];
    const allInserted = addsNonBlank.filter(function (l) { return regionAfter.indexOf(l) < 0; }).length === 0;
    // inSection：标记必须真的在 ## 今日待办 这一节里，中间不能冒出任何标题。
    // 这是本区专用的 blockInSection，与思考通道那条同源：查的是「放对了没有」。
    let stray = false;
    for (let i = hIdx + 1; i < ab; i++) { if (head(aLines[i])) { stray = true; break; } }

    let sub = 0;
    for (let j = 0; j < aLines.length && sub < lines.length; j++) if (lines[sub] === aLines[j]) sub++;

    const tverify = {
      jtPairPresent: nB === 1 && nE === 1,
      inSection: hIdx >= 0 && ab > hIdx && !stray,
      linesInserted: allInserted,
      regionClean: clean,
      originalsPreserved: sub === lines.length
    };
    tverify.allOk = tverify.jtPairPresent && tverify.inSection && tverify.linesInserted && tverify.regionClean && tverify.originalsPreserved;
    if (!tverify.allOk) {
      return JSON.stringify({ ok: false, error: "pre-write-verify-failed", verify: tverify, path: P.path, before: before, after: after });
    }

    return await commit({
      ok: true, path: P.path, kind: "todo",
      addedLines: addsNonBlank,
      taskCountAfter: regionAfter.filter(function (s) { return s !== ""; }).length,
      verify: tverify
    }, after);
  }

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

  // 锚点是**纯追加**在正文最后一行末尾（不另起一行）：正文一个字节没动，
  // bodyExact 仍按 P.content 找子串、恒命中。末不适合钉时 P.anchor 为空串（见 main 里的 tailAnchorBlocker）。
  const anchoredContent = P.content + (P.anchor || "");
  const block = ["<!-- jc:begin id=" + P.id + " -->", ""].concat(anchoredContent.split(NL), ["", "<!-- jc:end id=" + P.id + " -->"]);

  const rawEndBase = derived >= 0 ? derived : related;
  // 待办节是原文区与派生层之间多出来的一层。不把它算进来，新块就会拼到待办节**后面**，
  // 而五项校验一条都拦不住（它们查「有没有弄坏已有内容」，不查「新内容放对没放对」）—— D25。
  const rawEnd = todo >= 0 && todo < rawEndBase ? todo : rawEndBase;
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
  const linkCell = P.links && P.links.length > 0 ? P.links : "\u2014";
  // 块 id 列写成**块链接**（别名保留 id 文本，否则 Obsidian 渲染成「笔记 > 块 id」，
  // 这一列会被撑得很长）：点一下跳回那段思考。
  // 笔记名不能省 —— [[#^id]] 是同文档引用，行被剪到别的笔记里就哑了（与待办出处标记同口径）。
  // 别名里的 | 必须逃成 \|，否则 markdown 会把它当成列分隔符（同关联列）。
  const noteName = P.path.split("/").pop().replace(/\.md$/, "");
  const idCell = "[[" + noteName + "#^" + P.id + "\\|" + P.id + "]]";
  const row = "| " + P.time + " | " + idCell + " | " + P.category + " | " + linkCell + " |";

  if (derived >= 0 && iBegin >= 0 && iEnd > iBegin) {
    tail = tail.slice(0, iEnd).concat([row], tail.slice(iEnd));
  } else if (derived < 0) {
    if (iBegin >= 0 || iEnd >= 0) return JSON.stringify({ ok: false, error: "orphan-index-markers", path: P.path });
    const ins = [
      "## " + P.sections.derived,
      "",
      "<!-- jc:index:begin -->",
      "| 时间 | 块 id | 分类 | 关联 |",
      "| --- | --- | --- | --- |",
      row,
      "<!-- jc:index:end -->",
      ""
    ];
    // 插在 ### 关联笔记 之前，**不是**拼在 tail 头上：待办节存在时 rawEnd 会提前到它那儿，
    // 直接拼头会让 ## 今日分类与关联 插到 ## 今日待办 前面。待办节不存在时两者相等。
    const at = related - rawEnd;
    tail = tail.slice(0, at).concat(ins, tail.slice(at));
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

  const newBeginLine = "<!-- jc:begin id=" + P.id + " -->";
  const newEndLine = "<!-- jc:end id=" + P.id + " -->";
  const newBeginAt = afterLines.indexOf(newBeginLine);
  const newEndAt = afterLines.indexOf(newEndLine);
  // 第 6 项校验（D25）：新块必须真的落在「今日的思考」这一节里 ——
  // 它与 rawStart 之间不能再冒任何 H2（## 今日待办 / ## 今日分类与关联 都算越界）。
  // 既有的五项全绿也能放错区，因为它们是内容守恒检查，不是位置检查。
  let strayH2 = false;
  for (let j = rawStart + 1; j < newBeginAt; j++) {
    const h = head(afterLines[j]);
    if (h && h.level <= 2) { strayH2 = true; break; }
  }

  const verify = {
    marksBalanced: vBegin === vEnd,
    oneBlockAdded: vBegin === blocks.length + 1,
    hasNewBlock: after.indexOf(newBeginLine) >= 0,
    bodyExact: P.content.length > 0 && after.indexOf(P.content) >= 0,
    originalsPreserved: originalsPreserved,
    blockInSection: newBeginAt > rawStart && newEndAt > newBeginAt && !strayH2
  };
  verify.allOk = verify.marksBalanced && verify.oneBlockAdded && verify.hasNewBlock && verify.bodyExact && verify.originalsPreserved && verify.blockInSection;
  if (!verify.allOk) {
    return JSON.stringify({ ok: false, error: "pre-write-verify-failed", verify: verify, path: P.path, before: before, after: after });
  }

  const base = {
    ok: true, path: P.path, id: P.id, category: P.category, links: P.links,
    blockCountBefore: blocks.length, blockCountAfter: vBegin, verify: verify
  };

  // 乐观并发与读回校验都在 commit 里（与待办通道共用，口径只有一处）。
  return await commit(base, after);
})()
`;

const FILES_PAYLOAD = String.raw`
(async () => {
  const P = globalThis.__DJ_P;
  const all = [];
  const paths = [];
  const files = app.vault.getFiles();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    all.push(f.basename);
    paths.push(f.path);
    if (f.extension === "md") paths.push(f.path.slice(0, f.path.length - 3));
  }
  return JSON.stringify({ ok: true, all: all, paths: paths });
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
      const root = roots[r].replace(/\/+$/, "");
      if (f.path === root || f.path.indexOf(root + "/") === 0) { ok = true; break; }
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
  // 与 Node 侧 splitUnescapedPipes 同一口径：\| 是格内字面管道，不是列分隔符。
  // 硬 split("|") 会让块 id 列里的 \| 把列序号整体后移，cells[3] 就拿不到分类列 ——
  // 那些行会被**悄悄丢掉**（不报错，只是结果少几行）。
  const splitRowCells = function (s) {
    const out = [];
    let cur = "";
    for (let i = 0; i < s.length; i++) {
      const c = s.charAt(i);
      if (c === "\\" && s.charAt(i + 1) === "|") { cur += "\\|"; i++; continue; }
      if (c === "|") { out.push(cur); cur = ""; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  };
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
      const cells = splitRowCells(lines[j]);
      if (cells.length < 5) continue;
      const tags = cells[3].split(/\s+/).filter(function (s) { return s.length > 0; });
      if (tags.indexOf(P.tag) < 0) continue;
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

function proofread(content, vocab, linkIndex, skipKinds, ctx) {
  const findings = [];
  const ranges = codeRanges(content);
  const lines = content.split("\n");

  if (content.trim() === "") {
    findings.push({ kind: "empty", severity: "high", autoFix: false, blocking: true, found: "(空)", suggestion: "", reason: "内容为空或只有空白，没有可写入的原文。" });
  }

  // 待办通道只跑 task-* 那一套（taskFindings 自带行尾空白之外的检查）：
  // 通用的散文检查在任务行上全是噪音 —— 行内的 #gtd/next-action 会被当成英文词
  // 报 ascii-case，就是个典型。两个口径分开，也便于 --skip 的语义看清楚。
  if (CLI_ARGS.kind === "todo") {
    for (const f of taskFindings(content, ctx)) findings.push(f);
    return tallyFindings(content, findings, skipKinds);
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
  // 同一个词只出一条 finding（不重复刷屏），但 finding 记下它**全部**出现的 span：
  // 同一词的每一处都要被改掉，与 --fix-pair 的全量替换同一口径（R4）。
  const asciiSeen = new Map();
  while ((m = wordRe.exec(content))) {
    const w = m[0];
    if (inRanges(skipRanges, m.index)) continue;
    if (vocab.has(w)) continue;

    const canonical = lower.get(w.toLowerCase());
    let kind = null;
    let repl = null;
    let reason = null;
    if (canonical && canonical !== w) {
      kind = "ascii-case";
      repl = canonical;
      reason = "词表中的规范写法是 " + canonical + "。";
    } else if (!canonical && !ASCII_STOPWORDS.has(w.toLowerCase()) && w.length >= 5) {
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
        kind = "ascii-typo";
        repl = best.t;
        reason = "与本库词表「" + best.t + "」相差 " + best.d + " 个字符，疑似拼写错误。";
      }
    }
    if (!kind) continue;

    const span = { start: m.index, end: m.index + w.length };
    const prev = asciiSeen.get(w);
    if (prev) {
      prev.spans.push(span);
      continue;
    }
    const finding = {
      kind: kind,
      severity: kind === "ascii-typo" ? "medium" : "low",
      autoFix: true,
      start: span.start,
      end: span.end,
      spans: [span],
      replace: repl,
      found: w,
      suggestion: repl,
      reason: reason,
    };
    findings.push(finding);
    asciiSeen.set(w, finding);
  }

  // 3. 相邻重复虚词
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

  // 5. == 高亮（代码围栏与行内代码里的 == 不算，「if a == b」不是高亮）
  let hl = 0;
  const eqRe = /==/g;
  let em;
  while ((em = eqRe.exec(content))) {
    if (inRanges(ranges, em.index)) continue;
    hl += 1;
  }
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

  // 8. 过滤 + 编号 + 严重度排序（两条通道共用，口径只有一处）
  return tallyFindings(content, findings, skipKinds);
}

function tallyFindings(content, findings, skipKinds) {
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
const SAFE_KINDS = new Set(["trailing-space", "repeat-char", "ascii-case", "task-date-format"]);

function safeIds(findings) {
  return findings.filter((f) => f.autoFix && SAFE_KINDS.has(f.kind)).map((f) => f.id);
}

function applyFixes(content, findings, ids) {
  const chosen = findings.filter((f) => f.autoFix && f.start !== undefined && f.end !== undefined && (ids === "all" || (Array.isArray(ids) && ids.includes(f.id))));
  // 一条 finding 可能对应多处出现（R4：同一个词全改），先展平成 span 再统一按位置**倒序**替换 ——
  // 倒序保证前面的偏移不会被后面改动推移。
  const spans = [];
  for (const f of chosen) {
    const list = Array.isArray(f.spans) && f.spans.length > 0 ? f.spans : [{ start: f.start, end: f.end }];
    for (const s of list) spans.push({ start: s.start, end: s.end, replace: f.replace || "", id: f.id });
  }
  spans.sort((a, b) => b.start - a.start);
  let out = content;
  const applied = [];
  for (const s of spans) {
    out = out.slice(0, s.start) + s.replace + out.slice(s.end);
    if (!applied.includes(s.id)) applied.push(s.id);
  }
  return { text: out, applied: applied.reverse(), replacements: spans.length };
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
  // 少了任何一类都会把合法链接判成坏链接（实测路径式链接占误报的绝大多数）。
  //
  // **frontmatter aliases 不算可解析目标**（2026-09-21 实测，见 D34）：曾把 aliases 也加进
  // targets，于是 [[04-决策记录]] 这种「别名链接」能通过闸门、写进关联列后在库里是**死链**。
  // 实测口径：候选 51 个别名，getFirstLinkpathDest() 只解析出 6 个，且这 6 个都是别名
  // 恰好等于某个真文件名（Transformer / python→Python.md …），没有一个靠别名本身解析成功。
  const targets = new Set();
  const names = new Map();
  for (const b of listed.all) {
    if (!b) continue;
    const k = b.toLowerCase();
    targets.add(k);
    if (!names.has(k)) names.set(k, b);
  }
  for (const p of listed.paths) if (p) targets.add(p.toLowerCase());
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
  const res = { targets: [], unescapedPipe: [] };
  if (typeof s !== "string") return res;
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const inner = m[1];
    // 表格单元格里的 | 必须先转义成 \|，否则 markdown 把它当列分隔符，索引行从 4 列撑成 5 列。
    // 两个方向都要管：不拦 → 表格坏掉；不剥转义 → [[🎁\|礼物]] 会被认成不存在的文件名。
    // 先判未转义，再剥转义 —— 顺序反过来就分不清「转义过的」和「本来就有两个」。
    let bare = false;
    for (let k = 0; k < inner.length; k++) {
      if (inner[k] === "|" && (k === 0 || inner[k - 1] !== "\\")) { bare = true; break; }
    }
    if (bare) {
      res.unescapedPipe.push(inner);
      continue;
    }
    // 剥掉转义反斜杠（\| -> |），再切别名（|）与标题/块锚点（#）
    const t = inner.split("\\|").join("|").split("|")[0].split("#")[0].trim();
    if (t) res.targets.push(t);
  }
  return res;
}

// returns { checked, missing[], malformed, reason?, detail? }
function checkLinks(vault, links) {
  if (typeof links !== "string") return { checked: 0, missing: [], malformed: false };
  const stripped = links.replace(/[\s\u3001,\uFF0C]+/g, "");
  if (!stripped || stripped === "\u2014" || stripped === "-") {
    return { checked: 0, missing: [], malformed: false };
  }
  // 单元格里出现换行会把索引行折成两行 —— 直接判 malformed。
  if (/[\r\n]/.test(links)) {
    return { checked: 0, missing: [], malformed: true, reason: "含换行", detail: "关联列是单个表格单元格，不能换行。" };
  }
  const parsed = parseWikilinkTargets(links);
  if (parsed.unescapedPipe.length > 0) {
    return {
      checked: 0, missing: [], malformed: true, reason: "| 没有转义",
      detail: "表格单元格里的 | 要写成 \\|，否则索引行会多出一列。例：--links='[[🎁\\|礼物]]'",
    };
  }
  if (parsed.targets.length === 0) {
    return { checked: 0, missing: [], malformed: true, reason: "一个 wikilink 都没有" };
  }
  // 去掉 wikilink 和分隔符后还有残留 = 裸文字（它变成不了关联，只会写进表格）
  const residue = links.replace(/\[\[[^\]]+\]\]/g, "").replace(/[\s\u3001,\uFF0C]+/g, "");
  if (residue) {
    return {
      checked: 0, missing: [], malformed: true, reason: "有裸文字",
      detail: "「" + residue + "」不是 wikilink。关联列只放链接，说明文字请写在正文里。",
    };
  }
  const idx = buildLinkIndex(listFiles(vault));
  const missing = parsed.targets.filter((t) => !idx.targets.has(t.toLowerCase()));
  return { checked: parsed.targets.length, missing: missing, malformed: false };
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
const TODO_TAG_RE = /(^|\s)#([^\s#,.;:!?()[\]{}|"'`，。、；：！？（）【】「」“”‘’]+)/g;
// 待办行里的内联**主题**标签。Obsidian 的规则：`#` 前面必须是行首或空白（`a#b` 不是标签）。
// `#gtd/*` 是任务状态，另有一套口径（由 `task-tag-unknown` 校对），**不**喂给 validateTags ——
// D21/B4 要求两个口径分开；把待办行整行塞给 validateTags 会把 `#gtd/next-action` 判成非法新标签。
// 另外两类在库里也不算主题标签，跳过而不是报错：纯数字（Obsidian 自己就不认 `#123`）与单字符噪声。
function todoTopicTags(text) {
  const seen = [];
  for (const rawLine of String(text).split("\n")) {
    const line = rawLine.replace(/`[^`]*`/g, ""); // 行内 code 里的 `#x` 不是标签
    TODO_TAG_RE.lastIndex = 0;
    let m;
    while ((m = TODO_TAG_RE.exec(line)) !== null) {
      const tag = "#" + m[2];
      if (tagDropped(tag) !== null) continue; // gtd / numeric / short
      if (seen.indexOf(tag) < 0) seen.push(tag);
    }
  }
  return seen;
}

function knownTagSets(vocab) {
  return {
    skeleton: new Set(vocab.tags.filter((t) => t.source === "skeleton").map((t) => t.tag)),
    live: new Set(vocab.tags.filter((t) => t.source === "vault").map((t) => t.tag)),
  };
}

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

function noteDateFromName(p) {
  if (!p) return null;
  const base = path.basename(String(p)).replace(/\.md$/, "");
  const m = base.match(DAILY_BASENAME_RE);
  return m ? m[1] + "-" + m[2] + "-" + m[3] : null;
}

function noteDateFromArgs(args) {
  const fromPath = noteDateFromName(args && args.path);
  if (fromPath) return fromPath;
  if (typeof (args || {}).date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) return args.date;
  return null;
}

// 库内实时存在的 #gtd/* 状态集。**不**从 registry 推：registry 里只有主题标签骨架，
// 而 #gtd/* 是任务状态，两个口径分开（D21）。
function loadGtdStatuses(vault, args) {
  const code = "globalThis.__DJ_P = " + JSON.stringify({ roots: tagRoots(args) }) + ";\n" + TAGS_PAYLOAD;
  const res = evalInObsidian(vault, code);
  const out = [];
  for (const t in res.tags) if (t.indexOf("#gtd/") === 0) out.push(t);
  out.sort();
  return out;
}

// ---------------------------------------------------------------------------
// 待办行校对（--kind=todo）
//
// 语法对齐库内的 obsidian-tasks-plugin（taskFormat = tasksPluginEmoji）。
// 这一层只**报告**：除了 ➕（D22），一切修正都要用户点头。
// ---------------------------------------------------------------------------

const TASK_LINE_RE = /^([ \t]*)([-*+])[ \t]+\[(.)\]/;
const TASK_STATUSES = [" ", "x", "/", "-"];
const TASK_PRIORITY_ORDER = ["🔺", "⏫", "🔼", "🔽"];
const TASK_FIELD_ORDER = ["➕", "🛫", "⏳", "📅", "🔁", "✅", "❌"];
const TASK_DATE_FIELDS = ["➕", "🛫", "⏳", "📅", "✅", "❌"];
const TASK_FIELD_RE = /(➕|🛫|⏳|📅|🔁|✅|❌)[ \t]*([^ \t]*)/g;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RELATIVE_DAY_RE = /(今天|明天|后天|大后天|昨天|前天|今晚|明晚|今早|明早|这周|本周|下周|上周|周末|这月|本月|下月|上个月|月底|月初|年底)/;
const RELATIVE_OFFSET_RE = /([0-9]+|[一二三四五六七八九十两]+)[ \t]*(天|周|个?月|年)(前|后|内|以内|以后|之后)/;
const RELATIVE_WEEKDAY_RE = /(下周|本周|这周|上周|周|星期|礼拜)[一二三四五六日天]/;
const WEEKDAY_NUM = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 0, "天": 0 };
const DAY_OFFSET = { "今天": 0, "今早": 0, "今晚": 0, "明天": 1, "明早": 1, "明晚": 1, "后天": 2, "大后天": 3, "昨天": -1, "前天": -2 };
const CN_NUM = { "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };

function ymdOf(d) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

// 相对时间只**建议**，绝不自动落盘（D24）。给出的值要用户点头后用 --fix-pair 应用，
// 所以这里只是一个提示字符串，不存在“静默替你决定”的路径。
function suggestAbsoluteDate(token, noteDate) {
  if (!noteDate) return null;
  const base = new Date(noteDate + "T00:00:00");
  if (isNaN(base.getTime())) return null;
  const shift = (n) => { const d = new Date(base.getTime()); d.setDate(d.getDate() + n); return ymdOf(d); };

  if (Object.prototype.hasOwnProperty.call(DAY_OFFSET, token)) return shift(DAY_OFFSET[token]);

  const wd = token.match(/(下周|本周|这周|上周)?(?:周|星期|礼拜)([一二三四五六日天])$/);
  if (wd) {
    const raw = WEEKDAY_NUM[wd[2]] - base.getDay();
    if (wd[1] === "下周") return shift(raw + 7);
    if (wd[1] === "上周") return shift(raw - 7);
    return shift(raw);
  }

  const off = token.match(/^([0-9]+|[一二三四五六七八九十两]+)[ \t]*(天|周|个?月|年)(前|后|内|以内|以后|之后)$/);
  if (!off) return null;
  const n = /^[0-9]+$/.test(off[1]) ? Number(off[1]) : (Object.prototype.hasOwnProperty.call(CN_NUM, off[1]) ? CN_NUM[off[1]] : null);
  if (n === null) return null;
  const sign = off[3] === "前" ? -1 : 1;
  if (off[2] === "天") return shift(sign * n);
  if (off[2] === "周") return shift(sign * n * 7);
  const d = new Date(base.getTime());
  if (off[2] === "年") d.setFullYear(d.getFullYear() + sign * n);
  else d.setMonth(d.getMonth() + sign * n);
  return ymdOf(d);
}

function taskFindings(content, ctx) {
  const out = [];
  const lines = content.split("\n");
  const starts = [];
  let acc = 0;
  for (let i = 0; i < lines.length; i++) { starts.push(acc); acc += lines[i].length + 1; }
  const gtd = (ctx && ctx.gtd) || null;
  const noteDate = (ctx && ctx.noteDate) || null;
  const indentChars = new Set();

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    const lead = l.match(/^[ \t]*/)[0];
    const at = starts[i];
    const m = l.match(TASK_LINE_RE);

    if (lead.length > 0) indentChars.add(lead.charAt(0));

    if (!m) {
      // 缩进行当子项/续行，允许；顶格的必须是一行 checkbox。
      if (lead.length === 0) {
        out.push({
          kind: "task-no-checkbox", severity: "high", autoFix: false, blocking: true,
          line: i + 1, start: at, end: at + l.length, found: l,
          suggestion: "- [ ] " + l,
          reason: "待办捕获里顶格的行必须是一行 checkbox（- [ ]），这一行不是。",
        });
      }
      continue;
    }

    const status = m[3];
    if (TASK_STATUSES.indexOf(status) < 0) {
      out.push({
        kind: "task-status-unknown", severity: "high", autoFix: false, blocking: true,
        line: i + 1, start: at + m[0].length - 2, end: at + m[0].length - 1,
        found: "[" + status + "]",
        suggestion: "[ ]（待办）或 [x]（完成）",
        reason: "状态符 " + JSON.stringify(status) + " 不在库内 tasks 插件认的四种（空格 / x / / / -）里。",
      });
    }

    const rest = l.slice(m[0].length);
    const restAt = at + m[0].length;

    // 字段顺序：乱序会让顶上按 #gtd/wait-for 分组、按 ⏳/📅 取日期的查询漏掉这一行。
    const seq = [];
    const fields = [];
    for (const p of TASK_PRIORITY_ORDER) {
      const idx = rest.indexOf(p);
      if (idx >= 0) seq.push({ pos: idx, token: p, rank: 0 });
    }
    TASK_FIELD_RE.lastIndex = 0;
    let fm;
    while ((fm = TASK_FIELD_RE.exec(rest))) {
      fields.push({ token: fm[1], value: fm[2], pos: fm.index, len: fm[0].length });
      seq.push({ pos: fm.index, token: fm[1], rank: TASK_FIELD_ORDER.indexOf(fm[1]) + 1 });
    }
    seq.sort((a, b) => a.pos - b.pos);
    for (let k = 1; k < seq.length; k++) {
      if (seq[k].rank < seq[k - 1].rank) {
        out.push({
          kind: "task-field-order", severity: "medium", autoFix: false, blocking: false,
          line: i + 1, start: restAt + seq[k - 1].pos, end: restAt + seq[k].pos + 1,
          found: seq[k - 1].token + " 在 " + seq[k].token + " 之前",
          suggestion: "字段顺序：描述 → 标签 → 优先级 → ➕ → 🛫 → ⏳ → 📅 → 🔁 → ✅/❌",
          reason: "emoji 字段顺序乱了，顶上按 #gtd/wait-for 分组与众日期查询会漏掉这一行。",
        });
        break;
      }
    }

    // 日期字段的格式：一律 YYYY-MM-DD
    for (const f of fields) {
      if (TASK_DATE_FIELDS.indexOf(f.token) < 0) continue;
      if (f.value === "" || ISO_DATE_RE.test(f.value)) continue;
      const span = { start: restAt + f.pos, end: restAt + f.pos + f.len };
      const g = f.value.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
      if (g) {
        const iso = g[1] + "-" + pad2(g[2]) + "-" + pad2(g[3]);
        out.push(Object.assign({
          kind: "task-date-format", severity: "medium", autoFix: true, blocking: false,
          line: i + 1, replace: f.token + " " + iso,
          found: f.token + " " + f.value, suggestion: f.token + " " + iso,
          reason: "日期一律写 YYYY-MM-DD：库内所有 tasks 查询都按这个格式比。",
        }, span));
      } else {
        out.push(Object.assign({
          kind: "task-date-format", severity: "medium", autoFix: false, blocking: false,
          line: i + 1, found: f.token + " " + f.value,
          suggestion: f.token + " YYYY-MM-DD",
          reason: "日期一律写 YYYY-MM-DD；" + JSON.stringify(f.value) + " 缺年份，脚本不替你猜。",
        }, span));
      }
    }

    // 相对时间（D24）
    let rel = null;
    const d1 = rest.match(RELATIVE_DAY_RE);
    if (d1) rel = d1[0];
    if (!rel) { const d2 = rest.match(RELATIVE_WEEKDAY_RE); if (d2) rel = d2[0]; }
    if (!rel) { const d3 = rest.match(RELATIVE_OFFSET_RE); if (d3) rel = d3[0]; }
    if (rel) {
      const guess = suggestAbsoluteDate(rel, noteDate);
      out.push({
        kind: "task-date-relative", severity: "medium", autoFix: false, blocking: true,
        line: i + 1, start: restAt, end: restAt + rest.length, found: rel,
        suggestion: guess
          ? "改为 " + guess + "；用 --fix-pair 落地，右值要带够上下文（如 '明天去取车→2026-09-21 去取车'），" +
            "别只替「" + rel + "」一个词（会变成 '2026-09-21去取车'）"
          : "改成 YYYY-MM-DD（要用户点头）",
        reason: "相对时间不落盘：跨周 / 跨月 / 跨年时有真歧义，错一天任务就在错的日子冒出来（D24）。",
      });
    }

    // #gtd/* 状态：库内没有的就是新状态，得先问用户（与主题标签同一个纪律，但两套词表）
    if (gtd) {
      const found = rest.match(/#gtd(?:\/[^\s#]+)?/g) || [];
      for (const t of found) {
        if (gtd.indexOf(t) >= 0) continue;
        out.push({
          kind: "task-tag-unknown", severity: "medium", autoFix: false, blocking: false,
          line: i + 1, start: restAt, end: restAt + rest.length, found: t,
          suggestion: gtd.length > 0 ? gtd.join(" / ") : "先确认库里要用哪个状态",
          reason: "库内没有 " + t + " 这个 gtd 状态（它是任务状态，不是主题标签）。",
        });
      }
    }
  }

  if (indentChars.has("\t") && indentChars.has(" ")) {
    out.push({
      kind: "task-indent-mixed", severity: "low", autoFix: false, blocking: false,
      found: "Tab 与空格混用",
      suggestion: "统一成 Tab（库内已有的任务子项用的是 Tab）",
      reason: "同一个块内缩进不能混用 Tab 和空格，Obsidian 会把它们算成不同层级。",
    });
  }

  return out;
}

function runProofread(vault, content, skipKinds) {
  const registry = loadRegistry(vault);
  const listed = listFiles(vault);
  const vocab = buildVocabulary(registry);
  const linkIndex = buildLinkIndex(listed);
  const ctx = { gtd: null, noteDate: noteDateFromArgs(CLI_ARGS) };
  if (CLI_ARGS.kind === "todo") ctx.gtd = loadGtdStatuses(vault, CLI_ARGS);
  return proofread(content, vocab, linkIndex, skipKinds, ctx);
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
// 改写**已写入**的原文（R3 的显式例外：用户起意）
//
// R3「原文不得擅自改写」禁止的是 agent 擅自改写用户的话。事后改错字不是放宽
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
  const sumOf = function (s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  };
  // 落盘前先拿 Node 算的 len/sum 自查：载荷在传输路上被改写就一个字都不写。
  // 光比对字符串不够——两边一起被改坏时字符串照样相等（见 escapeNonAsciiForCli 注释）。
  if (P.after.length !== P.afterLen || sumOf(P.after) !== P.afterSum) {
    return JSON.stringify({
      ok: false,
      error: "transport-corrupt",
      path: P.path,
      gotLen: P.after.length,
      wantLen: P.afterLen
    });
  }
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
    readBackExact: after === P.after,
    readBackSumOk: after.length === P.afterLen && sumOf(after) === P.afterSum
  });
})()
`;

// 内容指纹：落盘前自查用（跟 Obsidian 侧同一套 31 进制滚动和）。
// 只防传输/落盘路上被改写，不当身份标识用。
function contentStamp(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return { len: s.length, sum: h };
}

// 捕获通道的指纹域：字段顺序与 WRITE_PAYLOAD 里的 stampSrc 必须逐字对应。
// join 会把 undefined / null 归一成空串，所以两侧算法一致。
function captureStampSrc(p) {
  return [
    p.content,
    p.anchor,
    p.id,
    p.time,
    p.noteDate,
    p.createdDateSource,
    p.category,
    p.links,
    p.sections.thinking,
    p.sections.todo,
    p.sections.derived,
    p.sections.related,
  ].join("\u0000");
}

// 所有改写落盘都走这里：一次落盘前比对 + 一次回读校验，六个调用点不再各写一遍。
function writeNoteInObsidian(vault, p) {
  const st = contentStamp(p.after);
  const res = evalInObsidian(
    vault,
    "globalThis.__DJ_P = " +
      JSON.stringify({
        path: p.rel,
        expectBefore: p.expectBefore,
        after: p.after,
        afterLen: st.len,
        afterSum: st.sum
      }) +
      ";\n" +
      FIXWRITTEN_PAYLOAD
  );
  if (!res.ok && res.error === "transport-corrupt") {
    fail(
      "落盘前自查不过 " + p.rel + "：待写内容在传进 Obsidian 的路上被改过（长度 " +
        res.gotLen + "，应为 " + res.wantLen + "），已中止、一个字未写。\n" +
        "  这是 obsidian CLI 的 code= 入参的已知失真；本脚本已把非 ASCII 转义送出，\n" +
        "  仍出现请升级 CLI，并把这条记入 decision-log。"
    );
  }
  if (!res.ok) fail("落盘失败 " + p.rel + "：" + res.error);
  if (!res.beforeMatched) {
    fail("落盘前比对失败 " + p.rel + "：文件在读取后被改过，未写入（concurrent-edit）");
  }
  if (!res.readBackExact || !res.readBackSumOk) {
    fail("回读不一致 " + p.rel + "：写入未按预期生效。备份在 " + (p.backup || ""));
  }
  return res;
}

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
    if (from === to) throw new Error(flag + " 两侧相同：" + JSON.stringify(s));
    out.push({ from: from, to: to });
  }
  if (out.length === 0) throw new Error(flag + " 为空");
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

      // 反向回代必须逐字节回到原文 —— 这是「除了这些对，什么都没动」的硬证据。
      // **倒序**撤销：a→b,b→c 这种链式对，正序撤只会得到中间态。
      let back = newBody;
      for (let i = hits.length - 1; i >= 0; i--) {
        back = replaceAllText(back, hits[i].to, hits[i].from);
      }
      if (back !== oldBody) {
        fail(
          "回代校验失败：" + id + "\n  替换不是干净的字面替换（右值在原文中也出现过，会互相干扰）。" +
            "\n  请换更长的上下文再试，不要用会撞车的对。",
        );
      }

      const oldId = id;
      // 锚点不算正文：算 hash 前先剥掉，否则锚点里的旧 id 会自指进新 hash。
      const canonNew = stripTailAnchor(newBody);
      const newHash = crypto.createHash("sha1").update(canonNew, "utf8").digest("hex").slice(0, 4);
      const newId = id.slice(0, id.length - 5) + "-" + newHash;
      // 锚点是 id 的副本，id 换了它就得跟着换。本来没有锚点的旧块不补 ——
      // 借「改错字」顺手给别人的笔记换形状是另一件事，要另开通道。
      const anchoredNew = canonNew === newBody ? canonNew : canonNew + " ^" + newId;

      after =
        after.slice(0, sp.bStart) +
        "<!-- jc:begin id=" + newId + " -->\n\n" +
        anchoredNew +
        "\n\n<!-- jc:end id=" + newId + " -->" +
        after.slice(sp.eEnd);

      changed.push({ id: oldId, newId: newId, hits: hits, before: oldBody, after: anchoredNew });
      reports.push({ id: oldId, newId: newId, path: rel, hits: hits, before: oldBody, after: anchoredNew });
    }

    if (changed.length === 0) continue;

    // 索引行里的 id 一起换（形态无关，旧的反引号与新的块链接都认）。
    // 只碰索引行那一格：jt 区里用户手写的来源链接不动（那是另一层、另一件事）。
    after = remapIndexRowIds(after, changed.map((c) => ({ from: c.id, to: c.newId })));

    // 块外必须逐字节不变：把块内替换全部还原后，应正好等于原文
    let restored = after;
    for (const c of changed) {
      restored = replaceAllText(restored, c.after, c.before);
      restored = replaceAllText(restored, "<!-- jc:begin id=" + c.newId + " -->", "<!-- jc:begin id=" + c.id + " -->");
      restored = replaceAllText(restored, "<!-- jc:end id=" + c.newId + " -->", "<!-- jc:end id=" + c.id + " -->");
    }
    restored = remapIndexRowIds(restored, changed.map((c) => ({ from: c.newId, to: c.id })));
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
    writeNoteInObsidian(vault, p);
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
// --repair-text：修 jc 块**之外**已写下的机械错误（错字、模板片段被改坏）。
//
// 块内正文不走这里：那边的块 id 是正文 sha1 的派生物，改字必须连带换 id，
// 属于 --fix-written 的地盘。这里只做「块外一处字面替换」，三条规定：
//   1. 每对必须且只能命中一次（宁少勿多，命中 0 或 >1 都拒绝）；
//   2. 命中处不许落在任何 jc 块体内（否则请改用 --fix-written）；
//   3. 反向回代必须逐字节回到原文 —— 「除了这一处，什么都没动」的硬证据。
// ---------------------------------------------------------------------------

const REPAIR_READ_PAYLOAD = String.raw`
(async () => {
  const P = globalThis.__DJ_P;
  let f = app.vault.getAbstractFileByPath(P.path);
  let resolved = P.path;
  if (!f) {
    const hits = app.vault.getMarkdownFiles().filter(function (x) { return x.name === P.path || x.basename === P.path; });
    if (hits.length === 1) { f = hits[0]; resolved = f.path; }
    else if (hits.length > 1) return JSON.stringify({ ok: false, error: "path-ambiguous", matches: hits.map(function (x) { return x.path; }) });
  }
  if (!f) return JSON.stringify({ ok: false, error: "file-missing", path: P.path });
  return JSON.stringify({ ok: true, path: f.path, content: await app.vault.read(f), root: app.vault.adapter.basePath });
})()
`;

// 命中位置是否落在某个 jc 块体内（块体 = begin 标记结束 到 end 标记开始之间）
function jcBodySpans(content) {
  const begins = [];
  const ends = [];
  const re = /<!-- jc:(begin|end)(?: id=[^ ]*)? -->/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    (m[1] === "begin" ? begins : ends).push({ start: m.index, end: m.index + m[0].length });
  }
  if (begins.length !== ends.length) return null; // 标记不成对
  const spans = [];
  for (let i = 0; i < begins.length; i++) spans.push([begins[i].end, ends[i].start]);
  return spans;
}

function cmdRepairText(vault, args) {
  if (typeof args.path !== "string" || args.path === "") {
    fail("--repair-text 需要 --path=<路径|文件名>（只修这一个文件）");
  }
  let pairs;
  try {
    pairs = parseReplaceList(args.replace, "--replace");
  } catch (e) {
    fail(String((e && e.message) || e));
  }
  if (pairs.length === 0) fail("--repair-text 需要 --replace='错→对'");
  for (const p of pairs) {
    if (p.from.indexOf("\n") >= 0 || p.to.indexOf("\n") >= 0) {
      fail("这个通道只修一行之内的字面错字：--replace 的左边和右边都不能含换行");
    }
  }

  const rr = evalInObsidian(
    vault,
    "globalThis.__DJ_P = " + JSON.stringify({ path: args.path }) + ";\n" + REPAIR_READ_PAYLOAD,
  );
  if (!rr.ok && rr.error === "path-ambiguous") {
    fail("这个文件名在库里有多个，请给全路径：\n  " + rr.matches.join("\n  "));
  }
  if (!rr.ok) fail("读不到 " + args.path + "：" + rr.error);
  const before = rr.content;
  const spans = jcBodySpans(before);
  if (!spans) fail("jc 标记不成对：" + rr.path + "（orphan-index-markers），先修标记再改字");

  let after = before;
  const hits = [];
  for (const p of pairs) {
    const n = countOf(after, p.from);
    if (n === 0) fail("没命中：「" + p.from + "」在 " + rr.path + " 里找不到（一个字也未改）");
    if (n > 1) {
      fail(
        "命中 " + n + " 次，不止一处：「" + p.from + "」\n" +
          "  这个通道只修一处，请把 --replace 的左边加长到全文件唯一（一个字也未改）",
      );
    }
    const at = after.indexOf(p.from);
    for (const [s, e] of spans) {
      if (at >= s && at < e) {
        fail(
          "命中落在 jc 块体内（偏移 " + at + "）：" + rr.path + "\n" +
            "  块内正文有 id 一致性约束，请改用 --fix-written --id=<块 id> --replace='错→对'",
        );
      }
    }
    hits.push({ from: p.from, to: p.to, at: at, line: before.slice(0, at).split("\n").length });
    after = replaceAllText(after, p.from, p.to);
  }

  // 反向回代：倒序撤销，逐字节回到原文
  let back = after;
  for (let i = hits.length - 1; i >= 0; i--) back = replaceAllText(back, hits[i].to, hits[i].from);
  if (back !== before) {
    fail(
      "回代校验失败：" + rr.path + "\n" +
        "  替换不是干净的字面替换（右值在原文中也出现过，会互相干扰）。请换更长的上下文再试。",
    );
  }

  // 只允许命中处的字节不同：把命中处（左值版/右值版）都挖成同一个哨兵后，两边必须完全相等
  const SENT = "\u0000";
  if (before.indexOf(SENT) >= 0) fail("原文里有 NUL 字符，本通道不能用，已中止未落盘");
  let a2 = before;
  let a3 = after;
  for (const h of hits) {
    a2 = replaceAllText(a2, h.from, SENT);
    a3 = replaceAllText(a3, h.to, SENT);
  }
  if (a2 !== a3) fail("命中处之外还有别的字节不同（脚本 bug），已中止未落盘");

  const lineOf = (i) => before.slice(0, i).split("\n").length;
  const lineText = (s, i) => (s.split("\n")[lineOf(i) - 1] || "").trim();
  const rows = hits.map((h) => ({
    line: h.line,
    from: h.from,
    to: h.to,
    before: lineText(before, h.at),
    after: lineText(after, h.at),
  }));

  if (!args.write) {
    if (args.json) {
      process.stdout.write(JSON.stringify({ ok: true, status: "dry-run", path: rr.path, rows: rows }, null, 2) + "\n");
      return;
    }
    process.stdout.write("修复 " + rr.path + "\n");
    for (const r of rows) {
      process.stdout.write("  行 " + r.line + "\n      「" + r.before + "」\n      → 「" + r.after + "」\n");
    }
    process.stdout.write("\n只改这一处，其余字节不动；jc 块体内的正文一个字节不动。确认后加 --write 重跑。\n");
    return;
  }

  const bdir = path.join(rr.root, ".daily-journal", "backup");
  fs.mkdirSync(bdir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(bdir, path.basename(rr.path) + "." + stamp + ".bak");
  fs.writeFileSync(backup, before);
  writeNoteInObsidian(vault, { rel: rr.path, expectBefore: before, after: after, backup: backup });

  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: true, status: "written", path: rr.path, backup: backup, rows: rows }, null, 2) + "\n");
    return;
  }
  process.stdout.write("修复完成\n");
  for (const r of rows) process.stdout.write("  " + rr.path + "  行 " + r.line + "  「" + r.from + "」→「" + r.to + "」\n");
  process.stdout.write("  备份: " + backup + "\n");
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

// 按**未转义**的 | 拆单元格。关联列与块 id 列里的 \| 是格内字面管道（markdown 表格要求），
// 不是列分隔符 —— 拿 split("|") 硬拆会把列序号整体后移。
function splitUnescapedPipes(s) {
  const out = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "\\" && s.charAt(i + 1) === "|") { cur += "\\|"; i++; continue; }
    if (c === "|") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// 「块 id」单元格有两种形态：
//   旧：`20260916-1547-8c95`                裹反引号（历史笔记里还留着）
//   新：[[2026-09-38w-20#^2026…-8c95\|…]]   块链接，点一下跳回那段思考
// 读的时候两种都认，写的时候只写新形态。
const INDEX_ID_LEGACY_RE = /^\d{8}-\d{4}-[0-9a-f]{4}$/;
const INDEX_ID_LINK_RE = /^\[\[[^\[\]|#]+#\^(\d{8}-\d{4}-[0-9a-f]{4})(?:\\\|[^\]]*)?\]\]$/;

function indexCellId(cell) {
  const s = String(cell);
  const m = s.match(INDEX_ID_LINK_RE);
  if (m) return m[1];
  if (s.length >= 3 && s.charAt(0) === BT_CHAR && s.charAt(s.length - 1) === BT_CHAR) {
    const inner = s.slice(1, -1);
    if (INDEX_ID_LEGACY_RE.test(inner)) return inner;
  }
  return null;
}

// 索引行 = "| 时间 | 块 id | 分类 | 关联 |"
function splitIndexRow(line) {
  if (line.charAt(0) !== "|" || line.charAt(line.length - 1) !== "|") return null;
  const parts = splitUnescapedPipes(line.slice(1, -1)).map((s) => s.trim());
  if (parts.length !== 4) return null;
  if (!/^\d{2}:\d{2}$/.test(parts[0])) return null;
  if (indexCellId(parts[1]) === null) return null;
  return parts;
}

// 换 id 时**只动「块 id」那一格**：形态无关（反引号与块链接都认），格内那串 id 出现两次
// （锚点与别名），一次换掉；同一行其余字节一个不动（不重排版，回代证明才守得住）。
// 只认索引行 —— jt 区里用户手写的 [[…#^id|↩]] 是另一层，不在这里改。
function remapIndexRowIds(text, pairs) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const parts = splitIndexRow(lines[i]);
    if (!parts) continue;
    const cur = indexCellId(parts[1]);
    for (const p of pairs) {
      if (p.from === cur) { lines[i] = replaceAllText(lines[i], p.from, p.to); break; }
    }
  }
  return lines.join("\n");
}

// 只认「每一段都裹了反引号」的旧格式；混写（已经是裸标签）直接返回 null，不动它
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
      if (check.novel && check.novel.length > 0 && !args["allow-new-tag"]) {
        fail(
          "迁移后出现词表外的新标签（D5：必须先问用户）：" + check.novel.join("、") + "\n" + "  在 " + f.path + " 第 " + (i + 1) + " 行。若已确认，用 --map='旧→新' 指定，或加 --allow-new-tag。",
        );
      }

      lines[i] = "| " + parts[0] + " | " + parts[1] + " | " + tags.join(" ") + " | " + parts[3] + " |";
      touched = true;
      rows.push({ path: f.path, line: i + 1, id: indexCellId(parts[1]) || parts[1], from: parts[2], to: tags.join(" ") });
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
    writeNoteInObsidian(vault, p);
  }

  if (args.json) process.stdout.write(JSON.stringify({ ok: true, status: "written", rows: rows }, null, 2) + "\n");
  else {
    process.stdout.write("迁移完成：" + rows.length + " 行\n\n");
    for (const r of rows) process.stdout.write("  " + r.path + ":" + r.line + "  " + r.from + "  →  " + r.to + "\n");
    for (const p of plans) process.stdout.write("  备份: " + p.backup + "\n");
  }
}

// ---------------------------------------------------------------------------
// --link-block-ids：把派生层里裹反引号的「块 id」格改写成块链接
//
//     | 10:25 | [[2026-09-38w-20#^20260920-1025-e95b\|20260920-1025-e95b]] | #family | — |
//
// 为什么要有这条通道：捕获通道从此直接写链接，但**历史笔记里还是反引号形态**。
// 形态迁移不回去改，那些行的 id 就永远点不动。
// 三条约束：
//   1. 只动派生层索引行的 id 那**一个格**（换回去必须逐字节等于原行）；
//   2. 块必须真的在本文件里（找不到就报 block-missing，不写）；
//   3. 块必须已经有尾部锚点 —— 没锚点链接就跳不过去。这里**不代劳补锚点**，
//      只报 anchor-missing 让你先跑 --add-anchors（两件事分开，各自可核）。
// ---------------------------------------------------------------------------

function cmdLinkBlockIds(vault, args) {
  const dp = dailyPath(vault);
  const slash = dp.lastIndexOf("/");
  const folder = slash > 0 ? dp.slice(0, slash) : "";
  if (folder === "") fail("定位不到日记目录（daily:path = " + dp + "）");
  const listed = evalInObsidian(
    vault,
    "globalThis.__DJ_P = " + JSON.stringify({ folder: folder }) + ";\n" + MIGRATE_LIST_PAYLOAD,
  );

  const rows = [];
  const skipped = [];
  const plans = [];
  for (const f of listed.files) {
    const noteName = path.basename(f.path).replace(/\.md$/, "");
    const lines = f.content.split("\n");
    const touched = [];
    for (let i = 0; i < lines.length; i++) {
      const parts = splitIndexRow(lines[i]);
      if (!parts) continue;
      const id = indexCellId(parts[1]);
      if (id === null) continue;
      if (parts[1].charAt(0) === "[") continue; // 已经是链接形态

      const cell = BT_CHAR + id + BT_CHAR;
      if (lines[i].indexOf(cell) < 0) {
        skipped.push({ path: f.path, line: i + 1, id: id, reason: "id 格不是纯反引号形态" });
        continue;
      }

      const beginLine = "<!-- jc:begin id=" + id + " -->";
      const endLine = "<!-- jc:end id=" + id + " -->";
      const b = lines.indexOf(beginLine);
      if (b < 0) {
        skipped.push({ path: f.path, line: i + 1, id: id, reason: "block-missing（本文件里没有这个块）" });
        continue;
      }
      let e = -1;
      for (let k = b + 1; k < lines.length; k++) {
        if (lines[k] === endLine) { e = k; break; }
      }
      if (e < 0) {
        skipped.push({ path: f.path, line: i + 1, id: id, reason: "end 标记缺失（先跑 --verify-ids）" });
        continue;
      }
      let anchored = false;
      for (let k = b + 1; k < e; k++) {
        if ((lines[k].match(/ \^([A-Za-z0-9._-]+)$/) || [])[1] === id) { anchored = true; break; }
      }
      if (!anchored) {
        skipped.push({ path: f.path, line: i + 1, id: id, reason: "anchor-missing（先跑 --add-anchors）" });
        continue;
      }

      const link = "[[" + noteName + "#^" + id + "\\|" + id + "]]";
      const newLine = replaceAllText(lines[i], cell, link);
      // 只动这一格：把链接换回去必须逐字节等于原行
      if (replaceAllText(newLine, link, cell) !== lines[i]) {
        fail("回代校验失败：" + f.path + ":" + (i + 1) + "（一个字未写）");
      }
      lines[i] = newLine;
      touched.push({ path: f.path, line: i + 1, id: id, from: cell, to: link });
    }

    if (touched.length === 0) continue;
    const after = lines.join("\n");
    // 全文件回代：把每一处都换回去，应正好等于原文（「除了这些格，什么都没动」的硬证据）
    let restored = after;
    for (const t of touched) restored = replaceAllText(restored, t.to, t.from);
    if (restored !== f.content) {
      fail("块外内容被牵连：" + f.path + "\n  这是脚本的 bug，已中止未落盘。请把现场报给用户看。");
    }
    for (const t of touched) rows.push(t);
    plans.push({ rel: f.path, expectBefore: f.content, after: after });
  }

  if (rows.length === 0) {
    if (args.json) {
      process.stdout.write(JSON.stringify({ ok: true, status: "nothing-to-do", rows: [], skipped: skipped }, null, 2) + "\n");
      return;
    }
    process.stdout.write("块 id 没有需要改的：派生层里的 id 格已经是链接形态。\n");
    if (skipped.length > 0) {
      process.stdout.write("\n有 " + skipped.length + " 行没动：\n");
      for (const s of skipped) process.stdout.write("  " + s.path + ":" + s.line + "  " + s.id + "  " + s.reason + "\n");
    }
    return;
  }

  if (!args.write) {
    if (args.json) {
      process.stdout.write(JSON.stringify({ ok: true, dryRun: true, rows: rows, skipped: skipped }, null, 2) + "\n");
      return;
    }
    process.stdout.write("把派生层的块 id 改成链接（未落盘）\n\n");
    for (const r of rows) {
      process.stdout.write("  " + r.path + ":" + r.line + "\n    " + r.from + "\n    → " + r.to + "\n");
    }
    if (skipped.length > 0) {
      process.stdout.write("\n没动的 " + skipped.length + " 行（不写，先处理它们）：\n");
      for (const s of skipped) process.stdout.write("  " + s.path + ":" + s.line + "  " + s.id + "  " + s.reason + "\n");
    }
    process.stdout.write("\n只动派生层索引行的块 id 格，原文与其余列一个字节不动。确认后加 --write 重跑。\n");
    return;
  }

  const bdir = path.join(listed.root, ".daily-journal", "backup");
  fs.mkdirSync(bdir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const p of plans) {
    const b = path.join(bdir, path.basename(p.rel) + "." + stamp + ".bak");
    fs.writeFileSync(b, p.expectBefore);
    p.backup = b;
    writeNoteInObsidian(vault, p);
  }

  if (args.json) process.stdout.write(JSON.stringify({ ok: true, status: "written", rows: rows, skipped: skipped }, null, 2) + "\n");
  else {
    process.stdout.write("块 id 已改成链接：" + rows.length + " 行\n\n");
    for (const r of rows) process.stdout.write("  " + r.path + ":" + r.line + "  " + r.id + "\n");
    for (const p of plans) process.stdout.write("  备份: " + p.backup + "\n");
    if (skipped.length > 0) {
      process.stdout.write("\n没动的 " + skipped.length + " 行：\n");
      for (const s of skipped) process.stdout.write("  " + s.path + ":" + s.line + "  " + s.id + "  " + s.reason + "\n");
    }
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

// 正文末尾适不适合钉锚点。
//
// 锚点是 **` ^<块 id>` 贴在正文最后一行的末尾**，不是单起一行 —— 单起一行 Obsidian 也认（整行就是 `^id`），
// 但那样锚点就不在正文里了，`--fix-written` 换 id 时会留下一个指向不存在块的死锚点。
// 代价是「最后一行」必须真能接受尾巴，下面几类不能钉，宁可不钉也不弄坏原文：
//   末行是表格行 -> 多出一个单元格，表格直接坏掉
//   末行是代码围栏 / 正文末尾在未闭合的代码块里 -> 围栏作废，后面的原文全变代码
//   末尾有空行 -> 锚点落到新起的一行上，Obsidian 不认（`^id` 得在段落开头或整行）
function tailAnchorBlocker(body) {
  if (String(body).trim() === "") return "块内没有正文";
  if (/\n[ \t]*$/.test(body)) return "正文末尾有空行：锚点会落到新起的一行上，Obsidian 认不出来";
  const lines = String(body).split("\n");
  let fences = 0;
  for (const ln of lines) if (/^\s*(```|~~~)/.test(ln)) fences += 1;
  if (fences % 2 === 1) return "正文末尾在未闭合的代码块里";
  let last = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") {
      last = lines[i];
      break;
    }
  }
  if (/^\s*(```|~~~)/.test(last)) return "正文最后一行是代码块围栏";
  if (/^\s*\|/.test(last)) return "正文最后一行是表格行";
  if (/^#{1,6}\s/.test(last)) return "正文最后一行是标题";
  if (/^\s*<!--/.test(last)) return "正文最后一行是注释";
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(last)) return "正文最后一行是分隔线";
  return null;
}

// ---------------------------------------------------------------------------
// 迁移：给旧块补上尾部锚点
//
// 锚点（C10）让 `[[笔记#^id]]` 能跳回那段思考，但 2026-09-20 之前写入的块没有。
// 补锚点是**纯追加**：正文一个字节不动（锚点不算正文，sha1 定义未变），所以它不碰 R3。
// 仍然逐块开闸：正文 hash 与块 id 对不上的先不补（先跑 --verify-ids --write），
// 末尾不适合钉的也不补，把原因报出来。
// ---------------------------------------------------------------------------

function cmdAddAnchors(vault, args) {
  const dp = dailyPath(vault);
  const slash = dp.lastIndexOf("/");
  const folder = slash > 0 ? dp.slice(0, slash) : "";
  if (folder === "") fail("定位不到日记目录（daily:path = " + dp + "）");
  const listed = evalInObsidian(
    vault,
    "globalThis.__DJ_P = " + JSON.stringify({ folder: folder }) + ";\n" + MIGRATE_LIST_PAYLOAD,
  );

  const want = typeof args.path === "string" ? args.path : null;
  const files = want
    ? listed.files.filter((f) => f.path === want || f.path.endsWith("/" + want) || path.basename(f.path) === want)
    : listed.files;
  if (files.length === 0) fail("在日记目录里找不到 " + want + "（本模式只扫 " + folder + "）");

  const rows = [];
  const plans = [];
  for (const f of files) {
    const lines = f.content.split("\n");
    const adds = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(ID_BEGIN_RE);
      if (!m) continue;
      const id = m[1];
      const endLine = "<!-- jc:end id=" + id + " -->";
      let j = -1;
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k] === endLine) {
          j = k;
          break;
        }
      }
      const at = { path: f.path, line: i + 1, id: id };
      if (j < 0) {
        rows.push(Object.assign({}, at, { action: "skip", reason: "end 标记缺失" }));
        continue;
      }
      const body = lines.slice(i + 2, j - 1).join("\n");
      if (/ \^[A-Za-z0-9._-]+$/.test(body)) {
        // 已经有锚点的块一个字节不动；值对不对是 --verify-ids 的事。
        rows.push(Object.assign({}, at, { action: "keep", reason: "已有锚点" }));
        continue;
      }
      const got = crypto.createHash("sha1").update(stripTailAnchor(body), "utf8").digest("hex").slice(0, 4);
      if (got !== m[2]) {
        rows.push(
          Object.assign({}, at, {
            action: "skip",
            reason: "正文 hash 与块 id 不一致（先跑 --verify-ids --write）",
          }),
        );
        continue;
      }
      const why = tailAnchorBlocker(body);
      if (why) {
        rows.push(Object.assign({}, at, { action: "skip", reason: why }));
        continue;
      }
      // 锚点钉在**最后一行非空行**的末尾。上面已挡掉末尾有空行的情况，这一步只是防御。
      let k = j - 2;
      while (k > i + 1 && lines[k].trim() === "") k--;
      adds.push({ id: id, at: k, before: lines[k], after: lines[k] + " ^" + id });
    }
    if (adds.length === 0) continue;

    const afterLines = lines.slice();
    for (const a of adds) afterLines[a.at] = a.after;
    const after = afterLines.join("\n");
    // 除了这几个追加串，文件其他部分必须逐字节未动：全部推回去后应正好等于原文。
    let restored = after;
    for (const a of adds) restored = replaceAllText(restored, a.after, a.before);
    const untouched = restored === f.content;
    plans.push({ rel: f.path, expectBefore: f.content, after: after, adds: adds, untouched: untouched });
    for (const a of adds) {
      rows.push({ path: f.path, line: a.at + 1, id: a.id, action: "add", before: a.before, after: a.after });
    }
  }

  const added = rows.filter((r) => r.action === "add");
  const kept = rows.filter((r) => r.action === "keep");
  const skipped = rows.filter((r) => r.action === "skip");

  if (added.length === 0) {
    if (args.json) {
      process.stdout.write(JSON.stringify({ ok: true, status: "nothing-to-do", blocks: rows.length, added: 0, kept: kept.length, skipped: skipped, rows: rows }, null, 2) + "\n");
    } else {
      process.stdout.write("补锚点：没有需要补的块（共 " + rows.length + " 个块，已有锚点 " + kept.length + " 个）\n");
      for (const r of skipped) process.stdout.write("  跳过 " + r.path + ":" + r.line + "  " + r.id + "  " + r.reason + "\n");
    }
    return;
  }

  if (!args.write) {
    if (args.json) {
      process.stdout.write(JSON.stringify({ ok: true, dryRun: true, plans: plans, rows: rows }, null, 2) + "\n");
    } else {
      process.stdout.write("补尾部锚点（未落盘）\n\n");
      for (const p of plans) {
        process.stdout.write("  " + p.rel + "  补 " + p.adds.length + " 个\n");
        for (const a of p.adds) process.stdout.write("    行 " + (a.at + 1) + "  " + a.id + "\n      「" + a.before + "」\n      → 「" + a.after + "」\n");
      }
      for (const r of skipped) process.stdout.write("  跳过 " + r.path + ":" + r.line + "  " + r.id + "  " + r.reason + "\n");
      process.stdout.write("\n只追加锚点，正文与标记一个字节不动。确认后加 --write 重跑。\n");
    }
    return;
  }

  const broken = plans.filter((p) => !p.untouched);
  if (broken.length > 0) fail("除了追加串还动到了别的字节：" + broken.map((p) => p.rel).join("、") + "\n  脚本 bug，已中止未落盘。");

  const bdir = path.join(listed.root, ".daily-journal", "backup");
  fs.mkdirSync(bdir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const written = [];
  for (const p of plans) {
    const b = path.join(bdir, path.basename(p.rel) + "." + stamp + ".bak");
    fs.writeFileSync(b, p.expectBefore);
    p.backup = b;
    writeNoteInObsidian(vault, p);
    written.push({ path: p.rel, added: p.adds.length, backup: b });
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: true, status: "written", written: written, added: added, kept: kept.length, skipped: skipped, rows: rows }, null, 2) + "\n");
  } else {
    process.stdout.write("补锚点完成\n\n");
    for (const w of written) process.stdout.write("  " + w.path + "  补了 " + w.added + " 个块\n    备份: " + w.backup + "\n");
    for (const r of skipped) process.stdout.write("  跳过 " + r.path + ":" + r.line + "  " + r.id + "  " + r.reason + "\n");
  }
}

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
      // 锚点不算正文：先剥掉再算 hash，不然每个带锚点的新块都会被判成「正文被改过」。
      const anchor = (body.match(/ \^([A-Za-z0-9._-]+)$/) || [])[1] || null;
      const got = crypto.createHash("sha1").update(stripTailAnchor(body), "utf8").digest("hex").slice(0, 4);
      const hashOk = got === m[2];
      // 锚点是块 id 的副本，两者不一致一样算对不上 —— 只差锚点也报出来，别让它悄悄烂掉。
      const anchorOk = anchor === null || anchor === m[1];
      rows.push({
        path: f.path, line: i + 1, id: m[1], stored: m[2], computed: got, anchor: anchor,
        ok: hashOk && anchorOk,
        reason: !hashOk ? "正文 hash 与块 id 不一致" : anchorOk ? undefined : "尾部锚点与块 id 不一致",
      });
      if (!hashOk || !anchorOk) {
        stale.push({
          id: m[1],
          newId: m[1].slice(0, m[1].length - 5) + "-" + got,
          from: i,
          to: j,
          anchorAt: anchor === null ? -1 : j - 2,
          // 锚点的**原值**得记下来：回推证明要拿它把锚点还原，
          // 只记 anchorAt 的话「锚点值不对、hash 对」这种情况回推不回去，会被误判成块外被牵连。
          anchorWas: anchor,
        });
      }
    }
    if (stale.length === 0) continue;
    for (const s of stale) {
      lines[s.from] = "<!-- jc:begin id=" + s.newId + " -->";
      lines[s.to] = "<!-- jc:end id=" + s.newId + " -->";
      // 锚点跟着 id 一起换：只改标记会留下一个指向不存在块的锚点。
      if (s.anchorAt >= 0) lines[s.anchorAt] = lines[s.anchorAt].replace(/ \^[A-Za-z0-9._-]+$/, " ^" + s.newId);
    }
    let after = lines.join("\n");
    after = remapIndexRowIds(after, stale.map((s) => ({ from: s.id, to: s.newId })));
    // 块外必须逐字节未动：把上面几处 id 字符串全推回去，应正好等于原文
    let restored = after;
    for (const s of stale) {
      restored = replaceAllText(restored, "<!-- jc:begin id=" + s.newId + " -->", "<!-- jc:begin id=" + s.id + " -->");
      restored = replaceAllText(restored, "<!-- jc:end id=" + s.newId + " -->", "<!-- jc:end id=" + s.id + " -->");
      if (s.anchorAt >= 0) restored = replaceAllText(restored, " ^" + s.newId, " ^" + s.anchorWas);
    }
    restored = remapIndexRowIds(restored, stale.map((s) => ({ from: s.newId, to: s.id })));
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
      process.stdout.write("\n含义：这些块的正文在写入后被改过，或由旧版脚本写入。\n加 --write 把 id 重算成与正文一致（只改 id 与尾部锚点这两串字符，正文一个字节不动）。\n");
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
    p.backup = b;
    writeNoteInObsidian(vault, p);
    for (const s of p.stale) healed.push({ path: p.rel, id: s.id, newId: s.newId });
  }

  if (args.json) process.stdout.write(JSON.stringify({ ok: true, status: "healed", healed: healed, rows: rows }, null, 2) + "\n");
  else {
    process.stdout.write("id 已重算：" + staleCount + " 个块\n\n");
    for (const h of healed) process.stdout.write("  " + h.path + "  " + h.id + " -> " + h.newId + "\n");
    process.stdout.write("\n正文一个字节未动，只换了 id 与尾部锚点这两串字符。\n");
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  CLI_ARGS = args;
  // --kind 缺省是 thought：不传时行为与改动前逐字节相同。
  if (args.kind !== undefined && args.kind !== "thought" && args.kind !== "todo") {
    fail("--kind 只能是 thought 或 todo，收到 " + JSON.stringify(args.kind) + "\n  （缺省 = thought，向后兼容）");
  }
  // --help 不需要 Obsidian；其余路径先做 preflight。
  if (!(args.help || args.h)) preflight();
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
        "    --kind=thought|todo       可选，默认 thought；todo 写 ## 今日待办（任务行），不动 jc 层",
        "    --category=<#标签...>     必填（--kind=todo 时不用），分类列写裸标签，多个用空格分隔",
        "    --allow-new-tag           放行词表外的新标签（D5 闸门：先问用户，点头后才加）",
        "    --links=<[[a]]、[[b]]>    可选，只用于思考捕获；纯 wikilink 列表（、分隔、禁换行），目标须真实存在；单元格 | 要写 \\|；违规退出 7",
        "    --time=HH:MM              可选，默认当前（也接受 HHmm）",
        "    --date=YYYY-MM-DD         可选，默认今天（用于块 id；也是 ➕ 的兜底来源）",
        "    --no-task-add-created     --kind=todo 时不自动补 ➕（默认会补，取**笔记日期**，见 D22）",
        "    --write                   落盘；缺省只出 diff",
        "  校对（不改写，只给建议）:",
        "    --proofread               检查输入准确性，列出疑似问题与建议",
        "  改写已写入的原文（R3 的显式例外，默认 dry-run）:",
        "    --fix-written             需要 --id 与 --replace；只动 jc:begin/jc:end 之间",
        "    --id=<块 id>              可逗号分隔多个，形如 20260916-1549-0882",
        "    --replace='错→对'          可逗号分隔多对；命中数会被验证，且必须能反向回代",
        "    --write                   落盘（会先备份到 .daily-journal/backup/）",
        "  修 jc 块之外的机械错字（模板片段被改坏等；默认 dry-run）:",
        "    --repair-text             需要 --path 与 --replace；每对必须全文件只命中一次",
        "    --path=<路径|文件名>       只修这一个文件；块内正文请改用 --fix-written",
        "    --write                   落盘（会先备份到 .daily-journal/backup/）",
        "  把历史笔记里裹反引号的「块 id」格改写成块链接（默认 dry-run）:",
        "    --link-block-ids          只动派生层索引行的 id 格；块缺尾部锚点的先跑 --add-anchors",
        "  迁移派生层的历史分类（默认 dry-run）:",
        "    --migrate-tags            把索引里裹反引号的分类还原成裸标签",
        "    --map='旧→新'             可逗号分隔多对，用于个别改写（如 life/HomeLab→life）",
        "    --allow-new-tag           迁移结果含词表外新标签时放行（同上，先问用户）",
        "  自检:",
        "    --verify-ids              校 jc 块的 id 与尾部锚点是否仍与正文自洽；不一致退 1",
        "    --add-anchors             给旧块补上尾部锚点（纯追加，让 [[笔记#^id]] 跳得回来）",
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
        "                              列出区间内分类列仍含占位标签（#unsorted）的索引行",
        "  通用:",
        "    --vault=<库名>            默认 $DJ_VAULT，再默认 nextlink",
        "    --registry=<路径>         registry.json 实例；默认按 vault/状态目录探测",
        "    --rebuild-registry        重新生成 registry（缺失时也会自动重建）",
        "    --path=<库内相对路径>     默认由 daily:path 得到",
        "    --json                    以 JSON 输出",
        "  环境变量:",
        "    DJ_VAULT / DJ_OBSIDIAN_BIN / DJ_OBSIDIAN_PROC_RE",
        "    DJ_TIMEOUT_MS             obsidian CLI 超时毫秒，默认 30000，超时退出 4",
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

  if (args["repair-text"]) {
    cmdRepairText(vault, args);
    return;
  }

  if (args["link-block-ids"]) {
    cmdLinkBlockIds(vault, args);
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

  if (args["add-anchors"]) {
    cmdAddAnchors(vault, args);
    return;
  }

  if (args.audit) {
    const p = localParts();
    const from = typeof args.from === "string" ? args.from : p.date;
    const to = typeof args.to === "string" ? args.to : from;
    const folder = typeof args.path === "string" ? path.dirname(args.path) : path.dirname(dailyPath(vault));
    const code =
      "globalThis.__DJ_P = " +
      JSON.stringify({ from, to, folder, tag: PLACEHOLDER_TAG, nameRe: "^(\\d{4})-(\\d{2})-\\d{2}w-(\\d{2})$" }) +
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
            "       发现: " + f.found + (Array.isArray(f.spans) && f.spans.length > 1 ? "（" + f.spans.length + " 处）" : "") + "\n" +
            "       建议: " + (f.suggestion === "" ? "(删除)" : f.suggestion) + "\n" +
            "       理由: " + f.reason + "\n\n"
        );
      }
    }
    return;
  }

  // 写入模式
  if (content === null) fail("缺少内容：请给 --content / --content-file / --stdin");
  // 空内容不是一条捕获：writer 那边 bodyExact 用 indexOf，空串恒命中，
  // 会让空块混过五项校验。这里先拦，payload 里再兜一层（同一口径：empty 是 blocking）。
  if (content.trim() === "") {
    fail("内容为空或只有空白，没有可写入的原文。\n  （校对里 empty 是 blocking 项，写入侧同一口径：不落盘）");
  }
  const isTodo = args.kind === "todo";
  if (isTodo && typeof args.links === "string" && args.links.trim()) {
    fail("--links 只给思考捕获用（它写索引表的关联列）；待办不产生索引行，分类写在行内标签里（D21）。");
  }

  if (!isTodo && (typeof args.category !== "string" || args.category.length === 0)) {
    fail("缺少 --category=<#标签...>（分类列写裸标签，可多个）");
  }
  if (!isTodo) {
    // 分类列的词表闸门只对思考捕获跑：待办不产生索引行，分类写在行内标签（D21），
    // 硬把 --category 的空串丢进 validateTags 会以「分类为空」直接失败。
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
  }

  // 关联列只能链真实存在的文件；没有实际文档，关联就没有意义（A3）。
  if (!isTodo && typeof args.links === "string" && args.links.trim()) {
    const lc = checkLinks(vault, args.links);
    if (lc.malformed) {
      fail(
        "--links 必须是纯 wikilink 列表，例：--links='[[🎁]]、[[🐱]]'" +
          (lc.reason ? "\n  问题：" + lc.reason : "") +
          (lc.detail ? "\n  " + lc.detail : "") +
          "\n  （关联列只放真实文件的链接；裸文字写不进关联，未转义的 | 会把索引行撑成 5 列）",
        7,
      );
    }
    if (lc.missing.length > 0) {
      fail(
        "--links 里有库里找不到的目标：" + lc.missing.map((t) => "[[" + t + "]]").join("、") +
          "\n  关联列只允许链真实存在的文件（没有实际文档，关联就没有意义）。" +
          "\n  要么去掉这些链接，要么先把对应笔记建好。" +
          "\n  （解析规则同 Obsidian：全路径/文件名算命中；frontmatter aliases **不算** —— 实测别名不是链接目标，见 D34）",
        7,
      );
    }
  }

  let finalContent = content;

  // 待办层只接任务行：**固定前**、在 --fix-pair / --fix 之后做最后一道阻断检查，
  // 只要还剩下阻断级发现（相对时间、错状态符、非任务行）就不落盘。
  // 这是 D24（相对时间不落盘）与「- [?] 不落盘」唯一的机械守住点 ——
  // 不先校验就写，错的状态符 / 相对时间会以完全合法的行形式落进去，五项校验全绿。
  const todoGate = function (text) {
    if (!isTodo) return;

    // D21/B4：行内**主题**标签仍要过同一道 D5 闸门（`#gtd/*` 除外，那是任务状态）。
    // 闸门开在 --fix-pair / --fix 之后，判的是真正要落盘的那份文本。
    const topicTags = todoTopicTags(text);
    if (topicTags.length > 0) {
      const know = knownTagSets(loadTags(vault, args));
      const check = validateTags(topicTags.join(" "), know);
      if (!check.ok) {
        fail(
          "待办行里的标签不合法：" + check.reason +
            "\n  （D5：不静默降级。主题标签走分类词表那套；任务状态写 #gtd/*）",
        );
      }
      if (check.novel.length > 0 && !args["allow-new-tag"]) {
        fail(
          "待办行里有词表外的新标签：" + check.novel.join("、") +
            "\n  新标签是允许的，但**必须先问用户**。用户点头后加 --allow-new-tag 重跑。" +
            "\n  （D5：不静默降级，也不静默扩张词表）",
        );
      }
    }

    const pf = runProofread(vault, text, skipSet(args));
    for (const f of pf.findings) {
      if (f.blocking) continue;
      process.stderr.write(
        "daily-journal: 待办提醒  " + f.kind + "  " + f.found + "\n   -> " + f.suggestion + "\n"
      );
    }
    const blockers = pf.findings.filter((f) => f.blocking);
    if (blockers.length > 0) {
      fail(
        "待办捕获没通过校对，未落盘：\n" +
          blockers
            .map((f) => "  " + f.kind + "  行 " + (f.line || "?") + "  " + f.found + "\n    -> " + f.suggestion)
            .join("\n") +
          "\n  （先跑 --proofread 看详情；确认后用 --fix-pair / --fix 修好再重跑）",
        1,
      );
    }
  };

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
    // 反向回代必须逐字节回到原文 —— 与 --fix-written 同一条硬证据。
    // **倒序**撤销：a→b,b→c 这种链式对，正序撤只会得到中间态。
    let back = after;
    for (let i = applied.length - 1; i >= 0; i--) {
      back = replaceAllText(back, applied[i].to, applied[i].from);
    }
    if (back !== before) {
      fail(
        "回代校验失败：--fix-pair 不是干净的字面替换（右值在原文中也出现过，会互相干扰）。" +
          "\n  请换更长的上下文再试，不要用会撞车的对。",
      );
    }
    pairReport = {
      applied: applied.map((a) => ({ from: a.from, to: a.to, n: a.n })),
      replacements: applied.reduce((s, a) => s + a.n, 0),
      changed: after !== before,
    };
    finalContent = after;
  }

  let fixReport = null;
  if (typeof args.fix === "string") {
    const pf = runProofread(vault, finalContent, skipSet(args));
    let ids;
    let explicit = null;
    if (args.fix === "safe") ids = safeIds(pf.findings);
    else if (args.fix === "all") ids = "all";
    else {
      explicit = args.fix.split(",").map((s) => s.trim()).filter(Boolean);
      ids = explicit;
    }
    const r = applyFixes(finalContent, pf.findings, ids);
    if (explicit) {
      const miss = explicit.filter((id) => !r.applied.includes(id));
      if (miss.length > 0) {
        fail(
          "--fix 指定的项不存在或不可机械修正：" + miss.join(",") + "\n  可用 id 见 --proofread 的输出。",
          1
        );
      }
    }
    const byId = new Map(pf.findings.map((f) => [f.id, f]));
    fixReport = {
      requested: args.fix,
      applied: r.applied.map((id) => (byId.get(id) || {}).found).filter(Boolean),
      appliedIds: r.applied,
      replacements: r.replacements,
      changed: r.text !== finalContent,
    };
    finalContent = r.text;
  }

  // 待办通道的最后一道闸：跑在 --fix-pair / --fix 之后，看的是真正要落盘的那份文本。
  todoGate(finalContent);

  const parts = localParts();
  const t =
    typeof args.time === "string" ? parseTime(args.time) : { compact: parts.hm, display: parts.hms };
  const idBase =
    (typeof args.date === "string" ? args.date.replace(/-/g, "") : parts.ymd) + "-" + t.compact;
  const hash = crypto.createHash("sha1").update(finalContent, "utf8").digest("hex").slice(0, 4);
  const id = idBase + "-" + hash;

  // dry-run 不落盘，也就不该创建当日笔记：只取路径，缺文件由 payload 报 note-not-found。
  const rel =
    typeof args.path === "string" ? args.path : args.write ? ensureDaily(vault) : dailyPath(vault);

  // ➕ 用**笔记日期**，不是脚本运行日（D22）。补记昨天的日记时运行日是错的那一天，
  // 而补错值的行仍然是合法任务行，五项校验全绿 —— 这里取错，后面没有任何东西拦得住。
  const noteDateFromPath = noteDateFromName(rel);
  const noteDate =
    noteDateFromPath ||
    (typeof args.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : parts.date);
  const createdDateSource = noteDateFromPath
    ? "note-name"
    : typeof args.date === "string"
    ? "--date"
    : "run-date";

  // 待办行只允许补 ➕ 这一个字段（D22）：它是机制字段、由笔记日期完全确定、可机械回代，
  // 不算改写用户原文；其余一个字符都不动（R3）。
  let todoContent = finalContent;
  let createdAdded = 0;
  if (isTodo && !args["no-task-add-created"]) {
    const todoLines = todoContent.split("\n");
    for (let i = 0; i < todoLines.length; i++) {
      const m = todoLines[i].match(/^([ \t]*[-*+][ \t]+\[.\][ \t]*)(.*)$/);
      if (!m) continue;
      if (m[2].indexOf("➕") >= 0) continue;
      const at = m[2].search(/(🛫|⏳|📅|🔁|✅|❌)/);
      const head = (at >= 0 ? m[2].slice(0, at) : m[2]).replace(/[ \t]+$/, "");
      todoLines[i] = m[1] + head + " ➕ " + noteDate + (at >= 0 ? " " + m[2].slice(at) : "");
      createdAdded++;
    }
    todoContent = todoLines.join("\n");
  }

  // 尾部锚点（C10）：钉在正文最后一行的末尾，让 [[笔记#^id]] 跳得回这段思考。
  // 它是 agent 自己生成的 token、不属于正文，但**位置在正文里**，所以末尾不适合钉时就不钉 ——
  // 只报出来，捕获本身照走（原文优先，绝不为了埋个锚点去弄坏 markdown）。
  let anchor = "";
  let anchorSkipped = null;
  if (!isTodo) {
    anchorSkipped = tailAnchorBlocker(finalContent);
    if (anchorSkipped === null) anchor = " ^" + id;
  }

  const payload = {
    path: rel,
    content: isTodo ? todoContent : finalContent,
    anchor: anchor,
    kind: isTodo ? "todo" : "thought",
    noteDate: noteDate,
    createdDateSource: createdDateSource,
    id,
    time: t.display,
    category: isTodo ? "" : args.category,
    links: typeof args.links === "string" ? args.links : "",
    write: !!args.write,
    sections: SECTIONS,
  };

  // 捕获通道也要能在落盘前证明「Obsidian 收到的 = Node 算出的」（C11）：
  // 指纹域与 WRITE_PAYLOAD 里的 stampSrc 逐字对应。
  const captureStamp = contentStamp(captureStampSrc(payload));
  payload.stampLen = captureStamp.len;
  payload.stampSum = captureStamp.sum;

  const code = "globalThis.__DJ_P = " + JSON.stringify(payload) + ";\n" + WRITE_PAYLOAD;
  const res = evalInObsidian(vault, code);

  if (fixReport) res.fixReport = fixReport;
  if (pairReport) res.pairReport = pairReport;
  if (anchorSkipped) res.anchorSkipped = anchorSkipped;

  if (!res.ok && res.status !== "duplicate" && res.error !== "task-line-duplicate") {
    process.stderr.write(JSON.stringify(res, null, 2) + "\n");
    if (res.error === "transport-corrupt") {
      process.stderr.write(
        "daily-journal: 载荷在传进 Obsidian 的路上被改过（长度 " + res.gotLen + "，应为 " + res.wantLen +
          "），已中止、一个字未写。\n" +
          "  这是 obsidian CLI 的 code= 入参的已知失真；本脚本已把非 ASCII 转义送出，\n" +
          "  仍出现请升级 CLI，并把这条记入 decision-log。\n"
      );
    }
    if (res.error === "concurrent-edit") {
      process.stderr.write("daily-journal: 读取到写入之间 Obsidian 里改过这条笔记，已放弃落盘；请重跑。\n");
    }
    if (res.error === "note-not-found") {
      if (typeof args.path === "string") {
        // 显式 --path 指向的文件 payload 只会读、绝不创建，加 --write 也没用。
        process.stderr.write(
          "daily-journal: --path 指向的笔记不存在；本脚本不创建指定路径的笔记（先建好它，或改用默认当日路径 + --write）。\n"
        );
      } else if (!args.write) {
        process.stderr.write(
          "daily-journal: 当日笔记还不存在；dry-run 不建文件，加 --write 才会建（或先跑 scripts/journal_create.sh）。\n"
        );
      }
    }
    process.exit(res.error === "id-collision" ? 5 : 6);
  }

  if (res.status === "duplicate") {
    process.stdout.write(
      (args.json
        ? JSON.stringify(res, null, 2)
        : (res.kind === "todo" ? "重复：这几行已在 " : "重复：相同内容已在 ") +
          res.path +
          " 中（" +
          (res.kind === "todo" ? "行级判重，无 id" : "id=" + res.id) +
          "），未写入。") + "\n"
    );
    return;
  }

  if (res.error === "task-line-duplicate") {
    process.stderr.write(
      "daily-journal: 待办行部分重复，不静默跳过重复行。\n  重复：" +
        res.duplicateLines.join("、") +
        "\n  新行：" +
        res.newLines.join("、") +
        "\n  请把要落的那几条单独重跑。\n"
    );
    process.exit(6);
  }

  const diff = res.before !== undefined && res.after !== undefined ? unifiedDiff(res.before, res.after) : "";
  delete res.before;
  delete res.after;
  res.diff = diff;

  if (args.json) process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  else {
    process.stdout.write("目标: " + res.path + "\n");
    if (res.kind === "todo") {
      process.stdout.write(
        "状态: " + res.status + "  待办行: " + res.addedLines.length +
          (createdAdded > 0 ? "  补 ➕ ×" + createdAdded : "") +
          "  （➕=" + noteDate + "，来源 " + createdDateSource + "）\n"
      );
    } else {
      process.stdout.write("状态: " + res.status + "  id: " + res.id + "  分类: " + res.category + "\n");
      if (res.anchorSkipped) {
        process.stdout.write("注意: 没钉尾部锚点 —— " + res.anchorSkipped + "\n  后果：这一段不能被 [[本笔记#^id]] 链到（正文照写了）。\n");
      }
    }
    if (res.fixReport && res.fixReport.changed) {
      process.stdout.write("修正: 已套用 " + res.fixReport.replacements + " 处 -> " + res.fixReport.applied.join("、") + "\n");
    }
    if (res.pairReport && res.pairReport.changed) {
      process.stdout.write(
        "中文修正: 已套用 " + res.pairReport.replacements + " 处 -> " +
          res.pairReport.applied.map((a) => a.from + "→" + a.to + " ×" + a.n).join("、") + "\n"
      );
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

main();
