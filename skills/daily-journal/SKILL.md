---
name: daily-journal
description: Capture text verbatim into today's Obsidian daily journal (02-Done), then classify and link it in an agent-maintained derived layer; also captures tasks into a separate mutable 今日待办 layer, including todo candidates spotted inside a captured thought (written together with the capture by default, unless the user opts out). Use when the user asks to 记一下、记录一下、追加到今天的日记、capture/journal this, hands over a thought to be kept for today, asks to 记个待办、加个任务、提醒我做某事（task/todo capture）, or asks to 把待办挑出来、这段里有没有待办、提取待办（todo extraction）.
---

# Daily Journal Capture

Append what the user gives you **verbatim** into today's daily note in the configured vault (default `nextlink`; override with `$DJ_VAULT` or `--vault=`), then attach a classification and links in a separate, rebuildable layer.

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

1. **原文不得擅自改写（R3）.** Never paraphrase, reorder, reformat, dedent, or "improve" the user's text. 照抄时逐字节照抄，**包括** `==highlights==`、Tab 缩进、以及打错的字。没有时间戳前缀。
   R3 拦的是「擅自」—— 你自己动笔改就违反。两道**授权**改写也走脚本，不走你手写：`--fix-pair`（第 2 步查出、用户点头才改，是**闸门**）与 `--fix-written`（用户事后点名要改，是**例外**）。
   **R3 的射程是 `jc` 原文层**（D19）。`## 今日待办`（`jt` 区）是另一层、天然可变：勾选、改期、拖动、删除全归用户，不受 R3 与 `--fix-written` 的 `--id` 限制约束。原文层的内容仍逐字节来自用户；`jt` 层的任务行**允许改写原句**（删「要」、调语序），两档默认不同：**从捕获内容里顺手提出的待办默认直接写入**（第 7 步，除非用户说不写），**用户直接交办的待办与回溯提取仍要点到最终文字**。
2. **默认 dry-run（D3）.** Show the diff first. Only run with `--write` after the user confirms. dry-run 不落盘、也**不创建**当日笔记：笔记不存在时直接报 `note-not-found`（默认当日路径要建它得显式加 `--write`，或先跑 `scripts/journal_create.sh`；显式 `--path` 指向的文件脚本一律不建）。
3. **不确定就问（D5）.** 分类、链接、来源、落点**任何一环**拿不准，先问用户，再落盘。不猜、不静默降级、不自行决定。`#unsorted` 只是占位符、**不是终点**：落占位的同时必须列出候选并当场提问。除非用户明确要求「全自动、不要问我」，本条不可关闭。
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

### 2. 校对用户输入（两轮：脚本查格式，你查中文，合成一张清单）

动笔之前查两遍原文。这一步**只报告，不改写**，可以随便跑。

#### 第一轮 · 脚本查格式

```bash
scripts/journal_apply.mjs --proofread --content-file=/tmp/dj-capture.txt
```

输出按严重度列出每条，并标出处置方式：`[建议直改]` / `[需确认]` / `[只能手改]`。

#### 第二轮 · 你自己读一遍中文

脚本**查不出中文别字**：`cjk-typo` 因噪声太高已被实测否决，`ascii-typo` 只管英文词。
用户最容易犯的同音字（`便宜`/`漂移`、`系统出`/`系统里`）从原理上就抓不到 —— 这一轮只能你来。

读的时候只做一件事：**找出读不通的地方，给出「错→对」对和理由。**

```text
便宜   → 漂移    上下文在讲上下文压缩，「防止便宜」语义不通
系统出 → 系统里  「在 Mac 系统出设置 bypass」，介词位塌了
```

三条红线：

- **只给「对」，不给改后的整句。** 你一旦写出重写好的段落，就是 R3 要防的润色。
- **不动风格。** `的地得`、口语化写法、生造词、专有名词、中英混排一律不碰 —— 那是品味，不是错。
- **每对都要附理由**，用户才有得否决。报不准就别报：宁可漏，不能错。

把两轮结果**并成一张清单**念给用户，逐条问。不要自己决定。

- **有发现** → 逐条问，用户点头的才进下一步。
- **没有发现** → 直接进入下一步。

**落盘时按来源分两条通道，守卫一样**：

```bash
--fix=safe        # 脚本查出的无损项：行尾空白、重复虚词（的的）、大小写
--fix=all         # 连脚本查出的「改字」（ascii-typo）也算上，必须先逐条得到同意
--fix=f2,f5       # 只套用脚本查出的指定条目
--fix-pair='系统出→系统里,便宜→漂移'   # 你提的中文对
--fix=safe --skip=trailing-space      # --skip 可关掉某类检查
```

