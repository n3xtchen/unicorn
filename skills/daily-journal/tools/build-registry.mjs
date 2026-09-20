#!/usr/bin/env node
// 从分类词表（vault 内的一篇笔记）生成 skill 运行时的 registry.json。
// 只解析 §六 种子注册表与 §五 叶子表（表格化，可机械提取）；§二 的「典型落点」列含自然语言描述，
// 因此以 DOMAIN_PATHS 常量维护 —— **仅用于校验文件夹真实存在、以及推导 9 个一级标签名，不参与判定**。
//
// 本文件随 skill 发布（<skill>/tools/），而「词表」是你 vault 里的一篇笔记 ——
// 两者不在同一棵树，所以词表路径是**解析出来的**，不绑在脚本旁边。
//
// 用法:
//   node build-registry.mjs --vault-root=<vault 绝对路径> [--out=<json 路径>] [--taxonomy=<词表路径>]
//
// 词表解析顺序：--taxonomy > 脚本旁边 > --vault-root 下搜（必须唯一）。
// 可接受的词表文件名见 TAXONOMY_NAMES —— 改名不会把生成器弄哑。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 可接受的词表文件名（按偏好顺序，第一个是当前口径）。改词表名字时**在 Obsidian 里重命名**，
// 它会自动修好全库的 [[...]] 链接；生成器这边靠这张表跟上，不必同步改代码。
// 2026-09-18：`05-` 前缀已去掉，旧名保留仅为兼容。
const TAXONOMY_NAMES = ["分类词表.md", "05-分类词表.md"];

// 词表不该长在仓库 / Obsidian 内部目录里，搜索时跳过。
const SKIP_DIRS = new Set([".git", ".obsidian", ".trash", ".daily-journal", "node_modules"]);

// §二 的「典型落点」（最长前缀优先，故顺序无关）。learn 的 09-Note4LLM/ 为兜底，故意最短。
// 注意：这张表**不参与分类判定**（T1 之后判定只有「标签名命中 / 关键词命中」两条）。
// 留在这里只为两件事：(1) 给出 9 个一级标签的名字；(2) 校验列出的文件夹真的存在。
const DOMAIN_PATHS = {
  work: ["04-OnlyWork/", "09-Note4LLM/work/", "09-Note4LLM/last_work/"],
  learn: ["08-Learning/", "101-LiteratureNote/", "102-PermanetNote/", "11-Knowledge/"],
  life: [
    "03-Life/",
    "09-Note4LLM/吃饭.md",
    "09-Note4LLM/健身.md",
    "09-Note4LLM/大脑.md",
    "09-Note4LLM/视频剪辑日记.md",
    "05-personal/健康.md",
    "05-personal/个人花费.md",
    "05-personal/汇款.md",
    "05-personal/人生规划.md",
    "05-personal/衣服尺寸.md",
    "05-personal/悦公馆物业费.md",
    "05-personal/借钱的注意点.md",
    "05-personal/个人身份证明和履历的管理.md",
    "05-personal/private/"
  ],
  family: [
    "09-Note4LLM/preg/",
    "10-GTD/family.md",
    "05-personal/重要日子.md",
    "05-personal/🐱.md",
    "05-personal/🎁.md",
    "05-personal/小雷.md",
    "05-personal/🐷/",
    "03-Life/AboutGirl.md"
  ],
  self: ["10-GTD/", "09-Note4LLM/obsidian.md", "09-Note4LLM/tidy-up/"],
  tool: ["09-Note4LLM/productivity/"],
  output: ["06-Blogs/", "07-Translation/"],
  idea: [],
  unsorted: []
};

