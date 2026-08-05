/**
 * Build a mono PCM WAV from the user's selected media sources for WASM inject.
 */

import { extractMp4AudioTrackFull } from '$lib/media/mp4-audio';
import type { MediaSource } from '$lib/media/tracks';

function AudioCtor(): typeof AudioContext | undefined {
	if (typeof AudioContext !== 'undefined') return AudioContext;
	if (typeof window !== 'undefined' && window.webkitAudioContext) {
		return window.webkitAudioContext;
	}
	return undefined;
}

declare global {
	interface Window {
		webkitAudioContext?: typeof AudioContext;
	}
}

/** Encode mono float PCM as 16-bit little-endian WAV. */
export function encodeMonoWav(samples: Float32Array, sampleRate: number): Uint8Array {
	const dataBytes = samples.length * 2;
	const buffer = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(buffer);
	const writeStr = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
	};

	writeStr(0, 'RIFF');
	view.setUint32(4, 36 + dataBytes, true);
	writeStr(8, 'WAVE');
	writeStr(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeStr(36, 'data');
	view.setUint32(40, dataBytes, true);

	let o = 44;
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]!));
		view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
		o += 2;
	}
	return new Uint8Array(buffer);
}

/** Linear resample mono float PCM (same approach as the Rust injector). */
export function resampleLinear(
	input: Float32Array,
	srcRate: number,
	dstRate: number
): Float32Array {
	if (input.length === 0) return input;
	if (srcRate === dstRate || srcRate <= 0 || dstRate <= 0) return input;
	const outLen = Math.max(1, Math.round((input.length * dstRate) / srcRate));
	const out = new Float32Array(outLen);
	const scale = srcRate / dstRate;
	for (let i = 0; i < outLen; i++) {
		const srcPos = i * scale;
		const i0 = Math.floor(srcPos);
		const i1 = Math.min(i0 + 1, input.length - 1);
		const frac = srcPos - i0;
		const a = input[Math.min(i0, input.length - 1)] ?? 0;
		const b = input[i1] ?? 0;
		out[i] = a + (b - a) * frac;
	}
	return out;
}

function mixMono(buffers: Float32Array[]): Float32Array {
	if (buffers.length === 0) return new Float32Array(0);
	if (buffers.length === 1) return buffers[0]!;
	const len = Math.max(...buffers.map((b) => b.length));
	const out = new Float32Array(len);
	for (const buf of buffers) {
		for (let i = 0; i < buf.length; i++) out[i]! += buf[i]!;
	}
	// Soft clip if summed above 1.
	let peak = 0;
	for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));
	if (peak > 1) {
		const scale = 1 / peak;
		for (let i = 0; i < out.length; i++) out[i]! *= scale;
	}
	return out;
}

function channelFromBuffer(audio: AudioBuffer, channelIndex: number): Float32Array {
	const ch = Math.min(Math.max(0, channelIndex), audio.numberOfChannels - 1);
	return audio.getChannelData(ch).slice();
}

function mixBufferChannels(audio: AudioBuffer, channelIndexes: number[]): Float32Array {
	if (channelIndexes.length === 0) {
		// All channels → mono
		const frames = audio.length;
		const out = new Float32Array(frames);
		const n = audio.numberOfChannels;
		for (let c = 0; c < n; c++) {
			const data = audio.getChannelData(c);
			for (let i = 0; i < frames; i++) out[i]! += data[i]! / n;
		}
		return out;
	}
	return mixMono(channelIndexes.map((idx) => channelFromBuffer(audio, idx)));
}

async function decodeWholeFile(file: File): Promise<AudioBuffer> {
	const Ctor = AudioCtor();
	if (!Ctor) throw new Error('Web Audio is required to decode media for injection.');
	const ctx = new Ctor();
	try {
		if (ctx.state === 'suspended') await ctx.resume();
		return await ctx.decodeAudioData(await file.arrayBuffer());
	} finally {
		await ctx.close().catch(() => undefined);
	}
}

function isMp4Family(file: File): boolean {
	const name = file.name.toLowerCase();
	const type = file.type.toLowerCase();
	return (
		type.includes('mp4') ||
		type.includes('m4a') ||
		type.includes('quicktime') ||
		/\.(mp4|m4a|mov)$/i.test(name)
	);
}

function isWav(file: File): boolean {
	const name = file.name.toLowerCase();
	const type = file.type.toLowerCase();
	return type.includes('wav') || name.endsWith('.wav');
}

/**
 * Decode selected tracks/channels into a mono PCM WAV suitable for the Rust injector.
 */
export async function prepareInjectWav(
	file: File,
	sources: MediaSource[],
	selectedIds: string[],
	onProgress?: (msg: string) => void
): Promise<Uint8Array> {
	const selected = sources.filter((s) => selectedIds.includes(s.id));
	if (selected.length === 0) throw new Error('Select at least one audio track or channel.');

	if (isMp4Family(file) && selected.every((s) => typeof s.trackId === 'number')) {
		onProgress?.('Extracting audio tracks…');
		const tracks: { samples: Float32Array; sampleRate: number }[] = [];
		for (const src of selected) {
			onProgress?.(`Decoding ${src.label}…`);
			const extracted = await extractMp4AudioTrackFull(file, src.trackId!);
			if (!extracted) throw new Error(`Could not extract audio from ${src.label}.`);
			tracks.push({ samples: extracted.samples, sampleRate: extracted.sampleRate });
		}
		const targetRate = Math.max(...tracks.map((t) => t.sampleRate));
		onProgress?.('Mixing tracks…');
		const aligned = tracks.map((t) => resampleLinear(t.samples, t.sampleRate, targetRate));
		return encodeMonoWav(mixMono(aligned), targetRate);
	}

	onProgress?.('Decoding media…');
	const audio = await decodeWholeFile(file);

	if (isWav(file) || selected.some((s) => typeof s.channelIndex === 'number')) {
		const indexes = selected
			.map((s) => s.channelIndex)
			.filter((n): n is number => typeof n === 'number');
		onProgress?.('Mixing channels…');
		const mono = mixBufferChannels(audio, indexes);
		return encodeMonoWav(mono, audio.sampleRate);
	}

	// Fallback: full mix of the decoded file.
	onProgress?.('Downmixing…');
	const mono = mixBufferChannels(audio, []);
	return encodeMonoWav(mono, audio.sampleRate);
}
