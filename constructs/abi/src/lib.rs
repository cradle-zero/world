//! Construct ABI v1. Host calls come from the `cz_v1` import module. All values are integers;
//! energy is microjoules.
#![no_std]

#[link(wasm_import_module = "cz_v1")]
unsafe extern "C" {
    fn cz_v1_sense(channel: i32) -> i64;
    fn cz_v1_draw_joules(requested_uj: i64) -> i64;
    fn cz_v1_emit_wave(strength_uj: i64) -> i32;
}

/// Reads one local sensor channel.
#[must_use]
pub fn sense(channel: i32) -> i64 {
    // SAFETY: host call with integer arguments only; the host validates every value.
    unsafe { cz_v1_sense(channel) }
}

/// Requests up to `requested_uj` microjoules from the Construct's input. Returns microjoules granted.
#[must_use]
pub fn draw_joules(requested_uj: i64) -> i64 {
    // SAFETY: host call with integer arguments only; the host validates every value.
    unsafe { cz_v1_draw_joules(requested_uj) }
}

/// Emits a local wave with `strength_uj` microjoules. Returns true if it was emitted.
pub fn emit_wave(strength_uj: i64) -> bool {
    // SAFETY: host call with integer arguments only; the host validates every value.
    unsafe { cz_v1_emit_wave(strength_uj) == 1 }
}
