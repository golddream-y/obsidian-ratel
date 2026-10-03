/**
 * @file src/ui/settings/chat-profiles-render.ts
 * @description 设置页「已保存的配置」列表 — 切换、当前套展开区(名称/供应商名单/模型/窗口)
 * @module ui/settings/chat-profiles-render
 * @depends obsidian, ../../settings/chat-profiles, ../../settings/settings-apply, ../../secrets/ratel-secrets, ../../i18n
 */

import { App, Modal, Notice, Setting, SettingPage, type SettingDefinitionList } from 'obsidian';
import type RatelVaultPlugin from '../../main';
import type { ChatProfile } from '../../settings/chat-profiles';
import {
	assignStoredProfileProvider,
	deleteChatProfile,
	inferChatProvider,
	projectProfileToSettings,
	saveCurrentAsProfile,
	switchChatProfile,
	syncChatWindow,
	writeStoredProfileModel,
	writeStoredProfileWindow,
} from '../../settings/chat-profiles';
import {
	CATALOG_MODEL_HAND,
	LOCAL_PROVIDER_CUSTOM,
	LOCAL_PROVIDER_OLLAMA,
	listCatalogModels,
	filterCatalogProviders,
	listCatalogProviders,
	lookupCatalogLimits,
	providerSearchAlias,
	modelPickValue,
	type CatalogProviderRow,
	type ModelsDevCatalog,
} from '../../settings/model-catalog';
import { applySettingValue } from '../../settings/settings-apply';
import {
	deleteChatProfileSecret,
	readChatProfileSecret,
	requiresChatApiKey,
	resolveChatApiKey,
	setChatProfileSecret,
	chatProfileSecretId,
} from '../../secrets/ratel-secrets';
import { tNow } from '../../i18n';
import { CUSTOM_TOKEN_MAX, CUSTOM_TOKEN_MIN } from '../../ui/tokens/context-length-presets';

/**
 * 简单文本输入 Modal — 用于改名 / 另存为名称。
 */
class TextPromptModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private placeholder: string,
		private initial: string,
		private onSubmit: (value: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(this.title);
		let value = this.initial;
		new Setting(contentEl)
			.addText((text) => {
				text.setPlaceholder(this.placeholder);
				text.setValue(this.initial);
				text.inputEl.addEventListener('input', () => {
					value = text.getValue();
				});
				setTimeout(() => text.inputEl.focus(), 0);
			})
			.addButton((btn) => {
				btn.setButtonText(tNow('settings.chatProfiles.promptConfirm'));
				btn.setCta();
				btn.onClick(() => {
					const trimmed = value.trim();
					if (!trimmed) return;
					this.onSubmit(trimmed);
					this.close();
				});
			});
	}
}

/**
 * 字段修改只落盘，不重绘整个设置页，避免从二级页被弹回列表。
 */
async function persistProfileEdit(plugin: RatelVaultPlugin): Promise<void> {
	await plugin.saveSettings({ refreshSettingsTab: false });
}

/** 这一套是不是当前正在对话的那套。 */
function profileIsActive(plugin: RatelVaultPlugin, profile: ChatProfile): boolean {
	return profile.id === plugin.settings.activeChatProfileId;
}

/**
 * 写入模型名。当前套走全局字段并重建客户端；其他套只改自己。
 *
 * @param plugin - 插件
 * @param profile - 正在编辑的那一套
 * @param model - 新模型名
 */
async function commitProfileModel(
	plugin: RatelVaultPlugin,
	profile: ChatProfile,
	model: string,
): Promise<void> {
	// 先写打开的这一套。是当前套时再把这一套抄到全局，避免写到另一套上。
	writeStoredProfileModel(profile, model);
	if (profileIsActive(plugin, profile)) {
		plugin.settings.chatModel = profile.model;
		plugin.rebuildLLM();
		const catalog = plugin.modelsDevCatalog ? await plugin.modelsDevCatalog.ensureCatalog() : null;
		await syncChatWindow(plugin.settings, { catalog, clearOnMiss: true });
	}
	await persistProfileEdit(plugin);
}

