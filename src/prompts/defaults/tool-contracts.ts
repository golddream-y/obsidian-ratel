/**
 * @file src/prompts/defaults/tool-contracts.ts
 * @description 默认工具契约补充源及可执行 JSON 调用示例
 * @module prompts/defaults/tool-contracts
 */
/** 单篇已存在笔记的规范补丁参数；对应原文甲、乙两行。 */
export const APPLY_PATCH_EXAMPLE = {
  patch: '*** Begin Patch\n*** Update File: notes/a.md\n@@\n 甲\n-乙\n+乙二\n*** End Patch',
};
/** 复杂工具的完整参数对象；统一用于描述展示与契约验证。 */
export const TOOL_CALL_EXAMPLES = {
  apply_patch: APPLY_PATCH_EXAMPLE,
  update_app_config: { updates: { goalMaxRounds: 20 } },
  configure_plugin: { pluginId: 'dataview', op: 'inspect' },
  manage_goal: { action: 'list' },
};
const TEXT_RESULT = '成功返回 { path, text }；text 是改后全文的统计。中文字数读 text.length.han，拉丁词数读 text.words.latin，codePoints 不是字数。';
/** 默认契约补充项；由默认中文源合并，用户覆盖仍具有优先权。 */
export const TOOL_CONTRACT_DEFAULTS = {
  'tool.write_note.description': `创建笔记或覆盖全文。参数是 JSON 对象，path 与字符串 content 同时必填。已有笔记局部修改用 edit_note；仅移动或复制用 move_note/copy_note。${TEXT_RESULT}`,
  'tool.append_note.description': `向文件末尾追加，文件不存在则创建。参数是 JSON 对象，path 与字符串 content 同时必填。${TEXT_RESULT}`,
  'tool.edit_note.description': `在已有笔记里替换唯一出现的一段。参数是 JSON 对象，path、old_string、new_string 同时必填且都是字符串；原文按缩进精确匹配。多处修改逐处调用 edit_note，每次先确认原文唯一匹配。${TEXT_RESULT}`,
  'tool.apply_patch.description': `局部修改一篇已存在笔记。function arguments 必须是 JSON 对象，补丁全文放在 patch 字符串，不能把裸补丁直接填进参数通道；不另传 path。一次只接受一个 Update File，不新建文件。调用参数 JSON 示例：${JSON.stringify(APPLY_PATCH_EXAMPLE)}。patch 以 *** Begin Patch 开头、*** End Patch 结尾；@@ 开始一处修改，其同行文字不参与匹配。下一行起，空格表示精确上下文，- 删除，+ 插入；标记后的文本原样比较，不 trim。每一行都必须有标记，不能从正文直接开始，也不能用 Tab 代替 ASCII 空格；空白上下文行写一个空格，新增空行写 +。上下文必须是完整物理行，不能只取段落里的一句话。错误写法为 @@\n甲\n+乙；正确写法为 @@\n 甲\n+乙（甲前有一个空格）。格式报错只修正指出的标记，不猜中文标点或长句问题；同类错误连续两次时停止盲试，先核对格式；匹配错误先 read_note 重新读取目标片段，再构造补丁。单处唯一片段替换可用 edit_note，不能用覆盖全文绕过错误。可有多处修改，每处至少一行增删。上下文缺失、多处匹配或 End of File 不在末尾，整次不写。Add File 用 write_note，Delete File 用 delete_note，Move to 用 move_note；大部分正文更换用 write_note。${TEXT_RESULT}`,
  'tool.apply_patch.param.patch': '补丁全文字符串，必填。调用必须是 {"patch":"补丁全文"}；字符串里的换行使用 JSON 编码。路径只写在唯一的 *** Update File: 库内相对路径中。结束标记必须是 *** End Patch。',
  'tool.update_plugin.description': '更新已安装的社区插件，保留已有设置，按权限执行并记录变更和备份。pluginId 是官方清单中的插件 ID。检查返回结果，热启用失败时说明需要重载。',
  'tool.uninstall_plugin.description': '卸载已安装社区插件，按权限执行并记录变更和恢复备份。结果不表示整个库或所有相关模板都已清理。',
  'tool.configure_plugin.description': '读取或按字段修改插件配置。op 省略或为 inspect 时只读取；修改必须明确 op=apply 并提供对象 patch。仅改点名字段，不整份覆盖，不代填密钥。confirmedNewKeys 只能包含已向用户确认可新增的键。返回实际检查或修改结果。调用参数 JSON 示例:{"pluginId":"dataview","op":"inspect"}。',
  'tool.get_plugin_status.description': '查询已安装插件或某个插件的状态；省略 pluginId 时列出已安装插件。可选择返回配置键和检查更新，不修改插件。',
  'tool.list_ecosystem_changes.description': '列出插件环境变更记录，可按 pluginId 筛选；用结果中的变更 ID 选择恢复对象，不猜 ID。',
  'tool.restore_backup.description': '按变更记录 ID 恢复对应插件快照，按权限执行。后续修改可能被覆盖，过期备份不能恢复；不是恢复整个库或整个场景。',
  'tool.grep.param.is_regex': '是否将 pattern 视为正则表达式，默认 true；false 按字面搜索。',
  'tool.grep.param.include': '限定匹配的文件 glob 模式。',
  'tool.grep.param.path': '限定搜索目录，库内相对路径。',
  'tool.grep.param.ignore_case': '是否忽略大小写，默认 true。',
  'tool.grep.param.context_lines': '每个匹配前后返回的上下文行数，默认 2。',
  'tool.grep.param.max_results': '最多返回的匹配结果数，默认 50。',
  'tool.glob.param.path': '搜索起始目录，库内相对路径。',
  'tool.list_files.param.path': '要列出的库内目录路径，省略时列库根。',
  'tool.delete_note.param.path': '要移到回收站的库内笔记路径。',
  'tool.run_skill_script.param.continueRun': '已有挂起脚本继续等待时传 true；不与 killRun 同时启用。',
  'tool.run_skill_script.param.killRun': '终止当前挂起脚本时传 true；不与 continueRun 同时启用。',
  'tool.manage_goal.param.goalId': '目标记录的 ID；更新或状态动作使用已有目标 ID，不自行编造。',
  'tool.manage_goal.param.predicate': '可选自动完成条件对象，kind=frontmatter-all，pathGlob 为库内文件匹配模式，property 为要求存在的属性名。',
  'tool.manage_goal.param.maxRounds': '目标回合上限；给当前目标加轮时必须高于当前值，不用它代改全局默认。',
  'tool.manage_goal.param.grant': '可选已获用户同意的库内目录授权模式数组；默认省略，不自行扩大范围。',
  'tool.manage_goal.param.progressNote': '本条目标的进度说明，不替代完成证据。',
  'tool.manage_goal.param.usage': '目标用量统计对象，包含 inputTokens 和 outputTokens 数值；只记录已知用量，不估算为真实统计。',
  'tool.update_plugin.param.pluginId': '已安装插件的官方 ID。',
  'tool.uninstall_plugin.param.pluginId': '要卸载的已安装插件 ID。',
  'tool.configure_plugin.param.pluginId': '要读取或修改配置的插件 ID。',
  'tool.configure_plugin.param.op': 'inspect 或 apply；缺省 inspect。写配置必须明确传 apply。',
  'tool.configure_plugin.param.patch': 'op=apply 必填对象，只有本次点名要修改的配置键和值。',
  'tool.configure_plugin.param.confirmedNewKeys': '用户已确认允许新增的配置键数组，不包含未获确认的键。',
  'tool.get_plugin_status.param.pluginId': '指定插件 ID；省略时列出已安装插件。',
  'tool.get_plugin_status.param.includeKeys': '是否返回配置键清单，默认 false；仅指定 pluginId 时生效。',
  'tool.get_plugin_status.param.checkUpdate': '是否查询可用更新，默认 false；仅指定 pluginId 时生效，可能访问插件发布来源。',
  'tool.list_ecosystem_changes.param.pluginId': '只列该插件的变更；省略不限定插件。',
  'tool.list_ecosystem_changes.param.limit': '返回条数，默认 20，范围 1–100。',
  'tool.restore_backup.param.changeId': 'list_ecosystem_changes 返回的具体变更 ID。',
} as const;
