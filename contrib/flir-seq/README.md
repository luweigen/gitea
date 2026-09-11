# FLIR 热成像序列查看器（flir-seq）

在 Gitea 的文件浏览页面里直接显示仓库中的 FLIR 辐射测温文件（`.seq` / `.fff`），
并读出任意像素点的温度。**不需要改动 Gitea 源码，不需要重新编译前端，也不需要
改 `app.ini`**：只往 `CUSTOM_PATH` 里放一个自定义模板和两个静态文件即可。

提供：

* **热像显示**：把 16 位原始计数按调色板渲染成图像，铁红 / 彩虹 / 白热 / 黑热 /
  极地五种调色板，右侧带温标色条。
* **点测温**：鼠标移到图像上实时读出该点温度与原始计数；**单击落一个测温点**，
  测温点列表随帧与参数实时刷新，可逐个删除。
* **自动最高/最低点**：每帧自动标出最热与最冷像素。
* **缩放平移**：滚轮缩放、拖拽平移、双击复位，便于在 640×480 上精确选点。
* **多帧序列**：`.seq` 通常是多帧，提供逐帧切换、滑块定位与循环播放，并显示每帧
  的采集时间戳。
* **测温参数可调**：发射率、反射表观温度、目标距离、相对湿度、大气透过率、大气温度、
  红外窗口温度与透过率都可现场修改，整幅图与所有测温点立即按新参数重算，一键恢复相机
  设定；面板里会写明当前用的大气透过率是来自文件、手动输入还是估算得到的。
* **温标模式**：本帧自动 / 全序列自动 / 手动上下限。
* **导出**：当前帧导出 PNG（含测温点标注），或导出整帧温度矩阵 CSV。
* **跟随 Gitea 主题**：颜色全部取自 Gitea 的 CSS 变量，明暗主题都正常。
* **多语言界面**：英语 / 简体中文 / 芬兰语，自动跟随 Gitea 当前语言。

全部代码自包含，**零依赖、零 CDN、零外网访问**——脚本只会去取它要显示的那个
原始文件，因此内网、离线部署同样可用。

## 安装

```sh
contrib/flir-seq/install.sh            # 装到 $GITEA_CUSTOM，默认 ./custom
contrib/flir-seq/install.sh /var/lib/gitea/custom
```

安装脚本会写入三个文件：

```
$GITEA_CUSTOM/templates/custom/body_inner_post.tmpl   （追加一段带标记的区块）
$GITEA_CUSTOM/public/assets/js/gitea-flir-seq.js
$GITEA_CUSTOM/public/assets/css/gitea-flir-seq.css
```

然后重载模板即可生效：

```sh
gitea manager reload-templates        # 或直接重启 Gitea
```

浏览器端请强制刷新一次（模板里的 `?v=` 时间戳每次安装都会更新，正常情况下不需要
手动清缓存）。

手动安装也可以：把 `custom/` 目录下的三个文件按同样的相对路径复制过去，并把
`body_inner_post.tmpl` 里的 `__FLIR_SEQ_VERSION__` 换成任意字符串。

## 与 custom 分支上其它扩展共存

`custom` 分支下的扩展各自占用不同的模板钩子：

| 扩展 | 使用的模板 |
| --- | --- |
| `contrib/markdown-draw` | `custom/header.tmpl` |
| `contrib/print-markdown` | `custom/header.tmpl` |
| `contrib/mermaid-pan-zoom` | `custom/footer.tmpl` |
| `contrib/table-export-png` | `custom/body_outer_post.tmpl` |
| **`contrib/flir-seq`（本扩展）** | **`custom/body_inner_post.tmpl`** |

本扩展特意选了当前没人使用的 `body_inner_post.tmpl`，因此与上面任何一个同时安装
都不会互相覆盖。即便将来有别的扩展也要写这个文件，`install.sh` 也只会替换
`flir-seq:begin` / `flir-seq:end` 之间的内容，文件里其它区块原样保留（重复执行
安装脚本是幂等的）。

静态资源同理：`gitea-flir-seq.js` / `gitea-flir-seq.css` 文件名唯一，JS 的全局符号
只有 `window.GiteaFlirSeq` 与配置对象 `window.giteaFlirSeqConfig`，CSS 选择器全部
以 `.flir-seq` 开头，不会碰到别的扩展或 Gitea 自身的样式。脚本只接管文件名后缀匹配
的文件浏览页，其余页面完全不动。

## 配置

配置写在 `body_inner_post.tmpl` 里的 `window.giteaFlirSeqConfig`，删掉某一行即取
默认值（默认值见 `gitea-flir-seq.js` 顶部的 `DEFAULTS`）：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `extensions` | `['.seq', '.fff']` | 触发查看器的文件名后缀（小写，含点） |
| `maxAutoLoadBytes` | 64 MiB | 超过此大小先询问再下载——整个文件要读进内存 |
| `maxLoadBytes` | 1 GiB | 硬上限，超过则拒绝加载 |
| `defaultPalette` | `'iron'` | `iron` / `rainbow` / `white-hot` / `black-hot` / `arctic` |
| `defaultRangeMode` | `'frame'` | `frame` 本帧自动 / `sequence` 全序列自动 / `manual` 手动 |
| `playbackFps` | `6` | 播放帧率 |
| `decimals` | `1` | 温度显示的小数位数 |
| `maxHeightVh` | `0.72` | 图像区域最大高度占视口高度的比例 |
| `lang` | `null` | `null` 跟随 Gitea 语言；也可强制 `'en'` / `'zh-CN'` / `'fi-FI'` |

