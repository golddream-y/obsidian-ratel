// Agent Loop — core orchestration of tool calls and LLM interaction
// Moved from src/agent/index.ts

const MAX_STEPS = 10;

// Agent loop will be implemented with the full signature from ARCHITECTURE.md section 8.1:
// async function* agentLoop(
//   req: ChatRequest,
//   ctx: ContextManager,
//   llm: LLMClient,
//   tools: ToolRegistry,
//   hooks: HookRegistry,
// ): AsyncIterable<AgentEvent>
