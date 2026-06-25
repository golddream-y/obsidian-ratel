# S-FEEDBACK — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-06-24 — P-FEEDBACK(用户反馈通道与开发者日志分离)

| Task | 文件 | 状态 | Commit | 备注 |
|------|------|------|--------|------|
| DevLogger | `src/logging/dev-logger.ts` | ✅ | `201a854` | 开发者专用日志,仅 console;LogModule union |
| UserNotice | `src/user-feedback/user-notice.ts` | ✅ | `201a854` | 用户可见 Toast / Progress,区分命令结果与系统事件 |
| UserStatus | `src/user-feedback/user-status.ts` | ✅ | `201a854` | StatusBar Svelte store,集中状态快照 |
| FeedbackController | `src/core/feedback-controller.ts` | ✅ | `201a854` | 集中事件订阅 + 安全卸载 |
| Chat StatusBar | `src/ui/ChatView.svelte`、`src/ui/StatusBar.svelte` | ✅ | `201a854` | 接线 FeedbackController 到 ChatView |
| IndexBanner 接线 | `src/core/index-controller.ts` | ✅ | `201a854` | 模型下载 / 索引进度推送 |
| 审查修复 | 多文件 | ✅ | `eee3c40` | I1 vectraStore 清理 / I2 StatusBar worker 模式显示 / I3 重复索引完成 toast |
| 钥匙串类型瘦身 | `src/core/feedback-controller.ts` | ✅ | `323d93c` | getSettings 返回类型去掉 Key 字段(S-KEYCHAIN 联动) |

**测试总数:** 232(实施前 219,新增 13)
**分支:** `main`(直接提交)
**Plan 偏差:** 无

### 架构约束落地

- 三个接口模块(dev-logger / user-notice / user-status)严格互不 import
- 业务代码统一 `devLogger.*`,不再裸 `console.*`
- 错误对象 `code` 字段类型分类,不暴露内部错误码给最终用户

---

## 参考文件

- Spec: [`2026-06-26-ratel-user-feedback-design.md`](./2026-06-26-ratel-user-feedback-design.md)
- Plan: [`2026-06-26-ratel-user-feedback.md`](./2026-06-26-ratel-user-feedback.md)
