#!/usr/bin/env bash
# daily-journal · 定位当日日记
#
# 用法: journal_path.sh [vault]
# 输出: 日记在库内的相对路径，例如 02-Done/2026-09-38w-16.md
# 行为: 只定位，不创建、不读取、不修改任何文件。
# 退出: 0 成功 / 2 Obsidian 未运行 / 3 CLI 调用失败 / 127 找不到 CLI
#
# 路径与命名由 .obsidian/daily-notes.json 决定
#   folder   = 02-Done
#   template = 998-template/journal
#   format   = YYYY-MM-WW\w-DD   （等价 shell: date "+%G-%Vw-%d"）
# 本脚本不自行拼接路径，一律以 Obsidian 的返回为准。
#
# 注意：所有变量展开一律写 ${VAR} 带花括号。本文件含全角标点，
# 若写成 $VAR） 这类紧邻多字节字符的形式，bash 会把后续字节并入变量名。

set -euo pipefail

VAULT="${1:-nextlink}"
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

out="$("${OBSIDIAN_BIN}" "vault=${VAULT}" daily:path 2>&1)" || {
  echo "daily-journal: daily:path 调用失败: ${out}" >&2
  exit 3
}

path="${out#=> }"
path="$(printf '%s' "${path}" | tr -d '\r' | head -n 1)"

if [ -z "${path}" ]; then
  echo "daily-journal: daily:path 返回空路径" >&2
  exit 3
fi

printf '%s\n' "${path}"