两条通道都要过**命中数验证 + 反向回代**。`--fix-pair` 里有一对没命中不是「跳过」，
而是**报错退出** —— 那说明你读错了原文，不能默默放过。`--fix-pair` 先于 `--fix` 执行，
因为它针对的是你读到的**原始文本**。

结果里的 `fixReport` / `pairReport` 会列出实际替换了什么。
**绝不要用这两条通道之外的任何方式改动原文** —— 你想「顺手润色」的那一下，正是 R3 要防的。
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

**两件事是脚本故意不做的，因为实测不成立：**

- **脚本里的中文别字检测**（`cjk-typo`）。识别这件事改由**模型**做（见上面的第二轮），脚本不碰 —— 但**脚本不碰的理由**必须记下来：用 155 个词表词做近似匹配，在全库 3.83M 字上给出 9567 条，其中 3070 个不同的「错字窗口」**没有一个**在语料里出现 0 次 —— `笔记整` 本来就是 `笔记整理` 的子串。没有分词器/词典就无法区分。
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

**候选为空是常态**：限定目录里的现成标签很少（2026-09-20 实测 40 个，随库内标签随时变动，以 `--tags` 现查为准）。标签可以**新建**，这正是标签相对「必须有对应文件」的好处。但按 D5：

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

`--links` 进派生层的关联列。四条硬约束都在写盘前机械拦下（dry-run 阶段就报，退出 7）：

- **必须是纯 wikilink 列表**，多个用 `、` 分隔。裸文字写不进去 —— 说明文字写到正文里。
- **目标是真实文件**：按 Obsidian 的解析规则（全路径带/不带 `.md`、文件名、frontmatter `aliases`）解析不到就退出 7。
- **单元格里的 `|` 要转义成 `\|`**（例 `--links='[[🎁\|礼物]]'`）。未转义的 `|` 会被 markdown 当成列分隔符，索引行从 4 列撑成 5 列、表格结构坏掉。
- **不能含换行** —— 关联列是单个表格单元格。

原文里**实际点名**的实体，库里有笔记就链（见硬规则 7）：有几个填几个。没有对应实体就留 `—`，但不要为了不留空硬凑。

The command prints a unified diff and the `verify` object. **Check that all six flags are true** —— `bodyExact` / `originalsPreserved` 管的是**内容守恒**，`blockInSection` 管的是**位置正确**（新块真的落在 `## 今日的思考` 里，D25）。

### 6. Write after confirmation

Re-run the same command with `--write`. Confirm the output says `status: written` and `readBackExact: true`.

### 7. Report back

Tell the user: the target path, the block `id`, the chosen tag(s), which candidate you picked (or that the tag is newly invented), and any candidate you had to break a tie between. If the captured text contained anything that looked like a todo, also 走「待办提取」那节 —— **默认与那段思考一起写进去**（`--kind=todo`），并**把写进去的行逐条列在回报里**，让他一眼能核、一行能删；只有用户明确说过不写时才跳过（跳过也要说明）。

## Repeating

Each additional capture in the same conversation is a new block appended after the previous one, plus a new row in the derived index table. Re-running the exact same text is idempotent and reports `duplicate`.

待办是另一回事：新行插在 `jt:end` 之前（区里已有的行不动），判重按**行**而不是按块。详见下一节。

## 待办捕获（`--kind=todo`）

用户说「记个待办」「提醒我明天交房租」时走这条通道：**只追加任务行，一个字节也不动 `jc` 原文层**。
第 3、4 步（建日记、分类）不适用 —— 待办不产生索引行，也不需要 `--category`。

```bash
cat > /tmp/dj-todo.txt <<'EOF'
- [ ] 交房租 #gtd/next-action 📅 2026-09-25
- [ ] 等快递 #gtd/wait-for
EOF

scripts/journal_apply.mjs --kind=todo --proofread --content-file=/tmp/dj-todo.txt   # 先校对
scripts/journal_apply.mjs --kind=todo --content-file=/tmp/dj-todo.txt               # dry-run
scripts/journal_apply.mjs --kind=todo --content-file=/tmp/dj-todo.txt --write       # 确认后落盘
```

`--kind` 缺省是 `thought`：不传时行为与改动前逐字节相同。

### 为什么是另一层（D19）

