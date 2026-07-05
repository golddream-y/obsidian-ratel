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
 */

import { IndexManager, type IndexBackend } from './index-manager';
import { FolderWatcher } from './folder-watcher';
import { Ratelignore } from '../utils/ratelignore-parser';
import { devLogger } from '../logging/dev-logger';

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

    constructor(private vault: VaultEventListener, backend: IndexBackend, vaultRoot: string) {
        this.indexManager = new IndexManager(backend);
        this.ratelignore = new Ratelignore(vaultRoot);
    }

    /**
     * 启动期调用 — 注册 vault 事件 + 索引启动。
     *
     * 关键路径:
     * - FolderWatcher 始终启动(无论 autoIndex),用户手动改文件仍增量(spec §5.7)。
     * - autoIndex=false 时跳过 smartReindex,但保留 FolderWatcher + 手动 /reindex。
     *
     * @param autoIndex - 是否启动自动索引。false 时仅启动 FolderWatcher,不跑 smartReindex。
     */
    async onLayoutReady(autoIndex = true): Promise<{ indexed: number; errors: number } | null> {
        this.watcher.start({
            // 关键路径:去抖触发后读取文件内容,随 op 一起入队。
            // 文件可能在去抖期间被删,readFile 失败时静默跳过。
            onUpsert: (p) => {
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
                if (!this.ratelignore.ignores(p)) this.watcher.notify(p, 'upsert');
            }),
            this.vault.onFileModify((p) => {
                if (!this.ratelignore.ignores(p)) this.watcher.notify(p, 'upsert');
            }),
            this.vault.onFileDelete((p) => this.watcher.notify(p, 'delete')),
            this.vault.onFileRename((newPath, oldPath) => {
                this.watcher.notify(oldPath, 'delete');
                if (!this.ratelignore.ignores(newPath)) this.watcher.notify(newPath, 'upsert');
            }),
        );

        // 关键路径:autoIndex=false 时仅启动 FolderWatcher,不跑 smartReindex(spec §5.7)。
        // 用户手动改文件仍增量,索引不会过期;手动 /reindex 仍可触发全量。
        if (!autoIndex) {
            return null;
        }
        return this.indexManager.onLayoutReady();
    }

    pause(): void { this.indexManager.pause(); }
    resume(): void { this.indexManager.resume(); }
    async reindex(): Promise<void> { await this.indexManager.reindex(); }

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
        if (op === 'delete') {
            this.indexManager.enqueue(path, 'delete');
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

    /** 卸载 — 清 watcher + 退订 vault 事件。 */
    destroy(): void {
        this.watcher.stop();
        for (const u of this.unsubscribers) u();
        this.unsubscribers = [];
    }
}
