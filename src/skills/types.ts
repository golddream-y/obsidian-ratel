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
