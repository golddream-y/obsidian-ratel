/**
 * @file src/core/index-controller.ts
 * @description 索引控制器 — 聚合 IndexManager + FolderWatcher + Vault 事件 + .ratelignore
 * @module core/index-controller
 * @depends core/index-manager, core/folder-watcher, utils/ratelignore-parser
 *
 * 设计要点:
 * - 启动期连接 vault 事件 → FolderWatcher → IndexManager.enqueue
 * - .ratelignore 过滤后入队;被排除的文件不入队
 * - pause / resume / reindex 三个方法直接透传到 IndexManager
 * - 自动索引开启时:事件通路先于任何扫描装配;注入 T4 协调器后由经理转发给协调器。
 * - 自动索引关闭时:保持只读契约 —— 不装配写路径监听、不读全库、不嵌入、不写盘;
 *   事件只记入内存的「已变更」集合,供检索侧过滤过期候选(黑名单清理只排队)。
 */

import { IndexManager, type IndexBackend, type IndexTaskCoordinatorPort } from './index-manager';
import { FolderWatcher } from './folder-watcher';
import { Ratelignore } from '../utils/ratelignore-parser';
import { isIndexableMarkdownPath } from '../utils/path-safety';
import { devLogger } from '../logging/dev-logger';
import { get } from 'svelte/store';
import { tNow } from '../i18n';

/**
 * 只读可见性视图端口 — 由 T4 的 `ReadOnlySearchView` 结构上满足。
 *
 * 关键路径:只读通道没有任何写入口;关闭自动索引时检索只消费可信完成记录。
 */
export interface ReadOnlySearchViewPort {
    /** 重新读取可信完成记录(只读,不写盘)。 */
    refresh(unresolvedPaths?: ReadonlySet<string>): Promise<unknown>;
    /** 记录是否可判定;`unjudgeable` 时不得显示为「0 篇可检索」。 */
    recordsKind(): 'known' | 'unjudgeable';
    /** 候选新鲜度;关闭自动索引时可信记录为 `unknown`。 */
    freshnessOf(path: string): string;
    /** 过滤候选,必须在融合/重排之前调用。 */
    filterCandidates<T extends { path: string }>(candidates: readonly T[]): Promise<{
        visible: T[];
        denied: Array<{ path: string; reason: string }>;
    }>;
}

/** IndexController 可选装配 — 协调器与只读视图由宿主装配层注入。 */
export interface IndexControllerOptions {
    /** 任务协调器;注入后自动索引由协调器持有事件、新鲜度与提交。 */
    coordinator?: IndexTaskCoordinatorPort;
    /** 关闭自动索引时使用的只读可见性视图。 */
    readOnlyView?: ReadOnlySearchViewPort;
}

/**
 * Vault 事件订阅接口(从 VaultPort 抽离,避免在 IndexController 强依赖全 VaultPort)。
 *
 * 关键路径:包含 readFile 方法,用于增量索引时读取文件内容。
 */
export interface VaultEventListener {
    onFileCreate(cb: (path: string) => void): () => void;
    onFileModify(cb: (path: string) => void): () => void;
    onFileDelete(cb: (path: string) => void): () => void;
    onFileRename(cb: (newPath: string, oldPath: string) => void): () => void;
    readFile(path: string): Promise<string>;
}

export class IndexController {
    readonly indexManager: IndexManager;
    private watcher = new FolderWatcher();
    private ratelignore: Ratelignore;
    private unsubscribers: Array<() => void> = [];

    private readonly readOnlyView: ReadOnlySearchViewPort | undefined;
    /** 只读模式下的内存变更集合 — 不落盘、不读文件,仅供检索侧过滤。 */
    private readonly readOnlyChangedPaths = new Set<string>();
    /** 当前已装配的事件通路 — 重复装配必须先去重,否则 vault 订阅会叠加。 */
    private wiredMode: 'write' | 'read-only' | null = null;

