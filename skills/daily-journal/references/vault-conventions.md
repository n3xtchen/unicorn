# 库约定与 CLI 实测行为

本文件记录实现所依赖的**已实测**事实。改动脚本前先读这里，避免重新踩坑。

## 库

| 项 | 值 |
| --- | --- |
| vault 名 | `nextlink` |
| vault 根 | `/Users/nextchen/Library/Mobile Documents/iCloud~md~obsidian/Documents/nextlink` |
| CLI | `/opt/homebrew/bin/obsidian` |
| 目录 | iCloud 同步目录，文件名与内容含中文与 emoji |

## 日记命名（来源：`.obsidian/daily-notes.json`）

```json
{ "folder": "02-Done", "template": "998-template/journal", "format": "YYYY-MM-WW\\w-DD" }
```

- `format` 等价 shell `date "+%G-%Vw-%d"` → 例如 `2026-09-38w-16.md`（ISO 年-月-第38周-日）。
- 路径**一律向 Obsidian 索取**（`daily:path`），不自行拼接。

## 日记模板结构

`998-template/journal` 的区块顺序：

```text
![[IMPORTANT]]
## 马上要完成的          <- tasks 查询块
## 今天要完成的          <- tasks 查询块
## 今日完成的任务        <- tasks 查询块 ×2
## 今日创建的任务        <- tasks 查询块
## 今日的思考            <- L0 原文层（只追加）
   (5 个空行)
### 关联笔记            <- dataviewjs，加载 Scripts/x.js，targetHeading = YYYY-MM-DD
```

`Scripts/x.js` 扫描 `09-Note4LLM/` 下标题**恰好等于** `YYYY-MM-DD` 的笔记。因此「关联笔记」是库内既有机制，**本 skill 永不触碰**。

## 三层结构

| 层 | 位置 | 谁维护 | 规则 |
| --- | --- | --- | --- |
| L0 原文层 | `## 今日的思考` 内、标记块中 | 用户 | **只追加，逐字不改** |
| L1/L2 派生层 | `## 今日分类与关联` | skill | 可重建、可手改 |
| 关联层 | `### 关联笔记` (dataviewjs) | 库既有机制 | 永不触碰 |

派生层位置：`## 今日的思考` 之后、`### 关联笔记` 之前。派生层不存在时由 skill 创建。

## 标记块协议

```markdown
<!-- jc:begin id=20260916-1547-8c95 -->

<用户原文，逐字节>

<!-- jc:end id=20260916-1547-8c95 -->
```

- `id = <YYYYMMDD>-<HHmm>-<sha1(原文) 前 4 位 hex>`。id 里的时间用**紧凑形式** `1547`（id 是不透明标记，不带冒号）。
- 派生层「时间」列用 **`HH:MM`**（如 `15:47`），与 id 的紧凑形式不同（见 [[02-设计与写入协议]] 落盘示例）。
- 幂等靠**逐块比对原文内容**（按行 rstrip 后整体 trim 后比较），不靠整文件字节。
- `id` 撞车且内容不同 → 报 `id-collision` 并中止，绝不覆盖。

派生索引表：

```markdown
## 今日分类与关联

<!-- jc:index:begin -->
| 时间 | 块 id | 分类 | 关联 |
|---|---|---|---|
| 15:47 | `20260916-1547-8c95` | #learn/spark | [[<关联笔记>]]、[[<另一篇>]] |
<!-- jc:index:end -->
```

新行插在 `jc:index:end` 之前（按时间升序累积）。「关联」为空写 `—`。
**孤儿 index 标记**（只有 begin 或只有 end）→ 报 `orphan-index-markers` 中止。

## 写入闸门

`app.vault.process()` 落盘前必须先通过五项校验，任一不通过即中止、不写：

| 校验 | 含义 |
| --- | --- |
| `marksBalanced` | `jc:begin` 数 == `jc:end` 数 |
| `oneBlockAdded` | 恰好新增 1 个块 |
| `hasNewBlock` | 新 id 的 begin 标记在结果中 |
| `bodyExact` | **原文以完整字符串出现在结果中**（R3 逐字不改） |
| `originalsPreserved` | 写入前的每一行，都是写入后行序列的子序列（不删行、不换序） |

落盘后再 `app.vault.read()` 回读，必须与预期结果字节一致（`readBackExact`）。

## CLI 实测行为（重要）

`obsidian` CLI 通过 IPC 与运行中的 Obsidian 通信。

| 事实 | 说明 |
| --- | --- |
| 必须 Obsidian 在运行 | CLI 依赖 IPC；未运行时**中止**，不回退到文件系统 |
| 主进程检测 | `pgrep -f "MacOS/Obsidian$"` —— 精确匹配主进程，排除 helper |
| `eval code=<js>` | 输出前缀为 `=>` 加一个空格；**不支持顶层 `return`**，必须包在 async IIFE 里 |
| `eval` 可用 API | `app.vault.getAbstractFileByPath` / `read` / `process` / `getMarkdownFiles`、`app.workspace.*` |
| `daily:path` | 只返回路径，不创建文件 |
| `daily:read` | **会创建**缺失的日记（套模板、解析 `{{date:...}}`）；输出**多加一个尾换行**，不是字节精确读 |
| `daily:append` | **禁用** —— 会追加到 dataviewjs 之后 |
| `code=` 不转义 `\n` | 传参时必须给真实换行 |
| 参数传递 | Node 侧用 `execFileSync(bin, [args])` 数组传参，绕开 shell 引号问题 |

## 未保存缓冲区（实测）

用户在 Obsidian 里打开当日日记且**有未保存编辑**时执行写入：

- 实测结果：`app.vault.process()` 在**活动缓冲区**上操作，未保存的编辑被保留并合并落盘，**没有被覆盖**。
- 因此**不得**用 plain filesystem 写入代替（那才会丢用户编辑）。

## shell 陷阱

脚本含全角标点。变量展开必须写 `${VAR}`：写成 `$VAR）` 时 bash 会把多字节字节并入变量名（实测报 `OBSIDIAN_BIN?: 未绑定的变量`）。
