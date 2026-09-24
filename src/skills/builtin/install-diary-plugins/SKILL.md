---
name: install-diary-plugins
description: 安装 Templater 与 Dataview，写入日记和月度模板、插件设置，并打开新建触发、写好核心日记模板。用户说「装日记插件」时使用。不写当天日记。
activation: auto
tags: [diary, plugins]
---

# 安装日记插件并配置模板

晨间、收尾、月末复盘是 `diary-month-ledger`。本技能只做环境和模板。不要调用 `read_skill_reference`。

## 语言

先 `get_app_config`，看 `config.language`。

- `zh`：下面两段模板按原文写入，不问翻译。
- `en`：同一次确认里问要不要把模板里的中文标题和提示译成英文。同意才译。Templater、dataviewjs、路径和文件名不译。不同意就仍用中文原文。
- `auto`：用户这条消息是中文就按 `zh`，是英文就按 `en`。

## 要落地的东西

一次确认里说清下面全部，用户同意后连续做完。缺什么做哪项，已经有的跳过。

1. 插件：`templater-obsidian`、`dataview`。未安装才 `install_plugin`。
2. 模板文件（不存在才 `write_note`，已存在不覆盖）：
   - `Template/Diary/Daily Note Template.md`
   - `Template/Month/Month Note Template.md`
   中文时正文用下面两段原样写入。英文且用户同意翻译时，只译标题和提示句。
3. 设置，用 `configure_plugin` 的 `op: apply`，只改点名字段，不整份覆盖：
   - `templater-obsidian`：`templates_folder` 为 `Template`，`trigger_on_file_creation_mode` 为 `folder`。新键放进 `confirmedNewKeys`。
   - `dataview`：`enableDataviewJs` 为 `true`。新键放进 `confirmedNewKeys`。
4. 日记根。同一次确认里问：建议 `Work/Diary`，要不要改。同意后才 `apply_diary_host`，`folder` 用确认后的路径。它会设模板、建文件夹、打开新建触发和正在运行的 Dataview JS。格式为空或仍是 `YYYY-MM-DD` 时写成 `YYYY/MM-MMMM/YYYY-MM-DD-dddd`，当天日记进月份目录。
5. 两个模板正文里的 `Work/Diary` 全部换成确认后的根，再 `write_note`。根就是 `Work/Diary` 时原文照写。
6. 当月台账 `{日记根}/{年}/{MM}-{MMMM}/{YYYY-MM}.md` 不存在就按月度模板创建。当天日记已在、脚本没跑过时必须补上。
7. 日记根下已有平铺的 `{YYYY-MM-DD}.md` 时，读出正文，写到月份目录的 `{YYYY-MM-DD}-{dddd}.md`，再 `delete_note` 删掉根上那份。
8. 路径定了就 `remember`：`type=global`，`source=model`，`section` 为 `日记 [pinned]`。一条写清日记目录 `{根}/{年}/{MM}-{MMMM}/` 和月任务台账 `{YYYY-MM}.md`。相同路径跳过；变了先 `forget_memory`。

## 配完怎么用

做完后告诉用户：以后用 `/diary-month-ledger`。晨间说「安排今天的工作」，收尾说「同步今天的进展」，月末说「月末复盘」。当天日记用 Obsidian 的日记命令新建，应出现在月份目录里。

## 红线

- 不改 `shell_path`、`user_scripts_folder`，不代填密钥。
- 不整份覆盖 `data.json`。
- 不新写当天日记。第 7 步只搬已经放错位置的那一份。当月台账只在第 6 步缺失时创建。

## 日记模板

~~~~markdown
---
创建日期: <% tp.file.creation_date() %>
最后编辑时间: <% tp.file.last_modified_date() %>
标签: "[[+每日笔记]]"
---

<%*
// === 🗓️ 自动检查并创建月度笔记 ===
const year = tp.date.now("YYYY");
const month = tp.date.now("MM");
const monthCN = moment().format("MMMM");
const folderPath = `Work/Diary/${year}/${month}-${monthCN}`; // ← 与核心日记 format 同一月份目录
const fileName = `${year}-${month}`;                   // ← 2026-08
const templateName = "Month Note Template";            // ← 模板名不变

// ✅ 自动创建目标文件夹（已存在则静默跳过）
await app.vault.createFolder(folderPath).catch(() => {});

// ✅ 安全获取模板
const templateFile = tp.file.find_tfile(templateName);
if (!templateFile) {
    new Notice(`❌ 找不到模板「${templateName}」，请检查 Templater 设置`);
    return;
}

const fullPath = `${folderPath}/${fileName}.md`;
const exists = app.vault.getAbstractFileByPath(fullPath);