待办**不能**放进 `jc` 块：`id = sha1(正文)`，用户每勾一次 checkbox、每改一次期，正文就变，
`--verify-ids` 第二天就报一片不一致 —— 那份体检报告会立刻失去意义。
所以待办落在新的 `## 今日待办` 节（`jt` 标记对，**无 id**），三层变四层。

固定节序：**思考 → 待办 → 派生 → 关联**。待办节不存在时由 skill 建在派生层之前；
被用户拖到派生层之后时视为**不存在**（退回改动前的行为，不报错）。

### 用户交办的待办：逐条确认，不静默加工

（从**捕获内容里顺手提出的**待办是另一回事 —— 那一条默认直接写入，见「待办提取」那节。）

- 每行都要是**一行 checkbox**。用户给的是「明天交房租」这种口语，**你转成任务行之前要先给他看**，
  别默默把口语改成 `- [ ]`。这跟 R3 同一个立场：转换由你提出、用户点头。
- **日期一律绝对化**（D24）。`明天` / `下周三` / `三天后` 由脚本报 `task-date-relative` 并**阻断落盘**，
  你给出建议值（脚本按**笔记日期**推算，不是运行日），用户确认后用 `--fix-pair` 落地。
  对里的右值**要带够上下文**，否则句子会读不通：

  ```bash
  --fix-pair='明天去取车→2026-09-21 去取车'    # ✅ 句子还读得通（笔记日期 2026-09-20 时，明天 = 09-21）
  --fix-pair='明天→2026-09-21'                # ⚠️ 会变成「2026-09-21去取车」
  ```

- **`➕` 由脚本自动补**（默认开，`--no-task-add-created` 关），取的是**笔记日期**，不是运行日。
  补记昨天的日记时运行日是错的那一天，而错值的行仍然完全合法、待办通道那五项校验全绿 —— 没有任何机械守卫拦得住（D22）。
- **分类写在行内标签**里（如 `#family`），待办**不产生索引行**（D21），所以不用给 `--category`；
  也不要给 `--links`（脚本会拒）。`#gtd/next-action` / `#gtd/wait-for` 是**任务状态**、不是主题分类，两个词表分开。
- V1 **只落当天日记**，不路由到 `10-GTD/*`（D23）。

### 校对项（`--kind=todo` 专属）

这条通道**只跑**下面这一套。通用的散文检查在任务行上全是噪音：行内的 `#gtd/next-action` 会被当成英文词报 `ascii-case`。

| kind | 含义 | 处置 |
| --- | --- | --- |
| `task-no-checkbox` | 顶格行不是一行 checkbox | **阻断** |
| `task-status-unknown` | `- [?]` 不在四种状态符里 | **阻断** |
| `task-date-relative` | `明天` / `下周三` / `三天后` | **阻断**，确认后走 `--fix-pair` |
| `task-date-format` | `2026/9/25` | 直改（`--fix=safe`） |
| `task-field-order` | emoji 字段顺序乱 | 需确认 |
| `task-indent-mixed` | 同一块内 Tab 与空格混用 | 需确认 |
| `task-tag-unknown` | `#gtd/xxx` 不在库内状态集 | 需确认 |

**阻断项是硬闸**：`--write` 前脚本把 `--fix-pair` / `--fix` 都套完，再看一遍**真正要落盘的那份文本**，
还剩阻断项就不落盘（退出 1）。所以修正与写入可以同一条命令，也可以先修好再写。

### 幂等与重复

判重按**行**（rstrip 后全等，扫整个 `jt` 区），不靠 id：

- 整批都已在区里 → `status: duplicate`，退出 0，**文件字节不变**。
- 只有一部分重复 → 报 `task-line-duplicate`，退出 6，**不静默跳过重复行** ——
  否则用户以为三条都记上了，实际只落两条。

## 待办提取：从内容里挑待办

上面那节是**你直接把待办交给我**；这节是**内容里藏着待办，我挑出来**。两个触发，**默认不同**：

| 触发 | 默认 | 为什么不一样 |
| --- | --- | --- |
| **捕获思考时顺手扫一遍**（工作流第 7 步） | **直接写进去**，与那段思考同批落进 `jt` 层 | 用户 2026-09-21 定调：「写日志的时候，如果有待办，也一起写，除非我明确说不写」 |
| **回溯已有日记**（「把今天的待办挑出来」） | **只提案，不落盘** | 翻的是旧内容，改动面比当次捕获大；用户没点名要写就一个字不动 |

