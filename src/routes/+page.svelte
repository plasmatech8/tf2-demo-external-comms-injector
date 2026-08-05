<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, slide } from 'svelte/transition';
	import FileField from '$lib/components/FileField.svelte';
	import Hint from '$lib/components/Hint.svelte';
	import LoadingStatus from '$lib/components/LoadingStatus.svelte';
	import { listDemoPlayers, type DemoPlayer } from '$lib/demo/players';
	import { previewAroundGameStart, type PreviewHandle } from '$lib/media/preview';
	import { previewMediaSource, primeAudioContext } from '$lib/media/source-preview';
	import { inspectMedia, type MediaInspection, type MediaSource } from '$lib/media/tracks';

	let demoFile = $state<File | null>(null);
	let mediaFile = $state<File | null>(null);
	/** Seconds into the media until game start / GO. Defaults to 5. */
	let mediaGameStart = $state<number | null>(5);
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

	let previewing = $state(false);
	let previewHandle = $state<PreviewHandle | null>(null);
	let sourcePreviewId = $state<string | null>(null);
	let sourcePreviewLoadingId = $state<string | null>(null);
	let sourcePreviewHandle = $state<PreviewHandle | null>(null);
	/** Bumped to ignore stale async demo/media/preview completions. */
	let demoLoadGen = 0;
	let mediaLoadGen = 0;
	let sourcePreviewGen = 0;
	let gameStartPreviewGen = 0;

	const selectedPlayer = $derived(
		players.find((p) => String(p.userId) === selectedPlayerId) ?? null
	);

	const gameStartValid = $derived(
		mediaGameStart !== null && Number.isFinite(mediaGameStart) && mediaGameStart >= 0
	);

	const showGameStartNeeded = $derived(!!mediaFile && !gameStartValid);

	const canGenerate = $derived(
		!!demoFile &&
			!!mediaFile &&
			!!selectedPlayer &&
			selectedSources.length > 0 &&
			gameStartValid &&
			!generating &&
			!playersLoading &&
			!mediaLoading
	);

	onMount(() => {
		const id = requestAnimationFrame(() => {
			ready = true;
		});
		return () => {
			cancelAnimationFrame(id);
			previewHandle?.stop();
			sourcePreviewHandle?.stop();
		};
	});

	function stopPreview() {
		gameStartPreviewGen += 1;
		previewHandle?.stop();
		previewHandle = null;
		previewing = false;
	}

	function stopSourcePreview() {
		sourcePreviewGen += 1;
		sourcePreviewHandle?.stop();
		sourcePreviewHandle = null;
		sourcePreviewId = null;
		sourcePreviewLoadingId = null;
	}

	async function onSourcePreview(source: MediaSource) {
		if (!mediaFile) return;
		if (sourcePreviewId === source.id || sourcePreviewLoadingId === source.id) {
			stopSourcePreview();
			return;
		}
		stopPreview();
		stopSourcePreview();
		const token = (sourcePreviewGen += 1);
		sourcePreviewLoadingId = source.id;
		const requestFile = mediaFile;
		const primed = primeAudioContext();
		try {
			const handle = await previewMediaSource(
				requestFile,
				source,
				() => {
					if (token !== sourcePreviewGen) return;
					sourcePreviewHandle = null;
					sourcePreviewId = null;
					sourcePreviewLoadingId = null;
				},
				primed
			);
			if (token !== sourcePreviewGen || mediaFile !== requestFile) {
				handle.stop();
				if (primed && primed.state !== 'closed') void primed.close().catch(() => undefined);
				return;
			}
			sourcePreviewHandle = handle;
			sourcePreviewId = source.id;
			sourcePreviewLoadingId = null;
			errorMessage = null;
		} catch (e) {
			if (token !== sourcePreviewGen) return;
			sourcePreviewLoadingId = null;
			sourcePreviewId = null;
			if (primed && primed.state !== 'closed') void primed.close().catch(() => undefined);
			errorMessage = e instanceof Error ? e.message : 'Track preview failed.';
		}
	}

	function onGameStartInput(e: Event) {
		const v = (e.currentTarget as HTMLInputElement).valueAsNumber;
		mediaGameStart = Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
	}

	async function onPreview() {
		if (!mediaFile || !gameStartValid || mediaGameStart === null) return;
		stopSourcePreview();
		stopPreview();
		const token = (gameStartPreviewGen += 1);
		const requestFile = mediaFile;
		const requestStart = mediaGameStart;
		previewing = true;
		try {
			const handle = await previewAroundGameStart(requestFile, requestStart, () => {
				if (token !== gameStartPreviewGen) return;
				previewing = false;
				previewHandle = null;
			});
			if (
				token !== gameStartPreviewGen ||
				mediaFile !== requestFile ||
				mediaGameStart !== requestStart
			) {
				handle.stop();
				return;
			}
			previewHandle = handle;
			errorMessage = null;
		} catch (e) {
			if (token !== gameStartPreviewGen) return;
			previewing = false;
			errorMessage = e instanceof Error ? e.message : 'Preview failed.';
		}
	}

	async function setDemoFile(file: File | null) {
		const token = (demoLoadGen += 1);
		demoFile = file;
		players = [];
		selectedPlayerId = '';
		playersError = null;
		successMessage = null;
		errorMessage = null;

		if (!file) {
			playersLoading = false;
			return;
		}

		playersLoading = true;
		try {
			const nextPlayers = await listDemoPlayers(file);
			if (token !== demoLoadGen || demoFile !== file) return;
			players = nextPlayers;
			if (nextPlayers.length === 0) {
				playersError = 'No players found in this demo file.';
			} else {
				selectedPlayerId = String(nextPlayers[0].userId);
			}
		} catch (e) {
			if (token !== demoLoadGen || demoFile !== file) return;
			playersError = e instanceof Error ? e.message : 'Failed to read players from demo file.';
		} finally {
			if (token === demoLoadGen) playersLoading = false;
		}
	}

	async function setMediaFile(file: File | null) {
		const token = (mediaLoadGen += 1);
		stopPreview();
		stopSourcePreview();
		mediaFile = file;
		mediaInfo = null;
		selectedSources = [];
		mediaError = null;
		mediaGameStart = file ? 5 : null;
		successMessage = null;
		errorMessage = null;

		if (!file) {
			mediaLoading = false;
			return;
		}

		mediaLoading = true;
		try {
			const info = await inspectMedia(file);
			if (token !== mediaLoadGen || mediaFile !== file) return;
			mediaInfo = info;
			selectedSources = info.sources.filter((s) => s.defaultSelected).map((s) => s.id);
			if (info.sources.length === 0) {
				mediaError = info.summary || 'No audio sources found.';
			}
		} catch (e) {
			if (token !== mediaLoadGen || mediaFile !== file) return;
			mediaError = e instanceof Error ? e.message : 'Failed to inspect media file.';
		} finally {
			if (token === mediaLoadGen) mediaLoading = false;
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
		if (!canGenerate || !demoFile || !mediaFile || !selectedPlayer || !gameStartValid) return;

		generating = true;
		successMessage = null;
		errorMessage = null;

		await new Promise((r) => setTimeout(r, 1250));

		const outName = downloadName(demoFile.name);
		const blob = new Blob(
			[
				`TF2 demo placeholder — ${outName}\n`,
				`speaker=${selectedPlayer.name} (${selectedPlayer.steamId})\n`,
				`mediaGameStart=${mediaGameStart}\n`,
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
		</header>

		<form
			class="flex flex-col gap-8"
			autocomplete="off"
			onsubmit={(e) => {
				e.preventDefault();
				void onGenerate();
			}}
		>
			<div class="flex flex-col gap-3">
				<FileField
					id="demo-file"
					label="Demo file"
					prominent
					accept=".dem,application/octet-stream"
					file={demoFile}
					onchange={(f) => void setDemoFile(f)}
				/>

				{#if demoFile}
					<div
						class="ml-1 flex flex-col gap-1.5 border-l border-[var(--color-border)] pl-4"
						transition:slide={{ duration: 160 }}
					>
						<div class="inline-flex items-center gap-1.5">
							<label for="speaker" class="text-sm font-medium text-[var(--color-muted)]">
								Speaker
							</label>
							<Hint text="Who the injected voice belongs to in this demo." />
						</div>

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
								class="w-full rounded border-[var(--color-border)] bg-[var(--color-surface-1)] text-sm text-[var(--color-fg)]
									focus:border-[var(--color-accent)] focus:ring-[var(--color-accent)]"
							>
								{#each players as player (player.userId)}
									<option value={String(player.userId)}
										>{playerLabel(player)} — {player.steamId}</option
									>
								{/each}
							</select>
						{/if}
					</div>
				{/if}
			</div>

			<div class="flex flex-col gap-3">
				<FileField
					id="media-file"
					label="Audio / video"
					prominent
					accept="video/mp4,audio/mpeg,audio/wav,audio/ogg,audio/webm,audio/flac,audio/x-m4a,.mp3,.wav,.ogg,.webm,.flac,.m4a,.mp4"
					file={mediaFile}
					onchange={(f) => void setMediaFile(f)}
				/>

				{#if mediaFile}
					<div
						class="ml-1 flex flex-col gap-4 border-l border-[var(--color-border)] pl-4"
						transition:slide={{ duration: 160 }}
					>
						<div class="flex flex-col gap-1.5">
							<div class="inline-flex items-center gap-1.5">
								<label for="media-game-start" class="text-sm font-medium text-[var(--color-muted)]">
									Game start (seconds)
								</label>
								<Hint
									text="Seconds into the recording until GO / end of the countdown. Earlier audio is skipped."
								/>
							</div>
							<input
								id="media-game-start"
								type="number"
								min="0"
								step="0.1"
								required
								placeholder="e.g. 5.0"
								autocomplete="off"
								inputmode="decimal"
								value={mediaGameStart === null ? '' : mediaGameStart.toFixed(1)}
								oninput={onGameStartInput}
								aria-invalid={showGameStartNeeded}
								class="w-full rounded border bg-[var(--color-surface-1)] text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)]
									focus:border-[var(--color-accent)] focus:ring-[var(--color-accent)]
									{showGameStartNeeded ? 'border-red-400/50' : 'border-[var(--color-border)]'}"
							/>

							<div class="flex flex-wrap items-center gap-2 pt-0.5">
								<button
									type="button"
									class="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs tracking-wide text-[var(--color-fg)]
										hover:border-[var(--color-border-strong)] disabled:cursor-not-allowed disabled:opacity-40"
									disabled={!gameStartValid || !mediaFile}
									onclick={() => (previewing ? stopPreview() : void onPreview())}
								>
									{previewing ? 'Stop preview' : 'Preview ±5s'}
								</button>
							</div>

							{#if showGameStartNeeded}
								<p class="text-xs text-red-300/90" role="alert">Enter when the game starts.</p>
							{/if}
						</div>

						<div class="flex flex-col gap-1.5">
							<p
								class="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-muted)]"
								id="tracks-label"
							>
								{mediaInfo ? sourceLegend(mediaInfo) : 'Tracks'}
								{#if mediaInfo?.summary}
									<Hint text={mediaInfo.summary} label="Track details" />
								{/if}
							</p>

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
									class="flex flex-col gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2"
									role="group"
									aria-labelledby="tracks-label"
									transition:fade={{ duration: 180 }}
								>
									{#each mediaInfo.sources as source (source.id)}
										<div class="flex items-center gap-2 py-1">
											<label
												class="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-sm text-[var(--color-fg)]"
											>
												<input
													type="checkbox"
													checked={selectedSources.includes(source.id)}
													onchange={() => toggleSource(source.id)}
													class="rounded border-[var(--color-border-strong)] bg-[var(--color-surface-2)] text-[var(--color-accent)]
														focus:ring-[var(--color-accent)]"
												/>
												<span class="truncate">{source.label}</span>
											</label>
											<button
												type="button"
												class="shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[10px] tracking-wide text-[var(--color-muted)] uppercase
													hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-40"
												aria-label={sourcePreviewId === source.id
													? `Stop preview of ${source.label}`
													: `Preview ${source.label}`}
												disabled={sourcePreviewLoadingId !== null &&
													sourcePreviewLoadingId !== source.id}
												onclick={() => void onSourcePreview(source)}
											>
												{sourcePreviewLoadingId === source.id
													? '…'
													: sourcePreviewId === source.id
														? 'Stop'
														: 'Play'}
											</button>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				{/if}
			</div>

			<div>
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
				<li>
					Generate currently mocks download only — no processing yet. Files stay in the browser.
				</li>
				<li>Track inspect reads MP4 metadata in chunks (not the whole video).</li>
			</ul>
		{/if}
	</footer>
</main>
