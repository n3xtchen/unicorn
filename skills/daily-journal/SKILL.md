---
name: daily-journal
description: Capture text verbatim into today's Obsidian daily journal (02-Done), then classify and link it in an agent-maintained derived layer. Use when the user asks to 记一下、记录一下、追加到今天的日记、capture/journal this, or hands over a thought to be kept for today.
---

# Daily Journal Capture

Append what the user gives you **verbatim** into today's daily note in the `nextlink` vault, then attach a classification and links in a separate, rebuildable derived layer.

Read [decision-log.md](references/decision-log.md) before changing this skill or when a write boundary is ambiguous.
分类是**库内实时标签**：词表 = 文档里维护的一二级骨架 ∪ 限定目录内实有的标签，**不由封闭配置文件决定**（封闭配置会过期）。`registry.json` 由 vault 里那份分类词表机械派生，现在产两样东西：**标签骨架**（分类用）与**拼写词表**（校对用）。vault/CLI 事实见 [vault-conventions.md](references/vault-conventions.md)。

## registry：按 vault 生成，缺失就自动重建

`registry.json` 曾经是封闭的分类词表；**现在分类改成多级标签，它改为产出「标签骨架 + 校对拼写词表」**。它描述的是**具体某个 vault 的笔记结构**，所以按 vault 各自生成，不随仓库分发。仓库里只有 [registry.template.json](references/registry.template.json)（结构模板）与 [taxonomy.template.md](references/taxonomy.template.md)（词表模板）。

**不要手抄生成命令**，也不要把命令丢给用户。脚本自己会重建：

| 情况 | 行为 |
| --- | --- |
| 找到实例 | 直接用 |
| 没找到实例 | 自动找到生成器并重建，然后在 stderr 报告一行 |
| `--rebuild-registry` | 无条件重建（词表改完后用这个） |
| 找不到生成器 / 找到多个 / 生成失败 | 退出码 3 + 原因，**不回退到空词表** |

落点优先级：

```text
--registry=<path>
  > $DJ_REGISTRY
  > <vault>/.daily-journal/registry.json     ← 默认落点
  > <vault>/registry.json
  > $XDG_STATE_HOME/daily-journal/<vault>.registry.json
  > <skill>/references/registry.json          ← 旧布局
```

生成器**随 skill 分发**（`<skill>/tools/build-registry.mjs`）—— 它跟脚本同版本、被 git 管着，所以 skill 是自包含的。查找顺序：`$DJ_REGISTRY_GENERATOR` > skill 自带的那份 > vault 内 `**/tools/build-registry.mjs`（上限 6 层，仅作兜底）。
若 vault 里还留着一份副本，**用 skill 自带的那份**，并在 stderr 提示副本已被忽略 —— 避免两份静默分叉。

生成器去 vault 里解析分类词表：先 `--taxonomy=<path>`，再看脚本旁边，最后在 `--vault-root` 下搜。文件名口径是 `分类词表.md`（旧名 `05-分类词表.md` 仍兼容，见脚本里的 `TAXONOMY_NAMES`），**整体**要求唯一 —— 新旧各留一份会报「发现多个」而不是随便挑。词表在库里就是一篇普通笔记，位置随意（实测落在 `997-conventions/`）。它逐条校验锚点路径真实存在，任一不存在即退出 1。vault 根一律向 Obsidian 索取（`app.vault.adapter.basePath`），不自行拼接 iCloud 路径。

**改校对词表或标签骨架**：改 vault 里的分类词表（唯一权威，现在在 `997-conventions/分类词表.md` —— 库级基础设施，不属于任何项目目录），然后 `--rebuild-registry`。
**只用库里已有的标签分类，不需要重建** —— 那部分是实时读的，改了标签立刻生效。

## Hard rules

1. **原文逐字不改（R3）.** Never paraphrase, fix typos, reorder, reformat, dedent, or "improve" the user's text. Copy it byte for byte, including `==highlights==`, tabs, and typos. No timestamp prefix.
2. **默认 dry-run（D3）.** Show the diff first. Only run with `--write` after the user confirms.
3. **不确定就问（D5）.** If the classification, the anchor, or the target note is uncertain, stop and ask. Never guess and never silently leave something `unsorted`.
4. **Never touch `### 关联笔记`** (the dataviewjs block), the tasks blocks, or any other note.
5. **No filesystem fallback.** If Obsidian is not running, stop and tell the user. Do not write the file directly — that would clobber unsaved editor content.
6. **校对是独立的一步（R3 的补充）.** 你只能在用户**明确确认后**，用脚本对原文做**机械替换**；绝不自己改写。原文层最终收到的，是用户批准的那个版本。详见第 2 步。
7. **关联列要填链接，但不硬凑（A1–A4）.** 原文里**实际点名**的实体，库里有对应笔记就链上（`--links`）；只有确实没有对应实体时才留 `—`。分类候选给的路径只是提示，不是填充项（词面命中 ≠ 实体关联）。目标必须真实存在 —— 脚本会拦（退出 7）。**不回溯**：只管新捕获与你点名要改的那条，历史条目一律不动。

