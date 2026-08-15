# S-CHAT-MOTION-v2 — 聊天动效增强（空态 / 角色区分 / 控件微反馈）

> **ID:** S-CHAT-MOTION-v2  
> **状态:** Active  
> **日期:** 2026-08-12  
> **灵感源:** [react-bits](https://github.com/DavidHDev/react-bits) 全目录筛查（TextAnimations / Animations / Backgrounds / Components）  
> **前置:** [S-CHAT-MOTION](2026-08-12-chat-motion-bits-design.md)（P-CHAT-MOTION Completed：Aurora / Blur / Type / FadeIn / TitleDissolve / Shiny / ClickSpark + 闸门）  
> **动机:** v1 骨架已通，但空态仍不够好看、用户/助手区分偏弱、控件除发送火花外缺少日常微反馈。在**不扩 npm 动画库、不抢 ThinkingOrb、不做落地页秀**的前提下，把 Bits 目录里筛出的「能用」项一次定进产品范围。

---

## 1. 背景

### 1.1 v1 已交付

| 能力 | 落点 |
|---|---|
| 空态 Aurora + Blur 主句 + Type 副句 | `EmptyStage` |
| 消息 / cite FadeIn | `FadeIn` + fade-play-policy |
| 标题落定 | `TitleDissolve` |
| Header 扫光 + 发送火花 | `ShinyBrand` / `ClickSpark` |
| 总闸 | `chatMotionEnabled ∩ prefers-reduced-motion` |

### 1.2 实测缺口（驱动本 v2）

- 空态「有创意但不咋好看」— 极光对比、主句层次、副句只有一次性打字。  
- 用户气泡曾因入场包装丢右对齐；修回后仍希望**视觉角色**更清晰。  
- 发送火花以外，菜单 / 状态数字 / 输入壳几乎无 Bits 级微反馈。  
- 流式贴底曾被 `scroll-behavior: smooth` 拖垮（已在 motion 分支 hotfix；v2 验收须保持）。

### 1.3 全目录筛查结论（摘要）

整库四类组件中：

- **采用 / 翻译**：SoftAurora（或等价柔光底）、GradientText、RotatingText（或 TextLoop 去 gsap）、CountUp/Counter、StarBorder / ElectricBorder / BorderGlow、GlareHover、Noise、GradualBlur、Waves / DotField（备选底）、AnimatedList、SpotlightCard / GlassSurface（轻量对齐）、HalftoneReveal / PixelTransition（标题备选，低优先）。  
- **拒绝**：全屏秀（Hyperspeed / Galaxy / Ballpit / Plasma / Liquid* / Silk…）、光标戏、骇客字、MaskedHeading 整棵（要图+gsap）、重 3D / 营销壳（Dock / Bento / Carousel…）。

筛查原则与 v1 相同：可抄源码翻译；**禁止**把 `ogl` / `gsap` / `motion` / `three` 写入 `package.json`；色走 Obsidian token；窄侧栏不裁切。

---

## 2. 目标

一次覆盖 **三桶**能力（用户已确认「都做」）：

### 桶 A — 空态再好看

1. 背景升级为更柔的极光/光带（优先 **SoftAurora** 剥 ogl；若 shader 难收或观感仍闷 → **Waves** 或 **DotField** 作同槽替换，仍仅 `messages.length===0` 挂载）。  
2. 欢迎主句：**GradientText** 色带 + 保留/强化入场（Blur 或 CSS wipe，二选一写死在 plan；默认 Gradient + 现有 Blur stagger）。  
3. 副句：**RotatingText** 风格多条 hint 轮换（i18n 数组）；`prefers-reduced-motion` / 关闸 → 静态第一条。  
4. 托盘：**Noise** 极淡纹理 +（可选）**GradualBlur** 边缘，提升可读与层次。

### 桶 B — 对话角色区分

1. **用户气泡**：右对齐保持；叠加 **StarBorder** 或 **BorderGlow** 级描边微光（默认跟 `--interactive-accent`）；不引入卡片阴影堆叠。  
2. **助手**：保持左对齐素文、无底无框（与用户对比即设计）。  
3. 入场 FadeIn 真盒子 **不得**再破坏 `align-self:flex-end`（回归用例）。  
4. 引用卡 / 错误块：可选对齐 **SpotlightCard** / **GlassSurface** 的高光边（低优先，不挡 A/B 主验收）。

### 桶 C — 控件微反馈

1. 发送钮：**GlareHover**（指针扫光）+ 保留 ClickSpark（入队成功）；Stop 态无 Spark、Glare 可弱化。  
2. 斜杠菜单与/或会话下拉：**AnimatedList** 项 stagger 入场（剥 motion → CSS/WAAPI）。  
3. StatusStrip 上下文使用率：**CountUp**（或 Counter 参数级）数字过渡；关闸时瞬时跳变。  
4. **Magnet** 发送微吸：**默认关闭**或幅度极小且可关；不做全侧栏磁吸。

成功标准（可验收）：

- 空会话：柔光底 + 渐变主句 + 轮换副句 + 托盘纹理可见；首条消息后背景与轮换卸载。  
- 用户气泡：右侧 + 可感知描边微光；助手无明显边框底。  
- 发送：悬停 glare + 成功 spark；菜单打开有 stagger；上下文 % 变化有短数字过渡。  
- 关 `chatMotionEnabled` 或 `prefers-reduced-motion`：上述装饰全部静态/瞬时；ThinkingOrb 不受影响。  
- sticky-to-bottom：流式贴底不因 CSS smooth 掉队（沿用 `snapScrollToBottom`）。  
- `npm test` / `npm run build` 通过；`src/ui/motion` NOTICE 增补本批上游条目。

---

## 3. 非目标

- 不引入 React / Framer Motion / GSAP / OGL / Three 运行时依赖。  
- 不引入 Tailwind 构建链。  
- 不做 MaskedHeading 整组件（无外链图/视频蒙版英雄区）。  
- 不替换 ThinkingOrb；忙态仍以 Orb 为主。  
- 不改 Agent Loop / 引用算法 / 权限语义 / MCP。  
- 不做光标跟踪秀、全屏粒子宇宙、Dock/Bento 级导航改造。  
- 不强制重做 v1 已稳定模块的 API；以**增量组件 + 编排接线**为主。

---

## 4. 组件映射（抄谁 → 落哪）

| # | 上游（Bits） | 落点 | 翻译策略 | 桶 |
|---|---|---|---|---|
| V2-1 | **SoftAurora**（失败则 Waves / DotField） | 空态背景，替换或并列开关式升级现 Aurora | 抄 shader/几何；原生 WebGL2 或 Canvas2D；无 WebGL → 增强 CSS 呼吸 | A |
| V2-2 | **GradientText** | 空态主句（及可选 Header 强化） | CSS `background-clip:text`；色停用 accent + copper soft | A |
| V2-3 | **RotatingText** | 空态副句多 hint | 剥 motion；CSS/WAAPI 交叉淡入；i18n 列表 | A |
| V2-4 | **Noise** + 可选 GradualBlur | 空态玻璃托盘 | CSS/SVG noise 或 canvas 一次烘焙；极低透明度 | A |
| V2-5 | **StarBorder** / **BorderGlow**（择一作默认） | `.ratel-msg-user` | 纯 CSS 扫边/发光；侧栏窄宽自适应 | B |
| V2-6 | **GlareHover** | 发送钮（及可选 session chip） | 纯 CSS / 单层 pointer 渐变 | C |
| V2-7 | **AnimatedList** | SlashMenu / 会话菜单列表项 | stagger fade+y；剥 motion | C |
| V2-8 | **CountUp** | StatusStrip 上下文 % 或 used/max 展示 | 短时 lerp；关闸瞬时 | C |
| V2-9 | **Magnet**（可选） | 发送钮 | 默认关或极小位移；须单测不破坏点击命中 | C |
| V2-10 | SpotlightCard / GlassSurface（可选） | cite / 错误块 | 低优先；有余力再做 | B |
| V2-11 | HalftoneReveal / PixelTransition（可选） | 标题落定替代 dissolve | 低优先；Halftone 须剥 ogl | — |

**默认选型冻结（实施 plan 不得静默改槽位）：**

1. 空态背景主路径 = SoftAurora 翻译；验收不过再换 Waves（同 EmptyStage 插槽）。  
2. 用户描边 = StarBorder 参数级（比 ElectricBorder 更克制）。  
3. Magnet = 本 spec 范围但 **默认 settings off**（或跟总闸且额外 `chatMotionMagnet` 默认 false——若不愿加设置项，则代码默认幅度 0 / 不挂载）。

---

## 5. 详细设计

### 5.1 与 v1 的关系

- v1 spec（S-CHAT-MOTION）保留为**地基**文档；P-CHAT-MOTION 已 Completed。  
- v2 **不推翻**闸门、NOTICE、目录约定、流式不打字机、忙态 Orb 分工。  
- v2 新增文件仍落在 `src/ui/motion/` 下按域分子目录：

```
src/ui/motion/
  empty/          # SoftAurora / GradientWelcome / RotateHint / NoiseTray …
  chrome/         # GlareHover / AnimatedList 接线辅助 / CountUp …
  bubble/         # UserStarBorder（或样式模块）
  …               # v1 已有 enter/brand/title 保留
```

### 5.2 编排

| 时刻 | 编排 |
|---|---|
| 空会话 | EmptyStage：柔光底 + Gradient 主句 + Rotating hints + Noise 托盘 |
| 首条用户消息 | 卸载空态全部 rAF/WebGL；用户气泡带 StarBorder 入场 |
| 助手流式 | 无逐 token 动效；块级 FadeIn 仅首次 |
| 打开发送悬停 | Glare；入队成功 Spark（v1） |
| 打开 / 或会话菜单 | 列表项 AnimatedList stagger（仅打开瞬间） |
| 上下文用量变化 | CountUp 短过渡 |
| 关动效总闸 | 全部 v1+v2 装饰静态；Orb 除外 |

### 5.3 设置与 i18n

- **总闸不变**：`chatMotionEnabled`；v2 全部受其约束。  
- **不新增第二总闸**；Magnet 若做，优先「代码默认不启用」避免设置膨胀。  
- i18n：  
  - `chat.empty.hints` — 副句轮换数组（zh/en 条数一致）。  
  - 若拆出单条 key：`chat.empty.hint.1` … 亦可，plan 选定一种并写测试。  
  - 用户可见新文案（若设置项描述需提 SoftAurora 等）走 zh/en；**禁止**硬编码。

### 5.4 性能预算（在 v1 上追加）

| 规则 | 说明 |
|---|---|
| 空态常驻动画源 ≤ 1 个 WebGL/Canvas 底 + CSS 字效 | SoftAurora 与 Waves **互斥** |
| RotatingText | 仅空态；不可见 / 有消息即停 timer |
| Noise | 优先静态 CSS；避免每帧全屏重绘 |
| AnimatedList | 仅菜单打开；项数 cap（如 ≤ 24）超出则整组一次 fade |
| CountUp | 时长 ≤ 400ms；高频 patch 合并到 rAF |
| 禁止 | 每 keystroke / 每 delta 触发布局动画 |

### 5.5 无障碍与降级

- `prefers-reduced-motion`：无轮换、无 glare 动画、无 border 扫光、CountUp 瞬时、空态静态渐变。  
- 对比度：Gradient 主句在深/浅色外观下均须可读（用 token mix，禁止死紫粉营销色）。  
- 用户描边不得导致正文对比度跌破可读。

### 5.6 回归硬性要求（写入验收）

1. 用户气泡 **右侧** 对齐（FadeIn 父级须 `display:flex; flex-direction:column; width:100%`）。  
2. `snapScrollToBottom` 保持 instant；消息区无全局 `scroll-behavior:smooth`。  
3. ClickSpark 继续用 tick + body 叠层，不被输入壳裁切。

---

## 6. 影响面

| 区域 | 影响 |
|---|---|
| `src/ui/motion/**` | 新增 empty/chrome/bubble 组件与 NOTICE 条目 |
| `EmptyStage` / `Welcome*` | 重组：Gradient + Rotate + 新背景 |
| `MessageBubble` | 用户描边 class / 包装 |
| `ChatView` composer / StatusStrip | Glare、CountUp |
| SlashMenu / 会话菜单 | AnimatedList |
| `settings` / i18n | hints 数组；设置描述可微调 |
| 测试 | prefs、轮换停表、贴底、右对齐、CountUp 纯函数 |
| 依赖 | **不**增加重型动画库 |

---

## 7. 实施分期（同一 spec，可拆多 plan）

| 分期 | 内容 | 优先级 |
|---|---|---|
| P1 | 桶 A：SoftAurora（或 Waves）+ GradientText + Rotating hints + Noise 托盘 | P0 |
| P2 | 桶 B：用户 StarBorder + FadeIn 右对齐回归测 | P0 |
| P3 | 桶 C：GlareHover + AnimatedList + CountUp；（Magnet 可选末尾） | P1 |
| P4 | NOTICE / user-guide 一句 / CHANGELOG 待发版；可选 cite Glass | P1 |

验收以 §2 三桶 + 回归硬性要求为准；工程可按 P1→P4 拆 plan。

---

## 8. 冻结决策

1. **三桶都做** — 空态 / 角色区分 / 控件微反馈，不砍桶。  
2. **背景主路径 SoftAurora**；不行再 Waves/DotField，同槽替换。  
3. **用户描边 StarBorder 系**；助手保持素文。  
4. **Magnet 默认不显眼/不启用**，避免侧栏误触。  
5. **总闸仍单一** `chatMotionEnabled`；不另开「动效包」商店式开关墙。  
6. **拒绝清单**延续 v1，并显式拒绝 MaskedHeading 整棵与光标/全屏秀。

---

## 9. 参考

- https://github.com/DavidHDev/react-bits（`src/ts-default/{TextAnimations,Animations,Backgrounds,Components}`）  
- [S-CHAT-MOTION](2026-08-12-chat-motion-bits-design.md)  
- `src/ui/motion/` 现网实现与 NOTICE  
- `src/ui/chat/sticky-scroll.ts`（贴底回归）

---

## 10. Spec 自审

- [x] 无 TBD/TODO 占位；选型有失败回退槽  
- [x] 与 v1 闸门/Orb/无重依赖无矛盾  
- [x] 范围 = 三桶全做；非目标排除营销全屏与 MaskedHeading 整棵  
- [x] 验收可测（空态卸载、右对齐、贴底、关闸静态）
