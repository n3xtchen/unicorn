#!/usr/bin/env bash
# daily-journal · 确保当日日记存在
#
# 用法: journal_create.sh [vault]
# 输出: 日记在库内的相对路径
# 行为: 调用 obsidian daily:read —— 文件缺失时由 Obsidian 按 .obsidian/daily-notes.json
#       套用 998-template/journal 模板并解析 {{date:...}}；已存在时仅读取，不修改内容。
#       创建后用 eval 在 Obsidian 进程内确认文件确实存在。
# 退出: 0 成功 / 2 Obsidian 未运行 / 3 CLI 调用失败 / 4 创建后未找到文件 / 5 CLI 超时无响应 / 127 找不到 CLI
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

# obsidian CLI 偶发无响应。macOS 没有 coreutils 的 timeout，这里用后台进程 + 轮询兜底，
# 阈值与 journal_apply.mjs 同源：DJ_TIMEOUT_MS（默认 30000）。
DJ_TIMEOUT_MS="${DJ_TIMEOUT_MS:-30000}"
case "${DJ_TIMEOUT_MS}" in
  ''|*[!0-9]*) DJ_TIMEOUT_MS=30000 ;;
esac
if [ "${DJ_TIMEOUT_MS}" -lt 100 ] 2>/dev/null; then DJ_TIMEOUT_MS=30000; fi

# 递归杀整棵进程树：obsidian CLI 可能派生子进程，只杀直接子进程会留下孤儿。
kill_tree() {
  local pid="${1}"
  local child
  for child in $(pgrep -P "${pid}" 2>/dev/null || true); do
    kill_tree "${child}"
  done
  kill -9 "${pid}" 2>/dev/null || true
}

# run_cli <命令...>：stdout + stderr 合并输出；超时杀进程并返回 124，否则透传命令退出码。
run_cli() {
  local tmp; tmp="$(mktemp "${TMPDIR:-/tmp}/dj-cli.XXXXXX")"
  "$@" >"${tmp}" 2>&1 &
  local pid=$!
  local ticks=$(( DJ_TIMEOUT_MS / 100 ))
  local i=0
  while kill -0 "${pid}" 2>/dev/null; do
    if [ "${i}" -ge "${ticks}" ]; then
      kill_tree "${pid}"
      wait "${pid}" 2>/dev/null || true
      cat "${tmp}" 2>/dev/null || true
      rm -f "${tmp}"
      return 124
    fi
    sleep 0.1
    i=$(( i + 1 ))
  done
  local rc=0
  wait "${pid}" || rc=$?
  cat "${tmp}"
  rm -f "${tmp}"
  return "${rc}"
}

rc=0
out="$(run_cli "${OBSIDIAN_BIN}" "vault=${VAULT}" daily:read)" || rc=$?
if [ "${rc}" -eq 124 ]; then
  echo "daily-journal: obsidian CLI 超过 ${DJ_TIMEOUT_MS}ms 无响应（子进程已杀）。重跑通常即可；连续出现请重启 Obsidian。" >&2
  exit 5
fi
if [ "${rc}" -ne 0 ]; then
  echo "daily-journal: daily:read 失败，无法创建或读取当日日记: ${out}" >&2
  exit 3
fi

rc=0
path="$(run_cli "${OBSIDIAN_BIN}" "vault=${VAULT}" daily:path)" || rc=$?
if [ "${rc}" -eq 124 ]; then
  echo "daily-journal: obsidian CLI 超过 ${DJ_TIMEOUT_MS}ms 无响应（子进程已杀）。重跑通常即可；连续出现请重启 Obsidian。" >&2
  exit 5
fi
if [ "${rc}" -ne 0 ]; then
  echo "daily-journal: daily:path 调用失败: ${path}" >&2
  exit 3
fi
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

verify="$(run_cli "${OBSIDIAN_BIN}" "vault=${VAULT}" eval \
  "code=(async () => { const f = app.vault.getAbstractFileByPath('${path}'); return JSON.stringify({ exists: !!f }); })()")" || {
  rc=$?
  if [ "${rc}" -eq 124 ]; then
    echo "daily-journal: obsidian CLI 超过 ${DJ_TIMEOUT_MS}ms 无响应（子进程已杀）。重跑通常即可；连续出现请重启 Obsidian。" >&2
    exit 5
  fi
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
