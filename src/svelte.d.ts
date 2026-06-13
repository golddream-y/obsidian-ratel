declare module '*.svelte' {
	import type { SvelteComponent } from 'svelte';
	interface SvelteComponentProps {
		[key: string]: unknown;
	}
	class Component extends SvelteComponent<SvelteComponentProps> {}
	export default Component;
}
