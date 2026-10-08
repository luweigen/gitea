#!/usr/bin/env python3
# Copyright 2026 The Gitea Authors. All rights reserved.
# SPDX-License-Identifier: MIT
#
# 列出一个 PDF 里的所有链接注解，用来判断打印出来的 PDF 中某条链接到底是
#   - 文档内部跳转（/Dest 或 /S /GoTo，点了在 PDF 里翻页）
#   - 网页链接（/S /URI，点了打开浏览器）
#
# 用法: python3 pdf-links.py out.pdf              看一遍，顺手改
#       python3 pdf-links.py out.pdf --dry-run    只看，不动文件
#
# 默认会把两类链接改掉，改好的那份仍叫原来的名字，原件改名加 -web 后缀留着：
#   * 指回本文档自己某个标题的 -> 文档内跳转。Safari 打印时会把 #片段 还原成
#     "页面地址 + 片段"的绝对 URL，点了会开浏览器；改完在 PDF 里就直接翻页。
#     做法是把文档的文字抽出来，按标题文字算出 GitHub 式的 slug，和链接里的
#     片段对上，就知道该跳到哪一页的哪个高度。
#   * 和本文档同目录的图片 -> 打开 PDF 旁边同样相对位置的那个文件（/Launch）。
#     把 PDF 和图片目录按原来的相对位置放在一起才点得开。
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

import os
import re
import sys
import unicodedata
from typing import NamedTuple
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
            # 增量更新过的文件里同一个对象号会出现两次，后面那份才是新的
            self.objs[int(m.group(1))] = m.group(2)

    def deref(self, value: bytes) -> bytes:
        """`12 0 R` 这样的间接引用跟进去取出对象本体，其它原样返回。"""
        m = re.fullmatch(rb"\s*(\d+)\s+0\s+R\s*", value)
        return self.objs.get(int(m.group(1)), b"").strip() if m else value.strip()

    def field_obj(self, dic: bytes, name: str) -> bytes:
        """取一个值是字典的键：可能是间接引用，也可能是就地写的 << >>。"""
        m = re.search(rb"/" + name.encode() + rb"\s*(\d+\s+0\s+R|<<)", dic)
        if not m:
            return b""
        if m.group(1) != b"<<":
            return self.deref(m.group(1))
        return balanced_dict(dic, m.end() - 2)

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


def balanced_dict(buf: bytes, start: int) -> bytes:
    """从 buf[start] 这个 << 开始，取出配平的整个字典（里面可以再套字典）。"""
    depth, j = 0, start
    while j < len(buf) - 1:
        if buf[j:j + 2] == b"<<":
            depth += 1
            j += 2
        elif buf[j:j + 2] == b">>":
            depth -= 1
            j += 2
            if depth == 0:
                return buf[start:j]
        else:
            j += 1
    return buf[start:]


def describe(pdf: Pdf, dic: bytes) -> tuple[str, str]:
    """把一条链接注解说清楚：(类别, 内容)。"""
    action = pdf.field_obj(dic, "A")
    kind = pdf.field(action, "S") if action else b""

    uri = pdf.field(action, "URI") if action else b""
    if not uri:
        uri = pdf.field(dic, "URI")
    if uri.startswith(b"("):
        return "uri", urllib.parse.unquote(uri[1:-1].decode("utf-8", "replace"))

    if kind == b"/Launch":
        # 文件说明里的 /F 是条字面量路径
        m = re.search(rb"/F\s*\((.*?)\)", action, re.S)
        name = m.group(1).decode("utf-8", "replace") if m else "?"
        return "file", name

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


# ---------------------------------------------------------------------------
# 以下是改链接用的：把文档文字抽出来，好把链接片段对到具体的页和高度
# ---------------------------------------------------------------------------


def slugify(text: str) -> str:
    """按 GitHub / Gitea 生成标题 id 的办法算 slug。

    先做 NFKC 规范化：PingFang 的 ToUnicode 会把一些汉字映射成康熙部首
    （"目"写成 U+2F6C "⽬"），不规范化就对不上。
    """
    t = unicodedata.normalize("NFKC", text).strip().lower()
    t = "".join(ch for ch in t if ch.isalnum() or ch in " -_")
    return "-".join(t.split(" "))


def stream_data(body: bytes) -> bytes:
    """取出对象里的流，能解压就解压。"""
    m = re.search(rb"stream\r?\n", body)
    if not m:
        return b""
    raw = body[m.end():body.rfind(b"endstream")]
    try:
        return zlib.decompress(raw)
    except zlib.error:
        return raw


