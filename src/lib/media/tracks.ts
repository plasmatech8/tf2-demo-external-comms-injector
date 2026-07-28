/** Inspect media files for injectable audio tracks or channels (client-side). */

export type MediaSourceKind = 'tracks' | 'channels';

export type MediaSource = {
	id: string;
	label: string;
	/** Hint for default checkbox state. */
	defaultSelected: boolean;
	trackId?: number;
	channelIndex?: number;
	channels?: number;
	sampleRate?: number;
};

export type MediaInspection = {
	kind: MediaSourceKind;
	sources: MediaSource[];
	summary: string;
};

function looksLikeComms(name: string): boolean {
	return /discord|mic|microphone|voice|comms|chat|vc/i.test(name);
}

function looksLikeFullMix(name: string): boolean {
	return /all\s*audio|master|mix|full|everything/i.test(name);
}

function isGenericHandlerName(name: string): boolean {
	return !name || /^sound\s*handler$/i.test(name) || /^audio$/i.test(name);
}

function defaultTrackSelection(name: string, total: number): boolean {
	if (total === 1) return true;
	if (looksLikeComms(name)) return true;
	if (looksLikeFullMix(name)) return false;
	// No useful names (e.g. Medal-less exports): select all tracks.
	return true;
}

function readWavHeader(buffer: ArrayBuffer): { channels: number; sampleRate: number } | null {
	if (buffer.byteLength < 44) return null;
	const view = new DataView(buffer);
	const riff = String.fromCharCode(
		view.getUint8(0),
		view.getUint8(1),
		view.getUint8(2),
		view.getUint8(3)
	);
	const wave = String.fromCharCode(
		view.getUint8(8),
		view.getUint8(9),
		view.getUint8(10),
		view.getUint8(11)
	);
	if (riff !== 'RIFF' || wave !== 'WAVE') return null;

	let offset = 12;
	while (offset + 8 <= view.byteLength) {
		const id = String.fromCharCode(
			view.getUint8(offset),
			view.getUint8(offset + 1),
			view.getUint8(offset + 2),
			view.getUint8(offset + 3)
		);
		const size = view.getUint32(offset + 4, true);
		if (id === 'fmt ') {
			const channels = view.getUint16(offset + 10, true);
			const sampleRate = view.getUint32(offset + 12, true);
			return { channels, sampleRate };
		}
		offset += 8 + size + (size % 2);
	}
	return null;
}

const CHANNEL_NAMES = ['Left', 'Right', 'Center', 'LFE', 'Side L', 'Side R', 'Back L', 'Back R'];

function channelLabel(index: number, total: number): string {
	if (total === 1) return 'Mono';
	if (total === 2) return index === 0 ? 'Left' : 'Right';
	return CHANNEL_NAMES[index] ?? `Channel ${index + 1}`;
}

async function inspectMp4(file: File): Promise<MediaInspection | null> {
	const name = file.name.toLowerCase();
	const type = file.type.toLowerCase();
	const isMp4Family =
		type.includes('mp4') ||
		type.includes('m4a') ||
		type.includes('quicktime') ||
		/\.(mp4|m4a|mov)$/i.test(name);
	if (!isMp4Family) return null;

	const { createFile, MP4BoxBuffer } = await import('mp4box');
	const ab = await file.arrayBuffer();

	const info = await new Promise<{
		audioTracks: Array<{
			id: number;
			name?: string;
			audio?: { channel_count?: number; sample_rate?: number };
		}>;
	}>((resolve, reject) => {
		const mp4 = createFile();
		mp4.onError = (err: string) => reject(new Error(err || 'Failed to parse MP4'));
		mp4.onReady = (movie) => resolve(movie);
		const buf = MP4BoxBuffer.fromArrayBuffer(ab, 0);
		mp4.appendBuffer(buf);
		mp4.flush();
	});

	const audioTracks = info.audioTracks ?? [];
	if (audioTracks.length === 0) {
		return {
			kind: 'tracks',
			sources: [],
			summary: 'No audio tracks found in this file.'
		};
	}

	const sources: MediaSource[] = audioTracks.map((track, i) => {
		const rawName = (track.name ?? '').trim();
		const niceName = isGenericHandlerName(rawName) ? '' : rawName;
		const channels = track.audio?.channel_count ?? 0;
		const sampleRate = track.audio?.sample_rate ?? 0;
		const parts = [
			`Track ${i + 1}`,
			niceName || `id ${track.id}`,
			channels ? `${channels}ch` : null,
			sampleRate ? `${Math.round(sampleRate / 100) / 10} kHz` : null
		].filter(Boolean);

		return {
			id: `track:${track.id}`,
			label: parts.join(' — '),
			defaultSelected: defaultTrackSelection(niceName || rawName, audioTracks.length),
			trackId: track.id,
			channels: channels || undefined,
			sampleRate: sampleRate || undefined
		};
	});

	// If every track got defaultSelected true via the fallback, but names suggest a full mix exists, prefer comms.
	const hasComms = sources.some((s) => looksLikeComms(s.label));
	const hasMix = sources.some((s) => looksLikeFullMix(s.label));
	if (hasComms && hasMix) {
		for (const s of sources) {
			s.defaultSelected = looksLikeComms(s.label);
		}
	}

	return {
		kind: 'tracks',
		sources,
		summary: `${sources.length} audio track${sources.length === 1 ? '' : 's'} detected.`
	};
}

