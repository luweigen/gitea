# FLIR `.seq` / `.fff` 格式与测温公式

这份文档记录 `gitea-flir-seq.js` 实际依赖的那部分格式细节，以及原始计数换算成
温度的完整公式。FLIR 没有公开这个格式的规范，下面的偏移量来自 ExifTool 的
`Image::ExifTool::FLIR` 模块，并用真实的 FLIR A655sc 录像逐条核对过。

## 容器：FFF 帧

`.seq` 文件就是若干个 **FFF 帧**首尾相接，没有额外的文件头，也没有全局索引。
`.fff` 则是单独一帧。每帧的开头是 0x40 字节的帧头：

| 偏移 | 类型 | 含义 |
| --- | --- | --- |
| `0x00` | 4 字节 | 魔数 `"FFF\0"`（ATS 变体为 `"AFF\0"`） |
| `0x04` | 16 字节 | 格式串，如 `CSPLEORACAM` |
| `0x14` | uint32 | 版本号（实测为 100） |
| `0x18` | uint32 | 记录索引相对本帧起点的偏移，实测 `0x40` |
| `0x1c` | uint32 | 索引条目数 |

**帧头与索引是大端**（实测机型如此），而记录内部是小端。两种字节序都要单独判断，
不能想当然：解析器先按大端读，若得到的索引偏移/条目数不合理再按小端重试，并对每
个条目做边界检查。

每个索引条目 32 字节：

| 偏移 | 类型 | 含义 |
| --- | --- | --- |
| `0x00` | uint16 | 记录类型 |
| `0x02` | uint16 | 子类型 |
| `0x04` | uint32 | 记录版本 |
| `0x08` | uint32 | 记录 ID |
| `0x0c` | uint32 | 数据相对本帧起点的偏移 |
| `0x10` | uint32 | 数据长度 |

用到的两种记录类型：

* **1 = RawData** — 16 位原始计数。
* **32 = CameraInfo** — 标定常数与拍摄时的环境参数。

**下一帧的起点** = 本帧起点 + 所有记录 `offset + length` 的最大值。实测 A655sc 的
帧长恰好是 `0x9fc + 640×480×2 + 32 = 616988` 字节，各记录紧密排布。解析器在算出
的位置上再校验一次魔数，对不上就往后扫描重新同步，这样中间有填充或损坏也只丢一帧。

### RawData 记录

开头 32 字节是图像头，随后是 `width × height` 个 uint16：

| 偏移 | 类型 | 含义 |
| --- | --- | --- |
| `0x00` | uint16 | 固定为 2，**用它判断本记录的字节序** |
| `0x02` | uint16 | 宽 |
| `0x04` | uint16 | 高 |
| `0x20` | uint16[] | 逐行排列的原始计数 |

判据：按小端读 `0x00` 得到 2 就是小端，否则按大端读到 2 就是大端；再验证
`32 + width × height × 2 ≤ 记录长度`。不满足就不是未压缩的 16 位数据（例如 PNG
压缩的变体），此时宁可明确报「不支持」，也不要按错误的宽高把图画歪。

### CameraInfo 记录

同样以那 32 字节图像头开头，字节序判断方式相同。用到的字段（偏移相对记录起点）：

| 偏移 | 类型 | 字段 |
| --- | --- | --- |
| `0x20` | float | 发射率 Emissivity |
| `0x24` | float | 目标距离 ObjectDistance（m） |
| `0x28` | float | 反射表观温度 ReflectedApparentTemperature（K） |
| `0x2c` | float | 大气温度 AtmosphericTemperature（K） |
| `0x30` | float | 红外窗口温度 IRWindowTemperature（K） |
| `0x34` | float | 红外窗口透过率 IRWindowTransmission（SDK 的 extOpticsTransmission） |
| `0x38` | float | **estAtmosphericTransmission**，见下节；为 0 表示「请自行估算」 |
| `0x3c` | float | 相对湿度 RelativeHumidity |
| `0x50` | uint32 | typeOfPixelValues，见下节 |
| `0x54` | uint32 | unitOfPixelValues |
| `0x58` | float | PlanckR1 |
| `0x5c` | float | PlanckB |
| `0x60` | float | PlanckF |
| `0x70`…`0x80` | float×5 | 大气透过率系数 α1、α2、β1、β2、X |
| `0x90` / `0x94` | float | 量程上/下限（K） |
| `0xd4` | char[32] | 相机型号 |
| `0xf4` / `0x104` / `0x114` | char[16] | 相机料号 / 序列号 / 固件版本 |
| `0x170` / `0x190` / `0x1a0` | char | 镜头型号 / 料号 / 序列号 |
| `0x1b4` | float | 视场角 |
| `0x308` | int32 | PlanckO（**有符号**，实测为负） |
| `0x30c` | float | PlanckR2 |
| `0x338` / `0x33c` | int32 | RawValueMedian / RawValueRange |
| `0x384` | uint32 | 采集时间，Unix 秒 |
| `0x388` | uint32 | 低 16 位为毫秒 |
| `0x38c` | int16 | 时区偏移，分钟 |
| `0x464` | uint16 | 帧率（Hz） |