# 简单字体（非 Type0）的内置编码。Safari 给拉丁文用的就是 MacRomanEncoding，
# 按 latin1 读的话 ä（0x8A）会变成控制字符，芬兰语、瑞典语的标题就对不上了。
BASE_ENCODINGS = {
    b"/MacRomanEncoding": "mac_roman",
    b"/WinAnsiEncoding": "cp1252",
    b"/StandardEncoding": "latin1",
    b"/PDFDocEncoding": "latin1",
}


class Font(NamedTuple):
    type0: bool                 # Type0 字体的字符串是两字节一个字形编号
    to_unicode: dict[int, str]  # 有 ToUnicode 就以它为准
    codec: str                  # 没有时按这个内置编码解


def base_codec(font_body: bytes) -> str:
    m = re.search(rb"/Encoding\s*(/[A-Za-z]+)", font_body)
    return BASE_ENCODINGS.get(m.group(1), "latin1") if m else "latin1"


def unhex(raw: bytes) -> bytes:
    raw = re.sub(rb"\s", b"", raw)
    if len(raw) % 2:
        raw += b"0"
    return bytes.fromhex(raw.decode())


def unescape_literal(raw: bytes) -> bytes:
    """PDF 字面量字符串里的转义。

    非 ASCII 字节通常写成八进制（MacRoman 的 ä 是 \\212），不认就会原样留下
    一串反斜杠和数字。
    """
    named = {ord("n"): 10, ord("r"): 13, ord("t"): 9, ord("b"): 8, ord("f"): 12}
    out = bytearray()
    i = 0
    while i < len(raw):
        if raw[i] != 0x5C:  # 反斜杠
            out.append(raw[i])
            i += 1
            continue
        i += 1
        if i >= len(raw):
            break
        ch = raw[i]
        if ch in named:
            out.append(named[ch])
            i += 1
        elif 0x30 <= ch <= 0x37:  # 八进制，最多三位
            j = i
            while j < min(i + 3, len(raw)) and 0x30 <= raw[j] <= 0x37:
                j += 1
            out.append(int(raw[i:j], 8) & 0xFF)
            i = j
        elif ch == 0x0A:  # 行末反斜杠是续行
            i += 1
        else:
            out.append(ch)
            i += 1
    return bytes(out)


def decode_string(raw: bytes, font: Font | None) -> str:
    """按字体把字符串字节还原成文字。"""
    if font is None:
        return raw.decode("latin1")
    if font.type0:
        codes = [int.from_bytes(raw[i:i + 2], "big") for i in range(0, len(raw) - 1, 2)]
        return "".join(font.to_unicode.get(c, "") for c in codes)
    if font.to_unicode:
        # 子集字体的编号是随便编的（常从 33 开始），只有 ToUnicode 说了算
        return "".join(font.to_unicode.get(b, bytes([b]).decode(font.codec, "replace")) for b in raw)
    return raw.decode(font.codec, "replace")


