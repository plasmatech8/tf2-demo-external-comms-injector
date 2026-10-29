<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
</script>

<main class="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-12">
	<h1
		class="font-[family-name:var(--font-display)] text-3xl font-semibold text-[var(--color-fg-strong)]"
	>
		{page.status === 410 ? 'Link expired' : 'Demo unavailable'}
	</h1>
	<p class="mt-3 text-sm leading-relaxed text-[var(--color-muted)]">
		{page.error?.message ?? 'This demo could not be loaded. Please try again later.'}
	</p>
	<a
		href={resolve('/')}
		class="mt-6 text-sm text-[var(--color-fg)] underline decoration-[var(--color-border-strong)] underline-offset-4 hover:decoration-current"
		>Open the demo tool</a
	>
</main>
