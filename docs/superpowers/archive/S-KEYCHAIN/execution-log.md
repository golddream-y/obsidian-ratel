# S-KEYCHAIN — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-06-26 — P-KEYCHAIN(API Key 迁入 Obsidian 钥匙串)

| Task | 文件 | 状态 | Commit | 备注 |
|------|------|------|--------|------|
| Task 1 | `src/secrets/ratel-secrets.ts`、`tests/secrets/ratel-secrets.test.ts` | ✅ | `3170eef` | 固定 `RATEL_SECRET_IDS` + 端点分类 + resolve/has |
| Task 2 | `manifest.json` | ✅ | `c73fa40` | `minAppVersion` 升至 1.11.4 |
| Task 3 | `src/settings.ts`、`tests/settings.test.ts`、`tests/settings-migration.test.ts` | ✅ | `567cf48` | 删除 4 个明文 Key/Provider 字段;Rerank 默认百炼 |
| Task 4 | `src/ui/secret-hint.ts`、`src/settings.ts` | ✅ | `7eb193d` | `renderSecretHint` 替代密码框;Rerank 段补 note |
| Task 5 | `src/main.ts`、`tests/integration/settings-propagation.test.ts` | ✅ | `323d93c` | LLM/Embedding 改用 `resolveChatApiKey`/`resolveEmbedApiKey`;FeedbackController 类型瘦身 |
| Task 6 | `src/ui/chat-send-gate.ts`、`src/ui/ChatView.svelte`、`tests/ui/chat-send-gate.test.ts` | ✅ | `988081b` | 端点感知硬拦;本地 Ollama 免 Key |
| Task 7 | `src/core/feedback-controller.ts`、`tests/core/feedback-controller.test.ts`、`src/ui/diagnostics/{llm-test,embedding-test,rerank-placeholder}.ts` | ✅ | `e79f473` | 诊断页改用 has*ApiKey;不再泄露 Key 前缀 |
| Task 8 | `docs/superpowers/STATUS.md` | ✅ | `599e2a6` | 全量验收:build 0 错误 / 258 测试 / lint 干净 |

**测试总数:** 258(实施前 232,新增 26 个)
**分支:** `main`(直接提交,未开 feature 分支)
**Plan 偏差:** 无

### 审查与修复

P-KEYCHAIN 8 个 Task 完成后进入代码审查,分级为 Critical 0 / Important 1 / Minor 8。

| 级别 | 问题 | 修复 | Commit |
|------|------|------|--------|
| Important | 钥匙串添加密钥后需重载插件才生效 | ChatView 加 `refreshKeyState()`(输入聚焦/发送前手动检测)+ `keyVersion` 计数器强制 Svelte 重算 + 按需 `rebuildLLM` | `6729fe1` |
| Minor #2+#3 | `getSecret` 无 try/catch,OS 钥匙串异常会冒泡阻断 rebuild | `getSecret` 加 try/catch + devLogger.error;LogModule union 加 `'secrets'` | `9da6e77` |
| Minor #5 | Rerank hint 缺「未配置即关闭」说明 | `renderSecretHint` 加可选 `note` 参数;settings.ts Rerank 段传入说明 | `9da6e77` |
| Minor #7 | 旧版 `data.json` 残留明文 Key 字段不会自动清理 | `loadSettings` 合并后 `delete` 四个 legacy 字段 | `9da6e77` |
| Minor #4 | ChatView `hasKey` 响应式对 settings mutate 不敏感 | 已被 keyVersion 方案覆盖(同 Important 修复) | — |
| Minor #6 | `renderSecretHint` 去掉 `app` 参数 | 合理简化,非问题 | — |
| Minor #8 | 手动 E2E 清单无法自动验证 | 非代码问题 | — |

**最终验收:** `npm run build` 0 errors / `npm test` 258 passed / `npm run lint` 0 errors

**未推送:** 因 GitHub 网络问题(端口 443 超时),`9da6e77` 与前序 9 个 commit 待网络恢复后推送 `origin/main`。

---

## 参考文件

- Spec: [`2026-06-26-ratel-keychain-design.md`](./2026-06-26-ratel-keychain-design.md)
- Plan: [`2026-06-26-ratel-keychain.md`](./2026-06-26-ratel-keychain.md)
