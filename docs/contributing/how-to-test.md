# Ratel 构建与真机测试指南

> 适用版本：Ratel `1.3.0`，插件 ID `ratel-vault`。
> 本文是本地构建、三文件手动安装和真机验收的唯一指南。只使用 Obsidian Sandbox，不链接、覆盖或启用日常库中的插件。

## 1. 外部条件与构建入口

- 桌面系统与 Node.js 24、npm；发布 CI 同样使用 Node.js 24。
- Obsidian 桌面版 `1.13.1` 或更高版本；`manifest.json` 声明 `isDesktopOnly: true`，不支持移动端。
- 首次执行或依赖变化后在仓库根运行 `npm install`。
- 使用单独的 Sandbox vault。测试写入、删除或插件管理功能前，先在 `Settings → Ratel → Memory & permissions` 将相关工具改为 Ask 或 Deny；内置工具默认权限可能允许修改库内容。
- 远程聊天需要可用的模型端点和凭据；本地 embedding 首次使用需要联网下载模型与 ONNX Runtime WASM 资产。网络下载失败不代表本地 bundle 缺失。

真实构建入口是 `src/main.ts`，构建配置是 `esbuild.config.mjs`。在仓库根执行：

```bash
npm install
npm run build
```

`npm run build` 等价于 `node esbuild.config.mjs production`。生产流程先构建并内联 Worker，再生成主 bundle；不要用 `npm run dev` 的监听产物作为交付包。

## 2. 产物与手动安装包

构建直接生成 `dist/main.js`，清单和静态样式分别来自仓库根的 `manifest.json`、`styles.css`。为手动安装整理一个只含交付文件的目录：

```bash
mkdir -p dist/ratel-vault
cp dist/main.js dist/ratel-vault/main.js
cp manifest.json dist/ratel-vault/manifest.json
cp styles.css dist/ratel-vault/styles.css
```

| 用途 | 路径 | 说明 |
|---|---|---|
| 主 bundle | `dist/main.js` | esbuild 生产产物，已内联所需 Worker |
| 清单源文件 | `manifest.json` | 当前版本 `1.3.0`，最低 Obsidian `1.13.1` |
| 样式源文件 | `styles.css` | 实际交付样式，不是可选的空占位 |
| 手动安装目录 | `dist/ratel-vault/` | 仅复制其中三个文件到 vault |

`dist/embedding-worker.js`、`dist/index-runtime-worker.js`、`dist/skill-script-worker.js`、`dist/worker.js`、`dist/main.css` 和 `dist/meta-main.json` 是构建中间物或分析产物，不属于手动安装包。不要把整个 `dist/` 复制进插件目录。

2026-11-03 本次实际构建的包文件如下，可用于核对本次产物而非后续重建版本：

| 文件 | 字节数 | SHA-256 |
|---|---:|---|
| `dist/ratel-vault/main.js` | 15510820 | `a564512ae4ca4876716009946c6b7629f82f091a6a1addec38010610a2c2f89d` |
| `dist/ratel-vault/manifest.json` | 458 | `69ef121565d93b3c353b11c477e6b35e1dafb9af2451d3bf7e6e5e9aaff69123` |
| `dist/ratel-vault/styles.css` | 30542 | `692f52426ccaed0adc2c4519da2c5fd116fe74c3718f52d12dc1741d8284cef7` |

## 3. 复制、启用与重载

1. 在 Obsidian 中关闭目标 Sandbox；若其中已有 Ratel，先在社区插件设置中禁用它。
2. 创建 `<Vault>/.obsidian/plugins/ratel-vault/`。目录名必须与 `manifest.json` 的 `id` 完全一致。
3. 将 `dist/ratel-vault/main.js`、`dist/ratel-vault/manifest.json`、`dist/ratel-vault/styles.css` 三个文件直接复制到该目录，不要再嵌套一层 `ratel-vault/`。
4. 打开 Sandbox，进入 `Settings → Community plugins`，关闭 Restricted mode，在已安装插件中启用 **Ratel**。
5. 已启用过插件时，先禁用再启用，或执行命令面板的 `Reload app without saving`，确保加载的是新复制文件。

可在仓库根用以下命令复制；先把 `VAULT` 换成 Sandbox 的实际路径，不要指向日常库：

```bash
VAULT=/path/to/Sandbox
mkdir -p "$VAULT/.obsidian/plugins/ratel-vault"
cp dist/ratel-vault/main.js "$VAULT/.obsidian/plugins/ratel-vault/main.js"
cp dist/ratel-vault/manifest.json "$VAULT/.obsidian/plugins/ratel-vault/manifest.json"
cp dist/ratel-vault/styles.css "$VAULT/.obsidian/plugins/ratel-vault/styles.css"
```

## 4. 真机测试清单

以下项目均为“操作 → 期望结果 → 失败表现”。除特别注明外，本次只提供清单，尚未在真实 Obsidian 中执行，不能据构建或 Vitest 结果标记通过。

