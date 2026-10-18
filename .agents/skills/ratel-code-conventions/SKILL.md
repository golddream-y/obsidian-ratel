---
name: ratel-code-conventions
description: 编写、修改或审查 Ratel 源码和测试时使用，统一类型与 ID、用户可见字符串国际化、中文注释及测试命名；不用于定义产品需求或执行发版。
---

# Ratel 编码约定

本 Skill 是跨模块编码约定的执行入口。遵循目标目录已加载的模块约束；不要求其他 Agent 已自动发现任何特定工具。

## 类型与模块约定

- TypeScript 启用 `"strict": true`。
- `async/await` 优先于 Promise 链。
- Plugin 类里用 `this.register*` 帮助函数管理清理。
- 每个文件只承担一个明确职责。

### 枚举与 ID 集中管理(mandatory)

架构级机制与骨架管理(注入源、Hook phase、Worker 消息类型、prompt zone 等 ID 清单 / 登记表)必须集中声明,按需求选型:

- **需要运行时遍历 / 校验**(登记表、白名单、防字面量散落)→ 用 `as const` 元组 + `(typeof X)[number]` 类型推导(强类型枚举的 TS 惯用法):一份声明同时得到可遍历的值清单与字面量联合类型,零运行时产物,esbuild 友好。范例见 `src/prompts/injection/ids.ts`。
- **仅做类型约束、无运行时需求** → 用字符串字面量联合(弱类型枚举,最轻)。范例见 `ToolPermission` / `ToolPermissionLevel`(`src/core/tool-permissions.ts`)。
- **禁止 TS `enum` / `const enum`**:enum 生成运行时对象(数字枚举含双向映射),类型与值列表两份维护;`const enum` 跨文件在 esbuild / isolatedModules 下退化。
- **禁止裸字符串字面量散落各调用点**:新增架构级 ID 时必须登记到对应集中声明处,不在线上硬编码。

## 用户可见字符串

> 所有新增功能的用户可见字符串必须走 i18n 机制,禁止硬编码。这是硬规矩 — 不协商。

### 触发时机

**任何 `feat` / `fix` commit 含新用户可见字符串时**:
- 实现者必须在 `src/i18n/zh.ts` + `en.ts` 加对应 key
- 代码里调 `t('key')` / `tNow('key')`,不允许字面量

### 用户可见字符串定义

下列场景**必须** i18n:
- Settings 面板的 `name` / `desc` / `heading` / `action` 文案
- Chat UI 的 placeholder / button / aria-label / 标题
- Notice / Modal 文案
- Status bar / Drawer 标签
- Slash command description
- Tool display name(format-tool-display 友好名,如"查看 xxx.md")
- 用户路径上的 throw new Error 消息(如路径校验、工具校验)

### 例外(不需 i18n)

- 面向开发者的 `console.*` / `devLogger.*`(用中文)
- LLM 收到的 prompt 正文(`prompts/defaults/zh.ts`)
- LLM 收到的 tool schema description
- 代码注释
- 错误堆栈(stack trace)

### 审查机制

- **subagent-driven-development spec 审查阶段**:检查硬编码字符串
- **requesting-code-review 技能**:检查 i18n 合规
- **翻译表开放式设计**:新功能在 `src/i18n/types.ts` 加 namespace interface,`zh.ts` / `en.ts` 用对象 spread 合并

## 语言与注释

- 注释与测试描述用中文，变量、类、函数和文件名保留英文。测试描述统一为“行为 - 条件 - 期望结果”。
- 用户路径上的错误走 i18n；开发日志、不会直接展示给用户的诊断用中文。不得用“开发错误”为名绕过用户可见错误翻译。
- 编写或审查源码时读取 [注释模板与判定准则](references/comments.md)，包括文件头、export/public 注释、修复与关键路径说明；不按模板堆显而易见的注释。
- i18n 设计历史见 [已归档设计](../../../docs/superpowers/archive/S-I18N-V2/2026-07-05-i18n-v2-design.md)，归档不改变当前中英文键一致要求。
