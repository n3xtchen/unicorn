#!/usr/bin/env bash
# 用用户 Neovim 的配置跑 markdownlint-cli2。
#
#   mdlint.sh <file.md> [...]        检查
#   mdlint.sh --fix <file.md> [...]  先尝试自动修复
#
# 配置来源（按优先级）：
#   1. 环境变量 MARKDOWNLINT_CONFIG
#   2. ~/.config/nvim/markdownlint-cli2.yaml   （用户 nvim 实际使用的配置）
#
# 二进制来源：mason 安装的 markdownlint-cli2 → PATH → npx 兜底。
set -uo pipefail

CONFIG="${MARKDOWNLINT_CONFIG:-$HOME/.config/nvim/markdownlint-cli2.yaml}"
BIN="${MARKDOWNLINT_BIN:-$HOME/.local/share/nvim/mason/bin/markdownlint-cli2}"

if [[ ! -f "$CONFIG" ]]; then
  echo "mdlint: warning: config not found: $CONFIG (用默认规则继续)" >&2
  CONFIG=""
fi

if [[ ! -x "$BIN" ]]; then
  BIN="$(command -v markdownlint-cli2 2>/dev/null || true)"
fi

if [[ $# -eq 0 ]]; then
  echo "usage: mdlint.sh [--fix] <file.md> [more.md ...]" >&2
  exit 2
fi

cfg_args=()
[[ -n "$CONFIG" ]] && cfg_args=(--config "$CONFIG")

if [[ -z "$BIN" ]]; then
  echo "mdlint: markdownlint-cli2 不在 PATH，回退 npx" >&2
  exec npx -y markdownlint-cli2 "${cfg_args[@]}" "$@"
fi

exec "$BIN" "${cfg_args[@]}" "$@"
