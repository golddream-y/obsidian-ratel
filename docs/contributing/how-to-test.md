# 本地测试手册(how to test)

> **目标读者:** Ratel 插件的开发者 / 贡献者。
> **目的:** 装一份当前开发版到本地 Obsidian,跑通关键场景验证改动。
> **范围:** 仅 W1 / W2 已实现的功能(聊天侧栏、设置面板、启停生命周期、状态命令)。
> **不在范围:** W3 / W4 还没做的部分 —— 索引器、混合检索、引用、链接建议等。

---

## 0. 当前能测什么、不能测什么

| 区域 | 状态 | 说明 |
|---|---|---|
| 插件加载 / 卸载 / 重载 | ✅ 可测 | `onload` / `onunload` 完整,Worker 进程管理已就绪 |
| 聊天侧栏(无工具) | ✅ 可测 | LLM 流式输出依赖 DeepSeek(或兼容 OpenAI 协议的服务) |
| 工具调用 | ✅ 可测 | 已注册 `read_note` 工具,LLM 可读 vault 里的笔记 |
| 设置面板 | ✅ 可测 | Chat / Embedding / Reranker / Indexing / Link Suggestions 五组 |
| Show index status 命令 | ✅ 可跑 | Worker 通信链 OK,但 W4 indexer 还没做,预期返回 `Index not available yet` |
| 索引 / 检索 / 引用 / 链接建议 | ❌ 不能测 | 排在 W3 / W4 plan,源码里这部分还是占位 |

---

## 1. 前置(一次性)

| 项 | 要求 |
|---|---|
| Node.js | ≥ 18(LTS) |
| Obsidian | ≥ 1.0(manifest 里 `minAppVersion: 1.0.0`) |
| 测试 vault | 单独建一个,不要拿主力 vault 冒险(插件会写 `data.json`、占 Sidebar) |
| 模型 API | 二选一:**DeepSeek** key(默认 `chatApiBase: https://api.deepseek.com`、模型 `deepseek-chat`),**或** 本地 Ollama 跑兼容 OpenAI 协议的服务 |

```bash
# 在仓库根
npm install
```

> 第一次跑链接前,Obsidian 那边要先打开目标 vault(否则 vault 目录还没创建)。

---

## 2. 场景一 — 启停生命周期

### 2.1 链接到 vault

```bash
# vault 路径走环境变量(更省事,后续 npm run link:vault 不用每次传参)
export RATEL_VAULT=/path/to/your/test-vault
npm run link:vault
```

预期输出(4 个全部"新建"):

```
→ 链接到 /path/to/your/test-vault/.obsidian/plugins/ratel-vault
  ✓ 新建 main.js       → .../dist/main.js
  ✓ 新建 worker.js     → .../dist/worker.js
  ✓ 新建 manifest.json → .../manifest.json
  ✓ 新建 styles.css    → .../styles.css
```

再次运行应全部"已存在"(幂等);故意改一个链接目标(`ln -sfn /x .../main.js`)再跑应触发"替换"。

### 2.2 启用插件

Obsidian 端:

1. 打开目标 vault
2. `Settings` → `Community plugins` → 关闭 `Restricted mode`(已关就跳过)
3. 已安装插件列表里翻到 `Ratel`,打开开关
4. 看到 ribbon 栏出现一个 🧠 脑图标 = 启用成功

### 2.3 验证加载

打开开发者控制台(`Cmd+Opt+I` / `Ctrl+Shift+I`):

```
> Ratel loaded
```

没看到这一行 = 加载失败,直接看控制台红字。

### 2.4 热重载不残留 Worker

开发中反复改代码,不能每次重启 Obsidian。流程:

```bash
# 终端 A: 持续监听
npm run dev
```

Obsidian 端:

1. 命令面板(`Cmd+P`)→ `Reload app without saving` —— 整个 vault 重启,插件 `onunload` 会清理 Worker
2. 或者只重载当前 vault 的插件:用社区插件 `Hot-Reload` 之类;没有就用第 1 步

**关键路径验证:** 重载后 macOS 活动监视器 / `ps aux | grep worker.js` 查不到 `worker.js` 残留进程。

### 2.5 卸载(测试结束)

```bash
npm run unlink:vault
```

预期:`✓ 已移除 4 个链接,真实文件未动`。`dist/` 下的 `main.js` / `worker.js` 没动,下次 `npm run link:vault` 直接恢复。

---

## 3. 场景二 — 聊天侧栏(核心)

### 3.0 先配 API key

`Settings` → `Ratel` → `Chat Model`:

- **用 DeepSeek:** 填 `API Key`(`API Base URL` 默认 `https://api.deepseek.com`、模型 `deepseek-chat`)
- **用 Ollama:** `API Base URL` 改 `http://localhost:11434/v1`、模型名换你跑的那个(如 `qwen2.5:7b`)、`API Key` 留空

切走前确认 key 写对了 —— 没 key 时点 Send,会立刻在回复框里追加 `⚠ Error: ...`。

### 3.1 唤起侧栏

三种入口任选其一:

| 入口 | 操作 |
|---|---|
| Ribbon | 点 🧠 脑图标 |
| 命令面板 | `Cmd+P` → `Ask vault` |
| 命令面板(可绑快捷键) | 同上 → 齿轮 → 绑键 |

关闭再开也 OK —— `onClose` 调 `$destroy()` 释放 Svelte,无内存泄漏。

### 3.2 最小对话(无工具调用)

侧栏里输入:

```
你好,用一句话介绍你自己
```

预期:

- 立即出现 `Thinking...` 占位(Svelte 等首个 `message.delta` 才会替换)
- 之后 Ratel 回复一字一字流式出现(`message.delta` 触发 `messages` 数组重建)
- 出现 `Ratel` 字样即流结束(`message.end`)
- 输入框解锁,可以接着发

### 3.3 工具调用(读笔记)

在测试 vault 里建一个笔记(比如 `hello.md`),内容随便写几行。

侧栏里输入:

```
读一下我的 hello.md 这篇笔记
```

LLM 应当:

1. 决定调 `read_note` 工具(单 tool_call)
2. 工具返回笔记内容
3. LLM 基于内容做总结回复

预期:回复里**确实出现了笔记正文的关键字**(不是 LLM 自己编的)。如果 LLM 答"我无法读取文件" / 自行编内容 = 工具调用链断了,看控制台 `agentLoop` 报错。

> 想看工具调用明细:控制台会有 `tool_calls` 相关的 log;或者在 `src/core/agent-loop.ts` 的工具 dispatch 处分期打 `console.log`。

### 3.4 异常路径

| 触发 | 预期 |
|---|---|
| 空消息 / 全空格 | Send 按钮 disabled,点了也没反应 |
| API key 为空 | 回复尾部追加 `⚠ Error: ...`(LLM 适配器抛 401) |
| 网络断 | 同上,错误信息含 fetch 失败字样 |
| 改完设置立刻发 | 用的是新值(设置项是立即写盘) |

---

## 4. 场景三 — 设置面板

### 4.1 切换 Embedding Provider

`Settings` → `Ratel` → `Embedding Model` → `Provider`:

- `Local (built-in)` → `API (external)`:`Local Model` 字段消失,出现 `API Base URL` / `API Key` / `Model` 三栏
- 反向切回,字段组反向消失

关键路径:Provider 切换会触发 `display()` 整体重渲染,字段组互斥不重叠。

### 4.2 切 Reranker Provider

`Provider` 改 `cohere` / `jina` / `siliconflow` / `custom`:

- 切到前三者时,`API Base URL` 自动填入官方默认值
- 切到 `custom` 不动 base(留给用户手填)

### 4.3 改 Indexing / Link Suggestions

- `Chunk size` / `Chunk overlap`:拖 slider,值立即写盘
- `Auto index` / `Auto suggest links`:toggle,值立即写盘
- `Confidence threshold`:拖 slider,值立即写盘

> 这两组 setting 当前**还只是配置项,没接到实际行为上**(Indexing 走 W4、Link Suggestions 还没做)。改完不影响功能 —— 这就是为什么场景一里 `Show index status` 总是 `not available yet`。

---

## 5. 场景四 — Show index status 命令

W4 indexer 没做,这个命令应当稳定返回 "Index not available yet" —— 它的价值在于验证 **Worker 通信链**:

```bash
# Obsidian 端: 命令面板 → "Show index status"
```

预期:右上角飘一个 `Index not available yet` 的 Notice(几秒后自动消失)。

如果出现的是别的话(报错、卡死):

- `Worker is not defined` 之类 = `worker.js` 没在 plugin 同目录(检查 2.1 的 `main.js` / `worker.js` 链接目标)
- 卡住没反应 = Worker 启动后没回响应(看控制台有无 worker 报错)

如果这个场景**通了**,说明:`onload` 起 Worker → `WorkerManager.request()` 收发消息 → Worker 的 `index.status` 处理器这整条链都活着。

---

## 6. 故障排查

| 现象 | 看哪里 | 可能原因 / 处置 |
|---|---|---|
| 启用后控制台没 `Ratel loaded` | Obsidian 控制台红字 | 多半是 `manifest.json` 缺字段 / `main.js` 解析失败;回 2.1 重新链接 |
| `worker.js` 找不到 / Worker 起不来 | 控制台 `Worker is not defined` / `Cannot find module` | 链接断了或目标文件不在;`npm run link:vault` 重新链接;`npm run build` 没产物也会报这个 |
| 链接时 `EEXIST: file already exists` | 链接脚本 | 之前留了同名普通文件;`rm <vault>/.obsidian/plugins/ratel-vault/main.js` 后重链 |
| 聊天没流式 / 直接一坨出 | 控制台 / Network 面板 | LLM 端没支持 SSE(DeepSeek 默认可),或 `LLMClient.streamChat` 解析断了 |
| 工具调用没触发 | 控制台 | `read_note` 工具的 schema 描述太模糊,LLM 不识别 —— 检查 `src/tools/read-note.ts` 的 description |
| 设置改了不生效 | 重启插件 | 部分配置要在 `onload` 时构造 adapter,运行时切换需重启 |

---

## 7. 配套工具命令速查

```bash
# 一次性
npm install
npm run build                       # tsc 类型检查 + esbuild 打包

# 日常开发
npm run dev                         # 监听模式,改 src/ 自动重 build 到 dist/
npm run link:vault                  # 把 dist/ + manifest 软链到 RATEL_VAULT(或第一个参数)
npm run link:dev                    # build + 链接,一次到位
npm run unlink:vault                # 清理链接

# 验证
npm test                            # vitest 跑单元 + 集成测试(目前 103 个)
npm run lint                        # eslint(注意:*.svelte 暂时跳不过,parser 未装)
npm run svelte-check                # Svelte + TS 联合类型检查
```

详细参数见 `scripts/link-vault.mjs` 文件头注释。
