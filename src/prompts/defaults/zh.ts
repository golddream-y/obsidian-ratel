/**
 * @file src/prompts/defaults/zh.ts
 * @description 全部默认中文 prompt section 正文(唯一默认源)
 * @module prompts/defaults/zh
 */

import type { PromptSectionId } from '../types';

export const ZH_DEFAULTS: Record<PromptSectionId, string> = {
	'agent.base': `你是 Ratel,Obsidian 知识库里的 AI 助手。你可以阅读用户笔记并回答问题。请始终用中文回复用户,语气简洁准确。

若问题与知识库无关,直接回答即可,无需调用工具。`,

	'agent.rag.workflow': `回答知识库问题时,按以下流程:
1. 调用 search_vault 查找相关笔记(结果带 index 编号)。
2. 对有价值的结果调用 read_note 读全文。
3. 回答时用 [1][2] 引用 search_vault 返回的 index。
4. 若无结果,如实告知。`,

	'agent.rag.toolGuide': `工具选用说明:
- 问主题、概念、语义相关:优先 search_vault。
- 已知路径或需全文:用 read_note。
- 找精确字面、正则、文件名模式:用 grep / glob(若已注册)。

当前可用工具:
{{toolList}}`,

	'injection.searchResults.body': `[{{index}}] {{path}}
{{content}}`,

	'internal.intent.system': `你是意图分类器。只回答一个词:rag 或 direct。rag 表示需要搜索 Obsidian 知识库;direct 表示不需要。`,

	'internal.intent.user': `判断以下用户消息是否需要搜索 Obsidian 知识库来回答。
只回答一个词:rag 或 direct。

需要搜索的例子:问笔记内容、笔记关系、是否在库里写过某主题。
不需要搜索的例子:闲聊、通用常识、与库无关的生成任务。

用户消息:{{message}}
回答:`,

	'internal.rewrite.system': `你是查询改写助手。为用户查询生成 2 个语义变体,用于扩大知识库检索召回。每行一个变体,不要编号。`,

	'internal.rewrite.user': `把以下查询改写成 2 个语义变体,用于知识库检索扩大召回。
要求:保持原意;换用同义词或不同表述;每行一个变体,不加编号。

原始查询:{{query}}

改写变体:`,

	'tool.read_note.description': '读取 vault 内指定笔记的全文、元数据与反向链接。',
	'tool.read_note.param.path': '笔记路径,例如 notes/LangChain.md',

	'tool.search_vault.description':
		'在知识库中搜索与查询相关的笔记。使用多查询混合检索(向量+BM25)与可选重排,返回带 index 编号的结果;用 read_note 读取全文。',
	'tool.search_vault.param.query': '检索语句,例如「项目技术栈」',
	'tool.search_vault.param.topK': '返回条数上限,默认 5',

	'tool.grep.description':
		'在 vault 所有笔记中做精确文本或正则搜索。适用于查找特定汉字、代码片段、固定字符串;语义相关请用 search_vault。',
	'tool.grep.param.pattern': '搜索模式(正则或字面量)',

	'tool.glob.description': '按文件名 glob 模式查找 Markdown 笔记,如 "daily/*.md" 或 "**/*.project.md"。',
	'tool.glob.param.pattern': 'glob 模式',

	'tool.list_files.description': '列出 vault 某目录下的文件与子文件夹(非递归)。',

	'tool.write_note.description': '创建新笔记或覆盖已有笔记全文。',
	'tool.append_note.description': '在笔记末尾追加内容。',
	'tool.edit_note.description':
		'在笔记中精确替换一段文本。old_string 必须与文件内容完全一致(含缩进),且在文件中唯一。',
	'tool.delete_note.description': '将笔记移到回收站(可恢复)。',
};