/**
 * 已保存配置列表。点一行进入这一套的二级页。加号把当前配置再存一套。
 */
export function buildChatProfileList(app: App, plugin: RatelVaultPlugin): SettingDefinitionList {
	const profiles = plugin.settings.chatProfiles ?? [];
	return {
		type: 'list',
		heading: tNow('settings.chatProfiles.heading'),
		addItem: {
			name: tNow('settings.chatProfiles.saveAsAction'),
			action: () => {
				new TextPromptModal(
					app,
					tNow('settings.chatProfiles.saveAsPromptTitle'),
					tNow('settings.chatProfiles.saveAsPromptPlaceholder'),
					'',
					async (name) => {
						const sourceProfileId = plugin.settings.activeChatProfileId;
						const key = resolveChatApiKey(app, {
							chatApiBase: plugin.settings.chatApiBase,
							chatProfiles: plugin.settings.chatProfiles,
							activeChatProfileId: sourceProfileId,
						});
						const created = saveCurrentAsProfile(plugin.settings, name);
						if (key) setChatProfileSecret(app, created, key);
						await plugin.saveSettings();
						new Notice(tNow('settings.chatProfiles.saveAsDone'), 3000);
					},
				).open();
			},
		},
		onDelete: (index) => {
			const profile = plugin.settings.chatProfiles[index];
			if (!profile) return;
			try {
				deleteChatProfile(plugin.settings, profile.id);
			} catch {
				new Notice(tNow('settings.chatProfiles.deleteActiveBlocked'), 5000);
				void plugin.saveSettings();
				return;
			}
			deleteChatProfileSecret(app, profile.id, profile);
			void plugin.saveSettings();
			new Notice(tNow('settings.chatProfiles.deleted', { name: profile.name }), 3000);
		},
		items: profiles.map((profile) => ({
			type: 'page' as const,
			name: profile.name,
			desc: profile.model,
			...(profile.id === plugin.settings.activeChatProfileId
				? { displayValue: tNow('settings.chatProfiles.activeMark') }
				: {}),
			page: () => new ChatProfileSettingPage(app, plugin, profile.id),
		})),
	};
}

/**
 * 某一套配置的编辑页。标题就是这套的名字，由设置框架的返回回到列表。
 */
export class ChatProfileSettingPage extends SettingPage {
	private closed = false;
	/** 在这一页里再进「选择供应商」，框架的返回仍回到配置列表。 */
	private pickingProvider = false;
	/** 进入本页时列表上显示的名称和模型。返回后用来找到那一行。 */
	private listSnapshot: { name: string; model: string } | null = null;
	/** 列表行回到设置面板时改名称。返回动画结束后才插回，不能只刷一次。 */
	private listObserver: MutationObserver | null = null;

	constructor(
		private app: App,
		private plugin: RatelVaultPlugin,
		private profileId: string,
	) {
		super();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const profile = this.plugin.settings.chatProfiles.find((item) => item.id === this.profileId);
		if (!profile) return;
		if (!this.listSnapshot) {
			this.listSnapshot = { name: profile.name, model: profile.model };
		}
		this.ensureListWatch();
		// 与高级里声明式二级页相同：setting-group > setting-items，内边距交给框架。
		const body = containerEl.createDiv({ cls: 'setting-group' }).createDiv({ cls: 'setting-items' });

		if (this.pickingProvider) {
			renderProviderPicker(body, this.plugin, profile, {
				onChoose: (providerId) => {
					void (async () => {
						await commitProviderChoice(this.plugin, profile, providerId);
						this.pickingProvider = false;
						if (!containerEl.isConnected) return;
						this.display();
					})();
				},
			});
			return;
		}

		if (profile.id !== this.plugin.settings.activeChatProfileId) {
			new Setting(body)
				.setName(tNow('settings.chatProfiles.setActive'))
				.setDesc(profile.model)
				.addButton((btn) => {
					btn.setButtonText(tNow('settings.chatProfiles.setActive'));
					btn.setCta();
					btn.onClick(async () => {
						switchChatProfile(this.plugin.settings, profile.id);
						const catalog = this.plugin.modelsDevCatalog
							? await this.plugin.modelsDevCatalog.ensureCatalog()
							: null;
						const result = await syncChatWindow(this.plugin.settings, {
							catalog,
							clearOnMiss: true,
						});
						if (!result.applied && !result.skipped) {
							new Notice(tNow('settings.notice.contextLengthUnknown', { model: profile.model }), 5000);
						}
						await this.plugin.saveSettings({ refreshSettingsTab: false });
						this.plugin.rebuildLLM();
						new Notice(tNow('settings.chatProfiles.switched', { name: profile.name }), 3000);
						this.display();
					});
				});
		}

		renderProfileDetail(this.app, this.plugin, body, profile, () => {
			this.pickingProvider = true;
			this.display();
		}, () => {
			const root = this.plugin.settingTab?.containerEl;
			if (root) this.writeListRow(root);
		});
	}

