# contrib/flir-seq 的测试

两层：解析与测温的纯逻辑测试（零依赖），以及真实浏览器里的端到端测试。

## 解析与测温

```sh
node run.mjs                 # 只跑合成样本
node run.mjs /path/to/a.seq  # 另外打印真实文件每一帧的温度摘要
```

传真实录像给 `run.mjs` 时，若文件名与 [`truth.mjs`](truth.mjs) 里的某条对得上，它会拿
**FLIR Thermal Studio 2.0.84** 的读数逐帧断言 max/min/avg（容差取 TS 的显示精度
±0.05 °C）；对不上则只打印摘要并说明没有对应真值。这是全套测试里唯一不源自同一次逆向的
参照，也是它定下了大气透过率该怎么算——详见 [`../doc/format.md`](../doc/format.md)。

`run.mjs` 不需要 `npm install`：它把 `gitea-flir-seq.js` 当作浏览器里的普通脚本
用 `new Function` 求值（Gitea 的 `package.json` 把 `.js` 标成 ESM，所以不能直接
`require`），再对合成样本逐项断言。

关键一点是 `load.mjs` 里的 `referenceTemp()`：它是照 FLIR 的目标信号模型**另行抄写**的
一份实现，没有复用查看器里那套预先整理好的 `gain`/`offset`。两者的偏差必须是 0，这样
查看器为了提速做的代数变形一旦写错就会立刻暴露。同一个文件里的 `thermimageTemp()` 则是
Thermimage/flirpy 那套「半程 τ 乘两次」的约定，只给 `compare-flirpy.mjs` 用。

合成样本由 `fixture.mjs` 生成（大端帧头 + 小端记录，与真机一致），因此仓库里不必
存放几兆字节的热成像数据。

## 浏览器

```sh
./setup.sh     # 安装 playwright-core（一次即可）
./run.sh       # 解析测试 + 浏览器测试
./run.sh /path/to/real.seq
```

`setup.sh` 只装 `playwright-core`，不下载浏览器。`browser.mjs` 会依次尝试
`$CHROMIUM`、playwright 自带的下载目录、`$PLAYWRIGHT_BROWSERS_PATH`；都找不到时按
提示执行 `npx playwright install chromium`，或把 `CHROMIUM` 指向已有的
Chrome/Chromium。

`server.mjs` 起一个本地静态服务，原样提供扩展的 js/css、`harness/index.html`
（复刻 Gitea `templates/repo/view_file.tmpl` 里查看器依赖的那几层 DOM 与 CSS 变量），
以及 `/raw/sample.seq`。因此浏览器测试不需要跑一个真的 Gitea 实例。

测试断言的内容：查看器接管了 “View Raw” 容器、图像真的画出了渐变、开图时用的是文件记录的
温标、悬停与单击读出的温度与 Node 侧算出的完全一致、改发射率后所有读数重算、切帧/换调色板/
滚轮缩放/适应窗口生效、PNG 与 CSV 能下载、控制台没有报错。

色标控制条的断言是逐像素的等价关系，而不是看外观：读回画布像素，要求**高于色标上限的
全部等于调色板最后一色、低于下限的全部等于第一色**，0 处例外。此外还验了条的两端与端点
标签正好等于本帧的最冷/最热像素（不留余量）、把滑块往条外拖只会停在这两个端点且定义域
不跟着扩张、Home/End 同样出不去、滑块落点对应的温度、拖动后切到手动并同步手动输入框，
以及顶部两个按钮尺寸一致、分别回到本帧全范围与文件记录区间、并各自在生效时置灰。

交互部分默认用英语跑（`FLIR_SEQ_LANG=fi-FI` 可换一种），之后**每种内置语言**都单独
开一个页面核对：各面板文案确实换成了该语言、帧标签按该语言的格式拼出、由三个键拼成
的读数行完全匹配。`harness/index.html` 用 `?lang=` 设置 `document.documentElement.lang`，
代替 Gitea 渲染的 `<html lang="{{ctx.Locale.Lang}}">`。

`run.mjs` 里另有一组翻译完整性检查：每种语言的键集合必须与英语完全一致、`{0}` 这类
占位符不能丢、不能有空串，解析器与测温代码抛出的每个翻译键都必须存在。

## 与 flirpy 交叉验证

```sh
pip install flirpy
node compare-flirpy.mjs                 # 参数网格
node compare-flirpy.mjs /path/real.seq  # 再逐像素比真实文件
FLIRPY_PYTHON=/path/to/venv/bin/python node compare-flirpy.mjs
```

本查看器的大气透过率算法与 flirpy **有意不同**（见 `../doc/format.md`），所以这个脚本
核验的是它仍能核验的两件事：flirpy 自己的 FFF 解析器解出的**原始计数逐像素比特级一致**
（连帧边界与记录偏移一起验了），以及 flirpy 与 `thermimageTemp()` 在它自己那套约定下的
算式一致（容差 1e-9 K）。两种约定的差额会一并打印出来。不达标时退出码非 0。

比对结果与 flirpy 那处 `273.14` 的说明记在 [`../doc/format.md`](../doc/format.md)。
这个脚本需要 Python 与 flirpy，属于可选，不在 `run.sh` 里。

想留一张截图：

```sh
FLIR_SEQ_SCREENSHOT=/tmp/flir.png node browser.mjs
```
