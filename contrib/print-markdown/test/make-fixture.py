#!/usr/bin/env python3
# Copyright 2026 The Gitea Authors. All rights reserved.
# SPDX-License-Identifier: MIT
#
# 造一份最小的、模仿 Safari 打印输出写法的 PDF：第 1 页是目录（两条指回本文档的
# 网页链接），第 2 页是两个芬兰语标题 —— 一个用 MacRomanEncoding 的简单字体（ä 是
# 八进制转义的 \\212），一个用编号从 33 开始、只有 ToUnicode 说了算的子集字体。
# 这两种写法按 latin1 读都会把 ä 读坏，标题 slug 就和链接里的片段对不上。
#
# 用法: python3 make-fixture.py 输出.pdf

import sys
import urllib.parse

BASE = "http://x/docs/taulukko.md"

def content(text_bytes, font, y):
    return (b"q 0.75 0 0 -0.75 50 " + str(y).encode() + b" cm BT 20 0 0 -20 0 0 Tm /"
            + font + b" 1 Tf (" + text_bytes + b") Tj ET Q\n")

# MacRoman: ä = 0x8A -> 八进制 \212
mac = b"2. Kent\\212t yhdell\\212 silm\\212yksell\\212"
# 子集字体：编号从 33 开始随便编，靠 ToUnicode 还原 "3. Ehdokaspisteiden kentät"
subset_text = "3. Ehdokaspisteiden kentät"
codes = {ch: 33 + i for i, ch in enumerate(dict.fromkeys(subset_text))}
subset = "".join(f"\\{codes[ch]:03o}" for ch in subset_text).encode()
cmap = ("/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
        "1 begincodespacerange <00><FF> endcodespacerange\n"
        f"{len(codes)} beginbfchar\n"
        + "".join(f"<{c:02X}> <{ord(ch):04X}>\n" for ch, c in codes.items())
        + "endbfchar\nendcmap\nend end").encode()

objs = {
    1: b"<< /Type /Catalog /Pages 2 0 R >>",
    2: b"<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    3: (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >>"
        b" /Contents 4 0 R /Annots [11 0 R 14 0 R] >>"),
    5: b"<< /Type /Font /Subtype /TrueType /BaseFont /Helvetica /Encoding /MacRomanEncoding >>",
    6: (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 9 0 R >> >>"
        b" /Contents 7 0 R >>"),
    9: b"<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+Sub /ToUnicode 10 0 R /FirstChar 33 /LastChar 99 >>",
    11: b"<< /Type /Annot /Subtype /Link /Rect [50 700 300 720] /Border [0 0 0] /A 12 0 R >>",
    12: b"<< /Type /Action /S /URI /URI 13 0 R >>",
    14: b"<< /Type /Annot /Subtype /Link /Rect [50 670 300 690] /Border [0 0 0] /A 15 0 R >>",
    15: b"<< /Type /Action /S /URI /URI 16 0 R >>",
    17: b"<< /Type /Annot /Subtype /Link /Rect [50 640 300 660] /Border [0 0 0] /A 18 0 R >>",
    18: b"<< /Type /Action /S /URI /URI 19 0 R >>",
}
frag2 = urllib.parse.quote("user-content-2-kentät-yhdellä-silmäyksellä")
frag3 = urllib.parse.quote("user-content-3-ehdokaspisteiden-kentät")
# 第三条用的是 header.tmpl 打印时换上的纯 ASCII id（每个字节 .hh 转义），
# 脚本要能解回原来的 id 才找得到标题
frag4 = "pd-user-content-4-mittausalueiden-kent.c3.a4t"
objs[13] = b"(" + f"{BASE}#{frag2}".encode() + b")"
objs[16] = b"(" + f"{BASE}#{frag3}".encode() + b")"
objs[19] = b"(" + f"{BASE}#{frag4}".encode() + b")"

# 第 1 页是目录（链接在这儿），第 2 页是两个标题
page1 = content(b"Sisallys", b"F1", 760)
page2 = (content(mac, b"F1", 600) + content(subset, b"F2", 500)
         + content(b"4. Mittausalueiden kent\\212t", b"F1", 400))
for num, body in ((4, page1), (7, page2), (10, cmap)):
    objs[num] = b"<< /Length %d >>\nstream\n" % len(body) + body + b"endstream"

out = bytearray(b"%PDF-1.3\n")
offsets = {}
for num in sorted(objs):
    offsets[num] = len(out)
    out += b"%d 0 obj\n" % num + objs[num] + b"\nendobj\n"
xref_at = len(out)
out += b"xref\n0 %d\n" % (max(objs) + 1)
out += b"0000000000 65535 f \n"
for num in range(1, max(objs) + 1):
    out += b"%010d 00000 n \n" % offsets.get(num, 0)
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (max(objs) + 1, xref_at)
out_path = sys.argv[1] if len(sys.argv) > 1 else "fi.pdf"
open(out_path, "wb").write(out)
print(f"写好了 {out_path}")