	override hide(): void {
		if (this.closed) return;
		this.closed = true;
		super.hide();
		const tab = this.plugin.settingTab;
		if (!tab?.containerEl) return;
		const scope = tab.containerEl.closest('.modal') ?? tab.containerEl.parentElement ?? tab.containerEl;
		// 返回动画结束后列表才插回。晚一拍重画，并用当时的文字把那一行改掉。
		window.setTimeout(() => {
			if (!tab.containerEl.isConnected) return;
			tab.update();
			this.writeListRow(scope);
		}, 50);
		window.setTimeout(() => this.stopListWatch(), 2000);
	}

	/** 监听设置面板。列表行一旦插回来，就写成当前名称和模型。 */
	private ensureListWatch(): void {
		if (this.listObserver) return;
		const tab = this.plugin.settingTab;
		const scope = tab?.containerEl?.closest('.modal') ?? tab?.containerEl;
		if (!scope) return;
		this.listObserver = new MutationObserver(() => {
			if (!this.writeListRow(scope)) return;
			if (this.closed) this.stopListWatch();
		});
		this.listObserver.observe(scope, { childList: true, subtree: true });
	}

	private stopListWatch(): void {
		this.listObserver?.disconnect();
		this.listObserver = null;
	}

	/**
	 * 把配置列表里这一行的名称和模型换成当前值。
	 *
	 * @returns 是否找到并写上了列表行
	 */
	private writeListRow(root: ParentNode): boolean {
		const snapshot = this.listSnapshot;
		const profile = this.plugin.settings.chatProfiles.find((item) => item.id === this.profileId);
		if (!snapshot || !profile) return false;
		if (snapshot.name === profile.name && snapshot.model === profile.model) return true;
		let wrote = false;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const nameNodes: Text[] = [];
		let current = walker.nextNode();
		while (current) {
			if (current.textContent?.trim() === snapshot.name) nameNodes.push(current as Text);
			current = walker.nextNode();
		}
		for (const node of nameNodes) {
			const item = node.parentElement?.closest('.setting-item');
			// 一个格子里有多行名字时，说明拿到的是整张列表，不能改里面的模型小字。
			if (!item || item.querySelectorAll('.setting-item-name').length !== 1) continue;
			node.textContent = profile.name;
			wrote = true;
			const desc = item.querySelector('.setting-item-description');
			if (!desc) continue;
			for (const child of Array.from(desc.childNodes)) {
				if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim() === snapshot.model) {
					child.textContent = profile.model;
				}
			}
		}
		if (!wrote) return false;
		snapshot.name = profile.name;
		snapshot.model = profile.model;
		return true;
	}
}

/**
 * 渲染某一套的字段：名字、提供商、地址、密钥、模型、窗口。
 */
