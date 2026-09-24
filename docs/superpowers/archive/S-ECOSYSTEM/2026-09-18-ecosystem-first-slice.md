# 支柱 C 第一刀 Implementation Plan

> **范围已变（2026-09-21）：** 需求源改为 [S-ECOSYSTEM](2026-08-20-ecosystem-management-design.md) + [S-PLUGIN-PROFILE](../S-PLUGIN-PROFILE/2026-09-10-plugin-profile-design.md)。CUT1 **Superseded**。本 plan 已落地部分（ADR-018 / denylist / search / install）仍是基线；**不要再按「冻结加功能」执行**，缺的卸/升/配/档案另写后续 plan。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 ADR-018、封死 Skill 脚本写 `configDir`、交出通道 B + 清单缓存 + `search_plugins`/`install_plugin` 最小骨架(R2 写盘尽力启用 / R3 开官方页)。

**Architecture:** 笔记工具继续走通道 A(`validateVaultPath`)。生态 IO 独立 adapter + `validateEcosystemPath`。清单缓存在 `pluginDir`,不进 `data.json`。安装默认 R2;设置 `ecosystemWriteEnabled=false` 走 R3。版本定位用仓库 `manifest.json`,禁止 `/releases/latest`。

**Tech Stack:** TypeScript / vitest / Obsidian `requestUrl` / Vault `DataAdapter` / 现有 i18n 与工具权限门。

## Global Constraints

- 基线 0.8.0;`id` 永为 `ratel-vault`;`isDesktopOnly: true`
- 中文文档与注释;用户可见字符串走 i18n
- 禁止声称官方授权、店外安装、管理自己、2MB 清单进 data.json
- 本刀不实现 `update_plugin` / `configure_plugin` / 卸载回滚全集
- TDD:先失败测试再实现

---

### Task 1: ADR-018 与隐私文案

**Files:** `docs/adr/2026-09-18-ecosystem-outbound.md`, README 中英, AGENTS.md, ADR-017 v1.2, architecture 索引, STATUS.md

已回答技术路线 §10 十五问(域名、触发、失败、与 014 并列、无 PAT、缓存、同 manifest 开关、热启用留盘、未文档 API 守卫、`obsidian://show-plugin`、下架仍可卸、Skill denylist 写入 018+017、半成品优先清理、配置后置)。

---

### Task 2: Skill configDir denylist

**Files:** `src/skills/script-vm.ts`, worker/sandbox 协议, `src/tools/run-skill-script.ts`, 对应测试

- `deniedDirs` 绝对路径;resolve 后命中则抛错(读/写)
- `run_skill_script` 注入 `path.join(vaultRoot, configDirName)`

---

### Task 3: 通道 B `validateEcosystemPath`

**Files:** `src/utils/path-safety.ts`, `tests/utils/path-safety.test.ts`

放行 `community-plugins.json` 与 `plugins/<校验过的 id>/**`;拒 `ratel-vault`、未知 id、其它配置文件。通道 A 回归仍拒整棵 configDir。

---

### Task 4: 清单缓存 + 搜索 + 安装骨架

**Files:** `src/adapters/ecosystem-registry.ts`, `ecosystem-vault.ts`, `ecosystem-runtime.ts`, `src/tools/search-plugins.ts`, `install-plugin.ts`, 接线 `main.ts` / schemas / i18n / settings.`ecosystemWriteEnabled`

- 缓存 TTL 7 天;过期可搜并标注
- 安装:清单内 id → raw manifest version → `releases/download/<version>/` 三件套 → 校验 id → 写盘 → 尽力 enable;关写盘则 R3

---

## 自审

- ADR-018 必答题均在 ADR 正文
- PP-08 物理 denylist 有单测
- 不跟 `/releases/latest`
- 不做 EC-03/05/09 与配置档案
