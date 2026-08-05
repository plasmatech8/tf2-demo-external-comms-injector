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
	dts?: number;
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
 * Demux + decode the first `maxSec` of MP4 audio tracks.
 * Pass `onlyTrackId` to extract a single track (for per-track preview).
 */
export async function extractMp4AudioTrackHeads(
	file: File,
	maxSec: number,
	signal?: AbortSignal,
	onlyTrackId?: number
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

	if (typeof onlyTrackId === 'number') {
		const collected = await collectTrackSamples(file, onlyTrackId, maxSec, signal);
		if (!collected) return [];
		const decoded = await decodeCollectedTrack(collected, maxSec);
		if (!decoded) return [];
		return [
			{
				samples: decoded.samples,
				sampleRate: decoded.sampleRate,
				trackLabel: `track ${onlyTrackId}`,
				trackId: onlyTrackId
			}
		];
	}

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
			const all = (movie.audioTracks ?? []).map((t) => ({
				...t,
				name: displayNames.get(t.id) || t.name
			}));
			tracks =
				typeof onlyTrackId === 'number'
					? all.filter((t) => t.id === onlyTrackId)
					: rankAudioTracks(all).slice(0, 4);

			for (const track of tracks) {
				collected.set(track.id, []);
				mp4.setExtractionOptions(track.id, track.id, { nbSamples: 200 });
			}
			mp4.onSamples = (id: number, _user: unknown, samples: Sample[]) => {
				const list = collected.get(id);
				if (!list) return;
				for (const sample of samples) {
					if (sample.cts / sample.timescale > maxSec + 0.75) continue;
					// Copy payload — mp4box reuses underlying buffers across batches.
					const raw = sample.data;
					const data =
						raw instanceof Uint8Array
							? raw.slice()
							: new Uint8Array(
									raw instanceof ArrayBuffer ? raw : Uint8Array.from(raw as ArrayLike<number>)
								);
					list.push({ ...sample, data });
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

		if (started && tracks.length > 0) {
			const enough = tracks.every((t) => {
				const list = collected.get(t.id) ?? [];
				if (list.length === 0) return false;
				const last = list[list.length - 1];
				return last.cts / last.timescale >= maxSec - 0.05;
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
		const codec = (track.codec ?? '').toLowerCase();
		let decoded: { samples: Float32Array; sampleRate: number } | null = null;

		if (codec.includes('mp4a') || codec.startsWith('aac') || !codec || codec.includes('40.')) {
			const asc = getAudioSpecificConfig(mp4, track.id);
			const adts = samplesToAdts(samples, asc, sampleRate, channels, maxSec);
			decoded = await decodeAdts(adts, maxSec);
		}

		if (!decoded) {
			decoded = await decodeWithWebCodecs(samples, track, mp4, maxSec);
		}

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

/** Max duration pulled for a full-track inject extract (2 hours). */
const FULL_EXTRACT_MAX_SEC = 2 * 60 * 60;

/**
 * Demux + decode an entire MP4 audio track (or up to {@link FULL_EXTRACT_MAX_SEC}).
 * Used when preparing inject audio from Medal / multi-track recordings.
 */
export async function extractMp4AudioTrackFull(
	file: File,
	trackId: number,
	signal?: AbortSignal
): Promise<ExtractedAudio | null> {
	const collected = await collectTrackSamples(file, trackId, FULL_EXTRACT_MAX_SEC, signal);
	if (!collected) return null;
	const decoded = await decodeCollectedTrack(collected, FULL_EXTRACT_MAX_SEC);
	if (!decoded || decoded.samples.length < decoded.sampleRate * 0.1) return null;
	return {
		samples: decoded.samples,
		sampleRate: decoded.sampleRate,
		trackLabel: `track ${trackId}`,
		trackId
	};
}

type CollectedSample = {
	data: Uint8Array;
	duration: number;
	cts: number;
	dts: number;
	is_sync: boolean;
	timescale: number;
};

type TrackRemuxMeta = {
	type: string;
	codec: string;
	timescale: number;
	channelCount: number;
	sampleSize: number;
	sampleRate: number;
	descriptionBoxes: unknown[];
};

function copySampleData(raw: ArrayBuffer | Uint8Array | ArrayLike<number>): Uint8Array {
	if (raw instanceof Uint8Array) return raw.slice();
	if (raw instanceof ArrayBuffer) return new Uint8Array(raw).slice();
	return Uint8Array.from(raw);
}

function dataStreamToUint8(stream: {
	buffer?: ArrayBuffer;
	byteOffset?: number;
	byteLength?: number;
	position?: number;
}): Uint8Array | null {
	const buf = stream.buffer;
	if (!buf) return null;
	const length = stream.byteLength ?? stream.position ?? (buf as ArrayBuffer).byteLength;
	if (typeof length !== 'number' || length <= 0) return null;
	try {
		return new Uint8Array(buf as ArrayBuffer, stream.byteOffset ?? 0, length);
	} catch {
		return null;
	}
}

function findAscInDescriptionBoxes(boxes: unknown[]): Uint8Array | undefined {
	for (const box of boxes) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const b: any = box;
		if (!b) continue;
		if (b.tag === 0x05 && b.data) {
			return b.data instanceof Uint8Array ? b.data : new Uint8Array(b.data);
		}
		const nested = findAscInDescriptionBoxes(b.descs ?? b.boxes ?? []);
		if (nested) return nested;
		if (b.esd?.descs) {
			const fromEsd = findAscInDescriptionBoxes(b.esd.descs);
			if (fromEsd) return fromEsd;
		}
	}
	return undefined;
}

async function decodeCollectedTrack(
	collected: { meta: TrackRemuxMeta; samples: CollectedSample[] },
	maxSec: number
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
	const { meta, samples } = collected;
	if (!samples.length) return null;

	const asSamples: Sample[] = samples.map((s) => ({
		data: s.data,
		cts: s.cts,
		dts: s.dts,
		duration: s.duration,
		timescale: s.timescale,
		is_sync: s.is_sync
	}));

	const codec = meta.codec.toLowerCase();
	if (
		meta.type === 'mp4a' ||
		codec.includes('mp4a') ||
		codec.includes('aac') ||
		codec.includes('40.')
	) {
		const asc = findAscInDescriptionBoxes(meta.descriptionBoxes);
		const adts = samplesToAdts(asSamples, asc, meta.sampleRate, meta.channelCount, maxSec);
		const decoded = await decodeAdts(adts, maxSec);
		if (decoded && decoded.samples.length >= decoded.sampleRate * 0.2) return decoded;
	}

	return decodeWithWebCodecs(
		asSamples,
		{
			id: 0,
			codec: meta.codec,
			audio: { sample_rate: meta.sampleRate, channel_count: meta.channelCount }
		},
		{
			getTrackById: () => ({
				mdia: {
					minf: {
						stbl: {
							stsd: {
								entries: [{ esds: meta.descriptionBoxes[0], boxes: meta.descriptionBoxes }]
							}
						}
					}
				}
			})
		},
		maxSec
	);
}

async function collectTrackSamples(
	file: File,
	trackId: number,
	maxSec: number,
	signal?: AbortSignal
): Promise<{ meta: TrackRemuxMeta; samples: CollectedSample[] } | null> {
	throwIfAborted(signal);
	const { createFile, MP4BoxBuffer } = await import('mp4box');
	throwIfAborted(signal);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mp4: any = createFile();
	// Default true: fine once extraction is armed. Moov-at-end Medal files need a
	// second pass from byte 0 after moov is known (mdat was discarded on first pass).
	mp4.discardMdatData = true;

	const samples: CollectedSample[] = [];
	let meta: TrackRemuxMeta | null = null;

	const ready = new Promise<void>((resolve, reject) => {
		mp4.onError = (msg: string) => reject(new Error(msg || 'MP4 parse failed'));
		mp4.onReady = (movie: { audioTracks?: Mp4AudioTrackInfo[] }) => {
			const track = (movie.audioTracks ?? []).find((t) => t.id === trackId);
			if (!track) {
				reject(new Error('Audio track not found'));
				return;
			}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const trak: any = mp4.getTrackById?.(trackId);
			const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
			const boxes = entry?.boxes ? [...entry.boxes] : entry?.esds ? [entry.esds] : [];
			const rawRate = track.audio?.sample_rate || entry?.samplerate || 48000;
			// AudioSampleEntry.samplerate is often 16.16 fixed-point.
			const sampleRate = rawRate > 100000 ? Math.round(rawRate / 65536) : rawRate;
			meta = {
				type: entry?.type || (String(track.codec).toLowerCase().includes('opus') ? 'Opus' : 'mp4a'),
				codec: track.codec ?? '',
				timescale:
					(track as { timescale?: number }).timescale || trak?.mdia?.mdhd?.timescale || 48000,
				channelCount: track.audio?.channel_count || entry?.channel_count || 2,
				sampleSize: entry?.samplesize || 16,
				sampleRate,
				descriptionBoxes: boxes
			};
			mp4.onSamples = (_id: number, _user: unknown, batch: Sample[]) => {
				for (const sample of batch) {
					if (sample.cts / sample.timescale > maxSec + 0.5) continue;
					const data = copySampleData(sample.data);
					if (!data.byteLength) continue;
					samples.push({
						data,
						duration: sample.duration,
						cts: sample.cts,
						dts: sample.dts ?? sample.cts,
						is_sync: sample.is_sync,
						timescale: sample.timescale
					});
				}
			};
			mp4.setExtractionOptions(trackId, trackId, { nbSamples: 100 });
			mp4.start();
			resolve();
		};
	});

	const appendRange = async (start: number, end: number) => {
		throwIfAborted(signal);
		if (end <= start) return start;
		const ab = await file.slice(start, end).arrayBuffer();
		throwIfAborted(signal);
		const next = mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, start));
		return typeof next === 'number' && next > start ? next : end;
	};

	const enoughSamples = () => {
		if (samples.length === 0) return false;
		const last = samples[samples.length - 1];
		// Preview callers pass maxSec ≈ 8; full inject passes a large maxSec and must
		// read until that duration (or EOF via the append loops below).
		return last.cts / last.timescale >= maxSec - 0.05;
	};

	// Pass 1: find moov. Medal/ffmpeg often put moov at the end — probe the tail first.
	const tailBytes = Math.min(file.size, 8 * MP4_CHUNK_SIZE);
	if (tailBytes > 0) {
		await appendRange(file.size - tailBytes, file.size);
	}

	if (!mp4.moov) {
		let offset = 0;
		const stopBeforeTail = Math.max(0, file.size - tailBytes);
		let guard = 0;
		while (!mp4.moov && offset < stopBeforeTail && guard < 1536) {
			guard += 1;
			offset = await appendRange(offset, Math.min(offset + MP4_CHUNK_SIZE, stopBeforeTail));
		}
	}

	try {
		await ready;
	} catch {
		return null;
	}

	// Pass 2: if mdat came before moov, payloads were discarded — re-read from the start
	// with extraction already armed so onSamples receives real data.
	if (!enoughSamples()) {
		let offset = 0;
		let guard = 0;
		while (offset < file.size && guard < 1536 && !enoughSamples()) {
			guard += 1;
			const end = Math.min(offset + MP4_CHUNK_SIZE, file.size);
			try {
				offset = await appendRange(offset, end);
			} catch {
				offset = end;
			}
		}
	}

	mp4.flush();
	try {
		mp4.stop();
	} catch {
		/* ignore */
	}

	if (!meta || samples.length === 0) return null;
	return { meta, samples };
}

async function decodeWithWebCodecs(
	samples: Sample[],
	track: Mp4AudioTrackInfo,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mp4: any,
	maxSec: number
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
	if (typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined') return null;

	const sampleRate = track.audio?.sample_rate || 44100;
	const channels = track.audio?.channel_count || 1;
	let codec = (track.codec || '').trim();
	if (!codec) return null;
	if (/^opus$/i.test(codec)) codec = 'opus';

	const config: AudioDecoderConfig = {
		codec,
		sampleRate,
		numberOfChannels: channels
	};
	const asc = getAudioSpecificConfig(mp4, track.id);
	if (asc && /mp4a|aac/i.test(codec)) {
		config.description = Uint8Array.from(asc).buffer;
	}

	try {
		const support = await AudioDecoder.isConfigSupported(config);
		if (!support.supported) return null;
	} catch {
		return null;
	}

	const chunks: Float32Array[] = [];
	let outRate = sampleRate;
	let frames = 0;
	const maxFrames = Math.ceil(sampleRate * maxSec);

	try {
		await new Promise<void>((resolve, reject) => {
			const decoder = new AudioDecoder({
				output: (audioData) => {
					try {
						outRate = audioData.sampleRate;
						const need = Math.min(audioData.numberOfFrames, Math.max(0, maxFrames - frames));
						if (need <= 0) {
							audioData.close();
							return;
						}
						const mono = new Float32Array(need);
						const ch = audioData.numberOfChannels;
						for (let c = 0; c < ch; c++) {
							const plane = new Float32Array(need);
							audioData.copyTo(plane, { planeIndex: c, frameOffset: 0, frameCount: need });
							for (let i = 0; i < need; i++) mono[i] += plane[i] / ch;
						}
						chunks.push(mono);
						frames += need;
						audioData.close();
					} catch (e) {
						audioData.close();
						reject(e);
					}
				},
				error: (e) => reject(e)
			});
			decoder.configure(config);
			for (const sample of samples) {
				if (frames >= maxFrames) break;
				if (sample.cts / sample.timescale > maxSec + 0.25) break;
				const data =
					sample.data instanceof Uint8Array
						? sample.data
						: new Uint8Array(
								sample.data instanceof ArrayBuffer
									? sample.data
									: Uint8Array.from(sample.data as ArrayLike<number>)
							);
				decoder.decode(
					new EncodedAudioChunk({
						type: sample.is_sync ? 'key' : 'delta',
						timestamp: Math.round((sample.cts / sample.timescale) * 1e6),
						duration: Math.round((sample.duration / sample.timescale) * 1e6),
						data
					})
				);
			}
			decoder
				.flush()
				.then(() => {
					decoder.close();
					resolve();
				})
				.catch(reject);
		});
	} catch {
		return null;
	}

	if (!chunks.length || frames < sampleRate * 0.2) return null;
	const merged = new Float32Array(frames);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk.subarray(0, Math.min(chunk.length, merged.length - offset)), offset);
		offset += chunk.length;
		if (offset >= merged.length) break;
	}
	return { samples: merged.subarray(0, Math.min(offset, maxFrames)), sampleRate: outRate };
}

/**
 * Remux the first `maxSec` of one audio track into a tiny playable MP4/M4A blob.
 * Works for AAC and Opus without relying on ADTS + decodeAudioData.
 */
export async function remuxMp4AudioTrackHead(
	file: File,
	trackId: number,
	maxSec: number,
	signal?: AbortSignal
): Promise<Blob | null> {
	const name = file.name.toLowerCase();
	const type = file.type.toLowerCase();
	const isMp4Family =
		type.includes('mp4') ||
		type.includes('m4a') ||
		type.includes('quicktime') ||
		/\.(mp4|m4a|mov)$/i.test(name);
	if (!isMp4Family) return null;

	const collected = await collectTrackSamples(file, trackId, maxSec, signal);
	if (!collected) return null;

	const { createFile } = await import('mp4box');
	throwIfAborted(signal);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const out: any = createFile();
	const { meta, samples } = collected;
	const options: Record<string, unknown> = {
		id: 1,
		type: meta.type,
		hdlr: 'soun',
		name: 'preview',
		timescale: meta.timescale,
		channel_count: meta.channelCount,
		samplesize: meta.sampleSize,
		samplerate: meta.sampleRate,
		language: 'und'
	};
	if (meta.descriptionBoxes.length) {
		options.description_boxes = meta.descriptionBoxes;
	}

	const newId = out.addTrack(options);
	if (!newId) return null;

	for (const sample of samples) {
		out.addSample(newId, sample.data, {
			duration: sample.duration,
			cts: sample.cts,
			dts: sample.dts,
			is_sync: sample.is_sync
		});
	}

	const stream = out.getBuffer();
	const bytes = dataStreamToUint8(stream);
	if (!bytes || bytes.byteLength < 64) return null;
	// Copy so we don't retain the DataStream's backing buffer.
	return new Blob([bytes.slice()], { type: 'audio/mp4' });
}