## Workflow

All scripts are relative to this skill directory.

### 1. Take the text verbatim

Write the user's text to a temp file so newlines and tabs survive the trip through argv. Do not edit it.

```bash
cat > /tmp/dj-capture.txt <<'EOF'
<the user's text, exactly as given>
EOF
```

### 2. 校对用户输入（先查，再问）

动笔之前先机械地查一遍原文，把可疑处摆给用户看。这一步**只报告，不改写**，可以随便跑。

```bash
scripts/journal_apply.mjs --proofread --content-file=/tmp/dj-capture.txt
```

输出按严重度列出每条，并标出处置方式：`[建议直改]` / `[需确认]` / `[只能手改]`。

- **有发现** → 把清单原样念给用户，逐条问。不要自己决定。
- **没有发现** → 直接进入下一步。

用户确认后，用 `--fix` 让**脚本**做机械替换（不是你来改）：

```bash
--fix=safe        # 只做无损修正：行尾空白、重复虚词（的的）、大小写规范
--fix=all         # 连「改字」也算上（ascii-typo），必须先逐条得到同意
--fix=f2,f5       # 只套用指定条目
--fix=safe --skip=trailing-space   # --skip 可关掉某类检查
```

`--fix` 在写入时生效，结果里的 `fixReport` 会列出实际替换了什么。
**绝不要用 `--fix` 之外的任何方式改动原文** —— 你想「顺手润色」的那一下，正是 R3 要防的。
如果用户说「我自己改」，就等他把改好的版本给你，重新走第 1 步。

**检查项**：

| kind | 含义 | 处置 |
| --- | --- | --- |
| `empty` | 内容为空 | 阻断，先问 |
| `trailing-space` | 行尾空白 | 直改 |
| `repeat-char` | `的的`、`了了` 等虚词重复 | 直改 |
| `ascii-case` | 大小写与词表不一致（`Spark` → `spark`） | 直改 |
| `ascii-typo` | 疑似拼错的领域词（`sprak` → `spark`） | 需确认 |
| `wikilink-missing` | `[[目标]]` 在库中找不到 | 只能手改 |
| `wikilink-empty` | 真正的空链接 `[[]]` | 只能手改 |
| `highlight-unclosed` | `==` 个数为奇数 | 只能手改 |
| `fence-unclosed` | 代码围栏个数为奇数 | 只能手改 |

**两件事是故意不做的，因为实测不成立：**

- **中文别字检测**（`cjk-typo`）。用 155 个词表词做近似匹配，在全库 3.83M 字上给出 9567 条，其中 3070 个不同的「错字窗口」**没有一个**在语料里出现 0 次 —— `笔记整` 本来就是 `笔记整理` 的子串。没有分词器/词典就无法区分。
- **`[[` / `]]` 成对检查**。全库 111 处全是误报：`[[白话解析] Flink…](url)` 是 markdown 链接文本，`[1]]` 是 Python 代码。

宁可漏，不能错。一个 5‰ 密度的检查只会训练用户忽略它，而 `--fix=all` 会真的改坏文本。

`wikilink-missing` 按 Obsidian 的真实规则解析：全路径（带/不带 `.md`）、文件名、frontmatter `aliases`；且 `[[#标题]]`、`[[#^块]]` 是合法的同文档引用，不报警。链接内部的内容不参与拼写检查（否则 `[[02-Done/…]]` 里的 `Done` 会被当成大小写错误）。

### 3. Ensure today's note exists

```bash
scripts/journal_create.sh            # prints e.g. 02-Done/2026-09-38w-16.md
```

### 4. Classify（标签，实时词表）

分类是**真实的多级 Obsidian 标签**（`#work/sales`），裸写在「分类」列，不是 `<域>/<锚点>` 代码片段，也**不需要有对应的笔记文件存在**。

词表有**两个来源，合起来用**：

| 来源 | 内容 | 特点 |
| --- | --- | --- |
| 文档骨架 | 一级 9 个 + 二级 83 个 = 92 个 | 在 vault 的分类词表里维护（现于 `997-conventions/`），稳定可评审 |
| 实时库标签 | 限定目录内实有的标签 | 从 Obsidian 元数据缓存读，**不用维护、永不陈旧** |

