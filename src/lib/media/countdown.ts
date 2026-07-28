/** Heuristic countdown ("3, 2, 1, GO") detection from media audio. */

export type CountdownDetection = {
	/** Estimated media time of GO / game start (seconds). */
	gameStartSec: number;
	/** Peak times believed to be countdown hits. */
	peakTimes: number[];
	confidence: 'low' | 'medium' | 'high';
	method: 'decoded' | 'element';
	detail: string;
};

const ANALYZE_WINDOW_SEC = 30;
const FRAME_SEC = 0.05;
const MIN_PEAK_GAP = 0.55;
const INTERVAL_MIN = 0.7;
const INTERVAL_MAX = 1.4;

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

function rms(frame: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
	return Math.sqrt(sum / Math.max(1, frame.length));
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
	return sorted[idx];
}

/** Build per-frame RMS energy for mono samples. */
export function frameEnergies(
	samples: Float32Array,
	sampleRate: number,
	frameSec = FRAME_SEC
): { t: number; e: number }[] {
	const frameSize = Math.max(1, Math.floor(sampleRate * frameSec));
	const out: { t: number; e: number }[] = [];
	for (let i = 0; i + frameSize <= samples.length; i += frameSize) {
		out.push({
			t: i / sampleRate,
			e: rms(samples.subarray(i, i + frameSize))
		});
	}
	return out;
}

function smoothEnergies(
	frames: { t: number; e: number }[],
	radius = 1
): { t: number; e: number }[] {
	return frames.map((frame, i) => {
		let sum = 0;
		let n = 0;
		for (let j = i - radius; j <= i + radius; j++) {
			if (j < 0 || j >= frames.length) continue;
			sum += frames[j].e;
			n += 1;
		}
		return { t: frame.t, e: sum / Math.max(1, n) };
	});
}

function findPeaks(frames: { t: number; e: number }[]): number[] {
	if (frames.length < 5) return [];
	const energies = frames.map((f) => f.e).sort((a, b) => a - b);
	const baseline = percentile(energies, 0.5);
	const high = percentile(energies, 0.9);
	const threshold = Math.max(baseline * 2.2, baseline + (high - baseline) * 0.35, 0.01);

	const candidates: { t: number; e: number }[] = [];
	for (let i = 1; i < frames.length - 1; i++) {
		const e = frames[i].e;
		if (e < threshold) continue;
		if (e >= frames[i - 1].e && e >= frames[i + 1].e) {
			candidates.push(frames[i]);
		}
	}

	// Enforce minimum spacing, keeping louder peaks
	candidates.sort((a, b) => b.e - a.e);
	const chosen: { t: number; e: number }[] = [];
	for (const c of candidates) {
		if (chosen.some((p) => Math.abs(p.t - c.t) < MIN_PEAK_GAP)) continue;
		chosen.push(c);
	}
	return chosen.map((p) => p.t).sort((a, b) => a - b);
}

/**
 * Find a 3–4 hit cadence typical of spoken/beep countdowns and return GO time.
 */
