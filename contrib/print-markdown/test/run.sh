#!/usr/bin/env bash
# Copyright 2026 The Gitea Authors. All rights reserved.
# SPDX-License-Identifier: MIT
#
# pdf-links.py 的回归检查：造一份模仿 Safari 写法的 PDF，确认
#   * 本文档所在目录能从几条链接里猜出来（图片在子目录里也不跑偏）
#   * 同目录下的图片链接改成了打开本地文件，子目录和大写扩展名都算
#   * 同目录的 .md 和站外链接保持原样
#   * 只剩图片链接时也不会把图片目录错当成文档目录
#   * 原件改名留着，再跑一次不会重复改
#
# 用法: ./run.sh

set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

python3 "$dir/make-fixture.py" "$work/doc.pdf" >/dev/null
python3 "$dir/../pdf-links.py" "$work/doc.pdf" >"$work/fix.log"
python3 "$dir/../pdf-links.py" "$work/doc.pdf" --dry-run >"$work/after.log"
python3 "$dir/../pdf-links.py" "$work/doc.pdf" >"$work/again.log"

fail=0
check() { # 说明 期待的内容 文件
  if grep -qF "$2" "$3"; then
    echo "  ok   $1"
  else
    echo "  FAIL $1 —— 没在输出里找到 '$2'"
    fail=1
  fi
}
absent() { # 说明 不该出现的内容 文件
  if grep -qF "$2" "$3"; then
    echo "  FAIL $1 —— 输出里不该有 '$2'"
    fail=1
  else
    echo "  ok   $1"
  fi
}

echo "改写:"
check "猜对了本文档所在目录" "本文档所在目录: http://x/docs/" "$work/fix.log"
check "子目录里的图片" "图片 taulukko-figs/kuva1.png" "$work/fix.log"
check "大写扩展名也算" "图片 taulukko-figs/alikansio/kuva2.PNG" "$work/fix.log"
absent "同目录的 .md 不动" "图片 taulukko.en.md" "$work/fix.log"
check "改了两条" "改了 2 条链接" "$work/fix.log"
check "原件改名留着" "原件留在" "$work/fix.log"

echo "改完:"
check "两张图成了打开本地文件" "合计 0 个内部跳转, 2 个网页链接, 2 个打开本地文件" "$work/after.log"
check "站外链接保持原样" "网页链接  https://github.com/example/repo" "$work/after.log"

echo "只剩图片链接时（页内锚点都成了文档内跳转）:"
python3 "$dir/make-fixture.py" "$work/figs.pdf" --only-figs >/dev/null
python3 "$dir/../pdf-links.py" "$work/figs.pdf" >"$work/figs.log"
check "没把图片目录当成文档目录" "本文档所在目录: http://x/docs/" "$work/figs.log"
check "相对路径保留了图片目录那一段" "图片 taulukko-figs/kuva1.png" "$work/figs.log"

echo "再跑一次:"
check "没有可改的，原文件没动" "没有可以改的链接" "$work/again.log"
[ -e "$work/doc-web-web.pdf" ] && { echo "  FAIL 又生成了一个 -web"; fail=1; } || echo "  ok   没有重复生成 -web"

[ "$fail" = 0 ] && echo "全部通过" || { echo "有失败"; exit 1; }
