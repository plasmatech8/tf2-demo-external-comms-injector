<script lang="ts">
	import { slide } from 'svelte/transition';
	import { resolve } from '$app/paths';
	import type { DemoSharing } from '$lib/demo-sharing.svelte';
	import { shareDateDetails, shareExpiryLabel, shareIsExpired } from '$lib/shares';

	let { sharing }: { sharing: DemoSharing } = $props();
	const state = $derived(sharing.state);
</script>

{#if state.shares.length > 0}
	<section
		aria-label="Share Links"
		class="relative z-30 max-h-[65dvh] shrink-0 overflow-y-auto border-t border-[var(--color-border)] bg-[var(--color-surface-0)] text-sm"
		style="padding-bottom: env(safe-area-inset-bottom)"
		transition:slide={{ duration: 180 }}
	>
		<div class="mx-auto w-full max-w-xl px-4 sm:px-6">
			<div id="saved-share-links">
				{#if state.expanded}
					<div
						class="border-b border-[var(--color-border)] py-1"
						transition:slide={{ duration: 180 }}
					>
						<ul
							class="max-h-[min(30dvh,18rem)] divide-y divide-[var(--color-border)] overflow-y-auto overscroll-contain"
						>
							{#each state.shares as share (share.id)}
								{@const expired = shareIsExpired(share, state.now)}
								<li class="flex items-center gap-3 py-2.5">
									<div class="min-w-0 flex-1">
										{#if expired}
											<p class="truncate text-xs text-[var(--color-muted)]" title={share.name}>
												{share.name}
											</p>
										{:else}
											<a
												href={resolve('/share/[id]', { id: share.id })}
												target="_blank"
												rel="noopener noreferrer"
												class="flex items-center gap-1 text-xs text-[var(--color-fg)] hover:underline"
												title={share.name}
											>
												<span class="min-w-0 truncate">{share.name}</span>
												<span class="shrink-0 text-[var(--color-muted)]" aria-hidden="true">↗</span>
												<span class="sr-only"> (opens in new tab)</span>
											</a>
										{/if}
										<p class="mt-1 text-[11px] text-[var(--color-muted)]">
											{(share.size / 1024 / 1024).toFixed(1)} MB ·
											<time datetime={share.expiresAt} title={shareDateDetails(share)}
												>{shareExpiryLabel(share.expiresAt, state.now)}</time
											>
										</p>
									</div>
									{#if !expired}<button
											type="button"
											class="inline-flex min-w-15 shrink-0 items-center justify-end gap-1 rounded py-1 text-xs transition-colors {state.copiedId ===
											share.id
												? 'text-[var(--color-success)]'
												: 'text-[var(--color-muted)] hover:text-[var(--color-fg)]'}"
											onclick={() => void sharing.copyLink(share)}
											disabled={state.deletingId === share.id}
											aria-label={`Copy share link for ${share.name}`}
											>{state.copiedId === share.id ? 'Copied' : 'Copy'}
											{#if state.copiedId === share.id}<svg
													class="size-3"
													viewBox="0 0 12 12"
													fill="none"
													aria-hidden="true"
													><path
														d="m2.5 6 2.25 2.25L9.5 3.5"
														stroke="currentColor"
														stroke-width="1.5"
														stroke-linecap="round"
														stroke-linejoin="round"
													/></svg
												>{/if}</button
										>{/if}
									<button
										type="button"
										class="shrink-0 rounded p-1.5 text-[var(--color-muted)] transition-colors hover:text-red-400 focus-visible:text-red-400 disabled:cursor-wait disabled:opacity-40"
										disabled={!!state.deletingId}
										aria-busy={state.deletingId === share.id}
										aria-label={share.deleteToken
											? `Delete shared demo ${share.name}`
											: `Remove ${share.name} from link history`}
										title={share.deleteToken
											? 'Delete uploaded demo and revoke its link'
											: 'Remove from history only — link stays available until expiry'}
										onclick={() => void sharing.requestDelete(share)}
									>
										<svg class="size-4" viewBox="0 0 24 24" fill="none" aria-hidden="true"
											><path
												d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"
												stroke="currentColor"
												stroke-width="1.7"
												stroke-linecap="round"
												stroke-linejoin="round"
											/></svg
										>
									</button>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			</div>
			<button
				type="button"
				aria-expanded={state.expanded}
				aria-controls="saved-share-links"
				title="Links saved in this browser"
				onclick={() => (state.expanded = !state.expanded)}
				class="flex w-full items-center justify-between gap-3 rounded py-3 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
			>
				<span>Share Links</span>
				<svg
					class="size-3 transition-transform duration-180 motion-reduce:transition-none {state.expanded
						? 'rotate-180'
						: ''}"
					viewBox="0 0 12 12"
					fill="none"
					aria-hidden="true"
					><path
						d="m3 7.5 3-3 3 3"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					/></svg
				>
			</button>
			<p
				class={state.copiedId || !state.copyMessage
					? 'sr-only'
					: 'pb-2.5 text-xs text-[var(--color-muted)]'}
				role="status"
			>
				{state.copyMessage}
			</p>
			{#if state.deleteError}<p class="pb-2.5 text-xs text-red-300/90" role="alert">
					{state.deleteError}
				</p>{/if}
		</div>
	</section>
{/if}
