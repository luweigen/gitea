#!/usr/bin/env python3
# Copyright 2026 The Gitea Authors. All rights reserved.
# SPDX-License-Identifier: MIT
#
# 列出一个 PDF 里的所有链接注解，看每条到底是
#   - 文档内部跳转（/Dest 或 /S /GoTo，点了在 PDF 里翻页）
#   - 网页链接（/S /URI，点了打开浏览器）
#   - 打开本地文件（/S /Launch）
#
# 用法: python3 pdf-links.py out.pdf              看一遍，顺手改
#       python3 pdf-links.py out.pdf --dry-run    只看，不动文件
#       python3 pdf-links.py out.pdf --base-url https://git.example.com/…/docs/
#
# 默认会把**和本文档同目录的图片链接**改成打开 PDF 旁边同样相对位置的那个文件
# （PDF 的 /GoToR 动作），改好的那份仍叫原来的名字，原件改名加 -web 后缀留着。
# 要把 PDF 和图片目录按原来的相对位置放在一起才点得开。
#
# 页内锚点不用管：header.tmpl 打印前会把它们改写成浏览器认得出来的样子，
# Chrome 和 Safari 写出来的就已经是文档内跳转了。
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

import os
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
    return balanced_dict(blob, start)


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


def describe(pdf: Pdf, dic: bytes) -> tuple[str, str]:
    """把一条链接注解说清楚：(类别, 内容)。"""
    action = pdf.field_obj(dic, "A")
    kind = pdf.field(action, "S") if action else b""

    uri = pdf.field(action, "URI") if action else b""
    if not uri:
        uri = pdf.field(dic, "URI")
    if uri.startswith(b"("):
        return "uri", urllib.parse.unquote(uri[1:-1].decode("utf-8", "replace"))

    if kind in (b"/Launch", b"/GoToR"):
        # 文件说明里的 /F 是条字面量路径（纯字符串写法也是同一个 /F）
        m = re.search(rb"/F\s*\((.*?)\)", action, re.S)
        return "file", m.group(1).decode("utf-8", "replace") if m else "?"

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


def link_uri(pdf: Pdf, body: bytes) -> str:
    """一条链接注解指向的 URL，不是网页链接就返回空串。"""
    action = pdf.field_obj(body, "A")
    uri = (pdf.field(action, "URI") if action else b"") or pdf.field(body, "URI")
    return urllib.parse.unquote(uri[1:-1].decode("utf-8", "replace")) if uri.startswith(b"(") else ""


# ---------------------------------------------------------------------------
# 把同目录的图片链接改成打开本地文件
# ---------------------------------------------------------------------------

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
    """把注解里的 /A 动作换成别的。"""
    m = re.search(rb"/A\s*(\d+\s+0\s+R|<<)", body)
    if not m:
        return body.replace(b">>", b" " + entry + b" >>", 1)
    if m.group(1) == b"<<":
        # 就地写的动作里还能再套字典（文件说明就是），非贪婪的 >> 会停在里层那个，
        # 把后面的 /D 之类剩在外面，注解就废了 —— 得配平着找
        end = m.end() - 2 + len(balanced_dict(body, m.end() - 2))
    else:
        end = m.end()
    return body[:m.start()] + entry + body[end:]


# Markdown 放插图的目录常见叫法。所有链接都挤在同一个这样的目录里时，
# 文档本身应该在它的上一级
FIG_DIR_NAMES = ("figs", "figures", "images", "img", "assets", "attachments")
FIG_DIR_SUFFIXES = tuple(sep + name for name in FIG_DIR_NAMES for sep in ("-", "_", "."))


def looks_like_figure_dir(url_dir: str) -> bool:
    last = url_dir.rstrip("/").rsplit("/", 1)[-1].lower()
    return last in FIG_DIR_NAMES or last.endswith(FIG_DIR_SUFFIXES)


