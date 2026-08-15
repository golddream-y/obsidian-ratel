# 索引清单持久化修复 — 停止每次启动全量重建

> 日期: 2026-07-15  
> 状态: Active  
> Spec ID: **S-INDEX-MANIFEST-FIX**  
> 关联: ADR-007；用户确认日常主库关闭重开后索引全量重建；磁盘证据：有 `.index/`、无 `index-manifest.json`

---

## 1. 背景

设计上热启动应走 `smartReindex` → hash diff，未变更文件 `skipped`。日常主库实测：

- `.index/index.json` 存在（数百 chunk）
- 插件根目录 **没有** `index-manifest.json`
- 库内启用 Remotely Save；`.gitignore` 只忽略 `.index/`，不忽略根目录清单

`doSmartReindex` 在 `load() === null` 时走 **全量 embed**，因此每次启动体感「又从头建」。

另有代码缺陷：`shouldFullRebuild` 分支在全量后 `save` **空 entries**，会制造下一轮全库 `toAdd`。

---

## 2. 目标

1. 索引存在但清单缺失时：**只重建清单（hash）**，禁止全量 re-embed  
2. 清单文件迁入 **`.index/ratel-manifest.json`**，与向量同生命周期（同步工具通常整目录忽略 `.index/`）  
3. 兼容旧路径 `pluginDir/index-manifest.json`（启动迁移）  
4. 参数变更全量后必须写完整清单，禁止空 entries  
5. 清单 mtime 使用文件真实 `stat.mtime`

## 3. 非目标

- 不改 vectra 内部格式  
- 不强制用户清理现有 `.index/`  
- 本轮不解决 Remotely Save 配置 UI（只靠路径落点）

---

## 4. 详细设计

### 4.1 路径

| 项 | 值 |
|---|---|
| 新路径 | `<pluginDir>/.index/ratel-manifest.json` |
| 旧路径 | `<pluginDir>/index-manifest.json` |
| 迁移 | 新路径不存在且旧路径存在 → `rename`；两者都在 → 删旧 |

ADR-007 曾否决「塞进 `.index/`」以免污染 vectra；本轮以 **实测同步删除** 推翻该否决的路径结论：使用 **Ratel 自有文件名** `ratel-manifest.json`，不依赖 vectra 私有结构。`dropIndex` 删整目录时清单一并清除，生命周期仍配对。

### 4.2 启动决策（替换原分支 2）

```
index 不存在 → fullReindex + writeManifest
index 在 && manifest 无 → writeManifest（仅 hash）→ 若仍失败才 fullReindex
index 在 && shouldFullRebuild → dropIndex + fullReindex + writeManifest（完整）
否则 → hash diff
```

### 4.3 writeManifest

- 逐文件 try/catch，单文件失败跳过  
- `mtime = vault.stat(path)?.mtime ?? Date.now()`  
- `chunkCount` 可先 0，增量路径再更新  

### 4.4 gitignore

追加忽略旧名：`index-manifest.json`、`index-manifest.json.tmp`（`.index/` 已覆盖新路径）。

---

## 5. 验收

1. 日常主库：有 `.index/` 无清单时，重载插件后出现 `.index/ratel-manifest.json`，且 **不** 出现全库 re-embed 进度（或仅极短 Diffing）  
2. 关闭再开 Obsidian：`skipped` 占绝大多数；状态仍就绪  
3. `/reindex` 仍强制全量并写出新清单  
4. 单测：迁移函数；参数变更后 entries 非空（或集成测覆盖 writeManifest 路径）

---

## 6. 影响面

- `src/core/index-manifest.ts` — 路径常量 + migrate  
- `src/main.ts` — `doSmartReindex` / `writeManifestAfterFullReindex`  
- `src/utils/gitignore-writer.ts`  
- 文档：`docs/architecture/rag/vector-index.md`（若写旧路径）轻量同步  
- ADR-007：本 spec 修订「文件落点」；可不新建 ADR，在本 spec 写明推翻理由  

---

## 7. 参考

- 磁盘诊断：日常主库缺清单、Sandbox 有清单  
- ADR-007、S-INDEX-STARTUP（已归档）
