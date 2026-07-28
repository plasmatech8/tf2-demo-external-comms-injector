<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';

	type Props = {
		id: string;
		label: string;
		accept: string;
		helper?: string;
		file: File | null;
		onchange: (file: File | null) => void;
	} & Omit<HTMLInputAttributes, 'id' | 'type' | 'accept' | 'onchange'>;

	let {
		id,
		label,
		accept,
		helper,
		file,
		onchange,
		...rest
	}: Props = $props();

	let dragging = $state(false);

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	}

	function pick(list: FileList | null) {
		const next = list?.[0] ?? null;
		onchange(next);
	}

	function onInput(e: Event) {
		const target = e.currentTarget as HTMLInputElement;
		pick(target.files);
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		pick(e.dataTransfer?.files ?? null);
	}
</script>

<div class="flex flex-col gap-1.5">
	<label for={id} class="text-sm font-medium text-[var(--color-fg-strong)]">{label}</label>

	<div
		class="relative rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] transition-[border-color,background-color] duration-200
			{dragging ? 'border-[var(--color-accent)] bg-[var(--color-surface-3)]' : ''}
			{file ? 'border-[var(--color-border-strong)]' : ''}"
		ondragenter={(e) => {
			e.preventDefault();
			dragging = true;
		}}
		ondragover={(e) => {
			e.preventDefault();
			dragging = true;
		}}
		ondragleave={() => {
			dragging = false;
		}}
		ondrop={onDrop}
		role="presentation"
	>
		<input
			{id}
			type="file"
			{accept}
			class="absolute inset-0 z-10 cursor-pointer opacity-0"
			onchange={onInput}
			{...rest}
		/>

		<div class="pointer-events-none flex min-h-[3.25rem] items-center justify-between gap-3 px-3 py-2.5">
			{#if file}
				<div class="min-w-0 transition-opacity duration-200">
					<p class="truncate text-sm text-[var(--color-fg-strong)]">{file.name}</p>
					<p class="text-xs text-[var(--color-muted)]">{formatSize(file.size)}</p>
				</div>
				<span class="shrink-0 text-xs tracking-wide text-[var(--color-muted)] uppercase"
					>Change</span
				>
			{:else}
				<p class="text-sm text-[var(--color-muted)]">
					Drop a file here, or click to browse
				</p>
			{/if}
		</div>
	</div>

	{#if helper}
		<p class="text-xs leading-relaxed text-[var(--color-muted)]">{helper}</p>
	{/if}
</div>