回溯触发读 `02-Done/` 里对应笔记即可（如 `obsidian vault=nextlink read path=...`），**只读不改**。

**捕获路径的唯一开关是用户的一句话。** 他说过「这次别记待办」「不用提取」，就跳过并回报一句「按你说的没提取待办」。
不新增旗标、不落配置 —— 这是**口径**，不是模式。

**同一批、同一轮确认。** D3 的 dry-run 与「用户点头」并没有被取消，取消的只是「为待办**单独**再等一轮」：
思考块与待办行可以一次看完（两条命令各出一份 diff），落盘也在同一次「写」里完成，
回报里把两边的结果一并列出。

### 提案长什么样（回溯那一档）

```text
刚记下的内容（原文已落入 20:00 块 `20260920-2000-a1b2`）：

> 明天要交房租，顺便把水电费也交了。另外别忘了周四前回复老王。

我看出 3 条可能的待办，请逐条判断：

| # | 建议的任务行 | 依据 | 需要你定的 |
| --- | --- | --- | --- |
| 1 | `- [ ] 交房租 #family 📅 2026-09-21` | 「明天」= 笔记日期 +1 | 日期对不对 |
| 2 | `- [ ] 交水电费` | 「顺便也交了」 | 算不算独立一条 |
| 3 | `- [ ] 回复老王 #work` | 「周四前」 | 哪个项目、要不要 due |
```

然后**停下来等**。用户回「1、3 要，日期都对，2 不要」之后，才用那几句话去跑 `--kind=todo`。
他没回，就只留原文 —— 这一档是只读的，没写任何东西。

（捕获那一档不走这张表：默认已经写完了，回报里给的是**已落盘的行**，不是待选项。）

### 提什么，不提什么

提：明确的**承诺或动作** —— 「要交房租」「回复老王」「记得带伞」。

不提：感慨、判断、方案、疑问（「我在想要不要换工作」「这个方案可能不太行」）。

**拿不准就不提，或者只问一句**（D5）。宁少勿多：把一句感慨提成待办比漏掉一条更难看，
而且用户还要花时间否掉它。

**默认写入不降门槛**：正因为捕获那一档没有「写前确认」这道人工闸，这里的「宁少勿多」是**唯一**的准入门槛，
一个字也不能松。漏一条待办用户下次提起来就行；多写一条感慨，用户得自己动手删。

一句话能拆出多条时，**默认拆开**并标出是你拆的 —— 用户合并比拆错容易。捕获那一档直接拆成多行写进去，回溯那一档拆成多行列进表里。

### 硬约束

- **原文一个字不动**（R3 / D19）。提取是在 `jt` 层新建行，不是在 `jc` 层编辑。
  原文里的「明天要交房租」原封不动留着，新行是另一条独立存在的描述。
- **允许改写原句来造任务行**（删「要」、调语序：「明天要交房租」→ `- [ ] 交房租 📅 2026-09-21`）。
  文字毕竟还是用户的，所以两档收口不同：**捕获路径**默认直接写，代价是回报时**逐条列出最终文字**；
  **回溯路径**仍要点到**最终文字**那一级再写。`jt` 层不受 R3 约束，写错一条也就是删一行。
- **日期仍然不猜**（D24）。`明天` / `下周三` / `三天后` 会被脚本报 `task-date-relative` 并**阻断落盘**，
  所以「默认写入」不会顺手把日期也替你定了 —— 遇到相对时间就**回来问一句**，给建议值并标出源词（「明天」= 笔记日期 +1），
  用户确认后走 `--fix-pair` 落地。
- **捕获路径里，日期这一步必然额外多一次往返**：闸门拦着，所以别把相对时间的行塞进 `--write` 硬撞，撞了就是退 1 不落盘。
- **提案里的行也要先过闸门**。提取出的行和直接给的待办走**同一条** `--kind=todo` 通道，
  同样过校对项与五项写入校验；不确定就先 dry-run 看一眼。

### 标出来源（可关）

提取出的待办默认带一个**别名块链接**，点一下跳回它来自哪句话。**位置在描述末尾、emoji 字段之前**：

```text
- [ ] 交房租 #family [[2026-09-38w-20#^20260920-2000-a1b2|↩]] ➕ 2026-09-20 📅 2026-09-21
```

三个部件各有理由：

- **别名 `|↩`**：渲染出来只是一个小箭头，但它是真链接、能点。不写别名，就是一长串 `2026-09-38w-20#^20260920-2000-a1b2` 摊在任务描述里。
- **带笔记名**，不是光写 `#^id`：`[[#^id]]` 是**同文档**引用，而来源块可能不在当天这篇里。
- **不能放注释里**：写在 `<!-- -->` 里的 `[[…]]` **不进链接表**（实测：同一篇里注释内、注释外各放一条指向同一个块锚点，metadata cache 只登记了外面那条）—— 不显形，也点不动。

