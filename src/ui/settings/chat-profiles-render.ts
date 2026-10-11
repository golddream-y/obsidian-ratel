/**
 * @file src/ui/settings/chat-profiles-render.ts
 * @description 设置页「已保存的配置」列表 — 切换、当前套展开区(名称/供应商名单/模型/窗口)
 * @module ui/settings/chat-profiles-render
 * @depends obsidian, ../../settings/chat-profiles, ../../settings/settings-apply, ../../secrets/ratel-secrets, ../../i18n
 */

import {
	App,
	ButtonComponent,
	Modal,
	Notice,
	Setting,
	SettingPage,
	setIcon,
	type SettingDefinitionList,
} from "obsidian";
import type RatelVaultPlugin from "../../main";
import type { ChatProfile } from "../../settings/chat-profiles";
import {
	assignStoredProfileProvider,
	deleteChatProfile,
	inferChatProvider,
	projectProfileToSettings,
	createChatProfile,
	copyChatProfile,
	syncChatWindow,
	writeStoredProfileModel,
	writeStoredProfileWindow,
} from "../../settings/chat-profiles";
import { activateChatProfile } from "../chat/activate-chat-profile";
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
} from "../../settings/model-catalog";
import { applySettingValue } from "../../settings/settings-apply";
import {
	deleteChatProfileSecret,
	readChatProfileSecret,
	requiresChatApiKey,
	resolveChatApiKey,
	setChatProfileSecret,
	chatProfileSecretId,
} from "../../secrets/ratel-secrets";
import { tNow } from "../../i18n";
import type { StringKey } from "../../i18n/types";
import {
	CUSTOM_TOKEN_MAX,
	CUSTOM_TOKEN_MIN,
} from "../../ui/tokens/context-length-presets";
import {
	fieldsShapeFlips,
	resolveProviderControl,
	type ProviderListState,
} from "./provider-control";
import { runConnectionTest } from "./connection-test";

/**
 * 简单文本输入 Modal — 用于新建 / 复制 / 改名。
 */
class TextPromptModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private placeholder: string,
		private initial: string,
		private onSubmit: (value: string) => void | Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(this.title);
		let value = this.initial;

		// 修复: 输入框回车应等同点「确定」;中文输入法组词时的回车(isComposing)不能误提交。
		const submit = (): void => {
			const trimmed = value.trim();
			if (!trimmed) return;
			void this.onSubmit(trimmed);
			this.close();
		};

		new Setting(contentEl)
			.addText((text) => {
				text.setPlaceholder(this.placeholder);
				text.setValue(this.initial);
				text.inputEl.addEventListener("input", () => {
					value = text.getValue();
				});
				text.inputEl.addEventListener("keydown", (event) => {
					if (event.key !== "Enter" || event.isComposing) return;
					event.preventDefault();
					submit();
				});
				window.setTimeout(() => text.inputEl.focus(), 0);
			})
			.addButton((btn) => {
				btn.setButtonText(tNow("settings.chatProfiles.promptConfirm"));
				btn.setCta();
				btn.onClick(submit);
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
function profileIsActive(
	plugin: RatelVaultPlugin,
	profile: ChatProfile,
): boolean {
	return profile.id === plugin.settings.activeChatProfileId;
}

/**
 * 命令式打开某套配置的编辑页。
 *
 * openPage 是声明式设置框架(1.13+)的页面导航方法,框架列表行点击内部就走它,
 * 但未写进公开 d.ts。带运行时形状校验:拿不到就返回 false,调用方降级为刷新列表 + Notice。
 *
 * @returns 是否成功进入编辑页
 */
function openProfilePage(
	app: App,
	plugin: RatelVaultPlugin,
	profileId: string,
): boolean {
	const modal = (
		app as unknown as {
			setting?: { openPage?: (page: unknown) => void };
		}
	).setting;
	if (typeof modal?.openPage !== "function") return false;
	modal.openPage(new ChatProfileSettingPage(app, plugin, profileId));
	return true;
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
		const catalog = plugin.modelsDevCatalog
			? await plugin.modelsDevCatalog.ensureCatalog()
			: null;
		await syncChatWindow(plugin.settings, { catalog, clearOnMiss: true });
	}
	await persistProfileEdit(plugin);
}

/**
 * 已保存配置列表。点一行进入这一套的二级页。加号新建空配置，复制入口放在具体配置页。
 */
export function buildChatProfileList(
	app: App,
	plugin: RatelVaultPlugin,
): SettingDefinitionList {
	const profiles = plugin.settings.chatProfiles ?? [];
	return {
		type: "list",
		heading: tNow("settings.chatProfiles.heading"),
		addItem: {
			name: tNow("settings.chatProfiles.createAction"),
			action: () => {
				new TextPromptModal(
					app,
					tNow("settings.chatProfiles.createPromptTitle"),
					tNow("settings.chatProfiles.createPromptPlaceholder"),
					"",
					async (name) => {
						const profile = createChatProfile(
							plugin.settings,
							name,
						);
						// 先静默落库再直接进编辑页:新配置是空套,停在列表还要再点一次。
						await plugin.saveSettings({
							refreshSettingsTab: false,
						});
						if (!openProfilePage(app, plugin, profile.id)) {
							// 防御:框架导航不可用时退回旧行为(刷新列表 + 提示)。
							await plugin.saveSettings();
							new Notice(
								tNow("settings.chatProfiles.createDone"),
								3000,
							);
						}
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
				new Notice(
					tNow("settings.chatProfiles.deleteActiveBlocked"),
					5000,
				);
				void plugin.saveSettings();
				return;
			}
			deleteChatProfileSecret(app, profile.id, profile);
			void plugin.saveSettings();
			new Notice(
				tNow("settings.chatProfiles.deleted", { name: profile.name }),
				3000,
			);
		},
		items: profiles.map((profile) => ({
			type: "page" as const,
			name: profile.name,
			desc: profile.model || tNow("settings.chatProfiles.unconfigured"),
			...(profile.id === plugin.settings.activeChatProfileId
				? { displayValue: tNow("settings.chatProfiles.activeMark") }
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
		this.renderPage();
	}

	/** 宿主 display 保留为入口，页面内刷新复用独立渲染方法。 */
	private renderPage(): void {
		const { containerEl } = this;
		containerEl.empty();
		const profile = this.plugin.settings.chatProfiles.find(
			(item) => item.id === this.profileId,
		);
		if (!profile) return;
		if (!this.listSnapshot) {
			this.listSnapshot = { name: profile.name, model: profile.model };
		}
		this.ensureListWatch();
		// 与高级里声明式二级页相同：setting-group > setting-items，内边距交给框架。
		const body = containerEl
			.createDiv({ cls: "setting-group" })
			.createDiv({ cls: "setting-items" });

		if (this.pickingProvider) {
			renderProviderPicker(body, this.plugin, profile, {
				onChoose: (providerId) => {
					void (async () => {
						await commitProviderChoice(
							this.plugin,
							profile,
							providerId,
						);
						this.pickingProvider = false;
						if (!containerEl.isConnected) return;
						this.renderPage();
					})();
				},
			});
			return;
		}

		if (profile.id !== this.plugin.settings.activeChatProfileId) {
			new Setting(body)
				.setName(tNow("settings.chatProfiles.setActive"))
				.setDesc(profile.model)
				.addButton((btn) => {
					btn.setButtonText(tNow("settings.chatProfiles.setActive"));
					btn.setCta();
					btn.onClick(() => {
						// 与顶栏菜单共用同一条切换路径;Modal 内抑制设置 Tab 重绘,落库后只重绘当前页。
						void activateChatProfile(this.plugin, profile.id, {
							refreshSettingsTab: false,
							onActivated: () => this.renderPage(),
						});
					});
				});
		}

		renderProfileDetail(
			this.app,
			this.plugin,
			body,
			profile,
			() => {
				this.pickingProvider = true;
				this.renderPage();
			},
			() => {
				const root = this.plugin.settingTab?.containerEl;
				if (root) this.writeListRow(root);
			},
		);
	}

	override hide(): void {
		if (this.closed) return;
		this.closed = true;
		super.hide();
		const tab = this.plugin.settingTab;
		if (!tab?.containerEl) return;
		const scope =
			tab.containerEl.closest(".modal") ??
			tab.containerEl.parentElement ??
			tab.containerEl;
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
		const scope = tab?.containerEl?.closest(".modal") ?? tab?.containerEl;
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
		const profile = this.plugin.settings.chatProfiles.find(
			(item) => item.id === this.profileId,
		);
		if (!snapshot || !profile) return false;
		if (snapshot.name === profile.name && snapshot.model === profile.model)
			return true;
		let wrote = false;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const nameNodes: Text[] = [];
		let current = walker.nextNode();
		while (current) {
			if (current.textContent?.trim() === snapshot.name)
				nameNodes.push(current as Text);
			current = walker.nextNode();
		}
		for (const node of nameNodes) {
			const item = node.parentElement?.closest(".setting-item");
			// 一个格子里有多行名字时，说明拿到的是整张列表，不能改里面的模型小字。
			if (
				!item ||
				item.querySelectorAll(".setting-item-name").length !== 1
			)
				continue;
			node.textContent = profile.name;
			wrote = true;
			const desc = item.querySelector(".setting-item-description");
			if (!desc) continue;
			for (const child of Array.from(desc.childNodes)) {
				if (
					child.nodeType === Node.TEXT_NODE &&
					child.textContent?.trim() === snapshot.model
				) {
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
	const detail = root.createDiv({ cls: "ratel-chat-profile-detail" });

	// 名字和提供商分开，避免「自定义」既是名字又是提供商。
	new Setting(detail)
		.setName(tNow("settings.chatProfiles.name.name"))
		.setDesc(tNow("settings.chatProfiles.name.desc"))
		.addText((text) => {
			text.setValue(profile.name);
			text.inputEl.addEventListener("change", () => {
				void (async () => {
					const trimmed = text.getValue().trim();
					if (!trimmed || trimmed === profile.name) return;
					profile.name = trimmed;
					await persistProfileEdit(plugin);
					onLabelsChanged?.();
				})();
			});
		});

	// 供应商区拆成两个宿主：rowHost 只放供应商一行，fieldsHost 放地址／密钥／模型。
	// loading 立即把两部分都画成可交互形态；resolve 后按字段形态是否翻转决定重绘范围，
	// 避免黑洞网络下名单数十秒不返回时，清空用户正在填写的输入框与焦点。
	const providerHost = detail.createDiv();
	const rowHost = providerHost.createDiv();
	const fieldsHost = providerHost.createDiv();
	const providerId = profile.providerId || inferChatProvider(profile.apiBase);
	renderProviderRow(
		rowHost,
		profile,
		providerId,
		undefined,
		onChooseProvider,
	);
	renderProviderFields(
		app,
		plugin,
		fieldsHost,
		profile,
		providerId,
		undefined,
	);
	void (async () => {
		const catalog = plugin.modelsDevCatalog
			? await plugin.modelsDevCatalog.ensureCatalog()
			: null;
		if (!providerHost.isConnected) return;

		// resolve 后三段判定（决定 fieldsHost 动不动）：
		// 一、catalog 为 null（断网，头号场景）：离线字段就是 loading 画出的可编辑地址、
		//    密钥行、手填模型，用户可能正填到一半——只重画供应商行，字段区一个节点都不动；
		// 二、本机项（custom／ollama）或名单里查不到此项：字段仍是同一形态——同样不重画；
		// 三、名单厂商（listed 存在）：就绪后地址可能转只读、模型转下拉，形态真的翻转，
		//    才允许重建字段区。
		rowHost.empty();
		renderProviderRow(
			rowHost,
			profile,
			providerId,
			catalog,
			onChooseProvider,
		);
		if (!fieldsShapeFlips(catalog, providerId)) return;

		// 形态翻转但焦点还在字段内：等焦点真正离开字段区再重建。
		// focusout 回调里再套一层 setTimeout(0)，让同一失焦任务中的 change 监听器先执行，
		// 把地址、密钥或模型写入配置／钥匙串，随后清空才不丢刚提交的值。
		let fieldsRebuilt = false;
		const rebuildFields = (): void => {
			if (fieldsRebuilt || !fieldsHost.isConnected) return;
			fieldsRebuilt = true;
			fieldsHost.empty();
			renderProviderFields(
				app,
				plugin,
				fieldsHost,
				profile,
				providerId,
				catalog,
			);
		};
		if (!fieldsHost.contains(document.activeElement)) {
			rebuildFields();
			return;
		}
		const onFocusOut = (): void => {
			window.setTimeout(() => {
				// 焦点可能只是从一个字段移到区内另一个字段：仍在区内就继续等，监听不能用 once。
				if (fieldsRebuilt || !fieldsHost.isConnected) return;
				if (fieldsHost.contains(document.activeElement)) return;
				fieldsHost.removeEventListener("focusout", onFocusOut);
				rebuildFields();
			}, 0);
		};
		fieldsHost.addEventListener("focusout", onFocusOut);
	})();

	// 连接测试固定在窗口行之前;字段宿主异步重建不会碰到这一行。
	renderConnectionTestRow(app, detail, profile);
	renderProfileWindow(plugin, detail, profile);

	new Setting(detail)
		.setName(tNow("settings.chatProfiles.copyAction"))
		.setDesc(tNow("settings.chatProfiles.copyDesc"))
		.addButton((btn) => {
			btn.setButtonText(tNow("settings.chatProfiles.copyAction"));
			btn.onClick(() => {
				new TextPromptModal(
					app,
					tNow("settings.chatProfiles.copyPromptTitle"),
					tNow("settings.chatProfiles.createPromptPlaceholder"),
					tNow("settings.chatProfiles.copyName", {
						name: profile.name,
					}),
					async (name) => {
						// 关键路径:读取正在编辑的来源配置，不能借用当前激活配置的字段或密钥。
						const source = plugin.settings.chatProfiles.find(
							(item) => item.id === profile.id,
						);
						if (!source) {
							new Notice(
								tNow("settings.chatProfiles.sourceMissing"),
								3000,
							);
							return;
						}
						const key = resolveChatApiKey(app, {
							chatApiBase: source.apiBase,
							chatProfiles: plugin.settings.chatProfiles,
							activeChatProfileId: source.id,
						});
						const copied = copyChatProfile(
							plugin.settings,
							source.id,
							name,
						);
						if (!copied) return;
						if (key) setChatProfileSecret(app, copied, key);
						await plugin.saveSettings({
							refreshSettingsTab: false,
						});
						new Notice(
							tNow("settings.chatProfiles.copyDone"),
							3000,
						);
					},
				).open();
			});
		});
}

/**
 * 供应商一行：名称、状态描述与「选择」按钮，画进 rowHost。
 * catalog 三态：undefined＝名单加载中、null＝断网无名单、对象＝就绪（过期缓存也算）。
 * 只画这一行，resolve 后可随时原位重画，不触碰 fieldsHost 里用户正在填的字段。
 */
function renderProviderRow(
	host: HTMLElement,
	profile: ChatProfile,
	providerId: string,
	catalog: ModelsDevCatalog | null | undefined,
	onChooseProvider: () => void,
): void {
	const rows = catalog ? listCatalogProviders(catalog) : [];
	const unconfigured = !profile.apiBase && !profile.model;
	const state: ProviderListState =
		catalog === undefined
			? "loading"
			: catalog === null
				? "offline"
				: "ready";
	const control = resolveProviderControl(state);

	// 供应商行描述:未配置→引导选择;离线且已配置→推断名加离线说明;loading 不加错误句;ready→名单名
	let providerDesc: string;
	if (unconfigured) {
		providerDesc = tNow("settings.chatProfiles.provider.empty");
	} else if (state === "offline") {
		providerDesc =
			providerDisplayName(rows, providerId) +
			"\n" +
			tNow("settings.chatProfiles.provider.offlineHint");
	} else {
		providerDesc = providerDisplayName(rows, providerId);
	}

	const providerSetting = new Setting(host)
		.setName(tNow("settings.chatProfiles.provider.name"))
		.setDesc(providerDesc);
	providerSetting.addButton((btn) => {
		btn.setDisabled(control.disabled);
		if (control.spinning) {
			// setIcon('loader') 会清空按钮内已有的文本节点（Obsidian 运行时实证），
			// 转圈态必须先放 loader 图标、再补文字 span，子节点顺序为 [svg, span]，文字才留得住；
			// 另补 aria-label，保证按钮在图标之外仍有无障碍名。
			btn.setIcon("loader");
			btn.buttonEl.querySelector("svg")?.classList.add("ratel-spin");
			btn.buttonEl.createSpan({ text: tNow(control.buttonTextKey) });
			btn.buttonEl.setAttribute(
				"aria-label",
				tNow(control.buttonTextKey),
			);
		} else {
			// offline／ready 为纯文本按钮；rowHost 每次先 empty 再画，按钮是全新元素，不会残留图标。
			btn.setButtonText(tNow(control.buttonTextKey));
		}
		// 断网两态禁用点击，只有 ready 可进 picker。
		if (!control.disabled) btn.onClick(onChooseProvider);
	});
}

/**
 * 地址、密钥与模型字段，画进 fieldsHost。
 * catalog 三态语义同 renderProviderRow。有官方 api 的名单厂商地址只读、模型走下拉；
 * 空 api、本机项（custom／ollama）、名单查无此项与无名单态均可编辑地址并手填模型。
 */
function renderProviderFields(
	app: App,
	plugin: RatelVaultPlugin,
	host: HTMLElement,
	profile: ChatProfile,
	providerId: string,
	catalog: ModelsDevCatalog | null | undefined,
): void {
	const rows = catalog ? listCatalogProviders(catalog) : [];
	const listed = rows.find((row) => row.id === providerId);
	const editableBase =
		providerId === LOCAL_PROVIDER_OLLAMA ||
		providerId === LOCAL_PROVIDER_CUSTOM ||
		!listed ||
		listed.api === null;
	if (!editableBase && listed?.api) {
		new Setting(host)
			.setName(tNow("settings.chatProfiles.apiBase.name"))
			.setDesc(listed.api);
	} else if (editableBase) {
		const address = new Setting(host).setName(
			tNow("settings.chatProfiles.apiBase.name"),
		);
		// 名单里的供应商但没给 api：不要编造，也不要用 /v1 占位假装必须这样填。
		if (listed && listed.api === null) {
			address.setDesc(tNow("settings.chatProfiles.provider.noApi"));
		}
		address.addText((text) => {
			text.setPlaceholder(
				tNow("settings.chatProfiles.apiBase.placeholder"),
			);
			text.setValue(profile.apiBase);
			text.inputEl.addEventListener("change", () => {
				void (async () => {
					const trimmed = text.getValue().trim();
					if (!trimmed) return;
					profile.apiBase = trimmed;
					if (profileIsActive(plugin, profile)) {
						projectProfileToSettings(plugin.settings, profile);
						plugin.settings.chatPreset = inferChatProvider(
							profile.apiBase,
						);
						plugin.rebuildLLM();
					}
					await persistProfileEdit(plugin);
				})();
			});
		});
	}

	if (requiresChatApiKey({ chatApiBase: profile.apiBase })) {
		const savedKey = readChatProfileSecret(app, profile) ?? "";
		const label = chatProfileSecretId(profile);
		let revealed = false;
		const keySetting = new Setting(host)
			.setName(tNow("settings.chatProfiles.apiKey.name"))
			.setDesc(tNow("settings.chatProfiles.apiKey.desc", { label }));
		let keyInput: HTMLInputElement | undefined;
		keySetting.addText((text) => {
			keyInput = text.inputEl;
			text.inputEl.type = "password";
			text.setPlaceholder(
				tNow("settings.chatProfiles.apiKey.placeholder"),
			);
			if (savedKey) text.setValue(savedKey);
			text.inputEl.addEventListener("change", () => {
				const trimmed = text.getValue().trim();
				if (!trimmed) return;
				setChatProfileSecret(app, profile, trimmed);
				new Notice(tNow("settings.chatProfiles.apiKey.saved"), 3000);
			});
		});
		keySetting.addExtraButton((btn) => {
			btn.setIcon("eye");
			btn.setTooltip(tNow("settings.chatProfiles.apiKey.show"));
			btn.onClick(() => {
				if (!keyInput) return;
				revealed = !revealed;
				keyInput.type = revealed ? "text" : "password";
				btn.setIcon(revealed ? "eye-off" : "eye");
				btn.setTooltip(
					tNow(
						revealed
							? "settings.chatProfiles.apiKey.hide"
							: "settings.chatProfiles.apiKey.show",
					),
				);
			});
		});
	}

	const handOnly =
		providerId === LOCAL_PROVIDER_OLLAMA ||
		providerId === LOCAL_PROVIDER_CUSTOM ||
		!catalog;
	if (handOnly) {
		addModelText(plugin, host, profile, () =>
			refreshProfileWindow(plugin, host, profile),
		);
		return;
	}
	const modelIds = listCatalogModels(catalog, providerId);
	const picked = modelPickValue(modelIds, profile.model);
	new Setting(host)
		.setName(tNow("settings.chatProfiles.model.name"))
		.addDropdown((drop) => {
			const modelOptions: Record<string, string> = {};
			for (const id of modelIds) modelOptions[id] = id;
			modelOptions[CATALOG_MODEL_HAND] = tNow(
				"settings.chatProfiles.model.hand",
			);
			drop.addOptions(modelOptions);
			let armed = false;
			drop.setValue(picked);
			armed = true;
			drop.onChange(async (value) => {
				// 下拉初始化会回调一次。控件已经不在页面上时，也不能再写到别的套上。
				if (!armed || !host.isConnected || value === profile.model)
					return;
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
	const catalog = plugin.modelsDevCatalog
		? await plugin.modelsDevCatalog.ensureCatalog()
		: null;
	assignStoredProfileProvider(plugin.settings, profile, providerId, catalog);
	if (profileIsActive(plugin, profile)) {
		projectProfileToSettings(plugin.settings, profile);
		plugin.settings.chatPreset = inferChatProvider(profile.apiBase);
		plugin.rebuildLLM();
		await syncChatWindow(plugin.settings, { catalog, clearOnMiss: true });
	}
	await persistProfileEdit(plugin);
}

function providerDisplayName(
	rows: readonly CatalogProviderRow[],
	providerId: string,
): string {
	if (providerId === LOCAL_PROVIDER_OLLAMA)
		return tNow("settings.chatPreset.ollama");
	if (providerId === LOCAL_PROVIDER_CUSTOM)
		return tNow("settings.chatPreset.custom");
	return rows.find((row) => row.id === providerId)?.name || providerId;
}

/**
 * 选择供应商的一页：检索过滤，每行带接口地址和文档链接。
 */
function renderProviderPicker(
	root: HTMLElement,
	plugin: RatelVaultPlugin,
	profile: ChatProfile,
	actions: { onChoose: (providerId: string) => void },
): void {
	const currentId =
		profile.providerId || inferChatProvider(plugin.settings.chatApiBase);
	// 修复: 1.14 起 .setting-items 卡片自身不再有内边距,内边距下沉到每个 .setting-item;
	// 裸 <p> 会贴住卡片顶/左缘。用 Setting 行承载说明,两种内边距模型下都与其他行自动对齐。
	new Setting(root).setDesc(tNow("settings.chatProfiles.provider.intro"));
	const listHost = root.createDiv();
	const search = new Setting(root).setName(
		tNow("settings.chatProfiles.provider.searchPlaceholder"),
	);
	search.addText((text) => {
		text.setPlaceholder(
			tNow("settings.chatProfiles.provider.searchPlaceholder"),
		);
		text.inputEl.addEventListener("input", () => {
			void paint(text.getValue());
		});
	});
	// 检索框在列表上面
	root.insertBefore(search.settingEl, listHost);

	async function paint(query: string): Promise<void> {
		const catalog = plugin.modelsDevCatalog
			? await plugin.modelsDevCatalog.ensureCatalog()
			: null;
		if (!listHost.isConnected) return;
		const rows = catalog ? listCatalogProviders(catalog) : [];
		listHost.empty();
		if (!catalog) {
			// 同 intro:用 Setting 行承载离线提示,保证与其他行内边距一致。
			new Setting(listHost).setDesc(
				tNow("settings.chatProfiles.provider.offlinePicker"),
			);
		}
		const grouped = providerChoiceGroups(rows, query);
		renderProviderSection(
			listHost,
			tNow("settings.chatProfiles.provider.sectionLocal"),
			grouped.local,
			currentId,
			actions,
		);
		renderProviderSection(
			listHost,
			tNow(
				query.trim()
					? "settings.chatProfiles.provider.sectionMatch"
					: "settings.chatProfiles.provider.sectionCommon",
			),
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
		parent.createEl("h4", { text: title, cls: "ratel-provider-section" });
		for (const row of sectionRows) {
			const alias = providerSearchAlias(row.id);
			const setting = new Setting(parent).setName(
				alias ? `${row.name}（${alias}）` : row.name,
			);
			setting.settingEl.addClass("ratel-provider-pick");
			const desc = createFragment();
			desc.appendText(
				row.api ?? tNow("settings.chatProfiles.provider.noApi"),
			);
			if (row.doc) {
				desc.appendText(" · ");
				const link = desc.createEl("a", {
					text: tNow("settings.chatProfiles.provider.doc"),
					href: row.doc,
					attr: { target: "_blank", rel: "noopener noreferrer" },
				});
				link.addEventListener("click", (evt) => evt.stopPropagation());
			}
			setting.setDesc(desc);
			const current = row.id === selectedId;
			setting.addButton((btn) => {
				btn.setButtonText(
					tNow(
						current
							? "settings.chatProfiles.provider.current"
							: "settings.chatProfiles.provider.use",
					),
				);
				if (current) btn.setDisabled(true);
				btn.onClick(() => {
					if (!current) sectionActions.onChoose(row.id);
				});
			});
		}
	}

	void paint("");
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
		{
			id: LOCAL_PROVIDER_OLLAMA,
			name: tNow("settings.chatPreset.ollama"),
			api: null,
			doc: null,
		},
		{
			id: LOCAL_PROVIDER_CUSTOM,
			name: tNow("settings.chatPreset.custom"),
			api: null,
			doc: null,
		},
	].filter(
		(row) => !q || row.name.toLowerCase().includes(q) || row.id.includes(q),
	);
	return { local, catalog: filterCatalogProviders(rows, query) };
}

/** 手填框的包裹层。用标记避免「打开时加一个、再选手填又加一个」。 */
function handModelWrap(host: HTMLElement): HTMLElement | null {
	return host.querySelector(":scope > [data-hand-model]");
}

/** 保证最多一个手填框。 */
function showHandModel(
	host: HTMLElement,
	plugin: RatelVaultPlugin,
	profile: ChatProfile,
): void {
	if (handModelWrap(host)) return;
	const wrap = host.createDiv();
	wrap.dataset.handModel = "1";
	addModelText(plugin, wrap, profile, () =>
		refreshProfileWindow(plugin, host, profile),
	);
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
	// 字段现在嵌在 fieldsHost＞providerHost 内，不能再用 parentElement，沿详情根类名找回。
	const detail = host.closest<HTMLElement>(".ratel-chat-profile-detail");
	if (!detail) return;
	detail.querySelector(":scope > [data-profile-window]")?.remove();
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
		.setName(tNow("settings.chatProfiles.model.name"))
		.setDesc(tNow("settings.chatProfiles.model.handDesc"))
		.addText((text) => {
			text.setValue(profile.model);
			text.inputEl.addEventListener("change", () => {
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
 * 连接测试一行:按钮发起最小请求,结果(成功耗时 / 分类错误原因 + 排查建议)行内反馈。
 *
 * 关键路径:测试读取的 profile 字段都是 change 即落盘的值;等待返回期间页面若整体重绘,
 * 旧行脱离 DOM 后不再写回,避免结果写到已销毁节点。
 */
function renderConnectionTestRow(
	app: App,
	detail: HTMLElement,
	profile: ChatProfile,
): void {
	const setting = new Setting(detail)
		.setName(tNow("settings.chatProfiles.connection.name"))
		.setDesc(tNow("settings.chatProfiles.connection.hint"));
	setting.addButton((btn) => {
		btn.setButtonText(tNow("settings.chatProfiles.connection.button"));
		btn.onClick(() => void runTest(btn));
	});

	async function runTest(btn: ButtonComponent): Promise<void> {
		// 测试中:复用 loading 按钮形态(先 icon 后补文字,避免 setIcon 吞掉文本节点)。
		btn.setDisabled(true);
		btn.setIcon("loader");
		btn.buttonEl.querySelector("svg")?.classList.add("ratel-spin");
		btn.buttonEl.createSpan({
			text: tNow("settings.chatProfiles.connection.testing"),
		});
		btn.buttonEl.setAttribute(
			"aria-label",
			tNow("settings.chatProfiles.connection.testing"),
		);
		setting.setDesc(tNow("settings.chatProfiles.connection.testing"));

		const result = await runConnectionTest(app, profile);
		if (!setting.settingEl.isConnected) return;

		btn.setDisabled(false);
		// 恢复为纯文本按钮:显式清掉 loader 节点,再放回文字。
		btn.buttonEl.empty();
		btn.setButtonText(tNow("settings.chatProfiles.connection.button"));

		setting.descEl.empty();
		if (result.ok) {
			const okRow = setting.descEl.createDiv({ cls: "ratel-conn-ok" });
			setIcon(okRow.createSpan(), "check");
			okRow.createSpan({
				text: tNow("settings.chatProfiles.connection.ok", {
					ms: result.elapsedMs,
				}),
			});
			return;
		}
		const fail = setting.descEl.createDiv({ cls: "ratel-conn-fail" });
		const head = fail.createDiv();
		setIcon(head.createSpan(), "alert-triangle");
		// 错误类型标签复用诊断页 i18n,动态 key 限定为已知五分类。
		const typeKey = `diag.errorType.${result.error.type}` as StringKey;
		head.createSpan({ text: `${tNow(typeKey)}: ${result.error.message}` });
		if (result.error.cause) {
			fail.createDiv({ cls: "ratel-conn-sub", text: result.error.cause });
		}
		if (result.error.suggestion) {
			fail.createDiv({
				cls: "ratel-conn-sub",
				text: result.error.suggestion,
			});
		}
	}
}

/**
 * 渲染上下文窗口一行(当前套展开区末行)。
 *
 * 四种情形:
 * - windowUserSet:用户改小过 — 「此配置的上限是 N」+ 数字框;
 * - 查表命中 — 「这个模型的窗口是 N」+「改得更小」按钮(不出现档位下拉);
 * - 断网无名单 — 离线说明 + 数字框,可先手填,联网后自动校正;
 * - 名单无此模型 — 按供应商文档填写的说明 + 数字框。
 */
function renderProfileWindow(
	plugin: RatelVaultPlugin,
	detail: HTMLElement,
	profile: ChatProfile,
): void {
	const setting = new Setting(detail).setName(
		tNow("settings.chatProfiles.window.heading"),
	);
	setting.settingEl.dataset.profileWindow = "1";
	const active = profileIsActive(plugin, profile);
	const windowTokens = active
		? plugin.settings.chatModelMaxTokens
		: profile.chatModelMaxTokens;

	if (profile.windowUserSet) {
		const baseDesc =
			tNow("settings.chatProfiles.window.userSet", {
				tokens: windowTokens.toLocaleString(),
			}) +
			"\n" +
			tNow("settings.chatProfiles.window.userSetHint");
		setting.setDesc(baseDesc);
		addWindowNumberInput(setting, plugin, profile);
		if (!active) return;
		void (async () => {
			const catalog = plugin.modelsDevCatalog
				? await plugin.modelsDevCatalog.ensureCatalog()
				: null;
			const result = await syncChatWindow(plugin.settings, {
				catalog,
				clearOnMiss: false,
			});
			if (!setting.settingEl.isConnected || !result.output) return;
			setting.setDesc(
				baseDesc +
					"\n" +
					tNow("settings.chatProfiles.window.output", {
						tokens: result.output.toLocaleString(),
					}),
			);
		})();
		return;
	}

	// 查表是异步的:先渲染 loading,结果回来后原位补 desc 与控件
	setting.setDesc(tNow("settings.chatProfiles.window.loading"));
	void (async () => {
		const catalog = plugin.modelsDevCatalog
			? await plugin.modelsDevCatalog.ensureCatalog()
			: null;
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
				tNow("settings.chatProfiles.window.found", {
					tokens: found.toLocaleString(),
				}) +
				"\n" +
				tNow("settings.chatProfiles.window.foundHint");
			if (result.output) {
				desc +=
					"\n" +
					tNow("settings.chatProfiles.window.output", {
						tokens: result.output.toLocaleString(),
					});
			}
			setting.setDesc(desc);
			setting.addButton((btn) => {
				btn.setButtonText(tNow("settings.chatProfiles.window.shrink"));
				btn.onClick(async () => {
					await applySettingValue(
						plugin,
						"chatModelMaxTokens",
						Math.floor(found / 2),
					);
					await persistProfileEdit(plugin);
				});
			});
		} else {
			// 断网(catalog=null)与名单无此模型是两回事:各自给说明,数字框都保留
			setting.setDesc(
				catalog
					? tNow("settings.chatProfiles.window.unknown", {
							model: plugin.settings.chatModel,
						})
					: tNow("settings.chatProfiles.window.offline"),
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
 * @param catalog - 已加载名单;null 表示断网无名单
 */
function paintStoredWindow(
	setting: Setting,
	plugin: RatelVaultPlugin,
	profile: ChatProfile,
	catalog: ModelsDevCatalog | null,
): void {
	if (!setting.settingEl.isConnected) return;
	const found = catalog
		? lookupCatalogLimits(
				catalog,
				profile.providerId || "custom",
				profile.model,
			)
		: undefined;
	if (found) {
		let desc =
			tNow("settings.chatProfiles.window.found", {
				tokens: found.context.toLocaleString(),
			}) +
			"\n" +
			tNow("settings.chatProfiles.window.foundHint");
		if (found.output > 0) {
			desc +=
				"\n" +
				tNow("settings.chatProfiles.window.output", {
					tokens: found.output.toLocaleString(),
				});
		}
		setting.setDesc(desc);
		setting.addButton((btn) => {
			btn.setButtonText(tNow("settings.chatProfiles.window.shrink"));
			btn.onClick(async () => {
				writeStoredProfileWindow(
					profile,
					Math.floor(found.context / 2),
					true,
				);
				await persistProfileEdit(plugin);
			});
		});
		return;
	}
	// 断网与名单无此模型分开提示,数字框都保留
	setting.setDesc(
		catalog
			? tNow("settings.chatProfiles.window.unknown", {
					model: profile.model,
				})
			: tNow("settings.chatProfiles.window.offline"),
	);
	addWindowNumberInput(setting, plugin, profile);
}

/** 窗口数字框 — min/max 与旧高级页一致,写入走 chatModelMaxTokens 分支(含大于查到值的钳制) */
function addWindowNumberInput(
	setting: Setting,
	plugin: RatelVaultPlugin,
	profile: ChatProfile,
): void {
	setting.addText((text) => {
		text.inputEl.type = "number";
		text.inputEl.min = String(CUSTOM_TOKEN_MIN);
		text.inputEl.max = String(CUSTOM_TOKEN_MAX);
		// 关键路径:查不到时可能已被清成 0,预填空而非 0,引导用户填写
		const active = profileIsActive(plugin, profile);
		const current = active
			? plugin.settings.chatModelMaxTokens
			: profile.chatModelMaxTokens;
		if (current > 0) {
			text.setValue(String(current));
		}
		text.inputEl.addEventListener("change", () => {
			void (async () => {
				const n = Number.parseInt(text.getValue(), 10);
				if (!Number.isFinite(n) || n <= 0) return;
				if (profileIsActive(plugin, profile)) {
					await applySettingValue(plugin, "chatModelMaxTokens", n);
				} else {
					writeStoredProfileWindow(profile, n, true);
				}
				await persistProfileEdit(plugin);
			})();
		});
	});
}
