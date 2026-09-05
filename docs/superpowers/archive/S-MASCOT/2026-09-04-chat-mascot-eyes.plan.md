# P-MASCOT-3:眼形表达状态

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 或 executing-plans。

**Goal:** 8 档脸用可区分眼形；保留 S-MASCOT-2 眼动；不读文本情绪。

**Architecture:** `EyeShape` 增加 `lidTop` / `lidBottom`；采样椭圆后在局部坐标压眼皮再旋转。测试用包围盒/内角 y。

**Tech Stack:** 现有 TS / vitest。

**关联:** [S-MASCOT-3](../specs/2026-09-04-chat-mascot-eyes.md)

## Global Constraints

- 不读回复情绪；不加五官；测试 `it` 中文。
- 未要求则不 git commit。

---

### Task 1: 眼皮采样 + 各脸参数 + 测试

**Files:** `src/ui/mascot/eyes.ts`, `eyes.test.ts`

- [ ] TDD：先写包围盒/内角断言（RED）再改 `FACE_SHAPES` 与 `sampleEyeRing`
- [ ] 不提交
