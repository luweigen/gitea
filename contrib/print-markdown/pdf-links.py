#!/usr/bin/env python3
# Copyright 2026 The Gitea Authors. All rights reserved.
# SPDX-License-Identifier: MIT
#
# 列出一个 PDF 里的所有链接注解，用来判断打印出来的 PDF 中某条链接到底是
#   - 文档内部跳转（/Dest 或 /S /GoTo，点了在 PDF 里翻页）
#   - 网页链接（/S /URI，点了打开浏览器）
#
# 用法: python3 pdf-links.py out.pdf
#
# 顺便报告这份 PDF 用的是哪种"命名目标"机制：
#   - 文档目录里的 /Dests 字典     —— PDF 1.1 的老办法，Chrome 只会写这种
#   - /Names 里的 /Dests 名称树    —— PDF 1.2 起的办法
#
# 不同浏览器写法差别很大，所以这里是整个注解字典一起看、间接引用也跟进去：
# Chrome 把值直接写在注解里、键按出现顺序排；Safari 按字母序排键（/A 在 /Subtype
# 前面），而且动作和 URI 都是单独的对象。只认一种写法的工具会得出"这份 PDF 里
# 没有链接"的错误结论。
#
# 只用标准库，按字节扫描，不是完整的 PDF 解析器：加密的 PDF 读不了。
# 够用来回答"这条链接是内部跳转还是外链"。

import re
import sys
import urllib.parse
import zlib


def inflate_all(data: bytes) -> bytes:
    """原始字节加上所有能解开的流，拼成一块供扫描（对象流里也有注解）。"""
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


def enclosing_dict(blob: bytes, pos: int) -> bytes:
    """取出包住 pos 的那一层 << >> 字典。"""
    depth, start = 0, None
    i = pos
    while i >= 1:  # 往前找配平的 <<
        if blob[i - 1:i + 1] == b">>":
            depth += 1
            i -= 2
            continue
        if blob[i - 1:i + 1] == b"<<":
            if depth == 0:
                start = i - 1
                break
            depth -= 1
            i -= 2
            continue
        i -= 1
    if start is None:
        return blob[max(0, pos - 300):pos + 300]
    depth, j = 0, start
    while j < len(blob) - 1:  # 再往后找配平的 >>
        if blob[j:j + 2] == b"<<":
            depth += 1
            j += 2
            continue
        if blob[j:j + 2] == b">>":
            depth -= 1
            j += 2
            if depth == 0:
                return blob[start:j]
            continue
        j += 1
    return blob[start:start + 600]


def unescape_name(name: bytes) -> str:
    """PDF 名称对象里的 #xx 转义还原成字节，再按 UTF-8 解码。"""
    raw = re.sub(rb"#([0-9A-Fa-f]{2})", lambda m: bytes([int(m.group(1), 16)]), name)
    return urllib.parse.unquote(raw.decode("utf-8", "replace"))


class Pdf:
    def __init__(self, data: bytes):
        self.blob = inflate_all(data)
        self.objs: dict[int, bytes] = {}
        for m in re.finditer(rb"(?:^|[^0-9])(\d+)\s+0\s+obj(.*?)endobj", self.blob, re.S):
            self.objs.setdefault(int(m.group(1)), m.group(2))

    def deref(self, value: bytes) -> bytes:
        """`12 0 R` 这样的间接引用跟进去取出对象本体，其它原样返回。"""
        m = re.fullmatch(rb"\s*(\d+)\s+0\s+R\s*", value)
        return self.objs.get(int(m.group(1)), b"").strip() if m else value.strip()

    def field(self, dic: bytes, *names: str) -> bytes:
        """取字典里某个键的值（跟进间接引用）。

        注意 `/S /URI /URI 125 0 R` 这种：按 URI 去搜，第一个命中的其实是 /S 的值
        `/URI`。所以先要不是名称对象的那个值，没有再退回名称对象。
        """
        for name in names:
            # 值放在前瞻里，免得 /S 的值 `/URI` 把后面真正的 `/URI 125 0 R` 一起吃掉
            pat = rb"/" + name.encode() + rb"(?=\s*(\d+\s+0\s+R|/[^\s/>\]()]+|\(.*?\)|\[.{0,120}?\]))"
            found = [m.group(1) for m in re.finditer(pat, dic, re.S)]
            if not found:
                continue
            value = next((v for v in found if not v.startswith(b"/")), found[0])
            return self.deref(value)
        return b""


def describe(pdf: Pdf, dic: bytes) -> tuple[str, str]:
    """把一条链接注解说清楚：(类别, 内容)。"""
    action = pdf.field(dic, "A")
    kind = pdf.field(action, "S") if action else b""

    uri = pdf.field(action, "URI") if action else b""
    if not uri:
        uri = pdf.field(dic, "URI")
    if uri.startswith(b"("):
        return "uri", urllib.parse.unquote(uri[1:-1].decode("utf-8", "replace"))

    dest = pdf.field(dic, "Dest") or (pdf.field(action, "D") if action else b"")
    if dest.startswith(b"/"):
        return "dest", unescape_name(dest[1:])
    if dest.startswith(b"("):
        return "dest", dest[1:-1].decode("utf-8", "replace") + "（字符串形式）"
    if dest.startswith(b"["):
        return "dest", "直接目标 " + dest.decode("latin1").strip()
    if kind == b"/GoTo":
        return "dest", "(GoTo，没找到目标)"
    return "", dic.decode("latin1")[:200]


def main(path: str) -> int:
    pdf = Pdf(open(path, "rb").read())
    blob = pdf.blob

    catalog_dests = re.search(rb"/Dests\s+(\d+)\s+0\s+R", blob)
    name_tree = re.search(rb"/Names\s*<<[^>]*?/Dests", blob, re.S)
    if name_tree:
        print("命名目标机制: /Names 里的 /Dests 名称树（PDF 1.2+）")
    elif catalog_dests:
        print("命名目标机制: 文档目录的 /Dests 字典（PDF 1.1 的老办法）")
    else:
        print("命名目标机制: 没找到（这份 PDF 里可能没有命名的内部跳转）")

    # 命名目标表里有哪些名字，用来判断跳转是不是悬空的
    known = set()
    if catalog_dests:
        body = pdf.objs.get(int(catalog_dests.group(1)), b"")
        known = {unescape_name(m.group(1)) for m in re.finditer(rb"/([^\s/\[\]<>()]+)\s*\[", body)}

    dests = uris = unknown = 0
    print()
    seen = set()
    for m in re.finditer(rb"/Subtype\s*/Link", blob):
        dic = enclosing_dict(blob, m.start())
        if dic in seen:  # 同一条注解在原始字节和解压流里各出现一次
            continue
        seen.add(dic)
        kind, text = describe(pdf, dic)
        if kind == "dest":
            dests += 1
            mark = "   <- 目标名字不在命名目标表里，悬空" if known and text not in known else ""
            print(f"内部跳转  {text}{mark}")
        elif kind == "uri":
            uris += 1
            print(f"网页链接  {text}")
        else:
            unknown += 1  # 认不出来的照原样打出来，免得静悄悄漏掉
            print(f"认不出来  {text!r}")

    tail = f", {unknown} 条认不出来" if unknown else ""
    print(f"\n合计 {dests} 个内部跳转, {uris} 个网页链接{tail}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("用法: python3 pdf-links.py out.pdf", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
