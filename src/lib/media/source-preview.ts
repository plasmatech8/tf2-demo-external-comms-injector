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

function playBuffer(
	samples: Float32Array,
	sampleRate: number,
	onEnded?: () => void
): PreviewHandle {
	const Ctor = AudioCtx();
	if (!Ctor) throw new Error('Web Audio is required for track preview.');
	const ctx = new Ctor();
	const frames = Math.min(samples.length, Math.floor(sampleRate * PREVIEW_SEC));
	const buffer = ctx.createBuffer(1, frames, sampleRate);
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
		void ctx.close().catch(() => undefined);
		onEnded?.();
	};

	src.onended = () => stop();
	void ctx.resume().then(() => src.start());
	return { stop };
}

async function decodeFileHead(file: File): Promise<{ buffer: AudioBuffer; ctx: AudioContext }> {
	const Ctor = AudioCtx();
	if (!Ctor) throw new Error('Web Audio is required for track preview.');
	const ctx = new Ctor();
	try {
		const audio = await ctx.decodeAudioData(await file.arrayBuffer());
		return { buffer: audio, ctx };
	} catch (e) {
		await ctx.close().catch(() => undefined);
		throw e instanceof Error ? e : new Error('Could not decode audio for preview.');
	}
}

function playAudioBufferChannel(
	audio: AudioBuffer,
	channelIndex: number | undefined,
	ctx: AudioContext,
	onEnded?: () => void
): PreviewHandle {
	const frames = Math.min(audio.length, Math.floor(audio.sampleRate * PREVIEW_SEC));
	const out = ctx.createBuffer(1, frames, audio.sampleRate);
	if (typeof channelIndex === 'number' && channelIndex < audio.numberOfChannels) {
		out.copyToChannel(audio.getChannelData(channelIndex).subarray(0, frames), 0);
	} else {
		const mixed = out.getChannelData(0);
		const ch = audio.numberOfChannels;
		for (let c = 0; c < ch; c++) {
			const data = audio.getChannelData(c);
			for (let i = 0; i < frames; i++) mixed[i] += data[i] / ch;
		}
	}

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
		void ctx.close().catch(() => undefined);
		onEnded?.();
	};

	src.onended = () => stop();
	void ctx.resume().then(() => src.start());
	return { stop };
}

function playMediaElement(file: File, onEnded?: () => void): Promise<PreviewHandle> {
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

	const ctx = new Ctor();
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
		void ctx.close().catch(() => undefined);
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
 */
export async function previewMediaSource(
	file: File,
	source: MediaSource,
	onEnded?: () => void
): Promise<PreviewHandle> {
	if (typeof source.trackId === 'number') {
		const extracted = await extractMp4AudioTrackHeads(file, PREVIEW_SEC, undefined, source.trackId);
		const hit = extracted.find((e) => e.trackId === source.trackId) ?? extracted[0];
		if (hit) return playBuffer(hit.samples, hit.sampleRate, onEnded);
		// Fall through if demux failed for this track.
	}

	if (typeof source.channelIndex === 'number') {
		const { buffer, ctx } = await decodeFileHead(file);
		return playAudioBufferChannel(buffer, source.channelIndex, ctx, onEnded);
	}

	// Single default stream / unknown: play the file itself for a few seconds.
	return playMediaElement(file, onEnded);
}
