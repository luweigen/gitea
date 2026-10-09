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

3. **Safari 解析不了带非 ASCII 的片段。** 同一篇芬兰语文档里，`#1-ennen-kuin-luet-taulukkoa`
   能跳到文档内，`#2-kentät-yhdellä-silmäyksellä` 就退化成跳回网站；整篇中文文档的锚点
   因此一条都跳不了。

所以 `beforeprint` 时会按 Gitea 自己 `scrollToAnchor` 的找法定位目标元素（先补
`user-content-` 前缀，再试 `a[name]`，最后按原样），把链接改写成 `#目标真实的 id`，
打印结束再还原；`a[name]` 这类没有 id 的目标会临时加一个 id。目标 id 里有非 ASCII 字符的
（第 3 种情况），打印期间还会临时换成 `pd-` 开头的纯 ASCII id —— 原 id 的每个字节按 `.hh`
转义，比如 `user-content-2-kentät…` 变成 `pd-user-content-2-kent.c3.a4t…`。已经是 ASCII 的
id 原样不动，Chrome 那边的命名目标还能保持可读。

改写后的效果（在 Chromium 上实测）：

| 链接 | PDF 里 |
| --- | --- |
| 目录里的 `[x](#某标题)`（前端抹掉前缀后指向不存在的 id） | 内部跳转 |
| 标题带非 ASCII 字符的锚点（Safari 原本跳不了） | 内部跳转 |
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
* **Safari 只认 ASCII 片段。** 实测 Safari 17.6：改写本身是生效的（打印媒体查询的
  `change` 在 Safari 上会触发，`beforeprint` / `afterprint` 不会，所以两套都挂着），
  纯 ASCII 的片段会写成文档内跳转，带非 ASCII 的则还原成"页面地址 + 片段"的绝对 URL，
  成了普通网页链接 —— 上面给非 ASCII 目标换 ASCII id 就是为了这个。
  另外同一篇文档 Chrome 写 43 条注解、Safari 只有 11 条：图片上的链接 Safari 不写。

### 自查工具 / 图片链接改本地

`pdf-links.py` 列出一份 PDF 里每条链接是内部跳转、网页链接还是打开本地文件，并报告它用的
是哪种命名目标机制：

```sh
python3 contrib/print-markdown/pdf-links.py out.pdf --dry-run
```

不加 `--dry-run` 时，它还会把**和本文档同目录的图片链接**改成打开 PDF 旁边同样相对位置的
那个文件，**改好的那份仍叫原来的名字，原件改名加 `-web` 后缀留着**：

```sh
python3 contrib/print-markdown/pdf-links.py safari.pdf
```

```
把这个目录当作本文档所在目录: https://git.example.com/…/docs/
  图片 字段说明-figs/fig4_1.png  ->  打开本地同名文件
  …
改了 16 条链接。原件留在 safari-web.pdf，改好的还叫 safari.pdf。
```

**怎么算相对路径**：Gitea 给图片写的 URL 就落在文档自己所在目录下面，前缀一减就是 Markdown
里原本写的相对路径（`字段说明-figs/fig4_1.png`），写成 PDF 的 `/GoToR` 动作（为什么不是
看起来更对口的 `/Launch`，见下一节）。

**所在目录是怎么猜的**：取同一站点下所有链接的最长公共目录前缀 —— 图片在
`docs/某文档-figs/` 里、同目录还有别的文件链接时，公共前缀正好是 `docs/`。但页内锚点现在
都是文档内跳转、不再算链接，常常**只剩下图片链接**，这时公共前缀就是图片目录本身，照它
相减会把 `某文档-figs/` 这一段吃掉、算出一条找不到文件的路径。所以前缀落在名字像放图的
目录上时（`-figs`、`-images`、`assets` 这类）会自动往上取一级；所有链接都在同一个目录、
又看不出那是图片目录时，宁可报"说不准"也不乱猜，这时用 `--base-url` 指定。脚本每次都会把
认定的目录打出来，**值得扫一眼**。

所以要把 PDF 和图片目录按原来的相对位置放在一起才点得开 —— PDF 放在 `docs/` 里、
`docs/某文档-figs/` 还在旁边。只改图片扩展名的链接，指向其它 Markdown 文件之类的保持原样
（打开本地 `.md` 源文件没什么用）。

**怎么写出去**：**增量更新** —— 原文件的字节一个不动，改过的注解对象追加在后面，再补一张
新的 xref 表。只支持传统 xref 表的 PDF（Safari 就是），交叉引用流的会直接跳过。重复跑是
安全的：改过的链接已经不是网页链接了，第二次跑会报"没有可以改的链接"，不会再生成一个
`-web`。

页内锚点不归它管：上面模板那一步做完，Chrome 和 Safari 写出来的就已经是文档内跳转了。

各家浏览器的写法差别很大，所以脚本是整个注解字典一起看、间接引用也跟进去的：Chrome 把值
直接写在注解里、键按出现顺序排；Safari 按字母序排键（`/A` 在 `/Subtype` 前面），动作和 URI
还都是单独的对象。内部跳转的几种写法（`/Dest` 给名字、字符串或数组，以及 `/A <</S /GoTo>>`
动作）都认，认不出来的注解会原样打出来，不会悄悄漏掉。只用 Python 标准库，按字节扫描，
不解析加密的 PDF。

### 为什么是 /GoToR

"从 PDF 打开一个本地文件"有好几种写法，各家阅读器认哪种差别很大，而且不认的时候往往
一声不吭。`test/make-link-probe.py` 造一张"试纸"：一页 PDF，八行链接都指向同一张图片，
每行换一种写法。它会在 PDF 旁边一起生成 `probe-figs/kuva1.png`，所以生成完别挪动 PDF：

```sh
python3 contrib/print-markdown/test/make-link-probe.py ~/Desktop/link-probe.pdf
```

macOS 预览（15.x）上挨个点的结果：

| 写法 | 结果 |
| --- | --- |
| `/Launch` + 文件说明 / 纯字符串 / 绝对路径 | 只"嘟"一声，什么也不做 |
| `/URI` + `file://` 绝对地址 | 同上 |
| `/URI` + 相对路径（带不带 `./` 都一样） | 弹出路径和"用其它 App 打开"，选了报"应用程序无法打开 -50" |
| **`/GoToR` + 文件说明 / 纯字符串** | **能打开**（第一次要授权，见下） |

所以脚本写的是 `/GoToR` + 文件说明（文件说明比纯字符串多一个 `/UF`，非 ASCII 文件名要靠它）。

**第一次要授权**：预览是沙箱应用，第一次点会说没权限。在访达里对那张图片（或整个图片
目录）按一次 ⌘I 看一下简介，之后预览就能打开了 —— 这一步是 macOS 的沙箱授权，和 PDF
本身无关。顺带一提，`/Launch` 被拒时系统日志里什么都不写（连沙箱拒绝都没有），就是
预览压根不执行这个动作。

换别的阅读器（Acrobat、Skim）结果可能不同，拿这张试纸点一遍就知道。

`test/run.sh` 是一小段回归检查：造一份模仿 Safari 写法的 PDF，确认所在目录猜得对、子目录和
大写扩展名的图片都改到、同目录的 `.md` 和站外链接不动、原件改名留着、重复跑不会再改一遍。

## 可选调整

* 想让 Wiki 页面也生效，把条件改成 `{{if or .IsMarkup .PageIsWiki}}`，
  并补上 `.wiki-content-toc`、`.wiki-content-sidebar` 的隐藏规则。
* 想调整正文字号或页边距，修改 `.file-view.markup` 的 `font-size` 与 `@page { margin }`。
