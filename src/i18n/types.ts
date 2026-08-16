/**
 * @file src/i18n/types.ts
 * @description i18n 翻译表类型 — 开放式 namespace 扩展
 * @module i18n/types
 */

// ==================== 基础(框架通用) ====================
export interface BaseStrings {
  'common.ok': string;
  'common.cancel': string;
  'common.confirm': string;
  'common.delete': string;
  'common.error': string;
  'common.warning': string;
  'common.success': string;
  'common.retry': string;
  'common.close': string;
  'common.docs': string;
}

// ==================== Settings 面板 ====================
export interface SettingsStrings {
  'settings.language.heading': string;
  'settings.language.name': string;
  'settings.language.desc': string;
  'settings.language.option.auto': string;
  'settings.language.option.zh': string;
  'settings.language.option.en': string;
  'settings.tabs.strip': string;
  'settings.tabs.chat': string;
  'settings.tabs.index': string;
  'settings.tabs.agent': string;
  'settings.tabs.appearance': string;
  'settings.tabs.advanced': string;
  'settings.appearance.heading': string;
  'settings.appearance.previewLabel': string;
  'settings.appearance.scheme.name': string;
  'settings.appearance.scheme.auto': string;
  'settings.appearance.scheme.light': string;
  'settings.appearance.scheme.dark': string;
  'settings.appearance.accent.name': string;
  'settings.appearance.accent.follow': string;
  'settings.appearance.accent.copper': string;
  'settings.appearance.accent.red': string;
  'settings.appearance.accent.purple': string;
  'settings.appearance.accent.indigo': string;
  'settings.appearance.accent.blue': string;
  'settings.appearance.accent.teal': string;
  'settings.appearance.accent.green': string;
  'settings.appearance.accent.orange': string;
  'settings.appearance.accent.pink': string;
  'settings.appearance.hint': string;
  'settings.appearance.saveFailed': string;
  'settings.appearance.status.followScheme': string;
  'settings.appearance.status.light': string;
  'settings.appearance.status.dark': string;
  'settings.appearance.preview.body': string;
  'settings.appearance.preview.citePath': string;
  'settings.appearance.preview.send': string;
  'settings.chatNavRailEnabled.name': string;
  'settings.chatNavRailEnabled.desc': string;
  'settings.chatMotionEnabled.name': string;
  'settings.chatMotionEnabled.desc': string;
  'settings.chatNavRailSide.name': string;
  'settings.chatNavRailSide.desc': string;
  'settings.chatNavRailSide.left': string;
  'settings.chatNavRailSide.right': string;
  'settings.chatPreset.heading': string;
  'settings.chatPreset.name': string;
  'settings.chatPreset.desc': string;
  'settings.chatPreset.deepseek': string;
  'settings.chatPreset.ollama': string;
  'settings.chatPreset.custom': string;
  'settings.chatModel.heading': string;
  'settings.chatModel.model.name': string;
  'settings.chatModel.model.desc': string;
  'settings.chatModel.apiBase.name': string;
  'settings.chatModel.apiBase.desc': string;
  'settings.contextLength.heading': string;
  'settings.contextLength.dropdown.name': string;
  'settings.contextLength.dropdown.desc': string;
  'settings.contextLength.probeButton': string;
  'settings.contextLength.probeLoading': string;
  'settings.contextLength.customTokens.name': string;
  'settings.contextLength.customTokens.desc': string;
  'settings.contextLength.preset.custom': string;
  'settings.contextLength.preset.default': string;
  'settings.advanced.heading': string;
  'settings.advanced.registryUrl.name': string;
  'settings.advanced.registryUrl.desc': string;
  'settings.advanced.resetButton': string;
  'settings.advanced.secretHint.title': string;
  'settings.advanced.secretHint.configured': string;
  'settings.advanced.secretHint.notConfigured': string;
  'settings.advanced.secretHint.copyTooltip': string;
  'settings.advanced.secretHint.localOllama': string;
  'settings.advanced.secretHint.privacy': string;
  'settings.advanced.secretHint.stepOpen': string;
  'settings.advanced.secretHint.stepAddPrefix': string;
  'settings.advanced.secretHint.stepAddSuffix': string;
  'settings.embedding.heading': string;
  'settings.embedding.provider.name': string;
  'settings.embedding.provider.desc': string;
  'settings.embedding.provider.option.local': string;
  'settings.embedding.provider.option.api': string;
  'settings.embedding.localModel.name': string;
  'settings.embedding.localModel.desc': string;
  'settings.embedding.localDimensions.name': string;
  'settings.embedding.localOllama': string;
  'settings.embedding.apiBase.name': string;
  'settings.embedding.apiModel.name': string;
  'settings.embedding.apiDimensions.name': string;
  'settings.reranker.heading': string;
  'settings.reranker.apiBase.name': string;
  'settings.reranker.model.name': string;
  'settings.reranker.secretHint.note': string;
  'settings.reranker.secretHint.localOllama': string;
  'settings.indexing.heading': string;
  'settings.indexing.chunkSize.name': string;
  'settings.indexing.chunkOverlap.name': string;
  'settings.indexing.autoIndex.name': string;
  'settings.indexing.autoIndex.desc': string;
  'settings.autoCompactEnabled.name': string;
  'settings.autoCompactEnabled.desc': string;
  'settings.developer.heading': string;
  'settings.developer.debugLog.name': string;
  'settings.developer.agentMaxSteps.name': string;
  'settings.developer.agentMaxSteps.desc': string;
  'settings.developer.trustMode.name': string;
  'settings.developer.trustMode.desc': string;
  'settings.toolPermissionLevel.name': string;
  'settings.toolPermissionLevel.desc': string;
  'settings.toolPermissionLevel.safe': string;
  'settings.toolPermissionLevel.auto': string;
  'settings.toolPermissionLevel.danger': string;
  'settings.daily.heading': string;
  'settings.daily.folder.name': string;
  'settings.daily.folder.desc': string;
  'settings.daily.format.name': string;
  'settings.daily.format.desc': string;
  'settings.toolPermissions.heading': string;
  'settings.toolPermissions.mcpSection': string;
  'settings.mcp.openManage': string;
  'settings.mcp.openManage.desc': string;
  'settings.toolPermissions.search_vault': string;
  'settings.toolPermissions.read_note': string;
  'settings.toolPermissions.grep': string;
  'settings.toolPermissions.glob': string;
  'settings.toolPermissions.list_files': string;
  'settings.toolPermissions.write_note': string;
  'settings.toolPermissions.append_note': string;
  'settings.toolPermissions.edit_note': string;
  'settings.toolPermissions.delete_note': string;
  // 关键路径:3 个 memory 工具的权限面板友好名
  'settings.toolPermissions.search_memory': string;
  'settings.toolPermissions.remember': string;
  'settings.toolPermissions.forget_memory': string;
  'settings.toolPermissions.activate_skill': string;
  'settings.toolPermissions.deactivate_skill': string;
  'settings.toolPermissions.get_datetime': string;
  'settings.toolPermissions.get_active_note': string;
  'settings.toolPermissions.get_daily_note': string;
  'settings.toolPermissions.list_recent_notes': string;
  'settings.toolPermissions.get_note_outline': string;
  'settings.toolPermissions.get_links': string;
  'settings.toolPermissions.search_by_tag': string;
  'settings.toolPermissions.search_by_property': string;
  'settings.toolPermissions.get_vault_structure': string;
  'settings.toolPermissions.open_note': string;
  'settings.toolPermissions.open_settings': string;
  'settings.toolPermissions.get_app_config': string;
  'settings.toolPermissions.update_app_config': string;
  'settings.toolPermissions.allow': string;
  'settings.toolPermissions.ask': string;
  'settings.toolPermissions.deny': string;
  'settings.promptOverrides.heading': string;
  'settings.promptOverrides.useCustom': string;
  'settings.promptOverrides.resetButton': string;
  'settings.promptOverrides.placeholderHint': string;
  'settings.promptOverrides.missingPlaceholder': string;
  'settings.promptOverrides.previewButton': string;
  'settings.promptOverrides.previewModal.title': string;
  'settings.promptOverrides.instructions': string;
  'settings.promptOverrides.instructionsDesc': string;
  'settings.promptOverrides.previewDesc': string;
  'settings.diagnostics.page.name': string;
  'settings.diagnostics.page.desc': string;
  'settings.diagnostics.intro': string;
  'settings.diagnostics.tab.embedding': string;
  'settings.diagnostics.tab.llm': string;
  'settings.diagnostics.tab.rerank': string;
  'settings.notice.noChatKey': string;
  'settings.notice.probeFailed': string;
  'settings.notice.probeSuccess': string;
  'settings.notice.probeNoRecommendation': string;
  'settings.notice.invalidTokens': string;
}

