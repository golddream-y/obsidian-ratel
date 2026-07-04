# S-DOCS-V1 — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-06-28 — P-DOCS-V1(文档体系 v1)

**分支:** `feat/s-docs-v1`(已合并,已清理)
**合并 commit:** `d8dec0a`(docs(s-docs-v1): 文档体系 v1 — README 商店化 + 用户手册 + CHANGELOG + 发版工作流)
**后续 commit:** `700014a`(release 准备)+ `c505547`(README 拆中英双语)+ `664351d`(原型替代 GIF)

### Task 完成情况

按 plan 7 个 Task 执行(Subagent-Driven):
- README 商店化重构(功能场景描述、Demo、简洁安装、shields.io badge)
- 中英双语拆分(README.md 英文 + README.zh-CN.md 中文,BCP 47 zh-CN 规范)
- manifest.json description 去技术化(动作语句开头、无 emoji、以句号结尾、≤250 字符)
- user-guide 单文件双语手册
- CHANGELOG(Keep a Changelog 1.1.0 格式)
- AI 生成 release 工作流 spec
- LICENSE(Apache-2.0)+ 侧边栏图标🦡(Lucide 无獾,paw-print fallback 后替换 emoji span)

**关键决策:**
- README 结构参考优秀开源插件:功能场景 + Demo + 简洁安装 + badge,避免技术黑话和防御性内容
- 功能描述从技术黑话改为用户场景("问我对X记过什么"而非"多步闭环")
- GIF 录屏方案废弃,改用可交互原型(GitHub Pages 部署)
- 侧边栏图标用🦡emoji(paw-print 创建元素后替换 emoji span,加注释说明)
- AI 对话驱动发版流程,不引入 release-please/standard-version 工具依赖

**测试总数:** spec compliance 全通过
**Plan 偏差:** spec 中 secret ID 与 src/secrets/ratel-secrets.ts 实际定义有不一致(已在执行中修复)

---

## 2026-06-28 — 文档同步规则硬约束落地(commit `dd890f3`)

- AGENTS.md 新增"文档同步规则(mandatory)"小节
- finishing-a-development-branch 技能 Step 1 前加"文档同步确认"步骤
- 触发点唯一化:仅 finishing 阶段评估(基于完整 diff)
- ARCHITECTURE.md/adr/ 严格触发条件(核心模块变更、跨线程协议变更、数据模型变更等)