```bash
# 看完整词表（骨架分组 + 库内实有）
scripts/journal_apply.mjs --tags

# 拿本次捕获的候选（标签名与锚点关键词都会命中）
scripts/journal_apply.mjs --classify --content-file=/tmp/dj-capture.txt --json
```

默认只扫这 5 个目录（`--scope=` 可覆盖）：

```text
00-InBox&FleetNote  02-Done  09-Note4LLM  10-GTD  11-Knowledge
```

自动剔除三类。这三条是**机械规则，不是要维护的配置**：

- `#gtd` / `#gtd/*` —— 任务状态（`next-action` / `wait-for` / `calendar`…），不是主题分类。你日记的 tasks 区里就有一堆。
- 纯数字标签 —— 来自 GitHub 链接标题（`· Issue #2672 ·`），Obsidian 会把它们当标签。
- 单字符标签 —— 代码/链接噪声（例 `#n` 来自 Jupyter 笔记里的 JSON）。

**候选为空是常态**：限定目录里的现成标签很少（实测 27 个）。标签可以**新建**，这正是标签相对「必须有对应文件」的好处。但按 D5：

- 有候选 → 把候选**连同样例路径**给用户，**不要静默挑一个**。
- 无候选 → 提 1–3 个建议标签（可复用现成的，也可新建），**问用户**。
- 实在定不了 → 用 `#unsorted` 占位（它就是骨架里的一级标签），并明确告诉用户。

候选里带的路径只是提示：它说明库里**可能**有对应笔记，要不要链取决于原文是否真的点名了那个实体（见硬规则 7）。

写盘时 `--category` 会做**机械校验**，不合法就退出 1，不写盘：

- 每个都必须是以 `#` 开头的合法标签，且不是上面剔除的三类。
- 命中骨架或库内实有 → 直接通过。
- **两者都不是 → 视为新建，必须带 `--allow-new-tag`**。这个旗标就是 D5 的机械闸门：脚本不替用户拍板，你也只能先问过用户才加它。

可以给多个：`--category='#work/sales #work/shops'`。
写进派生层的裸标签会在下一轮自动进入「实时」词表 —— 分类会自己长出来，不需要回头改文档。

### 5. Show the diff

```bash
scripts/journal_apply.mjs \
  --content-file=/tmp/dj-capture.txt \
  --category='#门店 #数仓' \
  --links='[[a]]、[[b]]'
```

`--links` 进派生层的关联列，写成原始 wikilink 文本，多个用 `、` 分隔。

原文里**实际点名**的实体，库里有笔记就链（见硬规则 7）：有几个填几个。没有对应实体就留 `—`，但不要为了不留空硬凑。

The command prints a unified diff and the `verify` object. **Check that all five flags are true**, especially `bodyExact` and `originalsPreserved`.

### 6. Write after confirmation

Re-run the same command with `--write`. Confirm the output says `status: written` and `readBackExact: true`.

### 7. Report back

Tell the user: the target path, the block `id`, the chosen tag(s), which candidate you picked (or that the tag is newly invented), and any candidate you had to break a tie between.

## Repeating

Each additional capture in the same conversation is a new block appended after the previous one, plus a new row in the derived index table. Re-running the exact same text is idempotent and reports `duplicate`.

## 事后修正：改已写入的原文

R3 说原文逐字不改。**唯一的例外是用户自己事后要求修正错字** —— 这不是放宽 R3，而是同一件事的另一面。三条约束一字不变：脚本机械执行、模型不产出最终文本、只动 `jc:begin`/`jc:end` 之间。

```bash
# 先 dry-run（默认），看清改前 / 改后
scripts/journal_apply.mjs --fix-written --id=20260916-1549-0882 --replace='便宜→漂移'

# 确认后落盘（自动备份到 .daily-journal/backup/）
scripts/journal_apply.mjs --fix-written --id=20260916-1549-0882 --replace='便宜→漂移' --write
```

**必须指定 `--id`。** 同一个词在不同块里含义可能不同：「便宜」在这一块是错字，在另一块「贪小便宜」是真词。无脑全库替换会改坏真词。

脚本做四件事，任何一件不过就不写：

1. **命中数校验** —— 报出每个对在该块内命中几次；
2. **反向回代守卫** —— 把改后正文反向换回来必须逐字节等于改前。右值在原文里本来就出现过时，替换会互相干扰，直接拒绝；
3. **块外不动** —— 把块内替换全部推回去后必须正好等于原文；
4. **id 重算** —— 正文变了 sha1 就变，id 必须跟着改（含索引行），否则「同内容 → 同 id」的幂等前提就断了。

