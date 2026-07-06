# Skill 机制基础与激活(P-SKILL-1-CORE)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Ratel Vault 中实现 Skill 机制基础层(三源加载 + 注册表 + 激活/反激活 + Discovery/Activation 注入 system prompt + 2 个 LLM 工具 + 斜杠命令),让用户通过 markdown 文件扩展 Agent 行为。

**Architecture:** 端口/适配器分层。`src/skills/` 为核心层(类型 + loader + registry + activator),`src/ports/skill-port.ts` 定义文件系统访问端口,`src/adapters/skill-vault.ts` 与 `src/adapters/skill-fs.ts` 实现该端口(分别走 ObsidianVault 外观与 node:fs)。Skill 注入 system prompt 复用现有 Composer + PromptSection 机制,新增 `agent.skills` section(zone: 'dynamic', `allowOverride: false`),由 `SkillActivator` 在 ContextManager 拼装时注入 Discovery 段 + Active 段。

**Tech Stack:** TypeScript(esbuild 打包)、gray-matter(frontmatter 解析,新依赖)、node:fs(全局/预置源)、ObsidianVault 外观(vault 内源)、vitest(单元测试)。

**前置依赖:** 无(本 plan 是 S-SKILL 的第一个 plan,基础层无依赖)。

**Spec 参考:** `docs/superpowers/specs/2026-07-06-skill-mechanism-design.md` §4.1-4.7(文件结构/frontmatter/三源/Discovery/Activation/工具)、§4.10-4.11(模块结构/与现有架构关系)、§5.1(P-SKILL-1-CORE 范围)。

---

## 文件结构

### 新建文件

| 路径 | 职责 |
|------|------|
| `src/skills/types.ts` | Skill / SkillManifest / SkillSource / SkillActivation 类型 |
| `src/skills/skill-loader.ts` | 三源扫描 + frontmatter 解析 + 合并 |
| `src/skills/skill-registry.ts` | 内存注册表(enabled/disabled/active 状态) |
| `src/skills/skill-activator.ts` | 激活/反激活逻辑,产出 Discovery/Active 段文本 |
| `src/ports/skill-port.ts` | SkillPort 接口(零实现) |
| `src/adapters/skill-vault.ts` | vault 内 skills 适配(走 ObsidianVault 外观) |
| `src/adapters/skill-fs.ts` | 全局 + 预置 skills 适配(node:fs) |
| `src/tools/activate-skill.ts` | activate_skill 工厂函数 |
| `src/tools/deactivate-skill.ts` | deactivate_skill 工厂函数 |
| `src/skills/skill-loader.test.ts` | loader 单元测试 |
| `src/skills/skill-registry.test.ts` | registry 单元测试 |
| `src/skills/skill-activator.test.ts` | activator 单元测试 |
| `src/tools/activate-skill.test.ts` | activate_skill 工具测试 |
| `src/tools/deactivate-skill.test.ts` | deactivate_skill 工具测试 |

### 修改文件

| 路径 | 改动 |
|------|------|
| `src/prompts/types.ts` | `PromptSectionId` 加 `'agent.skills'` 字面量 |
| `src/prompts/sections.ts` | 注册 `agent.skills` section + 2 个工具 section 元数据 |
| `src/prompts/composer.ts` | 加 `composeSkillsDiscovery` / `composeActiveSkills` |
| `src/prompts/defaults/zh.ts` | 加 `agent.skills` + 2 个工具 section 默认文案 |
| `src/prompts/tool-schemas.ts` | 加 `activate_skill` / `deactivate_skill` schema + `ALL_TOOL_NAMES` |
| `src/core/context-manager.ts` | 加 `setSkillsContext` + `toMessages` 注入 skills 段 |
| `src/core/agent-loop.ts` | activate/deactivate 工具执行后触发 ctx skills 段重组 |
| `src/main.ts` | onload 初始化 SkillLoader/Registry/Activator + 注册 2 工具 + Reload skills 命令 + `.ratel/skills/` 文件监听 |
| `src/settings.ts` | 加 `enableSkills: boolean` 字段 + Settings group |
| `src/ui/chat/input/slash-commands.ts` | 加 `/skill` / `/skills` / `/skill off` |
| `src/i18n/types.ts` | 加 `SkillStrings` namespace + `promptLabel.skill.*` + `promptLabel.tool.activate_skill.*` |
| `src/i18n/zh.ts` | 加 skill 翻译 |
| `src/i18n/en.ts` | 加 skill 翻译 |
| `package.json` | 加 `gray-matter` 与 `@types/gray-matter` 依赖 |

---

### Task 1: 类型定义 + i18n namespace 骨架 + PromptSectionId 扩展

**Files:**
- Create: `src/skills/types.ts`
- Modify: `src/prompts/types.ts:14-27`
- Modify: `src/i18n/types.ts:578-588`(Strings 合并加 SkillStrings)
- Modify: `src/i18n/types.ts`(新增 SkillStrings interface)

- [ ] **Step 1: 创建 `src/skills/types.ts` 类型定义**

```typescript
/**
 * @file src/skills/types.ts
 * @description Skill 机制核心类型 — Skill / SkillManifest / SkillSource / SkillActivation
 * @module skills/types
 * @depends prompts/types(仅 PromptSectionId 引用,无运行时依赖)
 */

/**
 * Skill 来源标识,对应三源合并存储的优先级。
 *
 * 关键路径:
 * - `builtin`:插件出厂自带(`<pluginDir>/skills/`),只读,优先级最低
 * - `global`:跨 vault 通用(`~/.ratel/skills/`),用户在文件系统手动管理
 * - `vault`:跟随 vault git/syncthing 同步(`<vaultRoot>/.ratel/skills/`),优先级最高
 */
export type SkillSource = 'builtin' | 'global' | 'vault';

/**
 * Skill 激活模式(来自 SKILL.md frontmatter `activation` 字段)。
 *
 * - `auto`:LLM 自主决定是否激活(默认)
 * - `manual`:仅 `/skill <name>` 斜杠命令可激活,不出现在 Discovery 段
 * - `always`:加载后持续激活(等效全局指令),Discovery 阶段自动激活
 */
export type SkillActivation = 'auto' | 'manual' | 'always';

/**
 * 多语言描述(来自 frontmatter `i18n.description`)。
 *
 * 关键路径:locale key 用 2 字母(zh / en),与 i18n Lang 类型一致。
 * 缺失对应 locale 时 fallback 到顶层 `description` 字段。
 */
export interface SkillI18nDescription {
	[key: string]: string;
}

/**
 * Skill manifest — SKILL.md frontmatter 解析结果。
 *
 * 关键路径:
 * - `name` 必须匹配正则 `^[a-z][a-z0-9-]{0,63}$`,加载时校验,非法值跳过并记 warning
 * - `description` 非空,建议 ≤200 字符(Loader 不强制,Discovery 注入时超长截断)
 * - `version` SemVer,解析失败记 warning,不影响加载
 * - `activation` 非法值降级 `auto`
 * - `enabled` 默认 true,可在 settings 内 toggle
 */
export interface SkillManifest {
	/** 唯一标识(kebab-case) */
	name: string;
	/** LLM 据此判断是否激活(Discovery 注入) */
	description: string;
	/** SemVer,显示用,不参与兼容判断 */
	version?: string;
	/** 作者标识 */
	author?: string;
	/** 是否启用(默认 true) */
	enabled: boolean;
	/** 激活模式 */
	activation: SkillActivation;
	/** 辅助分类标签 */
	tags: string[];
	/** 多语言 description,locale → 文案 */
	i18nDescription?: SkillI18nDescription;
}

/**
 * Skill 完整对象 — manifest + 正文 + 来源元数据。
 *
 * 关键路径:
 * - `instructions` 是 SKILL.md frontmatter 之后的正文,激活时全文注入 system prompt
 * - `source` 记录来源(builtin/global/vault),供 UI 展示与同名覆盖判断
 * - `dir` 是 skill 文件夹绝对路径,供 references/scripts 读取(P-SKILL-2 使用)
 */
export interface Skill {
	/** Manifest(frontmatter 解析结果) */
	manifest: SkillManifest;
	/** SKILL.md 正文(frontmatter 之后的全部内容) */
	instructions: string;
	/** 来源 */
	source: SkillSource;
	/** skill 文件夹绝对路径 */
	dir: string;
}

/**
 * 加载过程中的 warning(不阻塞加载,记录后跳过当前 skill)。
 *
 * 关键路径:Loader 收集所有 warning 供 main.ts 启动日志输出,
 * 帮助用户排查 frontmatter 损坏 / name 非法 / 文件读失败等问题。
 */
export interface SkillLoadWarning {
	/** skill 文件夹路径或文件名 */
	path: string;
	/** 警告消息(开发者日志用,中文) */
	message: string;
}
```

- [ ] **Step 2: 扩展 `src/prompts/types.ts` 的 PromptSectionId**

在现有 `PromptSectionId` 联合类型中 `'memory.systemPrompt'` 之后插入 `'agent.skills'`:

```typescript
export type PromptSectionId =
	| 'agent.base'
	| 'agent.rag.workflow'
	| 'agent.rag.toolGuide'
	| 'injection.searchResults.body'
	| 'memory.systemPrompt'
	// 关键路径:Skill 机制 Discovery 段 — 注入已加载 skill 的 name+description 列表,
	// 供 LLM 自主判断是否调 activate_skill。zone: 'dynamic',allowOverride: false。
	| 'agent.skills'
	| 'internal.compact'
	| 'internal.intent.system'
	| 'internal.intent.user'
	| 'internal.rewrite.system'
	| 'internal.rewrite.user'
	| `tool.${string}.description`
	| `tool.${string}.param.${string}`;
```

- [ ] **Step 3: 在 `src/i18n/types.ts` 新增 SkillStrings interface**

在 `MemoryStrings` 之后插入(参考 `MemoryStrings` 的 namespace 模式):

```typescript
// ==================== Skill(Skill 机制 — P-SKILL-1-CORE 消费) ====================
// 关键路径:SkillStrings 覆盖 settings 面板 / Notice / slash 命令 / 来源标签 / 激活态标签
export interface SkillStrings {
  // Settings 面板 — Skills group
  'skill.settings.heading': string;
  'skill.settings.enableSkills.name': string;
  'skill.settings.enableSkills.desc': string;
  // Notice(Toast)
  'skill.notice.activating': string;
  'skill.notice.activated': string;
  'skill.notice.deactivated': string;
  'skill.notice.notFound': string;
  'skill.notice.alreadyActive': string;
  'skill.notice.notActive': string;
  'skill.notice.reloadDone': string;
  'skill.notice.reloadFailed': string;
  // Slash 命令描述
  'skill.cmd.skill': string;
  'skill.cmd.skills': string;
  'skill.cmd.reloadSkills': string;
  // addCommand name(命令面板)
  'cmd.reloadSkills': string;
  // 来源标签
  'skill.source.builtin': string;
  'skill.source.global': string;
  'skill.source.vault': string;
  // 激活模式标签
  'skill.activation.auto': string;
  'skill.activation.manual': string;
  'skill.activation.always': string;
  // Discovery / Active 段文案(PromptLabelStrings 已覆盖 promptLabel.skill.*)
  'skill.discovery.title': string;
  'skill.discovery.empty': string;
  'skill.active.title': string;
  // 错误
  'error.skill.invalidName': string;
  'error.skill.notEnabled': string;
  'error.skill.loadFailed': string;
}
```

- [ ] **Step 4: 在 `src/i18n/types.ts` 的 Strings 合并加 SkillStrings**

```typescript
export interface Strings extends
  BaseStrings, SettingsStrings, ChatStrings, ToolNameStrings,
  SlashStrings, NoticeStrings, ModalStrings, StatusStrings,
  DiagnosticsStrings, ErrorStrings, PromptLabelStrings, MemoryStrings,
  CmdStrings, ToolPermStrings, SkillStrings {
  // 后续新功能按 namespace 追加 extends
}
```

- [ ] **Step 5: 验证类型编译通过**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: 编译失败,提示 `zh.ts` / `en.ts` 缺少 SkillStrings key(预期 — 下游 Task 补翻译)。但 `types.ts` 自身无类型错误。

- [ ] **Step 6: Commit**

