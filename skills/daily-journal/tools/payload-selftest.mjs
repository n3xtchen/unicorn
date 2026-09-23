// 离线自检：用假的 app 替掉 Obsidian，不碰库就能验「捕获通道」那条路径（C10 锚点 + C11 载荷指纹）。
//
// 跑法：node tools/payload-selftest.mjs        （不需要 Obsidian 在运行，不读也不写任何笔记）
//
// 为什么要有这个文件：这些都是「不报错、只是静默做错」的路径 —— 加错锚点、重复写块、
// 覆盖同 id 的旧块、载荷被传输改坏却照落盘。光靠读代码看不出来，靠人手在真库里试又会写坏日记。
// 契约（payload 字段、校验项、指纹域）一改，这里先红：所以它必须跟脚本同仓库、同版本走，
// 放在 /tmp 里重启就没，等于没有。
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "scripts", "journal_apply.mjs");
const src = fs.readFileSync(SRC, "utf8");

// 被测代码从源文件里抠，不从副本 —— 否则副本漂了、自检还全绿。
function cut(re, what) {
  const m = src.match(re);
  if (!m) throw new Error("在 " + SRC + " 里找不到 " + what);
  return m[1];
}
const payloadSrc = cut(/const WRITE_PAYLOAD = String\.raw`([\s\S]*?)`;\n/, "WRITE_PAYLOAD");
const fixWrittenSrc = cut(/const FIXWRITTEN_PAYLOAD = String\.raw`([\s\S]*?)`;\n/, "FIXWRITTEN_PAYLOAD");
// 指纹域同理：harness 自己再抄一份就会跟实现漂移，所以直接执行源文件里的那个函数。
const captureStampSrc = new Function("return " + cut(/(function captureStampSrc\(p\) \{[\s\S]*?\n\})/, "captureStampSrc"))();
const escapeNonAsciiForCli = new Function("return " + cut(/(function escapeNonAsciiForCli\(code\) \{[\s\S]*?\n\})/, "escapeNonAsciiForCli"))();
// 锚点是三个通道（捕获比对 / --fix-written / --verify-ids）共用的一层，
// 所以这三个纯函数直接执行源文件里的那份，不在 harness 里另拄一份。
const anchorFns = (function () {
  const src = cut(/(const ANCHOR_RE = [\s\S]*?\nconst retokenAnchors = function[\s\S]*?\n\};)/, "锚点函数（ANCHOR_RE / stripAnchors / anchorsInBody / retokenAnchors）");
  return new Function("return function () {\n" + src + "\nreturn { stripAnchors: stripAnchors, anchorsInBody: anchorsInBody, retokenAnchors: retokenAnchors, isAnchorId: isAnchorId };\n}")();
})();
const lineAnchorBlocker = new Function("return " + cut(/(function lineAnchorBlocker\(lines, idx\) \{[\s\S]*?\n\})/, "lineAnchorBlocker"))();
const anchorPlacement = new Function(
  "lineAnchorBlocker",
  "return " + cut(/(function anchorPlacement\(body\) \{[\s\S]*?\n\})/, "anchorPlacement"),
)(lineAnchorBlocker);

const SECTIONS = { thinking: "今日的思考", todo: "今日待办", derived: "今日分类与关联", related: "关联笔记" };
const NL = "\n";
const sha1 = (s) => crypto.createHash("sha1").update(s, "utf8").digest("hex").slice(0, 4);
// 剥锚点：逐行剥（块锚点新口径钉首行，整串 regex 只剥得掉末尾那个）。
const stripAnchor = (s) => s.split(NL).map((l) => l.replace(/ \^[A-Za-z0-9._-]+$/, "")).join(NL);
const sumOf = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
};

const SKELETON = [
  "---", "date: 2026-99-99", "---", "",
  "## " + SECTIONS.thinking, "",
  "## " + SECTIONS.todo, "",
  "<!-- jt:begin -->", "<!-- jt:end -->", "",
  "## " + SECTIONS.derived, "",
  "<!-- jc:index:begin -->",
  "| 时间 | 块 id | 分类 | 关联 |",
  "| --- | --- | --- | --- |",
  "<!-- jc:index:end -->", "",
  "### " + SECTIONS.related, "",
].join(NL);