function renderProfileDetail(
	app: App,
	plugin: RatelVaultPlugin,
	root: HTMLElement,
	profile: ChatProfile,
	onChooseProvider: () => void,
	onLabelsChanged?: () => void,
): void {
	const detail = root.createDiv({ cls: 'ratel-chat-profile-detail' });

	// 名字和提供商分开，避免「自定义」既是名字又是提供商。
	new Setting(detail)
		.setName(tNow('settings.chatProfiles.name.name'))
		.setDesc(tNow('settings.chatProfiles.name.desc'))
		.addText((text) => {
			text.setValue(profile.name);
			text.inputEl.addEventListener('change', () => {
				void (async () => {
					const trimmed = text.getValue().trim();
					if (!trimmed || trimmed === profile.name) return;
					profile.name = trimmed;
					await persistProfileEdit(plugin);
					onLabelsChanged?.();
				})();
			});
		});

	// 提供商与模型依赖名单，先占位，拉到缓存后再填
	const providerHost = detail.createDiv();
	void (async () => {
		const catalog = plugin.modelsDevCatalog ? await plugin.modelsDevCatalog.ensureCatalog() : null;
		if (!providerHost.isConnected) return;
		renderProviderAndModel(app, plugin, providerHost, profile, catalog, onChooseProvider);
	})();

	renderProfileWindow(plugin, detail, profile);
}

/**
 * 名单到达后画出提供商、地址、密钥和模型。
 * 有 api 的供应商只展示地址；空 api、本地和自定义才可编辑。
 */
function renderProviderAndModel(
	app: App,
	plugin: RatelVaultPlugin,
	host: HTMLElement,
	profile: ChatProfile,
	catalog: ModelsDevCatalog | null,
	onChooseProvider: () => void,
): void {
	const providerId = profile.providerId || inferChatProvider(profile.apiBase);
	const rows = catalog ? listCatalogProviders(catalog) : [];
	const currentName = providerDisplayName(rows, providerId);

	const providerSetting = new Setting(host)
		.setName(tNow('settings.chatProfiles.provider.name'))
		.setDesc(catalog ? currentName : tNow('settings.chatProfiles.catalogMissing'));
	providerSetting.addButton((btn) => {
		btn.setButtonText(tNow('settings.chatProfiles.provider.choose'));
		btn.onClick(onChooseProvider);
	});

	const listed = rows.find((row) => row.id === providerId);
	const editableBase =
		providerId === LOCAL_PROVIDER_OLLAMA ||
		providerId === LOCAL_PROVIDER_CUSTOM ||
		!listed ||
		listed.api === null;
	if (!editableBase && listed?.api) {
		new Setting(host)
			.setName(tNow('settings.chatProfiles.apiBase.name'))
			.setDesc(listed.api);
	} else if (editableBase) {
		const address = new Setting(host)
			.setName(tNow('settings.chatProfiles.apiBase.name'));
		// 名单里的供应商但没给 api：不要编造，也不要用 /v1 占位假装必须这样填。
		if (listed && listed.api === null) {
			address.setDesc(tNow('settings.chatProfiles.provider.noApi'));
		}
		address.addText((text) => {
				text.setPlaceholder(tNow('settings.chatProfiles.apiBase.placeholder'));
				text.setValue(profile.apiBase);
				text.inputEl.addEventListener('change', () => {
					void (async () => {
						const trimmed = text.getValue().trim();
						if (!trimmed) return;
						profile.apiBase = trimmed;
						if (profileIsActive(plugin, profile)) {
							projectProfileToSettings(plugin.settings, profile);
							plugin.settings.chatPreset = inferChatProvider(profile.apiBase);
							plugin.rebuildLLM();
						}
						await persistProfileEdit(plugin);
					})();
				});
			});
	}

	if (requiresChatApiKey({ chatApiBase: profile.apiBase })) {
		const savedKey = readChatProfileSecret(app, profile) ?? '';
		const label = chatProfileSecretId(profile);
		let revealed = false;
		const keySetting = new Setting(host)
			.setName(tNow('settings.chatProfiles.apiKey.name'))
			.setDesc(tNow('settings.chatProfiles.apiKey.desc', { label }));
		let keyInput: HTMLInputElement | undefined;
		keySetting.addText((text) => {
			keyInput = text.inputEl;
			text.inputEl.type = 'password';
			text.setPlaceholder(tNow('settings.chatProfiles.apiKey.placeholder'));
			if (savedKey) text.setValue(savedKey);
			text.inputEl.addEventListener('change', () => {
				const trimmed = text.getValue().trim();
				if (!trimmed) return;
				setChatProfileSecret(app, profile, trimmed);
				new Notice(tNow('settings.chatProfiles.apiKey.saved'), 3000);
			});
		});
		keySetting.addExtraButton((btn) => {
			btn.setIcon('eye');
			btn.setTooltip(tNow('settings.chatProfiles.apiKey.show'));
			btn.onClick(() => {
				if (!keyInput) return;
				revealed = !revealed;
				keyInput.type = revealed ? 'text' : 'password';
				btn.setIcon(revealed ? 'eye-off' : 'eye');
				btn.setTooltip(tNow(revealed
					? 'settings.chatProfiles.apiKey.hide'
					: 'settings.chatProfiles.apiKey.show'));
			});
		});
	}

	const handOnly = providerId === LOCAL_PROVIDER_OLLAMA || providerId === LOCAL_PROVIDER_CUSTOM || !catalog;
	if (handOnly) {
		addModelText(plugin, host, profile, () => refreshProfileWindow(plugin, host, profile));
		return;
	}
	const modelIds = listCatalogModels(catalog, providerId);
	const picked = modelPickValue(modelIds, profile.model);
	new Setting(host)
		.setName(tNow('settings.chatProfiles.model.name'))
		.addDropdown((drop) => {
			const modelOptions: Record<string, string> = {};
			for (const id of modelIds) modelOptions[id] = id;
			modelOptions[CATALOG_MODEL_HAND] = tNow('settings.chatProfiles.model.hand');
			drop.addOptions(modelOptions);
			let armed = false;
			drop.setValue(picked);
			armed = true;
			drop.onChange(async (value) => {
				// 下拉初始化会回调一次。控件已经不在页面上时，也不能再写到别的套上。
				if (!armed || !host.isConnected || value === profile.model) return;
				if (value === CATALOG_MODEL_HAND) {
					// 手填只留一个框。已有则不再追加。
					showHandModel(host, plugin, profile);
					return;
				}
				// 选回名单里的模型时，把之前的手填框拿掉，避免叠成两三个「模型」。
				hideHandModel(host);
				await commitProfileModel(plugin, profile, value);
				refreshProfileWindow(plugin, host, profile);
			});
		});
	if (picked === CATALOG_MODEL_HAND) showHandModel(host, plugin, profile);
}

