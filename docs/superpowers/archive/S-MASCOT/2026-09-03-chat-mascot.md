# S-MASCOT — 聊天吉祥物(状态脸 + 可拖 + 跟鼠标)

> 日期: 2026-09-03
> 状态: Archived
> Spec ID: **S-MASCOT**
> 关联: 现有 ThinkingOrb / `chatMotionEnabled`;参考开源眼环几何(MIT,如 grok-ball / LaoA-GrokBot 手法),**不使用 Grok 商标名、不搬实验室 UI**

## 1. 背景

聊天侧栏已有忙态思考球(点阵动词)与装饰动效,但仍是抽象指示,没有「Ratel 在场」的脸。用户确认不要表情实验室整页,只要一只吉祥物:固定在聊天窗里、可拖走、眼睛跟鼠标、表情跟 Agent 状态走(思考 / 报错 / 输出 / 等网络等)。

## 2. 目标

1. 聊天窗内一颗小色块吉祥物(默认约 48px),身体填当前强调色,双眼为高对比色块。
2. 表情只跟 **Agent 可观测状态** 切换,不分析回复文本情绪。
3. 默认停在输入区上方右侧;用户可拖到聊天窗内任意位置,坐标按窗体比例落盘,重载后还在。
4. 指针在聊天窗内移动时,眼睛朝指针方向看(归一化视线,有限偏转)。
5. 外观设置可关;系统「减少动态效果」或关闭聊天动效时:静态脸 + 不跟鼠标。

## 3. 非目标

- 不做实验室:换形状巡演、手脚天线装配、随机/自动巡演、导出分享卡、拍一拍果冻。
- 不做消息气泡旁随条吉祥物(会吵)。
- 不根据模型输出内容推断开心/害羞等情绪。
- 不替代 ThinkingOrb:工具行与状态条仍用思考球。
- 不引入 Flutter / WebView;不运行时拉 CDN。
- 不调用「GrokBot」品牌名(设置文案用「聊天吉祥物」)。

## 4. 详细设计

### 4.1 放置与拖动

- 挂在 `ChatView` 根层 `position:absolute`,不进消息虚拟列表。
- 默认:聊天内容区右下,贴输入壳顶沿上方 8–12px,右边距 8–12px,不挡发送钮。
- 拖动:指针按在吉祥物命中区(约 48×48)后 `setPointerCapture`,松手写入设置。
- 坐标存 **相对聊天窗宽高的 0–1**(含边距 clamp),侧栏改宽后仍落在窗内。
- 双击吉祥物:重置到默认角。
- `z-index` 高于消息、低于 Modal;拖时 `user-select:none`。
- 不拦截输入框/发送钮点击(命中区以外 pointer-events 穿透)。

### 4.2 状态 → 表情(单一事实源)

由 ChatView 已有信号派生一档 `MascotFace`,禁止第二套忙态状态机。

| `MascotFace` | 条件(优先级从上到下) | 脸 |
|---|---|---|
| `error` | 本轮刚出现 chatError / 工具 failed(约 2.4s 后若仍闲着回 `idle`) | 瘪、眼距略开 |
| `stopped` | 用户点停止且本轮 cancelled | 收住、眼垂 |
| `waiting` | `isRunning` 且尚无任何 text/think/tool delta | 眼慢转或空盯 |
| `thinking` | 正在流式 think 段 | 眯、略皱 |
| `working` | 正在 tool.call 或检索 | 略歪、眼更圆 |
| `speaking` | 正在流式正文 text | 轻微开合/强调眼 |
| `idle` | 其余 | 眨眼 + 慢呼吸 |

同帧只一档。报错闪过后若仍 `isRunning` 则回到 waiting/thinking/working,不卡在 error。

### 4.3 视线

- 监听聊天根节点 `pointermove`(不监听 window,避免 Obsidian 其它窗抢眼)。
- `gazeX/Y`:指针相对吉祥物中心,归一化到 [-1,1],再限幅(约水平 ±0.55、垂直 ±0.4)。
- 指针离开聊天窗或 reduced-motion:视线回 0。
- 拖动中冻结视线,避免眼和身体一起晃。

### 4.4 绘制

- Canvas 2D(与 ThinkingOrb 同栈),48 逻辑像素,DPR≤2。
- 身体:圆角色块,填充 `--interactive-accent`(随外观预设)。
- 眼:左右闭合轮廓插值(可移植 MIT 开源眼环点列,自维护一份 `mascot-eyes.ts`,文件头注明来源与许可)。
- 表情切换:阻尼弹簧插值,时长约 180–280ms。
- idle 眨眼:6–14s 随机间隔;waiting 不强调眨眼。
- Ticker:仅 morph / blink / 视线缓动时跑,idle 且指针静止可降到低帧或停。

### 4.5 设置与 i18n

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `chatMascotEnabled` | boolean | `true` | 外观 Tab 开关 |
| `chatMascotX` | number | 默认角对应比例 | 0–1 |
| `chatMascotY` | number | 默认角对应比例 | 0–1 |

- `chatMascotEnabled` 进 `CONFIG_UPDATE_WHITELIST`(与 `chatMotionEnabled` 同类)。
- 坐标可由 UI 拖动写入,不必进 LLM 白名单(避免 Agent 乱挪)。
- 用户可见:设置 name/desc、吉祥物 `aria-label`(随当前 face 变)。
- 闸门:`chatMascotEnabled===false` 不挂载; `prefers-reduced-motion` 或 `chatMotionEnabled===false` 时挂载静态脸、禁用视线与眨眼(开关关装饰时吉祥物也静,避免「关动效还在转眼」)。

### 4.6 无障碍

- 角色 `img`,label 如「Ratel 正在思考」。
- 不要求能键盘拖;位置记忆对键盘用户无影响。
- 对比:眼睛用 `--background-primary` 或近白,深色主题不发灰。

## 5. 影响面

| 层 | 文件(预期) |
|---|---|
| UI | 新 `src/ui/mascot/`(绘制 + 状态映射);`ChatView.svelte` 挂载与拖动 |
| 设置 | `settings.ts` / 外观 Tab / whitelist / i18n zh+en+types |
| 测试 | 状态优先级表;坐标 clamp;reduced-motion 不跟指针 |

## 6. 参考

- 开源眼环/弹簧手法:[grok-ball](https://github.com/TyCoding/grok-ball)、[LaoA-GrokBot](https://github.com/zhulin025/LaoA-GrokBot)(仅几何与动画,MIT)
- 现网忙态:`src/ui/orbs/map-orb-state.ts`、ChatView `isRunning` / segments / chatError
- 动效闸门:`src/ui/motion/prefs.ts`

## 落地偏差(归档备忘)

- 挂在 `.ratel-messages-wrap` 内,而非 ChatView 根层,避免挡发送钮。
