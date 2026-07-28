<script lang="ts">
	type Props = {
		label: string;
	};

	let { label }: Props = $props();
</script>

<p
	class="flex items-center gap-2.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-3 text-sm text-[var(--color-muted)]"
	role="status"
	aria-live="polite"
>
	<span
		class="inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--color-border-strong)] border-t-[var(--color-accent)]"
		aria-hidden="true"
	></span>
	<span>{label}</span>
</p>