/** 把供应商写进这一套，并让当前对话字段跟上。 */
async function commitProviderChoice(
	plugin: RatelVaultPlugin,
	profile: ChatProfile,
	providerId: string,
): Promise<void> {
	const catalog = plugin.modelsDevCatalog ? await plugin.modelsDevCatalog.ensureCatalog() : null;
	assignStoredProfileProvider(plugin.settings, profile, providerId, catalog);
	if (profileIsActive(plugin, profile)) {
		projectProfileToSettings(plugin.settings, profile);
		plugin.settings.chatPreset = inferChatProvider(profile.apiBase);
		plugin.rebuildLLM();
		await syncChatWindow(plugin.settings, { catalog, clearOnMiss: true });
	}
	await persistProfileEdit(plugin);
}

function providerDisplayName(rows: readonly CatalogProviderRow[], providerId: string): string {
	if (providerId === LOCAL_PROVIDER_OLLAMA) return tNow('settings.chatPreset.ollama');
	if (providerId === LOCAL_PROVIDER_CUSTOM) return tNow('settings.chatPreset.custom');
	return rows.find((row) => row.id === providerId)?.name || providerId;
}

/**
 * 选择供应商的一页：检索过滤，每行带接口地址和文档链接。
 * 名单没有文字简介。
 */
