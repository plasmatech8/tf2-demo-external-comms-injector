<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { shareDateDetails, shareExpiryLabel, shareIsExpired } from '$lib/shares';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let now = $state<number | null>(null);
	const checkedAt = $derived(now ?? data.checkedAt);
	const expired = $derived(shareIsExpired(data.share, checkedAt));
	onMount(() => {
		now = Date.now();
		const timer = setInterval(() => {
			now = Date.now();
		}, 60_000);
		return () => clearInterval(timer);
	});
</script>

<main class="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-12">
	<h1
		class="font-[family-name:var(--font-display)] text-3xl leading-tight font-semibold [overflow-wrap:anywhere] text-[var(--color-fg-strong)]"
	>
		{data.share.name}
	</h1>
	<p class="mt-3 text-sm text-[var(--color-muted)]">
		{(data.share.size / 1024 / 1024).toFixed(1)} MB ·
		<time
			datetime={data.share.expiresAt}
			title={now === null
				? `Uploaded ${data.share.createdAt} · Expires ${data.share.expiresAt}`
				: shareDateDetails(data.share)}>{shareExpiryLabel(data.share.expiresAt, checkedAt)}</time
		>
	</p>
	{#if expired}
		<p class="mt-6 text-sm text-[var(--color-muted)]" role="status">This share link has expired.</p>
	{:else}
		<a
			href={resolve('/share/[id]/download', { id: data.share.id })}
			download
			class="mt-7 inline-flex items-center justify-center rounded bg-[var(--color-accent)] px-4 py-3 font-[family-name:var(--font-display)] text-lg font-semibold tracking-wide text-[var(--color-fg-strong)] uppercase transition-colors hover:bg-[var(--color-accent-hover)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-accent)]"
			>Download demo</a
		>
	{/if}
</main>
