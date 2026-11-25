//! Template Construct: draws a little energy each tick and emits a wave when it has enough.
#![no_std]

use core::sync::atomic::{AtomicI64, Ordering};

/// Energy drawn per tick, in microjoules.
const DRAW_PER_TICK_UJ: i64 = 1_000;
/// Stored energy needed before emitting, in microjoules.
const EMIT_THRESHOLD_UJ: i64 = 10_000;

static STORED_UJ: AtomicI64 = AtomicI64::new(0);

#[unsafe(no_mangle)]
pub extern "C" fn cz_tick() {
    let granted = cz_abi_v1::draw_joules(DRAW_PER_TICK_UJ);
    let stored = STORED_UJ
        .load(Ordering::Relaxed)
        .saturating_add(granted.max(0));
    if stored >= EMIT_THRESHOLD_UJ && cz_abi_v1::emit_wave(stored) {
        STORED_UJ.store(0, Ordering::Relaxed);
    } else {
        STORED_UJ.store(stored, Ordering::Relaxed);
    }
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