链接的另一头是块的**尾部锚点**（`^<块 id>`），新捕获的块自动就有。

**位置为什么必须在这儿。** Tasks 的每个字段正则都**锚定行尾**（源码里 `Da()` 拼完符号就 `e += "$"`），
解析时**从右往左反复剥**（`extractField`：`line.match(regex)` → 命中就 `line.replace(regex,"")` → 再轮）。
所以行尾必须**正好**是一个字段，链接、注释、任何别的文字都只能挤在描述里。挂到行尾就全完：
`📅 …$` 匹配不上 → 一个字段也剥不下来 → `createdDate` 变 `null` →
这条待办**不会出现在「今日创建的任务」里**（`(created …)` 靠的就是它；日记标题里又没有日期，`heading includes` 也救不了）。

反方向也查过：链接里的 `#` 前面是文件名字符而不是空白，Obsidian 与脚本都不当标签；
脚本的 `wikilink-missing` 只拿 `#` 前的部分对词表，所以够得着、不误报。

> 同一个坑：行尾任何非字段文字都会让**全部**日期字段解析失败。
> 库里就有一条现存例子：`- [ ] fzy 和 fzf 的区别 ➕ 2026-06-25 】` —— 挂了个 `】`，`➕` 就不认了。

不想要这个链接就一句话去掉，不影响其他任何机制。

## 事后修正：改已写入的原文

R3 说原文不得擅自改写。**这里的例外是用户自己事后要求修正错字** —— 这不是放宽 R3，而是同一件事的另一面。三条约束一字不变：脚本机械执行、模型不产出最终文本、只动 `jc:begin`/`jc:end` 之间。

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
4. **id 重算** —— 正文变了 sha1 就变，id 必须跟着改（含索引行与块尾锚点），否则「同内容 → 同 id」的幂等前提就断了。

**模型绝不可以自己改日记文件。** 哪怕只改一个字，也必须走这条路径；否则「原文不得擅自改写」就变成一句空话。

**块外文本走 `--repair-text`。** `--fix-written` 只管 `jc:begin`/`jc:end` 之间的正文。派生区里、模板片段里、`## 今日待办` 里出现的**机械错字**（比如某次写入被 CLI 改坏了一个字），走同族的修复通道：

```bash
scripts/journal_apply.mjs --repair-text --path=02-Done/2026-09-38w-18.md --replace='设???脚本在库中的相对路径→设置脚本在库中的相对路径'
scripts/journal_apply.mjs --repair-text --path=… --replace='…→…' --write
```

七道闸，缺一条就一个字不写：只认 `--path` 指定的这一个文件；每对必须**恰好命中一次**（0 次或多次都拒，想限定就给更长的上下文）；命中落在任何 `jc` 块体内就拒，并叫你改用 `--fix-written`（那边有 id 一致性约束）；`--replace` 两边不许含换行；反向回代必须逐字节回到原文；命中处之外必须一个字节没变；缺省 dry-run。
同一层里换掉旧式来源标记（`<!-- from:2026… -->` → `[[笔记#^id|↩]]`）也走这条通道。

## 写入完整性：宁可不写，不可写坏

日记是本 skill 唯一不可重建的数据，**静默写坏是这里最坏的失败**。实测到一个真实的传输失真：`obsidian` CLI 解析 `code=` 入参时，约每 **8192 字节**会吃掉**多字节字符** —— 一个中文变成三个 U+FFFD，同一份载荷逐字节可复现；纯 ASCII 与几 KB 以内的短参数（`path=` 等）不受影响；回程（Obsidian → Node）测到几百 KB 中文无损。
脚本两道防：

1. **入参转纯 ASCII** —— 进 `code=` 之前把非 ASCII 全写成 `\uXXXX`（语义等价）。没有多字节序列，就没有可被切断的东西。
2. **载荷自带指纹** —— Node 算 `len` + 31 进制滚动和，Obsidian 收到后**落盘前先自查**，对不上就返回 `transport-corrupt`、**一个字都不写**；写后回读再自查一遍。

