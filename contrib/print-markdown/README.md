# 打印 Markdown 渲染视图（print-friendly markup view）

`header.tmpl` 是一个 **纯自定义模板** 的方案：不需要修改 Gitea 源码或重新编译前端资源，
即可让 Markdown（以及 AsciiDoc / Org 等所有 `.IsMarkup` 渲染视图）在浏览器里按 Web 上
看到的排版打印，同时去掉站点导航、仓库头、文件工具条、文件树、页脚等正文以外的内容。

## 安装

把 `header.tmpl` 复制到自定义模板目录下的 `custom/header.tmpl`：

```sh
mkdir -p $GITEA_CUSTOM/templates/custom
cp contrib/print-markdown/header.tmpl $GITEA_CUSTOM/templates/custom/header.tmpl
```

`$GITEA_CUSTOM` 默认是 Gitea 工作目录下的 `custom/`，最终路径通常是
`custom/templates/custom/header.tmpl`。

如果该文件已经存在，请把 `header.tmpl` 的内容追加到现有文件末尾，不要直接覆盖。

生产模式下模板不会热加载，安装后执行：

```sh
gitea manager reload-templates
```

或重启 Gitea 即可生效。

## 原理

* `templates/base/head.tmpl` 在 `</head>` 之前会渲染 `{{template "custom/header" .}}`，
  并传入完整的页面上下文，因此自定义模板可以注入任意 `<style>` / `<script>`。
* `routers/web/repo/view_file.go` 与 `view_readme.go` 会设置 `IsMarkup` / `MarkupType`，
  所以模板用 `{{if .IsMarkup}}` 就能只在渲染视图注入，源码视图（`?display=source`）
  和其它页面不受影响。
* 所有规则都写在 `@media print` 里，屏幕显示完全不变。

## 已处理的细节

* 打印时强制亮色配色，避免使用暗色主题的用户打印出浅灰色文字。
* 隐藏 `#navbar`、`.secondary-nav`、`.page-footer`、`.repo-button-row`、
  `.repository-summary`、`.repo-view-file-tree-container`、`#repo-file-commit-box`、
  `.file-header`、标题锚点图标、代码块复制按钮、tooltip 等元素。
* 去掉 `.ui.container` 的限宽居中与卡片边框，让正文占满纸张宽度。
* `web_src/css/markup/content.css` 中 `.markup` 的 `overflow: hidden` 和
  `table { display: block; overflow: auto }` 在打印时会截断内容，这里改回
  `overflow: visible` / `display: table`。
* 代码块 `white-space: pre-wrap` 换行；标题 `break-after: avoid`；
  表格行、图片、引用块 `break-inside: avoid`；`@page` 设置页边距。
* 通过 `print-color-adjust: exact` 保留代码块与表格的浅色底纹，效果与网页一致。
* 隐藏 YAML front matter 渲染出的 `details.frontmatter-content` 表格（`modules/markup/markdown/convertyaml.go`），
  打印内容从正文第一个标题开始。
* 打印前把指向本页自身的锚点链接改写成裸 `#fragment`，打印成 PDF 时它们会变成
  PDF 内部跳转而不是跳回网站的外链（见下一节），打印后还原。
* `beforeprint` / `afterprint` 事件自动展开再还原 `<details>` 折叠块
  （折叠内容无法仅用 CSS 可靠展开）；front matter 的 `details` 被排除在外，不会被展开。

页面里的 mermaid 图由 `contrib/mermaid-pan-zoom` 自己负责打印适配（打印时换成一份按
页幅宽度等比缩放的静态副本，详见该目录的 README），本样式表不需要为它额外配置。

## 打印成 PDF 时的链接

浏览器把页面里的链接写进 PDF 时有两种形式：跳到文档内某处的**内部跳转**（PDF 里的
`/Dest`），和打开浏览器的**网页链接**（`/Action /URI`）。Chromium 生成内部跳转的条件是
链接 URL 与当前文档 URL 完全一致（**query 不同也算不一致**）且片段在本页能找到。