function store(initial) {
  const s = { content: initial, writes: 0, concurrencyBreaker: null };
  s.app = {
    vault: {
      getAbstractFileByPath: (p) => ({ path: p }),
      read: async () => s.content,
      process: async (f, cb) => {
        const data = s.concurrencyBreaker === null ? s.content : s.concurrencyBreaker;
        const out = cb(data);
        s.content = out;
        s.writes++;
        return out;
      },
    },
  };
  return s;
}

// stamp 默认现算（真实脚本也是 payload 组装完成后才算）；要做篡改实验就传 opts.stamp。
function run(P, s, opts = {}) {
  const st = opts.stamp === undefined ? captureStampSrc(P) : opts.stamp;
  P.stampLen = opts.stampLen === undefined ? st.length : opts.stampLen;
  P.stampSum = opts.stampSum === undefined ? sumOf(st) : opts.stampSum;
  const code = "globalThis.__DJ_P = " + JSON.stringify(P) + ";\nreturn (\n" + payloadSrc + "\n);";
  return new Function("app", code)(s.app).then((r) => JSON.parse(r));
}

function mkPayload(content, extra = {}) {
  const hash = sha1(content); // 跟真实脚本一致：hash 算的是**原样**的 finalContent
  const id = "20260920-1037-" + hash;
  return Object.assign(
    {
      path: "02-Done/2026-99-99w-99.md",
      content: content,
      kind: "thought",
      noteDate: "2026-09-20",
      createdDateSource: "note-name",
      id: id,
      time: "10:37:08",
      category: "#test",
      links: "",
      write: false,
      anchor: " ^" + id,
      // 锚点钉在哪一行由 Node 侧算好（capture 通道用同一个 anchorPlacement）后传给 payload。
      anchorLine: anchorPlacement(content).at,
      sections: SECTIONS,
    },
    extra,
  );
}