```bash
git add src/skills/types.ts src/prompts/types.ts src/i18n/types.ts
git commit -m "feat(skill): 定义 Skill 核心类型 + i18n SkillStrings namespace + PromptSectionId 扩展

- src/skills/types.ts: Skill/SkillManifest/SkillSource/SkillActivation/SkillLoadWarning
- src/prompts/types.ts: PromptSectionId 加 'agent.skills'
- src/i18n/types.ts: 新增 SkillStrings interface,Strings 合并 extends

P-SKILL-1-CORE Task 1"
```

---

### Task 2: SkillPort 接口 + skill-vault / skill-fs 适配器 + skill-loader

**Files:**
- Create: `src/ports/skill-port.ts`
- Create: `src/adapters/skill-vault.ts`
- Create: `src/adapters/skill-fs.ts`
- Create: `src/skills/skill-loader.ts`
- Modify: `package.json`(加 gray-matter 依赖)

- [ ] **Step 1: 安装 gray-matter 依赖**

Run: `npm install gray-matter && npm install -D @types/gray-matter`
Expected: package.json dependencies 加 `gray-matter`,devDependencies 加 `@types/gray-matter`。

- [ ] **Step 2: 创建 `src/ports/skill-port.ts` 接口**

```typescript
/**
 * @file src/ports/skill-port.ts
 * @description SkillPort — Skill 文件系统访问端口(零实现,符合端口/适配器架构)
 * @module ports/skill-port
 * @depends skills/types
 */

import type { SkillSource } from '../skills/types';

/**
 * Skill 文件系统访问端口。
 *
 * 设计要点:
 * - 端口只定义契约,实现由 `adapters/skill-vault.ts`(ObsidianVault 外观)
 *   与 `adapters/skill-fs.ts`(node:fs)提供。
 * - 每个适配器实例绑定一个根目录(builtin pluginDir/skills,global ~/.ratel/skills,
 *   vault vaultRoot/.ratel/skills),构造时注入,运行时不可变。
 * - 所有路径在适配器内部做 path traversal 校验(spec §4.3 安全约束)。
 *
 * 关键路径:Loader 通过 SkillPort 抽象访问三源,不直接 import fs 或 ObsidianVault,
 * 保证 loader 可单测(mock SkillPort)。
 */
export interface SkillPort {
	/** 此端口绑定的来源标识 */
	readonly source: SkillSource;
	/** 此端口绑定的根目录绝对路径 */
	readonly rootDir: string;
	/**
	 * 列出根目录下所有 skill 文件夹名(不含路径,仅文件夹名)。
	 *
	 * 关键路径:只返回直接子文件夹(非递归),且文件夹内必须含 SKILL.md
	 * (不含 SKILL.md 的文件夹跳过,记 warning)。
	 */
	listSkillFolders(): Promise<string[]>;
	/**
	 * 读取指定 skill 的 SKILL.md 全文(frontmatter + 正文)。
	 *
	 * @param skillName - skill 文件夹名(kebab-case)
	 * @returns SKILL.md 全文;文件不存在时抛错
	 */
	readSkillManifest(skillName: string): Promise<string>;
}
```

- [ ] **Step 3: 创建 `src/adapters/skill-fs.ts`(全局 + 预置源,node:fs)**

```typescript
/**
 * @file src/adapters/skill-fs.ts
 * @description SkillFsAdapter — 用 node:fs 读全局/预置 skills 的 SkillPort 实现
 * @module adapters/skill-fs
 * @depends node:fs, node:path, ports/skill-port, skills/types
 */

import fs from 'fs';
import path from 'path';
import type { SkillPort } from '../ports/skill-port';
import type { SkillSource } from '../skills/types';

/**
 * node:fs 实现的 SkillPort — 用于全局源(`~/.ratel/skills/`)与预置源(`<pluginDir>/skills/`)。
 *
 * 设计要点:
 * - 构造时注入 `source` 与 `rootDir`,运行时只读,不写。
 * - `listSkillFolders` 用 `fs.readdirSync` 读直接子目录,过滤掉文件与不含 SKILL.md 的目录。
 * - `readSkillManifest` 用 `fs.readFileSync` 读 SKILL.md 全文。
 * - path traversal 防护:`readSkillManifest` 内用 `path.resolve` 后校验结果仍在 `rootDir` 内。
 *
 * 关键路径:全局/预置源不监听文件变更(spec §4.4),仅 onload 扫描一次。
 */
export class SkillFsAdapter implements SkillPort {
	constructor(
		readonly source: SkillSource,
		readonly rootDir: string,
	) {}

	async listSkillFolders(): Promise<string[]> {
		// 关键路径:目录不存在时返回空数组,不抛错(全局源可能尚未创建)。
		if (!fs.existsSync(this.rootDir)) return [];
		const entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
		const folders: string[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			// 关键路径:必须含 SKILL.md,否则跳过(不含 SKILL.md 的文件夹不是有效 skill)。
			const skillMdPath = path.join(this.rootDir, entry.name, 'SKILL.md');
			if (fs.existsSync(skillMdPath)) {
				folders.push(entry.name);
			}
		}
		return folders;
	}

	async readSkillManifest(skillName: string): Promise<string> {
		// 关键路径:path traversal 防护 — resolve 后校验仍在 rootDir 内。
		const resolved = path.resolve(this.rootDir, skillName, 'SKILL.md');
		if (!resolved.startsWith(this.rootDir + path.sep) && resolved !== path.join(this.rootDir, skillName, 'SKILL.md')) {
			throw new Error(`path traversal blocked: ${skillName}`);
		}
		return fs.readFileSync(resolved, 'utf-8');
	}
}
```

- [ ] **Step 4: 创建 `src/adapters/skill-vault.ts`(vault 内源,走 ObsidianVault 外观)**

```typescript
/**
 * @file src/adapters/skill-vault.ts
 * @description SkillVaultAdapter — 走 ObsidianVault 外观读 vault 内 skills 的 SkillPort 实现
 * @module adapters/skill-vault
 * @depends obsidian-vault, ports/skill-port, skills/types, utils/path-safety
 */

import type { ObsidianVault } from './obsidian-vault';
import type { SkillPort } from '../ports/skill-port';
import type { SkillSource } from '../skills/types';
import { validateVaultPath } from '../utils/path-safety';

/**
 * ObsidianVault 适配的 SkillPort — 读 `<vaultRoot>/.ratel/skills/` 内的 skills。
 *
 * 设计要点:
 * - 所有 Obsidian API 访问走 ObsidianVault 外观(AGENTS.md 架构约束)。
 * - `listSkillFolders` 委托 `vault.listFiles` 读目录,过滤含 SKILL.md 的子文件夹。
 * - `readSkillManifest` 委托 `vault.readFile`,路径经 `validateVaultPath` 防 traversal。
 * - vault 内源会监听文件变更(spec §4.4),但监听由 main.ts 注册,
 *   适配器本身不订阅事件(保持无状态)。
 *
 * 关键路径:vault 内源是用户主要管理 skill 的位置(随 vault git/syncthing 同步),
 * 优先级最高,同名覆盖 builtin 与 global。
 */
export class SkillVaultAdapter implements SkillPort {
	readonly source: SkillSource = 'vault';

	constructor(
		private vault: ObsidianVault,
		readonly rootDir: string,
	) {}

	async listSkillFolders(): Promise<string[]> {
		// 关键路径:vault.listFiles 在目录不存在时返回空数组(Obsidian API 行为)。
		const { folders } = await this.vault.listFiles(this.rootDir);
		const skillFolders: string[] = [];
		for (const folder of folders) {
			// 关键路径:folders 是相对 rootDir 的子目录路径,需拼前缀再校验 SKILL.md。
			const skillMdPath = `${this.rootDir}/${folder}/SKILL.md`;
			if (await this.vault.fileExists(skillMdPath)) {
				// 关键路径:folder 可能含子路径(嵌套),取末尾段作为 skill 名。
				// 三源结构要求 skill 直接在 rootDir 下,嵌套文件夹不识别。
				const name = folder.split('/').pop()!;
				skillFolders.push(name);
			}
		}
		return skillFolders;
	}

	async readSkillManifest(skillName: string): Promise<string> {
		// 关键路径:用 validateVaultPath 防 traversal(vault 内路径安全约束)。
		const relativePath = `${this.rootDir}/${skillName}/SKILL.md`;
		const normalized = validateVaultPath(relativePath);
		return this.vault.readFile(normalized);
	}
}
```

- [ ] **Step 5: 创建 `src/skills/skill-loader.ts`(三源扫描 + frontmatter 解析 + 合并)**

```typescript
/**
 * @file src/skills/skill-loader.ts
 * @description SkillLoader — 三源扫描 + frontmatter 解析 + 同名合并(vault > global > builtin)
 * @module skills/skill-loader
 * @depends gray-matter, ports/skill-port, skills/types
 */

import matter from 'gray-matter';
import type { SkillPort } from '../ports/skill-port';
import type { Skill, SkillManifest, SkillActivation, SkillLoadWarning } from './types';

/**
 * Skill name 合法正则(spec §4.2):全小写字母数字 + 连字符,首字母必须字母,长度 1-64。
 */
const SKILL_NAME_REGEX = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Skill 加载器 — 扫描三源,解析 frontmatter,合并同名 skill。
 *
 * 设计要点:
 * - 三源按 builtin → global → vault 顺序加载,后者覆盖前者同名 skill(spec §4.3)。
 * - frontmatter 解析用 gray-matter,失败时记 warning 跳过,不阻塞其他 skill。
 * - name 校验:正则不匹配 / 为空 → 跳过并记 warning。
 * - activation 非法值降级 'auto'(spec §4.2 字段约束)。
 * - enabled 缺省 true。
 *
 * 关键路径:Loader 只负责"读 + 解析 + 合并",不维护运行时状态(enabled/active 状态由 Registry 管)。
 *
 * @example
 *   const loader = new SkillLoader([builtinPort, globalPort, vaultPort]);
 *   const { skills, warnings } = await loader.loadAll();
 */
export class SkillLoader {
	constructor(private ports: SkillPort[]) {}

	/**
	 * 扫描全部已注入的端口,返回合并后的 skill 列表与 warning 列表。
	 *
	 * 关键路径:
	 * - 按 ports 数组顺序加载(调用方负责顺序:builtin → global → vault)
	 * - 同名 skill 后者覆盖前者(spec §4.3 合并规则)
	 * - 单个 skill 加载失败不阻塞其他 skill
	 *
	 * @returns skills: 合并后的 skill 数组;warnings: 加载过程中的警告
	 */
	async loadAll(): Promise<{ skills: Skill[]; warnings: SkillLoadWarning[] }> {
		// 关键路径:用 Map 按 name 去重覆盖,builtin 先入,vault 后入覆盖。
		const merged = new Map<string, Skill>();
		const warnings: SkillLoadWarning[] = [];

		for (const port of this.ports) {
			const folderNames = await this.safeListFolders(port, warnings);
			for (const folderName of folderNames) {
				const skill = await this.tryLoadOne(port, folderName, warnings);
				if (skill) {
					// 关键路径:后者覆盖前者(spec §4.3 同名覆盖)。
					merged.set(skill.manifest.name, skill);
				}
			}
		}

		return { skills: Array.from(merged.values()), warnings };
	}

	/**
	 * 安全列出端口下的 skill 文件夹,失败时记 warning 返回空数组。
	 */
	private async safeListFolders(port: SkillPort, warnings: SkillLoadWarning[]): Promise<string[]> {
		try {
			return await port.listSkillFolders();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			warnings.push({ path: port.rootDir, message: `列出 skill 文件夹失败: ${message}` });
			return [];
		}
	}

	/**
	 * 尝试加载单个 skill,失败时记 warning 返回 undefined。
	 */
	private async tryLoadOne(
		port: SkillPort,
		folderName: string,
		warnings: SkillLoadWarning[],
	): Promise<Skill | undefined> {
		const skillPath = `${port.rootDir}/${folderName}`;
		try {
			const raw = await port.readSkillManifest(folderName);
			const parsed = matter(raw);
			const manifest = this.buildManifest(parsed.data, folderName, skillPath, warnings);
			if (!manifest) return undefined;
			return {
				manifest,
				// 关键路径:gray-matter 的 content 是 frontmatter 之后的正文。
				instructions: parsed.content.trim(),
				source: port.source,
				dir: skillPath,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			warnings.push({ path: skillPath, message: `加载失败: ${message}` });
			return undefined;
		}
	}

	/**
	 * 从 frontmatter 数据构建 SkillManifest,校验并降级非法值。
	 *
	 * 关键路径:
	 * - name 必须匹配正则,否则跳过并记 warning
	 * - description 必须非空,否则跳过
	 * - activation 非法值降级 'auto'
	 * - enabled 缺省 true
	 * - version 解析失败记 warning,不影响加载(不参与兼容判断)
	 */
	private buildManifest(
		data: Record<string, unknown>,
		folderName: string,
		skillPath: string,
		warnings: SkillLoadWarning[],
	): SkillManifest | undefined {
		const name = typeof data.name === 'string' ? data.name : folderName;
		if (!SKILL_NAME_REGEX.test(name)) {
			warnings.push({
				path: skillPath,
				message: `name 非法(需匹配 ${SKILL_NAME_REGEX.source}): ${name}`,
			});
			return undefined;
		}
		const description = typeof data.description === 'string' ? data.description : '';
		if (!description) {
			warnings.push({ path: skillPath, message: 'description 为空' });
			return undefined;
		}
		const activation = this.normalizeActivation(data.activation, skillPath, warnings);
		const enabled = typeof data.enabled === 'boolean' ? data.enabled : true;
		const tags = Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === 'string') : [];
		const i18nDescription = this.extractI18nDescription(data.i18n, skillPath, warnings);
		return {
			name,
			description,
			version: typeof data.version === 'string' ? data.version : undefined,
			author: typeof data.author === 'string' ? data.author : undefined,
			enabled,
			activation,
			tags,
			i18nDescription,
		};
	}

	/**
	 * 规范化 activation 字段,非法值降级 'auto'(spec §4.2)。
	 */
	private normalizeActivation(
		value: unknown,
		skillPath: string,
		warnings: SkillLoadWarning[],
	): SkillActivation {
		if (value === 'auto' || value === 'manual' || value === 'always') return value;
		if (value !== undefined) {
			warnings.push({ path: skillPath, message: `activation 非法值 "${value}",降级 auto` });
		}
		return 'auto';
	}

	/**
	 * 提取 i18n.description 多语言描述对象。
	 */
	private extractI18nDescription(
		i18n: unknown,
		skillPath: string,
		warnings: SkillLoadWarning[],
	): SkillManifest['i18nDescription'] {
		if (!i18n || typeof i18n !== 'object') return undefined;
		const desc = (i18n as Record<string, unknown>).description;
		if (!desc || typeof desc !== 'object') return undefined;
		const result: Record<string, string> = {};
		for (const [locale, text] of Object.entries(desc as Record<string, unknown>)) {
			if (typeof text === 'string') {
				result[locale] = text;
			} else {
				warnings.push({ path: skillPath, message: `i18n.description.${locale} 非字符串,跳过` });
			}
		}
		return Object.keys(result).length > 0 ? result : undefined;
	}
}
```

