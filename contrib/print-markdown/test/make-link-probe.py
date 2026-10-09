#!/usr/bin/env python3
# Copyright 2026 The Gitea Authors. All rights reserved.
# SPDX-License-Identifier: MIT
#
# 造一份"哪种写法能打开本地文件"的试纸：一页 PDF，每行一条指向同一张图片的链接，
# 每条用不同的 PDF 动作写法。拿阅读器打开挨个点，能打开图片的那行就是该用的写法。
#
# 用法: python3 make-link-probe.py 输出.pdf
#
# 会在 PDF 旁边一起生成 probe-figs/kuva1.png（一张小红图），所以生成完别挪动 PDF ——
# 相对路径的那几条就是靠它和 PDF 的相对位置才找得到的。绝对路径的那两条写的是生成
# 当时的位置，挪了就失效。

import os
import struct
import sys
import zlib

REL = "probe-figs/kuva1.png"


def tiny_png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def literal(text: str) -> bytes:
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return b"(" + escaped.encode("latin1", "replace") + b")"


def utf16(text: str) -> bytes:
    return b"<" + (b"\xfe\xff" + text.encode("utf-16-be")).hex().upper().encode() + b">"


def variants(abs_path: str) -> list[tuple[str, bytes]]:
    """(给人看的说明, 动作字典)。"""
    rel_spec = b"<< /Type /Filespec /F " + literal(REL) + b" /UF " + utf16(REL) + b" >>"
    abs_spec = b"<< /Type /Filespec /F " + literal(abs_path) + b" /UF " + utf16(abs_path) + b" >>"
    return [
        ("1 Launch + Filespec + relative path",
         b"<< /S /Launch /F " + rel_spec + b" >>"),
        ("2 Launch + plain string + relative path",
         b"<< /S /Launch /F " + literal(REL) + b" >>"),
        ("3 Launch + Filespec + absolute path",
         b"<< /S /Launch /F " + abs_spec + b" >>"),
        ("4 URI action + relative path",
         b"<< /S /URI /URI " + literal(REL) + b" >>"),
        ("5 URI action + ./relative path",
         b"<< /S /URI /URI " + literal("./" + REL) + b" >>"),
        ("6 URI action + absolute file:// URL",
         b"<< /S /URI /URI " + literal("file://" + abs_path) + b" >>"),
        ("7 GoToR + Filespec + relative path  (what pdf-links.py writes)",
         b"<< /S /GoToR /F " + rel_spec + b" /D [0 /Fit] >>"),
        ("8 GoToR + plain string + relative path",
         b"<< /S /GoToR /F " + literal(REL) + b" /D [0 /Fit] >>"),
    ]


def main(out_path: str) -> int:
    out_dir = os.path.dirname(os.path.abspath(out_path)) or "."
    fig_path = os.path.join(out_dir, REL.replace("/", os.sep))
    os.makedirs(os.path.dirname(fig_path), exist_ok=True)
    with open(fig_path, "wb") as fh:
        fh.write(tiny_png(64, 64, (220, 60, 60)))

    rows = variants(fig_path)
    objs = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        5: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    }
    text = [b"BT 14 0 0 14 40 790 Tm /F1 1 Tf (Click each line. Which one opens the red square?) Tj ET\n"]
    annots = []
    for i, (label, action) in enumerate(rows):
        top = 750 - i * 30
        annot, act = 10 + i * 2, 11 + i * 2
        text.append(b"BT 11 0 0 11 40 %d Tm /F1 1 Tf " % top + literal(label) + b" Tj ET\n")
        objs[annot] = (b"<< /Type /Annot /Subtype /Link /Border [ 0 0 1 ]"
                       b" /Rect [38 %d 560 %d] /A %d 0 R >>" % (top - 4, top + 14, act))
        objs[act] = b"<< /Type /Action " + action[3:]
        annots.append(b"%d 0 R" % annot)

    body = b"q 0 0 1 RG 0.6 w\n" + b"".join(text) + b"Q\n"
    objs[4] = b"<< /Length %d >>\nstream\n" % len(body) + body + b"endstream"
    objs[3] = (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]"
               b" /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R"
               b" /Annots [" + b" ".join(annots) + b"] >>")

    out = bytearray(b"%PDF-1.4\n")
    offsets: dict[int, int] = {}
    for num in sorted(objs):
        offsets[num] = len(out)
        out += b"%d 0 obj\n" % num + objs[num] + b"\nendobj\n"
    xref_at = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (max(objs) + 1)
    for num in range(1, max(objs) + 1):
        out += b"%010d 00000 n \n" % offsets.get(num, 0)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (max(objs) + 1, xref_at)
    with open(out_path, "wb") as fh:
        fh.write(out)

    print(f"写好了 {out_path}，图片在 {fig_path}")
    print("拿阅读器打开，挨个点那 8 行，看哪一行能打开那张小红图。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "link-probe.pdf"))
