import { extractMp4AudioTrackHeads } from '$lib/media/mp4-audio';

/**
 * TF2 Administrator countdown detection via waveform template matching.
 *
 * Templates: static/tf2-announcer/announcer_begins_{5..1}sec.wav
 * (Valve TF2 assets mirrored from the Team Fortress Wiki).
 *
 * No speech recognition — normalized cross-correlation against the official
 * announcer lines, then an ordered 5→1 / 3→2→1 cadence check.
 */

export type CountdownDetection = {
	ok: true;
	gameStartSec: number;
	/** Matched digit → media time of template onset. */
	matches: Partial<Record<CountdownDigit, { time: number; score: number }>>;
	confidence: 'low' | 'medium' | 'high';
	method: 'template';
	detail: string;
};

export type CountdownMiss = {
	ok: false;
	detail: string;
};

export type CountdownResult = CountdownDetection | CountdownMiss;

export type CountdownDigit = 1 | 2 | 3 | 4 | 5;

const DIGITS: CountdownDigit[] = [5, 4, 3, 2, 1];
const WORK_RATE = 12000;
/** Opening window — Medal countdown is almost always here. */
const ANALYZE_SEC = 10;
const HOP_SEC = 0.02;
const MIN_SCORE = 0.06;
const PEAKS_PER_DIGIT = 8;
const PEAK_SEP_SEC = 0.4;
const INTERVAL_MIN = 0.55;
const INTERVAL_MAX = 1.5;
/** Countdown sync is almost always in the opening seconds of a Medal clip. */
const MAX_FIRST_DIGIT_SEC = 6;
/** Prefer streaming capture for video / large files (full decodeAudioData is too heavy). */
const FULL_DECODE_MAX_BYTES = 24 * 1024 * 1024;

/** "begins_1sec" means one second remains → fight/GO ≈ onset + 1s. */
const ONE_TO_GO_SEC = 1;

type Template = {
	digit: CountdownDigit;
	samples: Float32Array;
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

/** Call from a user-gesture handler so later media.play() / resume() still works. */
export function primeAudioContext(): AudioContext | null {
	const Ctor = AudioCtx();
	if (!Ctor) return null;
	const ctx = new Ctor();
	void ctx.resume();
	return ctx;
}

function downsample(mono: Float32Array, fromRate: number, toRate: number): Float32Array {
	if (fromRate === toRate) return mono;
	const ratio = fromRate / toRate;
	const outLen = Math.floor(mono.length / ratio);
	const out = new Float32Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const src = i * ratio;
		const i0 = Math.floor(src);
		const i1 = Math.min(mono.length - 1, i0 + 1);
		const frac = src - i0;
		out[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
	}
	return out;
}

/** Emphasize Administrator voice band (~300–3400 Hz) before matching. */
function voiceBandEmphasis(samples: Float32Array, sampleRate: number): Float32Array {
	const out = new Float32Array(samples.length);
	const hp = Math.exp((-2 * Math.PI * 300) / sampleRate);
	const lp = Math.exp((-2 * Math.PI * 3400) / sampleRate);
	let prevIn = 0;
	let hpState = 0;
	let lpState = 0;
	for (let i = 0; i < samples.length; i++) {
		const x = samples[i];
		hpState = hp * (hpState + x - prevIn);
		prevIn = x;
		lpState += (1 - lp) * (hpState - lpState);
		out[i] = lpState;
	}
	return out;
}

function prepareSignal(samples: Float32Array, sampleRate: number): Float32Array {
	return voiceBandEmphasis(downsample(samples, sampleRate, WORK_RATE), WORK_RATE);
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

function channelSignals(buffer: AudioBuffer, maxSec: number): Float32Array[] {
	const rate = buffer.sampleRate;
	const frames = Math.min(buffer.length, Math.floor(rate * maxSec));
	const out: Float32Array[] = [];
	for (let c = 0; c < buffer.numberOfChannels; c++) {
		const data = buffer.getChannelData(c);
		out.push(data.subarray(0, frames));
	}
	return out;
}

async function decodeWavPcm(
	buffer: ArrayBuffer,
	maxSec = ANALYZE_SEC
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
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
	let channels = 1;
	let sampleRate = 44100;
	let bits = 16;
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
			bits = view.getUint16(offset + 22, true);
		} else if (id === 'data') {
			dataOffset = offset + 8;
			dataSize = size;
			break;
		}
		offset += 8 + size + (size % 2);
	}

	if (dataOffset < 0 || bits !== 16) return null;

	const maxSamples = Math.floor(sampleRate * maxSec) * channels;
	const available = Math.floor(dataSize / 2);
	const count = Math.min(available, maxSamples);
	const monoFrames = Math.floor(count / channels);
	const samples = new Float32Array(monoFrames);

	for (let i = 0; i < monoFrames; i++) {
		let sum = 0;
		for (let c = 0; c < channels; c++) {
			sum += view.getInt16(dataOffset + (i * channels + c) * 2, true) / 32768;
		}
		samples[i] = sum / channels;
	}

	return { samples, sampleRate };
}

