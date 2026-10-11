<script lang="ts">
	import { resolve } from '$app/paths';
</script>

<main class="mx-auto w-full max-w-xl px-4 py-10 sm:px-6 sm:py-14">
	<a class="help-link text-sm" href={resolve('/')}>← Back to the injector</a>

	<header class="mt-8 mb-8 sm:mb-10">
		<h1
			class="font-[family-name:var(--font-display)] text-[2.75rem] leading-[0.95] font-bold tracking-wide text-[var(--color-fg-strong)] uppercase sm:text-5xl"
		>
			Recording help
		</h1>
		<p class="mt-4 text-sm leading-relaxed text-[var(--color-muted)]">
			Use whichever recorder suits you. Record the full match.
		</p>
	</header>

	<h2 class="mb-3 text-sm font-semibold text-[var(--color-fg-strong)]">
		Example recording options
	</h2>
	<div class="flex flex-col gap-5 text-sm leading-relaxed">
		<section
			class="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
			aria-labelledby="medal-heading"
		>
			<h3 id="medal-heading" class="help-heading">Medal</h3>
			<p class="mt-2 text-[var(--color-muted)]">
				If you use Medal, choose full-session recording rather than saving short clips. In Audio
				settings, make sure “Separate Audio Tracks” is on.
			</p>
			<a
				class="help-link mt-3 inline-block text-xs"
				href="https://support.medal.tv/support/solutions/articles/48001180234-how-to-enable-full-length-recording-features"
				target="_blank"
				rel="noopener noreferrer"
			>
				Full-session recording setup <span aria-hidden="true">↗</span>
				<span class="sr-only">(opens in a new tab)</span>
			</a>
		</section>

		<section
			class="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
			aria-labelledby="obs-heading"
		>
			<h3 id="obs-heading" class="help-heading">OBS</h3>
			<p class="mt-2 text-[var(--color-muted)]">
				If you use OBS, record the full match and save it as an MP4. Multi-track audio is
				recommended so you can inject Discord/mic tracks without game audio. A single audio track
				still works.
			</p>
			<a
				class="help-link mt-3 inline-block text-xs"
				href="https://obsproject.com/kb/multiple-audio-track-recording-guide"
				target="_blank"
				rel="noopener noreferrer"
			>
				Multi-track audio setup <span aria-hidden="true">↗</span>
				<span class="sr-only">(opens in a new tab)</span>
			</a>
		</section>

		<section
			class="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
			aria-labelledby="craig-heading"
		>
			<h3 id="craig-heading" class="help-heading">Craig (Discord bot)</h3>
			<p class="mt-2 text-[var(--color-muted)]">
				If you use Craig to record Discord voice-channel audio, keep it running for the whole match.
				Include a spoken start-time cue, such as saying “GO” in Discord as the first round begins.
			</p>
			<a
				class="help-link mt-3 inline-block text-xs"
				href="https://craig.chat/"
				target="_blank"
				rel="noopener noreferrer"
			>
				About Craig <span aria-hidden="true">↗</span>
				<span class="sr-only">(opens in a new tab)</span>
			</a>
		</section>

		<section
			class="mt-3 border-t border-[var(--color-border)] pt-6"
			aria-labelledby="timing-heading"
		>
			<h2 id="timing-heading" class="help-heading">Set Game start</h2>
			<p class="mt-3 text-[var(--color-muted)]">
				To sync your comms with the demo, note how many seconds into your recording the first round
				starts.
			</p>
			<p class="mt-3 text-[var(--color-muted)]">
				Enter that number in <strong>Game start</strong>.
			</p>
			<p class="mt-3 text-[var(--color-muted)]">
				For example, <strong>1:23.4</strong> on the recording's timeline is
				<strong>83.4 seconds</strong>.
			</p>
			<dl class="mt-3 space-y-3">
				<div>
					<dt class="font-semibold text-[var(--color-fg-strong)]">
						Video recordings — watch or listen
					</dt>
					<dd class="mt-1 text-[var(--color-muted)]">
						Open the recording and find the moment the opening countdown finishes and the first
						round starts. You can watch the video or listen to its game-audio track (no spoken
						marker needed). Leave any separate game-audio track unchecked when injecting comms.
					</dd>
				</div>
				<div>
					<dt class="font-semibold text-[var(--color-fg-strong)]">
						Audio-only recordings — audible cue
					</dt>
					<dd class="mt-1 text-[var(--color-muted)]">
						You'll need an audible cue. If game audio is recorded, listen for the end of the opening
						countdown. For Discord-only audio, have someone say “GO” as the first round begins, then
						use that spoken cue to find the approximate start time.
					</dd>
				</div>
			</dl>
			<p class="mt-3 text-[var(--color-muted)]">
				Preview ±5s plays audio and beeps at your entered time.
			</p>
			<p class="mt-3 text-[var(--color-muted)]">
				Recordings that start mid-match cannot be aligned.
			</p>
			<a class="help-link mt-5 inline-block" href={resolve('/')}>Back to the injector →</a>
		</section>
	</div>
</main>

<style>
	.help-heading {
		font-family: var(--font-display);
		font-size: 1.5rem;
		font-weight: 600;
		line-height: 1.2;
		letter-spacing: 0.025em;
		color: var(--color-fg-strong);
	}

	.help-link {
		border-radius: 0.125rem;
		color: var(--color-fg);
		text-decoration: underline;
		text-decoration-color: var(--color-border-strong);
		text-underline-offset: 0.25rem;
	}

	.help-link:hover {
		color: var(--color-fg-strong);
	}

	.help-link:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 4px;
	}
</style>