function renderProviderPicker(
	root: HTMLElement,
	plugin: RatelVaultPlugin,
	profile: ChatProfile,
	actions: { onChoose: (providerId: string) => void },
): void {
	const currentId = profile.providerId || inferChatProvider(plugin.settings.chatApiBase);
	root.createEl('p', {
		text: tNow('settings.chatProfiles.provider.intro'),
		cls: 'setting-item-description',
	});
	const listHost = root.createDiv();
	const search = new Setting(root).setName(tNow('settings.chatProfiles.provider.searchPlaceholder'));
	search.addText((text) => {
		text.setPlaceholder(tNow('settings.chatProfiles.provider.searchPlaceholder'));
		text.inputEl.addEventListener('input', () => {
			void paint(text.getValue());
		});
	});
	// 检索框在列表上面
	root.insertBefore(search.settingEl, listHost);

	async function paint(query: string): Promise<void> {
		const catalog = plugin.modelsDevCatalog ? await plugin.modelsDevCatalog.ensureCatalog() : null;
		if (!listHost.isConnected) return;
		const rows = catalog ? listCatalogProviders(catalog) : [];
		listHost.empty();
		if (!catalog) {
			listHost.createEl('p', { text: tNow('settings.chatProfiles.catalogMissing') });
		}
		const grouped = providerChoiceGroups(rows, query);
		renderProviderSection(
			listHost,
			tNow('settings.chatProfiles.provider.sectionLocal'),
			grouped.local,
			currentId,
			actions,
		);
		renderProviderSection(
			listHost,
			tNow(query.trim()
				? 'settings.chatProfiles.provider.sectionMatch'
				: 'settings.chatProfiles.provider.sectionCommon'),
			grouped.catalog,
			currentId,
			actions,
		);
	}

	function renderProviderSection(
		parent: HTMLElement,
		title: string,
		sectionRows: readonly CatalogProviderRow[],
		selectedId: string,
		sectionActions: { onChoose: (providerId: string) => void },
	): void {
		if (sectionRows.length === 0) return;
		parent.createEl('h4', { text: title, cls: 'ratel-provider-section' });
		for (const row of sectionRows) {
			const alias = providerSearchAlias(row.id);
			const setting = new Setting(parent).setName(alias ? `${row.name}（${alias}）` : row.name);
			setting.settingEl.addClass('ratel-provider-pick');
			const desc = document.createDocumentFragment();
			desc.appendText(row.api ?? tNow('settings.chatProfiles.provider.noApi'));
			if (row.doc) {
				desc.appendText(' · ');
				const link = desc.createEl('a', {
					text: tNow('settings.chatProfiles.provider.doc'),
					href: row.doc,
					attr: { target: '_blank', rel: 'noopener noreferrer' },
				});
				link.addEventListener('click', (evt) => evt.stopPropagation());
			}
			setting.setDesc(desc);
			const current = row.id === selectedId;
			setting.addButton((btn) => {
				btn.setButtonText(tNow(current
					? 'settings.chatProfiles.provider.current'
					: 'settings.chatProfiles.provider.use'));
				if (current) btn.setDisabled(true);
				btn.onClick(() => {
					if (!current) sectionActions.onChoose(row.id);
				});
			});
		}
	}

	void paint('');
}

/**
 * 本机两项在上，名单在下。空白时名单只留常用；有检索词时常用过滤取消，按名称和中文别名匹配。
 */
function providerChoiceGroups(
	rows: readonly CatalogProviderRow[],
	query: string,
): { local: CatalogProviderRow[]; catalog: CatalogProviderRow[] } {
	const q = query.trim().toLowerCase();
	const local: CatalogProviderRow[] = [
		{ id: LOCAL_PROVIDER_OLLAMA, name: tNow('settings.chatPreset.ollama'), api: null, doc: null },
		{ id: LOCAL_PROVIDER_CUSTOM, name: tNow('settings.chatPreset.custom'), api: null, doc: null },
	].filter((row) => !q || row.name.toLowerCase().includes(q) || row.id.includes(q));
	return { local, catalog: filterCatalogProviders(rows, query) };
}

/** 手填框的包裹层。用标记避免「打开时加一个、再选手填又加一个」。 */
function handModelWrap(host: HTMLElement): HTMLElement | null {
	return host.querySelector(':scope > [data-hand-model]');
}