只比字符串是不够的：两边一起被改坏时字符串照样相等。校验和保证「永不静默写坏」，ASCII 转义保证「根本不发生」。
**每一条落盘路径都要过这道指纹自查**：六个改写通道（`--fix-written` / `--repair-text` / `--migrate-tags` / `--link-block-ids` / `--add-anchors` / `--verify-ids --write`）走 `writeNoteInObsidian()` 一处实现，捕获通道（思考 / 待办）在写盘前自查同一套 `len` + 滚动和 —— 没有哪条通道只剩字符串相等这一层。

改完脚本先跑**离线自检**（不碰库、不需要 Obsidian 在运行；假 `app` 替掉 Obsidian）：

```bash
node tools/payload-selftest.mjs    # 契约一改这里先红：锚点、幂等、撞 id、载荷指纹、ASCII 转义
```

它跟脚本同仓库同版本：这些路径都是「不报错、只是静默做错」，靠读代码看不出来，靠人手在真库里试又会写坏日记。

## 自检：块 id 是否仍与正文自洽

```bash
scripts/journal_apply.mjs --verify-ids          # 只报告，不一致退 1
scripts/journal_apply.mjs --verify-ids --write  # 把对不上的 id 重算回一致（正文不动，连带派生层索引行的链接）
```

`id = <YYYYMMDD>-<HHmm>-<sha1(正文) 前 4 位>`。等式断了就说明正文在写入后被改过，或者来自旧版脚本。这是「原文有没有被悄悄改过」最便宜的一条证据。

**块尾锚点。** 每块正文最后一行的末尾钉着一个空格加 `^<块 id>`，于是 `[[2026-09-38w-20#^20260920-1037-8dc5]]` 能直接跳到那段思考。

Obsidian 只给落在一段**真文本**里的锚点注册块 —— 整行只有 `^id`、或跟在别的字后面都行，**HTML 注释行不算**（实测：写在 `<!-- -->` 里的 `[[…]]` 不进链接表，点不动）。所以锚点不能挂在 `jc:end` 上，只能挤进正文最后一行。

**锚点不算正文。** 算 sha1、比对幂等之前一律先剥掉：不剥，锚点里的 id 会自指进 hash，而同一段思考第二次捕获也会被当成新块重复写。`--verify-ids` 因此报两件事 —— 正文 hash 对不对、锚点值是不是等于块 id；任一不对，`--write` 一起修回来（**四处**：`jc:begin` / `jc:end` / 尾部锚点 / 派生层索引行的块链接）。**旧块没有锚点照样通过**，脚本也不会借修 id 的机会替它补上。

id 是 agent 生成的 opaque 锚点、不是用户写的话，所以重算它不触碰 R3 —— 但正文仍必须逐字节不变，脚本会自己验证。

