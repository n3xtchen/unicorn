# Skill 创建与迭代记录

本文档记录 `worktree-management` skill 的设计决策和需求修正，参考其他 skill 的 `references/decision-log.md` 结构。它用于维护 skill 本身的设计边界，不是每次执行 Git 操作时产生的运行时审计日志。

## 2026-09-01：初始目标

目标是提供一个安全的 Git worktree 管理流程，覆盖：

- 列出当前分支 fork 出去的 worktree；
- 清理当前分支派生的 worktree；
- 在 agent 请求创建新 worktree 时设置人工确认门；
- 分支合并前检查其下游 worktree 是否已经合并；
- 在合并、worktree 清理和分支删除之间建立独立的授权边界。

## 设计决策一：清理默认只针对当前分支派生的 worktree

“清理 worktree”不能解释为删除仓库中的全部 worktree。默认范围固定为：

```text
当前分支 -> fork 出去的分支 -> 这些分支对应的 worktree
```

其他 parent 分支的 worktree、其他项目的 worktree、当前 worktree，以及无法确认 fork 关系的 worktree，默认不处理。

如果用户明确指定了更大范围，仍需先列出扩大后的精确路径和风险，再执行清理。

## 设计决策二：Git fork 关系采用证据优先、无法确认则停止

Git 提交图不总能精确恢复分支的 fork 来源，尤其是 parent 分支在 fork 后继续前进时。因此判断 fork 关系时结合：

- 分支 reflog 中的创建记录；
- side-agent 或 parent session 的创建记录；
- `merge-base` 和祖先关系；
- worktree 路径和分支命名；
- 提交差异和当前 worktree 状态。

只有证据充分的候选项才进入默认范围。关系不确定时必须单独报告并等待用户决策，不能为了批量清理而猜测。

## 设计决策三：agent 创建新 worktree 必须经过人工确认

agent 请求新 worktree 不等于获得创建授权。创建前必须向用户展示：

- 任务用途；
- base 分支和 SHA；
- 新分支名；
- 目标目录；
- 是否可能覆盖或复制文件；
- 后续清理计划。

用户确认只授权该次明确的 base、branch 和 path。任一项变化，都需要重新确认。

## 设计决策四：合并前先检查 source 分支的下游 worktree

在将 `SOURCE` 合并到 `TARGET` 前，必须检查从 `SOURCE` 派生的下游 worktree：

- 下游 worktree 是否还有 dirty 或未跟踪内容；
- 下游分支是否存在只在自身分支上的提交；
- 这些提交是否已经进入 `TARGET`；
- fork 关系是否确定。

若存在未合并下游，skill 只提供建议，不自动替用户选择：

1. 先把下游合并或 rebase 到 `SOURCE` / `TARGET`；
2. 先合并 `SOURCE`，但保留下游 worktree；
3. 明确放弃下游提交后再清理。

必须由用户选择后才能继续。

## 设计决策五：合并授权不包含清理授权

以下动作严格分开：

```text
合并 SOURCE -> TARGET
删除 SOURCE worktree
删除 SOURCE 本地分支
删除 SOURCE 远程分支
```

即使合并成功，也必须再次人工确认是否删除 source worktree。删除 worktree 后，还要单独确认是否删除 branch。删除远程分支是另一项独立操作。

删除 dirty worktree 可能丢弃未提交和未跟踪内容，只有用户明确确认放弃后才能使用强制删除。

## 设计决策六：默认 fail-closed，不使用宽泛破坏性命令

skill 不默认使用：

- `rm -rf`；
- `git clean -fd`；
- `git reset --hard`；
- stash 覆盖用户改动；
- 面向全部 worktree 的批量删除脚本；
- `git branch -D` 删除仍有未合并提交的分支。

优先使用普通的 `git worktree remove <exact-path>`。只有在用户明确确认丢弃内容时，才允许使用 `--force`。

## 设计决策七：运行时决策日志与 skill 设计日志分离

本次需求中的 decision log 是 skill 的设计记录，应放在：

```text
~/Dev/project_pig/unicorn/skills/worktree-management/references/decision-log.md
```

它记录目标、设计修正和固定边界，供后续维护 skill 时参考。不会要求每次 worktree 操作都在仓库中创建 `.pi/.../decision-log.md`，避免把 skill 设计文档和项目运行时状态混在一起。

## 设计决策八：清理 worktree 时同时处理关联 branch，但 branch 删除必须人工确认

清理 worktree 时，不只删除目录和 Git worktree 元数据，还要盘点该 worktree 对应的本地 branch，并将 branch 是否一并清理明确列出。

但以下授权仍然分开：

```text
删除 worktree：确认删除指定目录
删除 local branch：确认删除指定 branch
删除 remote branch：再次单独确认
```

用户可以在同一次回复中对明确列出的 worktree 和 local branch 一并授权；不能用“清理相关内容”或“删除 worktree”推断 branch 删除授权。关系不确定或存在未合并提交的 branch 默认保留。

## 当前固定边界

- 默认清理范围：当前分支 fork 出去的 worktree 及其关联 local branch 候选；
- 新 worktree 创建：必须人工确认；
- 合并前：必须检查下游 worktree；
- 下游未合并：先报告建议，由用户决策；
- 合并后：source worktree 清理必须人工确认；
- 清理 worktree 时盘点关联 branch，但 local branch 删除必须人工确认；
- source branch 删除、remote branch 删除分别确认；
- fork 关系不确定、agent 未结束、worktree dirty 或存在未保留提交时，默认停止。
