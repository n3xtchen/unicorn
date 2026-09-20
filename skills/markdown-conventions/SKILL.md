---
name: markdown-conventions
description: 按用户既有的 markdownlint-cli2 配置写、改 Markdown 与 Obsidian 笔记，并在落笔后自检到 0 报错。覆盖标题层级、表格对齐、围栏语言、列表缩进、裸链接、内联 HTML、frontmatter、wikilink 与 mermaid 渲染校验。用户要求写或改 .md 文件、整理笔记、生成文档，或修 markdownlint 报错时使用。
---

# Markdown 规范：落笔就照做 + 落笔后自检

Read [rules.md](references/rules.md) for the per-rule detail (trigger → fix, with verified examples).
Read [decision-log.md](references/decision-log.md) before changing this skill or when a rule conflicts with the user's habit.

## 权威配置

不猜规则，以用户的实际配置为准：

| 项 | 值 |
| --- | --- |
| linter | `markdownlint-cli2` v0.22.1 / `markdownlint` v0.40.0 |
| 二进制 | `~/.local/share/nvim/mason/bin/markdownlint-cli2` |
| 配置 | `~/.config/nvim/markdownlint-cli2.yaml` |
| 配置要点 | `default: true`；`MD007.indent: 4`；`MD012: false`；`MD013: false` |
| 用户的 Neovim 格式化链 | `prettier` → `markdownlint-cli2 --fix` → `markdown-toc`（conform） |

`MD013`（行长度）和 `MD012`（连续空行）已关闭，**不要**为了 80 列去拆行。其余规则全部默认开启。

## 落笔就照做的 9 条

1. **表格不要手对齐。** 单元格一律写成 `| a | b |`（单空格），别用空格把竖线怼齐。手对齐的表格在后续编辑单元格时会与表头/分隔行错位，直接触发 MD060。
2. **标题层级不跳级**，且**结尾不带标点**。实测 `.` `,` `;` `:` `!` `。` `，` `；` `：` `！` 都会报 MD026（半角 `?` 例外，但不建议依赖）。
3. **同级标题不重名。** MD024 默认跨全文档检查，不同章节下的同名标题也会报。
4. **围栏必须带语言。** 普通文本用 ` ```text `，图用 ` ```mermaid `，日志用 ` ```log `，bash 用 ` ```bash `。
5. **加粗不能当标题。** 单独一行的 `**① chronos**` 触发 MD036，要写成 `#### ① chronos`。
6. **列表统一用 `-`**，子项缩进 **4 空格**（用户配置非默认值，2 空格会报 MD007）；列表前后各留一个空行（MD032）。
7. **标题前后（MD022）、围栏前后（MD031）都要留空行。**
8. **不要裸写 URL**，包成 `<https://...>` 或 `[文字](url)`（MD034）。**不要内联 HTML**，含表格里的 `<br>`（MD033）。
9. **一个标题只写一处**：frontmatter 的 `title:` 与正文 H1 不能同时存在（MD025；MD041 也认 frontmatter title）。默认保留 frontmatter `title`、不写 H1，详见 decision-log。

## 落笔后自检（必做）

写完或改完 .md 立刻跑一遍，**报告 0 error 才算完成**：

```bash
~/Dev/project_pig/unicorn/skills/markdown-conventions/scripts/mdlint.sh <file.md> [more.md ...]
~/Dev/project_pig/unicorn/skills/markdown-conventions/scripts/mdlint.sh --fix <file.md>   # 先试自动修
```

改动表格单元格之后尤其必须重跑：MD060 几乎都是"在已对齐的表格里手改了一个格子"造成的。

## 表格与 prettier 的配合

两种状态都是 clean 的，混用才是错：

| 状态 | 写法 | 说明 |
| --- | --- | --- |
| compact | `\| a \| b \|` | 手写推荐，编辑任意单元格都不会坏 |
| aligned | `\| a   \| b \|` + 分隔行等宽 | prettier 的产物，实测 lint 通过 |

关键结论（实测，勿凭直觉）：

- MD060 **不是**"禁止填充"，而是"同一张表内风格必须一致"。整表 compact、整表 aligned 都合法。
- prettier 对齐后的表格 lint 通过，**不会**重新引入 MD060；`<leader>cf` 是把表格修好的手段，不是弄坏的原因。
- `markdownlint-cli2 --fix` 对 MD060 **没有**修复器，`--fix` 不会动表格。

## Obsidian vault 体例

Vault 根：`<vault>` —— **不要写死绝对路径**。向 Obsidian 索取（`app.vault.adapter.basePath`），换台机器就不同。
技术文档放在 `09-Note4LLM/work/projects/<project>/`，同目录 `README.md` 维护文件索引。

- frontmatter：`id`（`YYYYMMDDHHmm`）/ `title` / `slug` / `created`（`2026-09-17 17:06`）
- 章节用编号：`## 1. 结论摘要`、`### 3.1 三个批次与归属`
- 引用沿用已有 S 编号体系，**一条一引**（文件 + 行号 + commit）
- 关联用 wikilink `[[文件名]]`
- 中文全角标点，代码标识符保留反引号

## mermaid 图

改完 mermaid 必须真渲染一次，语法错在 Obsidian 里只会显示成代码块：

```bash
cd /tmp && mkdir -p mmcheck && cd mmcheck
# 把 mermaid 块抽成 fig1.mmd 后用 npx -y @mermaid-js/mermaid-cli -i fig1.mmd -o fig1.png
```

渲染后读图目视检查：长虚线边容易拉出大片空白、跨画布连线，subgraph 标题容易被裁。

## 报错速查

| 报错 | 一句话改法 |
| --- | --- |
| MD060 table-column-style | 表格内风格不统一：整表改单空格，或跑 prettier 重排 |
| MD036 no-emphasis-as-heading | 单独一行的加粗改成 `####` 标题 |
| MD040 fenced-code-language | 围栏补语言，普通文本用 `text` |
| MD025 / MD041 | frontmatter `title` 与 H1 只留一处 |
| MD033 no-inline-html | 去掉内联 HTML（含 `<br>`），或用 `；`、拆行代替 |
| MD034 no-bare-urls | URL 包成 `<...>` |
| MD026 no-trailing-punctuation | 标题结尾删标点 |
| MD007 ul-indent | 无序列表子项缩进 4 空格 |
| MD022 / MD031 / MD032 | 标题、围栏、列表前后补空行 |
| MD024 no-duplicate-heading | 同名标题改写其中一个 |
| MD010 / MD009 | 删硬制表符、删行尾空格 |

## 范围

- **默认格式化（D6，2026-09-20 定）**：本次编辑只要落在某个 `.md` 上，就把它顺手修到**机械层 0 error**，不必先问。用户当轮明确说「别动格式 / 只加内容」时才跳过。
- **机械层 = 默认自动改**（不动语义）：行尾空白、硬制表符、列表缩进 4、列表标记 `-`、标题/围栏/列表前后空行、围栏语言、整表归一 compact。
- **内容层 = 仍按 D1/D2 不动，要改先问**：MD025/MD041 的 H1、MD033 的内联 HTML（含 `<br>`）、MD024 改标题名、MD026 删标题标点、MD029 重编号、MD034 包 URL。
- 范围只限**本次改动的文件**，不要顺手扩大到同目录或同 series 的其他文件（D4：本 skill 管格式与体例，不管结论、事实、术语）。
- 收尾必须报「改前 → 改后」的 error 数，并列出剩下哪几条、为什么留。
- 判断拿不准时先问，不要猜（这条优先于「默认自动」）。