class Doc(Pdf):
    """在 Pdf 之上加页面遍历和取字，只有改链接时会用到。"""

    def pages(self) -> list[int]:
        """按先后顺序列出每一页的对象号。"""
        catalog = next((b for b in self.objs.values() if re.search(rb"/Type\s*/Catalog", b)), b"")
        m = re.search(rb"/Pages\s+(\d+)\s+0\s+R", catalog)
        if not m:
            return [n for n, b in sorted(self.objs.items()) if re.search(rb"/Type\s*/Page[^s]", b)]
        out: list[int] = []
        seen: set[int] = set()

        def walk(num: int) -> None:
            if num in seen:
                return
            seen.add(num)
            body = self.objs.get(num, b"")
            kids = re.search(rb"/Kids\s*\[(.*?)\]", body, re.S)
            if not kids:
                out.append(num)
                return
            for k in re.findall(rb"(\d+)\s+0\s+R", kids.group(1)):
                walk(int(k))

        walk(int(m.group(1)))
        return out

    def to_unicode(self, font_body: bytes) -> dict[int, str]:
        """字体的 ToUnicode CMap：字形编号 -> 字符。"""
        m = re.search(rb"/ToUnicode\s+(\d+)\s+0\s+R", font_body)
        if not m:
            return {}
        cmap = stream_data(self.objs.get(int(m.group(1)), b""))
        table: dict[int, str] = {}
        for blk in re.findall(rb"beginbfchar(.*?)endbfchar", cmap, re.S):
            for src, dst in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", blk):
                table[int(src, 16)] = bytes.fromhex(dst.decode()).decode("utf-16-be", "replace")
        for blk in re.findall(rb"beginbfrange(.*?)endbfrange", cmap, re.S):
            for lo, hi, dst in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", blk):
                base = int(dst, 16)
                for code in range(int(lo, 16), int(hi, 16) + 1):
                    table[code] = chr(base + code - int(lo, 16))
        return table

    def page_lines(self, page_num: int) -> list[tuple[float, str]]:
        """一页里的文字，按行返回 (基线高度, 文字)。

        不做完整的文字排版还原：浏览器打印出来的内容流是一段文字一个
        `q … cm BT … ET Q`，取 cm 的平移量当高度，同高度的拼成一行，
        对"找标题在第几页什么位置"已经够了。
        """
        body = self.objs.get(page_num, b"")
        res = re.search(rb"/Resources\s*(\d+\s+0\s+R|<<.*?>>)", body, re.S)
        fonts: dict[str, "Font"] = {}
        if res:
            # 这里不走 field()：/Font 的值常是个内联字典，field() 不认 << >> 形式
            resources = self.deref(res.group(1))
            fm = re.search(rb"/Font\s*(\d+\s+0\s+R|<<.*?>>)", resources, re.S)
            fdict = self.deref(fm.group(1)) if fm else b""
            for name, num in re.findall(rb"/([A-Za-z0-9]+)\s+(\d+)\s+0\s+R", fdict):
                fb = self.objs.get(int(num), b"")
                fonts[name.decode()] = Font(b"/Type0" in fb, self.to_unicode(fb), base_codec(fb))

        contents = re.search(rb"/Contents\s*(\d+\s+0\s+R|\[.*?\])", body, re.S)
        if not contents:
            return []
        content = b"".join(
            stream_data(self.objs.get(int(n), b""))
            for n in re.findall(rb"(\d+)\s+0\s+R", contents.group(1))
        )

        lines: dict[float, list[str]] = {}
        for text_block in re.finditer(rb"BT(.*?)ET", content, re.S):
            placements = list(re.finditer(
                rb"([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+cm",
                content[:text_block.start()]))
            y = float(placements[-1].group(6)) if placements else 0.0
            text = self.decode_text_block(text_block.group(1), fonts)
            if text:
                lines.setdefault(round(y, 1), []).append(text)
        return [(y, "".join(parts)) for y, parts in sorted(lines.items(), reverse=True)]

    @staticmethod
    def decode_text_block(blk: bytes, fonts: dict[str, "Font"]) -> str:
        font: Font | None = None
        out: list[str] = []
        pattern = (rb"/([A-Za-z0-9]+)\s+[\d.]+\s+Tf"
                   rb"|\((?:\\.|[^\\)])*\)"
                   rb"|<([0-9A-Fa-f\s]+)>"
                   rb"|\[((?:[^\[\]]|\\.)*)\]\s*TJ")
        for tok in re.finditer(pattern, blk, re.S):
            piece = tok.group(0)
            if piece.endswith(b"Tf"):
                font = fonts.get(tok.group(1).decode())
            elif piece.startswith(b"("):
                out.append(decode_string(unescape_literal(piece[1:-1]), font))
            elif piece.startswith(b"<"):
                out.append(decode_string(unhex(tok.group(2)), font))
            elif piece.endswith(b"TJ"):
                for part in re.finditer(rb"\((?:\\.|[^\\)])*\)|<([0-9A-Fa-f\s]+)>", tok.group(3) or b""):
                    chunk = part.group(0)
                    raw = unescape_literal(chunk[1:-1]) if chunk.startswith(b"(") else unhex(part.group(1))
                    out.append(decode_string(raw, font))
        return "".join(out)


def link_uri(pdf: Pdf, body: bytes) -> str:
    """一条链接注解指向的 URL，不是网页链接就返回空串。"""
    action = pdf.field(body, "A")
    uri = (pdf.field(action, "URI") if action else b"") or pdf.field(body, "URI")
    return urllib.parse.unquote(uri[1:-1].decode("utf-8", "replace")) if uri.startswith(b"(") else ""


IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif",
                  ".bmp", ".tif", ".tiff")


