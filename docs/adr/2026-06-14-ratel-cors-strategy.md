# ADR-001:Ratel LLM 端点的 CORS 处理策略

**状态**:Draft
**日期**:2026-06-14

---

## Context(背景)

在 Obsidian 中配置 Ratel Vault 时,`chatApiBase` 指向 `https://ark.cn-beijing.volces.com/api/coding/v3`(火山方舟 doubao 端点)、`chatApiKey` 已配置(本 ADR 全文以 `<REDACTED-ARK-API-KEY>` 占位,真实密钥永久不进 git)。

ChatView 发起对话后,Chromium 渲染进程(`app://obsidian.md` Origin)对自定义 `Authorization` header 强制 preflight。volces 端点 OPTIONS 响应的 `Access-Control-Allow-Headers` **未列入 `authorization`**,导致 preflight 失败,POST 被拒:

```
Access to fetch at 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions'
from origin 'app://obsidian.md' has been blocked by CORS policy:
Request header field authorization is not allowed by
Access-Control-Allow-Headers in preflight response.

POST ... net::ERR_FAILED
```

**根因(三层)**:
- L1 浏览器:Chromium 对自定义 header 强制 preflight,服务端未允许该 header 则拒
- L2 服务端:volces 端点 CORS 白名单不含 `authorization`(托管型 API 通常无此选项)
- L3 客户端:`src/adapters/llm-deepseek.ts` 用纯 `fetch`,无 CORS 绕行或降级路径

**真正可解范围**:
- ✅ 换端点(DeepSeek / SiliconFlow / OpenAI 官方等 CORS 友好端点)
- ✅ 走 Obsidian 官方 `requestUrl()`(Node.js 层,绕开 Chromium preflight)
- ❌ `mode: 'no-cors'` 不可行(响应不透明)
- ❌ 砍 SDK header(我们没用 SDK,且本场景是 `authorization` 本身被拒)

**调研覆盖**:Obsidian 官方 `requestUrl` API、infio-copilot 源码(`/tmp/infio-copilot`)、Stainless SDK CORS 专题。

---

## Decision(决策)

**采用阶段 1(最小改动)**:在 `RatelVaultSettings` 新增 `chatTransport: 'fetch' | 'requestUrl'` 字段(默认 `'fetch'`),`llm-deepseek.ts` 根据该字段选择调用路径:

- `'fetch'`(默认):维持现状,继续用 `fetch` + `ReadableStream` 走 SSE 流式,适合 DeepSeek / SiliconFlow / OpenAI 官方 / Ollama localhost 等 CORS 友好端点
- `'requestUrl'`:用 `obsidian.requestUrl()` 走 Node.js 层绕开 CORS,代价是**失去流式**(自动把请求转成 `stream: false`,一次性 yield 完整响应),适合 volces 这类硬 CORS 端点

settings 面板 dropdown desc 直接写明「流式优先,选 requestUrl 可绕开 CORS 但失去逐字输出」。

**不采纳**:
- 阶段 2(SDK header 清理工具):`llm-deepseek.ts` 裸用 `fetch` 不带 `x-stainless-*`,本场景无此问题;不写无用的占位工具
- 阶段 3(本地代理字段):先看阶段 1 落地后用户反馈,真有需要再开 ADR-002
- `mode: 'no-cors'`、Electron `webRequest` 拦截改 CORS header、强制换端点:均明确拒绝(见后果)

---

## Consequences(后果)

**正面**:
- 任意 CORS 端点(包括 volces)可被调通,扩大 Ratel Vault 适用面
- 默认 CORS 友好端点(DeepSeek / SiliconFlow 等)用户**体验不变**
- 改动 < 100 行,改动面小:1 个 settings 字段 + `llm-deepseek.ts` 一处 if + 迁移测试 + 集成测试

**负面**:
- `requestUrl` 模式失去逐字输出,长响应等 5-30 秒一次性显示
- 用户在两种模式间切换需重启 ChatView(LLM 客户端在 rebuild 时定型)
- 错误日志脱敏规范需补到 `AGENTS.md`(本 ADR § 安全与隐私已记)

**影响面**:
- `src/settings.ts`:`RatelVaultSettings` 加 `chatTransport` 字段 + DEFAULT_SETTINGS 默认 `'fetch'` + 设置面板加 dropdown
- `src/adapters/llm-deepseek.ts`:`chat()` 内 if 两条路径;`buildRequestBody` 加 `stream` 参数
- 测试:`tests/settings-migration.test.ts`(旧值迁移)、`tests/adapters/llm-deepseek.test.ts`(双路径,需 mock `obsidian.requestUrl`)、`tests/integration/settings-propagation.test.ts`(切 transport → rebuild)
- 文档:README.md 「配置」章节加「若端点报 CORS 错误,把 Chat Transport 切到 `requestUrl`」指引

**安全与隐私**:
- API key 永久不进 git(本 ADR 全文以 `<REDACTED-XXX>` 占位)
- 错误日志只记 status code,body 仅记前 200 字符且过 regex 替 `<REDACTED>`
- AGENTS.md § 文档与注释规范后续补一条「ADR / Issue / 日志示例中 API key 必脱敏」

---

## 参考

- [Obsidian `requestUrl()` 官方 API](https://docs.obsidian.md/Reference/TypeScript+API/requestUrl)
- [掘金:Obsidian 插件必须 `requestUrl` 替代 `fetch` 解决跨域](https://juejin.cn/post/7437055230712004635)
- [CSDN:poe2openai 与 Stainless SDK `x-stainless-*` 头 CORS 预检专题](https://blog.csdn.net/gitblog_07517/article/details/148600921)
- `src/adapters/llm-deepseek.ts:67-77`(当前 `fetch` 入口)
- `src/settings.ts:20-49`(`RatelVaultSettings` 接口,字段新增落点)
