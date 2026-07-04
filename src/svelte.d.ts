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