// learn 的 09-Note4LLM/ 兜底必须能覆盖 09-Note4LLM/ 下未命中其他域者，但优先级低于上面所有
// 具体前缀（靠最长前缀比较自然实现），因此单独登记为 catchAll。
const CATCH_ALL = { learn: "09-Note4LLM/" };

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/s);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function parseRegistry(md) {
  const start = md.indexOf("## 六、");
  const end = md.indexOf("## 七、");
  if (start < 0 || end < 0) throw new Error("找不到 §六 / §七 边界");

  const section = md.slice(start, end);
  const anchors = [];
  let domain = null;

  for (const rawLine of section.split(/\r?\n/)) {
    const h = rawLine.match(/^###\s+(\S+)\s*$/);
    if (h) {
      domain = h[1].replace(/`/g, "").trim();
      continue;
    }
    const row = rawLine.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*(.*?)\s*\|\s*$/);
    if (!row) continue;
    if (!domain) throw new Error("锚点行出现在域标题之前: " + rawLine);
    const [, anchor, filePath, keywordsRaw] = row;
    const keywords = keywordsRaw
      .split(/[、,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    anchors.push({ anchor, path: filePath, domain, keywords });
  }
  return anchors;
}

function parseLeaves(md) {
  // 按章节号找边界，不绑死标题文字 —— 标题改过两次，绑文字就会静默断掉。
  const start = md.indexOf("## 五、");
  const end = md.indexOf("## 六、");
  if (start < 0 || end < 0) throw new Error("找不到 §五 / §六 边界");

  const leaves = {};
  for (const rawLine of md.slice(start, end).split(/\r?\n/)) {
    const row = rawLine.match(/^\|\s*`([^`]+)`\s*\|\s*(.*?)\s*\|\s*$/);
    if (!row) continue;
    const domain = row[1].trim();
    const rest = row[2].trim();
    // 「无」的三种写法都要当空处理 —— 否则会凭空造出 #idea/（无） 这种标签。
    leaves[domain] = ["（无）", "(无)", "-", "`-`", "—"].includes(rest)
      ? []
      : rest.split("/").map((s) => s.trim()).filter(Boolean);
  }
  return leaves;
}

// 按固定顺序解析词表路径。旧布局（生成器与词表同目录）仍被支持，因为那时
// PROJECT_DIR 下那份分类词表是唯一合理的位置；现在生成器随 skill 走，就得靠搜。
function resolveTaxonomy(vaultRoot, explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error("--taxonomy 指定的词表不存在: " + explicit);
    return explicit;
  }

  // 1) 脚本旁边（生成器被放在词表同目录时的旧布局）
  for (const name of TAXONOMY_NAMES) {
    const beside = path.join(path.dirname(HERE), name);
    if (fs.existsSync(beside)) return beside;
  }

  // 2) vault 内搜索。任何被接受的名字都算命中，**整体**要求唯一 ——
  //    若新旧名字各留一份，那是歧义，报错而不是挑一个。
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 6 || hits.length > 1) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length > 1) return;
      if (e.isFile() && TAXONOMY_NAMES.includes(e.name)) {
        hits.push(path.join(dir, e.name));
        continue;
      }
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  if (vaultRoot) walk(vaultRoot, 0);

  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new Error(
      "vault 内发现多个分类词表（" + TAXONOMY_NAMES.join(" / ") + "），无法确定用哪个：\n  " +
        hits.join("\n  ")
    );
  }
  throw new Error(
    "找不到分类词表（" + TAXONOMY_NAMES.join(" / ") + "）。\n" +
      "  用 --taxonomy=<绝对路径> 指定，或确认它在 --vault-root 之下。\n" +
      "  已查找: " + (vaultRoot || "(未提供 --vault-root)")
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const vaultRoot = args["vault-root"];
  if (!vaultRoot) throw new Error("缺少 --vault-root");
  const outPath = args.out || path.join(vaultRoot, ".daily-journal", "registry.json");

  const taxonomyPath = resolveTaxonomy(vaultRoot, args.taxonomy);
  const md = fs.readFileSync(taxonomyPath, "utf8");
  const anchors = parseRegistry(md);

  const errors = [];

  // 1. 唯一性
  const seen = new Map();
  for (const a of anchors) {
    const key = a.anchor;
    if (seen.has(key)) errors.push(`锚点重复: ${key} (${seen.get(key)} 与 ${a.path})`);
    seen.set(key, a.path);
  }

  // 2. 文件存在性
  for (const a of anchors) {
    const abs = path.join(vaultRoot, a.path);
    if (!fs.existsSync(abs)) errors.push(`路径不存在: ${a.anchor} -> ${a.path}`);
  }

  // 3. 域合法 + 锚点域与路径映射一致（允许注册表覆盖路径映射，只做提示）
  const domains = new Set(Object.keys(DOMAIN_PATHS));
  const overrides = [];
  for (const a of anchors) {
    if (!domains.has(a.domain)) errors.push(`非法域: ${a.domain} (${a.anchor})`);
    const byPath = resolveDomain(a.path);
    if (byPath !== a.domain) {
      overrides.push(`${a.anchor}: 注册表=${a.domain} 路径映射=${byPath || "(无)"} -> ${a.path}`);
    }
  }

  // 4. 域路径映射的路径存在性
  for (const [d, paths] of Object.entries(DOMAIN_PATHS)) {
    for (const p of paths) {
      if (!fs.existsSync(path.join(vaultRoot, p))) errors.push(`域路径不存在: ${d} -> ${p}`);
    }
  }
  for (const [d, p] of Object.entries(CATCH_ALL)) {
    if (!fs.existsSync(path.join(vaultRoot, p))) errors.push(`兜底路径不存在: ${d} -> ${p}`);
  }

  if (errors.length > 0) {
    console.error("校验失败:");
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }

  const leaves = parseLeaves(md);
  for (const d of Object.keys(DOMAIN_PATHS)) {
    if (!(d in leaves)) errors.push(`§五 缺少域叶子: ${d}`);
  }
  if (errors.length > 0) {
    console.error("校验失败:");
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }

  // ----------------------------------------------------------------
  // 多级标签骨架：一级 = 域（§二），二级 = 锚点（§六）/ 域叶子（§五）
  // 不引入任何新词，只是把已有的闭集换成标签写法，好让派生层写裸标签。
  // 锚点仍登记 path，但**不再要求文件必须存在才算合法**——
  // 它退化成「关联列的建议链接」（见 T1）。
  // ----------------------------------------------------------------
  const tagErrors = [];
  const domainList = Object.keys(DOMAIN_PATHS);
  const level1 = domainList.map((d) => "#" + d);
  const level2 = {};
  const tagPaths = {};
  const level2Seen = new Map();

  for (const d of domainList) {
    const anchorNames = anchors.filter((a) => a.domain === d).map((a) => a.anchor);
    const anchorSet = new Set(anchorNames);
    for (const l of leaves[d] || []) {
      if (anchorSet.has(l)) {
        tagErrors.push(`锚点与域叶子同名，会产出同一个标签: #${d}/${l}`);
      }
    }
    const set = new Set();
    for (const a of anchors.filter((x) => x.domain === d)) {
      const t = "#" + d + "/" + a.anchor;
      set.add(t);
      tagPaths[t] = a.path;
    }
    for (const l of leaves[d] || []) set.add("#" + d + "/" + l);
    level2[d] = Array.from(set).sort();
    for (const t of level2[d]) {
      if (level2Seen.has(t)) tagErrors.push(`二级标签重复: ${t}`);
      level2Seen.set(t, d);
    }
  }

  // 标签里不能有空白或 #（Obsidian 会在那里断开）
  const allTags = level1.concat(...domainList.map((d) => level2[d]));
  for (const t of allTags) {
    if (/[\s#]/.test(t.slice(1))) tagErrors.push(`标签含空白或 #: ${t}`);
    if (t.slice(1).length === 0) tagErrors.push(`空标签: ${t}`);
  }

  if (tagErrors.length > 0) {
    console.error("标签骨架校验失败:");
    for (const e of tagErrors) console.error("  - " + e);
    process.exit(1);
  }

  const registry = {
    version: 1,
    generatedFrom: path.basename(taxonomyPath),
    // 只输出脚本真正读的两个字段（tagSkeleton / anchors）。
    // domains / domainPaths / catchAll / whitelistRoots / leaves 曾经也写进来，
    // 但脚本一次都没读过（grep 计数均为 0），属于「生成了没人用」的死数据，2026-09-18 删除。
    // DOMAIN_PATHS / CATCH_ALL 常量仍留在本文件内，继续做上面的路径存在性校验。
    anchors,
    tagSkeleton: {
      level1: level1,
      level2: level2,
      all: allTags,
      paths: tagPaths
    }
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(registry, null, 2) + "\n");

  console.log(`锚点 ${anchors.length} 条，唯一 ${seen.size} 条`);
  console.log(`一级标签 ${domainList.length} 个`);
  console.log(
    `标签骨架: 一级 ${level1.length} 个，二级 ${allTags.length - level1.length} 个，合计 ${allTags.length} 个`
  );
  if (overrides.length > 0) {
    console.log(`注册表覆盖路径映射 ${overrides.length} 处:`);
    for (const o of overrides) console.log("  - " + o);
  }
  console.log("已写入 " + outPath + "（词表来自 " + taxonomyPath + "）");
}

// 按最长前缀解析域，供一致性检查使用
function resolveDomain(p) {
  let best = null;
  let bestLen = -1;
  for (const [d, paths] of Object.entries(DOMAIN_PATHS)) {
    for (const pre of paths) {
      if (p.startsWith(pre) && pre.length > bestLen) {
        best = d;
        bestLen = pre.length;
      }
    }
  }
  if (best) return best;
  for (const [d, pre] of Object.entries(CATCH_ALL)) {
    if (p.startsWith(pre)) return d;
  }
  return null;
}

main();
