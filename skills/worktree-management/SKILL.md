---
name: worktree-management
description: 安全管理 Git worktree、分支 fork 关系、下游 worktree、合并前检查与清理。用户要求列出、创建、合并、删除或清理 worktree，或 agent 请求创建新 worktree 时使用。
---

# Worktree 管理

## 核心默认规则

1. **清理 worktree 的默认范围**是“从当前分支 fork 出去的分支对应的 worktree”，不是仓库中的全部 worktree。
2. 除非用户明确指定其他范围，不得删除：
   - 其他项目或其他 parent 分支的 worktree；
   - 无法确认 fork 关系的 worktree；
   - 当前正在使用的 worktree。
3. Git 不会完整记录“某分支从哪个分支 fork”。必须使用分支 reflog、提交祖先关系、worktree 路径和分支命名等证据判断。证据不足时标记为“关系不确定”，交给用户决策，不得默认纳入清理。
4. agent 请求创建新的 worktree 时，必须先把请求转交用户确认；未获得明确确认前，不得调用创建 worktree 的工具或执行 `git worktree add`。
5. 合并、删除 worktree、删除分支是不同操作。合并不自动授权清理；清理也不自动授权删除分支。
6. 涉及丢弃未提交文件、未跟踪文件或未合并提交时，必须明确展示风险和精确路径，并获得用户确认。
7. 清理 worktree 时，默认同时盘点其关联的本地 branch，并把 branch 清理作为配套动作提出；删除 branch 必须取得针对精确 branch 名称的人工确认，不能从 worktree 删除授权中推断。

## 生命周期与确认边界

按以下顺序处理，不要把多个高风险动作合并成一次默认授权：

1. **只读盘点**：当前分支、所有 worktree、分支关系、agent 状态、各 worktree 是否干净。
2. **创建确认**：如果要创建新的 worktree，先询问用户。
3. **合并前检查**：确定目标分支和源分支，检查源分支的下游 worktree 是否已经合并。
4. **合并决策**：下游未合并时，报告建议并让用户决定先合并下游、保留它、还是放弃它；不得自行继续。
5. **合并授权**：合并动作需要用户明确授权，除非用户已经在同一条指令中明确指定了目标、源分支和合并方式。
6. **合并后清理确认**：如果要删除源分支对应的 worktree 或删除源分支，必须再次取得人工确认。尤其是“合并并清理”不得仅凭“合并”推断。
   - 用户可以对明确列出的 worktree 和 branch 一并确认；未列出的对象不在授权范围内。
7. **执行后复核**：验证合并结果、worktree 记录、分支引用和未触碰的其他 worktree。

当用户只说“清理一下”时，先按当前分支 fork 范围盘点并报告，不要直接对所有 worktree 执行删除。

本 skill 的设计决策和后续修正记录见 [references/decision-log.md](references/decision-log.md)。该文件记录 skill 为什么采用当前边界，不是每次运行时的操作审计日志。

## 一、列出当前分支 fork 出去的 worktree

### 1. 先获取当前上下文

```bash
git rev-parse --show-toplevel
git branch --show-current
git status --short --branch
git worktree list --porcelain
git branch --all --verbose --no-abbrev
```

如果当前处于 detached HEAD：

- 报告当前没有可作为“当前分支”的分支名；
- 可以按当前 HEAD 作为临时基准做只读分析；
- 不得默认进行 fork 范围清理，除非用户明确指定基准分支。

### 2. 建立 worktree 清单

解析 `git worktree list --porcelain`，为每个 worktree 记录：

- 绝对路径；
- HEAD SHA；
- 分支名，或 detached；
- 是否为当前 worktree；
- `git -C <path> status --porcelain=v1` 是否干净；
- 是否包含未跟踪文件；
- 是否有未提交提交（相对候选父分支）；
- 是否被锁定或路径已缺失。

每个 worktree 都要单独检查状态；不能只看 parent worktree 的 `git status`。

### 3. 判断“当前分支 fork 出去”的证据

设当前分支为 `CURRENT`，候选分支为 `CANDIDATE`。按证据强度从高到低判断：

#### 强证据

- `CANDIDATE` 的 reflog 含有类似 `branch: Created from CURRENT` 的创建记录；
- side-agent/agent 管理记录明确把 `CURRENT` 作为 parent/base；
- 当前分支的 HEAD 是候选分支的明确基点，且候选 worktree 是由本次 parent session 创建的。

#### 可接受的提交图证据

- `CURRENT` 的当前 HEAD 是 `CANDIDATE` 的祖先，且 `CANDIDATE` 在该 HEAD 之后有分叉提交；
- 或 `merge-base CURRENT CANDIDATE` 与已知 fork 点一致，并且 reflog、路径、分支名没有相互矛盾。

#### 不确定情况

- 只有很早的共同祖先；
- `CURRENT` 在候选分支创建后继续前进，无法从提交图恢复精确 fork 点；
- 候选分支来自其他 parent 分支但恰好共享祖先；
- 分支已删除但 worktree 仍处于 detached HEAD。