`0x20`–`0x3c` 这一段与 FLIR SDK 的 `CObjectParametersReduceObject`（`fnvreduce`）字段
顺序逐个对应：`emissivity`、`distance`、`reflectedTemp`、`atmosphereTemp`、
`extOpticsTemp`、`extOpticsTransmission`、`estAtmosphericTransmission`、
`relativeHumidity`。结构体里夹在最后两者之间的 `atmosphericTransmission` 被 SDK 注释为
“This is an out hole, don't write to it, read only please”——它是算出来的结果，不落盘，
所以文件里没有它的位置。

两个容易踩的坑：

* **相对湿度**有的机型写 `0.5`（比例），有的写 `50`（百分数）。解析器按
  「≤ 1.5 视为比例」归一到百分数。
* **PlanckO 必须按有符号读**，实测值为 `-3735`；按无符号读会直接把温度算到天上去。

### 大气透过率：文件里的值优先

SDK 对 `estAtmosphericTransmission` 的说明是
“set to 0 to calculate from relHum, distance, atmTemp”，配套的 `atmosphericTransmission`
则是“will be estAtmosphericTransmission if it's not 0, else will be computed atmospheric
transmission”，另有 `editNoCalcAtmTrans` 标志表示“atmospheric transmission can't be
calculated, user must supply it”。

因此规则很明确：**`0x38` 非 0 时直接拿它当 τ，为 0 时才用下面的湿度/距离/气温公式估算。**
在相机里手动设过大气透过率的文件，若一律走估算公式，算出的温度会与 FLIR 官方工具不一致。
查看器按此实现，并且只接受落在 (0, 1] 区间的值——透过率不可能在这个区间之外，这样即使某台
相机在这个偏移放了别的东西也不会被误用。手里两个 A655sc 样本该字段都是 0.0，正是“未设定”。

### 像素值类型

`0x50` / `0x54` 是 typeOfPixelValues / unitOfPixelValues。两个样本都是 `1 / 0`，也就是
原始探测器计数，本查看器的整套换算正是针对这种文件验证的。开了 TLinear 之类功能的机型
可能直接存温度线性值，那时「计数 → 温度」这条路就不适用。

**这两个偏移只在样本上核对过取值，枚举含义没有公开文档可依**，所以查看器的做法是保守的：
读出来，遇到 `1` 以外的类型就在界面上给出警告，提示温度换算可能不适用、请与 FLIR 官方
工具核对，而不是假装算对了。图像照常显示。

真实样本（FLIR A655sc，640×480）读出的值可作为对照：
`ε=0.95`、`d=1 m`、`RH=50%`、反射表观温度 `20 °C`、
`R1=14772.65`、`R2=0.0137111`、`B=1393.8`、`F=1`、`O=-3735`、
`estAtmosphericTransmission=0`（即估算，实测 τ≈0.9957）、像素值类型 `1 / 0`。

## 从原始计数到温度

相机输出的是探测器计数 `S`，里面混着目标自身辐射、目标反射的环境辐射、大气自身
辐射，以及（若有）红外窗口的辐射。FLIR 的目标信号模型把后三者剥掉再反解普朗克
公式。记号：

* `ε` 发射率，`τ` 大气透过率，`IRT` 红外窗口透过率，`ε_w = 1 − IRT` 窗口发射率
* `d` 目标距离（m），`RH` 相对湿度（%），`T_atm` / `T_refl` / `T_win` 分别是大气、
  反射表观、窗口温度（°C）
* `R1, R2, B, F, O` 为文件里的 Planck 标定常数

**1. 大气透过率**。文件里的 `estAtmosphericTransmission` 非 0 就直接用它；为 0 时先按
经验多项式估算水汽含量，再按**整段目标距离**算 τ：

```
h2o = (RH / 100) · exp(1.5587 + 0.06939·T_atm − 0.00027816·T_atm² + 0.00000068455·T_atm³)
τ   = X·exp(−√d·(α1 + β1·√h2o)) + (1 − X)·exp(−√d·(α2 + β2·√h2o))
```

注意被覆盖的只有 τ 这一项：`T_atm` 仍然参与下面的大气自身辐射项，不受影响。

**这里的 `√d` 是关键，且与 Thermimage / flirpy 不同**，详见下文「半程两次 vs 全程一次」。

**2. 各温度对应的黑体信号**（同一个函数，代入不同温度）：

```
raw(T) = R1 / (R2 · (exp(B / (T + 273.15)) − F)) − O
```