// ==================== Chat UI ====================
export interface ChatStrings {
  'chat.header.title': string;
  'chat.header.tagline': string;
  'chat.header.modelChip': string;
  'chat.empty.welcome': string;
  'chat.empty.hint': string;
  'chat.empty.hint.1': string;
  'chat.empty.hint.2': string;
  'chat.empty.hint.3': string;
  'chat.feedback.title': string;
  'chat.feedback.body': string;
  'chat.feedback.copyDiag': string;
  'chat.feedback.openIssues': string;
  'chat.feedback.copyOk': string;
  'chat.feedback.copyFail': string;
  'chat.workbar.indexing': string;
  'chat.workbar.downloading': string;
  'chat.workbar.preparing': string;
  'chat.workbar.searching': string;
  'chat.workbar.compacting': string;
  'chat.typing': string;
  'orb.state.working': string;
  'orb.state.searching': string;
  'orb.state.solving': string;
  'orb.state.listening': string;
  'orb.state.connecting': string;
  'orb.state.weaving': string;
  'orb.state.composing': string;
  'orb.state.breathing': string;
  'orb.state.shaping': string;
  'chat.input.placeholder': string;
  'chat.input.send': string;
  'chat.input.stop': string;
  'chat.input.addImage': string;
  'chat.perm.safe': string;
  'chat.perm.auto': string;
  'chat.perm.danger': string;
  'chat.perm.aria': string;
  'chat.composer.permHint.safe': string;
  'chat.composer.permHint.auto': string;
  'chat.composer.permHint.danger': string;
  'chat.composer.send': string;
  'chat.composer.stop': string;
  'chat.gate.noChatKey': string;
  'chat.gate.searchUnavailable': string;
  'chat.error.stopped': string;
  'chat.error.compactFailed': string;
  'chat.error.attachmentInvalid': string;
  'chat.thinking': string;
  'chat.thinking.done': string;
  'chat.tool.executing': string;
  'chat.tool.params': string;
  'chat.tool.result': string;
  'chat.tool.noResult': string;
  'chat.tool.found': string;
  'chat.tool.failed': string;
  /** get_links 等图类工具的折叠 meta 短标签 */
  'chat.tool.meta.graph': string;
  'chat.tool.detail.listingFiles': string;
  'chat.tool.detail.listingFolders': string;
  'chat.tool.detail.listingBoth': string;
  'chat.tool.detail.listingEmpty': string;
  'chat.tool.detail.hitsFound': string;
  'chat.tool.detail.snippetChars': string;
  'chat.tool.detail.linksFor': string;
  'chat.tool.detail.path': string;
  'chat.tool.detail.bullet': string;
  'chat.tool.detail.more': string;
  'chat.tool.detail.query': string;
  'chat.tool.detail.topK': string;
  'chat.tool.detail.hitsReranked': string;
  'chat.tool.detail.outgoing': string;
  'chat.tool.detail.backlinks': string;
  'chat.tool.detail.unresolved': string;
  'chat.tool.detail.matches': string;
  'chat.tool.detail.pattern': string;
  'chat.tool.detail.glob': string;
  'chat.tool.detail.orphans': string;
  'chat.tool.detail.tag': string;
  'chat.tool.detail.property': string;
  'chat.tool.detail.kv': string;
  'chat.search.title': string;
  'chat.search.rerankBadge': string;
  'chat.search.rerankHint': string;
  'chat.cite.openNote': string;
  'chat.cite.openFailed': string;
  'chat.cite.sourcesCollapsed': string;
  'chat.cite.sourcesExpandAria': string;
  'chat.cite.sourcesCollapseAria': string;
  'chat.md.copy': string;
  'chat.md.copied': string;
  'chat.md.mermaidFailed': string;
  'chat.tool.mcpBadge': string;
  'chat.session.loading': string;
  'chat.session.loadingNew': string;
  'chat.session.menuRecent': string;
  'chat.session.new': string;
  'chat.session.delete': string;
  'chat.session.rename': string;
  'chat.session.retitle': string;
  'chat.session.renameTitle': string;
  'chat.session.renamePlaceholder': string;
  'chat.session.renameField': string;
  'chat.session.renameSave': string;
  'chat.session.renameCancel': string;
  'chat.session.retitleOk': string;
  'chat.session.retitleFail': string;
  'chat.session.retitleEmpty': string;
  'chat.session.switchWhileRunningTitle': string;
  'chat.session.switchWhileRunningBody': string;
  'chat.session.switchAbortConfirm': string;
  'chat.session.switchAbortCancel': string;
  'chat.session.ariaHistory': string;
  'chat.session.ariaChip': string;
  'chat.session.emptyTitle': string;
  'chat.session.loadFailed': string;
  'chat.session.noteMissing': string;
  'chat.attachments.deleteAria': string;
  'chat.attachments.invalidType': string;
  'chat.attachments.tooLarge': string;
  'chat.attachments.tooMany': string;
  'chat.nav.rail.aria': string;
  'chat.nav.backToBottom': string;
  'chat.nav.tick.aria': string;
  'chat.slashMenu.header': string;
  'chat.mention.menuTitle': string;
  'chat.mention.empty': string;
  'chat.mention.fileMenu': string;
  'chat.mention.stripAria': string;
  'chat.mention.removeAria': string;
  'chat.mention.absoluteRejected': string;
  'chat.compact.running': string;
  'chat.compact.done': string;
  'chat.compact.failed': string;
  'chat.compact.tooShort': string;
  'chat.compacted': string;
  'chat.modelInfo.title': string;
  'chat.modelInfo.openSettings': string;
  'chat.modelInfo.notConfigured': string;
  'chat.modelInfo.defaultLocal': string;
  'chat.modelInfo.default': string;
  'chat.modelInfo.chatModel': string;
  'chat.modelInfo.chatBaseUrl': string;
  'chat.modelInfo.embedModel': string;
  'chat.modelInfo.contextLength': string;
  'chat.modelInfo.rerank': string;
  'chat.modelInfo.rerankConfigured': string;
  'chat.modelInfo.rerankNotConfigured': string;
}