async function inspectWavChannels(file: File): Promise<MediaInspection | null> {
	const name = file.name.toLowerCase();
	const type = file.type.toLowerCase();
	if (!(type.includes('wav') || name.endsWith('.wav'))) return null;

	const header = readWavHeader(await file.arrayBuffer());
	if (!header) {
		return {
			kind: 'channels',
			sources: [],
			summary: 'Could not read WAV header.'
		};
	}

	const { channels, sampleRate } = header;
	const sources: MediaSource[] = Array.from({ length: channels }, (_, i) => ({
		id: `ch:${i}`,
		label: `${channelLabel(i, channels)} — channel ${i + 1}`,
		defaultSelected: true,
		channelIndex: i,
		channels,
		sampleRate
	}));

	return {
		kind: 'channels',
		sources,
		summary:
			channels === 1
				? `Mono WAV @ ${sampleRate} Hz.`
				: `${channels}-channel WAV @ ${sampleRate} Hz.`
	};
}

async function inspectDecodedChannels(file: File): Promise<MediaInspection> {
	const AudioCtx =
		typeof AudioContext !== 'undefined'
			? AudioContext
			: typeof window !== 'undefined'
				? window.webkitAudioContext
				: undefined;

	if (!AudioCtx) {
		return {
			kind: 'tracks',
			sources: [
				{
					id: 'track:0',
					label: 'Default audio',
					defaultSelected: true
				}
			],
			summary: 'Audio decoding unavailable; treating as a single track.'
		};
	}

	const ctx = new AudioCtx();
	try {
		const audio = await ctx.decodeAudioData(await file.arrayBuffer());
		const channels = audio.numberOfChannels;
		const sampleRate = audio.sampleRate;
		const sources: MediaSource[] = Array.from({ length: channels }, (_, i) => ({
			id: `ch:${i}`,
			label: `${channelLabel(i, channels)} — channel ${i + 1}`,
			defaultSelected: true,
			channelIndex: i,
			channels,
			sampleRate
		}));

		return {
			kind: channels > 1 ? 'channels' : 'tracks',
			sources:
				channels === 1
					? [
							{
								id: 'track:0',
								label: `Audio — mono @ ${Math.round(sampleRate / 100) / 10} kHz`,
								defaultSelected: true,
								channels: 1,
								sampleRate
							}
						]
					: sources,
			summary:
				channels === 1
					? `Single audio stream @ ${sampleRate} Hz.`
					: `${channels} channels @ ${sampleRate} Hz.`
		};
	} catch {
		return {
			kind: 'tracks',
			sources: [
				{
					id: 'track:0',
					label: 'Default audio',
					defaultSelected: true
				}
			],
			summary: 'Could not decode audio; treating as a single track.'
		};
	} finally {
		await ctx.close().catch(() => undefined);
	}
}

declare global {
	interface Window {
		webkitAudioContext?: typeof AudioContext;
	}
}

/**
 * Inspect a media file for selectable audio tracks (MP4) or channels (WAV / decoded).
 */
export async function inspectMedia(file: File): Promise<MediaInspection> {
	const mp4 = await inspectMp4(file);
	if (mp4) return mp4;

	const wav = await inspectWavChannels(file);
	if (wav) return wav;

	return inspectDecodedChannels(file);
}