export function detectCountdownFromEnergies(
	frames: { t: number; e: number }[]
): Omit<CountdownDetection, 'method'> | null {
	const smoothed = smoothEnergies(frames);
	const peaks = findPeaks(smoothed);
	if (peaks.length < 3) {
		return null;
	}

	type Run = { idxs: number[]; score: number; meanInterval: number };
	let best: Run | null = null;

	for (const len of [4, 3]) {
		for (let i = 0; i + len - 1 < peaks.length; i++) {
			const idxs = Array.from({ length: len }, (_, k) => i + k);
			const times = idxs.map((ix) => peaks[ix]);
			const intervals: number[] = [];
			for (let k = 1; k < times.length; k++) intervals.push(times[k] - times[k - 1]);
			const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
			if (mean < INTERVAL_MIN || mean > INTERVAL_MAX) continue;
			const ok = intervals.every((d) => Math.abs(d - mean) <= 0.35);
			if (!ok) continue;
			// Prefer earlier runs (countdown usually at start) and 4-hit patterns
			const earliness = 1 / (1 + times[0]);
			const score = (len === 4 ? 2 : 1) * earliness;
			if (!best || score > best.score) best = { idxs, score, meanInterval: mean };
		}
		if (best && len === 4) break;
	}

	if (!best) return null;

	const peakTimes = best.idxs.map((ix) => peaks[ix]);
	const last = peakTimes[peakTimes.length - 1];
	let gameStartSec: number;
	if (peakTimes.length >= 4) {
		// 3,2,1,GO → GO is last
		gameStartSec = last;
	} else if (peakTimes[0] <= 0.45) {
		// Likely 3,2,1 with GO right after
		gameStartSec = last + best.meanInterval;
	} else {
		// Probably missed the first count; treat last hit as GO
		gameStartSec = last;
	}

	const confidence: CountdownDetection['confidence'] =
		peakTimes.length >= 4 && best.meanInterval >= 0.85 && best.meanInterval <= 1.15
			? 'high'
			: peakTimes.length >= 4 || (peakTimes.length === 3 && peakTimes[0] > 0.45)
				? 'medium'
				: 'low';

	return {
		gameStartSec: Math.round(gameStartSec * 100) / 100,
		peakTimes,
		confidence,
		detail: `Found ${peakTimes.length}-hit cadence (~${best.meanInterval.toFixed(2)}s apart).`
	};
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

async function decodeWavPcm(
	file: File
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
	const buf = await file.arrayBuffer();
	if (buf.byteLength < 44) return null;
	const view = new DataView(buf);
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
	let sampleRate = 48000;
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

	const maxSamples = Math.floor(sampleRate * ANALYZE_WINDOW_SEC) * channels;
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

async function detectFromDecoded(file: File): Promise<CountdownDetection | null> {
	// Prefer lightweight WAV PCM parse (no AudioContext needed for header/body slice).
	if (file.type.includes('wav') || file.name.toLowerCase().endsWith('.wav')) {
		const wav = await decodeWavPcm(file);
		if (wav) {
			const frames = frameEnergies(wav.samples, wav.sampleRate);
			const hit = detectCountdownFromEnergies(frames);
			if (hit) return { ...hit, method: 'decoded' };
		}
	}

	const Ctor = AudioCtx();
	if (!Ctor) return null;
	const ctx = new Ctor();
	try {
		const audio = await ctx.decodeAudioData(await file.arrayBuffer());
		const mono = mixToMono(audio, ANALYZE_WINDOW_SEC);
		const frames = frameEnergies(mono, audio.sampleRate);
		const hit = detectCountdownFromEnergies(frames);
		if (!hit) return null;
		return { ...hit, method: 'decoded' };
	} finally {
		await ctx.close().catch(() => undefined);
	}
}

/**
 * Fast-ish scan via media element (good for large MP4s — avoids full decode).
 * Plays muted/fast through the first ANALYZE_WINDOW_SEC of timeline.
 */
async function detectFromElement(file: File): Promise<CountdownDetection | null> {
	const Ctor = AudioCtx();
	if (!Ctor || typeof document === 'undefined') return null;

	const url = URL.createObjectURL(file);
	const media = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio') as
		HTMLVideoElement | HTMLAudioElement;
	media.src = url;
	media.preload = 'auto';
	if ('playsInline' in media) (media as HTMLVideoElement).playsInline = true;
	media.playbackRate = 3;

	const ctx = new Ctor();
	const source = ctx.createMediaElementSource(media);
	const analyser = ctx.createAnalyser();
	analyser.fftSize = 2048;
	const silence = ctx.createGain();
	silence.gain.value = 0;
	source.connect(analyser);
	analyser.connect(silence);
	silence.connect(ctx.destination);

	const data = new Uint8Array(analyser.fftSize);
	const frames: { t: number; e: number }[] = [];

	try {
		await new Promise<void>((resolve, reject) => {
			media.onloadedmetadata = () => resolve();
			media.onerror = () => reject(new Error('Could not load media for countdown detection.'));
		});
		if (ctx.state === 'suspended') await ctx.resume();
		await media.play();

		await new Promise<void>((resolve) => {
			const tick = () => {
				const t = media.currentTime;
				analyser.getByteTimeDomainData(data);
				let sum = 0;
				for (let i = 0; i < data.length; i++) {
					const v = (data[i] - 128) / 128;
					sum += v * v;
				}
				frames.push({ t, e: Math.sqrt(sum / data.length) });
				if (t >= ANALYZE_WINDOW_SEC || media.ended) {
					media.pause();
					resolve();
					return;
				}
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
	} finally {
		media.pause();
		URL.revokeObjectURL(url);
		source.disconnect();
		analyser.disconnect();
		silence.disconnect();
		await ctx.close().catch(() => undefined);
	}

	// Resample irregular RAF samples onto a regular grid
	const grid: { t: number; e: number }[] = [];
	for (let t = 0; t < ANALYZE_WINDOW_SEC; t += FRAME_SEC) {
		let best: { t: number; e: number } | null = null;
		let bestDist = Infinity;
		for (const f of frames) {
			const d = Math.abs(f.t - t);
			if (d < bestDist) {
				bestDist = d;
				best = f;
			}
		}
		grid.push({ t, e: best && bestDist < FRAME_SEC * 2 ? best.e : 0 });
	}

	const hit = detectCountdownFromEnergies(grid);
	if (!hit) return null;
	return { ...hit, method: 'element' };
}

/**
 * Attempt to find countdown GO time in a media file.
 * Tries full decode for smaller files; falls back to fast muted element scan.
 */
export async function detectCountdownGameStart(file: File): Promise<CountdownDetection | null> {
	const preferDecode =
		file.size <= 40 * 1024 * 1024 ||
		file.type.includes('wav') ||
		file.name.toLowerCase().endsWith('.wav');

	if (preferDecode) {
		try {
			const decoded = await detectFromDecoded(file);
			if (decoded) return decoded;
		} catch {
			// fall through
		}
	}

	try {
		return await detectFromElement(file);
	} catch {
		if (!preferDecode) {
			try {
				return await detectFromDecoded(file);
			} catch {
				return null;
			}
		}
		return null;
	}
}
