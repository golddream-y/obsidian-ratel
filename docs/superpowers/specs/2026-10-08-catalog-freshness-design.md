# S-CATALOG-FRESH — 模型名单一天内跟远端对齐

> 日期: 2026-10-08
> 状态: Active
> Spec ID: **S-CATALOG-FRESH**
> 关联: [S-MODEL-CATALOG](2026-09-28-model-catalog-design.md)（名单来源与下拉规则）。本 spec 只改 MC-01 的缓存时长。

---

## 1. 背景

对话模型页的供应商和模型来自 `https://models.dev/api.json`，缓存在插件目录的 `models-dev.json`。S-MODEL-CATALOG 规定打开该页时，缓存未满 7 天才用本地文件，满 7 天再拉。拉取失败继续用旧文件。对话发送和插件启动都不拉。

远端删掉一个模型 id 之后，本地文件里它还在。7 天内打开设置不会重拉，所以下拉里仍能搜到。拉取失败时，旧文件可以一直用下去。

`status: "deprecated"` 是名单上的标记，条目仍在 JSON 里。那不是缓存过期。本 spec 不按这个标记隐藏模型。

## 2. 目标

1. 打开对话模型页时，缓存超过 24 小时就重新拉取 models.dev。
2. 未超过 24 小时不发请求，继续用本地文件。
3. 拉取成功则覆盖本地名单，并把拉取时间写成现在。
4. 拉取失败、响应不是名单、或超过 8MB，仍用本地旧文件。没有旧文件时行为与现在相同，返回 null。

## 3. 非目标

- 不按 `status` 隐藏模型。`deprecated` 与 `beta` 的下拉规则仍是 S-MODEL-CATALOG MC-04：窗口大于 0 且 `tool_call` 为真就列出。
- 不在插件 `onload` 拉取，对话发送不拉取。
- 不在设置页开着的时候轮询。只在打开对话模型页、调用 `ensureCatalog` 时检查。
- 不拉各家自己的 `/v1/models`。
- 不改已保存配置里的模型 id。下拉里暂时没有的 id 仍走现有的「手填」。
- 不加手动刷新按钮。
- 不改生态清单、LiteLLM 映射表各自的 7 天缓存。

## 4. 详细设计

### 4.1 时长

`CATALOG_TTL_MS` 从 `7 * 24 * 60 * 60 * 1000` 改为 `24 * 60 * 60 * 1000`，并从 `model-catalog-cache.ts` 导出，测试直接用这个常量。

比较仍用严格大于：`Date.now() - fetchedAt > CATALOG_TTL_MS` 才视为过期。刚好满 24 小时仍用缓存。

### 4.2 拉取顺序

与现在相同，只改时长：

1. 本地文件存在、来源 URL 仍是 `MODELS_DEV_URL`、且未超过 24 小时：返回该文件，不请求。
2. 否则请求 `MODELS_DEV_URL`。成功则原子写入 `models-dev.json` 与 `models-dev.meta.json`，`fetchedAt` 为这次写入的时间。
3. 请求失败：读本地文件，忽略时长。有则返回并打现有警告。没有则返回 null。

来源 URL 不一致时仍视为缓存无效，走第 2 步。体积上限仍是 8MB。

### 4.3 和 S-MODEL-CATALOG 的关系

MC-01 与 §5.3 里「超过 7 天」改为「超过 24 小时」，并指向本 spec。其余条款不变。

---

## 5. 影响面

| 区域 | 变化 |
|---|---|
| `src/settings/model-catalog-cache.ts` | TTL 改为 24 小时并导出 |
| `tests/settings/model-catalog-cache.test.ts` | 超过 24 小时会请求；未超过不请求 |
| `docs/superpowers/specs/2026-09-28-model-catalog-design.md` | MC-01 与 §5.3 的时长改为 24 小时 |
| `CHANGELOG.md` | `[Unreleased]` 记一条：打开对话模型页时，名单超过一天会重新拉取 |

用户手册不写缓存时长，不改。

---

## 6. 参考

- [S-MODEL-CATALOG](2026-09-28-model-catalog-design.md) MC-01、§5.3
- `src/settings/model-catalog-cache.ts`