// ==================== Tool display names(UI 友好名) ====================
export interface ToolNameStrings {
  'tool.name.read_note': string;
  'tool.name.search_vault': string;
  'tool.name.list_files': string;
  'tool.name.write_note': string;
  'tool.name.edit_note': string;
  'tool.name.delete_note': string;
  'tool.name.append_note': string;
  'tool.name.grep': string;
  'tool.name.glob': string;
  'tool.name.search_memory': string;
  'tool.name.remember': string;
  'tool.name.forget_memory': string;
  'tool.name.get_datetime': string;
  'tool.name.get_active_note': string;
  'tool.name.get_daily_note': string;
  'tool.name.list_recent_notes': string;
  'tool.name.get_note_outline': string;
  'tool.name.get_links': string;
  'tool.name.search_by_tag': string;
  'tool.name.search_by_property': string;
  'tool.name.get_vault_structure': string;
  'tool.name.open_note': string;
  'tool.name.open_settings': string;
  'tool.name.get_app_config': string;
  'tool.name.update_app_config': string;
  'tool.name.mcp': string;
}

// ==================== Slash commands ====================
export interface SlashStrings {
  'slash.new.description': string;
  'slash.compact.description': string;
  'slash.model.description': string;
  'slash.reindex.description': string;
}

// ==================== Notices(Toast 消息) ====================
export interface NoticeStrings {
  'notice.indexStatus': string;
  'notice.indexNotReady': string;
  'notice.indexPaused': string;
  'notice.indexResumed': string;
  'notice.indexProgress': string;
  'notice.indexError': string;
  'notice.modelDownloading': string;
  'notice.modelInit': string;
  'notice.modelLoadFailed': string;
  'notice.indexFailed': string;
  'notice.ratelError': string;
  'notice.deleteIndexTitle': string;
  'notice.deleteIndexDesc': string;
  'notice.confirmDelete': string;
  'notice.rebuildIndexTitle': string;
  'notice.rebuildIndexDesc': string;
  'notice.confirmRebuild': string;
  'notice.toolRejected': string;
  'notice.toolRejectedDisabled': string;
  'notice.operationFailed': string;
  // 关键路径:记忆系统操作反馈(用户可见 Toast)
  'notice.memory.saved': string;
  'notice.memory.forgotten': string;
  'notice.memory.topicCreated': string;
  'notice.memory.topicRemoved': string;
  'notice.memory.truncated': string;
}