**3. 剥离各项干扰**，得到目标自身的信号。大气与外部光学各自**只扣一次**：

```
raw_obj = S/(ε·τ·IRT)
        − (1 − ε)/ε            · raw(T_refl)    目标反射的环境辐射
        − (1 − τ)/(ε·τ)        · raw(T_atm)     大气自身辐射
        − (1 − IRT)/(ε·τ·IRT)  · raw(T_win)     红外窗口自身辐射
```

**4. 反解温度**：

```
T = B / ln(R1 / (R2 · (raw_obj + O)) + F) − 273.15
```

实现上，`raw_obj` 对 `S` 是一次函数，所以查看器把它整理成 `S·gain + offset`，
`gain` 与 `offset` 只在参数变化时重算一次；温度对 `S` 单调递增，于是整条曲线预先
算成一张 65536 项的 `Float32Array` 查找表，每像素只查一次表。

改动发射率时的方向性可以拿来自检：目标比环境**热**时，调低 ε 会把读数**抬高**；
目标比环境**冷**时则相反。`test/run.mjs` 里就有这两条断言。

### 半程两次 vs 全程一次

Thermimage（以及从它移植的 flirpy）的写法不是上面这样：它假设红外窗口位于光路**中点**，
于是按 `√(d/2)` 算出半程透过率 `τ_half`，再在增益里乘两次（`raw/(ε·τ_half·IRT·τ_half)`），
大气辐射项也相应拆成两段。

**τ_half² ≠ τ(d)**。透过率表达式是两项指数之和，平方不等于把路径长度加倍代进去：

```
τ_half² = [X·e^(−√(d/2)·a₁) + (1−X)·e^(−√(d/2)·a₂)]²
τ(d)    =  X·e^(−√d·a₁)     + (1−X)·e^(−√d·a₂)
```

以样本的参数（d=1 m、RH=50%、T_atm=20 °C）为例：τ_half = 0.99572，τ_half² = 0.99146，
而 τ(d) = 0.99394。差 0.25%，落到温度上在 −30 °C 附近约 0.2 K，且**距离越远差得越多**
（本目录的比对脚本在 d=1000 m 的算例上两者相差 12.7 K）。

拿 FLIR Thermal Studio 2.0.84 的读数做判据，**全程一次的写法 21 个统计量全部命中，
半程两次则系统性偏冷**，见下节。因此本查看器采用全程一次，不再跟随 Thermimage/flirpy。

红外窗口那一项（`IRT < 1`）手头没有样本可验，按 FLIR 的标准形式实现，标注为未经核验。

## 与 FLIR Thermal Studio 的核验

这是本项目唯一**不**源自 ExifTool 论坛那次逆向的参照，因此它是**判据**，而不只是又一次
交叉检查。数据由录像所有者用 **FLIR Thermal Studio 2.0.84** 读出，两段 A655sc 录像共
7 帧、每帧 max/min/avg 三个统计量，全部记在 [`../test/truth.mjs`](../test/truth.mjs)。

| 模型写法 | 21 个统计量中落在 TS 显示精度（±0.05 K）内 | 最大偏差 | 平均偏差 |
| --- | --- | --- | --- |
| 半程 τ 乘两次（Thermimage / flirpy） | 6 / 21 | 0.216 K | **−0.088 K** |
| **全程 τ 用一次（本实现）** | **21 / 21** | **0.050 K** | **+0.001 K** |

发现过程值得留档：先把偏差反解成「等效透过率」，拟合出 τ = 0.9970 能让 20/21 落进舍入
误差；而 0.9970² = 0.99401，与按全程距离直接算出的 τ(d) = 0.99394 吻合到 7e-5——于是
问题不是参数没调准，而是**模型少了一层**。

录像本身没有放进仓库（几 MB 热成像数据不该进 Gitea 的树）。把文件名匹配得上的录像传给
`test/run.mjs`，它就会逐帧断言这 21 个数；传别的文件则只打印摘要并说明没有对应真值。

这也说明了上一节那句提醒的分量：**三份实现同源，一致并不等于正确**。与 flirpy 一致到
1e-13 K 完全没能暴露这个问题，因为 flirpy 是从 Thermimage 移植的，两边一起错。只有厂商
自己的软件能当判据。

## 公式出处

这套换算不是本项目推导的，FLIR 也没有公开规范。实现时直接对照的是 **Thermimage 的
`R/raw2temp.R`**（Glenn J. Tattersall，<https://github.com/gtatters/Thermimage>），本文
上面写的每一行都与它逐字核对过：水汽多项式 `(RH/100)*exp(1.5587+0.06939·T−0.00027816·T²+0.00000068455·T³)`、
`tau1 = ATX·exp(−√(OD/2)·(ATA1+ATB1·√h2o)) + (1−ATX)·exp(…)`，以及五个衰减项的写法完全一致。

