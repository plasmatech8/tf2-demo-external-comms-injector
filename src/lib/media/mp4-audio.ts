/**
 * Extract PCM from MP4 audio tracks (Medal: prefer "game").
 * Demux with mp4box → wrap AAC in ADTS → decodeAudioData.
 */

const MP4_CHUNK_SIZE = 1024 * 1024;

export type ExtractedAudio = {
	samples: Float32Array;
	sampleRate: number;
	trackLabel: string;
	trackId: number;
};

type Mp4AudioTrackInfo = {
	id: number;
	name?: string;
	codec?: string;
	audio?: { sample_rate?: number; channel_count?: number };
};

type Mp4Box = {
	type?: string;
	boxes?: Mp4Box[];
	track_id?: number;
	name?: string;
	data?: Uint8Array | ArrayLike<number>;
};

type Sample = {
	data: ArrayBuffer | Uint8Array;
	cts: number;
	duration: number;
	timescale: number;
	is_sync: boolean;
};

function looksLikeGame(name: string): boolean {
	return /\bgame\b/i.test(name) && !/discord|mic|microphone|all\s*audio/i.test(name);
}

function looksLikeComms(name: string): boolean {
	return /discord|mic|microphone|voice|comms|chat|vc/i.test(name);
}

function isGenericHandlerName(name: string): boolean {
	return !name || /^sound\s*handler$/i.test(name) || /^audio$/i.test(name);
}

export function rankAudioTracks<T extends { id: number; name?: string }>(tracks: T[]): T[] {
	return [...tracks].sort((a, b) => {
		const an = (a.name ?? '').trim();
		const bn = (b.name ?? '').trim();
		const as = looksLikeGame(an) ? 0 : looksLikeComms(an) ? 2 : 1;
		const bs = looksLikeGame(bn) ? 0 : looksLikeComms(bn) ? 2 : 1;
		return as - bs;
	});
}

function decodeBoxString(data: Uint8Array | ArrayLike<number> | undefined): string {
	if (!data) return '';
	const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
	let end = bytes.length;
	while (end > 0 && bytes[end - 1] === 0) end -= 1;
	if (end <= 0) return '';
	let start = 0;
	if (bytes[0] === end - 1 && end > 1) start = 1;
	return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start, end)).trim();
}

function findChild(box: Mp4Box | undefined, type: string): Mp4Box | undefined {
	return box?.boxes?.find((child) => child.type === type);
}

function findDeep(box: Mp4Box | undefined, type: string): Mp4Box | undefined {
	if (!box) return undefined;
	if (box.type === type) return box;
	for (const child of box.boxes ?? []) {
		const found = findDeep(child, type);
		if (found) return found;
	}
	return undefined;
}

function readTrackDisplayNames(mp4: { getBox: (type: string) => Mp4Box }): Map<number, string> {
	const names = new Map<number, string>();
	const moov = mp4.getBox('moov');
	if (!moov?.boxes) return names;
	for (const trak of moov.boxes.filter((box) => box.type === 'trak')) {
		const trackId = findChild(trak, 'tkhd')?.track_id;
		if (typeof trackId !== 'number') continue;
		const udtaName = decodeBoxString(findChild(findChild(trak, 'udta'), 'name')?.data);
		const hdlrName = (findDeep(trak, 'hdlr')?.name ?? '').trim();
		const chosen =
			udtaName || (!isGenericHandlerName(hdlrName) && hdlrName !== 'VideoHandler' ? hdlrName : '');
		if (chosen) names.set(trackId, chosen);
	}
	return names;
}