    constructor(private vault: VaultEventListener, backend: IndexBackend, vaultRoot: string, options: IndexControllerOptions = {}) {
        this.indexManager = new IndexManager(backend, options.coordinator);
        this.ratelignore = new Ratelignore(vaultRoot);
        this.readOnlyView = options.readOnlyView;
    }

    /** 只读可见性视图 — 未注入时为 undefined(宿主装配层负责注入)。 */
    searchVisibilityView(): ReadOnlySearchViewPort | undefined {
        return this.readOnlyView;
    }

    /**
     * 只读模式下已知发生变更的路径 — 检索侧据此过滤过期候选。
     *
     * 归属:T7 检索侧消费。只读通道没有写路径监听,完成记录不会随用户编辑更新;
     * 未消费本集合时,只读视图只能靠快照有效期兜底(见 `ReadOnlySearchView` 最大有效期)。
     */
    readOnlyChanged(): ReadonlySet<string> {
        return new Set(this.readOnlyChangedPaths);
    }

    /**
     * 启动期调用 — 按「是否自动索引」装配唯一一条事件通路并驱动索引启动。
     *
     * 关键路径(A11 只读契约):
     * - `autoIndex=false` 时**不装配写路径监听**:不读文件、不入队、不提交、不嵌入、不写盘;
     *   事件只记入内存的「已变更」集合,并只读恢复已有的真实就绪状态。
     * - `autoIndex=true` 时才装配 FolderWatcher 与 vault 事件,并在任何扫描之前完成。
     * - 两条通路互斥且去重:重复调用只重新装配一次,不会叠加订阅。
     *
     * @param autoIndex - 是否启动自动索引。false 时为只读通道,不跑 smartReindex。
     */
    async onLayoutReady(autoIndex = true): Promise<{ indexed: number; errors: number } | null> {
        // 关键路径:关闭自动索引 = 只读契约。这里**不装配写路径监听**(不读文件、不入队、不提交),
        // 只把变更记在内存里供检索侧过滤;恢复写事务必须等用户显式启用索引或执行重建。
        if (!autoIndex) {
            this.wireReadOnlyEvents();
            // 修复:禁用扫描不等于禁用已有索引；只读恢复真实就绪状态，仍不报告本次全量完成。
            await this.indexManager.restoreCommittedState();
            return null;
        }
        this.wireWriteEvents();
        return this.indexManager.onLayoutReady();
    }

    /**
     * 自动索引开启时的事件装配 — 在任何扫描之前完成,并保证只装配一次。
     *
     * 关键路径:监听先于扫描装配;枚举与监听之间的空隙由协调器的扫描后核对覆盖。
     */
    private wireWriteEvents(): void {
        if (this.wiredMode === 'write') return;
        this.unwireEvents();
        this.wiredMode = 'write';
        this.watcher.start({
            // 关键路径:去抖触发后读取文件内容,随 op 一起入队。
            // 文件可能在去抖期间被删,readFile 失败时静默跳过。
            onUpsert: (p) => {
                // 关键路径:协调器自行读取并核对磁盘内容,这里读到的正文会被丢弃 —— 不做白读。
                if (this.indexManager.hasCoordinator()) {
                    this.indexManager.enqueue(p, 'upsert');
                    return;
                }
                void this.vault.readFile(p).then(
                    (content) => this.indexManager.enqueue(p, 'upsert', content),
                    () => { /* 文件可能在去抖期间被删,忽略 */ },
                );
            },
            onDelete: (p) => this.indexManager.enqueue(p, 'delete'),
        });

        // 关键路径:订阅 4 个 vault 事件;rename 拆为 delete(old) + create(new)。
        this.unsubscribers.push(
            this.vault.onFileCreate((p) => {
                if (!isIndexableMarkdownPath(p)) return;
                if (!this.ratelignore.ignores(p)) this.watcher.notify(p, 'upsert');
            }),
            this.vault.onFileModify((p) => {
                if (!isIndexableMarkdownPath(p)) return;
                if (!this.ratelignore.ignores(p)) this.watcher.notify(p, 'upsert');
            }),
            this.vault.onFileDelete((p) => {
                if (!isIndexableMarkdownPath(p)) return;
                this.watcher.notify(p, 'delete');
            }),
            this.vault.onFileRename((newPath, oldPath) => {
                if (isIndexableMarkdownPath(oldPath)) this.watcher.notify(oldPath, 'delete');
                if (isIndexableMarkdownPath(newPath) && !this.ratelignore.ignores(newPath)) {
                    this.watcher.notify(newPath, 'upsert');
                }
            }),
        );
    }

