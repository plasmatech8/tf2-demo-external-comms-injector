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

/** Skip full decode for large non-MP4/WAV files — listing tracks does not need PCM. */
const DECODE_SIZE_LIMIT = 32 * 1024 * 1024;
const MP4_CHUNK_SIZE = 1024 * 1024;

function looksLikeComms(name: string): boolean {
	return /discord|mic|microphone|voice|comms|chat|vc/i.test(name);
}

function looksLikeFullMix(name: string): boolean {
	return /all\s*audio|master|mix|full|everything/i.test(name);
}

function looksLikeGame(name: string): boolean {
	return /\bgame\b/i.test(name) && !looksLikeComms(name) && !looksLikeFullMix(name);
}

function isGenericHandlerName(name: string): boolean {
	return !name || /^sound\s*handler$/i.test(name) || /^audio$/i.test(name);
}

/** Prefer comms tracks; skip game audio and full mixes when multiple tracks exist. */
function defaultTrackSelection(name: string, total: number): boolean {
	if (total === 1) return true;
	if (looksLikeComms(name)) return true;
	if (looksLikeFullMix(name) || looksLikeGame(name)) return false;
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

type Mp4AudioTrack = {
	id: number;
	name?: string;
	audio?: { channel_count?: number; sample_rate?: number };
};

type Mp4Box = {
	type?: string;
	boxes?: Mp4Box[];
	track_id?: number;
	name?: string;
	handler?: string;
	data?: Uint8Array | ArrayLike<number>;
};

function decodeBoxString(data: Uint8Array | ArrayLike<number> | undefined): string {
	if (!data) return '';
	const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
	let end = bytes.length;
	while (end > 0 && bytes[end - 1] === 0) end -= 1;
	if (end <= 0) return '';

	// QuickTime Pascal-style length prefix
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

/**
 * Medal / ffmpeg often store human track titles in trak/udta/name,
 * while hdlr stays as the useless "SoundHandler".
 */
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

function sourcesFromMp4Tracks(audioTracks: Mp4AudioTrack[]): MediaSource[] {
	const sources: MediaSource[] = audioTracks.map((track, i) => {
		const rawName = (track.name ?? '').trim();
		const niceName = isGenericHandlerName(rawName) ? '' : rawName;
		const channels = track.audio?.channel_count ?? 0;
		const sampleRate = track.audio?.sample_rate ?? 0;
		const details = [
			channels ? `${channels}ch` : null,
			sampleRate ? `${Math.round(sampleRate / 100) / 10} kHz` : null
		].filter(Boolean);

		const label = niceName
			? [niceName, details.length ? details.join(' · ') : null].filter(Boolean).join(' — ')
			: [`Track ${i + 1}`, ...details].filter(Boolean).join(' — ');

		return {
			id: `track:${track.id}`,
			label,
			defaultSelected: defaultTrackSelection(niceName || rawName, audioTracks.length),
			trackId: track.id,
			channels: channels || undefined,
			sampleRate: sampleRate || undefined
		};
	});

	const hasComms = sources.some((s) => looksLikeComms(s.label));
	if (hasComms) {
		// Only inject voice/comms by default — leave game and mixes unchecked.
		for (const s of sources) {
			s.defaultSelected = looksLikeComms(s.label);
		}
	} else {
		const hasMix = sources.some((s) => looksLikeFullMix(s.label));
		if (hasMix) {
			for (const s of sources) {
				s.defaultSelected = !looksLikeFullMix(s.label);
			}
		}
	}

	return sources;
}

/**
 * Progressive MP4 parse — only reads chunks needed for the moov/header,
 * so multi‑GB Medal recordings stay fast.
 * Medal/ffmpeg often put `moov` at the end; probe the tail first.
 */
async function parseMp4AudioTracks(file: File): Promise<Mp4AudioTrack[]> {
	const { createFile, MP4BoxBuffer } = await import('mp4box');

	return new Promise((resolve, reject) => {
		// mp4box typings vary across builds; keep the instance loosely typed.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const mp4: any = createFile();
		let settled = false;

		const finish = (tracks: Mp4AudioTrack[]) => {
			if (settled) return;
			settled = true;
			resolve(tracks);
		};

		const fail = (err: unknown) => {
			if (settled) return;
			settled = true;
			reject(err instanceof Error ? err : new Error(String(err)));
		};

		mp4.onError = (err: string) => fail(new Error(err || 'Failed to parse MP4'));
		mp4.onReady = (movie: { audioTracks?: Mp4AudioTrack[] }) => {
			const displayNames = readTrackDisplayNames(mp4);
			const tracks = (movie.audioTracks ?? []).map((track) => ({
				...track,
				name: displayNames.get(track.id) || track.name
			}));
			finish(tracks);
		};

		void (async () => {
			try {
				const appendRange = async (start: number, end: number) => {
					if (settled || end <= start) return start;
					const ab = await file.slice(start, end).arrayBuffer();
					if (settled) return start;
					const next = mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, start));
					return typeof next === 'number' && next > start ? next : end;
				};

				// Pass 1: tail probe — moov-at-end is common for Medal clips.
				const tailBytes = Math.min(file.size, 8 * MP4_CHUNK_SIZE);
				if (tailBytes > 0) {
					await appendRange(file.size - tailBytes, file.size);
				}

				// Pass 2: scan from the start if moov still missing (faststart / moov early).
				if (!settled && !mp4.moov) {
					let offset = 0;
					const stopBeforeTail = Math.max(0, file.size - tailBytes);
					let guard = 0;
					while (!settled && !mp4.moov && offset < stopBeforeTail && guard < 64) {
						guard += 1;
						offset = await appendRange(offset, Math.min(offset + MP4_CHUNK_SIZE, stopBeforeTail));
					}
				}

				if (!settled) {
					mp4.flush();
				}

				if (!settled) {
					fail(
						new Error(
							'Could not find MP4 metadata (moov). The file may be incomplete or still recording.'
						)
					);
				}
			} catch (e) {
				fail(e);
			}
		})();
	});
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

	const audioTracks = await parseMp4AudioTracks(file);
	if (audioTracks.length === 0) {
		return {
			kind: 'tracks',
			sources: [],
			summary: 'No audio tracks found in this file.'
		};
	}

	const sources = sourcesFromMp4Tracks(audioTracks);
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

	// Only need the RIFF header / fmt chunk — not the whole (often huge) PCM body.
	const headerBuf = await file.slice(0, Math.min(file.size, 65536)).arrayBuffer();
	const header = readWavHeader(headerBuf);
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

function singleTrackFallback(summary: string): MediaInspection {
	return {
		kind: 'tracks',
		sources: [
			{
				id: 'track:0',
				label: 'Default audio',
				defaultSelected: true
			}
		],
		summary
	};
}

async function inspectDecodedChannels(file: File): Promise<MediaInspection> {
	if (file.size > DECODE_SIZE_LIMIT) {
		return singleTrackFallback(
			`Large file (${(file.size / (1024 * 1024)).toFixed(0)} MB) — skipped full decode; treating as one audio stream.`
		);
	}

	const AudioCtx =
		typeof AudioContext !== 'undefined'
			? AudioContext
			: typeof window !== 'undefined'
				? window.webkitAudioContext
				: undefined;

	if (!AudioCtx) {
		return singleTrackFallback('Audio decoding unavailable; treating as a single track.');
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
		return singleTrackFallback('Could not decode audio; treating as a single track.');
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