def pdf_literal(text: str) -> bytes:
    """写成 PDF 的字面量字符串，转义反斜杠和括号。"""
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return b"(" + escaped.encode("latin1", "replace") + b")"


def pdf_utf16(text: str) -> bytes:
    """写成 PDF 的 UTF-16BE 十六进制字符串，非 ASCII 的文件名要用它。"""
    return b"<" + (b"\xfe\xff" + text.encode("utf-16-be")).hex().upper().encode() + b">"


def replace_action(body: bytes, entry: bytes) -> bytes:
    """把注解里的 /A 动作换成别的（/Dest 或另一个 /A）。"""
    new_body, n = re.subn(rb"/A\s+\d+\s+0\s+R|/A\s*<<.*?>>", entry, body, count=1, flags=re.S)
    return new_body if n else body.replace(b">>", b" " + entry + b" >>", 1)


def plan_changes(doc: "Doc") -> dict[int, bytes]:
    """算出要改哪些链接注解，返回 {对象号: 新的注解内容}。

    两类：
      * 指回本文档某个标题的，改成文档内跳转（/Dest）；
      * 和本文档同目录的图片，改成打开磁盘上同样相对位置的文件（/Launch）。
    """
    # 每个标题 slug 对应到 (页序号, 页对象号, 基线高度, 原文)
    index: dict[str, tuple[int, int, float, str]] = {}
    for i, page in enumerate(doc.pages()):
        for y, text in doc.page_lines(page):
            index.setdefault(slugify(text), (i + 1, page, y, text))

    links: list[tuple[int, bytes, str]] = []
    for num, body in doc.objs.items():
        if b"/Subtype" in body and b"/Link" in body:
            uri = link_uri(doc, body)
            if uri:
                links.append((num, body, uri))
    if not links:
        print("这份 PDF 里没有网页链接，无事可做。")
        return {}

    # 带片段的链接按"去掉片段后的地址"分组，出现最多的那个当成本文档自己
    bases: dict[str, int] = {}
    for _, _, uri in links:
        if "#" in uri:
            bases[uri.split("#", 1)[0]] = bases.get(uri.split("#", 1)[0], 0) + 1
    self_base = max(bases, key=lambda b: bases[b]) if bases else ""
    if self_base:
        print(f"把这个地址当作本文档自己: {self_base}")
        base_dir = self_base.rsplit("/", 1)[0] + "/"
    else:
        # 没有页内锚点可参考时，用出现最多的目录当本文档所在目录
        dirs: dict[str, int] = {}
        for _, _, uri in links:
            d = uri.rsplit("/", 1)[0] + "/"
            dirs[d] = dirs.get(d, 0) + 1
        base_dir = max(dirs, key=lambda d: dirs[d]) if dirs else ""
    if base_dir:
        print(f"把这个目录当作本文档所在目录: {base_dir}")

    changed: dict[int, bytes] = {}
    for num, body, uri in links:
        if "#" in uri:
            base, frag = uri.split("#", 1)
            if base != self_base:
                continue
            key = frag[len("user-content-"):] if frag.startswith("user-content-") else frag
            hit = index.get(slugify(key))
            if not hit:
                print(f"  片段 {frag} 在文档里找不到对应标题，保留原链接")
                continue
            page_no, page_obj, y, text = hit
            # 目标落在标题基线稍上方一点，免得标题贴着窗口上沿
            changed[num] = replace_action(body, f"/Dest [ {page_obj} 0 R /XYZ 0 {y + 10:.1f} 0 ]".encode())
            print(f"  {frag}  ->  第 {page_no} 页 ({text[:24]})")
            continue

        if not base_dir or not uri.startswith(base_dir):
            continue
        rel = uri[len(base_dir):]
        if not rel.lower().endswith(IMAGE_SUFFIXES) or rel.startswith(("/", "..")):
            continue
        # 打开 PDF 旁边同样相对位置的那个文件
        spec = b"<< /Type /Filespec /F " + pdf_literal(rel) + b" /UF " + pdf_utf16(rel) + b" >>"
        changed[num] = replace_action(body, b"/A << /S /Launch /F " + spec + b" >>")
        print(f"  图片 {rel}  ->  打开本地同名文件")

    return changed


