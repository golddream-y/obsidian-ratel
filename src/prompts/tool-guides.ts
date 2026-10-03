/**
 * @file src/prompts/tool-guides.ts
 * @description system 使用的内置工具选用摘要与扩展工具简介裁剪
 * @module prompts/tool-guides
 */
/** 内置工具的固定选用边界摘要，不重复参数契约或受描述覆盖影响。 */
export const BUILTIN_TOOL_GUIDES: Record<string, string> = {
  read_note: '已知路径时读取全文与元数据。', search_vault: '按主题语义查找笔记。',
  grep: '搜索精确文字或正则。', glob: '按文件名模式查找。', list_files: '列目录的一层内容。',
  write_note: '新建笔记或覆盖全文。', append_note: '追加到笔记末尾。',
  edit_note: '唯一原文片段精确替换。', apply_patch: '对已有笔记做一处或多处局部修改。',
  delete_note: '把笔记移到回收站。', move_note: '移动或重命名已有文件。', copy_note: '原文件保留，复制到新路径。',
  search_memory: '查询主题记忆。', remember: '记录偏好或工作约定。', forget_memory: '删除匹配的记忆。',
  activate_skill: '读取并激活匹配的技能。', deactivate_skill: '移除已激活技能。',
  read_skill_reference: '读取技能参考资料。', run_skill_script: '运行技能沙箱脚本或处理挂起状态。',
  get_datetime: '需要精确时间或相对日期时查询。', get_active_note: '定位当前笔记和选区。',
  get_daily_note: '探测指定日期的日记，不自动创建。', list_recent_notes: '列出最近修改的笔记。',
  get_note_outline: '读取标题大纲。', get_links: '查询出链、反链和未解析链接。',
  search_by_tag: '按标签过滤。', search_by_property: '按属性过滤。', get_vault_structure: '查看目录、标签和孤儿笔记概览。',
  open_note: '打开笔记并定位标题或块。', open_settings: '打开对应设置页。',
  get_app_config: '读取配置与诊断状态。', update_app_config: '修改白名单内设置。',
  manage_goal: '管理已确认完成标准的长期目标。', search_plugins: '在官方社区清单里找插件。',
  install_plugin: '安装官方清单中的插件。', update_plugin: '更新已安装插件。',
  uninstall_plugin: '卸载插件。', configure_plugin: '读取或按字段修改插件配置。',
  get_plugin_status: '查询安装与更新状态。', list_ecosystem_changes: '查看插件变更记录。',
  restore_backup: '恢复选定的插件变更快照。', apply_diary_host: '配置已确认的日记宿主设置。',
  list_host_dir: '列库外目录。', read_host_file: '读库外文本。',
  import_host_file: '原样导入库外文件。', run_host_command: '执行本机命令，可能有副作用。',
};
/**
 * 返回内置工具的固定选用摘要，扩展工具使用简介首行。
 * @param name - 工具名
 * @param description - 扩展工具的原始描述
 * @returns system 中展示的简短摘要
 * @example getToolGuide('read_note', '读取全文')
 */
export function getToolGuide(name: string, description: string): string {
  return BUILTIN_TOOL_GUIDES[name] ?? description.split(/\r?\n/, 1)[0]!.slice(0, 160);
}