// ==================== Modals(确认/信息模态框) ====================
export interface ModalStrings {
  'modal.rebuildIndex.title': string;
  'modal.rebuildIndex.confirmQuestion': string;
  'modal.rebuildIndex.confirmDesc': string;
  'modal.rebuildIndex.cancel': string;
  'modal.rebuildIndex.confirm': string;
  'modal.dropIndex.title': string;
  'modal.dropIndex.confirmQuestion': string;
  'modal.dropIndex.confirmDesc': string;
  'modal.dropIndex.inputPrompt': string;
  'modal.dropIndex.confirmWord': string;
  'modal.dropIndex.cancel': string;
  'modal.dropIndex.confirm': string;
  'modal.toolConfirm.title': string;
  'modal.toolConfirm.allow': string;
  'modal.toolConfirm.allowSession': string;
  'modal.toolConfirm.deny': string;
  'modal.operationFailed': string;
  'modal.mcpManage.title': string;
  'modal.mcpManage.installedHeading': string;
  'modal.mcpManage.empty': string;
  'modal.mcpManage.emptyHint': string;
  'modal.mcpManage.addSection': string;
  'modal.mcpManage.addSectionHint': string;
  'modal.mcpManage.addHttp': string;
  'modal.mcpManage.addStdio': string;
  'modal.mcpManage.importJson': string;
  'modal.mcpManage.importJsonHint': string;
  'modal.mcpManage.import': string;
  'modal.mcpManage.importOk': string;
  'modal.mcpManage.importDupSkipped': string;
  'modal.mcpManage.importSkipped': string;
  'modal.mcpManage.importEnvHint': string;
  'modal.mcpManage.edit': string;
  'modal.mcpManage.editHeading': string;
  'modal.mcpManage.editIdLocked': string;
  'modal.mcpManage.stdioSplitHint': string;
  'modal.mcpManage.refresh': string;
  'modal.mcpManage.refreshing': string;
  'modal.mcpManage.refreshOk': string;
  'modal.mcpManage.refreshFail': string;
  'modal.mcpManage.backToList': string;
  'modal.mcpManage.delete': string;
  'modal.mcpManage.enabled': string;
  'modal.mcpManage.id': string;
  'modal.mcpManage.label': string;
  'modal.mcpManage.url': string;
  'modal.mcpManage.command': string;
  'modal.mcpManage.args': string;
  'modal.mcpManage.save': string;
  'modal.mcpManage.cancel': string;
  'modal.mcpManage.secretHint': string;
  'modal.mcpManage.toolsCount': string;
  'modal.mcpManage.toolsNone': string;
  'modal.mcpManage.toolsList': string;
  'modal.mcpManage.status.offline': string;
  'modal.mcpManage.status.connecting': string;
  'modal.mcpManage.status.online': string;
  'modal.mcpManage.status.error': string;
  'modal.mcpManage.error.invalid_id': string;
  'modal.mcpManage.error.missing_url': string;
  'modal.mcpManage.error.missing_command': string;
  'modal.mcpManage.error.duplicate_id': string;
  'modal.mcpManage.error.invalid_json': string;
  'modal.mcpManage.error.no_servers': string;
  'modal.mcpManage.error.all_duplicate': string;
  'modal.mcpManage.error.not_found': string;
  'modal.mcpSpawn.title': string;
  'modal.mcpSpawn.body': string;
  'modal.mcpSpawn.confirm': string;
  'modal.mcpSpawn.cancel': string;
}