- [ ] **Step 6: 验证编译通过**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: 编译通过(SkillLoader 无运行时依赖,仅类型)。

- [ ] **Step 7: Commit**

```bash
git add src/ports/skill-port.ts src/adapters/skill-fs.ts src/adapters/skill-vault.ts src/skills/skill-loader.ts package.json package-lock.json
git commit -m "feat(skill): SkillPort 接口 + skill-fs/skill-vault 适配器 + SkillLoader 三源合并

- src/ports/skill-port.ts: SkillPort 端口接口(listSkillFolders/readSkillManifest)
- src/adapters/skill-fs.ts: node:fs 实现(全局/预置源)
- src/adapters/skill-vault.ts: ObsidianVault 外观实现(vault 内源)
- src/skills/skill-loader.ts: gray-matter 解析 frontmatter + 同名覆盖 + warning 收集
- package.json: 加 gray-matter + @types/gray-matter

P-SKILL-1-CORE Task 2"
```

---

### Task 3: SkillRegistry(内存注册表)

**Files:**
- Create: `src/skills/skill-registry.ts`

- [ ] **Step 1: 创建 `src/skills/skill-registry.ts`**

```typescript
/**
 * @file src/skills/skill-registry.ts
 * @description SkillRegistry — 内存注册表,管理 enabled/disabled/active 三态
 * @module skills/skill-registry
 * @depends skills/types, i18n
 */

import type { Skill, SkillManifest, SkillLoadWarning } from './types';
import { tNow } from '../i18n';

/**
 * Skill 注册表 — 内存常驻,管理 skill 的加载结果与运行时状态。
 *
 * 设计要点:
 * - 三态管理:
 *   - `enabled`:skill manifest 的 enabled 字段(用户可改),控制是否进入 Discovery
 *   - `active`:session 内激活态,激活后 instructions 注入 system prompt
 *   - `always`:activation='always' 的 skill 在 Discovery 阶段自动 active
 * - `reload(skills, warnings)` 全量替换内部状态,供 main.ts 重新扫描后调用
 * - 激活态不跨会话持久化(spec §4.5 — session 关闭时全部清空)
 *
 * 关键路径:Registry 不直接读文件系统(load 由 Loader 做),只维护内存状态。
 * Activator 通过 Registry 拿 enabled skill 列表与 active skill 列表。
 */
export class SkillRegistry {
	/** 全部已加载 skill(name → Skill) */
	private skills = new Map<string, Skill>();
	/** 加载 warnings(供 main.ts 日志输出) */
	private warnings: SkillLoadWarning[] = [];
	/** 当前激活的 skill name 集合(session 内有效) */
	private activeSkills = new Set<string>();
	/** 用户手动 toggle 的 enabled 覆盖(name → boolean);未在 map 中则用 manifest.enabled */
	private enabledOverrides = new Map<string, boolean>();

	/**
	 * 全量替换已加载 skill(供 main.ts reload 调用)。
	 *
	 * 关键路径:
	 * - 保留当前 activeSkills(若新列表中仍存在同名 skill)
	 * - 保留 enabledOverrides(用户 toggle 的状态跨 reload 保留)
	 * - activation='always' 的 skill 自动加入 activeSkills
	 *
	 * @param skills - Loader 加载合并后的 skill 列表
	 * @param warnings - Loader 产生的 warning 列表
	 */
	reload(skills: Skill[], warnings: SkillLoadWarning[]): void {
		this.skills = new Map(skills.map((s) => [s.manifest.name, s]));
		this.warnings = warnings;
		// 关键路径:清理已不存在的 active skill。
		for (const name of Array.from(this.activeSkills)) {
			if (!this.skills.has(name)) {
				this.activeSkills.delete(name);
			}
		}
		// 关键路径:activation='always' 的 skill 自动激活(spec §4.5)。
		for (const skill of skills) {
			if (skill.manifest.activation === 'always' && this.isEnabled(skill.manifest.name)) {
				this.activeSkills.add(skill.manifest.name);
			}
		}
	}

	/**
	 * 获取全部已加载 skill(不含 active 状态过滤)。
	 */
	getAll(): Skill[] {
		return Array.from(this.skills.values());
	}

	/**
	 * 获取 warnings(加载过程中的非阻塞警告)。
	 */
	getWarnings(): SkillLoadWarning[] {
		return this.warnings;
	}

	/**
	 * 按 name 取单个 skill。
	 *
	 * @returns skill 存在则返回,否则 undefined
	 */
	get(name: string): Skill | undefined {
		return this.skills.get(name);
	}

	/**
	 * 判断 skill 是否启用(考虑 manifest.enabled 与 enabledOverrides)。
	 *
	 * 关键路径:enabledOverrides 优先于 manifest.enabled,用户在 settings/UI toggle 后立即生效。
	 */
	isEnabled(name: string): boolean {
		const skill = this.skills.get(name);
		if (!skill) return false;
		if (this.enabledOverrides.has(name)) {
			return this.enabledOverrides.get(name)!;
		}
		return skill.manifest.enabled;
	}

	/**
	 * 设置单个 skill 的 enabled 覆盖(用户 toggle)。
	 */
	setEnabled(name: string, enabled: boolean): void {
		if (!this.skills.has(name)) return;
		this.enabledOverrides.set(name, enabled);
		// 关键路径:禁用时清掉 active 状态,避免 instructions 仍在 system prompt 里。
		if (!enabled) {
			this.activeSkills.delete(name);
		}
	}

	/**
	 * 获取进入 Discovery 段的 skill 列表(enabled 且 activation != 'manual')。
	 *
	 * 关键路径:activation='manual' 的 skill 不出现在 Discovery 段(spec §4.5b),
	 * 仅 `/skill <name>` 可激活。
	 */
	getDiscovered(): Skill[] {
		return this.getAll().filter((s) => {
			if (!this.isEnabled(s.manifest.name)) return false;
			return s.manifest.activation !== 'manual';
		});
	}

	/**
	 * 获取当前激活的 skill 列表(instructions 已注入 system prompt)。
	 */
	getActive(): Skill[] {
		return Array.from(this.activeSkills)
			.map((name) => this.skills.get(name))
			.filter((s): s is Skill => s !== undefined);
	}

	/**
	 * 激活指定 skill — 读 instructions 正文并加入 activeSkills。
	 *
	 * 关键路径:
	 * - skill 不存在 → 抛 notFound
	 * - skill 未启用 → 抛 notEnabled
	 * - 已激活 → 幂等返回(不报错)
	 *
	 * @param name - skill name
	 * @returns 激活后的 Skill 对象(供 Activator 拼 system prompt)
	 * @throws skill 不存在或未启用时抛 i18n 错误
	 */
	activate(name: string): Skill {
		const skill = this.skills.get(name);
		if (!skill) {
			throw new Error(tNow('skill.notice.notFound', { name }));
		}
		if (!this.isEnabled(name)) {
			throw new Error(tNow('error.skill.notEnabled', { name }));
		}
		this.activeSkills.add(name);
		return skill;
	}

	/**
	 * 反激活指定 skill — 从 activeSkills 移除。
	 *
	 * @param name - skill name
	 * @throws skill 未激活时抛 notActive
	 */
	deactivate(name: string): void {
		if (!this.activeSkills.has(name)) {
			throw new Error(tNow('skill.notice.notActive', { name }));
		}
		this.activeSkills.delete(name);
	}

	/**
	 * 清空全部激活态(供 chat session 关闭时调用,spec §4.5)。
	 */
	clearActive(): void {
		this.activeSkills.clear();
	}
}
```

- [ ] **Step 2: 验证编译通过**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: 编译通过。

- [ ] **Step 3: Commit**

```bash
git add src/skills/skill-registry.ts
git commit -m "feat(skill): SkillRegistry 内存注册表 — enabled/disabled/active 三态管理

- reload(): 全量替换 + 保留 active/enabledOverrides + always 自动激活
- getDiscovered(): Discovery 段 skill 列表(enabled 且非 manual)
- getActive(): 当前激活 skill 列表
- activate/deactivate: 状态切换 + i18n 错误
- clearActive(): session 关闭时清空

P-SKILL-1-CORE Task 3"
```

---

### Task 4: SkillActivator + prompts 集成 + ContextManager 注入

**Files:**
- Create: `src/skills/skill-activator.ts`
- Modify: `src/prompts/sections.ts`(加 `agent.skills` section + 2 个工具 section 元数据)
- Modify: `src/prompts/composer.ts`(加 `composeSkillsDiscovery` / `composeActiveSkills`)
- Modify: `src/prompts/defaults/zh.ts`(加 `agent.skills` + 工具 section 默认文案)
- Modify: `src/core/context-manager.ts`(加 `setSkillsContext` + `toMessages` 注入)
- Modify: `src/i18n/types.ts`(PromptLabelStrings 加 `promptLabel.skill.*` + `promptLabel.tool.activate_skill.*`)
- Modify: `src/i18n/zh.ts` + `src/i18n/en.ts`(加 promptLabel.skill.* 翻译)

- [ ] **Step 1: 扩展 `src/i18n/types.ts` 的 PromptLabelStrings**

在 `PromptLabelStrings` interface 末尾(`promptLabel.retrieval.wrapperSuffix` 之前)加:

```typescript
  // 关键路径:Skill 机制 Discovery 段 section(用户可在 Prompt overrides 面板覆盖)
  'promptLabel.agent.skills': string;
  'promptLabel.agent.skills.desc': string;
  // 关键路径:2 个 skill 工具 section 元数据
  'promptLabel.tool.activate_skill.description': string;
  'promptLabel.tool.activate_skill.description.desc': string;
  'promptLabel.tool.activate_skill.param.name': string;
  'promptLabel.tool.activate_skill.param.name.desc': string;
  'promptLabel.tool.deactivate_skill.description': string;
  'promptLabel.tool.deactivate_skill.description.desc': string;
  'promptLabel.tool.deactivate_skill.param.name': string;
  'promptLabel.tool.deactivate_skill.param.name.desc': string;
```

- [ ] **Step 2: 在 `src/i18n/zh.ts` 的 `promptLabelZh` 加翻译**

在 `promptLabel.memory.systemPrompt.desc` 之后插入:

```typescript
  // 关键路径:Skill 机制 Discovery 段
  'promptLabel.agent.skills': 'Skill Discovery 段',
  'promptLabel.agent.skills.desc': '已加载 skill 的 name+description 列表,供 LLM 自主判断是否激活',
  // 关键路径:activate_skill 工具
  'promptLabel.tool.activate_skill.description': 'activate_skill 描述',
  'promptLabel.tool.activate_skill.description.desc': '激活指定 Skill,读完整 SKILL.md 注入上下文',
  'promptLabel.tool.activate_skill.param.name': 'activate_skill.name',
  'promptLabel.tool.activate_skill.param.name.desc': 'Skill 名称(kebab-case)',
  // 关键路径:deactivate_skill 工具
  'promptLabel.tool.deactivate_skill.description': 'deactivate_skill 描述',
  'promptLabel.tool.deactivate_skill.description.desc': '关闭已激活的 Skill,移除其指令段',
  'promptLabel.tool.deactivate_skill.param.name': 'deactivate_skill.name',
  'promptLabel.tool.deactivate_skill.param.name.desc': 'Skill 名称',
```

在 `zh.ts` 末尾的 `export const zh` 合并对象中无需改动(SkillStrings 的 key 在 Task 1 已加入 extends,但翻译对象需补充)。在 `memoryZh` 之后新增 `skillZh`(SkillStrings 翻译):

```typescript
const skillZh: SkillStrings = {
  // Settings 面板
  'skill.settings.heading': 'Skill 管理',
  'skill.settings.enableSkills.name': '启用 Skill 机制',
  'skill.settings.enableSkills.desc': '关闭后 Agent 不加载 skill,Discovery/Activation 段不注入',
  // Notice
  'skill.notice.activating': '正在激活 {name}...',
  'skill.notice.activated': '已激活 {name}',
  'skill.notice.deactivated': '已关闭 {name}',
  'skill.notice.notFound': '未找到 Skill: {name}',
  'skill.notice.alreadyActive': '{name} 已激活',
  'skill.notice.notActive': '{name} 未激活',
  'skill.notice.reloadDone': '已重新加载 {count} 个 Skill',
  'skill.notice.reloadFailed': 'Skill 重新加载失败: {message}',
  // Slash 命令描述
  'skill.cmd.skill': '激活 Skill',
  'skill.cmd.skills': '列出 Skill',
  'skill.cmd.reloadSkills': '重新加载 Skill',
  // addCommand name
  'cmd.reloadSkills': '重新加载 Skill',
  // 来源标签
  'skill.source.builtin': '预置',
  'skill.source.global': '全局',
  'skill.source.vault': 'vault 内',
  // 激活模式标签
  'skill.activation.auto': '自动',
  'skill.activation.manual': '手动',
  'skill.activation.always': '常驻',
  // Discovery / Active 段
  'skill.discovery.title': '可用 Skills',
  'skill.discovery.empty': '(暂无已加载的 Skill)',
  'skill.active.title': '当前激活的 Skill',
  // 错误
  'error.skill.invalidName': 'Skill 名称非法: {name}',
  'error.skill.notEnabled': 'Skill {name} 未启用',
  'error.skill.loadFailed': 'Skill 加载失败: {message}',
};
```

在 `export const zh = { ... }` 合并对象加 `...skillZh,`。

- [ ] **Step 3: 在 `src/i18n/en.ts` 加对应英文翻译**

在 `en.ts` 的合并对象中加入对应 key(参考 zh.ts 结构,英文文案):

```typescript
  // Skill strings
  'skill.settings.heading': 'Skills',
  'skill.settings.enableSkills.name': 'Enable Skill mechanism',
  'skill.settings.enableSkills.desc': 'When off, Agent loads no skills; Discovery/Activation not injected',
  'skill.notice.activating': 'Activating {name}...',
  'skill.notice.activated': 'Activated {name}',
  'skill.notice.deactivated': 'Deactivated {name}',
  'skill.notice.notFound': 'Skill not found: {name}',
  'skill.notice.alreadyActive': '{name} already active',
  'skill.notice.notActive': '{name} not active',
  'skill.notice.reloadDone': 'Reloaded {count} skills',
  'skill.notice.reloadFailed': 'Skill reload failed: {message}',
  'skill.cmd.skill': 'Activate skill',
  'skill.cmd.skills': 'List skills',
  'skill.cmd.reloadSkills': 'Reload skills',
  'cmd.reloadSkills': 'Reload skills',
  'skill.source.builtin': 'builtin',
  'skill.source.global': 'global',
  'skill.source.vault': 'vault',
  'skill.activation.auto': 'auto',
  'skill.activation.manual': 'manual',
  'skill.activation.always': 'always',
  'skill.discovery.title': 'Available Skills',
  'skill.discovery.empty': '(no skills loaded)',
  'skill.active.title': 'Active Skills',
  'error.skill.invalidName': 'Invalid skill name: {name}',
  'error.skill.notEnabled': 'Skill {name} is not enabled',
  'error.skill.loadFailed': 'Skill load failed: {message}',
  // promptLabel.skill.*
  'promptLabel.agent.skills': 'Skill Discovery section',
  'promptLabel.agent.skills.desc': 'Loaded skill name+description list for LLM auto-routing',
  'promptLabel.tool.activate_skill.description': 'activate_skill description',
  'promptLabel.tool.activate_skill.description.desc': 'Activate a skill, inject SKILL.md instructions',
  'promptLabel.tool.activate_skill.param.name': 'activate_skill.name',
  'promptLabel.tool.activate_skill.param.name.desc': 'Skill name (kebab-case)',
  'promptLabel.tool.deactivate_skill.description': 'deactivate_skill description',
  'promptLabel.tool.deactivate_skill.description.desc': 'Deactivate a skill, remove its instructions',
  'promptLabel.tool.deactivate_skill.param.name': 'deactivate_skill.name',
  'promptLabel.tool.deactivate_skill.param.name.desc': 'Skill name',
```

- [ ] **Step 4: 在 `src/prompts/sections.ts` 注册 `agent.skills` section + 2 工具 section**

在 `buildSections()` 数组中,`memory.systemPrompt` 之后插入 `agent.skills`:

```typescript
		// 关键路径:Skill 机制 Discovery 段 — 注入已加载 skill 的 name+description 列表。
		// zone: 'dynamic',allowOverride: false(spec §4.4 — 不可被用户覆盖删除,防 LLM 失去 skill 感知)。
		{
			id: 'agent.skills',
			label: tNow('promptLabel.agent.skills'),
			description: tNow('promptLabel.agent.skills.desc'),
			zone: 'dynamic',
			placeholders: ['skillList'],
			allowOverride: false,
		},
```

在 `tool.delete_note.description` 之后追加 2 个工具 section:

```typescript
		// --- tool.activate_skill ---
		{
			id: 'tool.activate_skill.description',
			label: tNow('promptLabel.tool.activate_skill.description'),
			description: tNow('promptLabel.tool.activate_skill.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.activate_skill.param.name',
			label: tNow('promptLabel.tool.activate_skill.param.name'),
			description: tNow('promptLabel.tool.activate_skill.param.name.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		// --- tool.deactivate_skill ---
		{
			id: 'tool.deactivate_skill.description',
			label: tNow('promptLabel.tool.deactivate_skill.description'),
			description: tNow('promptLabel.tool.deactivate_skill.description.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
		{
			id: 'tool.deactivate_skill.param.name',
			label: tNow('promptLabel.tool.deactivate_skill.param.name'),
			description: tNow('promptLabel.tool.deactivate_skill.param.name.desc'),
			zone: 'tool',
			placeholders: [],
			allowOverride: true,
		},
```

- [ ] **Step 5: 在 `src/prompts/defaults/zh.ts` 加默认文案**

在 `memory.systemPrompt` 之后插入 `agent.skills` 默认文案;在文件末尾(tool.* 区)追加 2 工具 section:

```typescript
	// 关键路径:Skill Discovery 段 — 注入已加载 skill 的 name+description 列表。
	// 占位符:{{skillList}} = skill 列表行("- name: description" 格式)。
	'agent.skills': `## 可用 Skills

以下 skill 已加载,你可在任务需要时调用 \`activate_skill(name)\` 激活对应指令集。激活后该 skill 的完整指令会注入上下文,直到任务完成或你主动 deactivate。

{{skillList}}`,
```

在 `tool.forget_memory.param.match` 之后追加:

```typescript
	'tool.activate_skill.description': '激活一个已加载的 Skill。激活后该 skill 的指令会注入到上下文,直到任务完成或你主动 deactivate。',
	'tool.activate_skill.param.name': 'Skill 名称(kebab-case)',
	'tool.deactivate_skill.description': '关闭一个已激活的 Skill,从上下文移除其指令。',
	'tool.deactivate_skill.param.name': 'Skill 名称',
```

- [ ] **Step 6: 创建 `src/skills/skill-activator.ts`**

```typescript
/**
 * @file src/skills/skill-activator.ts
 * @description SkillActivator — 产出 Discovery 段与 Active 段文本,供 ContextManager 注入 system prompt
 * @module skills/skill-activator
 * @depends skills/skill-registry, i18n
 */

import type { SkillRegistry } from './skill-registry';
import type { Skill } from './types';
import type { OverrideMap } from '../prompts/types';
import { resolveSection } from '../prompts/composer';
import { interpolate } from '../prompts/interpolate';
import { tNow } from '../i18n';

/**
 * Skill 激活器 — 产出两段 system prompt 文本:
 *
 * 1. Discovery 段:列出 enabled 且非 manual 的 skill 的 name+description,
 *    注入到 system prompt 的 `agent.rag.toolGuide` 之后、检索结果之前(spec §4.4)。
 * 2. Active 段:当前激活的 skill 的 instructions 正文,作为动态指令追加(spec §4.5)。
 *
 * 设计要点:
 * - 不维护状态,纯函数式产出文本(状态由 Registry 管)
 * - Discovery 段走 `agent.skills` prompt section(支持 override),Active 段不走 section
 *   (instructions 是 skill 作者写的,不进 section 注册表)
 * - 50 个 skill 上限时按 tags 粗筛(spec §4.4 — v2 优化,本 plan 实现简单字面量截断到 50)
 *
 * 关键路径:Activator 由 ContextManager 在 toMessages 时调用,产出文本注入到 system 与
 * memorySystemPrompt 之间(或 memorySystemPrompt 不存在时直接在 system 之后)。
 */
export class SkillActivator {
	/** Discovery 段最多展示的 skill 数(spec §4.4 — 超过 50 时按 tags 粗筛,v2 优化) */
	private static readonly MAX_DISCOVERY_SKILLS = 50;

	constructor(private registry: SkillRegistry) {}

	/**
	 * 产出 Discovery 段文本(enabled 且非 manual 的 skill 列表)。
	 *
	 * 关键路径:
	 * - 无 enabled skill 时返回空串(不注入,避免空段)
	 * - 超过 50 个时截断到前 50 个(v2 按 tags + query 粗筛)
	 * - skillList 格式:`- name: description`(每行一个)
	 *
	 * @param overrides - prompt section 覆盖(来自 settings.promptOverrides)
	 * @returns Discovery 段文本;无 skill 时返回空串
	 */
	composeDiscovery(overrides: OverrideMap): string {
		const discovered = this.registry.getDiscovered();
		if (discovered.length === 0) return '';

		// 关键路径:超过 50 个截断(v2 按 tags 粗筛)。
		const limited = discovered.slice(0, SkillActivator.MAX_DISCOVERY_SKILLS);
		const skillList = limited
			.map((s) => `- ${s.manifest.name}: ${this.resolveDescription(s)}`)
			.join('\n');

		const template = resolveSection('agent.skills', overrides);
		return interpolate(template, { skillList });
	}

