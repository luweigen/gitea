#!/usr/bin/env bash
# Copyright 2026 The Gitea Authors. All rights reserved.
# SPDX-License-Identifier: MIT
#
# pdf-links.py 的回归检查：造一份模仿 Safari 写法的 PDF，确认两个芬兰语标题
# （MacRoman 简单字体 / 带 ToUnicode 的子集字体各一个）都能从网页链接改成文档内跳转。
#
# 用法: ./run.sh

set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

python3 "$dir/make-fixture.py" "$work/fi.pdf" >/dev/null
python3 "$dir/../pdf-links.py" "$work/fi.pdf" >"$work/fix.log"
python3 "$dir/../pdf-links.py" "$work/fi.pdf" --dry-run >"$work/after.log"

fail=0
check() { # 说明 期待的内容 文件
  if grep -qF "$2" "$3"; then
    echo "  ok   $1"
  else
    echo "  FAIL $1 —— 没在输出里找到 '$2'"
    fail=1
  fi
}
echo "改写:"
check "MacRoman 字体里的 ä 认得出来" "user-content-2-kentät-yhdellä-silmäyksellä  ->  第 2 页" "$work/fix.log"
check "子集字体靠 ToUnicode 认得出来" "user-content-3-ehdokaspisteiden-kentät  ->  第 2 页" "$work/fix.log"
check "打印时换的 ASCII id 解得回来" "pd-user-content-4-mittausalueiden-kent.c3.a4t  ->  第 2 页" "$work/fix.log"
check "原件改名留着" "原件留在" "$work/fix.log"
echo "改完:"
check "三条都成了文档内跳转" "合计 3 个内部跳转, 0 个网页链接" "$work/after.log"

[ "$fail" = 0 ] && echo "全部通过" || { echo "有失败"; exit 1; }
