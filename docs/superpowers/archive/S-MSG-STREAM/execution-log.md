# S-MSG-STREAM — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-06-28 — P-MSG-STREAM(Chat 消息流重构)

**分支:** `feat/s-msg-stream`(已合并,已清理)
**合并 commit:** `54af747`(feat(s-msg-stream): Chat 消息流重构 — segments 判别联合 + token 三层校准)
**合并方式:** 17 commits 合并到 main,54 文件变更(+6700/-1262)

### Task 完成情况

按 plan 20 个 Task 跨 8 阶段(A-H)执行:
- A. 纯逻辑模块(segments 判别联合、segment-appender)
- B. 端口扩展(reasoning/usage 字段预留)
- C. 适配器(DeepSeek reasoning_content 解析)
- D. 目录归拢(chat/message-stream、chat/input、status、tokens、components、diagnostics)
- E. 组件创建(TextSegment/ThinkSegment/ToolSegment/Collapsible)
- F. ChatView 重构(遍历 segments 委托子组件)
- G. 接线
- H. Task 8(15 file moves + 18 import fixes)+ Task 20(全量验证)

**关键决策:**
- 消息模型改为 segments 判别联合,支持 text/think/tool/image/citation 段类型,保留事件时序
- token 三层校准:context-manager 精确估算(send前)→ 流式中英混合权重估算 → API 真值(message.end 校准)
- 模型 context length 通过 probe-model.ts 测试连接推断,失败用内置映射表回退
- agent-loop 保留核心逻辑,search-result-mapper 等大块逻辑移出
- 折叠组件通用化,通过 slot 支持 think/tool/详情共用

**测试总数:** 453 passed(3 pre-existing failures — 真实 API 401,非回归)
**三产物构建:** main.js(10M) + worker.js(6.3M) + embedding-worker.js(75K)
**Plan 偏差:** Claude adapter 因 `llm-anthropic.ts` 文件缺失 scoped out,reasoning/usage 字段在端口层预留未用

---

## 2026-06-28 — 设计与架构文档同步(commit `dd890f3`)

- spec `2026-06-28-chat-message-stream-redesign-design.md` 写入并自审
- 架构文档 `docs/architecture/agent/chat.md` 同步 5 处:state diagrams 加 text/reasoning 交替、event tables 加 reasoning/usage、Chat UI 拆 7 子节、orchestration 责任边界、message persistence 改 segments
- 交互原型 `chat-ui-mockup.html` 创建
