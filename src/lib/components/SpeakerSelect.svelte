<script lang="ts">
	import { teamDotStyle } from '$lib/demo/team';
	import type { DemoPlayer } from '$lib/demo/players';

	type Props = {
		id: string;
		players: DemoPlayer[];
		value: string;
	};

	let { id, players, value = $bindable() }: Props = $props();

	let open = $state(false);
	/** DOM refs — plain lets; only read from event handlers. */
	let rootEl: HTMLDivElement | null = null;
	let listEl: HTMLUListElement | null = null;
	/** Snapshot of committed value when the list opened (Escape restores). */
	let valueOnOpen = $state('');
	/** Keyboard highlight while open — does not commit `value`. */
	let highlightId = $state('');

	const selected = $derived(players.find((p) => String(p.userId) === value) ?? null);
	const selectedDot = $derived(teamDotStyle(selected?.team));

	function optionLabel(player: DemoPlayer): string {
		const team = player.team ? ` · ${player.team}` : '';
		return `${player.name}${team} — ${player.steamId}`;
	}

	function openList() {
		valueOnOpen = value;
		highlightId = value;
		open = true;
	}

	function closeList(opts?: { restore?: boolean; focusTrigger?: boolean }) {
		if (opts?.restore) value = valueOnOpen;
		open = false;
		if (opts?.focusTrigger) rootEl?.querySelector('button')?.focus();
	}

	function selectPlayer(player: DemoPlayer) {
		value = String(player.userId);
		highlightId = value;
		open = false;
	}

	function toggle() {
		if (open) {
			closeList();
		} else {
			openList();
		}
	}

	function onWindowPointerDown(e: PointerEvent) {
		if (!open || !rootEl) return;
		if (e.target instanceof Node && !rootEl.contains(e.target)) closeList();
	}

	function onWindowKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') closeList({ restore: true });
	}

	function onTriggerKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			if (!open) openList();
			queueMicrotask(() => focusActiveOption());
		} else if (e.key === 'Escape') {
			if (open) closeList({ restore: true });
		}
	}

	function onListKeydown(e: KeyboardEvent) {
		const idx = players.findIndex((p) => String(p.userId) === highlightId);
		if (e.key === 'Escape') {
			e.preventDefault();
			closeList({ restore: true, focusTrigger: true });
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			const next = players[Math.min(players.length - 1, Math.max(0, idx) + 1)];
			if (next) {
				highlightId = String(next.userId);
				focusActiveOption();
			}
			return;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			const prev = players[Math.max(0, (idx < 0 ? 0 : idx) - 1)];
			if (prev) {
				highlightId = String(prev.userId);
				focusActiveOption();
			}
			return;
		}
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			const highlighted = players.find((p) => String(p.userId) === highlightId);
			if (highlighted) selectPlayer(highlighted);
			else closeList({ focusTrigger: true });
			rootEl?.querySelector('button')?.focus();
		}
	}

	function focusActiveOption() {
		const el = listEl?.querySelector<HTMLElement>('[aria-selected="true"]');
		el?.focus();
	}

	function captureRoot(node: HTMLDivElement) {
		rootEl = node;
		return () => {
			if (rootEl === node) rootEl = null;
		};
	}

	function captureList(node: HTMLUListElement) {
		listEl = node;
		return () => {
			if (listEl === node) listEl = null;
		};
	}
</script>

<svelte:window
	onpointerdown={open ? onWindowPointerDown : undefined}
	onkeydown={open ? onWindowKeydown : undefined}
/>

<div class="relative" {@attach captureRoot}>
	<button
		type="button"
		{id}
		class="flex w-full items-center gap-2.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-1)]
			px-3 py-2 text-left text-sm text-[var(--color-fg)]
			hover:border-[var(--color-border-strong)]
			focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)] focus:outline-none"
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-controls="{id}-listbox"
		onclick={toggle}
		onkeydown={onTriggerKeydown}
	>
		{#if selectedDot}
			<span
				class="size-2 shrink-0 rounded-full"
				style={selectedDot}
				aria-hidden="true"
			></span>
		{/if}
		<span class="min-w-0 flex-1 truncate">{selected?.name ?? 'Select speaker'}</span>
		<span class="shrink-0 text-[var(--color-muted)]" aria-hidden="true">{open ? '▴' : '▾'}</span>
	</button>

	{#if open}
		<ul
			{@attach captureList}
			id="{id}-listbox"
			class="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded border border-[var(--color-border)]
				bg-[var(--color-surface-2)] py-1 shadow-lg"
			role="listbox"
			aria-labelledby={id}
			tabindex="-1"
			onkeydown={onListKeydown}
		>
			{#each players as player (player.userId)}
				{@const dot = teamDotStyle(player.team)}
				{@const selectedOpt = String(player.userId) === highlightId}
				<li role="presentation">
					<button
						type="button"
						role="option"
						aria-selected={selectedOpt}
						class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm
							hover:bg-[var(--color-surface-3)] focus:bg-[var(--color-surface-3)] focus:outline-none
							{selectedOpt ? 'text-[var(--color-fg-strong)]' : 'text-[var(--color-fg)]'}"
						onclick={() => selectPlayer(player)}
					>
						<span
							class="size-2 shrink-0 rounded-full {dot ? '' : 'bg-transparent'}"
							style={dot ?? undefined}
							aria-hidden="true"
						></span>
						<span class="min-w-0 truncate">{optionLabel(player)}</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
