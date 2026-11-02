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

/** 构建期开关:T0 索引线程实验入口,仅在 RATEL_INDEX_EXPERIMENT=1 时注册。 */
declare const __RATEL_INDEX_EXPERIMENT__: boolean;
