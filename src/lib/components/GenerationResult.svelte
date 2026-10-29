<script lang="ts">
	import { dev } from '$app/environment';
	import { slide } from 'svelte/transition';
	import ProgressBar from './ProgressBar.svelte';
	import type { DemoSharing } from '$lib/demo-sharing.svelte';
	import type { GeneratedDemo } from '$lib/shares';
	import { MAX_SHARE_SIZE, SHARE_SIZE_ERROR, SHARE_LIFETIME_DAYS } from '$lib/shares';

	let {
		demo,
		generating,
		progress,
		status,
		summary,
		sharing,
		enabled
	}: {
		demo: GeneratedDemo | null;
		generating: boolean;
		progress: number;
		status: string;
		summary: string | null;
		sharing: DemoSharing;
		enabled: boolean;
	} = $props();
	const state = $derived(sharing.state);
	const saved = $derived(sharing.isSaved(demo));
	const uploadError = $derived(sharing.errorFor(demo));
	const tooLarge = $derived(!!demo && demo.blob.size > MAX_SHARE_SIZE);
</script>

<div
	class="mt-3 flex flex-col gap-3 rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-3"
	transition:slide={{ duration: 180 }}
>
	{#if generating}
		<ProgressBar value={progress} label={status || 'Working…'} framed={false} />
	{:else if demo}
		<div role="status" title={summary ?? undefined}>
			<p class="flex items-center gap-1.5 text-sm text-[var(--color-success)]">
				<svg class="size-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true"
					><path
						d="m3.5 8 3 3 6-6"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					/></svg
				>
				Downloaded
			</p>
			<p class="mt-1 truncate text-xs text-[var(--color-muted)]" title={demo.name}>{demo.name}</p>
		</div>
		{#if demo.warning}<p class="text-xs text-amber-200/80">{demo.warning}</p>{/if}
		{#if state.uploading}
			<div class="flex items-center gap-3">
				<div class="min-w-0 flex-1">
					<ProgressBar
						value={state.progress}
						label={state.progress >= 95 ? 'Creating share link…' : 'Uploading demo…'}
						framed={false}
					/>
				</div>
				<button
					type="button"
					class="text-xs text-[var(--color-muted)] underline hover:text-[var(--color-fg)]"
					onclick={sharing.cancelUpload}>Cancel</button
				>
			</div>
		{:else if saved}
			<p class="text-xs text-[var(--color-success)]" role="status">Share link created.</p>
		{:else}
			<div
				class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[var(--color-border)] pt-3"
			>
				<button
					type="button"
					disabled={!enabled || tooLarge || !!state.deletingId || !!state.cleanupError}
					onclick={() => demo && void sharing.createShare(demo)}
					class="rounded border border-[var(--color-border-strong)] px-3 py-1.5 text-xs text-[var(--color-fg)] transition-colors enabled:hover:bg-[var(--color-surface-2)] disabled:cursor-not-allowed disabled:opacity-50"
				>
					{sharing.isShared(demo) ? 'Restore Share Link' : 'Create Share Link'}
				</button>
				<p class="text-[11px] text-[var(--color-muted)]">
					{tooLarge
						? SHARE_SIZE_ERROR
						: !enabled
							? 'Sharing is not available yet.'
							: dev
								? `Stored locally · ${SHARE_LIFETIME_DAYS}-day link`
								: `Anyone with the link can download · Expires after ${SHARE_LIFETIME_DAYS} days`}
				</p>
			</div>
		{/if}
		{#if uploadError}<p class="text-xs text-red-300/90" role="alert">{uploadError}</p>{/if}
	{/if}
</div>
