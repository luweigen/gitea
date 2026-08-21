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
* `beforeprint` / `afterprint` 事件自动展开再还原 `<details>` 折叠块
  （折叠内容无法仅用 CSS 可靠展开）。

## 可选调整

* 想让 Wiki 页面也生效，把条件改成 `{{if or .IsMarkup .PageIsWiki}}`，
  并补上 `.wiki-content-toc`、`.wiki-content-sidebar` 的隐藏规则。
* 想调整正文字号或页边距，修改 `.file-view.markup` 的 `font-size` 与 `@page { margin }`。
