import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	],
	assetsInclude: ['**/*.wasm'],
	optimizeDeps: {
		include: ['@demostf/demo.js', 'mp4box', 'events', 'bit-buffer', 'snappyjs'],
		exclude: ['$lib/wasm/pkg/tf2_demo_comms_injector.js']
	},
	ssr: {
		noExternal: ['@demostf/demo.js', 'mp4box']
	}
});
