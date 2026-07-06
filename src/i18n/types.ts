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
  'settings.advanced.secretHint.hint': string;
  'settings.embedding.heading': string;
  'settings.embedding.provider.name': string;
  'settings.embedding.provider.desc': string;
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
  'settings.developer.heading': string;
  'settings.developer.debugLog.name': string;
  'settings.developer.agentMaxSteps.name': string;
  'settings.developer.agentMaxSteps.desc': string;
  'settings.developer.trustMode.name': string;
  'settings.developer.trustMode.desc': string;
  'settings.toolPermissions.heading': string;
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
  'chat.input.placeholder': string;
  'chat.input.send': string;
  'chat.input.stop': string;
  'chat.input.addImage': string;
  'chat.compacting': string;
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
  'chat.search.title': string;
  'chat.search.rerankBadge': string;
  'chat.attachments.deleteAria': string;
  'chat.attachments.invalidType': string;
  'chat.attachments.tooLarge': string;
  'chat.attachments.tooMany': string;
  'chat.slashMenu.header': string;
  'chat.compactConfirm.title': string;
  'chat.compactConfirm.body': string;
  'chat.compactConfirm.confirm': string;
  'chat.compactConfirm.cancel': string;
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
}

// ==================== Status / Drawer ====================
export interface StatusStrings {
  'status.index.indexing': string;
  'status.index.requestFailed': string;
  'status.index.notConfigured': string;
  'status.index.thinking': string;
  'status.index.ready': string;
  'status.tokenSource.api': string;
  'status.tokenSource.streaming': string;
  'status.tokenSource.estimate': string;
  'status.tokenSource.apiTitle': string;
  'status.tokenSource.streamingTitle': string;
  'status.tokenSource.estimateTitle': string;
  'status.line.ctxTooltip': string;
  'status.drawer.expand': string;
  'status.drawer.collapse': string;
  'status.drawer.tooltip': string;
  'status.drawer.section.index': string;
  'status.drawer.label.index': string;
  'status.drawer.label.currentFile': string;
  'status.drawer.label.embedding': string;
  'status.drawer.label.workerMode': string;
  'status.drawer.workerMode.inline': string;
  'status.drawer.workerMode.worker': string;
  'status.drawer.section.context': string;
  'status.drawer.label.usedMax': string;
  'status.drawer.label.dataSource': string;
  'status.drawer.label.attachments': string;
  'status.drawer.attachmentsCount': string;
  'status.drawer.compactButton': string;
  'status.drawer.sourceApi': string;
  'status.drawer.sourceStreaming': string;
  'status.drawer.sourceEstimate': string;
  'status.drawer.docCount': string;
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
  'status.degraded.inline': string;
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

// ==================== Memory(S-MEMORY 预留,本 plan 不消费) ====================
export interface MemoryStrings {
  'memory.settings.heading': string;
  'memory.settings.enabled.name': string;
  'memory.settings.enabled.desc': string;
  'memory.settings.storageLimit.name': string;
  'memory.settings.storageLimit.desc': string;
  'memory.settings.autoConsolidate.name': string;
  'memory.settings.autoConsolidate.desc': string;
  'memory.settings.consolidateThreshold.name': string;
  'memory.settings.consolidateThreshold.desc': string;
  'memory.settings.recallTopK.name': string;
  'memory.settings.recallTopK.desc': string;
  'memory.settings.viewMemory.name': string;
  'memory.tool.saveMemory': string;
  'memory.tool.recallMemory': string;
  'memory.tool.deleteMemory': string;
}

// ==================== 合并 ====================
export interface Strings extends
  BaseStrings, SettingsStrings, ChatStrings, ToolNameStrings,
  SlashStrings, NoticeStrings, ModalStrings, StatusStrings,
  DiagnosticsStrings, ErrorStrings, PromptLabelStrings, MemoryStrings,
  CmdStrings, ToolPermStrings {
  // 后续新功能按 namespace 追加 extends
}

export type Lang = 'zh' | 'en';
export type LangPreference = 'auto' | Lang;
export type StringKey = keyof Strings;