// ==================== Status / Drawer ====================
export interface StatusStrings {
  'status.index.indexing': string;
  'status.index.requestFailed': string;
  'status.index.notConfigured': string;
  'status.index.thinking': string;
  'status.index.ready': string;
  'status.drawer.expand': string;
  'status.drawer.collapse': string;
  'status.drawer.tooltip': string;
  'status.drawer.section.index': string;
  'status.drawer.label.index': string;
  'status.drawer.label.currentFile': string;
  'status.drawer.label.embedding': string;
  'status.drawer.label.embedKind': string;
  'status.drawer.embedKind.local': string;
  'status.drawer.embedKind.api': string;
  'status.drawer.section.context': string;
  'status.drawer.label.usedMax': string;
  'status.drawer.usedMaxValue': string;
  'status.drawer.compactButton': string;
  'status.drawer.docCount': string;
  'status.drawer.feedback': string;
  'status.drawer.memory': string;
  'status.drawer.sponsor': string;
  'status.drawer.mcp': string;
  'status.indexLabel.ready': string;
  'status.indexLabel.scanning': string;
  'status.indexLabel.queued': string;
  'status.indexLabel.processing': string;
  'status.indexLabel.paused': string;
  'status.indexLabel.failed': string;
  'status.indexLabel.initializing': string;
  'status.indexLabel.checkingChanges': string;
  'status.indexLabel.idle': string;
  'status.indexLabel.unknown': string;
  'status.embedding.ready': string;
  'status.embedding.loading': string;
  'status.embedding.notConfigured': string;
  'status.embedding.unknown': string;
  'status.degraded.apiEmbedding': string;
  'status.detail.checkingChanges': string;
  'status.detail.pending': string;
}

// ==================== Diagnostics 子页面 ====================
export interface DiagnosticsStrings {
  'diag.intro': string;
  'diag.errorType.config': string;
  'diag.errorType.network': string;
  'diag.errorType.model': string;
  'diag.errorType.runtime': string;
  'diag.errorType.unknown': string;
  'diag.errorMeta.possibleCauses': string;
  'diag.errorMeta.troubleshoot': string;
  'diag.errorMeta.details': string;
  'diag.executing': string;
  // 通用诊断文案
  'diag.errorUnknown': string;
  'diag.errorUnserializable': string;
  'diag.errorInputValidation': string;
  'diag.configSummary': string;
  'diag.configLocalOnnx': string;
  'diag.configApi': string;
  'diag.statusReady': string;
  'diag.statusLoading': string;
  'diag.configured': string;
  'diag.notConfiguredKey': string;
  'diag.localServiceNoKey': string;
  // 错误分类 cause
  'diag.errorCause.modelNotLoaded': string;
  'diag.errorCause.invalidKey': string;
  'diag.errorCause.modelNotFound': string;
  'diag.errorCause.networkFailed': string;
  'diag.errorCause.localModelFailed': string;
  'diag.errorCause.badRequest': string;
  'diag.errorCause.rateLimit': string;
  // 错误分类 suggestion
  'diag.errorSuggestion.modelNotLoaded': string;
  'diag.errorSuggestion.invalidKey': string;
  'diag.errorSuggestion.modelNotFound': string;
  'diag.errorSuggestion.networkFailed': string;
  'diag.errorSuggestion.localModelFailed': string;
  'diag.errorSuggestion.badRequest': string;
  'diag.errorSuggestion.rateLimit': string;
  // Embedding 测试
  'diag.embedding.section1': string;
  'diag.embedding.hint': string;
  'diag.embedding.searchButton': string;
  'diag.embedding.noChunks': string;
  'diag.embedding.indexReadFailed': string;
  'diag.embedding.section2': string;
  'diag.embedding.calcButton': string;
  'diag.embedding.oppositeLabel': string;
  'diag.embedding.unrelatedLabel': string;
  'diag.embedding.identicalLabel': string;
  'diag.embedding.queryPlaceholder': string;
  'diag.embedding.loading': string;
  'diag.embedding.readFailed': string;
  'diag.embedding.searchFailed': string;
  'diag.embedding.similarityFailed': string;
  'diag.embedding.searchResultTitle': string;
  'diag.embedding.searchHint': string;
  'diag.embedding.similarityResultTitle': string;
  'diag.embedding.similarityHint': string;
  'diag.embedding.textA': string;
  'diag.embedding.textB': string;
  'diag.embedding.textAPh': string;
  'diag.embedding.textBPh': string;
  'diag.embedding.cosineResult': string;
  'diag.embedding.errorEmptyQuery': string;
  'diag.embedding.errorEmptyTextPair': string;
  'diag.embedding.errorNoVectra': string;
  'diag.embedding.indexEmptyWarn': string;
  'diag.embedding.indexReadFailedWarn': string;
  'diag.embedding.emptyResult': string;
  'diag.embedding.searchStats': string;
  'diag.embedding.indexLoading': string;
  'diag.embedding.indexStatus': string;
  'diag.embedding.indexReadFailedStatus': string;
  'diag.embedding.configLocalDetail': string;
  'diag.embedding.configApiDetail': string;
  'diag.embedding.errorNotInit': string;
  'diag.embedding.errorModelNotReady': string;
  // LLM 测试
  'diag.llm.systemPromptLabel': string;
  'diag.llm.userMessageLabel': string;
  'diag.llm.paramsLabel': string;
  'diag.llm.send': string;
  'diag.llm.stop': string;
  'diag.llm.clear': string;
  'diag.llm.statusRunning': string;
  'diag.llm.statusDone': string;
  'diag.llm.statusStopped': string;
  'diag.llm.errorEmptyMessage': string;
  'diag.llm.errorNoKey': string;
  'diag.llm.requestFailed': string;
  'diag.llm.systemPromptPh': string;
  'diag.llm.userMessagePh': string;
  'diag.llm.tempHint': string;
  'diag.llm.maxTokensPlaceholder': string;
  'diag.llm.sendHint': string;
  'diag.llm.generating': string;
  'diag.llm.warn': string;
  'diag.llm.errorNoKeyWarn': string;
  'diag.llm.statusMeta': string;
  'diag.llm.statusStoppedFull': string;
  'diag.llm.configSummary': string;
  'diag.llm.configDetail': string;
  // Rerank 测试
  'diag.rerank.notConfigured': string;
  'diag.rerank.statusConfigured': string;
  'diag.rerank.queryLabel': string;
  'diag.rerank.testButton': string;
  'diag.rerank.queryDesc': string;
  'diag.rerank.candidatesPh': string;
  'diag.rerank.testing': string;
  'diag.rerank.errorEmptyQuery': string;
  'diag.rerank.errorNoKey': string;
  'diag.rerank.noResult': string;
  'diag.rerank.testFailed': string;
}