if (!exists) {
    await tp.file.create_new(templateFile, fileName, false, folderPath);
    new Notice(`📅 本月笔记已生成：${fullPath}`);
}
// === ✅ 月度检查结束 ===
%>
```dataviewjs
/*
    previous/next note by date for Daily Notes
    Also works for other files having a `date:` YAML entry.
    MCH 2021-06-14
*/
var none = '(none)';
var p = dv.pages('"' + dv.current().file.folder + '"').where(p => p.file.day).map(p => [p.file.name, p.file.day.toISODate()]).sort(p => p[1]);
var t = dv.current().file.day ? dv.current().file.day.toISODate() : luxon.DateTime.now().toISODate();
// Obsidian uses moment.js; Luxon’s format strings differ!
var format = app['internalPlugins']['plugins']['daily-notes']['instance']['options']['format'] || 'YYYY-MM-DD';
var current = '(' + moment(t).format(format) + ')';
var nav = [];
var today = p.find(p => p[1] == t);
var next = p.find(p => p[1] > t);
var prev = undefined;
p.forEach(function (p, i) {
    if (p[1] < t) {
        prev = p;
    }
});
nav.push(prev ? '[[' + prev[0] + ']]' : '暂无');
//nav.push(today ? today[0] : '暂无');
nav.push(today ? today[0] : current);
nav.push(next ? '[[' + next[0] + ']]' : '暂无');

//dv.list(nav);
//dv.paragraph(nav.join(" · "));
dv.paragraph(nav[0] + ' ← ' + nav[1] + ' → ' + nav[2]);
```


---
### 📅 Daily Questions
##### 🌜 昨晚下班后，我...
- 

##### 🙌 我现在兴奋的一件事是......
- 

##### 🚀 今天计划完成的几件事是......
- 

##### 👎 今天我正在努力解决的几件事是......
- 

---
### 🖥 Work Management
##### 🔖 昨日遗留的短期任务：
- 

##### 🧸 今天的任务记录：



---
# 📝 Notes
<% tp.file.cursor() %>

---
### Notes created today
```dataviewjs
let today = dv.current().file.day ? dv.current().file.day.toISODate() : luxon.DateTime.now().toISODate();
dv.list(dv.pages().where(p => p.file.cday && p.file.cday.toISODate() == today).sort(p => p.file.ctime).map(p => p.file.link));
```

### Notes last touched today
```dataviewjs
let today = dv.current().file.day ? dv.current().file.day.toISODate() : luxon.DateTime.now().toISODate();
dv.list(dv.pages().where(p => p.file.mday && p.file.mday.toISODate() == today).sort(p => p.file.mtime).map(p => p.file.link));
```~~~~

## 月度模板

~~~~markdown
---
创建日期: <% tp.file.creation_date() %>
最后编辑时间: <% tp.file.last_modified_date() %>
标签: ""
---

```dataviewjs
var p = dv.pages('"Work/Diary"').where(p => p.file.name.match(/^\d{4}-\d{2}$/)).sort(p => p.file.name);
var cur = dv.current().file.name;
var idx = p.findIndex(p => p.file.name === cur);
var prev = idx > 0 ? '[[' + p[idx-1].file.name + ']]' : '暂无';
var next = idx < p.length - 1 ? '[[' + p[idx+1].file.name + ']]' : '暂无';
dv.paragraph(prev + ' ← (' + cur + ') → ' + next);
```

---

### 🎯 本月目标

整体目标：

> 优先级：🔴 必须完成　🟡 尽量完成　🟢 有余力再做　⚪ 备选/观望
> 状态：⏳ 进行中　✅ 完成　❌ 取消　➡️ 流转（备注写去向）

| #   | 优先级 | 目标  | 状态  | 备注  |
| --- | --- | --- | --- | --- |
| 1   | 🔴  |     | 🔲  |     |
| 2   | 🟡  |     | 🔲  |     |
| 3   | 🟢  |     | 🔲  |     |
| 4   | ⚪   |     | 🔲  |     |

---

### 📋 任务记录

> 结果可选：✅ 完成　❌ 取消　🔲 未开始　⏳ 进行中　➡️ 流转到下月（备注写去向）

| 日期  | 任务  | 关联目标# | 结果  | 备注  |
| --- | --- | ----- | --- | --- |
|     |     |       |     |     |
|     |     |       |     |     |
|     |     |       |     |     |
|     |     |       |     |     |
|     |     |       |     |     |

> 💡 「关联目标#」对应上方目标编号，方便月底复盘时追溯

---

### 💡 月末复盘

##### ✅ 做到了什么：

-

##### ❌ 没做到什么，为什么：

-

##### 🌱 下个月想调整什么：

-  
~~~~
