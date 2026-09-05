# S-MASCOT-3 — 用眼形 + 眼动表达状态（不读回复情绪）

> 日期: 2026-09-04
> 状态: Archived
> Spec ID: **S-MASCOT-3**
> 关联: [S-MASCOT](2026-09-03-chat-mascot.md)、[S-MASCOT-2](2026-09-04-chat-mascot-v2.md)

## 1. 背景

没有手，情绪几乎只能靠眼。v1/v2 各档仍是同一套椭圆微调，48px 下认不出。用户确认：**不读回复文本情绪**，只把现有 8 档 Agent 状态做成更好认的眼形，并叠上已有眼动。

## 2. 目标

每档 `MascotFace` 有可区分的闭合眼环形状；换脸弹簧插值；S-MASCOT-2 的眼动保留。不加嘴、瞳孔、腮红。

## 3. 非目标

- 不根据模型输出推断开心/害羞等。
- 不新增脸档、不新增设置。
- 不把手、天线、换装做进来。

## 4. 详细设计

### 4.1 形状（`eyes.ts`）

椭圆采样后加眼皮：`lidTop` 把上半压下来，`lidBottom` 把下半压上去。`tilt` 做 `> <`。

| 脸 | 形状 | 动作（已有 sim，本轮核对不断） |
|---|---|---|
| idle | 圆、略不对称 | 连眨 + 微瞥 |
| waiting | 更小的圆点 | 慢扫 |
| thinking | 横缝，左眼更细 | 偶发单眼再眯 |
| working | 又圆又开 | 小颠，不转圈 |
| speaking | 更高的椭圆 | 开合跟流式 |
| listening | 略扁、偏低 | 朝下 + 水平轻扫 |
| error | 内八 `> <`，细 | 切入短震 |
| stopped | 上眼皮压下，下弯月牙 | 几乎不眨 |

### 4.2 插值与闸门

`lerpRings` 仍按点列；形状差变大后 180–280ms 弹簧足够。reduced-motion：贴目标形，无扫/眨/开合。

### 4.3 测试

- thinking 垂直幅度明显小于 idle
- waiting 包围盒小于 idle
- speaking 高于 idle
- listening 平均 y 大于 idle（更靠下）
- error：左眼内侧点 y 大于外侧（内角下压），右眼对称
- stopped 垂直幅度小于 idle，且上沿比下沿更扁（lidTop）

## 5. 影响面

`src/ui/mascot/eyes.ts` + `eyes.test.ts`。`sim.ts` 仅当某档动作接不上时补接线；不改 derive-face / 设置。
