# Mermaid 缩放/平移查看器（mermaid pan-zoom viewer）

`footer.tmpl` 是一个 **纯自定义模板** 的方案：不需要修改 Gitea 源码或重新编译前端资源，
即可把 Markdown 里的 ```` ```mermaid ```` 代码块渲染成可交互的图形，替代 Gitea 内置的
静态 iframe 渲染。提供：

* **滚轮缩放、拖拽平移**（svg-pan-zoom），另有放大 / 缩小 / 重置 / 适应四个按钮。
* **ELK 布局支持**（`@mermaid-js/layout-elk`），复杂 flowchart 可用
  `---\nconfig:\n  layout: elk\n---` 前置配置获得更好的布局。
* **高度自适应**：容器高度按图形宽高比随页面宽度等比伸缩，也可配置封顶或固定高度。
* **导出 PNG**：一键把当前图形按自然尺寸 2 倍分辨率导出为 PNG 文件。
* 跟随 Gitea 主题：暗色主题下使用 mermaid 的 `dark` 主题与站点背景色。

## 安装

把 `footer.tmpl` 复制到自定义模板目录下的 `custom/footer.tmpl`：

```sh
mkdir -p $GITEA_CUSTOM/templates/custom
cp contrib/mermaid-pan-zoom/footer.tmpl $GITEA_CUSTOM/templates/custom/footer.tmpl
```

`$GITEA_CUSTOM` 默认是 Gitea 工作目录下的 `custom/`，最终路径通常是
`custom/templates/custom/footer.tmpl`。

如果该文件已经存在，请把 `footer.tmpl` 的内容追加到现有文件末尾，不要直接覆盖。

生产模式下模板不会热加载，安装后执行：

```sh
gitea manager reload-templates
```

或重启 Gitea 即可生效。

**注意**：脚本从 jsDelivr CDN 加载 mermaid、layout-elk 与 svg-pan-zoom，浏览器需要能访问
外网。内网部署时把三个包下载到 `$GITEA_CUSTOM/public/assets/` 下，并把文件顶部的三个
`import` 改成对应的 `/assets/...` 路径即可。

## 原理

* `templates/base/footer.tmpl` 在 `</body>` 之前会渲染 `{{template "custom/footer" .}}`，
  因此自定义模板可以在每个页面注入 `<script>`。
* 脚本用 `MutationObserver` 监听页面中出现的 `code.language-mermaid` 代码块，
  抢在 Gitea 内置渲染之前接管：给外层 `<pre>` 同时打上 `data-render-done`（旧版
  内置渲染器的守卫属性）和 `data-markup-mermaid-rendered`（1.25+ 的守卫属性），
  然后调用 `mermaid.render()` 生成 SVG 并整体替换 `<pre>`。
* 高度自适应从 SVG 的 `viewBox` 读取图形真实宽高比，按容器宽度等比换算高度；
  `ResizeObserver` 在页面宽度变化时重算并让 pan-zoom 重新 fit/center。
* 导出 PNG 使用 `mermaid.render()` 返回的 **原始 SVG 字符串**（不是页面里被
  pan-zoom 包上 transform 的 DOM），按 `viewBox` 自然尺寸放大后经
  Blob URL → `Image` → 离屏 canvas → `canvas.toBlob('image/png')` 下载，
  因此无论当前缩放/平移到哪里，导出的都是完整图形。canvas 先用容器背景色
  （`--color-box-body` 的计算值）铺底，暗色主题导出深色底、亮色主题导出白底。

## 可配置项

都在 `footer.tmpl` 顶部：

* `MIN_HEIGHT` / `MAX_HEIGHT`：容器高度范围。`MAX_HEIGHT = 0` 表示不封顶（默认，
  框高完全随图形增长）；设为正数则封顶到该值，超出部分用缩放/平移查看；
  两者设为同一正数（如 500）则固定高度。
* `EXPORT_SCALE`：导出 PNG 相对自然尺寸的放大倍数，默认 2，越大文字越清晰、文件越大。
* 想导出固定白底而不是主题背景色，把 `exportPng` 里的 `ctx.fillStyle` 赋值
  改成 `ctx.fillStyle = '#ffffff'`。

## 已知限制

* mermaid 主题在页面加载时按当前 Gitea 主题选定，切换主题后需刷新页面已渲染的图才会跟随。
* mermaid 11 的 flowchart 默认用 `htmlLabels`（`foreignObject`）渲染标签，
  Chrome / Firefox 导出 PNG 正常，Safari 把这类 SVG 画到 canvas 时标签可能空白；
  如有此问题，在 `mermaid.initialize` 里加 `flowchart: {htmlLabels: false}` 规避。
* 与内置渲染是"先到先得"的竞态：本脚本经 CDN ESM 加载，正常情况下先于 Gitea
  懒加载的 mermaid chunk 完成接管；极端网络条件下若内置渲染抢先，该代码块会
  退回内置的静态 iframe 显示，不会重复渲染或报错。
