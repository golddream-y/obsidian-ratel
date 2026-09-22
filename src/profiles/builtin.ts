/**
 * @file src/profiles/builtin.ts
 * @description builtin 示例档案正文（与仓库 YAML 对拍）
 * @module profiles/builtin
 */
export const BUILTIN_CALENDAR_YAML = `kind: obsidian-plugin-profile
id: calendar-week-start
pluginId: calendar
pluginName: Calendar
pluginVersionRange: ">=1.0.0"
enabled: true
tags: [calendar, week]
install:
  source: community-store
forbid:
  - token
  - apiKey
presets:
  - id: week-start-monday
    when: 周一开始
    patch:
      weekStart: 1
`;