/**
 * Capture the first `maxSec` of audio via an HTML media element.
 * Avoids loading / decoding an entire Medal recording into memory.
 */
async function captureMediaHead(
	file: File,
	maxSec: number,
	primed: AudioContext | null,
	signal?: AbortSignal
): Promise<{ samples: Float32Array; sampleRate: number }> {
	const Ctor = AudioCtx();
	if (!Ctor || typeof document === 'undefined') {
		throw new Error('Web Audio is required for countdown detection.');
	}

	const url = URL.createObjectURL(file);
	const isVideo = file.type.startsWith('video/') || /\.mp4$/i.test(file.name);
	const media = document.createElement(isVideo ? 'video' : 'audio') as
		HTMLVideoElement | HTMLAudioElement;
	media.src = url;
	media.preload = 'auto';
	media.controls = false;
	// Route through Web Audio (gain 0) instead of element mute — muted can yield silence to the graph.
	media.muted = false;
	media.volume = 1;
	if ('playsInline' in media) (media as HTMLVideoElement).playsInline = true;

	const ownsContext = !(primed && primed.state !== 'closed');
	const ctx = ownsContext ? new Ctor() : primed!;

	try {
		if (signal?.aborted) {
			const err = new Error('Cancelled');
			err.name = 'AbortError';
			throw err;
		}
		await new Promise<void>((resolve, reject) => {
			media.onloadedmetadata = () => resolve();
			media.onerror = () => reject(new Error('Could not load media for countdown detection.'));
		});

		if (ctx.state === 'suspended') await ctx.resume();

		const sampleRate = ctx.sampleRate;
		const limitSec = Math.min(maxSec, Number.isFinite(media.duration) ? media.duration : maxSec);
		const total = Math.max(1, Math.floor(sampleRate * limitSec));
		const mono = new Float32Array(total);
		let written = 0;

		const source = ctx.createMediaElementSource(media);
		const processor = ctx.createScriptProcessor(4096, 2, 1);
		const mute = ctx.createGain();
		mute.gain.value = 0;

		await new Promise<void>((resolve, reject) => {
			const timeoutMs = Math.max(12_000, limitSec * 1000 + 5_000);
			const timeout = window.setTimeout(() => {
				finish();
				reject(new Error('Timed out while reading audio for countdown detection.'));
			}, timeoutMs);

			const onAbort = () => {
				finish();
				const err = new Error('Cancelled');
				err.name = 'AbortError';
				reject(err);
			};
			signal?.addEventListener('abort', onAbort, { once: true });

			const finish = () => {
				window.clearTimeout(timeout);
				signal?.removeEventListener('abort', onAbort);
				processor.onaudioprocess = null;
				try {
					processor.disconnect();
				} catch {
					/* already disconnected */
				}
				try {
					source.disconnect();
				} catch {
					/* already disconnected */
				}
				try {
					mute.disconnect();
				} catch {
					/* already disconnected */
				}
				media.pause();
			};

			processor.onaudioprocess = (ev) => {
				if (signal?.aborted) {
					onAbort();
					return;
				}
				const input = ev.inputBuffer;
				const n = input.length;
				const ch = input.numberOfChannels;
				for (let i = 0; i < n && written < total; i++) {
					let sum = 0;
					for (let c = 0; c < ch; c++) sum += input.getChannelData(c)[i];
					mono[written++] = sum / ch;
				}
				if (written >= total || media.ended) {
					finish();
					resolve();
				}
			};

			source.connect(processor);
			processor.connect(mute);
			mute.connect(ctx.destination);

			media.currentTime = 0;
			void media.play().catch((err) => {
				finish();
				reject(
					err instanceof Error ? err : new Error('Could not play media for countdown detection.')
				);
			});
		});

		if (written < sampleRate * 0.4) {
			throw new Error('Captured too little audio for countdown detection.');
		}

		return { samples: mono.subarray(0, written), sampleRate };
	} finally {
		URL.revokeObjectURL(url);
		media.removeAttribute('src');
		media.load();
		if (ownsContext) await ctx.close().catch(() => undefined);
	}
}