**模型绝不可以自己改日记文件。** 哪怕只改一个字，也必须走这条路径；否则「原文逐字不改」就变成一句空话。

## 自检：块 id 是否仍与正文自洽

```bash
scripts/journal_apply.mjs --verify-ids          # 只报告，不一致退 1
scripts/journal_apply.mjs --verify-ids --write  # 把对不上的 id 重算回一致（正文不动）
```

`id = <YYYYMMDD>-<HHmm>-<sha1(正文) 前 4 位>`。等式断了就说明正文在写入后被改过，或者来自旧版脚本。这是「原文有没有被悄悄改过」最便宜的一条证据。

id 是 agent 生成的 opaque 锚点、不是用户写的话，所以重算它不触碰 R3 —— 但正文仍必须逐字节不变，脚本会自己验证。

## 迁移派生层的历史分类

早期版本把分类写成 `` `work/sales` ``（裹反引号），那不是标签，从来没进过图谱。**不要手改**，用迁移模式：

```bash
scripts/journal_apply.mjs --migrate-tags --map='life/HomeLab→life'         # dry-run
scripts/journal_apply.mjs --migrate-tags --map='life/HomeLab→life' --write
```

它只改派生层索引行的分类列（原文与关联列一个字节不动），且每个结果标签仍要过 `validateTags`；出现词表外的新标签会被拦下（D5）。混写的行（分类列里已经有裸标签）不会被碰。

## Other modes

```bash
# 列出词表（骨架 + 限定目录内实有），不写盘
scripts/journal_apply.mjs --tags --json

# 只对另外几个目录取词表
scripts/journal_apply.mjs --tags --scope='04-OnlyWork,08-Learning'

# 只校对，不写入；把发现当 JSON 拿来做后续处理
scripts/journal_apply.mjs --proofread --content-file=/tmp/dj-capture.txt --json

# List everything still parked at #unsorted in a date range
scripts/journal_apply.mjs --audit --from=2026-09-01 --to=2026-09-30 --json

# Locate today's note without creating it
scripts/journal_path.sh

# 校块 id 与正文是否自洽（只读，不一致退 1）
scripts/journal_apply.mjs --verify-ids

# 把派生层裘反引号的历史分类迁移成裸标签（dry-run）
scripts/journal_apply.mjs --migrate-tags --map='life/HomeLab→life'

# 事后改已写入的原文里的错字（dry-run）
scripts/journal_apply.mjs --fix-written --id=20260916-1549-0882 --replace='便宜→漂移'
```

## Failure modes

| Message | Meaning |
| --- | --- |
| `Obsidian 未运行` | Start Obsidian. Do not retry with a direct file write. |
| `section-missing` | The note lacks `## 今日的思考` or `### 关联笔记`. Look at the note with the user before doing anything. |
| `id-collision` | Same id, different text. Report both and ask; never overwrite. |
| `--category 不合法` | 不是合法标签，或是被剔除的 `#gtd/*` / 纯数字 / 单字符标签。先跑 `--tags` 与 `--classify`，不要臆造。 |
| `--category` 里有词表外的新标签 | 缺 `--allow-new-tag`。这是 D5 的机械闸门：**先问用户**，点头后再加旗标重跑。 |
| `pre-write-verify-failed` | A verbatim/idempotency check failed. Nothing was written. Report the failed flag. |
| `orphan-index-markers` | The derived-layer markers are half-present. Ask the user before repairing. |
| `readback-mismatch` | Something else wrote to the note concurrently. Stop and inspect. |
| `回代校验失败` | `--fix-written` 的右值在原文里本来就出现过，替换会互相干扰。换更长的上下文再试，不要用会撞车的对。 |
| `块外内容被牵连` | 脚本 bug，已中止未落盘。把现场给用户看，不要自己绕过去。 |
| `迁移后不合法` / `迁移后出现词表外的新标签` | `--migrate-tags` 会被拦下。用 `--map` 指定映射，或先问用户再 `--allow-new-tag`。 |
| `--fix-written 需要 --id` | 没给块 id。先 `grep -rn 'jc:begin id='` 找到它，**不要**改成全库替换。 |

## Fixing a wrong classification

Edit the 「分类」 column in the derived layer directly — it holds bare tag(s) (e.g. `#work/sales #门店`), **not** wrapped in backticks, otherwise Obsidian will not treat them as tags. It is agent-maintained and rebuildable; the original text and the marker blocks must stay untouched.

旧日记里可能还留着裹反引号的旧格式（`` `work/sales` ``），那不是标签，不会进图谱。**不要手改**，用 `--migrate-tags`（见上一节）。
