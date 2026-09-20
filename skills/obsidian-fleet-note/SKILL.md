---
name: obsidian-fleet-note
description: Create and organize standalone FleetNote capture notes in the user's Obsidian inbox. Use when the user asks to record, capture,整理、沉淀或引用网页、Git 项目、本地文档等内容为一篇独立笔记。
---

# Obsidian FleetNote

Read [the decision log](references/decision-log.md) when changing this skill or when a capture workflow boundary is ambiguous.

Create one self-contained note for one captured topic. A note may synthesize multiple heterogeneous sources. Keep the workflow lightweight and never modify other notes.

## Destination

Write notes only to:

```text
<vault>/00-InBox&FleetNote/
```

Do not move, rename, reorganize, or edit any existing note unless the user explicitly asks.

## Filename

Use:

```text
{YYYYMMDDHHmm}-{english-topic}.md
```

Example:

```text
202311150859-preserve-original-error-context.md
```

Rules:

- Generate the timestamp at note creation time.
- Use a concise lowercase English `kebab-case` slug, normally 3–8 words.
- Use no spaces or non-English characters in the slug.
- Never overwrite an existing file. If a collision occurs, make the slug more specific or ask the user.

## Note Structure

Frontmatter contains note metadata only. Never put sources or quotations in frontmatter.

```markdown
---
id: "{YYYYMMDDHHmm}"
title: "{中文标题}"
slug: "{english-topic}"
created: "{YYYY-MM-DD HH:mm}"
---

# {中文标题}

## 内容

整理后的最终内容。需要指出依据时使用【S1】【S2】。

## 对齐记录

仅在记录过程中出现实质歧义、纠正或约定变化时添加；否则省略。

## 引用

按来源添加引用块。

## 思路

记录自己的理解、判断、疑问、联想和可能的后续行动。

## 关联

- [[相关笔记]]
```

Omit `## 对齐记录` when there was no meaningful ambiguity or correction. Omit `## 关联` when there is no meaningful relation. Links are outbound links in the new note only; never add backlinks by editing target notes.

## Writing Rules

- Write the note body and human-readable title in Chinese unless the user requests otherwise.
- `## 内容` is a clear synthesis, not a raw dump.
- Keep direct quotations verbatim and visibly quoted.
- Clearly distinguish quotations, paraphrases, and the user's own thinking.
- Do not fabricate a source, author, date, commit, path, line range, quotation, related note, session path, session entry ID, or JSONL line number.
- Preserve uncertainty. If important information is unavailable, ask briefly or mark it as `待补充` when immediate capture is preferred.
- A note may have any number and combination of source types.
- Make `## 内容` reflect the final aligned understanding, not superseded interpretations.

## Alignment and Corrections

Treat the visible discussion from the capture request until note creation as one alignment process. Before writing, check for explicit corrections, competing interpretations, changed constraints, and unresolved disagreements.

Add `## 对齐记录` only when the discussion materially affected what should be recorded. Do not record minor wording changes or routine clarification. Summarize the evolution instead of copying the whole conversation.

Use this format:

```markdown
## 对齐记录

### A1 · {歧义主题}

- 歧义点：
- 原理解（用户或 AI）：
- 修正或补充（用户或 AI）：
- 最终约定：
- 对笔记的影响：
```

Rules:

- Preserve who corrected or supplemented whom, using neutral language.
- Record only visible user and assistant statements; never infer or expose hidden reasoning.
- When the user corrects the assistant, use the user's correction in the final content.
- When the assistant proposes a correction, record it as accepted only if the user confirms it or the visible discussion clearly adopts it.
- If disagreement remains unresolved, write `最终约定：未决` and keep the alternatives instead of choosing one.
- Keep exact supporting dialogue in `## 引用` as a conversation source when it is useful; `## 对齐记录` contains the concise change history.
- Whenever a prompt or visible session reply is quoted, attach its persisted session file path, entry ID, and exact physical JSONL line number.
- Finish alignment before creating the file whenever possible.
- If the user immediately corrects a just-created current note, revise only that note and append or update its `## 对齐记录`. Never modify any other note. Ask which note to update if the target is unclear.

