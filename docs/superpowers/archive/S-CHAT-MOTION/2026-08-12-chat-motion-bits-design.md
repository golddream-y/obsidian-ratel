# S-CHAT-MOTION — 聊天动效精致化（Bits 翻译落地）

> **ID:** S-CHAT-MOTION  
> **状态:** Active  
> **日期:** 2026-08-12  
> **灵感源:** [react-bits](https://github.com/DavidHDev/react-bits) / [sveltebits.xyz](https://sveltebits.xyz/)  
> **前置:** ThinkingOrb（`src/ui/orbs/`）、S-CHAT-PROTO、S-CHAT-NAV  
> **动机:** 侧栏已能用，但空态空白、消息硬切、品牌静止；要把「精致 / 好看 / 动态」当成一等体验，用 Bits 源码翻译进 Svelte，而不是从零臆造。

---

## 1. 背景

Ratel 聊天侧栏已有：

- **忙态** — ThinkingOrb（canvas，多挂载点）
- **会话切换** — exit/enter + spinner
- **导航** — 点列鱼眼

缺口集中在「非忙态」时刻：空会话无舞台、气泡/引用硬出现、标题落定硬切、Header / 发送几乎无微光。

[react-bits](https://github.com/DavidHDev/react-bits)（及官方 Svelte 移植 [Svelte Bits](https://sveltebits.xyz/)）提供大量可拷贝动效组件。本项目约束是 Obsidian 插件 + Svelte 5 + 无重依赖 + 隐私（无 CDN），**不能**整库 npm 依赖 React/Tailwind 版。

已确认落地策略：

> **方案 B（抄代码翻译）** — 找到 Bits 对应组件源码 → 翻成 Svelte 5 + Obsidian CSS 变量 → vendor 进仓库（与 `src/ui/orbs/` 同套路）。  
> 「很多不就是找到代码做翻译么」——是的，本 spec 按此执行，不是「只抄观感自己重写算法」优先。

---

## 2. 目标

1. **一镜覆盖五块能力**：空会话舞台、消息编舞、标题落定、品牌微光、工程闸门（开关 / reduced-motion / 溯源）。  
2. **观感达到 Bits 级精致**：入场有曲线、完成有定格、减弱动效有降级；窄侧栏不裁切、不抖布局。  
3. **忙态不抢戏**：生成中仍以 ThinkingOrb 为主；Bits 层在空态 / 入场 / 轻反馈。  
4. **可维护**：每个翻译组件有上游链接 + LICENSE/NOTICE；无 Tailwind 运行时依赖；色走 Obsidian token。

成功标准（可验收）：

- 空会话：可见淡背景 + 欢迎文案入场；首条消息发出后背景卸载且动画停。  
- 新用户气泡 / 助手块 / cite chip：有入场动画；流式正文**无**打字机。  
- 标题从占位 → AI 总结：chip 有交叉淡入或 blur 过渡，非硬切。  
- Header `Ratel.` 有可感知微光（hover 或常驻极淡）；发送成功有一次 Click Spark（可关）。  
- 设置「聊天动效」关闭或 `prefers-reduced-motion`：全部装饰动效静默为瞬时/静态。  
- `npm test` / `npm run build` 通过；插件目录含 NOTICE 与上游许可。

---

## 3. 非目标

- 不引入 React / Framer Motion / GSAP 作为运行时依赖（翻译后可去掉；若某组件强依赖且无法剥离则换组件）。  
- 不引入 Tailwind 构建链；翻译时把 TW class 收成 scoped CSS / `styles.css`。  
- 不做全屏背景秀：Hyperspeed、Galaxy、Ballpit、Splash Cursor、Blob Cursor 等。  
- 不替换 ThinkingOrb；不在 Backgrounds 再塞第二个 Orb。  
- 不改 Agent Loop / 引用算法 / 权限语义。  
- 不做落地页级营销动效。

---

## 4. 组件映射（抄谁 → 落哪）

优先对照 **react-bits / sveltebits 源码**抄时序、easing、关键参数与视觉；**禁止**把 `ogl` / `gsap` / `motion` / `framer-motion` 加进 `package.json`。依赖库的部分用 WebGL2 原文 shader / Canvas2D / CSS `@keyframes` / WAAPI **剥库重写**（仍算「翻译」，不是另起炉灶的观感猜测）。

| # | 上游（Bits 名） | 落点 | 翻译策略 |
|---|---|---|---|
| M1 | **Aurora**（非 Soft Aurora 若源码即 Aurora） | 空会话消息区背景 | 抄 `VERT`/`FRAG`；用原生 WebGL2 挂 canvas（**不**引 `ogl`）。无 WebGL → CSS 渐变呼吸降级。`messages.length===0` 才挂载 |
| M2 | **BlurText** | 空态欢迎主句 | 抄 delay / blur / y / stepDuration；用 `span` + CSS/WAAPI（**不**引 `motion`）。i18n；reduced-motion → 静态全文 |
| M3 | **TextType** | 空态副句一行 | 抄打字节奏；`setInterval` 只打一次、不循环 |
| M4 | Fade Content / Animated Content | 用户气泡、助手消息块入场 | 抄位移+opacity 曲线 → CSS class；stagger ≤ 3 档 |
| M5 | （同 Fade / 轻 scale） | cite chip、内联 `[n]` 首次出现 | 一次；≥8 个 chip 时整组一次 fade |
| M6 | BlurText 短时 / 交叉淡入 | 会话标题 chip 落定 | 占位 → 总结完成触发一次 |
| M7 | **ShinyText** | Header `Ratel.` | 抄扫光关键帧 → CSS；hover 加强 |
| M8 | **ClickSpark** | 发送钮成功瞬间 | 抄粒子参数 → 轻量 canvas/DOM；Stop 态不触发 |
| M9 | （轻 CSS） | Send ↔ Stop | 短 crossfade / scale |

**明确拒绝清单**：Glitch / ASCII / Decrypted / Scrambled、Splash/Blob Cursor、Hyperspeed / Plasma / Liquid Ether / Ballpit、Bento / Carousel / Dock / Model Viewer；**拒绝**为动效新增 npm 动画库。

**依赖踩坑（审查冻结）**：

| 上游 | 原依赖 | 本仓库做法 |
|---|---|---|
| Aurora | `ogl` | 只抄 shader + 原生 WebGL2 |
| DotGrid（备选） | `gsap` | 不采用；若 Aurora 失败也不引 gsap |
| BlurText | `motion/react` | CSS/WAAPI |
| 任意 | Tailwind | 收成 scoped / `styles.css` |
---

## 5. 详细设计

### 5.1 目录与溯源

```
src/ui/motion/
  NOTICE.md                 # 上游列表 + Commons Clause 说明
  LICENSE.react-bits.md     # 上游许可全文拷贝
  empty/
    EmptyStage.svelte       # 组合：背景 + 欢迎文案
    AuroraBackdrop.svelte   # Aurora shader → WebGL2
    WelcomeBlurText.svelte  # BlurText → CSS/WAAPI
    WelcomeTypeLine.svelte  # TextType 一次
  enter/
    FadeIn.svelte           # 通用入场包装
  brand/
    ShinyBrand.svelte
    ClickSpark.svelte
  title/
    TitleDissolve.svelte    # chip 落定
  prefs.ts                  # chatMotionEnabled ∩ prefers-reduced-motion
```

- 每个翻译文件头注释：`@origin <url>`、`@license`、改动摘要（剥 ogl/motion/TW、换 token、Svelte runes）。  
- 许可：上游为 **MIT + Commons Clause** — **允许**作为应用/插件的一部分分发；**禁止**把 `src/ui/motion` 再拆成独立组件包出售或再分发。NOTICE 必须写明此条。  
- 设置入口：**外观 Tab**（与点列开关并列）`chatMotionEnabled`，默认 `true`。

### 5.2 翻译规范（强制）

1. **先抄后改**：保留动画时序 / easing / 关键数学；再换样式 token。  
2. **去 Tailwind**：`class="..."` → scoped CSS；颜色 → `var(--text-normal)` / `var(--interactive-accent)` / copper soft。  
3. **Svelte 5**：`$props` / `$state` / `$effect`；避免与 `$state` 同名 prop（Orbs 教训：勿用 `state`）。  
4. **压 Obsidian `button`**：若动效包在 button 上，几何重置进 `styles.css`（同 `ratel-send` / `ratel-perm-btn`）。  
5. **无外网**：字体、贴图、shader CDN 一律去掉或内联。  
6. **可测**：纯函数（延迟计算、是否应播放）单测；组件烟雾用现有 vitest + 逻辑测。

### 5.3 编排（ChatView / MessageList）

| 时刻 | 编排 |
|---|---|
| 空会话 | `MessageList` 内叠 `EmptyStage`；`messages.length>0` 卸载 |
| 新消息 | `MessageBubble` 外包 `FadeIn`；key=messageId，仅首次挂载播 |
| 流式 delta | **不**对每个 token 播入场；块级只播一次 |
| cite | chip 挂载时播；跟进引用可点逻辑不变 |
| 标题 | `maybeGenerateTitle` / 手改成功 → chip 触发 `TitleDissolve` |
| 发送 | `sendMessage` 成功入队后 Spark；gate 挡下不触发 |
| 忙态 | Orb 照旧；EmptyStage 已卸 |

### 5.4 设置与减弱动效

- 设置 → 外观（或高级）：`chatMotionEnabled: boolean`（默认 `true`）。  
- `prefs.ts`：`enabled = settings.chatMotionEnabled && !prefersReducedMotion()`。  
- 关闭时：EmptyStage 只渲染静态文案（无背景 canvas）；FadeIn 瞬时；Spark / Shiny 禁用。  
- i18n：`settings.chatMotion.*`、`chat.empty.*` 欢迎文案。

### 5.5 性能预算

| 规则 | 说明 |
|---|---|
| 同时常驻 canvas ≤ 1（空态背景）+ Orb 挂载点已有策略 | 空态与 Orb 不同时（空态无 busy orb） |
| 背景仅空态 | 有消息立即 destroy |
| IntersectionObserver + visibilitychange | 与 Orb 同级停环 |
| 侧栏宽度 | 背景用 CSS 百分比；欢迎文案 `max-width` + 换行 |
| 禁止 | 每 keystroke / 每 delta 触发 layout 动画 |

### 5.6 与原型 / 文档

- 可选：`docs/prototype/chat-ui-mockup.html` 回写空态示意（非阻塞）。  
- user-guide §10 补「聊天动效 / 可关」一句；CHANGELOG 发版时记。

---

## 6. 影响面

| 区域 | 影响 |
|---|---|
| `src/ui/motion/**` | 新建 |
| `MessageList` / `MessageBubble` / `ChatView` header·composer | 编排接入 |
| `styles.css` | 全局 button/动画重置（若需要） |
| `settings` / i18n | `chatMotionEnabled` + 空态文案 |
| 测试 | prefs + 编排条件单测 |
| 依赖 | **不**增加 package.json 重型动画库 |

---

## 7. 实施分期（仍同一 spec，可多 plan）

| 分期 | 内容 | 优先级 |
|---|---|---|
| P1 | 脚手架 `motion/` + prefs + 设置字段 + M1/M2/M3 空态 | P0 |
| P2 | M4/M5 消息与 cite 入场 | P0 |
| P3 | M6 标题 + M7/M8/M9 品牌与发送 | P1 |
| P4 | NOTICE 齐套、user-guide、CHANGELOG、原型可选回写 | P1 |

「一个 spec 全做」指产品范围一次定死；工程可按 P1→P4 拆 plan，但验收以 §2 全表为准。

---

## 8. 冻结决策（自审已定，不再开放）

1. **空态背景** = Aurora shader + 原生 WebGL2（不引 ogl）；无 WebGL 时 CSS 渐变呼吸。  
2. **欢迎主句** = BlurText 参数 + CSS/WAAPI（不引 motion）。  
3. **副句** = TextType，只打一次、不循环。  
4. **设置** = 外观 Tab · `chatMotionEnabled` 默认开。  
5. **不采用** DotGrid（gsap）作为背景方案。

---

## 9. 参考

- https://github.com/DavidHDev/react-bits  
- https://sveltebits.xyz/  
- `src/ui/orbs/`（vendor + NOTICE 范本）  
- S-CHAT-PROTO / S-CHAT-NAV / ThinkingOrb 接入（MessageList / StatusLine / ToolSegment）