// ==================== 用户可见 Errors ====================
export interface ErrorStrings {
  'error.path.empty': string;
  'error.path.traversal': string;
  'error.path.absolute': string;
  'error.path.configDir': string;
  'error.path.trash': string;
  'error.tool.fileNotFound': string;
  'error.tool.oldStringNotFound': string;
  'error.tool.oldStringMultipleMatches': string;
  'error.tool.invalidContent': string;
  'error.tool.invalidQuery': string;
  'error.tool.invalidArg': string;
  'error.tool.rejected': string;
  'error.tool.rejectedDisabled': string;
  'error.compact.emptySummary': string;
  'error.compact.failed': string;
  // 关键路径:Embedding / Vector / Tokenizer 适配器用户可见错误
  'error.embedding.notInit': string;
  'error.embedding.dimMismatch': string;
  'error.embedding.emptyVector': string;
  'error.vector.initFailed': string;
  'error.tokenizer.vocabFailed': string;
  // 关键路径:外部 API 调用错误(包含状态码 / 错误体)
  'error.api.rerankFailed': string;
  'error.api.llmFailed': string;
  'error.api.llmEmptyBody': string;
  'error.api.embeddingFailed': string;
  // 关键路径:模型探测失败错误
  'error.probe.connectionFailed': string;
  'error.probe.requestFailed': string;
  // 关键路径:Worker 未内联错误(main.ts 启动检查)
  'error.worker.notInlined': string;
  // 关键路径:检索就绪状态错误
  'error.search.notReady': string;
  // 关键路径:模型 / ORT WASM 下载失败错误(用户可见 Notice,经 ratelError 冒泡)
  'error.model.downloadFailed': string;
  'error.ort.downloadFailed': string;
  'error.ort.fileCorrupted': string;
  // 关键路径:记忆系统错误(用户可见)
  'error.memory.storeNotInit': string;
  'error.memory.topicRequired': string;
  'error.memory.sectionNotFound': string;
  'error.memory.topicNotFound': string;
  'error.memory.noMatch': string;
  // 关键路径:topic 名校验失败(LLM 输出可能含 ../ 等穿越片段)
  'error.memory.invalidTopic': string;
  // 关键路径:embeddingPort 未注入或返回空向量
  'error.memory.embeddingNotInit': string;
  'error.memory.embeddingFailed': string;
  // 关键路径:写入超 10MB 存储上限
  'error.memory.storageFull': string;
}