def base_directory(urls: list[str]) -> str:
    """猜本文档在网站上的所在目录，图片路径按它做前缀相减。猜不出来就返回空串。

    链接分布在好几个目录时，取同一站点下的最长公共目录前缀就对了：图片在
    `docs/某文档-figs/` 里、同目录还有别的文件链接，公共前缀正好是 `docs/`。

    但页内锚点现在都是文档内跳转、不再是链接了，常常只剩下图片链接，而且全挤在
    同一个 `-figs` 目录里 —— 这时候公共前缀就是那个图片目录本身，照它相减会把
    `某文档-figs/` 这一段吃掉。所以单目录的情况要单独判断：目录名像个放图的地方
    就取它的上一级，否则宁可说不知道，也别算出一条错的相对路径。
    """
    hosts: dict[str, int] = {}
    for u in urls:
        parts = urllib.parse.urlsplit(u)
        host = f"{parts.scheme}://{parts.netloc}"
        hosts[host] = hosts.get(host, 0) + 1
    if not hosts:
        return ""
    main = max(hosts, key=lambda h: hosts[h])
    dirs = [u.rsplit("/", 1)[0] + "/" for u in urls if u.startswith(main + "/")]
    if not dirs:
        return ""

    unique = set(dirs)
    if len(unique) == 1:
        candidate, need_figure_dir = dirs[0], True
    else:
        common: list[str] = []
        for segs in zip(*[d.split("/") for d in dirs]):
            if len(set(segs)) != 1:
                break
            common.append(segs[0])
        candidate, need_figure_dir = "/".join(common) + "/", False

    if looks_like_figure_dir(candidate):
        # 公共前缀落在图片目录上（图片还分了子目录也算），文档在它上一级
        candidate = candidate.rstrip("/").rsplit("/", 1)[0] + "/"
    elif need_figure_dir:
        return ""  # 所有链接都在同一个目录，又看不出那是图片目录，说不准
    return candidate if candidate.count("/") > 3 else ""


def plan_changes(pdf: Pdf, base_url: str) -> dict[int, bytes]:
    """算出要改哪些链接注解，返回 {对象号: 新的注解内容}。"""
    links: list[tuple[int, bytes, str]] = []
    for num, body in pdf.objs.items():
        if b"/Subtype" in body and b"/Link" in body:
            uri = link_uri(pdf, body)
            if uri:
                links.append((num, body, uri))
    if not links:
        print("这份 PDF 里没有网页链接，无事可做。")
        return {}

    base_dir = base_url or base_directory([u for _, _, u in links])
    if not base_dir:
        print("认不出本文档所在的目录，没法算图片的相对路径。链接都在这些目录下：")
        for d in sorted({u.rsplit("/", 1)[0] + "/" for u in (u for _, _, u in links)}):
            print(f"  {d}")
        print("挑出文档自己所在的那个目录，用 --base-url 指定它再跑一次。")
        return {}
    print(f"把这个目录当作本文档所在目录: {base_dir}")

    changed: dict[int, bytes] = {}
    for num, body, uri in links:
        path = uri.split("#", 1)[0]
        if not path.startswith(base_dir):
            continue
        rel = path[len(base_dir):]
        if not rel.lower().endswith(IMAGE_SUFFIXES) or rel.startswith(("/", "..")):
            continue
        # 打开 PDF 旁边同样相对位置的那个文件。用 /GoToR 而不是看起来更对口的
        # /Launch：macOS 预览对 /Launch 和 file:// 的 /URI 一概不理（只"嘟"一声），
        # 相对路径的 /URI 它认得出路径却开不起来（报 -50），只有 /GoToR 能打开。
        spec = b"<< /Type /Filespec /F " + pdf_literal(rel) + b" /UF " + pdf_utf16(rel) + b" >>"
        changed[num] = replace_action(body, b"/A << /S /GoToR /F " + spec + b" /D [0 /Fit] >>")
        print(f"  图片 {rel}  ->  打开本地同名文件")
    return changed


def group_runs(nums: list[int]) -> list[tuple[int, list[int]]]:
    """把对象号切成连续的几段，xref 表要按段写。"""
    runs: list[tuple[int, list[int]]] = []
    for num in nums:
        if runs and num == runs[-1][1][-1] + 1:
            runs[-1][1].append(num)
        else:
            runs.append((num, [num]))
    return runs


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


def fix_in_place(path: str, data: bytes, base_url: str) -> int:
    """改好的那份用原来的文件名，原件改名加 -web 后缀留着。"""
    if not re.search(rb"[\r\n]xref[\r\n]", data):
        print("这份 PDF 用的是交叉引用流（xref stream），本脚本只会改传统 xref 表的文件。")
        return 0

    changed = plan_changes(Pdf(data), base_url)
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
    base_url = ""
    if "--base-url" in args:
        i = args.index("--base-url")
        if i + 1 >= len(args):
            print("--base-url 后面要跟本文档所在目录的地址", file=sys.stderr)
            sys.exit(2)
        base_url = args[i + 1].rstrip("/") + "/"
        del args[i:i + 2]
    if len(args) != 1:
        print("用法: python3 pdf-links.py out.pdf [--dry-run] [--base-url URL]", file=sys.stderr)
        sys.exit(2)
    code = main(args[0])
    if code == 0 and not dry_run:
        print()
        code = fix_in_place(args[0], open(args[0], "rb").read(), base_url)
    sys.exit(code)
