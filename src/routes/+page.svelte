<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, slide } from 'svelte/transition';
	import FileField from '$lib/components/FileField.svelte';

	type MockTrack = {
		id: string;
		label: string;
		defaultSelected: boolean;
	};

	const MOCK_TRACKS: MockTrack[] = [
		{ id: '1', label: 'Track 1 — All Audio', defaultSelected: false },
		{ id: '2', label: 'Track 2 — Game', defaultSelected: false },
		{ id: '3', label: 'Track 3 — Discord', defaultSelected: true },
		{ id: '4', label: 'Track 4 — Mic', defaultSelected: true }
	];

	const DEFAULT_TRACK_IDS = MOCK_TRACKS.filter((t) => t.defaultSelected).map((t) => t.id);

	let demoFile = $state<File | null>(null);
	let mediaFile = $state<File | null>(null);
	let offset = $state(0);
	let speaker = $state('');
	let selectedTracks = $state<string[]>([]);
	let notesOpen = $state(false);
	let generating = $state(false);
	let successMessage = $state<string | null>(null);
	let ready = $state(false);

	const canGenerate = $derived(!!demoFile && !!mediaFile && !generating);

	onMount(() => {
		const id = requestAnimationFrame(() => {
			ready = true;
		});
		return () => cancelAnimationFrame(id);
	});

	function setMediaFile(file: File | null) {
		mediaFile = file;
		selectedTracks = file ? [...DEFAULT_TRACK_IDS] : [];
		successMessage = null;
	}

	function toggleTrack(id: string) {
		if (selectedTracks.includes(id)) {
			selectedTracks = selectedTracks.filter((t) => t !== id);
		} else {
			selectedTracks = [...selectedTracks, id];
		}
	}

	function downloadName(name: string): string {
		const base = name.replace(/\.dem$/i, '');
		return `${base}_with_comms.dem`;
	}

	async function onGenerate() {
		if (!demoFile || !mediaFile || generating) return;

		generating = true;
		successMessage = null;

		await new Promise((r) => setTimeout(r, 1250));

		const outName = downloadName(demoFile.name);
		const blob = new Blob(
			[`TF2 demo placeholder — ${outName}\n(mock output; no real processing)\n`],
			{ type: 'application/octet-stream' }
		);
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = outName;
		a.click();
		URL.revokeObjectURL(url);

		generating = false;
		successMessage = `Downloaded ${outName}`;
	}
</script>

<main
	class="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-4 py-10 sm:px-6 sm:py-14
		transition-opacity duration-500 ease-out
		{ready ? 'opacity-100' : 'opacity-0'}"
