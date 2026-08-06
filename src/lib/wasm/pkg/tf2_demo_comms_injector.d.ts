/* tslint:disable */
/* eslint-disable */

/**
 * Options for [`inject_comms`]. Fields mirror the CLI where possible.
 */
export class WasmInjectOptions {
    free(): void;
    [Symbol.dispose](): void;
    constructor();
    set audio_skip_secs(value: number);
    set bitrate(value: number);
    set client_index(value: number | null | undefined);
    set loudness_db(value: number);
    /**
     * Set demo-time offset in seconds. Pass a negative value for auto.
     */
    set offset_secs(value: number);
    set player_name(value: string | null | undefined);
    set replace_existing(value: boolean);
    set sample_rate(value: number);
    set steam_id(value: string | null | undefined);
}

/**
 * Result of a WASM inject: rewritten demo bytes plus JSON metadata.
 */
export class WasmInjectResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly demo: Uint8Array;
    readonly meta_json: string;
}

/**
 * Inject PCM WAV audio into a demo. Audio must be an integer PCM WAV (any rate; resampled).
 */
export function inject_comms(demo: Uint8Array, audio_wav: Uint8Array, options: WasmInjectOptions): WasmInjectResult;

/**
 * Inspect a TF2 demo; returns JSON matching [`crate::inject::InspectReport`].
 */
export function inspect_demo(demo: Uint8Array): any;

export function wasm_start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly inspect_demo: (a: number, b: number) => [number, number, number];
    readonly __wbg_wasminjectoptions_free: (a: number, b: number) => void;
    readonly wasminjectoptions_new: () => number;
    readonly wasminjectoptions_set_audio_skip_secs: (a: number, b: number) => void;
    readonly wasminjectoptions_set_offset_secs: (a: number, b: number) => void;
    readonly wasminjectoptions_set_player_name: (a: number, b: number, c: number) => void;
    readonly wasminjectoptions_set_steam_id: (a: number, b: number, c: number) => void;
    readonly wasminjectoptions_set_client_index: (a: number, b: number) => void;
    readonly wasminjectoptions_set_sample_rate: (a: number, b: number) => void;
    readonly wasminjectoptions_set_bitrate: (a: number, b: number) => void;
    readonly wasminjectoptions_set_replace_existing: (a: number, b: number) => void;
    readonly wasminjectoptions_set_loudness_db: (a: number, b: number) => void;
    readonly __wbg_wasminjectresult_free: (a: number, b: number) => void;
    readonly wasminjectresult_demo: (a: number) => [number, number];
    readonly wasminjectresult_meta_json: (a: number) => [number, number];
    readonly inject_comms: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly wasm_start: () => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
