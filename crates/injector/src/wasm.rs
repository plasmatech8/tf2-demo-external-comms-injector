//! Browser WASM bindings for in-memory demo inspection and voice injection.

use wasm_bindgen::prelude::*;

use crate::audio::Loudness;
use crate::inject::{inject_comms_bytes, inspect_demo_bytes, InjectBytesOptions};
use crate::steam_voice::{DEFAULT_BITRATE, DEFAULT_SAMPLE_RATE};

#[wasm_bindgen(start)]
pub fn wasm_start() {
    console_error_panic_hook::set_once();
}

/// Inspect a TF2 demo; returns JSON matching [`crate::inject::InspectReport`].
#[wasm_bindgen]
pub fn inspect_demo(demo: &[u8]) -> Result<JsValue, JsValue> {
    let report = inspect_demo_bytes(demo).map_err(|e| JsValue::from_str(&format!("{e:#}")))?;
    serde_wasm_bindgen::to_value(&report).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Options for [`inject_comms`]. Fields mirror the CLI where possible.
#[wasm_bindgen]
#[derive(Clone, Debug)]
pub struct WasmInjectOptions {
    audio_skip_secs: f32,
    /// Negative means “auto” (teamplay_round_start / 0).
    offset_secs: f32,
    player_name: Option<String>,
    steam_id: Option<String>,
    client_index: Option<u8>,
    sample_rate: u32,
    bitrate: i32,
    replace_existing: bool,
    loudness_db: f32,
}

#[wasm_bindgen]
impl WasmInjectOptions {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            audio_skip_secs: 0.0,
            offset_secs: -1.0,
            player_name: None,
            steam_id: None,
            client_index: None,
            sample_rate: DEFAULT_SAMPLE_RATE,
            bitrate: DEFAULT_BITRATE,
            replace_existing: false,
            loudness_db: 0.0,
        }
    }

    #[wasm_bindgen(setter)]
    pub fn set_audio_skip_secs(&mut self, v: f32) {
        self.audio_skip_secs = v;
    }

    /// Set demo-time offset in seconds. Pass a negative value for auto.
    #[wasm_bindgen(setter)]
    pub fn set_offset_secs(&mut self, v: f32) {
        self.offset_secs = v;
    }

    #[wasm_bindgen(setter)]
    pub fn set_player_name(&mut self, v: Option<String>) {
        self.player_name = v.filter(|s| !s.is_empty());
    }

    #[wasm_bindgen(setter)]
    pub fn set_steam_id(&mut self, v: Option<String>) {
        self.steam_id = v.filter(|s| !s.is_empty());
    }

    #[wasm_bindgen(setter)]
    pub fn set_client_index(&mut self, v: Option<u8>) {
        self.client_index = v;
    }

    #[wasm_bindgen(setter)]
    pub fn set_sample_rate(&mut self, v: u32) {
        self.sample_rate = if v == 0 { DEFAULT_SAMPLE_RATE } else { v };
    }

    #[wasm_bindgen(setter)]
    pub fn set_bitrate(&mut self, v: i32) {
        self.bitrate = if v == 0 { DEFAULT_BITRATE } else { v };
    }

    #[wasm_bindgen(setter)]
    pub fn set_replace_existing(&mut self, v: bool) {
        self.replace_existing = v;
    }

    #[wasm_bindgen(setter)]
    pub fn set_loudness_db(&mut self, v: f32) {
        self.loudness_db = v;
    }
}

impl Default for WasmInjectOptions {
    fn default() -> Self {
        Self::new()
    }
}

impl WasmInjectOptions {
    fn to_bytes_opts(&self) -> InjectBytesOptions {
        InjectBytesOptions {
            offset_secs: if self.offset_secs < 0.0 {
                None
            } else {
                Some(self.offset_secs)
            },
            audio_skip_secs: self.audio_skip_secs,
            loudness: Loudness::from_db(self.loudness_db),
            player_name: self.player_name.clone(),
            steam_id: self.steam_id.clone(),
            client_index: self.client_index,
            sample_rate: self.sample_rate,
            bitrate: self.bitrate,
            replace_existing: self.replace_existing,
        }
    }
}

/// Result of a WASM inject: rewritten demo bytes plus JSON metadata.
#[wasm_bindgen]
pub struct WasmInjectResult {
    demo: Vec<u8>,
    meta_json: String,
}

#[wasm_bindgen]
impl WasmInjectResult {
    #[wasm_bindgen(getter)]
    pub fn demo(&self) -> Vec<u8> {
        self.demo.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn meta_json(&self) -> String {
        self.meta_json.clone()
    }
}

/// Inject PCM WAV audio into a demo. Audio must be an integer PCM WAV (any rate; resampled).
#[wasm_bindgen]
pub fn inject_comms(
    demo: &[u8],
    audio_wav: &[u8],
    options: &WasmInjectOptions,
) -> Result<WasmInjectResult, JsValue> {
    let opts = options.to_bytes_opts();
    // Catch panics from the Opus backend so the JS side gets a Result instead of an
    // abort + broken `free()` ("attempted to take ownership while borrowed").
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        inject_comms_bytes(demo, audio_wav, &opts)
    }));
    let result = match result {
        Ok(inner) => inner.map_err(|e| JsValue::from_str(&format!("{e:#}")))?,
        Err(payload) => {
            let msg = if let Some(s) = payload.downcast_ref::<&str>() {
                (*s).to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "internal panic during inject_comms".to_string()
            };
            return Err(JsValue::from_str(&format!("injector panic: {msg}")));
        }
    };
    let meta_json = serde_json::to_string(&result.meta)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(WasmInjectResult {
        demo: result.demo,
        meta_json,
    })
}
