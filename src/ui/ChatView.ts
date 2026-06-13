import { ItemView, type WorkspaceLeaf } from 'obsidian';
import ChatViewComponent from './ChatView.svelte';
import type RatelVaultPlugin from '../main';

export const VIEW_TYPE_CHAT = 'ratel-chat';

export class ChatView extends ItemView {
	component: { $destroy: () => void } | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: RatelVaultPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_CHAT;
	}

	getDisplayText(): string {
		return 'Ratel Chat';
	}

	getIcon(): string {
		return 'brain';
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();

		this.component = new ChatViewComponent({
			target: container,
			props: {
				plugin: this.plugin,
			},
		}) as { $destroy: () => void };
	}

	async onClose(): Promise<void> {
		this.component?.$destroy();
		this.component = null;
	}
}
