/** Short listen-through for a single inspected media source (track / channel). */

import { extractMp4AudioTrackHeads, remuxMp4AudioTrackHead } from '$lib/media/mp4-audio';
import type { MediaSource } from '$lib/media/tracks';

export type PreviewHandle = {
	stop: () => void;
};

const PREVIEW_SEC = 8;

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

/**
 * Stream the file via a media element and route only one channel to the speakers.
 * Avoids decoding the whole WAV/file into memory (which caused multi-second Play delay).
 */
function playMediaElementChannel(
	file: Blob,
	channelIndex: number,
	channelCount: number,
	primed: AudioContext | null,
	onEnded?: () => void
): Promise<PreviewHandle> {
	const Ctor = AudioCtx();
	if (!Ctor || typeof document === 'undefined') {
		return Promise.reject(new Error('Audio preview is not supported in this browser.'));
	}
	if (channelIndex < 0 || channelIndex >= channelCount) {
		return Promise.reject(new Error('That audio channel is not available in this file.'));
	}

	const url = URL.createObjectURL(file);
	const media = document.createElement('audio');
	media.src = url;
	media.preload = 'auto';

	const owns = !(primed && primed.state !== 'closed');
	const ctx = owns ? new Ctor() : primed!;
	const source = ctx.createMediaElementSource(media);
	const splitter = ctx.createChannelSplitter(Math.max(channelCount, 2));
	const gain = ctx.createGain();
	source.connect(splitter);
	splitter.connect(gain, channelIndex);
	gain.connect(ctx.destination);

	let stopped = false;
	let pollId = 0;

	const stop = () => {
		if (stopped) return;
		stopped = true;
		window.clearInterval(pollId);
		media.pause();
		try {
			source.disconnect();
			splitter.disconnect();
			gain.disconnect();
		} catch {
			/* already disconnected */
		}
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
					reject(e instanceof Error ? e : new Error('Could not play channel preview.'));
				}
			})();
		};
		media.onerror = () => {
			stop();
			reject(new Error('Could not load media for channel preview.'));
		};
	});
}

/** Fast PCM head read for WAV — no full-file decode. */
async function playWavChannelHead(
	file: File,
	channelIndex: number,
	primed: AudioContext | null,
	onEnded?: () => void
): Promise<PreviewHandle | null> {
	const name = file.name.toLowerCase();
	const type = file.type.toLowerCase();
	if (!(type.includes('wav') || name.endsWith('.wav'))) return null;

	const headerBuf = await file.slice(0, Math.min(file.size, 65536)).arrayBuffer();
	const view = new DataView(headerBuf);
	if (headerBuf.byteLength < 44) return null;
	const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
	const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
	if (riff !== 'RIFF' || wave !== 'WAVE') return null;

	let offset = 12;
	let channels = 0;
	let sampleRate = 0;
	let bitsPerSample = 0;
	let dataOffset = -1;
	let dataSize = 0;

	while (offset + 8 <= view.byteLength) {
		const id = String.fromCharCode(
			view.getUint8(offset),
			view.getUint8(offset + 1),
			view.getUint8(offset + 2),
			view.getUint8(offset + 3)
		);
		const size = view.getUint32(offset + 4, true);
		if (id === 'fmt ') {
			channels = view.getUint16(offset + 10, true);
			sampleRate = view.getUint32(offset + 12, true);
			bitsPerSample = view.getUint16(offset + 22, true);
		} else if (id === 'data') {
			dataOffset = offset + 8;
			dataSize = size;
			break;
		}
		offset += 8 + size + (size % 2);
	}

	if (
		dataOffset < 0 ||
		!channels ||
		!sampleRate ||
		(bitsPerSample !== 16 && bitsPerSample !== 24 && bitsPerSample !== 32) ||
		channelIndex < 0 ||
		channelIndex >= channels
	) {
		return null;
	}

	const bytesPerSample = bitsPerSample / 8;
	const frameBytes = channels * bytesPerSample;
	const framesWanted = Math.floor(sampleRate * PREVIEW_SEC);
	const bytesWanted = Math.min(dataSize, framesWanted * frameBytes);
	const pcm = new Uint8Array(await file.slice(dataOffset, dataOffset + bytesWanted).arrayBuffer());
	const frames = Math.floor(pcm.byteLength / frameBytes);
	if (frames < sampleRate * 0.1) return null;

	const samples = new Float32Array(frames);
	const pcmView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	for (let i = 0; i < frames; i++) {
		const base = i * frameBytes + channelIndex * bytesPerSample;
		if (bitsPerSample === 16) {
			samples[i] = pcmView.getInt16(base, true) / 32768;
		} else if (bitsPerSample === 24) {
			const b0 = pcmView.getUint8(base);
			const b1 = pcmView.getUint8(base + 1);
			const b2 = pcmView.getUint8(base + 2);
			let v = (b2 << 16) | (b1 << 8) | b0;
			if (v & 0x800000) v |= ~0xffffff;
			samples[i] = v / 8388608;
		} else {
			samples[i] = pcmView.getFloat32(base, true);
		}
	}

	return playBuffer(samples, sampleRate, primed, onEnded);
}