function getAudioSpecificConfig(
	mp4: { getTrackById?: (id: number) => unknown },
	trackId: number
): Uint8Array | undefined {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const trak: any = mp4.getTrackById?.(trackId);
		const entries = trak?.mdia?.minf?.stbl?.stsd?.entries ?? [];
		for (const entry of entries) {
			const esds = entry?.esds ?? entry?.wave?.esds;
			const descs = esds?.esd?.descs ?? [];
			for (const desc of descs) {
				if (desc?.tag === 0x04) {
					for (const inner of desc.descs ?? []) {
						if (inner?.tag === 0x05 && inner.data) {
							return inner.data instanceof Uint8Array ? inner.data : new Uint8Array(inner.data);
						}
					}
				}
				if (desc?.tag === 0x05 && desc.data) {
					return desc.data instanceof Uint8Array ? desc.data : new Uint8Array(desc.data);
				}
			}
		}
	} catch {
		/* best-effort */
	}
	return undefined;
}

function throwIfAborted(signal?: AbortSignal) {
	if (signal?.aborted) {
		const err = new Error('Cancelled');
		err.name = 'AbortError';
		throw err;
	}
}

const SAMPLE_RATES = [
	96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350
];

function parseAsc(asc: Uint8Array | undefined, fallbackRate: number, fallbackCh: number) {
	if (!asc || asc.length < 2) {
		return {
			objectType: 2,
			freqIndex: Math.max(0, SAMPLE_RATES.indexOf(fallbackRate)),
			channels: fallbackCh
		};
	}
	const bits = (asc[0] << 8) | asc[1];
	let objectType = (bits >> 11) & 0x1f;
	let freqIndex = (bits >> 7) & 0x0f;
	let channels = (bits >> 3) & 0x0f;
	if (objectType === 31 && asc.length >= 3) {
		objectType = 32 + ((asc[1] & 7) << 3) + (asc[2] >> 5);
	}
	if (freqIndex === 15 && asc.length >= 5) {
		freqIndex = Math.max(0, SAMPLE_RATES.indexOf(fallbackRate));
	}
	if (!channels) channels = fallbackCh;
	return { objectType: objectType || 2, freqIndex: freqIndex >= 0 ? freqIndex : 4, channels };
}

