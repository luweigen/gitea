#!/usr/bin/env python3
# Copyright 2026 The Gitea Authors. All rights reserved.
# SPDX-License-Identifier: MIT
#
# 造一份最小的、模仿 Safari 打印输出写法的 PDF：键按字母序排（/A 在 /Subtype 前面），
# 动作和 URI 各是单独的对象。里面放四条链接：同目录的另一个 Markdown、两张在
# `taulukko-figs/` 子目录里的图片、一条站外链接。
#
# 用法: python3 make-fixture.py 输出.pdf [--only-figs]
#
# --only-figs 只留两条图片链接，模拟页内锚点都成了文档内跳转之后的样子：这时候
# 所有链接都挤在图片目录里，猜"文档所在目录"不能直接取公共前缀。

import sys

BASE = "http://x/docs"
LINKS = [
    f"{BASE}/taulukko.en.md",
    f"{BASE}/taulukko-figs/kuva1.png",
    f"{BASE}/taulukko-figs/alikansio/kuva2.PNG",
    "https://github.com/example/repo",
]
if "--only-figs" in sys.argv:
    sys.argv.remove("--only-figs")
    LINKS = [u for u in LINKS if u.endswith((".png", ".PNG"))]

objs = {
    1: b"<< /Type /Catalog /Pages 2 0 R >>",
    2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]"
        b" /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R"
        b" /Annots [10 0 R 13 0 R 16 0 R 19 0 R] >>"),
    5: b"<< /Type /Font /Subtype /TrueType /BaseFont /Helvetica /Encoding /MacRomanEncoding >>",
}
# 注解、动作、URI 各占一个对象，和 Safari 一样；键也按字母序排
for i, url in enumerate(LINKS):
    annot, action, uri = 10 + i * 3, 11 + i * 3, 12 + i * 3
    top = 700 - i * 30
    objs[annot] = (b"<< /A %d 0 R /Border [ 0 0 0 ] /Type /Annot /Subtype /Link"
                   b" /Rect [50 %d 300 %d] >>" % (action, top, top + 20))
    objs[action] = b"<< /Type /Action /S /URI /URI %d 0 R >>" % uri
    objs[uri] = b"(" + url.encode() + b")"

body = b"q BT 12 0 0 12 50 760 Tm /F1 1 Tf (Sisallys) Tj ET Q\n"
objs[4] = b"<< /Length %d >>\nstream\n" % len(body) + body + b"endstream"

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

out_path = sys.argv[1] if len(sys.argv) > 1 else "fixture.pdf"
open(out_path, "wb").write(out)
print(f"写好了 {out_path}")
