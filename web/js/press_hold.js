/**
 * press_hold.js -- the click-and-hold gesture (round 33, user request).
 *
 * A small action button gets TWO verbs on one surface:
 *  - a normal click keeps whatever it always did;
 *  - pressing and HOLDING for HOLD_MS fires a second, deliberate
 *    action (used by the executed-output chips to accept the CURRENT
 *    state as the baseline instead of acting on the executed one).
 *
 * How the two stay out of each other's way: when the hold fires, the
 * button flags itself (`_pcHoldFired`). The click that always follows
 * the pointer release must CHECK that flag and swallow itself -- a
 * later-registered listener cannot cancel an earlier one on the same
 * element (target-phase order is registration order, capture flag
 * included), so suppression is cooperation, not interception. The flag
 * is also cleared at the start of every new press, so an interrupted
 * hold can never eat a later honest click.
 *
 * The hold class (`pc-exec-chip-holding`) drives the CSS progress
 * animation; its duration must match HOLD_MS. Timers are injectable so
 * the whole state machine unit-tests headless.
 */

export const HOLD_MS = 1000;
export const HOLD_CLASS = "pc-exec-chip-holding";

/**
 * Attach the gesture to `chip`. Returns nothing; the listeners live as
 * long as the element does.
 */
export function bindPressAndHold(chip, onHold, opts = {}) {
    const holdMs = opts.holdMs ?? HOLD_MS;
    const setT = opts.setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
    const clearT = opts.clearTimeoutFn || ((id) => clearTimeout(id));
    let timer = null;
    const cancel = () => {
        if (timer !== null) {
            clearT(timer);
            timer = null;
        }
        chip.classList.remove(HOLD_CLASS);
    };
    chip.addEventListener("pointerdown", (e) => {
        if (e && typeof e.button === "number" && e.button !== 0) return; // primary only
        cancel(); // a re-press restarts the progress
        chip._pcHoldFired = false; // a stale flag must never eat this click
        chip.classList.add(HOLD_CLASS);
        timer = setT(() => {
            timer = null;
            chip.classList.remove(HOLD_CLASS);
            chip._pcHoldFired = true;
            onHold();
        }, holdMs);
    });
    for (const evt of ["pointerup", "pointerleave", "pointercancel"]) {
        chip.addEventListener(evt, cancel);
    }
}