/** 保证最多一个手填框。 */
function showHandModel(host: HTMLElement, plugin: RatelVaultPlugin, profile: ChatProfile): void {
	if (handModelWrap(host)) return;
	const wrap = host.createDiv();
	wrap.dataset.handModel = '1';
	addModelText(plugin, wrap, profile, () => refreshProfileWindow(plugin, host, profile));
}

/** 选了名单中的模型后，去掉手填框。 */
function hideHandModel(host: HTMLElement): void {
	handModelWrap(host)?.remove();
}

/** 模型变了之后重画窗口那一行，避免说明还写着上一个模型名。 */
function refreshProfileWindow(
	plugin: RatelVaultPlugin,
	host: HTMLElement,
	profile: ChatProfile,
): void {
	const detail = host.parentElement;
	if (!detail) return;
	detail.querySelector(':scope > [data-profile-window]')?.remove();
	renderProfileWindow(plugin, detail, profile);
}

/**
 * 手填模型名。变更后按当前供应商精确查窗口。
 *
 * @param onCommitted - 写入成功后刷新窗口行
 */
function addModelText(
	plugin: RatelVaultPlugin,
	host: HTMLElement,
	profile: ChatProfile,
	onCommitted?: () => void,
): void {
	new Setting(host)
		.setName(tNow('settings.chatProfiles.model.name'))
		.setDesc(tNow('settings.chatProfiles.model.handDesc'))
		.addText((text) => {
			text.setValue(profile.model);
			text.inputEl.addEventListener('change', () => {
				void (async () => {
					const trimmed = text.getValue().trim();
					if (!trimmed) return;
					await commitProfileModel(plugin, profile, trimmed);
					onCommitted?.();
				})();
			});
		});
}

/**
 * 渲染上下文窗口一行(当前套展开区末行)。
 *
 * 三态:
 * - windowUserSet:用户改小过 — 「此配置的上限是 N」+ 数字框;
 * - 查表命中 — 「这个模型的窗口是 N」+「改得更小」按钮(不出现档位下拉);
 * - 查不到 — 「未查到 X 的窗口」+ 数字框,不静默沿用上一个模型的上限。
 */
function renderProfileWindow(
	plugin: RatelVaultPlugin,
	detail: HTMLElement,
	profile: ChatProfile,
): void {
	const setting = new Setting(detail).setName(tNow('settings.chatProfiles.window.heading'));
	setting.settingEl.dataset.profileWindow = '1';
	const active = profileIsActive(plugin, profile);
	const windowTokens = active ? plugin.settings.chatModelMaxTokens : profile.chatModelMaxTokens;

	if (profile.windowUserSet) {
		const baseDesc =
			tNow('settings.chatProfiles.window.userSet', {
				tokens: windowTokens.toLocaleString(),
			}) + '\n' + tNow('settings.chatProfiles.window.userSetHint');
		setting.setDesc(baseDesc);
		addWindowNumberInput(setting, plugin, profile);
		if (!active) return;
		void (async () => {
			const catalog = plugin.modelsDevCatalog ? await plugin.modelsDevCatalog.ensureCatalog() : null;
			const result = await syncChatWindow(plugin.settings, { catalog, clearOnMiss: false });
			if (!setting.settingEl.isConnected || !result.output) return;
			setting.setDesc(baseDesc + '\n' + tNow('settings.chatProfiles.window.output', { tokens: result.output.toLocaleString() }));
		})();
		return;
	}

	// 查表是异步的:先渲染 loading,结果回来后原位补 desc 与控件
	setting.setDesc(tNow('settings.chatProfiles.window.loading'));
	void (async () => {
		const catalog = plugin.modelsDevCatalog ? await plugin.modelsDevCatalog.ensureCatalog() : null;
		if (!active) {
			paintStoredWindow(setting, plugin, profile, catalog);
			return;
		}
		const result = await syncChatWindow(plugin.settings, {
			catalog,
			// 仅展示:查不到保留旧值(不落盘),避免打开设置就清空
			clearOnMiss: false,
		});
		// 关键路径:查到且值变化才落盘;saveSettings 会触发整页重渲染,本元素随之重建
		if (result.changed) {
			await persistProfileEdit(plugin);
		}
		if (!setting.settingEl.isConnected) return;
		if (result.tokens != null) {
			const found = result.tokens;
			let desc =
				tNow('settings.chatProfiles.window.found', { tokens: found.toLocaleString() }) +
				'\n' +
				tNow('settings.chatProfiles.window.foundHint');
			if (result.output) {
				desc += '\n' + tNow('settings.chatProfiles.window.output', { tokens: result.output.toLocaleString() });
			}
			setting.setDesc(desc);
			setting.addButton((btn) => {
				btn.setButtonText(tNow('settings.chatProfiles.window.shrink'));
				btn.onClick(async () => {
					await applySettingValue(plugin, 'chatModelMaxTokens', Math.floor(found / 2));
					await persistProfileEdit(plugin);
				});
			});
		} else {
			setting.setDesc(
				tNow('settings.chatProfiles.window.unknown', { model: plugin.settings.chatModel }) +
					'\n' +
					tNow('settings.chatProfiles.window.unknownHint'),
			);
			addWindowNumberInput(setting, plugin, profile);
		}
	})();
}