async function decodeAudioCandidates(
	file: File,
	maxSec: number,
	primed: AudioContext | null,
	signal?: AbortSignal
): Promise<{ signals: Float32Array[]; sampleRate: number; sourceNote: string }> {
	if (signal?.aborted) {
		const err = new Error('Cancelled');
		err.name = 'AbortError';
		throw err;
	}

	if (file.type.includes('wav') || file.name.toLowerCase().endsWith('.wav')) {
		const wav = await decodeWavPcm(await file.arrayBuffer(), maxSec);
		if (wav) return { signals: [wav.samples], sampleRate: wav.sampleRate, sourceNote: 'wav' };
	}

	// Medal multi-track: demux preferred tracks (game first) so we don't hear Discord-only.
	try {
		const extracted = await extractMp4AudioTrackHeads(file, maxSec, signal);
		if (extracted.length > 0) {
			return {
				signals: extracted.map((e) => e.samples),
				sampleRate: extracted[0].sampleRate,
				sourceNote: `mp4 tracks: ${extracted.map((e) => e.trackLabel).join(', ')}`
			};
		}
	} catch (e) {
		if (e instanceof Error && e.name === 'AbortError') throw e;
		/* fall through to capture / decodeAudioData */
	}

	const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/i.test(file.name);
	const useCapture = isVideo || file.size > FULL_DECODE_MAX_BYTES;

	if (useCapture) {
		const head = await captureMediaHead(file, maxSec, primed, signal);
		return { signals: [head.samples], sampleRate: head.sampleRate, sourceNote: 'media element' };
	}

	const Ctor = AudioCtx();
	if (!Ctor) throw new Error('Web Audio is required for countdown detection.');
	const ctx = primed && primed.state !== 'closed' ? primed : new Ctor();
	const owns = ctx !== primed;
	try {
		if (ctx.state === 'suspended') await ctx.resume();
		const audio = await ctx.decodeAudioData(await file.arrayBuffer());
		const signals = [mixToMono(audio, maxSec), ...channelSignals(audio, maxSec)];
		return { signals, sampleRate: audio.sampleRate, sourceNote: 'decodeAudioData' };
	} finally {
		if (owns) await ctx.close().catch(() => undefined);
	}
}

async function loadTemplates(): Promise<Template[]> {
	const out: Template[] = [];
	for (const digit of DIGITS) {
		const url = `/tf2-announcer/announcer_begins_${digit}sec.wav`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`Missing countdown template ${url}`);
		const decoded = await decodeWavPcm(await res.arrayBuffer(), 5);
		if (!decoded) throw new Error(`Could not decode template ${url}`);
		out.push({
			digit,
			samples: prepareSignal(decoded.samples, decoded.sampleRate)
		});
	}
	return out;
}

function templateEnergy(template: Float32Array): number {
	let e = 0;
	for (let i = 0; i < template.length; i++) e += template[i] * template[i];
	return Math.sqrt(e) + 1e-12;
}

type Match = { digit: CountdownDigit; time: number; score: number };