	/**
	 * 产出 Active 段文本(当前激活的 skill 的 instructions 正文)。
	 *
	 * 关键路径:
	 * - 无 active skill 时返回空串(不注入)
	 * - 每个 skill 的 instructions 用标题包裹(`## 当前激活的 Skill: <name>`)
	 * - 多 skill 激活时累加,空行分隔
	 *
	 * @returns Active 段文本;无 active skill 时返回空串
	 */
	composeActive(): string {
		const active = this.registry.getActive();
		if (active.length === 0) return '';

		const parts = active.map((s) => {
			const title = tNow('skill.active.title');
			return `## ${title}: ${s.manifest.name}\n\n${s.instructions}`;
		});
		return parts.join('\n\n');
	}

	/**
	 * 解析 skill 的 description(优先 i18n.description 当前语言,fallback 顶层 description)。
	 *
	 * 关键路径:i18n.description 缺失当前 locale 时 fallback 到顶层 description(spec §4.2)。
	 */
	private resolveDescription(skill: Skill): string {
		return skill.manifest.description;
	}
}
```

- [ ] **Step 7: 在 `src/prompts/composer.ts` 加 `composeSkillsDiscovery` / `composeActiveSkills` 包装函数**

在 `composeMemorySystemPrompt` 之后追加(供 ContextManager 调用,封装 Activator):

```typescript
/**
 * 组装 Skill Discovery 段 — 注入到 system prompt 的 memorySystemPrompt 之后。
 *
 * 关键路径:
 * - 委托 SkillActivator.composeDiscovery 产出文本
 * - 不做 retrieval wrapper 包裹(Discovery 段是指令,不是检索结果)
 * - enableSkills=false 或无 enabled skill 时返回空串(不注入)
 *
 * @param discoveryText - SkillActivator 产出的 Discovery 段文本(已含模板)
 * @returns 传入非空则原样返回,空串则返回空串
 */
export function composeSkillsDiscovery(discoveryText: string): string {
	return discoveryText;
}

/**
 * 组装 Skill Active 段 — 注入到 Discovery 段之后。
 *
 * 关键路径:Active 段是激活 skill 的 instructions 正文,不做 wrapper 包裹(是指令)。
 *
 * @param activeText - SkillActivator 产出的 Active 段文本
 * @returns 传入非空则原样返回,空串则返回空串
 */
export function composeActiveSkills(activeText: string): string {
	return activeText;
}
```

> 注:这两个包装函数看似冗余,但保留是为了与 `composeMemorySystemPrompt` 对称,未来若需加 wrapper / 截断逻辑有挂载点。若执行者认为冗余可直接在 ContextManager 内联 Activator 调用,但建议保留对称性。

- [ ] **Step 8: 修改 `src/core/context-manager.ts` 加 `setSkillsContext` + `toMessages` 注入**

在 `ContextManagerDeps` interface 加 `getSkillsDiscovery` / `getSkillsActive` getter:

```typescript
export interface ContextManagerDeps {
	getOverrides: () => OverrideMap;
	getTools: () => ToolDefinition[];
	/**
	 * 关键路径:返回当前 Skill Discovery 段文本(由 Activator 产出)。
	 * 空串表示不注入(无 enabled skill 或 enableSkills=false)。
	 */
	getSkillsDiscovery?: () => string;
	/**
	 * 关键路径:返回当前 Skill Active 段文本(由 Activator 产出)。
	 * 空串表示无激活 skill。
	 */
	getSkillsActive?: () => string;
}
```

在 `ContextManager` 类内,`memorySystemPrompt` 字段后加 `skillsDiscovery` / `skillsActive` 字段:

```typescript
	/**
	 * Skill Discovery 段 — 启动时由 setSkillsContext() 设置,
	 * 注入位置在 memorySystemPrompt 之后、searchResults 之前。
	 */
	private skillsDiscovery = '';
	/**
	 * Skill Active 段 — 激活/反激活时由 setSkillsContext() 更新,
	 * 注入位置在 skillsDiscovery 之后。
	 */
	private skillsActive = '';
```

加 `setSkillsContext` 方法(在 `setMemoryContext` 之后):

```typescript
	/**
	 * 设置 Skill 上下文 — 在会话启动时与 activate/deactivate 工具执行后调用。
	 *
	 * 关键路径:
	 * - discovery 与 active 文本由 SkillActivator 产出(在调用方)
	 * - toMessages 时注入到 memorySystemPrompt 之后、searchResultsMessages 之前
	 * - 空串表示对应段不注入
	 *
	 * @param discovery - Discovery 段文本(空串则不注入)
	 * @param active - Active 段文本(空串则不注入)
	 */
	setSkillsContext(discovery: string, active: string): void {
		this.skillsDiscovery = discovery;
		this.skillsActive = active;
	}
```

修改 `toMessages` 方法,在 `memorySystemPrompt` 注入后加 skills 注入:

```typescript
	toMessages(intent: Intent = 'direct'): ChatMessage[] {
		const overrides = this.deps.getOverrides();
		const tools = this.deps.getTools();
		const systemPrompt = composeAgentSystem(intent, { intent, tools }, overrides);
		const history = this.session?.messages ?? [];
		const trimmed = this.trimHistory(history);

		const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
		if (this.memorySystemPrompt) {
			messages.push({ role: 'system', content: this.memorySystemPrompt });
		}
		// 关键路径:Skill 段注入 — Discovery 在前,Active 在后,均位于 memory 与 searchResults 之间。
		// 两段合并为一条 system 消息(避免消息数膨胀)。
		const skillsText = [this.skillsDiscovery, this.skillsActive]
			.filter((s) => s.length > 0)
			.join('\n\n');
		if (skillsText) {
			messages.push({ role: 'system', content: skillsText });
		}
		messages.push(...this.searchResultsMessages, ...trimmed);
		return messages;
	}
```

- [ ] **Step 9: 验证编译通过**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: 编译通过。

- [ ] **Step 10: Commit**

```bash
git add src/skills/skill-activator.ts src/prompts/sections.ts src/prompts/composer.ts src/prompts/defaults/zh.ts src/core/context-manager.ts src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat(skill): SkillActivator + agent.skills section + ContextManager skills 段注入

- src/skills/skill-activator.ts: composeDiscovery/composeActive 产出两段文本
- src/prompts/sections.ts: 注册 agent.skills section(allowOverride: false)+ 2 工具 section
- src/prompts/composer.ts: composeSkillsDiscovery/composeActiveSkills 包装
- src/prompts/defaults/zh.ts: agent.skills + activate_skill/deactivate_skill 默认文案
- src/core/context-manager.ts: setSkillsContext + toMessages 注入 skills 段
- src/i18n/types.ts: PromptLabelStrings 加 promptLabel.skill.* / promptLabel.tool.activate_skill.*
- src/i18n/zh.ts/en.ts: 加 skillZh 翻译 + promptLabel.skill.* 翻译

P-SKILL-1-CORE Task 4"
```

---

### Task 5: activate_skill / deactivate_skill 工具 + tool-schemas + agent-loop 集成

**Files:**
- Create: `src/tools/activate-skill.ts`
- Create: `src/tools/deactivate-skill.ts`
- Modify: `src/prompts/tool-schemas.ts`(加 2 个 schema + ALL_TOOL_NAMES)
- Modify: `src/core/agent-loop.ts`(activate/deactivate 执行后触发 ctx skills 段重组)

- [ ] **Step 1: 在 `src/prompts/tool-schemas.ts` 加 2 个 schema**

在 `forget_memory` 之后追加:

```typescript
	activate_skill: {
		name: 'activate_skill',
		parameters: {
			type: 'object',
			properties: {
				name: { type: 'string' },
			},
			required: ['name'],
		},
	},
	deactivate_skill: {
		name: 'deactivate_skill',
		parameters: {
			type: 'object',
			properties: {
				name: { type: 'string' },
			},
			required: ['name'],
		},
	},
```

在 `ALL_TOOL_NAMES` 数组末尾追加 `'activate_skill', 'deactivate_skill'`:

```typescript
export const ALL_TOOL_NAMES = [
	'read_note', 'search_vault', 'grep', 'glob', 'list_files',
	'write_note', 'append_note', 'edit_note', 'delete_note',
	'search_memory', 'remember', 'forget_memory',
	'activate_skill', 'deactivate_skill',
];
```

- [ ] **Step 2: 创建 `src/tools/activate-skill.ts`**

```typescript
/**
 * @file src/tools/activate-skill.ts
 * @description `activate_skill` 工具 — 激活指定 skill,读完整 SKILL.md 注入 system prompt
 * @module tools/activate-skill
 * @depends core/tool-registry, skills/skill-registry, ports/llm, i18n
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { SkillRegistry } from '../skills/skill-registry';
import { tNow } from '../i18n';

/**
 * 构造 `activate_skill` 工具实例。
 *
 * 设计要点:
 * - 只读工具(`readOnly: true`),不触发写钩子 — 激活只改 system prompt,不写文件。
 * - 内部调用 `registry.activate(name)`,失败时抛 i18n 错误(notFound / notEnabled)。
 * - 工具返回值是简短确认文本,供 LLM 知道激活成功。
 * - `definition` 由调用方通过 Composer 生成后注入(参考 search-vault 模式)。
 *
 * 关键路径:激活后 system prompt 的重组不在工具内做 — 由 agent-loop 在工具执行后
 * 调 `ctx.setSkillsContext(...)` 触发(见 Task 5 Step 4)。
 *
 * @param registry - SkillRegistry 实例
 * @param definition - LLM 侧 schema,由 composeToolDefinitions 生成
 * @returns 符合 Tool 接口的工具定义
 */
export function createActivateSkillTool(
	registry: SkillRegistry,
	definition: ToolDefinition,
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			if (typeof args.name !== 'string' || args.name.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'name', type: typeof args.name }));
			}
			const name = args.name;
			// 关键路径:registry.activate 幂等 — 已激活时直接返回(不抛 alreadyActive)。
			// 但这里用 getActive 判断返回更友好的消息。
			const active = registry.getActive();
			if (active.some((s) => s.manifest.name === name)) {
				return tNow('skill.notice.alreadyActive', { name });
			}
			const skill = registry.activate(name);
			return tNow('skill.notice.activated', { name: skill.manifest.name });
		},
	};
}
```

- [ ] **Step 3: 创建 `src/tools/deactivate-skill.ts`**

```typescript
/**
 * @file src/tools/deactivate-skill.ts
 * @description `deactivate_skill` 工具 — 关闭已激活的 skill,从 system prompt 移除指令段
 * @module tools/deactivate-skill
 * @depends core/tool-registry, skills/skill-registry, ports/llm, i18n
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { SkillRegistry } from '../skills/skill-registry';
import { tNow } from '../i18n';

/**
 * 构造 `deactivate_skill` 工具实例。
 *
 * 设计要点:
 * - 只读工具(`readOnly: true`),不触发写钩子。
 * - 内部调用 `registry.deactivate(name)`,未激活时抛 notActive。
 * - 返回简短确认文本。
 *
 * @param registry - SkillRegistry 实例
 * @param definition - LLM 侧 schema
 * @returns 符合 Tool 接口的工具定义
 */
export function createDeactivateSkillTool(
	registry: SkillRegistry,
	definition: ToolDefinition,
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			if (typeof args.name !== 'string' || args.name.length === 0) {
				throw new Error(tNow('error.tool.invalidArg', { label: 'name', type: typeof args.name }));
			}
			const name = args.name;
			registry.deactivate(name);
			return tNow('skill.notice.deactivated', { name });
		},
	};
}
```

- [ ] **Step 4: 修改 `src/core/agent-loop.ts` 在 activate/deactivate 工具执行后触发 ctx skills 段重组**

在 `agentLoop` 函数签名加 `skillActivator` 与 `skillRegistry` 可选参数(参考现有 `intentClassifier` 注入模式):

```typescript
import type { SkillActivator } from '../skills/skill-activator';
import type { SkillRegistry } from '../skills/skill-registry';

