#!/usr/bin/env bash
# daily-journal · 确保当日日记存在
#
# 用法: journal_create.sh [vault]
# 输出: 日记在库内的相对路径
# 行为: 调用 obsidian daily:read —— 文件缺失时由 Obsidian 按 .obsidian/daily-notes.json
#       套用 998-template/journal 模板并解析 {{date:...}}；已存在时仅读取，不修改内容。
#       创建后用 eval 在 Obsidian 进程内确认文件确实存在。
# 退出: 0 成功 / 2 Obsidian 未运行 / 3 CLI 调用失败 / 4 创建后未找到文件 / 127 找不到 CLI
#
# 注意：所有变量展开一律写 ${VAR} 带花括号。本文件含全角标点，
# 若写成 $VAR） 这类紧邻多字节字符的形式，bash 会把后续字节并入变量名。

set -euo pipefail

VAULT="${1:-${DJ_VAULT:-nextlink}}"
OBSIDIAN_BIN="${DJ_OBSIDIAN_BIN:-obsidian}"
OBSIDIAN_PROC_RE="${DJ_OBSIDIAN_PROC_RE:-MacOS/Obsidian$}"

if ! command -v "${OBSIDIAN_BIN}" >/dev/null 2>&1; then
  echo "daily-journal: 找不到 obsidian CLI（${OBSIDIAN_BIN}）" >&2
  exit 127
fi

if ! pgrep -f "${OBSIDIAN_PROC_RE}" >/dev/null 2>&1; then
  echo "daily-journal: Obsidian 未运行。请先启动 Obsidian 再重试。" >&2
  echo "daily-journal: 本 skill 不回退到文件系统写入，以免覆盖 Obsidian 的未保存缓冲区。" >&2
  exit 2
fi

if ! "${OBSIDIAN_BIN}" "vault=${VAULT}" daily:read >/dev/null 2>&1; then
  echo "daily-journal: daily:read 失败，无法创建或读取当日日记。" >&2
  exit 3
fi

path="$("${OBSIDIAN_BIN}" "vault=${VAULT}" daily:path 2>&1)"
path="${path#=> }"
path="$(printf '%s' "${path}" | tr -d '\r' | head -n 1)"

if [ -z "${path}" ]; then
  echo "daily-journal: daily:path 返回空路径" >&2
  exit 3
fi

# 路径含单引号会破坏下面的 JS 字面量，直接拒绝（Obsidian 日记路径不会出现）
case "${path}" in
  *"'"*)
    echo "daily-journal: 日记路径含单引号，拒绝内联到 eval: ${path}" >&2
    exit 4
    ;;
esac

verify="$("${OBSIDIAN_BIN}" "vault=${VAULT}" eval \
  code="(async () => { const f = app.vault.getAbstractFileByPath('${path}'); return JSON.stringify({ exists: !!f }); })()" 2>&1)" || {
  echo "daily-journal: 存在性校验调用失败: ${verify}" >&2
  exit 4
}

case "${verify}" in
  *'"exists":true'*) : ;;
  *)
    echo "daily-journal: daily:read 之后仍找不到 ${path}" >&2
    exit 4
    ;;
esac

printf '%s\n' "${path}"