/** Top-K NCC peaks for one template (NMS-separated), so late decoys don't hide early hits. */
function templatePeaks(
	signal: Float32Array,
	template: Float32Array,
	sampleRate: number,
	digit: CountdownDigit
): Match[] {
	const hop = Math.max(1, Math.floor(sampleRate * HOP_SEC));
	const tNorm = templateEnergy(template);
	const raw: Match[] = [];

	for (let i = 0; i + template.length <= signal.length; i += hop) {
		let dot = 0;
		let sEnergy = 0;
		for (let j = 0; j < template.length; j++) {
			const s = signal[i + j];
			dot += s * template[j];
			sEnergy += s * s;
		}
		const score = dot / ((Math.sqrt(sEnergy) + 1e-12) * tNorm);
		if (score >= MIN_SCORE) {
			raw.push({ digit, time: i / sampleRate, score });
		}
	}

	raw.sort((a, b) => b.score - a.score);

	const kept: Match[] = [];
	for (const p of raw) {
		if (kept.every((k) => Math.abs(k.time - p.time) >= PEAK_SEP_SEC)) {
			const center = Math.round(p.time * sampleRate);
			let bestScore = p.score;
			let bestIndex = center;
			const radius = hop;
			const start = Math.max(0, center - radius);
			const end = Math.min(signal.length - template.length, center + radius);
			for (let i = start; i <= end; i++) {
				let dot = 0;
				let sEnergy = 0;
				for (let j = 0; j < template.length; j++) {
					const s = signal[i + j];
					dot += s * template[j];
					sEnergy += s * s;
				}
				const score = dot / ((Math.sqrt(sEnergy) + 1e-12) * tNorm);
				if (score > bestScore) {
					bestScore = score;
					bestIndex = i;
				}
			}
			kept.push({ digit, time: bestIndex / sampleRate, score: bestScore });
		}
		if (kept.length >= PEAKS_PER_DIGIT) break;
	}

	return kept;
}

function pickSequence(
	candidates: Match[]
): { chosen: Match[]; confidence: CountdownDetection['confidence']; score: number } | null {
	const byDigit = new Map<CountdownDigit, Match[]>();
	for (const m of candidates) {
		const list = byDigit.get(m.digit) ?? [];
		list.push(m);
		byDigit.set(m.digit, list);
	}

	const sequences: CountdownDigit[][] = [
		[5, 4, 3, 2, 1],
		[4, 3, 2, 1],
		[3, 2, 1],
		[2, 1]
	];

	type Cand = { chosen: Match[]; score: number; confidence: CountdownDetection['confidence'] };
	const ranked: Cand[] = [];

	for (const seq of sequences) {
		const pools = seq.map((d) => byDigit.get(d) ?? []);
		if (pools.some((p) => p.length === 0)) continue;

		const idxs = new Array(seq.length).fill(0);
		const walk = () => {
			const chosen = pools.map((pool, i) => pool[idxs[i]]);
			let ok = true;

			if (chosen[0].time > MAX_FIRST_DIGIT_SEC) ok = false;

			for (let i = 1; i < chosen.length && ok; i++) {
				const dt = chosen[i].time - chosen[i - 1].time;
				const step = chosen[i - 1].digit - chosen[i].digit;
				if (step < 1 || dt < INTERVAL_MIN * step || dt > INTERVAL_MAX * step) {
					ok = false;
				}
			}
			if (!ok) return;

			const minScore = Math.min(...chosen.map((c) => c.score));
			const avgScore = chosen.reduce((a, c) => a + c.score, 0) / chosen.length;
			const earliness = 1 / (1 + chosen[0].time);
			const total = avgScore * 2 + minScore + earliness * 1.5 + chosen.length * 0.2;
			const confidence: CountdownDetection['confidence'] =
				chosen.length >= 4 && minScore >= 0.28
					? 'high'
					: chosen.length >= 3 && minScore >= 0.15
						? 'medium'
						: 'low';

			ranked.push({ chosen, score: total, confidence });
		};

		const advance = (): boolean => {
			for (let i = seq.length - 1; i >= 0; i--) {
				idxs[i]++;
				if (idxs[i] < pools[i].length) return true;
				idxs[i] = 0;
			}
			return false;
		};

		walk();
		while (advance()) walk();
	}

	if (ranked.length === 0) return null;
	ranked.sort((a, b) => b.score - a.score);
	return { chosen: ranked[0].chosen, confidence: ranked[0].confidence, score: ranked[0].score };
}