    /**
     * 关闭自动索引时的事件装配 — 只读,零 IO。
     *
     * 关键路径:事件只更新内存集合,不读文件、不入队、不写盘;
     * 黑名单/删除路径由检索侧的可见性门过滤,恢复写事务留给用户显式操作。
     * 重复调用只装配一次,因此**不会丢弃此前的变更记录**(切换通路时才清空)。
     */
    private wireReadOnlyEvents(): void {
        if (this.wiredMode === 'read-only') return;
        this.unwireEvents();
        this.wiredMode = 'read-only';
        this.readOnlyChangedPaths.clear();
        const mark = (path: string): void => {
            if (isIndexableMarkdownPath(path)) this.readOnlyChangedPaths.add(path);
        };
        this.unsubscribers.push(
            this.vault.onFileCreate(mark),
            this.vault.onFileModify(mark),
            this.vault.onFileDelete(mark),
            this.vault.onFileRename((newPath, oldPath) => {
                mark(oldPath);
                mark(newPath);
            }),
        );
    }

    pause(): void { this.indexManager.pause(); }
    resume(): void { this.indexManager.resume(); }
    /** 重建失败向调用者抛错，防止子代理将失败转换为成功统计。 */
    async reindex(): Promise<void> {
        await this.indexManager.reindex();
        const status = get(this.indexManager.status$);
        if (status.state === 'Failed') throw new Error(status.reason);
        if (status.state === 'Unloaded') throw new Error(tNow('notice.indexResponseFailed'));
    }

    /**
     * 立即触发单文件索引刷新,绕过 FolderWatcher 5s 去抖。
     *
     * 关键路径:供 post-tool-use hook 调用,写工具执行后立即更新索引。
     * IndexManager.enqueue 已做 Map 去重(同 path 多次调用保留最后 op),无需额外去抖。
     *
     * @param path - 文件路径(vault 相对路径)
     * @param op - 'upsert' 或 'delete'
     */
    async enqueue(path: string, op: 'upsert' | 'delete'): Promise<void> {
        if (!isIndexableMarkdownPath(path)) return;
        if (op === 'delete') {
            this.indexManager.enqueue(path, 'delete');
            return;
        }
        if (this.indexManager.hasCoordinator()) {
            // 关键路径:协调器模式不读盘 —— 管理器会丢弃 content,协调器在读取/推理/提交前
            // 自行核对磁盘内容。这里读一次就是纯白读(每文件 1 次整读 + 1 次 sha256)。
            this.indexManager.enqueue(path, 'upsert');
            return;
        }
        // 关键路径:upsert 需读文件内容,文件可能在写工具执行后被删/移动,失败时静默跳过
        try {
            const content = await this.vault.readFile(path);
            this.indexManager.enqueue(path, 'upsert', content);
        } catch (err) {
            devLogger.warn('index', `immediate-reindex 读文件失败: ${path}`, err);
        }
    }

    /** 卸载 — 退订所有 vault 事件与 watcher,再卸载管理器。 */
    destroy(): void {
        this.readOnlyChangedPaths.clear();
        this.unwireEvents();
        this.indexManager.destroy();
    }

    /** 退订全部 vault 事件并停掉 watcher;切换通路或卸载时调用,保证订阅不叠加。 */
    private unwireEvents(): void {
        for (const u of this.unsubscribers) u();
        this.unsubscribers = [];
        this.watcher.stop();
        this.wiredMode = null;
    }
}