/**
 * 非当前套的窗口只读这一套自己的数字，查表不写全局上限。
 *
 * @param setting - 窗口那一行
 * @param plugin - 插件
 * @param profile - 正在编辑的那一套
 * @param catalog - 已加载名单
 */
function paintStoredWindow(
	setting: Setting,
	plugin: RatelVaultPlugin,
	profile: ChatProfile,
	catalog: ModelsDevCatalog | null,
): void {
	if (!setting.settingEl.isConnected) return;
	const found = catalog
		? lookupCatalogLimits(catalog, profile.providerId || 'custom', profile.model)
		: undefined;
	if (found) {
		let desc =
			tNow('settings.chatProfiles.window.found', { tokens: found.context.toLocaleString() }) +
			'\n' +
			tNow('settings.chatProfiles.window.foundHint');
		if (found.output > 0) {
			desc += '\n' + tNow('settings.chatProfiles.window.output', { tokens: found.output.toLocaleString() });
		}
		setting.setDesc(desc);
		setting.addButton((btn) => {
			btn.setButtonText(tNow('settings.chatProfiles.window.shrink'));
			btn.onClick(async () => {
				writeStoredProfileWindow(profile, Math.floor(found.context / 2), true);
				await persistProfileEdit(plugin);
			});
		});
		return;
	}
	setting.setDesc(
		tNow('settings.chatProfiles.window.unknown', { model: profile.model }) +
			'\n' +
			tNow('settings.chatProfiles.window.unknownHint'),
	);
	addWindowNumberInput(setting, plugin, profile);
}

/** 窗口数字框 — min/max 与旧高级页一致,写入走 chatModelMaxTokens 分支(含大于查到值的钳制) */
function addWindowNumberInput(setting: Setting, plugin: RatelVaultPlugin, profile: ChatProfile): void {
	setting.addText((text) => {
		text.inputEl.type = 'number';
		text.inputEl.min = String(CUSTOM_TOKEN_MIN);
		text.inputEl.max = String(CUSTOM_TOKEN_MAX);
		// 关键路径:查不到时可能已被清成 0,预填空而非 0,引导用户填写
		const active = profileIsActive(plugin, profile);
		const current = active ? plugin.settings.chatModelMaxTokens : profile.chatModelMaxTokens;
		if (current > 0) {
			text.setValue(String(current));
		}
		text.inputEl.addEventListener('change', () => {
			void (async () => {
				const n = Number.parseInt(text.getValue(), 10);
				if (!Number.isFinite(n) || n <= 0) return;
				if (profileIsActive(plugin, profile)) {
					await applySettingValue(plugin, 'chatModelMaxTokens', n);
				} else {
					writeStoredProfileWindow(profile, n, true);
				}
				await persistProfileEdit(plugin);
			})();
		});
	});
}