Thermimage 与 flirpy 的注释都把公式来源指向两处：

* **Minkina, W. & Dudzik, S., *Infrared Thermography: Errors and Uncertainties*, Wiley, 2009**
  ——大气与窗口透过率方程的出处。
* **ExifTool 论坛 “FLIR file format” 讨论串（topic 4898）**——逆普朗克式
  `T = B/ln(R1/(R2·(raw+O))+F) − 273.15` 与各衰减项的具体形式在此被逆向并公开。

需要说明的是：**我手头没有 Minkina & Dudzik 原书**，也没能从本机访问 ExifTool 论坛
（出口代理拒绝了 exiftool.org）。所以准确的说法是——本实现与 Thermimage、flirpy 两份
公开实现在数值上完全一致，而这两份都标注源自上述文献；文献本身没有逐条核对。

大气透过率的**取值优先级**（文件里有值就直接用）另有出处：FLIR SDK 的
`ObjectParametersReduceObject.h`，见上一节。

## 与 flirpy 的交叉验证

[flirpy](https://github.com/LJMUAstroecology/flirpy)（`flirpy/util/raw.py`，注释写明
“Roughly ported from ThermImage”）是一份独立的 Python 实现，`contrib/flir-seq/test/compare-flirpy.mjs`
拿它做对照：

```sh
pip install flirpy
node contrib/flir-seq/test/compare-flirpy.mjs                  # 参数网格
node contrib/flir-seq/test/compare-flirpy.mjs your.seq         # 再逐像素比真实文件
```

自从模型改成全程一次，flirpy 与本查看器**按设计就不再一致**，所以比对脚本改成核验它仍
能核验的两件事：

* **容器解析**——用 flirpy 自己的 FFF 解析器解出整幅原始计数图，与我们的**逐像素比特级
  一致**（2 个文件 / 7 帧 / 每帧 307200 个计数，0 处不同），帧边界与记录偏移一并验了；
* **共用的代数**——拿 `test/load.mjs` 里按 Thermimage 约定另行抄写的 `thermimageTemp()`
  与 flirpy 比，14 组参数 × 9 个原始值以及全部像素上偏差 **≤ 2.6e-13 K**。

脚本同时把两种约定的差额打印出来（样本上每帧 0.13…0.19 K，长距离算例上可达 12.7 K），
那正是这次改动的要点。

落在域外（`log` 的自变量 ≤ 0）的原始值，双方一致地判为无效。

比对里另有 ~1.3 mK 的残差不是模型分歧，而是 flirpy 的一处不自洽：它的
`flirpy/io/fff.py:328` 把开尔文转摄氏用的是 `− 273.14`，而同一个包里其余各处（包括
`raw2temp` 自己）都用 `273.15`。于是 flirpy 解析出来的反射/大气/窗口温度整体偏高 0.01 K，
传播到最终温度上约 1 mK。本查看器两端都用 273.15。把 flirpy 自己的参数喂给本实现，偏差
立刻回到 1e-13——这正是比对脚本同时打印两个数字的原因。

**顺带的交叉验证**：flirpy 的 `fff.py` 有它自己的一份 CameraInfo 偏移表，与本文上面那张
表在 `0x20`–`0x34`、`0x3c`、`0x58`–`0x60`、`0x70`–`0x80`、`0x90`/`0x94`、`0xd4`、`0xf4`、
`0x170`、`0x1b4`、`0x308`（PlanckO 按 int32）、`0x30c`、`0x384`、`0x45c`、`0x464` 上全部
一致，是独立于 ExifTool 的第二份佐证。两处不一致：

* flirpy 同样**没有读取** `0x38`（estAtmosphericTransmission）与 `0x50`/`0x54`，所以在相机里
  手动设过大气透过率的文件上，它也会走估算公式。
* flirpy 把相机序列号与固件版本读成 `get_string(104, 16)` / `get_string(114, 16)`——十进制
  写成了十六进制该写的位置，正确的是 `0x104` / `0x114`。实测它在样本上返回的是二进制垃圾，
  本实现返回 `55007795` / `16.0.0`。

## 与 ExifTool 对照

手头有 ExifTool 时，可以这样核对本文档里的字段：

```sh
exiftool -a -G1 -Planck* -Emissivity -ObjectDistance -RawThermalImage* your.seq
```

ExifTool 的 FLIR 表没有给 `0x38` / `0x50` / `0x54` 命名，这三个字段的依据是 FLIR SDK 的
`ObjectParametersReduceObject.h` 与样本实测，不是 ExifTool。

注意 ExifTool 对 `.seq` 只解析第一帧。查看器的 `test/run.mjs` 接受真实文件作为
参数，会把每一帧的最高/最低/中心温度都打印出来，便于逐帧比对：

```sh
node contrib/flir-seq/test/run.mjs your.seq
```
