# 规则明细（实测）

全部结论来自在本机用用户配置实跑：

```bash
~/.local/share/nvim/mason/bin/markdownlint-cli2 \
  --config ~/.config/nvim/markdownlint-cli2.yaml <file>
```

版本：markdownlint-cli2 v0.22.1 / markdownlint v0.40.0。

## 已关闭的规则（不要反向"修"它）

| 规则 | 状态 | 含义 |
| --- | --- | --- |
| MD013 line-length | off | 长行合法，**不要**为了 80 列拆行或拆表 |
| MD012 no-multiple-blanks | off | 连续空行合法 |

## 已开启且最容易踩的规则

| 规则 | 触发条件（实测） | 改法 |
| --- | --- | --- |
| MD060 table-column-style | 同一张表内风格不统一：表头/分隔行定了风格，正文行的竖线或填充不匹配 | 整表 compact 或整表 aligned；改过单元格后跑 prettier |
| MD036 no-emphasis-as-heading | 单独一行 `**文字**`（整行只有加粗，无其他内容） | 改成 `#### 文字` |
| MD040 fenced-code-language | ` ``` ` 后不带语言 | 补 `text` / `mermaid` / `bash` / `log` |
| MD033 no-inline-html | 任何内联 HTML，**包括表格单元格里的 `<br>`** | 去掉；中文用 `；` 或直接拆成两行 |
| MD034 no-bare-urls | 正文裸写 `https://...` | `<https://...>` 或 `[文字](url)` |
| MD026 no-trailing-punctuation | 标题结尾是 `.` `,` `;` `:` `!` `。` `，` `；` `：` `！` | 删掉标点。实测半角 `?` **不**触发 |
| MD024 no-duplicate-heading | 同名标题，默认跨全文档（不只是同级兄弟） | 改写其中一个标题 |
| MD007 ul-indent | 无序列表子项缩进不是 4 空格（用户配置 4，默认值是 2） | 子项前补到 4 空格 |
| MD004 ul-style | 无序列表标记混用（`-` / `*` / `+`） | 统一 `-` |
| MD022 blanks-around-headings | 标题上下没有空行 | 上下各留一个空行 |
| MD031 blanks-around-fences | 围栏上下没有空行 | 上下各留一个空行 |
| MD032 blanks-around-lists | 列表上下没有空行 | 上下各留一个空行 |
| MD001 heading-increment | 跳级，例如 `##` 后直接 `####` | 逐级递减 |
| MD003 heading-style | setext 式标题（`===` / `---` 下划线） | 一律用 ATX `#` |
| MD010 no-hard-tabs | 行内有制表符 | 换成空格 |
| MD009 no-trailing-spaces | 行尾空格（恰好 2 个是合法硬换行） | 删干净 |
| MD049 emphasis-style | `_斜体_` 与 `*斜体*` 混用 | 全篇统一一种 |
| MD035 hr-style | `***` / `---` / `___` 混用 | 全篇统一一种 |

## MD025 / MD041 与 frontmatter 的关系（重点）

markdownlint 默认把 frontmatter 的 `title:` 当作文档标题（`front_matter_title`，默认匹配 `^\s*title\s*[:=]`）。由此产生两个连带效果：

- **MD025**：frontmatter `title` + 正文 `# H1` = 两个顶级标题 → 报错。
- **MD041**：文档**没有** H1 时，只要 frontmatter 有 `title`，就不报 MD041。

实测：

```markdown
---
title: probe
---

# H1          <- MD025 Multiple top-level headings [Context: "H1"]
```

```markdown
---
title: 咖啡冲煮参数记录
---

## 1. 结论摘要   <- 无 H1，0 error
```

## 表格的两种合法状态（MD060）

### compact（手写推荐）

```markdown
| 名词 | 指哪一段 | 含义 |
| --- | --- | --- |
| **锚点** | 词表§3 | 分类的二级取值，指向一篇真实笔记 |
```

空表头单元格写成 `| |`（单空格），不要写成 `|  |` —— 后者报 MD060 "extra space to the right/left"。

### aligned（prettier 产物，合法）

```markdown
| 场景                     | 行为                | 对外信号         |
| ------------------------ | ------------------- | ---------------- |
| 捕获内容缺少明确归属对象 | 回退到 `unsorted/-` | **有**：当场提问 |
```

### 报错长什么样

在 aligned 表里手改一个格子（不重新对齐）：

```text
doc.md:444:41 error MD060/table-column-style Table column style
  [Table pipe does not align with header for style "aligned"]
```

整表填充风格不一致时：

```text
doc.md:443:38 error MD060/table-column-style Table column style
  [Table pipe has extra space to the left for style "compact"]
```

两种消息都指向同一个原因：**同一张表里混了两种风格**。`markdownlint-cli2 --fix` 不修 MD060。

## 复现脚本

```bash
# 用 prettier 重排表格（产物 lint-clean）
npx -y prettier@3 --write <file.md>
# 只补指定规则（不能修 MD060 / MD036 / MD040）
~/Dev/project_pig/unicorn/skills/markdown-conventions/scripts/mdlint.sh --fix <file.md>
```
