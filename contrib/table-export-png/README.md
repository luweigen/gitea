# 表格与公式块导出 PNG（export markdown tables and math blocks to PNG）

`body_outer_post.tmpl` 是一个 **纯自定义模板** 的方案：不需要修改 Gitea 源码或重新编译前端资源，
也不引入任何外部依赖，即可在 Markdown（以及 AsciiDoc / Org 等所有 `.markup` 渲染结果）里
给这些内容加一个「⤓ PNG」按钮，点击就把这一块导出成图片：

* **所有表格**；
* **含数学公式（KaTeX）的段落、列表项、引用块、标题、定义列表项**
  —— 不含公式的普通段落不会出现按钮，免得满屏都是按钮。

鼠标移到目标上时按钮出现在右上角，移开即消失；按钮本身不属于被导出的内容，不会进到图里。

## 安装

把 `body_outer_post.tmpl` 复制到自定义模板目录下的 `custom/body_outer_post.tmpl`：

```sh
mkdir -p $GITEA_CUSTOM/templates/custom
cp contrib/table-export-png/body_outer_post.tmpl $GITEA_CUSTOM/templates/custom/body_outer_post.tmpl
```

`$GITEA_CUSTOM` 默认是 Gitea 工作目录下的 `custom/`，最终路径通常是
`custom/templates/custom/body_outer_post.tmpl`。

生产模式下模板不会热加载，安装后执行：

```sh
gitea manager reload-templates
```

或重启 Gitea 即可生效。

> 这里特意用 `body_outer_post.tmpl` 而不是 `header.tmpl` / `footer.tmpl`，
> 是为了和 `contrib/print-markdown`（占用 `custom/header.tmpl`）、
> `contrib/mermaid-pan-zoom`（占用 `custom/footer.tmpl`）并存 —— 三者可以同时安装、互不覆盖。
> Gitea 可用的自定义模板挂载点见 `templates/custom/`：`header`、`footer`、
> `body_inner_pre`、`body_inner_post`、`body_outer_pre`、`body_outer_post` 等。
> 如果这个挂载点已经被别的扩展占用，把本文件的内容**追加**到那个文件末尾即可，
> 脚本放在 `header.tmpl`（此时 `<body>` 尚不存在）里也能正常工作。

## 对页面加载速度的影响

**加载时不扫描 DOM、不改 DOM、不装 MutationObserver**：只创建一个浮动按钮和几个事件监听，
开销与文档长度无关；「这一块能不能导出」推迟到鼠标悬停时才判断。

在一篇 981 KB / 2.3 万个元素 / 606 个 KaTeX 公式 / 420 个段落的长文档上用 headless Chromium 实测：

| 时机 | 动作 | 耗时 |
|---|---|---|
| 页面加载 | 本扩展脚本自身执行（内联在 `</body>` 前，9 次中位数） | **0.80 ms** |
| 页面加载 | FCP / DOMContentLoaded 的有无差异 | 落在机器抖动内 |
| 鼠标悬停 | 判定目标（`closest` + 是否含公式，全文 548 个元素） | **2.9 µs/次** |
| 点击导出 | 407 字含公式段落：重画 26 ms + PNG 编码 51 ms | ~80 ms |
| 点击导出 | 12 行表格：重画 23 ms + PNG 编码 16 ms | ~40 ms |

作为对比，"加载时全量扫描并给每个块预先插按钮"的急切方案在同一篇文档上要 **83 ms** 并触发整篇回流；
而且 Gitea 的 KaTeX 是异步渲染的，急切方案还得靠 MutationObserver 等它渲染完 —— 所以这里没有那么做。

## 原理

浏览器没有「把一段 HTML 截图」的原生接口，常见做法是把 DOM 塞进 SVG 的 `<foreignObject>`
再画进 canvas（html2canvas / dom-to-image 都是这一类），但那条路在 Safari 上画不出内容、
在 Chrome 上还会遇到 canvas 污染（`contrib/mermaid-pan-zoom` 里已经踩过这些坑）。

这里换了个思路：**不做 HTML 光栅化，而是直接用 canvas 2D 把这块内容重画一遍**，
所有位置都向浏览器"问"现成的排版结果：

* `getBoundingClientRect()` 拿到每个元素的位置，逐个画背景色和四条边框
  （颜色、线宽都取自 `getComputedStyle`，因此深浅色主题、斑马纹、引用块竖线都和网页一致）。
* 文本用 `Range.getClientRects()` 拿到**每一个行盒**的位置：自动换行是浏览器排好的，
  脚本只负责把每一行的文字画到对应坐标，不需要自己实现断行；
  只有多行时才会逐字符量一次位置来切分行。
