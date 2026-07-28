<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, slide } from 'svelte/transition';
	import FileField from '$lib/components/FileField.svelte';
	import LoadingStatus from '$lib/components/LoadingStatus.svelte';
	import { listDemoPlayers, type DemoPlayer } from '$lib/demo/players';
	import { inspectMedia, type MediaInspection } from '$lib/media/tracks';

	let demoFile = $state<File | null>(null);
	let mediaFile = $state<File | null>(null);
	/** Seconds into the media until game start / GO. Empty until the user enters a value. */
	let mediaGameStart = $state<number | null>(null);
	let selectedPlayerId = $state('');
	let selectedSources = $state<string[]>([]);
	let notesOpen = $state(false);
	let generating = $state(false);
	let successMessage = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);
	let ready = $state(false);

	let players = $state<DemoPlayer[]>([]);
	let playersLoading = $state(false);
	let playersError = $state<string | null>(null);

	let mediaInfo = $state<MediaInspection | null>(null);
	let mediaLoading = $state(false);
	let mediaError = $state<string | null>(null);

	const selectedPlayer = $derived(
		players.find((p) => String(p.userId) === selectedPlayerId) ?? null
	);

	const canGenerate = $derived(
		!!demoFile &&
			!!mediaFile &&
			!!selectedPlayer &&
			selectedSources.length > 0 &&
			!generating &&
			!playersLoading &&
			!mediaLoading
	);

	onMount(() => {
		const id = requestAnimationFrame(() => {
			ready = true;
		});
		return () => cancelAnimationFrame(id);
	});

	async function setDemoFile(file: File | null) {
		demoFile = file;
		players = [];
		selectedPlayerId = '';
		playersError = null;
		successMessage = null;
		errorMessage = null;

		if (!file) return;

		playersLoading = true;
		try {
			players = await listDemoPlayers(file);
			if (players.length === 0) {
				playersError = 'No players found in this demo file.';
			} else {
				selectedPlayerId = String(players[0].userId);
			}
		} catch (e) {
			playersError = e instanceof Error ? e.message : 'Failed to read players from demo file.';
		} finally {
			playersLoading = false;
		}
	}

	async function setMediaFile(file: File | null) {
		mediaFile = file;
		mediaInfo = null;
		selectedSources = [];
		mediaError = null;
		mediaGameStart = null;
		successMessage = null;
		errorMessage = null;

		if (!file) return;

		mediaLoading = true;
		try {
			const info = await inspectMedia(file);
			mediaInfo = info;
			selectedSources = info.sources.filter((s) => s.defaultSelected).map((s) => s.id);
			if (info.sources.length === 0) {
				mediaError = info.summary || 'No audio sources found.';
			}
		} catch (e) {
			mediaError = e instanceof Error ? e.message : 'Failed to inspect media file.';
		} finally {
			mediaLoading = false;
		}
	}

	function toggleSource(id: string) {
		if (selectedSources.includes(id)) {
			selectedSources = selectedSources.filter((t) => t !== id);
		} else {
			selectedSources = [...selectedSources, id];
		}
	}

	function downloadName(name: string): string {
		const base = name.replace(/\.dem$/i, '');
		return `${base}_with_comms.dem`;
	}

	function playerLabel(player: DemoPlayer): string {
		const team = player.team ? ` · ${player.team}` : '';
		return `${player.name}${team}`;
	}

	async function onGenerate() {
		if (!canGenerate || !demoFile || !mediaFile || !selectedPlayer) return;

		generating = true;
		successMessage = null;
		errorMessage = null;

		// UI-only mock: no network upload yet. Real flow will convert → process → download.
		await new Promise((r) => setTimeout(r, 1250));

		const outName = downloadName(demoFile.name);
		const blob = new Blob(
			[
				`TF2 demo placeholder — ${outName}\n`,
				`speaker=${selectedPlayer.name} (${selectedPlayer.steamId})\n`,
				`mediaGameStart=${mediaGameStart ?? 0}\n`,
				`sources=${selectedSources.join(',')}\n`,
				`(mock output; no real processing)\n`
			],
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

	function sourceLegend(info: MediaInspection): string {
		return info.kind === 'channels' ? 'Audio channels' : 'Audio tracks';
	}
</script>

<main
	class="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-4 py-10 transition-opacity duration-500
		ease-out sm:px-6 sm:py-14
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
				Upload a demo file and external voice/video, mark when the game starts in your recording,
				choose tracks, then generate a modified <span class="text-[var(--color-fg)]">.dem</span>.
			</p>
		</header>

		<form
			class="flex flex-col gap-6"
			autocomplete="off"
			onsubmit={(e) => {
				e.preventDefault();
				void onGenerate();
			}}
		>
			<section class="flex flex-col gap-4">
				<FileField
					id="demo-file"
					label="Demo file"
					accept=".dem,application/octet-stream"
					helper="Team Fortress 2 .dem recording. Players are read in the browser when you select the file."
					file={demoFile}
					onchange={(f) => void setDemoFile(f)}
				/>

				<div class="flex flex-col gap-1.5">
					<label for="speaker" class="text-sm font-medium text-[var(--color-fg-strong)]">
						Speaker / player attribution
					</label>

					{#if playersLoading}
						<LoadingStatus label="Reading players…" />
					{:else if playersError}
						<p
							class="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-3 text-sm text-red-300/90"
							role="alert"
						>
							{playersError}
						</p>
					{:else if players.length > 0}
						<select
							id="speaker"
							bind:value={selectedPlayerId}
							class="w-full rounded border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-fg-strong)]
								focus:border-[var(--color-accent)] focus:ring-[var(--color-accent)]"
						>
							{#each players as player (player.userId)}
								<option value={String(player.userId)}
									>{playerLabel(player)} — {player.steamId}</option
								>
							{/each}
						</select>
						<p class="text-xs leading-relaxed text-[var(--color-muted)]">
							From this demo file’s userinfo. Injected voice is attributed to the selected player.
						</p>
					{:else}
						<p
							class="rounded border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-3 text-sm text-[var(--color-muted)]"
						>
							Select a demo file to load players.
						</p>
					{/if}
				</div>
			</section>

			<section class="flex flex-col gap-4">
				<FileField
					id="media-file"
					label="Audio / video"
					accept="video/mp4,audio/mpeg,audio/wav,audio/ogg,audio/webm,audio/flac,audio/x-m4a,.mp3,.wav,.ogg,.webm,.flac,.m4a,.mp4"
					helper="Tracks/channels are inspected locally from file metadata (not a full decode)."
					file={mediaFile}
					onchange={(f) => void setMediaFile(f)}
				/>

				<div class="flex flex-col gap-1.5">
					<label for="media-game-start" class="text-sm font-medium text-[var(--color-fg-strong)]">
						Game start in audio/video (seconds)
					</label>
					<input
						id="media-game-start"
						type="number"
						min="0"
						step="0.01"
						placeholder="e.g. 3"
						autocomplete="off"
						inputmode="decimal"
						bind:value={mediaGameStart}
						class="w-full rounded border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-fg-strong)] placeholder:text-[var(--color-muted)]
							focus:border-[var(--color-accent)] focus:ring-[var(--color-accent)]"
					/>
					<p class="text-xs leading-relaxed text-[var(--color-muted)]">
						How far into your recording until the game actually starts (end of “5, 4, 3, 2, 1…” /
						GO). Audio before this is skipped.
					</p>
				</div>

				<fieldset class="flex flex-col gap-1.5">
					<legend class="text-sm font-medium text-[var(--color-fg-strong)]">
						{mediaInfo ? sourceLegend(mediaInfo) : 'Audio channels / tracks'}
					</legend>

					{#if mediaLoading}
						<LoadingStatus label="Reading tracks…" />
					{:else if mediaError}
						<p
							class="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-3 text-sm text-red-300/90"
							role="alert"
						>
							{mediaError}
						</p>
					{:else if mediaInfo && mediaInfo.sources.length > 0}
						<div
							class="flex flex-col gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2"
							transition:fade={{ duration: 180 }}
						>
							{#each mediaInfo.sources as source (source.id)}
								<label
									class="flex cursor-pointer items-center gap-2.5 py-1.5 text-sm text-[var(--color-fg)]"
								>
									<input
										type="checkbox"
										checked={selectedSources.includes(source.id)}
										onchange={() => toggleSource(source.id)}
										class="rounded border-[var(--color-border-strong)] bg-[var(--color-surface-1)] text-[var(--color-accent)]
											focus:ring-[var(--color-accent)]"
									/>
									<span>{source.label}</span>
								</label>
							{/each}
						</div>
						<p class="text-xs text-[var(--color-muted)]">{mediaInfo.summary}</p>
					{:else}
						<p
							class="rounded border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-3 text-sm text-[var(--color-muted)]"
						>
							Select a media file to list available tracks or channels.
						</p>
					{/if}
				</fieldset>
			</section>

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
				<p class="mt-2 text-xs leading-relaxed text-[var(--color-muted)]">
					Nothing is uploaded yet — files stay in the browser. The real flow will convert selected
					audio, process locally (or on a worker), then download.
				</p>

				{#if successMessage}
					<p
						class="mt-3 text-sm text-[var(--color-success)]"
						role="status"
						transition:fade={{ duration: 200 }}
					>
						{successMessage}
					</p>
				{/if}
				{#if errorMessage}
					<p class="mt-3 text-sm text-red-300/90" role="alert">{errorMessage}</p>
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
				<li>Generate currently mocks download only — no processing yet.</li>
				<li>Track inspect reads MP4 metadata in chunks (not the whole video).</li>
				<li>Optional waveform / countdown helpers — deferred.</li>
			</ul>
		{/if}
	</footer>
</main>