function playMediaElement(
	file: Blob,
	primed: AudioContext | null,
	onEnded?: () => void
): Promise<PreviewHandle> {
	const Ctor = AudioCtx();
	if (!Ctor || typeof document === 'undefined') {
		return Promise.reject(new Error('Audio preview is not supported in this browser.'));
	}

	const url = URL.createObjectURL(file);
	const media = document.createElement(
		file.type.startsWith('video/') ? 'video' : 'audio'
	) as HTMLVideoElement | HTMLAudioElement;
	media.src = url;
	media.preload = 'auto';
	if ('playsInline' in media) (media as HTMLVideoElement).playsInline = true;

	const owns = !(primed && primed.state !== 'closed');
	const ctx = owns ? new Ctor() : primed!;
	const source = ctx.createMediaElementSource(media);
	source.connect(ctx.destination);

	let stopped = false;
	let pollId = 0;
	let notifyEnded = false;

	const cleanup = () => {
		window.clearInterval(pollId);
		media.pause();
		try {
			source.disconnect();
		} catch {
			/* already disconnected */
		}
		URL.revokeObjectURL(url);
		if (owns || primed === ctx) void ctx.close().catch(() => undefined);
	};

	const stop = () => {
		if (stopped) return;
		stopped = true;
		cleanup();
		if (notifyEnded) onEnded?.();
	};

	return new Promise((resolve, reject) => {
		media.onloadedmetadata = () => {
			void (async () => {
				try {
					if (ctx.state === 'suspended') await ctx.resume();
					media.currentTime = 0;
					await media.play();
					notifyEnded = true;
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
		media.onerror = () => {
			stop();
			reject(new Error('Could not load media for track preview.'));
		};
	});
}

/**
 * Play ~8s from the start of a specific inspected source so the user can identify it.
 * MP4 tracks are remuxed alone (AAC/Opus); WAV channels read only the PCM head.
 */
export async function previewMediaSource(
	file: File,
	source: MediaSource,
	onEnded?: () => void,
	primed: AudioContext | null = null
): Promise<PreviewHandle> {
	const ctx = primed ?? primeAudioContext();

	if (typeof source.trackId === 'number') {
		const blob = await remuxMp4AudioTrackHead(file, source.trackId, PREVIEW_SEC);
		if (blob) {
			try {
				return await playMediaElement(blob, ctx, onEnded);
			} catch {
				/* fall through to PCM decode */
			}
		}

		const extracted = await extractMp4AudioTrackHeads(file, PREVIEW_SEC, undefined, source.trackId);
		const hit = extracted.find((e) => e.trackId === source.trackId);
		if (hit) {
			return playBuffer(hit.samples, hit.sampleRate, ctx, onEnded);
		}

		if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
		throw new Error(
			`Could not isolate “${source.label}” for preview. This track may use an unsupported codec.`
		);
	}

	if (typeof source.channelIndex === 'number') {
		const wav = await playWavChannelHead(file, source.channelIndex, ctx, onEnded);
		if (wav) return wav;

		const channelCount = source.channels ?? source.channelIndex + 1;
		return playMediaElementChannel(file, source.channelIndex, channelCount, ctx, onEnded);
	}

	// Single unnamed stream from inspect fallback — the file itself is the source.
	return playMediaElement(file, ctx, onEnded);
}