不确定的候选项必须单独列出并标记“需要用户确认”，不能放入默认删除集合。

### 4. 推荐报告格式

```text
当前分支：<CURRENT> @ <SHA>

确认属于当前分支 fork 的 worktree：
- <path> | <branch> | clean/dirty | ahead/behind 或 unique commits

关系不确定、默认不处理：
- <path> | <branch> | 原因

当前分支及其他 parent 分支的 worktree：
- <path> | <branch> | 不在本次默认范围
```

## 二、agent 请求创建新的 worktree

只要 agent 提出以下任意请求，都视为创建 worktree 请求：

- `git worktree add`；
- 创建新的 side-agent worktree；
- 为并行任务分配新的 checkout；
- 需要在另一个分支或目录中继续工作。

先向用户报告：

```text
Agent 请求创建新的 worktree：
- 用途：<task>
- 基于：<base branch/SHA>
- 新分支：<branch>
- 目录：<path>
- 是否会覆盖或复制文件：<yes/no>
- 清理计划：<说明>

是否允许创建？
```

只有用户明确确认后，才可以创建。确认只授权该次指定的 base、branch 和 path；如果 agent 改变其中任何一项，必须重新确认。

创建前检查：

- 目标路径不存在或为空；
- 分支名未被占用；
- 目标 worktree 不会使用当前已 checkout 的分支；
- bootstrap/setup 命令不会覆盖用户文件；
- parent worktree 没有因此被 reset、stash、clean 或 checkout 覆盖。

创建后立即记录：

- worktree path；
- branch；
- base SHA；
- 创建时间；
- 请求它的 agent/session；
- 用户授权范围。

## 三、合并分支前检查下游 worktree

场景：要把源分支 `SOURCE` 合并到目标分支 `TARGET`。

### 1. 先冻结合并意图

确认并报告：

```text
源分支：SOURCE @ <SHA>
目标分支：TARGET @ <SHA>
合并方式：<ff-only / --no-ff / 项目约定>
合并后是否计划删除 SOURCE worktree：是/否/未决定
```

未指定合并方式时，读取仓库约定；仍无法确定时先询问，不要自行选择 squash、rebase 或 force push。

### 2. 识别 SOURCE 的下游 worktree

对每个其他 worktree 分支 `DOWNSTREAM` 检查：

- reflog 是否显示从 `SOURCE` 创建；
- `SOURCE` 的 fork 点是否是 `DOWNSTREAM` 的基点；
- 当前提交图是否显示 `DOWNSTREAM` 包含 `SOURCE` 的提交，并在其上有自己的提交；
- 是否为 detached HEAD 或关系不确定。

使用只读命令辅助判断：

```bash
git merge-base SOURCE DOWNSTREAM
git merge-base --is-ancestor SOURCE DOWNSTREAM
git log --oneline --decorate SOURCE..DOWNSTREAM
git log --oneline --decorate TARGET..DOWNSTREAM
git reflog show --date=iso DOWNSTREAM
```

### 3. 判断是否已合并

对确认属于 SOURCE 下游的 `DOWNSTREAM`：

- 如果 `git log TARGET..DOWNSTREAM` 没有提交，说明 DOWNSTREAM 的有效提交已在 TARGET 中，视为已合并；
- 如果存在提交，说明 DOWNSTREAM 仍有未进入 TARGET 的提交，视为未合并；
- 如果关系或提交状态无法证明，标记为 unknown，不得当作已合并。

注意：`SOURCE` 是 `DOWNSTREAM` 的祖先，不等于 DOWNSTREAM 已经合并回 SOURCE 或 TARGET。必须检查 `TARGET..DOWNSTREAM` 的提交差异。

### 4. 未合并下游时给建议并停下

报告每个下游 worktree：

```text
下游 worktree：<path>
分支：<DOWNSTREAM>
未合并提交：<commit list>
状态：clean/dirty
建议：
1. 先将 DOWNSTREAM 合并或 rebase 到 SOURCE/TARGET，再合并 SOURCE；
2. 保留 DOWNSTREAM worktree，先合并 SOURCE，但不要删除 SOURCE 的 worktree/branch；
3. 明确放弃 DOWNSTREAM 的未合并提交后再清理。
```

然后让用户选择。不得因为用户说“合并 SOURCE”就默认放弃下游提交或删除其 worktree。

如果所有下游都确认已合并，报告：

```text
SOURCE 的确认下游 worktree 均已合并到 TARGET。
关系不确定项：<none 或列表>。
可以进入合并授权步骤。
```

关系不确定项存在时，必须先让用户决定是否把它们纳入检查范围或保留不动。

## 四、合并与清理

### 合并执行

只有在合并前检查完成并获得授权后执行。执行前再次确认：

- TARGET worktree 是干净的；
- SOURCE、TARGET 的 SHA 没有在盘点后变化；
- 没有其他进程正在使用目标 worktree；
- 不会覆盖 parent worktree 的用户改动。

