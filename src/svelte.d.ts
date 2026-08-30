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