Gitea 这边有两处会让页内链接打印出来不对：

1. **目录里的链接在 PDF 里直接消失。** 后端给标题的 id 带 `user-content-` 前缀
   （`<h2 id="user-content-1-这张表是怎么来的">`），链接也带（`#user-content-1-%E8%BF%99...`），
   但前端 `web_src/js/markup/anchors.ts` 会把链接上的前缀**抹掉**，只在 click 时用 JS
   把前缀补回去再滚动。于是页面上链接指向的 id 根本不存在 —— 浏览器打印时找不到目标，
   这条链接在 PDF 里既不是跳转也不是外链，**连注解都不生成**。
2. **被展开成绝对路径的锚点链接成了外链。** Gitea 把相对链接重写成不带 query 的绝对
   仓库路径，而文件视图地址常带 `?display=rendered`，两者对不上。

所以 `beforeprint` 时会按 Gitea 自己 `scrollToAnchor` 的找法定位目标元素（先补
`user-content-` 前缀，再试 `a[name]`，最后按原样），把链接改写成 `#目标真实的 id`，
打印结束再还原；`a[name]` 这类没有 id 的目标会临时加一个 id，打印后删掉。

改写后的效果（在 Chromium 上实测）：

| 链接 | PDF 里 |
| --- | --- |
| 目录里的 `[x](#某标题)`（前端抹掉前缀后指向不存在的 id） | 内部跳转 |
| 用户自己写的 `<a name="x">` 锚点 | 内部跳转 |
| 被 Gitea 展开成绝对仓库路径、指回本文件的锚点链接 | 内部跳转 |
| 指向折叠块里标题的锚点（打印时折叠块已展开） | 内部跳转 |
| 脚注与脚注返回链接（`#fn:user-content-1` / `#fnref:...`） | 内部跳转 |
| 片段在本页找不到的链接 | 保留网页链接（避免造出点不动的跳转） |
| `?display=source` 等指向同一文件另一个视图的链接 | 保留网页链接 |
| 指向仓库里其它文件的链接 | 保留网页链接（目标不在这份 PDF 里） |
| 站外链接 | 保留网页链接 |

中文标题也可以：PDF 的命名目标用百分号编码加 `#` 转义写入，名称树里能对上。

### 浏览器与阅读器的差异

这一步依赖浏览器在打印时生成链接注解，上表是在 Chromium（Chrome / Edge）上验证的。
两个已知的坑：

* **Chrome 出的 PDF 是好的。** 命名目标放在文档目录的 `/Dests` 字典里（PDF 1.1 的办法，
  不是 PDF 1.2 起的 `/Names` 名称树；Chrome 的普通输出、tagged 输出、带大纲的输出都只写
  这种，页面这边改不了），实测 macOS 预览能正常跳转。
* **Safari 不生成文档内部跳转。** 实测 Safari 17.6：改写本身是生效的（打印媒体查询的
  `change` 在 Safari 上会触发，`beforeprint` / `afterprint` 不会，所以两套都挂着），
  但 Safari 把裸 `#fragment` 还原成"页面地址 + 片段"的绝对 URL，写成普通的网页链接。
  想要能跳的 PDF，要么用 Chrome 打印，要么用下面的 `pdf-links.py` 把 Safari 的成品改一遍。

### 自查工具

`pdf-links.py` 列出一份 PDF 里每条链接是内部跳转还是网页链接，并报告它用的是哪种命名
目标机制 —— 用来区分"浏览器没生成内部跳转"和"阅读器不跟这种跳转"：

```sh
python3 contrib/print-markdown/pdf-links.py out.pdf
```

它同时会把两类链接改掉，**改好的那份仍叫原来的名字，原件改名加 `-web` 后缀留着**
（想只看不改就加 `--dry-run`）：

| 原来 | 改成 |
| --- | --- |
| 指回本文档自己某个标题的网页链接 | 文档内跳转（翻到那一页） |
| 和本文档同目录的图片链接 | 打开 PDF 旁边同样相对位置的那个文件 |