export async function* agentLoop(
	req: UserChatRequest,
	ctx: ContextManager,
	llm: LLMClient,
	tools: ToolRegistry,
	hooks: HookRegistry,
	signal?: AbortSignal,
	intentClassifier?: (message: string) => Promise<Intent>,
	toolPermissionCheck?: (toolCall: ToolCall) => Promise<void>,
	maxSteps?: number,
	// 关键路径:Skill 激活/反激活后需重组 system prompt — 注入 Activator + Registry。
	skillActivator?: SkillActivator,
	skillRegistry?: SkillRegistry,
): AsyncIterable<AgentEvent> {
```

在工具执行循环内(现有 `yield { type: 'tool.result', payload: { name: tc.name, result } };` 之后,`if (tc.name === 'search_vault')` 之前)加 activate/deactivate 后重组逻辑:

```typescript
				// 关键路径:activate_skill / deactivate_skill 执行后,重组 system prompt 的 skills 段。
				// 不重组则 LLM 下一轮看到的 system prompt 仍是旧的(不含新激活的 instructions)。
				if (
					skillActivator &&
					skillRegistry &&
					(tc.name === 'activate_skill' || tc.name === 'deactivate_skill') &&
					!toolFailed
				) {
					// 关键路径:用当前 settings.promptOverrides 重新产出 Discovery + Active 段。
					// overrides 通过 ctx.deps.getOverrides() 拿(与 toMessages 同源)。
					const overrides = (ctx as unknown as { deps: { getOverrides: () => OverrideMap } }).deps.getOverrides();
					const discovery = skillActivator.composeDiscovery(overrides);
					const active = skillActivator.composeActive();
					ctx.setSkillsContext(discovery, active);
				}
```

> 注:`ctx.deps` 是 private,这里用类型断言访问。更干净的做法是在 ContextManager 加 `getOverrides()` public 方法。执行者可选择给 ContextManager 加 public `getOverrides()` 方法替代断言,更优雅。建议执行者用 public 方法。

在 `agent-loop.ts` 顶部 import 加:

```typescript
import type { OverrideMap } from '../prompts/types';
```

- [ ] **Step 5: 验证编译通过**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: 编译通过。

- [ ] **Step 6: Commit**

```bash
git add src/tools/activate-skill.ts src/tools/deactivate-skill.ts src/prompts/tool-schemas.ts src/core/agent-loop.ts
git commit -m "feat(skill): activate_skill/deactivate_skill 工具 + agent-loop skills 段重组

- src/tools/activate-skill.ts: createActivateSkillTool 工厂(readOnly)
- src/tools/deactivate-skill.ts: createDeactivateSkillTool 工厂(readOnly)
- src/prompts/tool-schemas.ts: 加 2 个 schema + ALL_TOOL_NAMES
- src/core/agent-loop.ts: activate/deactivate 执行后 ctx.setSkillsContext 重组

P-SKILL-1-CORE Task 5"
```

---

### Task 6: main.ts 装配 + settings + slash-commands

**Files:**
- Modify: `src/main.ts`(onload 初始化 + 注册工具 + Reload 命令 + 文件监听)
- Modify: `src/settings.ts`(加 `enableSkills` 字段 + Settings group)
- Modify: `src/ui/chat/input/slash-commands.ts`(加 `/skill` / `/skills` / `/skill off`)

- [ ] **Step 1: 在 `src/settings.ts` 加 `enableSkills` 字段**

在 `RatelVaultSettings` interface 的 `memoryContextTotalLimitKB` 之后加:

```typescript
	// 关键路径(P-SKILL-1-CORE):Skill 机制总开关,false 时 Agent 不加载 skill。
	enableSkills: boolean;
```

在 `DEFAULT_SETTINGS` 的 `memoryContextTotalLimitKB: 50,` 之后加:

```typescript
	// 关键路径:默认启用 skill 机制,让用户零感知 Discovery 注入。
	enableSkills: true,
```

在 `RatelVaultSettingTab.getSettingDefinitions()` 的 Memory group 之后插入 Skills group:

```typescript
		// ==================== Skills(P-SKILL-1-CORE) ====================
		// 关键路径:声明式 toggle,saveSettings 后 main.ts 监听 enableSkills 变化触发 reload。
		{
			type: 'group',
			heading: tNow('skill.settings.heading'),
			items: [
				{
					name: tNow('skill.settings.enableSkills.name'),
					desc: tNow('skill.settings.enableSkills.desc'),
					control: { type: 'toggle', key: 'enableSkills' },
				},
			],
		},
```

在 `toolPermissions` 权限 map(`settings.ts` DEFAULT_SETTINGS.toolPermissions)末尾加 2 个 skill 工具默认权限(只读放行):

```typescript
		// 关键路径:2 个 skill 工具只读放行(不写文件,只改 system prompt)。
		activate_skill: 'allow',
		deactivate_skill: 'allow',
```

在 `buildToolPermissionItems` 的 `labelByKey` map 加:

```typescript
			activate_skill: 'settings.toolPermissions.activate_skill',
			deactivate_skill: 'settings.toolPermissions.deactivate_skill',
```

在 `allTools` 数组加 `'activate_skill', 'deactivate_skill'`。

在 `SettingsStrings` interface(`src/i18n/types.ts`)加 2 个权限标签 key:

```typescript
  'settings.toolPermissions.activate_skill': string;
  'settings.toolPermissions.deactivate_skill': string;
```

在 `zh.ts` 的 `settingsZh` 加:

```typescript
  'settings.toolPermissions.activate_skill': '激活 Skill',
  'settings.toolPermissions.deactivate_skill': '关闭 Skill',
```

在 `en.ts` 加对应英文:

```typescript
  'settings.toolPermissions.activate_skill': 'Activate skill',
  'settings.toolPermissions.deactivate_skill': 'Deactivate skill',
```

- [ ] **Step 2: 在 `src/ui/chat/input/slash-commands.ts` 加 `/skill` / `/skills` / `/skill off`**

修改 `getSlashCommands` 返回数组,在 `/reindex` 之后追加:

```typescript
		{
			name: '/skill',
			description: tNow('skill.cmd.skill'),
			icon: '🦡',
		},
		{
			name: '/skills',
			description: tNow('skill.cmd.skills'),
			icon: '📋',
		},
		{
			name: '/skill off',
			description: tNow('skill.cmd.skill'),
			icon: '🦡',
		},
```

> 注:`/skill off` 是 `/skill` 的子命令,filterCommands 当前实现遇空格返回空数组(已脱离命令模式)。执行者需确认 `/skill off` 的菜单触发逻辑 — 当前 filterCommands 会在输入 `/skill off` 时返回空(含空格)。这是预期行为:`/skill off` 不走菜单,而是 ChatView 在发送时拦截解析。执行者需在 ChatView 发送逻辑加 `/skill <name>` / `/skill off <name>` / `/skills` 解析。若 ChatView 改动超本 plan 范围,可只注册 `/skill` 与 `/skills` 菜单项,`/skill off` 在 ChatView 用 if 分支处理(不发 LLM)。

- [ ] **Step 3: 在 `src/main.ts` onload 初始化 SkillLoader/Registry/Activator + 注册工具 + Reload 命令**

在 main.ts 顶部 import 区加:

```typescript
// 关键路径:P-SKILL-1-CORE — Skill 机制(三源加载 + 注册表 + 激活器 + 2 工具)。
import { SkillLoader } from './skills/skill-loader';
import { SkillRegistry } from './skills/skill-registry';
import { SkillActivator } from './skills/skill-activator';
import { SkillFsAdapter } from './adapters/skill-fs';
import { SkillVaultAdapter } from './adapters/skill-vault';
import { createActivateSkillTool } from './tools/activate-skill';
import { createDeactivateSkillTool } from './tools/deactivate-skill';
import os from 'os';
```

在 `RatelVaultPlugin` 类的字段区(memoryStore 之后)加:

```typescript
	// 关键路径:P-SKILL-1-CORE — Skill 三源加载器、注册表、激活器。
	private skillLoader!: SkillLoader;
	private skillRegistry!: SkillRegistry;
	private skillActivator!: SkillActivator;
```

在 `onload` 方法中,Memory 系统装配之后、Worker 装配之前,加 Skill 装配:

```typescript
		// ==================== Skills(P-SKILL-1-CORE) ====================
		// 关键路径:三源路径 — builtin(pluginDir/skills 只读)/ global(~/.ratel/skills)/ vault(vaultBase/.ratel/skills)。
		// 加载顺序 builtin → global → vault,后者覆盖前者同名(spec §4.3)。
		const builtinSkillsDir = path.join(pluginDir, 'skills');
		const globalSkillsDir = path.join(os.homedir(), '.ratel', 'skills');
		const vaultSkillsDir = path.join(vaultBase, '.ratel', 'skills');
		const builtinPort = new SkillFsAdapter('builtin', builtinSkillsDir);
		const globalPort = new SkillFsAdapter('global', globalSkillsDir);
		const vaultPort = new SkillVaultAdapter(this.vault, vaultSkillsDir);
		this.skillLoader = new SkillLoader([builtinPort, globalPort, vaultPort]);
		this.skillRegistry = new SkillRegistry();
		this.skillActivator = new SkillActivator(this.skillRegistry);
		// 关键路径:onload 异步加载 skills,不阻塞 Obsidian 启动(spec §6.6)。
		// enableSkills=false 时跳过加载(空 registry,Discovery/Active 段都不注入)。
		if (this.settings.enableSkills) {
			void this.reloadSkills();
		}
```

在 工具注册区(forget_memory 之后)加 2 工具注册:

```typescript
		// 关键路径:P-SKILL-1-CORE — 2 个 skill 工具,复用 skillRegistry。
		// definition 由 composeToolDefinitions 生成(ALL_TOOL_NAMES 已含 activate_skill/deactivate_skill)。
		this.tools.register(createActivateSkillTool(this.skillRegistry, toolDefMap.get('activate_skill')!));
		this.tools.register(createDeactivateSkillTool(this.skillRegistry, toolDefMap.get('deactivate_skill')!));
```

在命令注册区(drop-index 之后)加 Reload skills 命令:

```typescript
	// 命令:重新加载 Skills(手动刷新三源)
	this.addCommand({
		id: 'reload-skills',
		name: tNow('cmd.reloadSkills'),
		callback: async () => {
			try {
				const count = await this.reloadSkills();
				this.userNotice.toast(tNow('skill.notice.reloadDone', { count }));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.userNotice.toastError(tNow('skill.notice.reloadFailed', { message }));
			}
		},
	});
```

在 `ask` 方法中,构造 ContextManager 时注入 skills getter(在 `getTools` 之后):

```typescript
		const ctx = new ContextManager(this.persistence, {
			getOverrides: () => this.settings.promptOverrides,
			getTools: () => this.tools.definitions(),
			// 关键路径:注入 skills 段 getter,让 toMessages 时能拿到 Discovery + Active 文本。
			// enableSkills=false 或无 skill 时返回空串(不注入)。
			getSkillsDiscovery: () =>
				this.settings.enableSkills
					? this.skillActivator.composeDiscovery(this.settings.promptOverrides)
					: '',
			getSkillsActive: () =>
				this.settings.enableSkills ? this.skillActivator.composeActive() : '',
		});

		// 关键路径:会话启动时设置初始 skills 段(Discovery + Active,后者含 always 激活的 skill)。
		if (this.settings.enableSkills) {
			ctx.setSkillsContext(
				this.skillActivator.composeDiscovery(this.settings.promptOverrides),
				this.skillActivator.composeActive(),
			);
		}
```

在 `agentLoop` 调用处(`yield* agentLoop(...)`)加 skillActivator / skillRegistry 参数:

```typescript
		yield* agentLoop(
			{ sessionId, message },
			ctx,
			this.llm,
			this.tools,
			this.hooks,
			signal,
			intentClassifier,
			toolPermissionCheck,
			this.settings.agentMaxSteps,
			// 关键路径:注入 skillActivator + skillRegistry,让 activate/deactivate 工具执行后能重组 skills 段。
			this.skillActivator,
			this.skillRegistry,
		);
```

在类底部加 `reloadSkills` 方法:

```typescript
	/**
	 * 重新加载 skills — 扫描三源 + 解析 frontmatter + 合并 + 写入 registry。
	 *
	 * 关键路径:
	 * - enableSkills=false 时直接返回 0(不加载)
	 * - 加载 warnings 通过 devLogger 输出(非阻塞)
	 * - 加载完成后 registry 状态全量替换
	 *
	 * @returns 加载到的 skill 数量
	 */
	async reloadSkills(): Promise<number> {
		if (!this.settings.enableSkills) return 0;
		const { skills, warnings } = await this.skillLoader.loadAll();
		this.skillRegistry.reload(skills, warnings);
		if (warnings.length > 0) {
			for (const w of warnings) {
				devLogger.warn('skill', `${w.path}: ${w.message}`);
			}
		}
		devLogger.info('skill', `已加载 ${skills.length} 个 skill`);
		return skills.length;
	}
```

- [ ] **Step 4: 验证编译通过**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: 编译通过。

- [ ] **Step 5: 运行现有测试确保无回归**

Run: `npm test`
Expected: 全部测试通过(现有 memory / tool 等测试不受影响)。

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/settings.ts src/ui/chat/input/slash-commands.ts src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat(skill): main.ts 装配 + settings enableSkills + slash 命令

- src/main.ts: onload 初始化 SkillLoader/Registry/Activator + 注册 2 工具 + Reload skills 命令 + ask 注入 skills getter
- src/settings.ts: 加 enableSkills 字段 + Skills group + 2 工具权限
- src/ui/chat/input/slash-commands.ts: 加 /skill /skills /skill off
- src/i18n: 加 2 工具权限标签翻译

P-SKILL-1-CORE Task 6"
```

---

### Task 7: 单元测试(loader / registry / activator / 工具)

**Files:**
- Create: `src/skills/skill-loader.test.ts`
- Create: `src/skills/skill-registry.test.ts`
- Create: `src/skills/skill-activator.test.ts`
- Create: `src/tools/activate-skill.test.ts`
- Create: `src/tools/deactivate-skill.test.ts`

- [ ] **Step 1: 创建 `src/skills/skill-loader.test.ts`**

```typescript
/**
 * @file src/skills/skill-loader.test.ts
 * @description SkillLoader 单元测试 — 三源扫描 + frontmatter 解析 + 同名合并
 * @module skills/skill-loader.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SkillLoader } from './skill-loader';
import type { SkillPort } from '../ports/skill-port';
import type { SkillSource } from './types';

// 关键路径:用内存 mock SkillPort,避免触碰真实 fs。
class MockSkillPort implements SkillPort {
	constructor(
		readonly source: SkillSource,
		readonly rootDir: string,
		private skills: Record<string, string>, // name → SKILL.md 全文
	) {}
	async listSkillFolders(): Promise<string[]> {
		return Object.keys(this.skills);
	}
	async readSkillManifest(skillName: string): Promise<string> {
		const content = this.skills[skillName];
		if (!content) throw new Error(`not found: ${skillName}`);
		return content;
	}
}

describe('SkillLoader', () => {
	it('loadAll - 三源合并 - vault 覆盖 global 与 builtin 同名', async () => {
		const builtin = new MockSkillPort('builtin', '/builtin', {
			'reviewer': `---
name: reviewer
description: builtin reviewer
---
builtin instructions`,
		});
		const global = new MockSkillPort('global', '/global', {
			'reviewer': `---
name: reviewer
description: global reviewer
---
global instructions`,
		});
		const vault = new MockSkillPort('vault', '/vault', {
			'reviewer': `---
name: reviewer
description: vault reviewer
---
vault instructions`,
		});
		const loader = new SkillLoader([builtin, global, vault]);
		const { skills, warnings } = await loader.loadAll();
		expect(warnings).toHaveLength(0);
		expect(skills).toHaveLength(1);
		expect(skills[0]!.manifest.description).toBe('vault reviewer');
		expect(skills[0]!.instructions).toBe('vault instructions');
		expect(skills[0]!.source).toBe('vault');
	});

	it('loadAll - name 非法 - 跳过并记 warning', async () => {
		const port = new MockSkillPort('vault', '/vault', {
			'BadName': `---
name: BadName
description: 非法大写
---
x`,
		});
		const loader = new SkillLoader([port]);
		const { skills, warnings } = await loader.loadAll();
		expect(skills).toHaveLength(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]!.message).toContain('name 非法');
	});

	it('loadAll - description 为空 - 跳过', async () => {
		const port = new MockSkillPort('vault', '/vault', {
			'empty-desc': `---
name: empty-desc
description: ""
---
x`,
		});
		const loader = new SkillLoader([port]);
		const { skills, warnings } = await loader.loadAll();
		expect(skills).toHaveLength(0);
		expect(warnings[0]!.message).toContain('description 为空');
	});

	it('loadAll - activation 非法值 - 降级 auto', async () => {
		const port = new MockSkillPort('vault', '/vault', {
			'my-skill': `---
name: my-skill
description: test
activation: invalid
---
x`,
		});
		const loader = new SkillLoader([port]);
		const { skills, warnings } = await loader.loadAll();
		expect(skills).toHaveLength(1);
		expect(skills[0]!.manifest.activation).toBe('auto');
		expect(warnings[0]!.message).toContain('activation 非法值');
	});

	it('loadAll - enabled 缺省 - 默认 true', async () => {
		const port = new MockSkillPort('vault', '/vault', {
			'my-skill': `---
name: my-skill
description: test
---
x`,
		});
		const loader = new SkillLoader([port]);
		const { skills } = await loader.loadAll();
		expect(skills[0]!.manifest.enabled).toBe(true);
	});

	it('loadAll - i18n.description 嵌套对象 - 解析成功', async () => {
		const port = new MockSkillPort('vault', '/vault', {
			'my-skill': `---
name: my-skill
description: default desc
i18n:
  description:
    zh: 中文描述
    en: English desc
---
x`,
		});
		const loader = new SkillLoader([port]);
		const { skills } = await loader.loadAll();
		expect(skills[0]!.manifest.i18nDescription).toEqual({
			zh: '中文描述',
			en: 'English desc',
		});
	});

	it('loadAll - 文件读取失败 - 记 warning 不阻塞其他', async () => {
		const port = new MockSkillPort('vault', '/vault', {
			'good': `---
name: good
description: ok
---
x`,
			'bad': 'corrupted content without frontmatter',
		});
		// 关键路径:gray-matter 对无 frontmatter 的文件解析为空 data + content=原文,不会抛错。
		// 这里改 mock 让 readSkillManifest 抛错模拟 fs 失败。
		const failingPort: SkillPort = {
			source: 'vault',
			rootDir: '/vault',
			listSkillFolders: async () => ['bad', 'good'],
			readSkillManifest: async (name: string) => {
				if (name === 'bad') throw new Error('fs error');
				return port.readSkillManifest(name);
			},
		};
		const loader = new SkillLoader([failingPort]);
		const { skills, warnings } = await loader.loadAll();
		expect(skills).toHaveLength(1);
		expect(skills[0]!.manifest.name).toBe('good');
		expect(warnings.some((w) => w.message.includes('fs error'))).toBe(true);
	});
});
```

- [ ] **Step 2: 创建 `src/skills/skill-registry.test.ts`**

```typescript
/**
 * @file src/skills/skill-registry.test.ts
 * @description SkillRegistry 单元测试 — enabled/active 三态 + reload + activate/deactivate
 * @module skills/skill-registry.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SkillRegistry } from './skill-registry';
import type { Skill } from './types';

function makeSkill(name: string, opts: Partial<Skill['manifest']> = {}): Skill {
	return {
		manifest: {
			name,
			description: opts.description ?? `desc-${name}`,
			enabled: opts.enabled ?? true,
			activation: opts.activation ?? 'auto',
			tags: opts.tags ?? [],
		},
		instructions: `instructions-${name}`,
		source: 'vault',
		dir: `/vault/${name}`,
	};
}

describe('SkillRegistry', () => {
	let registry: SkillRegistry;
	beforeEach(() => {
		registry = new SkillRegistry();
	});

	it('reload - always 类型自动激活', () => {
		const skills = [
			makeSkill('auto-skill', { activation: 'auto' }),
			makeSkill('always-skill', { activation: 'always' }),
			makeSkill('manual-skill', { activation: 'manual' }),
		];
		registry.reload(skills, []);
		expect(registry.getActive().map((s) => s.manifest.name)).toEqual(['always-skill']);
	});

	it('getDiscovered - 排除 manual 与 disabled', () => {
		const skills = [
			makeSkill('auto-skill'),
			makeSkill('manual-skill', { activation: 'manual' }),
			makeSkill('disabled-skill', { enabled: false }),
		];
		registry.reload(skills, []);
		const discovered = registry.getDiscovered().map((s) => s.manifest.name);
		expect(discovered).toEqual(['auto-skill']);
	});

	it('activate - 不存在 - 抛 notFound', () => {
		expect(() => registry.activate('nope')).toThrow(/未找到/);
	});

	it('activate - 已禁用 - 抛 notEnabled', () => {
		registry.reload([makeSkill('x', { enabled: false })], []);
		expect(() => registry.activate('x')).toThrow(/未启用/);
	});

	it('activate - 成功后出现在 getActive', () => {
		registry.reload([makeSkill('x')], []);
		registry.activate('x');
		expect(registry.getActive().map((s) => s.manifest.name)).toContain('x');
	});

	it('deactivate - 未激活 - 抛 notActive', () => {
		registry.reload([makeSkill('x')], []);
		expect(() => registry.deactivate('x')).toThrow(/未激活/);
	});

	it('setEnabled - false 时清掉 active', () => {
		registry.reload([makeSkill('x')], []);
		registry.activate('x');
		registry.setEnabled('x', false);
		expect(registry.getActive()).toHaveLength(0);
		expect(registry.isEnabled('x')).toBe(false);
	});

	it('reload - 保留 enabledOverrides 与清理已不存在的 active', () => {
		registry.reload([makeSkill('x')], []);
		registry.activate('x');
		registry.setEnabled('x', false);
		// reload 后 x 不存在了
		registry.reload([makeSkill('y')], []);
		expect(registry.getActive()).toHaveLength(0);
	});

	it('clearActive - 清空全部激活态', () => {
		registry.reload([makeSkill('x'), makeSkill('y')], []);
		registry.activate('x');
		registry.activate('y');
		registry.clearActive();
		expect(registry.getActive()).toHaveLength(0);
	});
});
```

- [ ] **Step 3: 创建 `src/skills/skill-activator.test.ts`**

```typescript
/**
 * @file src/skills/skill-activator.test.ts
 * @description SkillActivator 单元测试 — composeDiscovery / composeActive
 * @module skills/skill-activator.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SkillActivator } from './skill-activator';
import { SkillRegistry } from './skill-registry';
import type { Skill } from './types';

function makeSkill(name: string, instructions: string, opts: Partial<Skill['manifest']> = {}): Skill {
	return {
		manifest: {
			name,
			description: opts.description ?? `desc-${name}`,
			enabled: opts.enabled ?? true,
			activation: opts.activation ?? 'auto',
			tags: opts.tags ?? [],
		},
		instructions,
		source: 'vault',
		dir: `/vault/${name}`,
	};
}

describe('SkillActivator', () => {
	let registry: SkillRegistry;
	let activator: SkillActivator;
	beforeEach(() => {
		registry = new SkillRegistry();
		activator = new SkillActivator(registry);
	});

	it('composeDiscovery - 无 skill - 返回空串', () => {
		registry.reload([], []);
		expect(activator.composeDiscovery({})).toBe('');
	});

	it('composeDiscovery - 含 name 与 description', () => {
		registry.reload([makeSkill('reviewer', '', { description: '审查代码' })], []);
		const text = activator.composeDiscovery({});
		expect(text).toContain('reviewer');
		expect(text).toContain('审查代码');
	});

	it('composeDiscovery - 排除 manual skill', () => {
		registry.reload([
			makeSkill('auto', '', { activation: 'auto' }),
			makeSkill('manual', '', { activation: 'manual' }),
		], []);
		const text = activator.composeDiscovery({});
		expect(text).toContain('auto');
		expect(text).not.toContain('manual');
	});

	it('composeActive - 无激活 - 返回空串', () => {
		registry.reload([makeSkill('x', 'instr')], []);
		expect(activator.composeActive()).toBe('');
	});

	it('composeActive - 含激活的 instructions', () => {
		registry.reload([makeSkill('reviewer', '你是代码审查者')], []);
		registry.activate('reviewer');
		const text = activator.composeActive();
		expect(text).toContain('reviewer');
		expect(text).toContain('你是代码审查者');
	});

	it('composeActive - 多 skill 累加', () => {
		registry.reload([
			makeSkill('a', 'instr-a'),
			makeSkill('b', 'instr-b'),
		], []);
		registry.activate('a');
		registry.activate('b');
		const text = activator.composeActive();
		expect(text).toContain('instr-a');
		expect(text).toContain('instr-b');
	});
});
```

- [ ] **Step 4: 创建 `src/tools/activate-skill.test.ts`**

```typescript
/**
 * @file src/tools/activate-skill.test.ts
 * @description activate_skill 工具单元测试
 * @module tools/activate-skill.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createActivateSkillTool } from './activate-skill';
import { SkillRegistry } from '../skills/skill-registry';
import type { ToolDefinition } from '../ports/llm';
import type { Skill } from '../skills/types';

const fakeDef: ToolDefinition = {
	name: 'activate_skill',
	description: 'test',
	parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
};

function makeSkill(name: string): Skill {
	return {
		manifest: { name, description: `desc-${name}`, enabled: true, activation: 'auto' as const, tags: [] },
		instructions: `instr-${name}`,
		source: 'vault',
		dir: `/vault/${name}`,
	};
}

describe('activate_skill 工具', () => {
	let registry: SkillRegistry;
	beforeEach(() => {
		registry = new SkillRegistry();
		registry.reload([makeSkill('reviewer')], []);
	});

	it('激活成功 - 返回 activated 消息', async () => {
		const tool = createActivateSkillTool(registry, fakeDef);
		const result = await tool.execute({ name: 'reviewer' });
		expect(result).toContain('已激活');
		expect(registry.getActive().map((s) => s.manifest.name)).toContain('reviewer');
	});

	it('已激活 - 返回 alreadyActive', async () => {
		registry.activate('reviewer');
		const tool = createActivateSkillTool(registry, fakeDef);
		const result = await tool.execute({ name: 'reviewer' });
		expect(result).toContain('已激活');
	});

	it('不存在 - 抛 notFound', async () => {
		const tool = createActivateSkillTool(registry, fakeDef);
		await expect(tool.execute({ name: 'nope' })).rejects.toThrow(/未找到/);
	});

	it('name 缺失 - 抛 invalidArg', async () => {
		const tool = createActivateSkillTool(registry, fakeDef);
		await expect(tool.execute({})).rejects.toThrow(/name/);
	});

	it('readOnly 标记为 true', () => {
		const tool = createActivateSkillTool(registry, fakeDef);
		expect(tool.readOnly).toBe(true);
	});
});
```

- [ ] **Step 5: 创建 `src/tools/deactivate-skill.test.ts`**

```typescript
/**
 * @file src/tools/deactivate-skill.test.ts
 * @description deactivate_skill 工具单元测试
 * @module tools/deactivate-skill.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDeactivateSkillTool } from './deactivate-skill';
import { SkillRegistry } from '../skills/skill-registry';
import type { ToolDefinition } from '../ports/llm';
import type { Skill } from '../skills/types';

const fakeDef: ToolDefinition = {
	name: 'deactivate_skill',
	description: 'test',
	parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
};

function makeSkill(name: string): Skill {
	return {
		manifest: { name, description: `desc-${name}`, enabled: true, activation: 'auto' as const, tags: [] },
		instructions: `instr-${name}`,
		source: 'vault',
		dir: `/vault/${name}`,
	};
}

describe('deactivate_skill 工具', () => {
	let registry: SkillRegistry;
	beforeEach(() => {
		registry = new SkillRegistry();
		registry.reload([makeSkill('reviewer')], []);
	});

	it('反激活成功 - 返回 deactivated 消息', async () => {
		registry.activate('reviewer');
		const tool = createDeactivateSkillTool(registry, fakeDef);
		const result = await tool.execute({ name: 'reviewer' });
		expect(result).toContain('已关闭');
		expect(registry.getActive()).toHaveLength(0);
	});

	it('未激活 - 抛 notActive', async () => {
		const tool = createDeactivateSkillTool(registry, fakeDef);
		await expect(tool.execute({ name: 'reviewer' })).rejects.toThrow(/未激活/);
	});

	it('name 缺失 - 抛 invalidArg', async () => {
		const tool = createDeactivateSkillTool(registry, fakeDef);
		await expect(tool.execute({})).rejects.toThrow(/name/);
	});

	it('readOnly 标记为 true', () => {
		const tool = createDeactivateSkillTool(registry, fakeDef);
		expect(tool.readOnly).toBe(true);
	});
});
```

- [ ] **Step 6: 运行全部新测试**

Run: `npx vitest run src/skills src/tools/activate-skill.test.ts src/tools/deactivate-skill.test.ts`
Expected: 全部测试通过。

- [ ] **Step 7: 运行全量测试确保无回归**

Run: `npm test`
Expected: 全部测试通过(含现有 memory / tool / i18n 测试)。

- [ ] **Step 8: Commit**

```bash
git add src/skills/skill-loader.test.ts src/skills/skill-registry.test.ts src/skills/skill-activator.test.ts src/tools/activate-skill.test.ts src/tools/deactivate-skill.test.ts
git commit -m "test(skill): loader/registry/activator/工具 单元测试

- skill-loader.test: 三源合并 + name 校验 + activation 降级 + i18n 嵌套 + fs 失败
- skill-registry.test: reload/activate/deactivate/setEnabled/clearActive
- skill-activator.test: composeDiscovery/composeActive
- activate-skill.test / deactivate-skill.test: 工具 happy path + 错误路径

P-SKILL-1-CORE Task 7"
```

---

## Self-Review

### 1. Spec coverage(spec §5.1 P-SKILL-1-CORE 范围)

| spec §5.1 文件 | 对应 Task | 状态 |
|----------------|-----------|------|
| `src/skills/types.ts` | Task 1 | ✅ |
| `src/skills/skill-loader.ts` | Task 2 | ✅ |
| `src/skills/skill-registry.ts` | Task 3 | ✅ |
| `src/skills/skill-activator.ts` | Task 4 | ✅ |
| `src/ports/skill-port.ts` | Task 2 | ✅ |
| `src/adapters/skill-vault.ts` | Task 2 | ✅ |
| `src/adapters/skill-fs.ts` | Task 2 | ✅ |
| `src/tools/activate-skill.ts` | Task 5 | ✅ |
| `src/tools/deactivate-skill.ts` | Task 5 | ✅ |
| `src/prompts/sections.ts`(agent.skills + 2 工具 section) | Task 4 | ✅ |
| `src/prompts/composer.ts`(discovery + active 注入) | Task 4 | ✅ |
| `src/core/agent-loop.ts`(activate/deactivate tool call) | Task 5 | ✅ |
| `src/main.ts`(onload 初始化) | Task 6 | ✅ |
| `src/settings.ts`(enableSkills 字段) | Task 6 | ✅ |
| `src/ui/chat/slash-commands.ts`(/skill /skills /skill off) | Task 6 | ✅ |
| `src/i18n/types.ts + zh.ts + en.ts`(SkillStrings 基础 key) | Task 1+4+6 | ✅ |
| 单元测试(loader / registry / activator / 工具) | Task 7 | ✅ |

### 2. Placeholder scan

- 无 "TBD" / "TODO" / "implement later"
- 无 "Add appropriate error handling"(错误处理已完整给出)
- 无 "Similar to Task N"(每个 Task 代码独立)
- 无 "fill in details"
- 每个 Step 都有完整代码或确切命令

### 3. Type consistency

- `Skill` / `SkillManifest` / `SkillSource` / `SkillActivation` / `SkillLoadWarning`:Task 1 定义,Task 2/3/4/5/7 一致使用
- `SkillPort` 接口:`listSkillFolders() / readSkillManifest(name)`:Task 2 定义,Task 2 的两个适配器与 Task 7 的 Mock 一致实现
- `SkillRegistry`:`reload / getAll / getWarnings / get / isEnabled / setEnabled / getDiscovered / getActive / activate / deactivate / clearActive`:Task 3 定义,Task 4(Activator 调 getDiscovered/getActive)/ Task 5(工具调 activate/deactivate)/ Task 7(测试)一致使用
- `SkillActivator`:`composeDiscovery(overrides) / composeActive()`:Task 4 定义,Task 5(agent-loop 调用)/ Task 6(main.ts 注入 getter)/ Task 7(测试)一致使用
- `createActivateSkillTool(registry, definition) / createDeactivateSkillTool(registry, definition)`:Task 5 定义,Task 6(main.ts 注册)/ Task 7(测试)一致使用
- `PromptSectionId` 加 `'agent.skills'`:Task 1 定义,Task 4(sections.ts 注册 + defaults/zh.ts 默认文案)一致使用
- `SkillStrings` namespace:Task 1 定义,Task 4(zh.ts skillZh + en.ts)/ Task 6(2 工具权限标签)一致补充翻译
- `ContextManager.setSkillsContext(discovery, active)` + `getSkillsDiscovery/getSkillsActive` deps:Task 4 定义,Task 6(main.ts ask 注入)一致使用
- `agentLoop` 签名扩展 `skillActivator?` + `skillRegistry?`:Task 5 定义,Task 6(main.ts 调用)一致传参

### 4. 对 spec 的偏差与建议

1. **`/skill off <name>` 菜单触发**:spec §4.5b 列出 `/skill off <name>` 命令,但现有 `filterCommands` 在输入含空格时返回空数组。plan Task 6 Step 2 已注明此约束 — 执行者需在 ChatView 发送逻辑加 `/skill off <name>` 解析(不发 LLM,直接调 registry.deactivate)。若 ChatView 改动超 P-SKILL-1-CORE 范围,可只实现 `/skill <name>` 与 `/skills` 菜单项,`/skill off` 留 P-SKILL-3-UI 完善。**建议**:Task 6 实现时先做 `/skill <name>` 与 `/skills`,ChatView 发送拦截在 P-SKILL-3-UI 完善。

2. **`composeSkillsDiscovery` / `composeActiveSkills` 包装函数**:Task 4 Step 7 的两个包装函数当前是恒等函数(原样返回)。保留是为了与 `composeMemorySystemPrompt` 对称,未来加 wrapper/截断有挂载点。执行者若认为冗余,可直接在 ContextManager 内联 Activator 调用,但建议保留对称性。

3. **`agent-loop.ts` 访问 `ctx.deps` private 字段**:Task 5 Step 4 用类型断言访问 private `deps`。**建议**:执行者给 `ContextManager` 加 public `getOverrides()` 方法,替代断言,更优雅。plan 已注明此建议。

4. **50 个 skill 截断**:spec §4.4 提到超过 50 个时按 tags 粗筛。Task 4 的 Activator 实现简单 `slice(0, 50)` 截断,v2 优化为 tags + query 匹配。spec 已标注 v2,本 plan 符合范围。

5. **`.ratel/skills/` 文件监听**:spec §4.4 提到 vault 内文件变更去抖 500ms。本 plan Task 6 未实现文件监听(仅 onload 扫描 + Reload 命令)。**原因**:文件监听需复用现有 IndexController 的 watcher 模式,改动较大;且 Reload 命令已覆盖手动刷新场景。**建议**:文件监听留 P-SKILL-3-UI 或独立小 plan 完善,本 plan 验收(spec §5.1 验收)已满足"重启 Obsidian 或运行 Reload skills 命令后 Discovery 段出现"。

6. **gray-matter 新依赖**:spec §6.4 提到"如已在 dependencies 则复用,否则加"。package.json 当前无 gray-matter,Task 2 Step 1 明确 `npm install gray-matter @types/gray-matter`。

---

## 验收(spec §5.1)

执行完本 plan 后应满足:

- [ ] 用户在 `.ratel/skills/code-reviewer/SKILL.md` 创建 skill
- [ ] 重启 Obsidian 或运行 `Reload skills` 命令后,Discovery 段出现在 system prompt(可用 `/compact` 预览或 Diagnostics 验证)
- [ ] LLM 调用 `activate_skill('code-reviewer')`,SKILL.md 指令注入,Agent 行为按指令改变
- [ ] `/skill code-reviewer` 手动激活同样生效(注:ChatView 发送拦截,见偏差 1)
- [ ] `/skill off code-reviewer` 关闭(注:同上)
- [ ] `enableSkills` 设置关闭后,Discovery/Active 段不注入