/** Wrap raw AAC access units in ADTS frames for decodeAudioData. */
function samplesToAdts(
	samples: Sample[],
	asc: Uint8Array | undefined,
	sampleRate: number,
	channelCount: number,
	maxSec: number
): Uint8Array {
	const { objectType, freqIndex, channels } = parseAsc(asc, sampleRate, channelCount);
	const chunks: Uint8Array[] = [];
	let total = 0;

	for (const sample of samples) {
		if (sample.cts / sample.timescale > maxSec + 0.5) break;
		const payload = sample.data instanceof Uint8Array ? sample.data : new Uint8Array(sample.data);
		const frameLen = 7 + payload.length;
		const header = new Uint8Array(7);
		header[0] = 0xff;
		header[1] = 0xf1; // MPEG-4, no CRC
		header[2] = ((objectType - 1) << 6) | ((freqIndex & 0x0f) << 2) | ((channels >> 2) & 0x01);
		header[3] = ((channels & 0x03) << 6) | ((frameLen >> 11) & 0x03);
		header[4] = (frameLen >> 3) & 0xff;
		header[5] = ((frameLen & 0x07) << 5) | 0x1f;
		header[6] = 0xfc;
		chunks.push(header, payload);
		total += frameLen;
	}

	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

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

function mixToMono(buffer: AudioBuffer, maxSec: number): Float32Array {
	const rate = buffer.sampleRate;
	const frames = Math.min(buffer.length, Math.floor(rate * maxSec));
	const mono = new Float32Array(frames);
	const ch = buffer.numberOfChannels;
	for (let c = 0; c < ch; c++) {
		const data = buffer.getChannelData(c);
		for (let i = 0; i < frames; i++) mono[i] += data[i] / ch;
	}
	return mono;
}

async function decodeAdts(
	adts: Uint8Array,
	maxSec: number
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
	if (adts.byteLength < 64) return null;
	const Ctor = AudioCtx();
	if (!Ctor) return null;
	const ctx = new Ctor();
	try {
		const copy = Uint8Array.from(adts).buffer;
		const audio = await ctx.decodeAudioData(copy);
		return { samples: mixToMono(audio, maxSec), sampleRate: audio.sampleRate };
	} catch {
		return null;
	} finally {
		await ctx.close().catch(() => undefined);
	}
}

/**
 * Demux + decode the first `maxSec` of ranked MP4 audio tracks (game first).
 */
export async function extractMp4AudioTrackHeads(
	file: File,
	maxSec: number,
	signal?: AbortSignal
): Promise<ExtractedAudio[]> {
	throwIfAborted(signal);

	const name = file.name.toLowerCase();
	const type = file.type.toLowerCase();
	const isMp4Family =
		type.includes('mp4') ||
		type.includes('m4a') ||
		type.includes('quicktime') ||
		/\.(mp4|m4a|mov)$/i.test(name);
	if (!isMp4Family) return [];

	const { createFile, MP4BoxBuffer } = await import('mp4box');
	throwIfAborted(signal);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mp4: any = createFile();
	const collected = new Map<number, Sample[]>();
	let tracks: Mp4AudioTrackInfo[] = [];
	let started = false;

	const ready = new Promise<void>((resolve, reject) => {
		mp4.onError = (msg: string) => reject(new Error(msg || 'MP4 parse failed'));
		mp4.onReady = (movie: { audioTracks?: Mp4AudioTrackInfo[] }) => {
			const displayNames = readTrackDisplayNames(mp4);
			tracks = rankAudioTracks(
				(movie.audioTracks ?? []).map((t) => ({
					...t,
					name: displayNames.get(t.id) || t.name
				}))
			).slice(0, 4);

			for (const track of tracks) {
				collected.set(track.id, []);
				mp4.setExtractionOptions(track.id, track.id, { nbSamples: 200 });
			}
			mp4.onSamples = (id: number, _user: unknown, samples: Sample[]) => {
				const list = collected.get(id);
				if (!list) return;
				for (const sample of samples) {
					if (sample.cts / sample.timescale > maxSec + 0.75) continue;
					list.push(sample);
				}
			};
			mp4.start();
			started = true;
			resolve();
		};
	});

	let offset = 0;
	let guard = 0;
	while (offset < file.size && guard < 768) {
		throwIfAborted(signal);
		guard += 1;
		const end = Math.min(offset + MP4_CHUNK_SIZE, file.size);
		const ab = await file.slice(offset, end).arrayBuffer();
		throwIfAborted(signal);
		const next = mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, offset));
		if (typeof next === 'number' && next > offset) offset = next;
		else offset = end;

		if (!started && mp4.moov) {
			await ready;
		}

		// Stop early once we likely have enough samples for every track.
		if (started && tracks.length > 0) {
			const enough = tracks.every((t) => {
				const list = collected.get(t.id) ?? [];
				if (list.length === 0) return false;
				const last = list[list.length - 1];
				return last.cts / last.timescale >= Math.min(maxSec, 8) - 0.05;
			});
			if (enough) break;
		}
	}

	await ready.catch(() => undefined);
	mp4.flush();
	try {
		mp4.stop();
	} catch {
		/* ignore */
	}

	throwIfAborted(signal);

	const out: ExtractedAudio[] = [];
	for (const track of tracks) {
		throwIfAborted(signal);
		const samples = collected.get(track.id) ?? [];
		if (samples.length === 0) continue;
		const sampleRate = track.audio?.sample_rate || 44100;
		const channels = track.audio?.channel_count || 1;
		const asc = getAudioSpecificConfig(mp4, track.id);
		const adts = samplesToAdts(samples, asc, sampleRate, channels, maxSec);
		const decoded = await decodeAdts(adts, maxSec);
		if (!decoded || decoded.samples.length < decoded.sampleRate * 0.25) continue;
		out.push({
			samples: decoded.samples,
			sampleRate: decoded.sampleRate,
			trackLabel: (track.name ?? '').trim() || `track ${track.id}`,
			trackId: track.id
		});
	}

	return out;
}
