---
name: daily-journal
description: Capture text verbatim into today's Obsidian daily journal (02-Done), then classify and link it in an agent-maintained derived layer. Use when the user asks to 记一下、记录一下、追加到今天的日记、capture/journal this, or hands over a thought to be kept for today.
---

# Daily Journal Capture

Append what the user gives you **verbatim** into today's daily note in the `nextlink` vault, then attach a classification and links in a separate, rebuildable derived layer.

Read [decision-log.md](references/decision-log.md) before changing this skill or when a write boundary is ambiguous.
Classification rules are generated into `registry.json`, which describes one concrete vault and is therefore generated **per vault**; vault/CLI facts in [vault-conventions.md](references/vault-conventions.md).

## registry：按 vault 生成，缺失就自动重建

`registry.json` 是 vault 内「分类词表」的**机械派生物**，描述的是**具体某个 vault 的笔记结构**，所以按 vault 各自生成，不随仓库分发。仓库里只有 [registry.template.json](references/registry.template.json)（结构模板）与 [taxonomy.template.md](references/taxonomy.template.md)（词表模板）。

**不要手抄生成命令**，也不要把命令丢给用户。脚本自己会重建：

| 情况 | 行为 |
| --- | --- |
| 找到实例 | 直接用 |
| 没找到实例 | 自动在 vault 内找到生成器并重建，然后在 stderr 报告一行 |
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

生成器不按项目路径硬编码，而是在 vault 内搜 `**/tools/build-registry.mjs`（与「分类词表」同目录，上限 6 层）。它逐条校验锚点路径真实存在，任一不存在即退出 1。vault 根一律向 Obsidian 索取（`app.vault.adapter.basePath`），不自行拼接 iCloud 路径。

**改分类规则**：改 vault 里的 `05-分类词表.md`（唯一权威），然后 `--rebuild-registry`。

## Hard rules

1. **原文逐字不改（R3）.** Never paraphrase, fix typos, reorder, reformat, dedent, or "improve" the user's text. Copy it byte for byte, including `==highlights==`, tabs, and typos. No timestamp prefix.
2. **默认 dry-run（D3）.** Show the diff first. Only run with `--write` after the user confirms.
3. **不确定就问（D5）.** If the classification, the anchor, or the target note is uncertain, stop and ask. Never guess and never silently leave something `unsorted`.
4. **Never touch `### 关联笔记`** (the dataviewjs block), the tasks blocks, or any other note.
5. **No filesystem fallback.** If Obsidian is not running, stop and tell the user. Do not write the file directly — that would clobber unsaved editor content.
6. **校对是独立的一步（R3 的补充）.** 你只能在用户**明确确认后**，用脚本对原文做**机械替换**；绝不自己改写。原文层最终收到的，是用户批准的那个版本。详见第 2 步。

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

### 4. Classify

```bash
scripts/journal_apply.mjs --classify --content-file=/tmp/dj-capture.txt --json
```

Output tells you the `category` (`<域>/<锚点>`), the `source` (`registry` / `basename` / `none`), and `candidates`.

- `needsUser: false` and a single candidate → proceed.
- `ambiguous: true` → **ask the user**, listing every candidate with its path. Do not pick silently.
- `source: "none"` → fall back to a domain leaf from `leavesByDomain` only if the domain is obvious from the user's words; otherwise ask. Use `unsorted/-` as a placeholder only while asking.

At write time `--category` is **validated mechanically**: the domain must be one of the nine, and the anchor must be a registry entry, a leaf of that domain, or an existing note basename. Anything else exits 1 without writing. **Never invent a classification.**

### 5. Show the diff

```bash
scripts/journal_apply.mjs \
  --content-file=/tmp/dj-capture.txt \
  --category=<域>/<锚点> \
  --links='[[a]]、[[b]]'
```

`--links` is optional; it goes in the derived layer's 关联 column (keep it as the raw wikilink text, separated by `、`). Omit for `—`.

The command prints a unified diff and the `verify` object. **Check that all five flags are true**, especially `bodyExact` and `originalsPreserved`.

### 6. Write after confirmation

Re-run the same command with `--write`. Confirm the output says `status: written` and `readBackExact: true`.

### 7. Report back

Tell the user: the target path, the block `id`, the chosen category, any candidates you had to break a tie between, and — if the category came from a domain leaf rather than a real note — suggest creating a note for it once that leaf has appeared three times.

## Repeating

Each additional capture in the same conversation is a new block appended after the previous one, plus a new row in the derived index table. Re-running the exact same text is idempotent and reports `duplicate`.

## Other modes

```bash
# 只校对，不写入；把发现当 JSON 拿来做后续处理
scripts/journal_apply.mjs --proofread --content-file=/tmp/dj-capture.txt --json

# List everything still parked at unsorted/- in a date range
scripts/journal_apply.mjs --audit --from=2026-09-01 --to=2026-09-30 --json

# Locate today's note without creating it
scripts/journal_path.sh
```

## Failure modes

| Message | Meaning |
| --- | --- |
| `Obsidian 未运行` | Start Obsidian. Do not retry with a direct file write. |
| `section-missing` | The note lacks `## 今日的思考` or `### 关联笔记`. Look at the note with the user before doing anything. |
| `id-collision` | Same id, different text. Report both and ask; never overwrite. |
| `--category 不合法` | 域不在 9 域闭集内，或锚点既不在注册表 / 域叶子，也不是库中已有笔记名。先跑 `--classify`，不要臆造。 |
| `pre-write-verify-failed` | A verbatim/idempotency check failed. Nothing was written. Report the failed flag. |
| `orphan-index-markers` | The derived-layer markers are half-present. Ask the user before repairing. |
| `readback-mismatch` | Something else wrote to the note concurrently. Stop and inspect. |

## Fixing a wrong classification

Edit the 「分类」 column in the derived layer directly. It is agent-maintained and rebuildable; the original text and the marker blocks must stay untouched.