* 字体、字重、斜体、颜色、字距同样来自 `getComputedStyle`，粗体、`` `行内代码` ``、
  *斜体*、~~删除线~~、链接色都能还原；canvas 的字体回退和页面偶有差异时，
  会按行盒宽度做一次横向微调，保证不串列。
* 图片、内联 `<svg>`、任务列表复选框分别按图片 / data-URL 图片 / 手绘方框处理。
* 列表项前面的 `•` / `1.` 是浏览器画的 `::marker`，DOM 里没有对应节点也量不到位置，
  按首行位置和实测间距补画一个。

因为全程只用 canvas 2D，不涉及 `foreignObject`，Chrome / Firefox / Safari 表现一致，
也不会因为 canvas 被污染而导出失败。

## 已处理的细节

* **导出范围按"真正会留下痕迹的东西"计算**：有背景/边框的盒子、图片、复选框、文字行盒的并集。
  于是表格不会带上 `width:100%` 造成的右侧空白（`display:block; overflow:auto` 横向滚动出去的列
  也不会丢），段落和列表项则紧贴文字裁剪，而不是按容器宽度导出一大片空白。
* **数学公式不重影**：KaTeX 渲染每个公式时会同时输出两份 —— 一份只给读屏软件的 MathML
  （用 `clip-path: inset(50%)` 裁成 1px，但并不是 `display:none`）和一份可见的 HTML。
  逐个元素判断可见性会把两份都画出来，公式就重影了；脚本按树剪枝，遇到这类「视觉隐藏」的
  元素直接跳过整棵子树。文件名取标题文字时同样会先去掉这份 MathML。
* **引用块整块导出**：悬停在引用块内的段落上，导出的是整个 `blockquote`（连左边的竖线）。
  同理，悬停在表格单元格里的段落上，导出的仍是整张表。
* **不会透明底**：底色取向上第一个不透明祖先的背景色，深色主题导出的就是深色底图。
* **两倍分辨率**：默认 `EXPORT_SCALE = 2`，文字清晰、可直接贴进文档或聊天窗口；
  超大内容会自动降低倍率，避免超过浏览器的 canvas 尺寸上限。
* **跨域图片**：会污染 canvas 导致 `toBlob` 直接抛 `SecurityError`，脚本主动跳过它们
  并在控制台给出提示，其余部分照常导出。
* **文件名**：取前面最近的标题（没有就取页面标题）加类型和序号，例如 `功能对比-table-1.png`、
  `符号说明-li-3.png`。
* **不改动页面 DOM**：按钮是一个 `position:fixed` 的公共元素，不包裹、不修改内容本身，
  因此不会影响 Gitea 自己的样式和脚本；issue 评论、Wiki、Release 说明等异步加载的
  `.markup` 内容也无需额外处理。

## 可选调整

打开模板顶部的几个常量即可：

* `EXPORT_SCALE`：导出倍率，`1` 为与屏幕等大，调大文字更清晰、文件更大。
* `PADDING`：四周的留白像素。
* `MAX_CANVAS_SIDE`：canvas 单边上限，超过就自动降倍率。
* `TABLE_SELECTOR`：默认 `.markup table`，即所有渲染视图里的表格。
* `BLOCK_SELECTOR`：默认 `p, li, blockquote, dd, dt, h1..h6`（都限定在 `.markup` 内）。
  想给所有段落都加按钮（不要求含公式），把 `exportTarget()` 里的 `hasMath(block)` 判断去掉即可。
* `MATH_SELECTOR`：默认 `.katex`，即 KaTeX 渲染出来的公式。

## 已知限制

* 只重画常见内容：背景、边框、文字、图片、内联 SVG、复选框、列表符号。
  圆角、阴影、背景渐变、`clip-path` 等效果不会还原。
* 虚线/点线边框按实线画。
* 列表符号的位置是按 Chromium 实测的经验间距补画的（数字 0.45em、圆点 0.65em），
  其它浏览器可能有一两像素的出入；`lower-roman` 等不常见的编号类型会退回成阿拉伯数字。
* 不模拟 `overflow: hidden` 的裁剪，极少数靠裁剪成形的元素（例如 KaTeX 的拉伸箭头）
  可能画出本该被裁掉的部分。
* 折叠起来的 `<details>`、`display:none` 的内容不会出现在图里（和肉眼所见一致）。
* 跨域图片（例如外链图床）会被跳过，导出的图里该位置是空白。