def apply_update(data: bytes, changed: dict[int, bytes], out_path: str) -> None:
    """增量更新：原字节一个不动，改过的对象追加到末尾，再补一张新的 xref 表。"""
    out = bytearray(data)
    if not out.endswith(b"\n"):
        out += b"\n"
    offsets: dict[int, int] = {}
    for num in sorted(changed):
        offsets[num] = len(out)
        out += b"%d 0 obj" % num + changed[num] + b"endobj\n"

    xref_at = len(out)
    out += b"xref\n"
    for first, group in group_runs(sorted(changed)):
        out += b"%d %d\n" % (first, len(group))
        for num in group:
            out += b"%010d %05d n \n" % (offsets[num], 0)
    root = re.findall(rb"/Root\s+(\d+)\s+0\s+R", data)[-1]
    # 没有新增对象，/Size 沿用原来的就行（objs 是按字节扫出来的，可能混进假对象号）
    sizes = [int(m) for m in re.findall(rb"/Size\s+(\d+)", data)]
    size = max(sizes + [n + 1 for n in changed])
    prev = re.findall(rb"startxref\s+(\d+)", data)[-1]
    out += b"trailer\n<< /Size %d /Root %s 0 R /Prev %s >>\nstartxref\n%d\n%%%%EOF\n" % (
        size, root, prev, xref_at)
    with open(out_path, "wb") as fh:
        fh.write(out)


def fix_in_place(path: str, data: bytes) -> int:
    """改好的那份用原来的文件名，原件改名加 -web 后缀留着。"""
    if not re.search(rb"[\r\n]xref[\r\n]", data):
        print("这份 PDF 用的是交叉引用流（xref stream），本脚本只会改传统 xref 表的文件。")
        print("Chrome 打印出来的本来就是文档内跳转，不需要改；Safari 的是传统表。")
        return 0

    changed = plan_changes(Doc(data))
    if not changed:
        print("没有可以改的链接，原文件没动。")
        return 0

    stem, dot, ext = path.rpartition(".")
    backup = (stem if dot else path) + "-web" + (dot + ext if dot else "")
    if os.path.exists(backup):
        print(f"{backup} 已经存在，不覆盖；先把它挪开再跑。", file=sys.stderr)
        return 1

    tmp = path + ".tmp"
    apply_update(data, changed, tmp)
    os.rename(path, backup)
    os.rename(tmp, path)
    print(f"\n改了 {len(changed)} 条链接。原件留在 {backup}，改好的还叫 {path}。")
    return 0


def group_runs(nums: list[int]) -> list[tuple[int, list[int]]]:
    """把对象号切成连续的几段，xref 表要按段写。"""
    runs: list[tuple[int, list[int]]] = []
    for num in nums:
        if runs and num == runs[-1][1][-1] + 1:
            runs[-1][1].append(num)
        else:
            runs.append((num, [num]))
    return runs


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

    # 同一条注解可能出现不止一次：原始字节和解压出来的对象流里各有一份，
    # 增量更新过的文件里还会有旧版本。按 /Rect 去重，保留文件里靠后的那一份。
    annots: dict[bytes, bytes] = {}
    for m in re.finditer(rb"/Subtype\s*/Link", blob):
        dic = enclosing_dict(blob, m.start())
        rect = re.search(rb"/Rect\s*\[(.*?)\]", dic, re.S)
        annots[rect.group(1).strip() if rect else dic] = dic

    dests = uris = files = unknown = 0
    print()
    for dic in annots.values():
        kind, text = describe(pdf, dic)
        if kind == "dest":
            dests += 1
            mark = "   <- 目标名字不在命名目标表里，悬空" if known and text not in known else ""
            print(f"内部跳转  {text}{mark}")
        elif kind == "uri":
            uris += 1
            print(f"网页链接  {text}")
        elif kind == "file":
            files += 1
            print(f"打开文件  {text}")
        else:
            unknown += 1  # 认不出来的照原样打出来，免得静悄悄漏掉
            print(f"认不出来  {text!r}")

    tail = f", {files} 个打开本地文件" if files else ""
    tail += f", {unknown} 条认不出来" if unknown else ""
    print(f"\n合计 {dests} 个内部跳转, {uris} 个网页链接{tail}")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    if dry_run:
        args.remove("--dry-run")
    if len(args) != 1:
        print("用法: python3 pdf-links.py out.pdf [--dry-run]", file=sys.stderr)
        sys.exit(2)
    code = main(args[0])
    if code == 0 and not dry_run:
        print()
        code = fix_in_place(args[0], open(args[0], "rb").read())
    sys.exit(code)