## 界面语言

Gitea 自带 29 种界面语言（`options/locale/`，其中包含 `zh-CN` 与 `fi-FI`），并把当前
语言渲染进 `<html lang="{{ctx.Locale.Lang}}">`。本扩展据此自动切换，用户在 Gitea 的
语言设置里选什么，查看器就显示什么，**不需要另外配置**。

目前内置三种：**英语（`en`）、简体中文（`zh-CN`）、芬兰语（`fi-FI`）**。匹配规则是
先精确匹配语言标签（不分大小写），再退到主语言子标签，最后退到英语——所以 Gitea 设
成 `fi-FI` 得到芬兰语，`zh-TW` 会落到简体中文（比退回英语更接近），`de-DE` 等其余
语言则显示英语。

要加一种语言，在 `gitea-flir-seq.js` 顶部的 `LANGUAGES` 里照抄 `en` 那一份改写即可；
`test/run.mjs` 会检查每种语言的键集合与英语完全一致、占位符 `{0}` 未丢失、没有空串，
`test/browser.mjs` 会在真实浏览器里逐语言核对界面上确实出现了这些文案。

解析器与测温代码本身不含任何面向用户的句子：它们抛出的是翻译键（例如
`warnResync`、`errNoPlanck`），由查看器统一翻译。

## 原理

* `templates/base/footer.tmpl` 在页面容器结束前会渲染
  `{{template "custom/body_inner_post" .}}`，自定义模板由此注入 `<script>`。
* Gitea 的文件浏览页把原始文件链接放在 `.non-diff-file-content` 的
  `data-raw-file-link` 属性上，二进制文件则渲染出一个只含 “View Raw” 链接的
  `.file-view-render-container`。脚本按后缀匹配后，把查看器挂进这个容器。
* Gitea 1.24 起左侧文件树是前端换页（直接改写 `.repo-view-content` 的 innerHTML），
  所以脚本用 `MutationObserver` 监听新插入的节点，而不是只在首次加载时扫描一遍。
* 原始文件用 `fetch(..., {credentials: 'same-origin'})` 取回，私有仓库同样可用；
  下载前先发 `HEAD` 拿 `Content-Length` 做大小保护。
* `.seq` 是若干 FLIR “FFF” 帧的直接拼接。脚本解析每帧的记录索引，取出
  `CameraInfo`（标定与环境参数）和 `RawData`（16 位原始计数），再按 FLIR 的目标
  信号模型换算温度。格式细节与公式推导见 [`doc/format.md`](doc/format.md)。
* 渲染时先把「原始计数 → 调色板下标」预先算成一张 65536 项的查找表，每个像素只做
  一次查表，640×480 的整帧重绘（换调色板、改参数、切帧）都是即时的。

## 已知限制

* 只支持**未压缩的 16 位** `RawData` 记录，也就是相机直出的 `.seq` / `.fff`。
  少数 FLIR JPEG 里那种 PNG 压缩的原始数据会明确提示不支持，而不是画错。
* 温度换算依赖文件里的 Planck 标定常数（R1、R2、B、F、O）。个别老机型不写 R2，
  这时查看器会给出提示并改为显示原始计数，图像照常可看。
* 只对**原始计数型**文件（typeOfPixelValues = 1）验证过。开了 TLinear 之类功能、直接
  存温度线性值的机型会被识别出来并给出警告，但不会自动改用正确的换算——这两个字段的
  枚举含义没有公开文档，详见 [`doc/format.md`](doc/format.md)。
* 整个文件会读进浏览器内存。几百兆的长序列建议先用相机软件裁剪，或调低
  `maxAutoLoadBytes` 让它先询问。
* 大气透过率按 FLIR SDK 的规则取值：文件里的 `estAtmosphericTransmission` 非 0 就直接
  采用，为 0 才按距离、湿度与大气温度估算。如果拍摄距离与文件记录不符，在「测温参数」
  里改即可，温度会立刻重算。
* 显示的采集时间按文件里的 UTC 时间戳渲染，若文件带时区偏移则一并标出。
* 不接管 diff 页面与文件列表预览，只接管单文件浏览页。

## 测试

```sh
cd contrib/flir-seq/test
node run.mjs                 # 解析、测温与翻译完整性，无需任何依赖
./setup.sh && ./run.sh       # 再加上真实浏览器里的端到端测试（三种语言都跑）
./run.sh /path/to/real.seq   # 同时跑一遍真实相机文件
```

另有一个可选的交叉验证脚本，把温度换算与独立的 Python 实现 [flirpy](https://github.com/LJMUAstroecology/flirpy)
对比（需要 `pip install flirpy`）：

```sh
node contrib/flir-seq/test/compare-flirpy.mjs /path/to/real.seq
```

实测两者在 14 组参数 × 9 个原始值以及两个真实文件的全部 7 × 307200 个像素上偏差
≤ 1.14e-13 K。公式出处与完整比对结果见 [`doc/format.md`](doc/format.md)。

详见 [`test/README.md`](test/README.md)。