## Citations

Assign source IDs in order: `S1`, `S2`, `S3`, and so on. Cite them in `## 内容` as `【S1】`. Put all source metadata and excerpts in `## 引用`, not frontmatter.

### Prompt or session conversation source

When quoting a user prompt or a visible assistant reply, use one citation block per session message:

```markdown
### S1 · Prompt

- Session：`/absolute/path/to/session.jsonl`
- Session ID：`session-uuid`
- 消息 ID：`8-char-entry-id`
- 行号：`L72`
- 角色：`user`
- 时间：`YYYY-MM-DDTHH:mm:ss.sssZ`

> 引用的 prompt 原文。
```

Session files are JSONL files under `~/.pi/agent/sessions/--<cwd>--/`. Determine the citation location from the persisted file rather than from the displayed message count:

1. Identify and verify the exact current session file. Do not assume that the newest file is correct without matching the quoted text and session header `cwd`.
2. Parse the JSONL file one physical line at a time, using 1-based line numbers.
3. Match an entry with `type: "message"`, the correct `message.role`, and the quoted text in `message.content`.
4. Record the absolute file path, header session ID, message entry ID, physical line as `L<number>`, role, and timestamp.
5. Verify the quote is present in that exact entry. Embedded newlines escaped inside one JSON object still belong to one physical JSONL line.

For several quoted prompts, create separate source IDs so each quote has an unambiguous entry ID and line number. For a visible assistant reply, change the heading to `Session 回复` and set `角色：assistant`. Never cite hidden thinking blocks. If the session is ephemeral, unavailable, or not yet persisted, write `Session：未保存` and `行号：不适用` instead of guessing.

### Web source

```markdown
### S1 · 网页

- 标题：[网页标题](https://example.com/article)
- 位置：章节 > 子章节
- 访问时间：YYYY-MM-DD

> 与当前笔记直接相关的原文。
```

Record the page title, URL, exact heading or anchor, access date, and relevant excerpt. Add author or publication date only when useful and known.

### Git source

````markdown
### S2 · Git

- 仓库：[org/repo](https://github.com/org/repo)
- Commit：`commit-sha`
- 文件：`path/to/file`
- 位置：`symbol()`，第 20～45 行
- 固定链接：[file#L20-L45](https://github.com/org/repo/blob/commit-sha/path/to/file#L20-L45)

```text
相关代码或配置摘录。
```
````

Prefer an immutable commit SHA and a permalink pinned to that commit. Do not cite only a moving branch such as `main` when a commit can be identified. For uncommitted code, write `Commit：working-tree` with capture time and include the necessary excerpt.

### Local document

```markdown
### S3 · 本地文档

- 文档：文档名称
- 路径：`/path/to/document.pdf`
- 位置：第 3 章，p. 18

> 与当前笔记直接相关的原文。
```

Use an Obsidian link such as `[[附件/document.pdf]]` when the file is inside the vault; otherwise use its path. Record a section, page, heading, or other precise locator.

### Other source

For books, videos, podcasts, conversations, meetings, or personal observations, keep the same block pattern:

```markdown
### S4 · 来源类型

- 名称：
- 位置：章节、页码、时间点或场景
- 日期：YYYY-MM-DD

> 原文、原话，或明确标记为转述的内容。
```

## Creation Workflow

1. Understand the topic and identify supplied sources.
2. Resolve material ambiguities and track accepted corrections from the visible discussion.
3. When quoting prompts or visible replies, locate and verify their persisted session entries and 1-based physical JSONL line numbers.
4. Generate the current 12-digit timestamp and an English kebab-case slug.
5. Check that the destination filename does not already exist.
6. Organize the final understanding into `内容`, optional `对齐记录`, `引用`, and `思路`.
7. Add only meaningful outbound links under `关联`.
8. Create exactly one new Markdown file in the destination directory.
9. Verify the filename, frontmatter timestamp, source IDs, alignment entries, session paths, entry IDs, and JSONL line numbers are consistent.
10. Report the created file path and briefly mention unresolved or `待补充` information.

If the user asks only for a draft or template, return it without creating a file.