`--verify-ids --write` 与 `--fix-written` 换 id 时**只动索引行的那一格**（`remapIndexRowIds`，形态无关：反引号与块链接都认），
`## 今日待办` 里用户自己的 `` [[…#^id|↩]] `` 不被牵连 —— 那是另一层、另一件事（已知缺口：待办出处链接不会跟着重算，暂不自动改）。

## 迁移派生层的历史分类

早期版本把分类写成 `` `work/sales` ``（裹反引号），那不是标签，从来没进过图谱。**不要手改**，用迁移模式：

```bash
scripts/journal_apply.mjs --migrate-tags --map='life/HomeLab→life'         # dry-run
scripts/journal_apply.mjs --migrate-tags --map='life/HomeLab→life' --write
```

它只改派生层索引行的分类列（原文与关联列一个字节不动），且每个结果标签仍要过 `validateTags`；出现词表外的新标签会被拦下（D5）。混写的行（分类列里已经有裸标签）不会被碰。

## 迁移派生层的块 id 成块链接

派生层的「块 id」列写的是**可点的块链接**（D28）：

```markdown
| 时间 | 块 id | 分类 | 关联 |
| --- | --- | --- | --- |
| 10:25 | [[2026-09-38w-20#^20260920-1025-e95b\|20260920-1025-e95b]] | #family | — |
```

点一下直接跳回那段思考（别名就是 id 文本，不写别名 Obsidian 会渲染成「笔记名 > 块 id」，这一列被撑得很长）。
新捕获自动就是这个形态；**历史笔记里裹反引号的旧形态**（`` `20260920-1025-e95b` ``）用迁移模式补：

```bash
scripts/journal_apply.mjs --link-block-ids         # dry-run，列出会改哪几行、没动的为什么没动
scripts/journal_apply.mjs --link-block-ids --write
```

**三条约束**：只改索引行的 id 那一格（原文与其余三列一个字节不动）；块必须真在本文件里（找不到报 `block-missing`，不写）；
块必须**已经有尾部锚点** —— 没锚点链接就跳不过去。这里**不代劳补锚点**，只报 `anchor-missing`，叫你先跑 `--add-anchors`（两件事分开，各自可核）。

> 别名里的 `|` 必须逃成 `\|`，这跟关联列是同一条 markdown 规则。解析侧因此一律按**未转义的 `|`** 拆列
> （`splitUnescapedPipes`）。拿 `split("|")` 硬拆的坑实测过：块 id 列里一旦出现 `\|`，列序号整体后移，
> `--audit` 的 `cells[3]` 拿到的就不是分类列 —— 那些行被**悄悄丢掉**（不报错，只是结果少几行）。

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

# 给旧块补上尾部锚点（纯追加，让 [[笔记#^id]] 跳得回来；dry-run）
scripts/journal_apply.mjs --add-anchors

# 修 jc 块之外的机械错字（模板片段、派生区、待办行；dry-run）
scripts/journal_apply.mjs --repair-text --path=02-Done/2026-09-38w-18.md --replace='错字→正字'

# 把派生层裹反引号的历史分类迁移成裸标签（dry-run）
scripts/journal_apply.mjs --migrate-tags --map='life/HomeLab→life'

# 把派生层裹反引号的块 id 迁移成块链接（dry-run；块缺尾部锚点的先跑 --add-anchors）
scripts/journal_apply.mjs --link-block-ids

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
| `pre-write-verify-failed` | 六项校验有一项没过。什么都没写。报告具体是哪一项。`blockInSection` 失败 = 新块被拼到区外（D25）。 |
| `orphan-jt-markers` | `jt` 标记不是正好一对，或不在 `## 今日待办` 节内（比如待办节被拖到了派生层之后）。先看库内实际状态再问用户，不要自己补标记。 |
| `task-line-duplicate` | 待办行部分重复。**不静默跳过**，退 6，文件不变。把要落的那几条单独重跑。 |
| `--kind 只能是 thought 或 todo` | 旗标拼错了。检查 argv，**不要**改成默认值重跑 —— 那会把待办写进原文层。 |
| `待办捕获没通过校对` | 还剩阻断项（相对时间 / 错状态符 / 非任务行）。按提示修好再重跑，退 1，文件不变。 |
| `orphan-index-markers` | The derived-layer markers are half-present. Ask the user before repairing. |
| `index-markers-missing` | `jc:index` 标记整块缺失。不要自己补，先看库内实际状态再问用户。 |
| `note-not-found` | 当日笔记不存在。dry-run 只报不建；跑 `scripts/journal_create.sh`，或确认后加 `--write` 让捕获路径建它。显式 `--path` 指向的文件脚本不会建，加 `--write` 也不行。 |
| `file-missing` | 目标笔记在写入瞬间消失了。查 vault 状态后重跑，不要回退到文件系统写入。 |
| `--links 必须是纯 wikilink 列表` | 关联列只放链接。`问题：` 后面写明是「含换行」「\| 没有转义」「有裸文字」还是「一个 wikilink 都没有」（退出 7）。 |
| `--links 里有库里找不到的目标` | 链接指向不存在的笔记。去掉它，或先把对应笔记建好（退出 7）。 |
| `--fix-pair 没有命中` | 对里的左值在原文里找不到 —— 通常意味着模型读错了原文。核对后重来，不要默默放过。 |
| `readback-mismatch` | Something else wrote to the note concurrently. Stop and inspect. |
| `concurrent-edit` | 读盘到写盘之间 Obsidian 里改过这条笔记，已放弃落盘。重跑即可，不要强行覆盖。 |
| `obsidian CLI 超过 ... 无响应` | Obsidian 侧偶发无响应，本脚本按 `DJ_TIMEOUT_MS` 超时杀子进程（退出 4）。重跑通常即可；连续出现就重启 Obsidian。 |
| `obsidian CLI 子进程被 ... 终止` | **不是超时** —— 子进程被 SIGKILL/SIGTERM 杀掉，多为 Obsidian 崩溃或被系统回收内存（退出 4）。先重跑一次；反复出现请重启 Obsidian 并看崩溃报告，别说成「偶发抖动」。 |
| `--fix 指定的项不存在或不可机械修正` | `--fix=f1,f5` 里的 id 没落到实际替换（不存在，或该项 `autoFix: false`，如 `highlight-unclosed`）。看 `--proofread` 输出的可用 id 重选；`safe` / `all` 不受影响（退出 1）。 |
| `回代校验失败` | `--fix-written` 的右值在原文里本来就出现过，替换会互相干扰。换更长的上下文再试，不要用会撞车的对。 |
| `块外内容被牵连` | 脚本 bug，已中止未落盘。把现场给用户看，不要自己绕过去。 |
| `迁移后不合法` / `迁移后出现词表外的新标签` | `--migrate-tags` 会被拦下。用 `--map` 指定映射，或先问用户再 `--allow-new-tag`。 |
| `block-missing` | `--link-block-ids` 在**本文件里**没找到这个块 id。不猜、不跨文件补，报告给用户。 |
| `anchor-missing` | 块没有尾部锚点，链接跳不过去。先跑 `--add-anchors`，再重跑 `--link-block-ids`。 |
| `end 标记缺失` | 块的 `jc:end` 不见了（半个块）。先跑 `--verify-ids` 看清楚，不要拿迁移通道去修。 |
| `--fix-written 需要 --id` | 没给块 id。先 `grep -rn 'jc:begin id='` 找到它，**不要**改成全库替换。 |
| `transport-corrupt` | 待写内容在传进 Obsidian 的路上被改过，**一个字未写**。本脚本已转义送出，仍出现就升级 `obsidian` CLI，并把这条记进 decision-log。 |
| `命中落在 jc 块体内` | `--repair-text` 撞到了块内正文。改用 `--fix-written --id=<块 id>`，那边会连带重算 id。 |
| `命中 N 次，不止一处` | `--repair-text` 只修一处。把 `--replace` 的左边加长到全文件唯一。 |

## Fixing a wrong classification

Edit the 「分类」 column in the derived layer directly — it holds bare tag(s) (e.g. `#work/sales #门店`), **not** wrapped in backticks, otherwise Obsidian will not treat them as tags. It is agent-maintained and rebuildable; the original text and the marker blocks must stay untouched.

旧日记里可能还留着裹反引号的旧格式（`` `work/sales` ``），那不是标签，不会进图谱。**不要手改**，用 `--migrate-tags`（见上一节）。

「块 id」列同理：它是可点的块链接，**不要**改回裹反引号的旧形态；历史笔记里还留着的旧形态用 `--link-block-ids` 补。

## 维护本 skill：迭代工作区与上提（D27）

改本 skill 时，设计材料分两侧，**结论只有一份**：

| 位置 | 装什么 | 读它是为了 |
| --- | --- | --- |
| 本仓库（git） | 规格（本文件）、决策条文（`references/decision-log.md`）、库约定（`references/vault-conventions.md`）、`scripts/`、`tools/` | 「做」与「定」 |
| vault 迭代页 `09-Note4LLM/productivity/projects/<YYYYMMDD>-<主题>/` | 本轮的过程：现状核对、设计稿、否决理由、实测草稿、工程史与验收证据、开放项、指针 | 「信」（当时怎么试的、怎么验的） |

判据一句话：是「现在是什么」→ 仓库；是「为什么、怎么试的、还没定」→ vault。

**定稿即提（不攒批）。** 一条口径定稿就搬进仓库 —— 设计决策追加进 `decision-log.md` 的 D 系列（编号一次分配、**永不重排**；被替代的条目不删，写明它被谁替代），实现口径并进本文件或 `vault-conventions.md`；随即把 vault 侧那段的**结论正文删掉、压成一行指针**。过程叙事留 vault，结论不两边各存一份：两边同存正文必然分叉（vault 自称「唯一权威」、仓库头部又指回 vault 的那次互指，就是这么来的）。

**vault 不是 git 仓库**（误删只有 Obsidian File Recovery 一条路），所以不可重建的东西 —— 决策条文、验收证据 —— 一律留在仓库；vault 侧只放过程、指针与验收**结果**。

**新开一轮迭代**：在 vault 建 `projects/<YYYYMMDD>-<主题>/README.md` 当迭代页即可，仓库侧**零准备动作**（不建 CHANGELOG、不开分支）。迭代收口时把批次账写进 vault 的 release note；未完成的跨迭代项转进 `10-GTD/me.md`；仓库 `decision-log.md §遗留` 只留「已知缺口 + 重开条件」这类结论，不留行动项。
