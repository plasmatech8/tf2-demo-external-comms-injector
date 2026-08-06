<script lang="ts">
	type Props = {
		/** Progress from 0–100. */
		value: number;
		/** Short status shown above the bar (also used as aria-label). */
		label: string;
	};

	let { value, label }: Props = $props();

	const clamped = $derived(Math.min(100, Math.max(0, value)));
	const now = $derived(Math.round(clamped));
</script>

<div
	class="flex flex-col gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-3"
>
	<div class="flex items-baseline justify-between gap-3 text-sm">
		<span class="min-w-0 truncate text-[var(--color-muted)]">{label}</span>
		<span class="shrink-0 tabular-nums text-[var(--color-muted)]">{now}%</span>
	</div>
	<div
		class="h-1.5 w-full overflow-hidden rounded-sm bg-[var(--color-border)]"
		role="progressbar"
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={now}
		aria-label={label}
	>
		<div
			class="h-full rounded-sm bg-[var(--color-accent)] transition-[width] duration-200 ease-out"
			style:width="{clamped}%"
		></div>
	</div>
</div>
