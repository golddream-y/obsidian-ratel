# ADR-007:索引清单独立于 data.json

**日期**:2026-06-28
**状态**:Accepted

## 背景

Ratel Vault 0.1.0 每次启动都全量 re-embed 整个 vault,5000 笔记库冷启动需要数十分钟。引入 smart reindex 需要一个"清单"记录每文件的内容指纹(sha256)+ mtime + chunkCount,以及全局 embedding 参数(embedModelId / chunkSize / chunkOverlap),启动期 hash diff 跳过未变更文件。

清单数据的存放位置有两个候选:

1. **data.json**(走 Obsidian `loadData/saveData`)— 与 settings 同文件
2. **独立文件** `pluginDir/index-manifest.json`(直接 fs 读写)— 与 `.index/` 同目录同生命周期

## 决策

采用方案 2 — **独立文件 `pluginDir/index-manifest.json`,直接 `fs/promises` 读写,不走 Obsidian loadData/saveData**。

## 理由

### 与 `.index/` 同生命周期

manifest 描述的是向量索引的内容指纹,与 `.index/` 目录一一对应。若放 data.json,`.index/` 删除重建后 manifest 仍在,产生不一致;独立文件则可与 `.index/` 一起清理(dropIndex + invalidate 配对)。

### 避免 data.json 膨胀

5000 笔记库的 manifest 包含 5000 条 entry(每条 path + sha256 + mtime + chunkCount ≈ 100 字节),约 500KB。data.json 是 Obsidian 启动时加载的设置文件,膨胀会拖慢 Obsidian 启动。独立文件按需加载,只在 smartReindex 时读取。

### 原子写

独立文件可用 `.tmp` + `rename` 原子写,避免半写损坏。Obsidian `saveData` 不保证原子性(内部走 `writeFile`),中途崩溃可能留下损坏 JSON,导致下次启动 manifest 解析失败。虽然 smartReindex 有降级路径(manifest 损坏 → 全量),但频繁降级浪费资源。

### 写入频率与 Obsidian 协议解耦

索引是高频写操作(每次 index.batch 后都要更新 manifest),Obsidian `saveData` 是低频 API,频繁调用可能触发不必要的设置重载或冲突。独立文件不受 Obsidian 设置协议约束。

## 影响

- `IndexManifest` 类直接 `import fs from 'fs'`,与 `VectraStore` 同属主线程磁盘 IO 层
- `dropIndex` 必须同时清 `.index/` 与 manifest(配对操作,见 `IndexManager.reindex`)
- manifest 文件位置:`<pluginDir>/index-manifest.json`,与 `.index/` 同级
- 文件损坏不致命:`load()` 返回 null,调用方降级全量重建(spec §9)
- 新增 ARCHITECTURE.md `rag/vector-index.md` §6.1 目录结构需补充该文件

## 替代方案

### A. 放 data.json

**优点**:复用 Obsidian loadData/saveData,无新文件;Obsidian 自动同步到移动端(若将来支持)。

**缺点**:data.json 膨胀拖慢启动;非原子写易损坏;与 `.index/` 生命周期不同步;高频写触发设置协议。

**否决原因**:data.json 是设置文件,不是索引状态文件。混用职责违反单一职责,且性能与一致性劣势明显。

### B. 放 `.index/` 内部

**优点**:与 vectra 索引完全同目录,删 `.index/` 自动删 manifest。

**缺点**:vectra 内部目录结构是第三方库实现细节,Ratel 不应往里塞文件;vectra 升级若改目录结构会丢失 manifest。

**否决原因**:违反"不污染第三方库目录"原则,与 vectra 升级耦合。

## 参考

- spec `S-INDEX-STARTUP` §3.1 manifest 设计
- plan `P-INDEX-STARTUP` Task 1/2 — IndexManifest 类实现
- ADR-006 release asset distribution(manifest 不在商店三件套中,本地生成)