// ==================== Prompt section labels(设置面板展示用) ====================
// 关键路径:label 为 section 标题;desc 为 section 在 Prompt overrides 面板的简短说明(用户可见)
export interface PromptLabelStrings {
  'promptLabel.agent.base': string;
  'promptLabel.agent.base.desc': string;
  'promptLabel.agent.rag.workflow': string;
  'promptLabel.agent.rag.workflow.desc': string;
  'promptLabel.agent.rag.toolGuide': string;
  'promptLabel.agent.rag.toolGuide.desc': string;
  'promptLabel.injection.searchResults.body': string;
  'promptLabel.injection.searchResults.body.desc': string;
  // 关键路径:记忆系统注入提示 section(用户可在 Prompt overrides 面板覆盖默认中文模板)
  'promptLabel.memory.systemPrompt': string;
  'promptLabel.memory.systemPrompt.desc': string;
  // 关键路径:Skill 机制 Discovery 段 section(allowOverride: false,不出现在 Prompt overrides 面板)
  'promptLabel.agent.skills': string;
  'promptLabel.agent.skills.desc': string;
  'promptLabel.internal.intent.system': string;
  'promptLabel.internal.intent.system.desc': string;
  'promptLabel.internal.intent.user': string;
  'promptLabel.internal.intent.user.desc': string;
  'promptLabel.internal.rewrite.system': string;
  'promptLabel.internal.rewrite.system.desc': string;
  'promptLabel.internal.rewrite.user': string;
  'promptLabel.internal.rewrite.user.desc': string;
  'promptLabel.tool.read_note.description': string;
  'promptLabel.tool.read_note.description.desc': string;
  'promptLabel.tool.read_note.param.path': string;
  'promptLabel.tool.read_note.param.path.desc': string;
  'promptLabel.tool.search_vault.description': string;
  'promptLabel.tool.search_vault.description.desc': string;
  'promptLabel.tool.search_vault.param.query': string;
  'promptLabel.tool.search_vault.param.query.desc': string;
  'promptLabel.tool.search_vault.param.topK': string;
  'promptLabel.tool.search_vault.param.topK.desc': string;
  'promptLabel.tool.grep.description': string;
  'promptLabel.tool.grep.description.desc': string;
  'promptLabel.tool.grep.param.pattern': string;
  'promptLabel.tool.grep.param.pattern.desc': string;
  'promptLabel.tool.glob.description': string;
  'promptLabel.tool.glob.description.desc': string;
  'promptLabel.tool.glob.param.pattern': string;
  'promptLabel.tool.glob.param.pattern.desc': string;
  'promptLabel.tool.list_files.description': string;
  'promptLabel.tool.list_files.description.desc': string;
  'promptLabel.tool.write_note.description': string;
  'promptLabel.tool.write_note.description.desc': string;
  'promptLabel.tool.append_note.description': string;
  'promptLabel.tool.append_note.description.desc': string;
  'promptLabel.tool.edit_note.description': string;
  'promptLabel.tool.edit_note.description.desc': string;
  'promptLabel.tool.delete_note.description': string;
  'promptLabel.tool.delete_note.description.desc': string;
  // 关键路径:2 个 skill 工具 section 元数据
  'promptLabel.tool.activate_skill.description': string;
  'promptLabel.tool.activate_skill.description.desc': string;
  'promptLabel.tool.activate_skill.param.name': string;
  'promptLabel.tool.activate_skill.param.name.desc': string;
  'promptLabel.tool.deactivate_skill.description': string;
  'promptLabel.tool.deactivate_skill.description.desc': string;
  'promptLabel.tool.deactivate_skill.param.name': string;
  'promptLabel.tool.deactivate_skill.param.name.desc': string;
  'promptLabel.tool.get_datetime.description': string;
  'promptLabel.tool.get_datetime.description.desc': string;
  'promptLabel.tool.get_datetime.param.format': string;
  'promptLabel.tool.get_datetime.param.format.desc': string;
  'promptLabel.tool.get_datetime.param.offsetDays': string;
  'promptLabel.tool.get_datetime.param.offsetDays.desc': string;
  'promptLabel.tool.get_active_note.description': string;
  'promptLabel.tool.get_active_note.description.desc': string;
  'promptLabel.tool.get_active_note.param.includeSelection': string;
  'promptLabel.tool.get_active_note.param.includeSelection.desc': string;
  'promptLabel.tool.get_active_note.param.includeFrontmatter': string;
  'promptLabel.tool.get_active_note.param.includeFrontmatter.desc': string;
  'promptLabel.tool.get_daily_note.description': string;
  'promptLabel.tool.get_daily_note.description.desc': string;
  'promptLabel.tool.get_daily_note.param.date': string;
  'promptLabel.tool.get_daily_note.param.date.desc': string;
  'promptLabel.tool.list_recent_notes.description': string;
  'promptLabel.tool.list_recent_notes.description.desc': string;
  'promptLabel.tool.list_recent_notes.param.limit': string;
  'promptLabel.tool.list_recent_notes.param.limit.desc': string;
  'promptLabel.tool.get_note_outline.description': string;
  'promptLabel.tool.get_note_outline.description.desc': string;
  'promptLabel.tool.get_note_outline.param.path': string;
  'promptLabel.tool.get_note_outline.param.path.desc': string;
  'promptLabel.tool.get_links.description': string;
  'promptLabel.tool.get_links.description.desc': string;
  'promptLabel.tool.get_links.param.path': string;
  'promptLabel.tool.get_links.param.path.desc': string;
  'promptLabel.tool.search_by_tag.description': string;
  'promptLabel.tool.search_by_tag.description.desc': string;
  'promptLabel.tool.search_by_tag.param.tag': string;
  'promptLabel.tool.search_by_tag.param.tag.desc': string;
  'promptLabel.tool.search_by_tag.param.limit': string;
  'promptLabel.tool.search_by_tag.param.limit.desc': string;
  'promptLabel.tool.search_by_property.description': string;
  'promptLabel.tool.search_by_property.description.desc': string;
  'promptLabel.tool.search_by_property.param.key': string;
  'promptLabel.tool.search_by_property.param.key.desc': string;
  'promptLabel.tool.search_by_property.param.value': string;
  'promptLabel.tool.search_by_property.param.value.desc': string;
  'promptLabel.tool.search_by_property.param.limit': string;
  'promptLabel.tool.search_by_property.param.limit.desc': string;
  'promptLabel.tool.get_vault_structure.description': string;
  'promptLabel.tool.get_vault_structure.description.desc': string;
  'promptLabel.tool.get_vault_structure.param.include': string;
  'promptLabel.tool.get_vault_structure.param.include.desc': string;
  'promptLabel.tool.open_note.description': string;
  'promptLabel.tool.open_note.description.desc': string;
  'promptLabel.tool.open_note.param.path': string;
  'promptLabel.tool.open_note.param.path.desc': string;
  'promptLabel.tool.open_note.param.anchor': string;
  'promptLabel.tool.open_note.param.anchor.desc': string;
  'promptLabel.tool.open_settings.description': string;
  'promptLabel.tool.open_settings.description.desc': string;
  'promptLabel.tool.open_settings.param.tab': string;
  'promptLabel.tool.open_settings.param.tab.desc': string;
  'promptLabel.tool.get_app_config.description': string;
  'promptLabel.tool.get_app_config.description.desc': string;
  'promptLabel.tool.update_app_config.description': string;
  'promptLabel.tool.update_app_config.description.desc': string;
  'promptLabel.tool.update_app_config.param.updates': string;
  'promptLabel.tool.update_app_config.param.updates.desc': string;
  'promptLabel.retrieval.wrapperPrefix': string;
  'promptLabel.retrieval.wrapperSuffix': string;
}