| 场景 | 操作 | 期望结果 | 失败表现 |
|---|---|---|---|
| 文件完整性 | 检查安装目录并读取 `manifest.json` | 三个文件直接位于 `ratel-vault/`；ID 为 `ratel-vault`、版本为 `1.3.0` | 缺文件、双层目录、ID 或版本不符，Obsidian 不识别插件 |
| 插件发现与启用 | 启动 Sandbox，在社区插件列表启用 Ratel | Ratel 出现在列表并可启用；控制台无模块解析或 `onload` 异常 | 列表无 Ratel、开关自动回退、控制台出现红字 |
| 正常界面 | 点击 Ratel ribbon 图标，打开聊天并检查设置页 | 聊天与设置可打开；文字、按钮、表单无重叠、遮挡或不可辨 | 图标或视图缺失、空白页、布局错乱、控制台渲染异常 |
| 空态 | 在没有聊天历史的新 Sandbox 打开聊天 | 显示可理解的初始/空状态，输入区可用，无伪造历史或报错 | 空白、持续加载、旧会话串入库、无法输入 |
| 加载与禁用 | 发起一个需要模型响应的请求，等待期间尝试重复提交 | 有明确加载状态，重复提交受控；结束后输入区恢复 | 无加载反馈、重复请求、界面永久禁用或卡死 |
| 身份/权限失败 | 使用无效 API key 或将读取工具设为 Deny 后发起对应请求 | 显示可理解的鉴权或权限错误，不泄露 key，界面可继续操作 | 静默失败、暴露密钥、权限被拒绝仍读取/修改、应用卡死 |
| 网络失败 | 断开网络后请求远程聊天或首次下载本地模型资产 | 显示网络/下载失败并可重试，既有 vault 内容不变 | 无限加载、未捕获异常、重试无效、笔记被意外修改 |
| 真实 vault 读取与解码 | 新建含中文、Emoji 和唯一标记的 `测试-读取.md`，明确要求只读该文件并复述唯一标记 | 返回该文件真实正文，中文与 Emoji 无乱码，不修改文件 | 读取错误文件、路径解析失败、正文乱码、模型编造内容或文件被改动 |
| 真实 ONNX 重建 | 选择本地 embedding，在全新 Sandbox 或清除其测试索引后执行重建，保持网络可用 | 模型与 WASM 按需下载，索引进度推进并完成，无 Worker/WASM 异常；中断后可按产品行为恢复 | 下载失败、进度不走、Worker/WASM 加载异常、重建后状态仍错误 |
| 真实检索与引用 | 重建后查询仅存在于测试笔记的独特语义内容，并打开回答引用 | 检索到正确笔记，引用能打开原位置，结果不是模型臆造 | 无结果、错笔记、引用失效、结果与索引内容不一致 |
| 重载与卸载 | 禁用再启用 Ratel，随后重载 Sandbox | 视图和命令不重复，旧任务/Worker 按设计清理，重新启用后可用 | 重复视图、残留任务、端口/Worker 异常、无法再次启用 |

每个失败项都应记录 Obsidian 版本、操作系统、插件版本、操作步骤、控制台错误和截图；不得在失败后以单元测试结果替代该项真机验收。

## 5. 本次验证记录与已知缺口

2026-11-03 在 macOS、Node.js `24.11.0`、npm `11.6.1` 下实际执行：

| 命令 | 结果 |
|---|---|
| `npm run build` | 退出码 0；生成生产 bundle。出现 18 条既有 Svelte 状态捕获、a11y 与未使用 CSS 警告，无构建错误 |
| `npm test` | 退出码 0；323 个测试文件通过、4 个跳过；3008 项测试通过、24 个跳过，耗时 77.90 秒 |
| 三文件暂存与 Node.js 门禁脚本 | 退出码 0；三文件存在且非空，ID/版本匹配；未发现 `this.display()` 或空 `getSettingDefinitions(){return[]}` stub |
| `shasum -a 256 dist/ratel-vault/{main.js,manifest.json,styles.css}` | 退出码 0；摘要见第 2 节 |

本次未运行 `npm run lint`、`npm run typecheck`，也未执行真实 Obsidian 安装与界面验收。**真实 vault 读取与解码、真实 ONNX 索引重建与检索均尚未真机验证，不得宣称完成。** 正常态、空态、身份/权限/网络错误态、加载/禁用态以及模型下载同样没有真机结论。

构建警告涉及 `src/ui/chat/`、`src/ui/status/`、`src/ui/motion/`、`src/ui/orbs/` 下的既有 Svelte 文件，责任归对应 UI 实现维护者；本次未修改业务逻辑。若后续构建失败，应原样记录完整命令、首个错误及堆栈、涉及文件和责任模块，不得为让构建变绿而回退他人改动或顺手修改无关业务代码。