禁止在 dirty worktree 中通过 stash、reset、checkout 或 clean 强行制造干净状态。应使用独立临时 worktree，或停下请求用户处理。

### 合并后复核

至少验证：

```bash
git merge-base --is-ancestor SOURCE TARGET
git log --oneline --decorate -n 10 TARGET
git status --short --branch
```

如果采用 fast-forward，确认 TARGET 指向预期 SHA；如果采用非 fast-forward，确认 merge commit 的两个 parent、提交信息和文件范围符合授权。

### 删除 source worktree

合并成功后，删除 SOURCE 对应 worktree 仍需人工确认。确认提示必须包含：

```text
SOURCE 已合并到 TARGET。
准备删除：
- worktree：<path>
- 分支：SOURCE
- 未提交修改：<summary>
- 未跟踪文件：<summary>
- 未合并提交：<summary>

删除 worktree 会丢弃其中未提交/未跟踪内容；是否确认删除 worktree？
```

- 干净 worktree 使用普通 `git worktree remove <path>`；
- dirty worktree 只有在用户明确确认放弃其中内容后，才可使用 `git worktree remove --force <path>`；
- 不得为了方便使用 `git clean -fd`、`rm -rf` 或 `git reset --hard`；
- 不得删除当前正在使用的 worktree。

### 删除 source branch

删除 branch 必须有独立且明确的人工确认。该确认可以和 worktree 删除在同一条用户回复中一并给出，但必须明确列出 branch 名称，不能从“删除 worktree”或“清理相关内容”推断：

```text
确认删除 worktree `<path>`，并同时删除本地分支 `SOURCE`。
```

如果用户只确认删除 worktree，仍需在 branch 删除前再次询问：

```text
worktree 已删除。是否同时删除本地分支 SOURCE？
```

- 默认使用 `git branch -d SOURCE`，让 Git 检查已合并状态；
- `git branch -D SOURCE` 只有在用户明确说放弃未合并提交并确认风险时才允许；
- 删除远程分支是独立操作，必须单独确认，不能由本地 branch 删除推断授权。

## 五、只清理当前分支 fork worktree

收到“清理 worktree”时按以下步骤：

1. 列出当前分支及所有 worktree；
2. 只筛选有充分证据从当前分支 fork 的 worktree；
3. 单独报告 dirty、未跟踪文件、未合并提交和关系不确定项；
4. 明确展示将要删除的精确路径，以及每个 worktree 对应的待清理本地 branch；
5. 先获得 worktree 删除确认；如果要同时删除 branch，确认内容必须明确列出 branch 名称，不能使用“相关分支”这类模糊表述；
6. 删除 worktree 后，只有在 branch 删除确认已覆盖对应 branch 时，才执行 branch 删除；默认使用 `git branch -d`；
7. 保留其他 parent 分支和关系不确定的 worktree 及 branch；
8. 执行 `git worktree prune` 前确认它只会清理已不存在的 worktree 元数据；
9. 复核 `git worktree list`、branch 引用和 parent worktree 状态。

推荐删除命令：

```bash
git worktree remove <exact-path>
```

只有用户明确授权丢弃 dirty 内容时才使用：

```bash
git worktree remove --force <exact-path>
```

不要使用宽泛的 glob、批量 `rm -rf` 或“删除所有 worktree”的脚本。

## 六、异常与安全处理

立即停止并报告以下情况：

- worktree 有未提交或未跟踪内容，但用户没有明确说要丢弃；
- worktree 中有只存在于该 worktree 分支的提交；
- agent 仍处于 running 或 waiting 状态；
- worktree 被锁定、路径不存在或 Git 元数据损坏；
- 当前分支是 detached HEAD 且用户没有指定基准；
- 分支关系无法从 reflog 和提交图可靠判断；
- 目标分支在盘点后发生漂移；
- 合并存在冲突，或合并方式不明确；
- 删除操作可能影响其他 parent 分支的 worktree。

处理 agent 生命周期时：

- `crashed` 或 `exitCode: 0` 表示 agent 进程结束，但不等于其工作已合并；
- 必须单独检查其 worktree 的文件和分支提交；
- 不要仅依据 tmux window 消失就删除 worktree；
- 不要仅依据 registry 中没有 agent 记录就认为没有待保留工作。

## 最终报告

每次操作后使用以下结构：

```text
已确认：
- 当前分支：<branch @ SHA>
- 处理范围：仅当前分支 fork worktree / 用户指定范围
- 操作：<列出/创建/合并/删除>
- 结果：<exact paths、branches、SHAs>

未处理或未知：
- <其他 parent 分支 worktree>
- <关系不确定项>
- <未合并提交或 dirty 内容>

仍需人工确认：
- <创建新 worktree / 合并 / 删除 worktree / 删除 branch / 删除 remote branch>
```

除非所有边界均已明确且用户完成了对应确认，不要使用“全部清理完成”这类含糊表述。