let pass = 0, failn = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { failn++; console.log("  ❌ " + name + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
};

// ---------------------------------------------------------------- 1 捕获
console.log("\n[1] 捕获：正文首行钉锚点");
const TEXT = "今天把日记脚本的块锚点补上了。\n\n结论是锚点只能挤在正文里。";
{
  const s = store(SKELETON);
  const P = mkPayload(TEXT);
  const r = await run(P, s);
  ok("六项校验全绿", r.verify && r.verify.allOk === true, r.verify);
  ok("正文一字未动（bodyExact）", r.verify.bodyExact === true);
  ok("锚点是纯追加", r.after.includes("今天把日记脚本的块锚点补上了。 ^" + P.id), r.after.split(NL).filter((l) => l.includes("^")).join("|"));
  ok("锚点落在正文第一行（不另起行）", r.after.split(NL).some((l) => l === "今天把日记脚本的块锚点补上了。 ^" + P.id));
  ok("锚点 = 块 id", r.id === P.id);
  ok("dry-run 没写盘", s.writes === 0);

  // 拿写出来的样子自己验一遍：剥掉锚点后 sha1 必须等于 id 里的 hash
  const lines = r.after.split(NL);
  const i = lines.findIndex((l) => l === "<!-- jc:begin id=" + P.id + " -->");
  const j = lines.findIndex((l, k) => k > i && l === "<!-- jc:end id=" + P.id + " -->");
  const body = lines.slice(i + 2, j - 1).join(NL);
  ok("剥锚点后 sha1(正文) == id 里的 hash", sha1(stripAnchor(body)) === P.id.slice(-4), { got: sha1(stripAnchor(body)), want: P.id.slice(-4) });
  ok("锚点行 = 第一行正文", i + 2 === lines.findIndex((l) => l.endsWith(" ^" + P.id)));
}

// ---------------------------------------------------------------- 2 幂等
console.log("\n[2] 重捕同一段：必须认成 duplicate，不能重复写");
{
  const s = store(SKELETON);
  const P1 = mkPayload(TEXT);
  P1.write = true;
  const w = await run(P1, s);
  ok("第一次写入成功", w.status === "written" && w.readBackExact === true, w.status);
  const P2 = mkPayload(TEXT);
  const d = await run(P2, s);
  ok("第二次报 duplicate", d.status === "duplicate" && d.ok === true, d.status || d.error);
  ok("没有多写一次盘", s.writes === 1, s.writes);
}

// ---------------------------------------------------------------- 3 撞 id
console.log("\n[3] 同 id 不同正文：必须 id-collision，不能覆盖");
{
  const s = store(SKELETON);
  const P1 = mkPayload(TEXT);
  P1.write = true;
  await run(P1, s);
  const P2 = mkPayload(TEXT);
  P2.content = "换了内容的同一时刻捕获。";
  const c = await run(P2, s);
  ok("报 id-collision", c.error === "id-collision", c.error || c.status);
}

// ---------------------------------------------------------------- 4 老块（无锚点）不受影响
console.log("\n[4] 向后兼容：库里已有的无锚点块，再加新块不受影响");
{
  const legacy = SKELETON.replace(
    "## " + SECTIONS.todo,
    "<!-- jc:begin id=20260920-1025-e95b -->\n\n老的一块原文\n\n<!-- jc:end id=20260920-1025-e95b -->\n\n## " + SECTIONS.todo,
  );
  const s = store(legacy);
  const P = mkPayload(TEXT);
  const r = await run(P, s);
  ok("六项校验全绿", r.verify && r.verify.allOk === true, r.verify);
  ok("老块一字未动", r.after.includes("老的一块原文\n\n<!-- jc:end id=20260920-1025-e95b -->"));
}

// ---------------------------------------------------------------- 5 尾随空白
console.log("\n[5] 正文末尾带空白/换行：锚点仍要能一字不差剥回去");
for (const [name, text] of [["尾随空格", "正文末尾有空格   "], ["尾随换行", "正文末尾有换行\n"], ["多段", "第一段\n\n第二段"]]) {
  const s = store(SKELETON);
  const P = mkPayload(text);
  const r = await run(P, s);
  const lines = r.after.split(NL);
  const i = lines.findIndex((l) => l === "<!-- jc:begin id=" + P.id + " -->");
  const j = lines.findIndex((l, k) => k > i && l === "<!-- jc:end id=" + P.id + " -->");
  const body = lines.slice(i + 2, j - 1).join(NL);
  ok(name + "：剥锚点后回到原文", stripAnchor(body) === text, { got: JSON.stringify(stripAnchor(body)), want: JSON.stringify(text) });
  ok(name + "：bodyExact", r.verify.bodyExact === true);
}

// ------------------------------------------------- 6 捕获通道的载荷指纹（C11）
// 这一节是「捕获通道只剩字符串相等」那个缺口的回归钉：改坏一个字也必须一个字都不写。
console.log("\n[6] 载荷指纹：对不上就 transport-corrupt，且一次盘都不写（C11）");
{
  const s = store(SKELETON);
  const P = mkPayload(TEXT);
  P.write = true;
  const r = await run(P, s);
  ok("指纹正确 → 正常写入", r.status === "written" && s.writes === 1, r.status || r.error);

  const s2 = store(SKELETON);
  const before = s2.content;
  const P2 = mkPayload(TEXT);
  P2.write = true;
  const st2 = captureStampSrc(P2);
  const r2 = await run(P2, s2, { stamp: st2, stampLen: st2.length + 1 });
  ok("stampLen 差 1 → transport-corrupt", r2.error === "transport-corrupt", r2.error || r2.status);
  ok("stampLen 差 1 → process 调用 0 次", s2.writes === 0, s2.writes);
  ok("stampLen 差 1 → 盘上内容一字未动", s2.content === before);

  // 最要命的一类：长度不变、只有内容被换掉 —— 只比字符串是绝对抓不到的。
  const s3 = store(SKELETON);
  const P3 = mkPayload(TEXT);
  P3.write = true;
  const st3 = captureStampSrc(P3); // 指纹按**原稿**算，然后偷偷改稿
  P3.content = P3.content.replace("锚点", "陷阱"); // 等长替换
  const r3 = await run(P3, s3, { stamp: st3 });
  ok("等长改一个字 → transport-corrupt", r3.error === "transport-corrupt", r3.error || r3.status);
  ok("等长改一个字 → 一次盘都没写", s3.writes === 0, s3.writes);

  // 指纹域必须覆盖锚点：只护 content 的话，锚点被改坏（→ 链接跳不到）没人拦。
  const s4 = store(SKELETON);
  const P4 = mkPayload(TEXT);
  P4.write = true;
  const st4 = captureStampSrc(P4);
  P4.anchor = " ^20260920-1037-dead";
  const r4 = await run(P4, s4, { stamp: st4 });
  ok("只改锚点 → transport-corrupt", r4.error === "transport-corrupt", r4.error || r4.status);
}

// ------------------------------------------------- 7 入参转 ASCII（C11 第一道防）
console.log("\n[7] code= 入参转纯 ASCII：语义等价，且再没有可被切断的多字节序列");
{
  const code = 'globalThis.__X = {"c":"中文，含 emoji ➕ 和 \\u2028"};';
  const esc = escapeNonAsciiForCli(code);
  ok("转义后整串是纯 ASCII", !/[^\x00-\x7f]/.test(esc), esc.slice(0, 80));
  ok("非 ASCII 一个不剩（原串确实有）", /[^\x00-\x7f]/.test(code));
  // 语义等价：转义后的源码在 JS 里跑出来必须还是原字符串。
  const got = new Function(esc + " return globalThis.__X.c;")();
  ok("转义后求值 == 原值（含 emoji）", got === "中文，含 emoji ➕ 和 \u2028", got);
  // 载荷整体走一遍：转义前后 Obsidian 拿到的 JSON 必须一模一样。
  const P = mkPayload("正文带中文与 emoji ➕ 📅，还有 \u2028 行分隔符");
  const body = "globalThis.__DJ_P = " + JSON.stringify(P) + ";\n" + payloadSrc;
  const a = new Function(body + " return JSON.stringify(globalThis.__DJ_P);");
  const b = new Function(escapeNonAsciiForCli(body) + " return JSON.stringify(globalThis.__DJ_P);");
  ok("整个载荷转义前后相等", a() === b());
}

// ------------------------------------- 8 改写通道的载荷指纹（同一个口径，另一条通道）
console.log("\n[8] 改写通道 payload：len/sum 自查同样 fail-closed");
{
  // 写盘只算真改动（process 回调返回原样 = 一次都没写）。
  // breaker 不为 null 时，模拟「读到写之间 Obsidian 那边把文件改了」：写那一刻盘上已经是 breaker。
  const sleep = (rel, before, after, extra = {}, breaker = null) => {
    const f = { path: rel };
    const s = { content: before, writes: 0 };
    s.app = { vault: { getAbstractFileByPath: () => f, read: async () => s.content,
      process: async (_f, cb) => { if (breaker !== null) s.content = breaker; const out = cb(s.content); if (out !== s.content) { s.content = out; s.writes++; } return out; } } };
    const P = Object.assign({ path: rel, expectBefore: before, after: after, afterLen: after.length, afterSum: sumOf(after) }, extra);
    const code = "globalThis.__DJ_P = " + JSON.stringify(P) + ";\nreturn (\n" + fixWrittenSrc + "\n);";
    return new Function("app", code)(s.app).then((r) => [JSON.parse(r), s]);
  };
  const before = "## 今日的思考\n\n老正文\n";
  const after = before + "\n<!-- jc:begin id=x -->\n\n新块\n\n<!-- jc:end id=x -->\n";
  const [r1, s1] = await sleep("02-Done/x.md", before, after);
  ok("指纹正确 → 写入且回读一致", r1.ok === true && r1.readBackExact === true && s1.writes === 1, r1);

  const [r2, s2] = await sleep("02-Done/x.md", before, after, { afterLen: after.length + 1 });
  ok("afterLen 差 1 → transport-corrupt", r2.error === "transport-corrupt", r2.error || r2.status);
  ok("afterLen 差 1 → 没写盘", s2.writes === 0 && s2.content === before);

  // 最要命的一类：长度不变、指纯被换掉 —— 只比字符串是绝对抓不到的。
  // 指纹按**原稿**算，再偷改稿（等长），看它认不认。
  const tampered = after.replace("新块", "别的");
  const [r3, s3] = await sleep("02-Done/x.md", before, tampered, { afterLen: after.length, afterSum: sumOf(after) });
  ok("等长改字 → transport-corrupt", r3.error === "transport-corrupt", r3.error || r3.status);
  ok("等长改字 → 没写盘", s3.writes === 0 && s3.content === before);

  // 并发：读到写之间文件被 Obsidian 那边改过 → process 回调原样返回、盘上停在他的版本。
  const theirs = "## 今日的思考\n\n我这边刚改过的\n";
  const [r4, s4] = await sleep("02-Done/x.md", before, after, {}, theirs);
  ok("并发改动 → beforeMatched=false", r4.ok === true && r4.beforeMatched === false, r4);
  ok("并发改动 → 盘上仍是他的版本、没被覆盖", s4.content === theirs && s4.writes === 0);

  // 载荷指纹要在**并发检查之前**拦：先证明收到的字节是对的，再谈文件是不是读到的那个。
  const [r5] = await sleep("02-Done/x.md", before, after, { afterSum: sumOf(after) + 1 }, theirs);
  ok("并发 + 指纹坏 → 报 transport-corrupt（不是 readback-mismatch）", r5.error === "transport-corrupt", r5.error || r5.status);
}

// ------------------------------------------- 9 行锚点（D35：指到具体哪一句）
console.log("\n[9] 行锚点：剥 / 认 / 换前缀（三个通道都靠这三件事）");
{
  const A = anchorFns();
  const BID = "20260923-0923-0411";
  const body = [
    "常规品预测前天就简单做了代码分析 ^" + BID + "-1",
    "",
    "- 结论一：建模要拆开 ^" + BID + "-3",
    "- 结论二：不会被重构掉",
    "最后一句 ^" + BID,
  ].join(NL);
  const plain = [
    "常规品预测前天就简单做了代码分析",
    "",
    "- 结论一：建模要拆开",
    "- 结论二：不会被重构掉",
    "最后一句",
  ].join(NL);

  ok("剥锚点：块锚点与行锚点一起剥，正文一字不差", A.stripAnchors(body) === plain, {
    got: JSON.stringify(A.stripAnchors(body)),
  });
  // 形状没限死的话，正文里碰巧以 ` ^词` 结尾的句子会被当锚点剥掉 —— 那就成静默改原文了。
  const prose = "口令是 abc ^word";
  ok("剥锚点：正文里碰巧的 ` ^词` 不剥", A.stripAnchors(prose) === prose, A.stripAnchors(prose));
  ok("剥锚点：旧锚点形状（非本约定）也不剥", A.stripAnchors("正文 ^2026-abcd") === "正文 ^2026-abcd");

  const found = A.anchorsInBody(body);
  ok("认得出全部 4 个锚点及各自行号", JSON.stringify(found.map((a) => [a.at + 1, a.lineNo])) === JSON.stringify([[1, 1], [3, 3], [5, null]]), found.map((a) => [a.at + 1, a.lineNo]));
  ok("裸块锚点的 lineNo 是 null（不是 0）", found[2].lineNo === null, found[2]);

  const NEW = "20260923-0923-ab12";
  const re = A.retokenAnchors(body, NEW);
  ok("换前缀：三个锚点全换，行号位保留", re.includes(" ^" + NEW + "-1") && re.includes(" ^" + NEW + "-3") && re.includes("最后一句 ^" + NEW), re);
  ok("换前缀：剥掉后仍是同一段正文", A.stripAnchors(re) === plain);
  ok("换前缀：行数不变（行位置不漂）", re.split(NL).length === body.split(NL).length);
  ok("换前缀：新 hash 就是对剥掉锚点的正文算的", sha1(A.stripAnchors(re)) === sha1(plain));

  // 钉不钉得上：这几类行钉了会把 markdown 弄坏，必须先拦。
  const mk = (ls, i) => lineAnchorBlocker(ls, i);
  ok("拒绝：空行", mk(["正文", ""], 1) !== null);
  ok("拒绝：表格行", mk(["正文", "| a | b |"], 1) !== null);
  ok("拒绝：代码围栏", mk(["正文", "```"], 1) !== null);
  ok("拒绝：未闭合代码块里的行", mk(["```", "代码 ^x"], 1) !== null);
  ok("拒绝：闭合代码块之后的行可以钉", mk(["```", "代码", "```", "正文"], 3) === null);
  ok("拒绝：标题", mk(["正文", "## 标题"], 1) !== null);
  ok("普通行可钉", mk(["正文", "- 子项"], 1) === null);
  ok("钉位：普通正文钉首行", anchorPlacement("第一句\n\n第二句").at === 0);
  ok("钉位：列表整条钉首行（整条挂在顶层项下时就该这样）", anchorPlacement("- 父项\n  - 子项一\n  - 子项二").at === 0);
  ok("钉位：首行是标题就退末行", anchorPlacement("## 标题\n正文").at === 1);
  ok("钉位：首行是表格行就退末行", anchorPlacement("| a |\n正文").at === 1);
  ok("钉位：首行是围栏就退末行", anchorPlacement("```\n代码\n```").at === -1, anchorPlacement("```\n代码\n```"));
  ok("钉位：首末都不行就不钉，并给出原因", anchorPlacement("## 标题\n| a |").at === -1 && /标题/.test(anchorPlacement("## 标题\n| a |").why));
  ok("钉位：末尾有空行不影响钉子（钉首行）", anchorPlacement("正文\n").at === 0);
  ok("钉位：全空就不钉", anchorPlacement("   \n").at === -1);
}

// ------------------------------- 10 补过行锚点的块，再捕一次不能变成 id-collision
console.log("\n[10] 块里挂着行锚点时：正文比对要先把行锚点剥干净（否则重捕像撞 id）");
{
  const id = "20260920-1037-" + sha1(TEXT);
  const anchoredText = TEXT.split(NL).map((l, k) => (k === 0 ? l + " ^" + id + "-1" : l)).join(NL);
  const legacy = SKELETON.replace(
    "## " + SECTIONS.todo,
    "<!-- jc:begin id=" + id + " -->\n\n" + anchoredText + "\n\n<!-- jc:end id=" + id + " -->\n\n## " + SECTIONS.todo,
  );
  const s = store(legacy);
  const d = await run(mkPayload(TEXT), s);
  ok("带行锚点的旧块 → 认成 duplicate", d.status === "duplicate" && d.ok === true, d.status || d.error);
  ok("没有多写一次盘", s.writes === 0, s.writes);
}

// ------------------------------- 11 块锚点位置（首行；首行钉不住才退末行）
console.log("\n[11] 块锚点位置：写在 payload 指的那一行，且首行有锚点也算「同一段」");
{
  // 首行是标题（钉不住）→ 自动退末行，但正文与校验仍得一模一样。
  const text = "## 小标题\n正文一句";
  const s = store(SKELETON);
  const P = mkPayload(text);
  ok("退末行：anchorLine 指向最后一行", P.anchorLine === 1, P.anchorLine);
  const r = await run(P, s);
  ok("退末行：六项校验全绿", r.verify && r.verify.allOk === true, r.verify);
  ok("退末行：锚点落在末行末尾", r.after.split(NL).some((l) => l === "正文一句 ^" + P.id));
  {
    const ls = r.after.split(NL);
    const i2 = ls.findIndex((l) => l === "<!-- jc:begin id=" + P.id + " -->");
    const j2 = ls.findIndex((l, k) => k > i2 && l === "<!-- jc:end id=" + P.id + " -->");
    ok("退末行：剥掉锚点后 sha1 == id 里的 hash", sha1(stripAnchor(ls.slice(i2 + 2, j2 - 1).join(NL))) === P.id.slice(-4));
    ok("退末行：正文剥回原文", stripAnchor(ls.slice(i2 + 2, j2 - 1).join(NL)) === text);
  }

  // 首行钉不住、末行也不行（表格）→ 不钉，只把原因报出来；正文照写、校验照绿。
  const t2 = "| a | b |";
  const s2 = store(SKELETON);
  const P2 = mkPayload(t2, { anchor: "", anchorLine: -1 });
  const r2 = await run(P2, s2);
  ok("钉不了：正文照写、校验全绿", r2.verify && r2.verify.allOk === true, r2.verify);
  {
    const ls2 = r2.after.split(NL);
    const i3 = ls2.findIndex((l) => l === "<!-- jc:begin id=" + P2.id + " -->");
    const j3 = ls2.findIndex((l, k) => k > i3 && l === "<!-- jc:end id=" + P2.id + " -->");
    // 只看块内：派生层的索引行本来就带 [[#^id\|id]]，跟这里的「钉没钉」不是一回事。
    ok("钉不了：块内没有锚点", !ls2.slice(i3 + 2, j3 - 1).join(NL).includes("^"));
  }

  // 首行挂着块锚点的块，再捕一次也要认成 duplicate（剥锚点是逐行的，不是只剥尾巴）。
  const t3 = "第一句\n第二句";
  const id3 = "20260920-1037-" + sha1(t3);
  const anchored = t3.split(NL).map((l, k) => (k === 0 ? l + " ^" + id3 : l)).join(NL);
  const legacy = SKELETON.replace(
    "## " + SECTIONS.todo,
    "<!-- jc:begin id=" + id3 + " -->\n\n" + anchored + "\n\n<!-- jc:end id=" + id3 + " -->\n\n## " + SECTIONS.todo,
  );
  const s3 = store(legacy);
  const d3 = await run(mkPayload(t3), s3);
  ok("首行锚点的旧块 → duplicate", d3.status === "duplicate" && d3.ok === true, d3.status || d3.error);
  ok("首行锚点的旧块 → 没有多写一次盘", s3.writes === 0, s3.writes);
}

console.log("\n" + (failn === 0 ? "全部通过" : "有失败") + "：" + pass + " 通过 / " + failn + " 失败");
process.exit(failn === 0 ? 0 : 1);
