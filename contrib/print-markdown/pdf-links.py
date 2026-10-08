#!/usr/bin/env python3
# Copyright 2026 The Gitea Authors. All rights reserved.
# SPDX-License-Identifier: MIT
#
# 列出一个 PDF 里的所有链接注解，用来判断打印出来的 PDF 中某条链接到底是
#   - 文档内部跳转（/Dest，点了在 PDF 里翻页）
#   - 网页链接（/Action /S /URI，点了打开浏览器）
#
# 用法: python3 pdf-links.py out.pdf
#
# 顺便报告这份 PDF 用的是哪种"命名目标"机制：
#   - 文档目录里的 /Dests 字典     —— PDF 1.1 的老办法，Chrome 只会写这种
#   - /Names 里的 /Dests 名称树    —— PDF 1.2 起的办法
# 有些阅读器（如 macOS 预览）只认后者，于是 Chrome 打印出来的内部跳转点不动。
#
# 只用标准库，按字节扫描，不是完整的 PDF 解析器：加密的 PDF 读不了，
# 极少数写法可能漏掉几条。够用来回答"这条链接是内部跳转还是外链"。

import re
import sys
import urllib.parse
import zlib


def inflate_all(data: bytes) -> bytes:
    """原始字节加上所有能解开的流，拼成一块供正则扫描（对象流里也有注解）。"""
    parts = [data]
    for m in re.finditer(rb"stream\r?\n", data):
        start = m.end()
        end = data.find(b"endstream", start)
        if end < 0:
            continue
        try:
            parts.append(zlib.decompress(data[start:end]))
        except zlib.error:
            pass
    return b"\n".join(parts)


def unescape_name(name: bytes) -> str:
    """PDF 名称对象里的 #xx 转义还原成字节，再按 UTF-8 解码。"""
    raw = re.sub(rb"#([0-9A-Fa-f]{2})", lambda m: bytes([int(m.group(1), 16)]), name)
    return urllib.parse.unquote(raw.decode("utf-8", "replace"))


def main(path: str) -> int:
    data = open(path, "rb").read()
    blob = inflate_all(data)

    catalog_dests = re.search(rb"/Dests\s+(\d+)\s+0\s+R", blob)
    name_tree = b"/Names" in blob and re.search(rb"/Names\s*<<[^>]*?/Dests", blob, re.S)
    if catalog_dests and not name_tree:
        print("命名目标机制: 文档目录的 /Dests 字典（PDF 1.1 的老办法）")
        print("  注意: 只认 /Names 名称树的阅读器（如 macOS 预览）可能点不动内部跳转，")
        print("        换 Acrobat / Firefox / Chrome 打开同一份 PDF 可以验证。")
    elif name_tree:
        print("命名目标机制: /Names 里的 /Dests 名称树（PDF 1.2+）")
    else:
        print("命名目标机制: 没找到（这份 PDF 里可能没有内部跳转）")

    # 命名目标字典里有哪些名字，用来判断跳转是不是悬空的
    known = set()
    if catalog_dests:
        num = int(catalog_dests.group(1))
        obj = re.search(rb"[^0-9]%d\s+0\s+obj(.*?)endobj" % num, blob, re.S)
        if obj:
            known = {m.group(1) for m in re.finditer(rb"/([^\s/\[\]<>()]+)\s*\[", obj.group(1))}

    dests = uris = 0
    print()
    for m in re.finditer(rb"/Subtype\s*/Link", blob):
        # 只看这条注解自己的范围：到 endobj 或下一条注解为止，免得把邻居吃进来
        window = blob[m.end():m.end() + 400]
        bounds = [i for i in (window.find(b"endobj"), window.find(b"/Subtype")) if i >= 0]
        chunk = window[:min(bounds)] if bounds else window
        uri = re.search(rb"/URI\s*\((.*?)\)", chunk, re.S)
        dest = re.search(rb"/Dest\s*/([^\s/>\]]+)", chunk)
        if dest:
            dests += 1
            name = dest.group(1)
            mark = "" if not known or name in known else "   <- 目标名字不在命名目标表里，悬空"
            print(f"内部跳转  {unescape_name(name)}{mark}")
        elif uri:
            uris += 1
            print(f"网页链接  {urllib.parse.unquote(uri.group(1).decode('latin1'))}")

    print(f"\n合计 {dests} 个内部跳转, {uris} 个网页链接")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__ or "用法: python3 pdf-links.py out.pdf", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