```sh
python3 contrib/print-markdown/pdf-links.py safari.pdf
```

```
把这个地址当作本文档自己: https://git.example.com/…/docs/字段说明.md
把这个目录当作本文档所在目录: https://git.example.com/…/docs/
  图片 字段说明-figs/fig4_1.png  ->  打开本地同名文件
  user-content-1-这张表是怎么来的  ->  第 1 页 (1. 这张表是怎么来的)
  user-content-3-字段一览          ->  第 2 页 (3. 字段⼀览)
  …
改了 24 条链接。原件留在 safari-web.pdf，改好的还叫 safari.pdf。
```

**跳转目标是怎么找到的**：把 PDF 的文字按页抽出来，对每一行算出 GitHub 式的 slug，和链接
里的片段对上，就知道该跳到第几页的什么高度。取字时要按字体来：Type0 字体是两字节一个
字形编号、查 ToUnicode；子集的简单字体编号是随便编的（常从 33 开始），也只有 ToUnicode
说了算；没有 ToUnicode 的简单字体按声明的内置编码解 —— Safari 给拉丁文用
`MacRomanEncoding`，按 latin1 读的话 `ä`（0x8A，字面量里写成八进制 `\212`）会读成控制
字符，芬兰语、瑞典语的标题就全对不上。取出来的文字还要做 NFKC 规范化，PingFang 会把
"目"这种字映射成康熙部首。去掉片段后地址相同、出现次数最多的那个
URL 被当作"本文档自己"，只有指向它的链接才会被改；片段找不到对应标题的保留原样，免得造出
点不动的跳转。

**图片**：以"本文档所在目录"为准做前缀相减，剩下的就是相对路径（`字段说明-figs/fig4_1.png`），
写成 PDF 的 `/Launch` 动作。所以要把 PDF 和图片目录按原来的相对位置放在一起才点得开 ——
PDF 放在 `docs/` 里、`docs/字段说明-figs/` 还在旁边。只改图片扩展名的链接，指向其它
Markdown 文件之类的保持原样（打开本地 `.md` 源文件没什么用）。`/Launch` 能不能点开要看
阅读器，有的出于安全考虑会拦。

**怎么写出去**：**增量更新** —— 原文件的字节一个不动，改过的注解对象追加在后面，再补一张
新的 xref 表。只支持传统 xref 表的 PDF（Safari 就是），交叉引用流的会直接跳过 —— Chrome
出的本来就是文档内跳转，不需要改。重复跑是安全的：改过的链接已经不是网页链接了，第二次
跑会报"没有可以改的链接"，不会再生成一个 `-web`。

各家浏览器的写法差别很大，所以脚本是整个注解字典一起看、间接引用也跟进去的：Chrome 把值
直接写在注解里、键按出现顺序排；Safari 按字母序排键（`/A` 在 `/Subtype` 前面），动作和 URI
还都是单独的对象。内部跳转的几种写法（`/Dest` 给名字、字符串或数组，以及 `/A <</S /GoTo>>`
动作）都认，认不出来的注解会原样打出来，不会悄悄漏掉。只用 Python 标准库，按字节扫描，
不解析加密的 PDF。

某条页内链接在输出里**完全没出现**，就说明浏览器没找到它的目标 —— 多半是上面第 1 种情况。

`test/run.sh` 是一小段回归检查：造一份模仿 Safari 写法的 PDF（芬兰语标题，MacRoman 简单
字体和带 ToUnicode 的子集字体各一个），确认两条链接都能改成文档内跳转。

## 可选调整

* 想让 Wiki 页面也生效，把条件改成 `{{if or .IsMarkup .PageIsWiki}}`，
  并补上 `.wiki-content-toc`、`.wiki-content-sidebar` 的隐藏规则。
* 想调整正文字号或页边距，修改 `.file-view.markup` 的 `font-size` 与 `@page { margin }`。
