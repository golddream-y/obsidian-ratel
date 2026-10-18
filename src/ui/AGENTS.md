# UI 目录约束

本文件作用于 `src/ui/`，继承源码层规则。

- UI 使用 Svelte 5；新增按钮、placeholder、标题、aria-label、Notice、错误与工具展示都按编码约定 Skill 国际化。
- 设置页、导航和模型连接测试加载根目录的 `obsidian-setting-ui` Skill；其实现细则不复制在这里。
- 保留输入焦点、加载/失败/取消状态及现有权限语义；不要把界面入口当成底层能力已成功执行。
- UI 验证仅使用 Obsidian Sandbox。画面未更新先确认当前构建软链，再按本地规则重载；不得为此覆盖日常库插件。