// ==================== 斜杠命令 addCommand name ====================
// 关键路径:Obsidian addCommand 的 name 字段(用户在命令面板可见)
export interface CmdStrings {
  'cmd.askVault': string;
  'cmd.showIndexStatus': string;
  'cmd.rebuildIndex': string;
  'cmd.pauseIndex': string;
  'cmd.resumeIndex': string;
  'cmd.dropIndex': string;
}

// ==================== 工具调用摘要(tool-permissions) ====================
// 关键路径:summarizeToolCall 在 Chat UI / Notice 中显示的工具调用描述(带 {path} 占位)
export interface ToolPermStrings {
  'toolPerm.writeNote': string;
  'toolPerm.appendNote': string;
  'toolPerm.editNote': string;
  'toolPerm.deleteNote': string;
}

// ==================== Memory(记忆系统 — P-MEMORY-UI 消费) ====================
// 关键路径:6 个设置项 + heading + viewMemory action + Svelte 面板用 key
export interface MemoryStrings {
  // Settings 面板 — Memory group
  'memory.settings.heading': string;
  'memory.settings.limitsHeading': string;
  'memory.settings.enabled.name': string;
  'memory.settings.enabled.desc': string;
  'memory.settings.autoWrite.name': string;
  'memory.settings.autoWrite.desc': string;
  'memory.settings.storageLimit.name': string;
  'memory.settings.storageLimit.desc': string;
  'memory.settings.injectLimit.name': string;
  'memory.settings.injectLimit.desc': string;
  'memory.settings.dynamicLimit.name': string;
  'memory.settings.dynamicLimit.desc': string;
  'memory.settings.contextTotalLimit.name': string;
  'memory.settings.contextTotalLimit.desc': string;
  'memory.settings.viewMemory.name': string;
  'memory.settings.viewMemory.desc': string;
  // Memory 面板(Svelte)
  'memory.panel.title': string;
  'memory.panel.searchPlaceholder': string;
  'memory.panel.globalSection': string;
  'memory.panel.topicSection': string;
  'memory.panel.sourceUser': string;
  'memory.panel.sourceModel': string;
  'memory.panel.filterAll': string;
  'memory.panel.filterUser': string;
  'memory.panel.filterModel': string;
  'memory.panel.clearModelMemories': string;
  'memory.panel.totalSize': string;
  'memory.panel.storageLimit': string;
  'memory.panel.empty': string;
  'memory.panel.topicEmpty': string;
  'memory.panel.confirmClear': string;
  'memory.panel.editPlaceholder': string;
  'memory.panel.save': string;
  'memory.panel.cancel': string;
  'memory.panel.delete': string;
  'memory.panel.noModelMemories': string;
  'memory.panel.cleared': string;
}

// ==================== Skill(Skill 机制 — P-SKILL-1-CORE 消费) ====================
// 关键路径:SkillStrings 覆盖 settings 面板 / Notice / slash 命令 / 来源标签 / 激活态标签
export interface SkillStrings {
  // Settings 面板 — Skills group
  'skill.settings.heading': string;
  'skill.settings.enableSkills.name': string;
  'skill.settings.enableSkills.desc': string;
  // Notice(Toast)
  'skill.notice.activating': string;
  'skill.notice.activated': string;
  'skill.notice.deactivated': string;
  'skill.notice.notFound': string;
  'skill.notice.alreadyActive': string;
  'skill.notice.notActive': string;
  'skill.notice.reloadDone': string;
  'skill.notice.reloadFailed': string;
  // Slash 命令描述
  'skill.cmd.skill': string;
  'skill.cmd.skills': string;
  'skill.cmd.reloadSkills': string;
  // addCommand name(命令面板)
  'cmd.reloadSkills': string;
  // 来源标签
  'skill.source.builtin': string;
  'skill.source.global': string;
  'skill.source.vault': string;
  // 激活模式标签
  'skill.activation.auto': string;
  'skill.activation.manual': string;
  'skill.activation.always': string;
  // Discovery / Active 段文案(PromptLabelStrings 已覆盖 promptLabel.skill.*)
  'skill.discovery.title': string;
  'skill.discovery.empty': string;
  'skill.active.title': string;
  // 错误
  'error.skill.invalidName': string;
  'error.skill.notEnabled': string;
  'error.skill.loadFailed': string;
}

// ==================== 合并 ====================
export interface Strings extends
  BaseStrings, SettingsStrings, ChatStrings, ToolNameStrings,
  SlashStrings, NoticeStrings, ModalStrings, StatusStrings,
  DiagnosticsStrings, ErrorStrings, PromptLabelStrings, MemoryStrings,
  CmdStrings, ToolPermStrings, SkillStrings {
  // 后续新功能按 namespace 追加 extends
}

export type Lang = 'zh' | 'en';
export type LangPreference = 'auto' | Lang;
export type StringKey = keyof Strings;