>
	<div class="flex-1">
		<header class="mb-8 sm:mb-10">
			<h1
				class="font-[family-name:var(--font-display)] text-[2.75rem] leading-[0.95] font-bold tracking-wide text-[var(--color-fg-strong)] uppercase sm:text-5xl"
			>
				TF2 Demo File
			</h1>
			<p
				class="mt-2 font-[family-name:var(--font-display)] text-lg font-medium tracking-wide text-[var(--color-muted)] uppercase sm:text-xl"
			>
				External Comms Audio Injection Tool
			</p>
			<p class="mt-4 max-w-md text-sm leading-relaxed text-[var(--color-muted)]">
				Upload a demo and external voice/video, set when the countdown should sync, pick tracks to
				keep, then generate a modified <span class="text-[var(--color-fg)]">.dem</span> for download.
			</p>
		</header>

		<form
			class="flex flex-col gap-6"
			onsubmit={(e) => {
				e.preventDefault();
				void onGenerate();
			}}
		>
			<FileField
				id="demo-file"
				label="Demo file"
				accept=".dem,application/octet-stream"
				helper="Team Fortress 2 .dem recording."
				file={demoFile}
				onchange={(f) => {
					demoFile = f;
					successMessage = null;
				}}
			/>

			<FileField
				id="media-file"
				label="Audio / video"
				accept="video/mp4,audio/mpeg,audio/wav,audio/ogg,audio/webm,audio/flac,audio/x-m4a,.mp3,.wav,.ogg,.webm,.flac,.m4a,.mp4"
				helper="Conversion to 24 kHz mono WAV happens client-side before processing."
				file={mediaFile}
				onchange={setMediaFile}
			/>

			<div class="flex flex-col gap-1.5">
				<label for="offset" class="text-sm font-medium text-[var(--color-fg-strong)]">
					Countdown / inject start offset (seconds)
				</label>
				<input
					id="offset"
					type="number"
					min="0"
					step="0.01"
					bind:value={offset}
					class="w-full rounded border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-fg-strong)]
						focus:border-[var(--color-accent)] focus:ring-[var(--color-accent)]"
				/>
				<p class="text-xs leading-relaxed text-[var(--color-muted)]">
					When the video/audio countdown ("5, 4, 3, 2, 1…") should sync with the demo.
				</p>
			</div>

			<fieldset class="flex flex-col gap-1.5">
				<legend class="text-sm font-medium text-[var(--color-fg-strong)]">
					Audio channels / tracks
				</legend>

				{#if mediaFile}
					<div
						class="flex flex-col gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2"
						transition:fade={{ duration: 180 }}
					>
						{#each MOCK_TRACKS as track (track.id)}
							<label
								class="flex cursor-pointer items-center gap-2.5 py-1.5 text-sm text-[var(--color-fg)]"
							>
								<input
									type="checkbox"
									checked={selectedTracks.includes(track.id)}
									onchange={() => toggleTrack(track.id)}
									class="rounded border-[var(--color-border-strong)] bg-[var(--color-surface-1)] text-[var(--color-accent)]
										focus:ring-[var(--color-accent)]"
								/>
								<span>{track.label}</span>
							</label>
						{/each}
					</div>
				{:else}
					<p
						class="rounded border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-3 text-sm text-[var(--color-muted)]"
					>
						Select a media file to list available tracks.
					</p>
				{/if}
			</fieldset>

			<div class="flex flex-col gap-1.5">
				<label for="speaker" class="text-sm font-medium text-[var(--color-fg-strong)]">
					Speaker / player attribution
				</label>
				<input
					id="speaker"
					type="text"
					placeholder="plasmatech8"
					autocomplete="off"
					bind:value={speaker}
					class="w-full rounded border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-fg-strong)] placeholder:text-[var(--color-muted)]
						focus:border-[var(--color-accent)] focus:ring-[var(--color-accent)]"
				/>
				<p class="text-xs leading-relaxed text-[var(--color-muted)]">
					Player name substring for the injector CLI. SteamID / client index support can come later.
				</p>
			</div>

			<div class="pt-1">
				<button
					type="submit"
					disabled={!canGenerate}
					class="w-full rounded border border-transparent bg-[var(--color-accent)] px-4 py-3
						font-[family-name:var(--font-display)] text-lg font-semibold tracking-wider text-[var(--color-fg-strong)] uppercase
						transition-[background-color,transform,opacity] duration-150
						enabled:hover:bg-[var(--color-accent-hover)] enabled:active:scale-[0.98]
						disabled:cursor-not-allowed disabled:opacity-40"
				>
					{#if generating}
						Generating…
					{:else}
						Generate &amp; download
					{/if}
				</button>

				{#if successMessage}
					<p
						class="mt-3 text-sm text-[var(--color-success)]"
						role="status"
						transition:fade={{ duration: 200 }}
					>
						{successMessage}
					</p>
				{/if}
			</div>
		</form>
	</div>

	<footer class="mt-10 border-t border-[var(--color-border)] pt-6 pb-2">
		<button
			type="button"
			class="flex w-full items-center justify-between text-left text-xs tracking-wide text-[var(--color-muted)] uppercase
				hover:text-[var(--color-fg)]"
			aria-expanded={notesOpen}
			onclick={() => (notesOpen = !notesOpen)}
		>
			<span>Notes / coming soon</span>
			<span aria-hidden="true">{notesOpen ? '−' : '+'}</span>
		</button>

		{#if notesOpen}
			<ul
				class="mt-3 list-disc space-y-1 pl-4 text-xs leading-relaxed text-[var(--color-muted)]"
				transition:slide={{ duration: 160 }}
			>
				<li>Target format path: 24 kHz mono WAV (and optional Opus) still TBD.</li>
				<li>Optional countdown auto-detect from media — not wired yet.</li>
				<li>Optional waveform / offset preview — deferred.</li>
			</ul>
		{/if}
	</footer>
</main>
