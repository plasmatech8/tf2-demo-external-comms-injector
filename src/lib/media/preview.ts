/** Preview media around the game-start marker with a cue beep. */

export type PreviewHandle = {
	stop: () => void;
};

function AudioCtx(): typeof AudioContext | undefined {
	if (typeof AudioContext !== 'undefined') return AudioContext;
	if (typeof window !== 'undefined' && window.webkitAudioContext) return window.webkitAudioContext;
	return undefined;
}

declare global {
	interface Window {
		webkitAudioContext?: typeof AudioContext;
	}
}

/**
 * Soft mid-range 0.45s monotone cue at `when` (AudioContext time).
 * Lightly ducks media so the beep stays clear without hurting ears.
 */
function scheduleBeep(ctx: AudioContext, when: number, mediaGain: GainNode, freq = 440) {
	const duck = 0.35;
	const peak = 0.16;
	const dur = 0.45;

	mediaGain.gain.cancelScheduledValues(when);
	mediaGain.gain.setValueAtTime(mediaGain.gain.value, when);
	mediaGain.gain.linearRampToValueAtTime(duck, when + 0.03);
	mediaGain.gain.setValueAtTime(duck, when + dur - 0.05);
	mediaGain.gain.linearRampToValueAtTime(1, when + dur);

	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.type = 'sine';
	osc.frequency.value = freq;
	gain.gain.setValueAtTime(0.0001, when);
	gain.gain.exponentialRampToValueAtTime(peak, when + 0.04);
	gain.gain.setValueAtTime(peak, when + dur - 0.06);
	gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
	osc.connect(gain);
	gain.connect(ctx.destination);
	osc.start(when);
	osc.stop(when + dur + 0.02);
}

/**
 * Play [gameStart-5s, gameStart+5s] from the media file and beep at gameStart.
 */
export async function previewAroundGameStart(
	file: File,
	gameStartSec: number,
	onEnded?: () => void
): Promise<PreviewHandle> {
	const Ctor = AudioCtx();
	if (!Ctor || typeof document === 'undefined') {
		throw new Error('Audio preview is not supported in this browser.');
	}

	const pad = 5;
	const startAt = Math.max(0, gameStartSec - pad);
	const endAt = gameStartSec + pad;
	const url = URL.createObjectURL(file);
	const media = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio') as
		HTMLVideoElement | HTMLAudioElement;
	media.src = url;
	media.preload = 'auto';
	if ('playsInline' in media) (media as HTMLVideoElement).playsInline = true;

	const ctx = new Ctor();
	const source = ctx.createMediaElementSource(media);
	const mediaGain = ctx.createGain();
	mediaGain.gain.value = 1;
	source.connect(mediaGain);
	mediaGain.connect(ctx.destination);

	let stopped = false;
	let pollId = 0;

	const stop = () => {
		if (stopped) return;
		stopped = true;
		window.clearInterval(pollId);
		media.pause();
		source.disconnect();
		mediaGain.disconnect();
		URL.revokeObjectURL(url);
		void ctx.close().catch(() => undefined);
		onEnded?.();
	};

	await new Promise<void>((resolve, reject) => {
		media.onloadedmetadata = () => resolve();
		media.onerror = () => reject(new Error('Could not load media for preview.'));
	});

	if (ctx.state === 'suspended') await ctx.resume();

	media.currentTime = startAt;
	await new Promise<void>((resolve) => {
		if (Math.abs(media.currentTime - startAt) < 0.05) {
			resolve();
			return;
		}
		media.onseeked = () => resolve();
	});

	const beepAt = ctx.currentTime + Math.max(0, gameStartSec - startAt);
	scheduleBeep(ctx, beepAt, mediaGain, 440);

	await media.play();

	pollId = window.setInterval(() => {
		if (media.currentTime >= endAt || media.ended) stop();
	}, 50);

	media.onended = () => stop();

	return { stop };
}
