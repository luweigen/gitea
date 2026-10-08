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

Gitea 会把 Markdown 里的相对链接重写成不带 query 的绝对仓库路径，而文件视图的地址常常
带着 `?display=rendered`，两者对不上，这类链接在 PDF 里就成了跳回网站的外链。所以
`beforeprint` 时会把**指向本页自身**的链接统一改写成裸 `#fragment`，打印结束再还原。

改写后的效果（在 Chromium 上实测）：

| 链接 | PDF 里 |
| --- | --- |
| `#user-content-某标题`（Gitea 对 `[x](#某标题)` 的重写） | 内部跳转 |
| 被 Gitea 展开成绝对仓库路径、指回本文件的锚点链接 | 内部跳转 |
| 指向折叠块里标题的锚点（打印时折叠块已展开） | 内部跳转 |
| 脚注与脚注返回链接（`#fn:user-content-1` / `#fnref:...`） | 内部跳转 |
| 片段在本页找不到的链接 | 保留网页链接（避免造出点不动的跳转） |
| `?display=source` 等指向同一文件另一个视图的链接 | 保留网页链接 |
| 指向仓库里其它文件的链接 | 保留网页链接（目标不在这份 PDF 里） |
| 站外链接 | 保留网页链接 |

中文标题也可以：PDF 的命名目标用百分号编码加 `#` 转义写入，名称树里能对上。

注意这依赖浏览器在打印时生成链接注解，上面是在 Chromium（Chrome / Edge）上验证的；
其它浏览器的打印输出是否带链接未测。

## 可选调整

* 想让 Wiki 页面也生效，把条件改成 `{{if or .IsMarkup .PageIsWiki}}`，
  并补上 `.wiki-content-toc`、`.wiki-content-sidebar` 的隐藏规则。
* 想调整正文字号或页边距，修改 `.file-view.markup` 的 `font-size` 与 `@page { margin }`。
