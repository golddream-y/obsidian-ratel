# Bug 报告:工具权限弹窗点击「允许」后仍显示"用户拒绝了工具调用"

- **报告日期**:2026-06-26
- **严重程度**:High(写工具完全无法使用,用户授权流程失效)
- **引入版本**:P-VAULT-TOOLS 工具权限功能实现(commit `a0adfe6` 附近)
- **修复 commit**:工作区修改(confirm-modal.ts)
- **影响范围**:所有写工具(write_note / append_note / edit_note / delete_note)在默认 `ask` 权限下无法通过授权

---

## 1. 现象

用户让 Ratel 在 vault 根目录生成整体目录 markdown 笔记,Ratel 执行 list_files 遍历目录后调用 write_note,弹出「确认工具调用: write_note」权限弹窗。用户点击「允许」按钮后:

- 弹窗关闭
- 聊天界面红色提示条出现:**"用户拒绝了工具调用"**
- write_note 未执行,生成目录的操作中断

截图显示:
1. 权限弹窗正常弹出,有「允许」「允许(本次会话不再询问)」「拒绝」三个按钮
2. 用户点了允许,但仍收到拒绝提示
3. write_note 调用被 block,之前的 list_files(只读,默认 allow,无弹窗)全部成功

---

## 2. 根因

### 2.1 直接原因

[confirm-modal.ts](file:///Users/golddream/code/git-public/Ratel-CLI/src/ui/confirm-modal.ts#L40-L51) 三个按钮的 onclick 回调**先调 `this.close()` 再调 `this.settle()`**:

```typescript
// 修复前(错误):
btnRow.createEl('button', { text: '允许' }).onclick = () => {
    this.close();         // ← 先 close
    this.settle('allow'); // ← 后 settle
};
```

Obsidian Modal 的 `close()` 会**同步触发** `onClose()` 回调,而 `onClose()` 为了防止用户按 ESC 或点遮罩关闭弹窗导致 Promise 永远挂起,做了兜底:

```typescript
onClose(): void {
    // 关键路径:ESC / 点遮罩关闭时视为拒绝,避免 agentLoop 永久 await。
    this.settle('deny');
    this.contentEl.empty();
}
```

### 2.2 执行时序(关键路径)

用户点击「允许」按钮时:

1. `onclick` 触发
2. 调 `this.close()` → Obsidian 同步调用 `onClose()` → `this.settle('deny')`
3. `settle('deny')` 执行:
   - `this.settled === false` → 通过防重复检查
   - 设置 `this.settled = true`
   - 调 `this.onResolve('deny')` → Promise resolve('deny') → **权限决策变为 deny**
4. 回到 onclick 第二行 `this.settle('allow')`:
   - `this.settled === true` → 直接 return,`allow` 结果被丢弃
5. [tool-permissions.ts](file:///Users/golddream/code/git-public/Ratel-CLI/src/core/tool-permissions.ts#L72-L75) 收到 `decision === 'deny'` → `throw new Error('用户拒绝了工具调用')`

### 2.3 为什么「拒绝」按钮没暴露问题

「拒绝」按钮也是先 close 再 settle,但 `onClose()` 的兜底结果也是 `deny`,两次 settle 都是 deny,结果恰好一致,所以 bug 长期潜伏没被发现。

### 2.4 为什么「允许(本次会话不再询问)」同样失效

同理会被 `onClose()` 的 `settle('deny')` 抢先 resolve,`session` 结果同样丢失。

---

## 3. 诊断过程

1. **现象复现**:用户反馈点击允许后仍被拒绝,怀疑是权限判断逻辑问题
2. **读 tool-permissions.ts**:`resolveToolPermission` 在 `decision === 'deny'` 时抛错,逻辑本身没问题,问题在 confirm 返回值
3. **读 confirm-modal.ts**:注意到 onclick 是 `close()` 在前 `settle()` 在后
4. **回忆 Modal 生命周期**:Obsidian Modal 的 `close()` 是同步触发 `onClose()`,不是异步延迟
5. **时序分析**:settle 有 `this.settled` 防重复标志,第一次 settle 赢,close 触发的 onClose 里 settle('deny') 抢先
6. **确认假设**:三个按钮都有同样问题,「拒绝」按钮因结果一致所以不出错

---

## 4. 修复方案

**原则**:先 settle(确定结果),再 close(触发 onClose 兜底)。利用 `settle()` 的 `this.settled` 防重入,让 onClose 的兜底 deny 在正常按钮路径下被跳过,只在 ESC/点遮罩时生效。

**具体修改**([confirm-modal.ts#L40-L51](file:///Users/golddream/code/git-public/Ratel-CLI/src/ui/confirm-modal.ts#L40-L51)):

```typescript
// 修复后(正确):
btnRow.createEl('button', { text: '允许' }).onclick = () => {
    this.settle('allow');  // ← 先 settle(正确结果)
    this.close();          // ← 后 close(onClose 的 settle 因 settled=true 被跳过)
};
btnRow.createEl('button', { text: '允许(本次会话不再询问)' }).onclick = () => {
    this.settle('session');
    this.close();
};
btnRow.createEl('button', { text: '拒绝' }).onclick = () => {
    this.settle('deny');
    this.close();
};
```

**修复后时序**:
1. 点击「允许」→ `settle('allow')` → `settled=true` → resolve('allow') → 权限通过
2. `close()` → `onClose()` → `settle('deny')` → `settled===true` → 跳过
3. 弹窗关闭,工具正常执行

**ESC / 点遮罩路径不变(仍正确)**:
1. 用户按 ESC → Obsidian 调 `close()` → `onClose()` → `settle('deny')` → 拒绝
2. Promise 不会永久挂起

---

## 5. 经验教训

1. **Modal + Promise 模式的通用陷阱**:当 Modal 的 `onClose()` 有兜底 resolve 逻辑时,onclick 必须**先 resolve(settle)再 close**,因为 `close()` 会**同步**触发 `onClose()`,而不是异步。
2. **防重入标志的语义**:利用 settled 标志做"第一次赢"是正确的,但必须保证"正确结果"是第一个 settle 的调用者,不能让兜底逻辑抢先。
3. **对称测试的重要性**:「拒绝」按钮工作正常不代表「允许」也正常 — 当 onClose 兜底值是 deny 时,「拒绝」路径的 bug 被掩盖了。测试时必须覆盖所有三个按钮,不能因为一个按钮工作就假设都对。
4. **close/settle 顺序的记忆口诀**:**"定结果,再关门"**。所有用 Promise 包装 Modal 并在 onClose 做兜底的场景都适用。

---

## 6. 复现与验证

- **复现步骤**:
  1. 确保 `toolPermissions.write_note === 'ask'`(默认值)
  2. 给 Ratel 发消息要求写文件(如"帮我创建 test.md")
  3. 弹窗出现,点击「允许」→ 应执行成功,修复前会显示"用户拒绝了工具调用"

- **验证方式**:修复后重新 `npm run build`,Obsidian 重新加载插件,同样操作应正常写入文件。
- **测试结果**:npm test 349/349 通过,构建无报错。
