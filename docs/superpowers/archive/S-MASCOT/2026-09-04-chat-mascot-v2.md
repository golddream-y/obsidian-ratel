# S-MASCOT-2 — 聊天吉祥物更可爱灵动(闲着 / 单击 / 忙态)

> 日期: 2026-09-04
> 状态: Archived
> Spec ID: **S-MASCOT-2**
> 关联: [S-MASCOT](2026-09-03-chat-mascot.md)(放置、脸派生、设置、reduced-motion 仍有效);实现落在现有 `src/ui/mascot/`

## 1. 背景

P-MASCOT-1 已落地一只可拖 blob:浅色眼环、弹簧换脸、慢呼吸、微瞥、倾听朝下看。用户觉得还不够像活物:闲着像待机,各忙态差别不够一眼能看出来,摸它几乎没反馈。本轮只加运动与姿态差,不做成表情实验室。

## 2. 目标

1. **闲着更像活的**:连眨、轻晃、指针离开聊天窗后仍自己活,不盯死中心。
2. **单击轻弹**:点一下压扁再弹回;拖完余震;不吞掉双击复位。
3. **忙态拉开**:waiting / thinking / working / speaking / error / stopped / listening 姿态差一眼可辨。
4. 仍走现有 `MascotSim` + `deriveMascotFace`,不新开状态机,不读回复文本情绪。

## 3. 非目标

- 不加嘴、腮红、瞳孔、身体高光、换装巡演。
- 不根据模型输出内容推断开心/害羞。
- 不替代 ThinkingOrb。
- 不改设置项(仍 `chatMascotEnabled` + 坐标);不新增外观开关。
- 不把「拍一拍」做成独立玩法或连点连击计数;单击只是一次短弹簧。

## 4. 详细设计

### 4.1 闲着(仅 `idle`)

在现有慢呼吸、6–14s 眨眼、偶发微瞥之上增加:

| 行为 | 规格 |
|---|---|
| 连眨 | 主间隔约 6–12s;约 1/4 次在睁开后 120–220ms 内再眨一次 |
| 轻晃 | 身体缓慢左右倾,幅度约 ±4°,呼吸略大于 v1 |
| 自主视线 | 指针在聊天窗内仍跟鼠标;指针离开后用 idle 微瞥 + 轻晃,视线不锁 0 |

`error` / `stopped` / reduced-motion / `chatMotionEnabled===false`:关掉连眨、轻晃、自主微瞥。

### 4.2 单击与拖动

命中判定仍是吉祥物约 48×48 热区。

| 手势 | 行为 |
|---|---|
| 单击(按下到抬起位移小于约 6px) | 身体压扁再弹回,时长约 280–400ms;眼环跟着挤一下(`squash`) |
| 拖动(位移超过阈值) | 按住压扁;松手弹簧回正并余震约半拍;松手**不**再触发单击弹跳 |
| 双击 | 仍重置到默认角;单击弹跳不得抢掉双击 |
| 忙态下单击 | 允许,但弹跳幅度约为 idle 的 40–60%,避免抢思考球 |
| reduced-motion 或关聊天动效 | 单击/拖动均无弹跳,只改位置(拖)或无动画(点) |

实现提示:在 `pointerup` 用「是否发生过 drag」门闩区分单击与拖;双击仍走现有 `dblclick` 复位。

### 4.3 忙态姿态(相对 v1 加大差)

脸档集合不变。`FACE_KINETICS` + 眼环目标 + `face-motion` 加强,不新增 `MascotFace`。

| 脸 | 本轮 |
|---|---|
| waiting | 眼慢扫一圈(已有 wander 加大半径/变慢周期);身体轻轻左右摆 |
| thinking | 更扁、更歪(约 −10° 量级);偶尔单眼先眯再对称 |
| working | 更密的小颠(提高 `bounceHz`,略增 `bounceAmp`) |
| speaking | 眼开合跟流式走(已有);身体一点点点头 |
| error | 切入时短震一下再瘪住;保持约 2.4s 的 error hold |
| stopped | 更趴、呼吸更慢、几乎不眨眼 |
| listening | 仍朝输入框;点头/颠的幅度小于 speaking |

同帧只一档;报错闪过后若仍 `isRunning` 回到对应忙态,不卡在 error(S-MASCOT 4.2 不变)。

### 4.4 绘制与闸门

- 仍 Canvas 2D blob + 平滑眼环;强调色身体、`--background-primary` 浅色眼。
- Ticker:闲晃/连眨/单击弹簧进行中必须跑;静止且无弹簧速度时可维持现有降帧策略,但 idle 轻晃视为「未静止」。
- `prefers-reduced-motion` 或 `chatMotionEnabled===false`:静态脸,不跟鼠标、不闲晃、不弹。

### 4.5 测试

- 闲着:连眨第二次落在第一眨结束后的短窗口内;reduced-motion 不调度连眨。
- 单击 vs 拖:位移 < 阈值触发 tap squash;超过阈值不触发 tap。
- 忙态:各脸 `FACE_KINETICS` 的 rotate/bounce/restOpen 差满足「waiting 摆、thinking 更扁歪、working 颠得更密」的断言(用常量或 `tick` 取样,不要求像素截图)。
- `deriveMascotFace` 优先级表不改则不必重写,除非本轮误动该文件。

## 5. 影响面

| 层 | 文件 |
|---|---|
| 运动 | `src/ui/mascot/sim.ts`、`face-motion.ts`(及对应 test) |
| 手势 | `src/ui/mascot/ChatMascot.svelte`(tap 门闩;现有 drag/dblclick) |
| 绘制 | `paint.ts` 仅当 squash/点头需要;原则上可不改路径算法 |
| 脸派生 / 设置 / i18n | 不改,除非 aria-label 已覆盖各脸 |

## 6. 参考

- 基线 spec:[S-MASCOT](2026-09-03-chat-mascot.md)
- 现网:`MascotSim`、`FACE_KINETICS`、`waitingWander` / `idleGlance` / `listeningGlance`

## 落地偏差(归档备忘)

- 侧边吸附后改为无设置开关、阈值 8px。
- 按压缩放画布四周留白,避免变扁被裁成直线。