function summarizePeaks(candidates: Match[]): string {
	if (candidates.length === 0) return 'No announcer-like peaks in the first ~20s.';
	const best = [...candidates].sort((a, b) => b.score - a.score).slice(0, 5);
	return `Closest peaks: ${best.map((m) => `${m.digit}@${m.time.toFixed(2)}s(${m.score.toFixed(2)})`).join(', ')}.`;
}

let templatesPromise: Promise<Template[]> | null = null;

function getTemplates(): Promise<Template[]> {
	if (!templatesPromise) {
		templatesPromise = loadTemplates().catch((err) => {
			templatesPromise = null;
			throw err;
		});
	}
	return templatesPromise;
}

function detectionFromSequence(seq: {
	chosen: Match[];
	confidence: CountdownDetection['confidence'];
}): CountdownDetection {
	const byDigit: CountdownDetection['matches'] = {};
	for (const m of seq.chosen) byDigit[m.digit] = { time: m.time, score: m.score };

	const one = byDigit[1];
	const two = byDigit[2];
	const three = byDigit[3];

	let gameStartSec: number;
	if (one) {
		gameStartSec = one.time + ONE_TO_GO_SEC;
	} else if (two) {
		gameStartSec = two.time + 2;
	} else if (three) {
		gameStartSec = three.time + 3;
	} else {
		const last = seq.chosen[seq.chosen.length - 1];
		gameStartSec = last.time + last.digit;
	}

	gameStartSec = Math.round(gameStartSec * 100) / 100;
	const label = seq.chosen.map((m) => `${m.digit}@${m.time.toFixed(2)}s`).join(' → ');

	return {
		ok: true,
		gameStartSec,
		matches: byDigit,
		confidence: seq.confidence,
		method: 'template',
		detail: `Found announcer ${label}.`
	};
}

function signalRms(samples: Float32Array): number {
	let e = 0;
	const n = Math.min(samples.length, samples.length);
	for (let i = 0; i < n; i++) e += samples[i] * samples[i];
	return Math.sqrt(e / Math.max(1, n));
}

/**
 * Match TF2 announcer 5…1 lines against the media waveform and estimate GO time.
 * Pass a primed AudioContext from the file-picker gesture when available.
 */
export async function detectCountdownGameStart(
	file: File,
	primed: AudioContext | null = null,
	abortSignal?: AbortSignal
): Promise<CountdownResult> {
	if (abortSignal?.aborted) {
		const err = new Error('Cancelled');
		err.name = 'AbortError';
		throw err;
	}

	const templates = await getTemplates();
	if (abortSignal?.aborted) {
		const err = new Error('Cancelled');
		err.name = 'AbortError';
		throw err;
	}

	const { signals, sampleRate, sourceNote } = await decodeAudioCandidates(
		file,
		ANALYZE_SEC,
		primed,
		abortSignal
	);

	let best: {
		chosen: Match[];
		confidence: CountdownDetection['confidence'];
		score: number;
	} | null = null;
	let allPeaks: Match[] = [];
	let loudest = 0;

	for (const raw of signals) {
		if (abortSignal?.aborted) {
			const err = new Error('Cancelled');
			err.name = 'AbortError';
			throw err;
		}
		loudest = Math.max(loudest, signalRms(raw));
		const prepared = prepareSignal(raw, sampleRate);
		const candidates: Match[] = [];
		for (const t of templates) {
			candidates.push(...templatePeaks(prepared, t.samples, WORK_RATE, t.digit));
		}
		allPeaks = allPeaks.concat(candidates);
		const seq = pickSequence(candidates);
		if (seq && (!best || seq.score > best.score)) best = seq;
	}

	if (!best) {
		const silenceHint =
			loudest < 1e-4 ? ' Captured audio looks silent — check the selected/default track.' : '';
		return {
			ok: false,
			detail: `No clear TF2 announcer 3-2-1 countdown in the first ~${ANALYZE_SEC}s (${sourceNote}).${silenceHint} ${summarizePeaks(allPeaks)}`
		};
	}

	const hit = detectionFromSequence(best);
	hit.detail = `${hit.detail} [${sourceNote}]`;
	return hit;
}
