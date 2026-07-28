/** Short listen-through for a single inspected media source (track / channel). */

import { extractMp4AudioTrackHeads } from '$lib/media/mp4-audio';
import type { MediaSource } from '$lib/media/tracks';

export type PreviewHandle = {
	stop: () => void;
};

const PREVIEW_SEC = 4;

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

/** Call from the Play click so later decode/play still has an unlocked context. */
export function primeAudioContext(): AudioContext | null {
	const Ctor = AudioCtx();
	if (!Ctor) return null;
	const ctx = new Ctor();
	void ctx.resume();
	return ctx;
}

function playBuffer(
	samples: Float32Array,
	sampleRate: number,
	primed: AudioContext | null,
	onEnded?: () => void
): PreviewHandle {
	const Ctor = AudioCtx();
	if (!Ctor) throw new Error('Web Audio is required for track preview.');
	const owns = !(primed && primed.state !== 'closed');
	const ctx = owns ? new Ctor() : primed!;
	const frames = Math.min(samples.length, Math.floor(sampleRate * PREVIEW_SEC));
	const buffer = ctx.createBuffer(1, Math.max(1, frames), sampleRate);
	buffer.getChannelData(0).set(samples.subarray(0, frames));
	const src = ctx.createBufferSource();
	src.buffer = buffer;
	src.connect(ctx.destination);

	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		try {
			src.stop();
		} catch {
			/* already stopped */
		}
		src.disconnect();
		if (owns || primed === ctx) void ctx.close().catch(() => undefined);
		onEnded?.();
	};

	src.onended = () => stop();
	void ctx.resume().then(() => {
		if (!stopped) src.start();
	});
	return { stop };
}

async function decodeFileHead(file: File): Promise<AudioBuffer> {
	const Ctor = AudioCtx();
	if (!Ctor) throw new Error('Web Audio is required for track preview.');
	const ctx = new Ctor();
	try {
		return await ctx.decodeAudioData(await file.arrayBuffer());
	} finally {
		await ctx.close().catch(() => undefined);
	}
}

function playAudioBufferChannel(
	audio: AudioBuffer,
	channelIndex: number,
	primed: AudioContext | null,
	onEnded?: () => void
): PreviewHandle {
	if (channelIndex < 0 || channelIndex >= audio.numberOfChannels) {
		throw new Error('That audio channel is not available in this file.');
	}
	const Ctor = AudioCtx();
	if (!Ctor) throw new Error('Web Audio is required for track preview.');
	const owns = !(primed && primed.state !== 'closed');
	const ctx = owns ? new Ctor() : primed!;
	const frames = Math.min(audio.length, Math.floor(audio.sampleRate * PREVIEW_SEC));
	const out = ctx.createBuffer(1, Math.max(1, frames), audio.sampleRate);
	out.getChannelData(0).set(audio.getChannelData(channelIndex).subarray(0, frames));

	const src = ctx.createBufferSource();
	src.buffer = out;
	src.connect(ctx.destination);

	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		try {
			src.stop();
		} catch {
			/* already stopped */
		}
		src.disconnect();
		if (owns || primed === ctx) void ctx.close().catch(() => undefined);
		onEnded?.();
	};

	src.onended = () => stop();
	void ctx.resume().then(() => {
		if (!stopped) src.start();
	});
	return { stop };
}

function playMediaElement(
	file: File,
	primed: AudioContext | null,
	onEnded?: () => void
): Promise<PreviewHandle> {
	const Ctor = AudioCtx();
	if (!Ctor || typeof document === 'undefined') {
		return Promise.reject(new Error('Audio preview is not supported in this browser.'));
	}

	const url = URL.createObjectURL(file);
	const media = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio') as
		HTMLVideoElement | HTMLAudioElement;
	media.src = url;
	media.preload = 'auto';
	if ('playsInline' in media) (media as HTMLVideoElement).playsInline = true;

	const owns = !(primed && primed.state !== 'closed');
	const ctx = owns ? new Ctor() : primed!;
	const source = ctx.createMediaElementSource(media);
	source.connect(ctx.destination);

	let stopped = false;
	let pollId = 0;

	const stop = () => {
		if (stopped) return;
		stopped = true;
		window.clearInterval(pollId);
		media.pause();
		source.disconnect();
		URL.revokeObjectURL(url);
		if (owns || primed === ctx) void ctx.close().catch(() => undefined);
		onEnded?.();
	};

	return new Promise((resolve, reject) => {
		media.onloadedmetadata = () => {
			void (async () => {
				try {
					if (ctx.state === 'suspended') await ctx.resume();
					media.currentTime = 0;
					await media.play();
					pollId = window.setInterval(() => {
						if (media.currentTime >= PREVIEW_SEC || media.ended) stop();
					}, 50);
					media.onended = () => stop();
					resolve({ stop });
				} catch (e) {
					stop();
					reject(e instanceof Error ? e : new Error('Could not play track preview.'));
				}
			})();
		};
		media.onerror = () => reject(new Error('Could not load media for track preview.'));
	});
}

/**
 * Play ~4s from the start of a specific inspected source so the user can identify it.
 * Multi-track/channel sources are demuxed; never silently falls back to the default mix.
 */
export async function previewMediaSource(
	file: File,
	source: MediaSource,
	onEnded?: () => void,
	primed: AudioContext | null = null
): Promise<PreviewHandle> {
	const ctx = primed ?? primeAudioContext();

	if (typeof source.trackId === 'number') {
		const extracted = await extractMp4AudioTrackHeads(file, PREVIEW_SEC, undefined, source.trackId);
		const hit = extracted.find((e) => e.trackId === source.trackId);
		if (!hit) {
			if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
			throw new Error(
				`Could not isolate “${source.label}” for preview. This track may use an unsupported codec.`
			);
		}
		return playBuffer(hit.samples, hit.sampleRate, ctx, onEnded);
	}

	if (typeof source.channelIndex === 'number') {
		const buffer = await decodeFileHead(file);
		return playAudioBufferChannel(buffer, source.channelIndex, ctx, onEnded);
	}

	// Single unnamed stream from inspect fallback — the file itself is the source.
	return playMediaElement(file, ctx, onEnded);
}
