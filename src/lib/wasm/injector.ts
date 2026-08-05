/**
 * Lazy-load the Rust injector WASM (browser only).
 */

import init, {
	inject_comms,
	inspect_demo,
	WasmInjectOptions,
	type WasmInjectResult
} from '$lib/wasm/pkg/tf2_demo_comms_injector.js';
import wasmUrl from '$lib/wasm/pkg/tf2_demo_comms_injector_bg.wasm?url';

export type InjectMeta = {
	output: string;
	player: {
		client_index: number;
		entity_id: number;
		user_id: number;
		name: string;
		steam_id: string;
		steam_id64: number | null;
	};
	start_tick: number;
	offset_secs: number;
	offset_source: string;
	audio_skip_secs: number;
	packets_injected: number;
	voice_init: { codec: string; quality: number; sampling_rate: number } | null;
};

export type InjectRequest = {
	demo: Uint8Array;
	audioWav: Uint8Array;
	audioSkipSecs: number;
	/** Omit / negative → auto teamplay_round_start. */
	offsetSecs?: number | null;
	playerName?: string | null;
	steamId?: string | null;
	sampleRate?: number;
	bitrate?: number;
	loudnessDb?: number;
	replaceExisting?: boolean;
};

export type InjectOutput = {
	demo: Uint8Array;
	meta: InjectMeta;
};

let ready: Promise<void> | null = null;

async function ensureWasm(): Promise<void> {
	if (!ready) {
		ready = init({ module_or_path: wasmUrl }).then(() => undefined);
	}
	await ready;
}

export async function inspectDemoWasm(demo: Uint8Array): Promise<unknown> {
	await ensureWasm();
	return inspect_demo(demo);
}

export async function injectCommsWasm(req: InjectRequest): Promise<InjectOutput> {
	await ensureWasm();
	const opts = new WasmInjectOptions();
	opts.audio_skip_secs = req.audioSkipSecs;
	opts.offset_secs = req.offsetSecs === undefined || req.offsetSecs === null ? -1 : req.offsetSecs;
	opts.player_name = req.playerName ?? undefined;
	opts.steam_id = req.steamId ?? undefined;
	if (req.sampleRate) opts.sample_rate = req.sampleRate;
	if (req.bitrate) opts.bitrate = req.bitrate;
	if (req.loudnessDb !== undefined) opts.loudness_db = req.loudnessDb;
	if (req.replaceExisting !== undefined) opts.replace_existing = req.replaceExisting;

	let result: WasmInjectResult;
	try {
		result = inject_comms(req.demo, req.audioWav, opts);
	} finally {
		opts.free();
	}

	try {
		const meta = JSON.parse(result.meta_json) as InjectMeta;
		return { demo: result.demo, meta };
	} finally {
		result.free();
	}
}
