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

const SECTIONS = { thinking: "今日的思考", todo: "今日待办", derived: "今日分类与关联", related: "关联笔记" };
const NL = "\n";
const sha1 = (s) => crypto.createHash("sha1").update(s, "utf8").digest("hex").slice(0, 4);
const stripAnchor = (s) => s.replace(/ \^[A-Za-z0-9._-]+$/, "");
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
console.log("\n[1] 捕获：正文末尾钉锚点");
const TEXT = "今天把日记脚本的块锚点补上了。\n\n结论是锚点只能挤在正文里。";
{
  const s = store(SKELETON);
  const P = mkPayload(TEXT);
  const r = await run(P, s);
  ok("六项校验全绿", r.verify && r.verify.allOk === true, r.verify);
  ok("正文一字未动（bodyExact）", r.verify.bodyExact === true);
  ok("锚点是纯追加", r.after.includes(TEXT + " ^" + P.id), r.after.split(NL).filter((l) => l.includes("^")).join("|"));
  ok("锚点落在正文最后一行（不另起行）", r.after.split(NL).some((l) => l === "结论是锚点只能挤在正文里。 ^" + P.id));
  ok("锚点 = 块 id", r.id === P.id);
  ok("dry-run 没写盘", s.writes === 0);

  // 拿写出来的样子自己验一遍：剥掉锚点后 sha1 必须等于 id 里的 hash
  const lines = r.after.split(NL);
  const i = lines.findIndex((l) => l === "<!-- jc:begin id=" + P.id + " -->");
  const j = lines.findIndex((l, k) => k > i && l === "<!-- jc:end id=" + P.id + " -->");
  const body = lines.slice(i + 2, j - 1).join(NL);
  ok("剥锚点后 sha1(正文) == id 里的 hash", sha1(stripAnchor(body)) === P.id.slice(-4), { got: sha1(stripAnchor(body)), want: P.id.slice(-4) });
  ok("锚点行 = 最后一行正文", j - 2 === lines.findIndex((l) => l.endsWith(" ^" + P.id)));
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

console.log("\n" + (failn === 0 ? "全部通过" : "有失败") + "：" + pass + " 通过 / " + failn + " 失败");
process.exit(failn === 0 ? 0 : 1);
