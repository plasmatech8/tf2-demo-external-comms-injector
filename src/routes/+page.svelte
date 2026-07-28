<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, slide } from 'svelte/transition';
	import FileField from '$lib/components/FileField.svelte';
	import Hint from '$lib/components/Hint.svelte';
	import LoadingStatus from '$lib/components/LoadingStatus.svelte';
	import { listDemoPlayers, type DemoPlayer } from '$lib/demo/players';
	import { detectCountdownGameStart, primeAudioContext } from '$lib/media/countdown';
	import { previewAroundGameStart, type PreviewHandle } from '$lib/media/preview';
	import { previewMediaSource } from '$lib/media/source-preview';
	import { inspectMedia, type MediaInspection, type MediaSource } from '$lib/media/tracks';

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

	let countdownLoading = $state(false);
	let countdownDone = $state(false);
	let countdownNote = $state<string | null>(null);
	let countdownDetail = $state<string | null>(null);
	let detectAbort: AbortController | null = null;
	let previewing = $state(false);
	let previewHandle = $state<PreviewHandle | null>(null);
	let sourcePreviewId = $state<string | null>(null);
	let sourcePreviewHandle = $state<PreviewHandle | null>(null);

	const selectedPlayer = $derived(
		players.find((p) => String(p.userId) === selectedPlayerId) ?? null
	);

	const gameStartValid = $derived(
		mediaGameStart !== null && Number.isFinite(mediaGameStart) && mediaGameStart >= 0
	);

	const showGameStartNeeded = $derived(
		!!mediaFile && countdownDone && !countdownLoading && !gameStartValid
	);

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
		previewHandle?.stop();
		previewHandle = null;
		previewing = false;
	}

	function stopSourcePreview() {
		sourcePreviewHandle?.stop();
		sourcePreviewHandle = null;
		sourcePreviewId = null;
	}

	async function onSourcePreview(source: MediaSource) {
		if (!mediaFile) return;
		if (sourcePreviewId === source.id) {
			stopSourcePreview();
			return;
		}
		stopPreview();
		stopSourcePreview();
		sourcePreviewId = source.id;
		try {
			sourcePreviewHandle = await previewMediaSource(mediaFile, source, () => {
				sourcePreviewHandle = null;
				sourcePreviewId = null;
			});
		} catch (e) {
			sourcePreviewId = null;
			errorMessage = e instanceof Error ? e.message : 'Track preview failed.';
		}
	}

	function cancelCountdownDetect() {
		detectAbort?.abort();
	}

	async function runCountdownDetect(file: File, primed: AudioContext | null = null) {
		detectAbort?.abort();
		const abort = new AbortController();
		detectAbort = abort;

		countdownLoading = true;
		countdownDone = false;
		countdownNote = null;
		countdownDetail = null;
		try {
			const hit = await detectCountdownGameStart(file, primed, abort.signal);
			if (abort.signal.aborted) return;
			if (hit.ok) {
				mediaGameStart = hit.gameStartSec;
				countdownNote = `~${hit.gameStartSec}s · ${hit.confidence}`;
				countdownDetail = hit.detail;
			} else {
				countdownNote = 'Not found — set manually';
				countdownDetail = hit.detail;
			}
		} catch (e) {
			if (abort.signal.aborted || (e instanceof Error && e.name === 'AbortError')) {
				countdownNote = 'Cancelled — set manually';
				countdownDetail = 'Countdown detection was cancelled.';
				return;
			}
			countdownNote = 'Detect failed — set manually';
			countdownDetail =
				e instanceof Error ? e.message : 'Countdown detection failed — set game start manually.';
		} finally {
			if (detectAbort === abort) detectAbort = null;
			countdownLoading = false;
			countdownDone = true;
			if (primed && primed.state !== 'closed') {
				void primed.close().catch(() => undefined);
			}
		}
	}

	function onGameStartInput(e: Event) {
		const v = (e.currentTarget as HTMLInputElement).valueAsNumber;
		mediaGameStart = Number.isFinite(v) ? v : null;
	}

	async function onPreview() {
		if (!mediaFile || !gameStartValid || mediaGameStart === null) return;
		stopSourcePreview();
		stopPreview();
		previewing = true;
		try {
			previewHandle = await previewAroundGameStart(mediaFile, mediaGameStart, () => {
				previewing = false;
				previewHandle = null;
			});
		} catch (e) {
			previewing = false;
			errorMessage = e instanceof Error ? e.message : 'Preview failed.';
		}
	}

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
		stopPreview();
		stopSourcePreview();
		cancelCountdownDetect();
		mediaFile = file;
		mediaInfo = null;
		selectedSources = [];
		mediaError = null;
		mediaGameStart = null;
		countdownNote = null;
		countdownDetail = null;
		countdownDone = false;
		successMessage = null;
		errorMessage = null;

		if (!file) return;

		// Unlock audio during the file-picker gesture so large MP4 head-capture can play().
		const primed = primeAudioContext();
		mediaLoading = true;
		countdownLoading = true;

		const detectPromise = runCountdownDetect(file, primed);

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

		await detectPromise;
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
									text="Seconds into the recording until GO / end of countdown. Earlier audio is skipped. Auto-detected from TF2 announcer lines."
								/>
							</div>
							<input
								id="media-game-start"
								type="number"
								min="0"
								step="0.01"
								required
								placeholder="e.g. 3"
								autocomplete="off"
								inputmode="decimal"
								value={mediaGameStart ?? ''}
								oninput={onGameStartInput}
								disabled={countdownLoading}
								aria-invalid={showGameStartNeeded}
								class="w-full rounded border bg-[var(--color-surface-1)] text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)]
									focus:border-[var(--color-accent)] focus:ring-[var(--color-accent)]
									disabled:cursor-not-allowed disabled:opacity-55
									{showGameStartNeeded ? 'border-red-400/50' : 'border-[var(--color-border)]'}"
							/>

							{#if countdownLoading}
								<div class="flex flex-wrap items-center gap-2">
									<LoadingStatus label="Detecting countdown…" />
									<button
										type="button"
										class="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs tracking-wide text-[var(--color-fg)] uppercase
											hover:border-[var(--color-border-strong)]"
										onclick={cancelCountdownDetect}
									>
										Cancel
									</button>
								</div>
							{:else if countdownNote}
								<p
									class="inline-flex items-center gap-1.5 text-xs text-[var(--color-muted)]"
									role="status"
								>
									{countdownNote}
									{#if countdownDetail}
										<Hint text={countdownDetail} label="Detection details" />
									{/if}
								</p>
							{/if}

							<div class="flex flex-wrap items-center gap-2 pt-0.5">
								<button
									type="button"
									class="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs tracking-wide text-[var(--color-fg)] uppercase
										hover:border-[var(--color-border-strong)] disabled:cursor-not-allowed disabled:opacity-40"
									disabled={!mediaFile || countdownLoading}
									onclick={() => {
										if (!mediaFile) return;
										void runCountdownDetect(mediaFile, primeAudioContext());
									}}
								>
									Re-detect
								</button>
								<button
									type="button"
									class="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs tracking-wide text-[var(--color-fg)] uppercase
										hover:border-[var(--color-border-strong)] disabled:cursor-not-allowed disabled:opacity-40"
									disabled={!gameStartValid || !mediaFile || countdownLoading}
									onclick={() => (previewing ? stopPreview() : void onPreview())}
								>
									{previewing ? 'Stop preview' : 'Preview ±5s'}
								</button>
								<Hint
									text="Preview plays 5s before/after game start with a soft mid 0.45s beep on the marker."
								/>
							</div>

							{#if showGameStartNeeded && !countdownNote}
								<p class="text-xs text-red-300/90" role="alert">Enter when the game starts.</p>
							{/if}
						</div>

						<div class="flex flex-col gap-1.5">
							<p
								class="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-muted)]"
								id="tracks-label"
							>
								{mediaInfo ? sourceLegend(mediaInfo) : 'Tracks'}
								<Hint
									text={mediaInfo?.summary
										? `${mediaInfo.summary} Use Play to hear ~4s from the start of each source.`
										: 'Use Play to hear ~4s from the start of each source.'}
									label="Track details"
								/>
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
													hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]"
												aria-label={sourcePreviewId === source.id
													? `Stop preview of ${source.label}`
													: `Preview ${source.label}`}
												onclick={() => void onSourcePreview(source)}
											>
												{sourcePreviewId === source.id ? 'Stop' : 'Play'}
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
				<li>
					Countdown detect cross-correlates TF2 announcer begins_5…1sec WAVs (no speech
					recognition). Verify with Preview.
				</li>
				<li>Track inspect reads MP4 metadata in chunks (not the whole video).</li>
			</ul>
		{/if}
	</footer>
</main>
