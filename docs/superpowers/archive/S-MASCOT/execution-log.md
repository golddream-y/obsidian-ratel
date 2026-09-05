# S-MASCOT — 执行日志(按时间倒序)

> 该系列 spec(S-MASCOT / S-MASCOT-2 / S-MASCOT-3)的实施记录。最新在前。
> 归档时分支 `feat/p-mascot-1` 尚未 squash 合入 develop;CHANGELOG 已起草 `[0.6.0]`。
> spec 与 plan 原文件名相同,plan 按 S-VISION 惯例改存为 `*.plan.md`。
> 用户可见文案定为「捣蛋鬼」(英文 Imp);归档 spec 正文仍保留当时的「吉祥物」用词。

---

## 2026-09-04 — P-MASCOT-3(眼形 + 眼动表达状态)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| 眼皮采样 + 8 档 FACE_SHAPES | `src/ui/mascot/eyes.ts` | ✅ | 工作区未单开 commit | lidTop/lidBottom;`><` 与月牙 |
| 包围盒 / 内角断言 | `eyes.test.ts` | ✅ | | 不读回复情绪 |

**测试:** mascot 相关单测通过
**Plan 偏差:** 无独立 commit;与 P-MASCOT-2 同在工作区

---

## 2026-09-04 — P-MASCOT-2(闲着 / 单击 / 忙态)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| 单击 vs 拖 | `gesture.ts` | ✅ | 未提交 | `MASCOT_TAP_SLOP=6` |
| 连眨 / 轻晃 / 忙态 kinetics | `face-motion.ts` `sim.ts` | ✅ | 未提交 | `pulseTap`;speakingTalkAmount 补接线 |
| ChatMascot 手势 | `ChatMascot.svelte` | ✅ | 未提交 | 按压画布留白 `MASCOT_CANVAS_PAD`;侧边吸附 8px 无开关 |

**测试:** mascot 单测通过
**Plan 偏差:** 吸附后改为无设置开关、阈值 8px(用户改口)

---

## 2026-09-03 — P-MASCOT-1(可拖吉祥物 v1)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| 脸派生 / 布局 / 设置 i18n | derive-face layout settings | ✅ | `2879599` 起一串 feat/fix | `feat/p-mascot-1` |
| 眼环 + Canvas blob | eyes paint sim | ✅ | 至 `fd45f3d` | 无瞳孔、浅色眼块 |
| ChatView 接线 | ChatMascot.svelte | ✅ | | 挂消息 wrap,不挡发送 |

**测试:** 当时 mascot 单测绿
**分支:** feat/p-mascot-1;HEAD 曾停在 `fd45f3d`,后续 v2/v3/UTF-8 解码仍在工作区
**Plan 偏差:** 挂点用 `.ratel-messages-wrap` 而非 ChatView 根层

---

## 顺带(非本 spec)

流式 UTF-8 半截汉字修复(`utf8-stream-buffer.ts` + openai-compat)同期落地,无独立 spec;CHANGELOG 0.6.0 Fixed 已写。
