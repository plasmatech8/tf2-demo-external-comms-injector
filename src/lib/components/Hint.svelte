<script lang="ts">
	type Props = {
		/** Short help text shown on hover / focus. */
		text: string;
		label?: string;
	};

	let { text, label = 'More info' }: Props = $props();
</script>

<span class="hint relative inline-flex align-middle">
	<button
		type="button"
		class="inline-flex size-4 items-center justify-center rounded-full border border-[var(--color-border-strong)]
			text-[10px] leading-none font-semibold text-[var(--color-muted)]
			hover:border-[var(--color-muted)] hover:text-[var(--color-fg)]
			focus:border-[var(--color-accent)] focus:text-[var(--color-fg)] focus:outline-none"
		aria-label={label}
		onclick={(e) => e.stopPropagation()}
	>
		?
	</button>
	<span
		role="tooltip"
		class="pointer-events-none absolute bottom-[calc(100%+0.4rem)] left-1/2 z-20 w-max max-w-[14rem] -translate-x-1/2
			rounded border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2.5 py-1.5 text-left text-xs
			leading-snug font-normal tracking-normal text-[var(--color-fg)] normal-case opacity-0 shadow-lg
			transition-opacity duration-100
			[.hint:focus-within_&]:opacity-100 [.hint:hover_&]:opacity-100"
	>
		{text}
	</span>
</span>
