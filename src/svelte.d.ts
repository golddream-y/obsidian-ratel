declare module '*.svelte' {
	import type { SvelteComponent } from 'svelte';
	interface SvelteComponentProps {
		[key: string]: unknown;
	}
	class Component extends SvelteComponent<SvelteComponentProps> {}
	export default Component;
}

declare module '@ratel/embedding-worker-code' {
	export const EMBEDDING_WORKER_CODE: string;
}

declare module '@ratel/skill-script-worker-code' {
	export const SKILL_SCRIPT_WORKER_CODE: string;
}

declare module '@ratel/index-runtime-worker-code' {
	export const INDEX_RUNTIME_WORKER_CODE: string;
}

/** 构建期开关:T0 索引线程实验入口,仅在 RATEL_INDEX_EXPERIMENT=1 时注册。 */
declare const __RATEL_INDEX_EXPERIMENT__: boolean;


declare module '@ratel/gpu-embedding-worker-code' {
	export const GPU_EMBEDDING_WORKER_CODE: string;
}

/**
 * 构建期注入：当前是否是 GPU 版嵌入 Worker（ESM + webgpu bundle）。
 * 同一份 Worker 源码打两份产物，靠它区分，避免维护两份逻辑。
 */
declare const __RATEL_GPU_WORKER__: boolean;

/** 构建期内联的 ONNX jsep 胶水模块源码；非 GPU 版为空字符串。 */
declare const __RATEL_ORT_GLUE__: string;
