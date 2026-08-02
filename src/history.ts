/**
 * pi-session-finder — universal "back" navigation stack.
 *
 * pi emits `session_start` (reason `new` | `resume` | `fork`) carrying
 * `event.previousSessionFile` = the session we just left. We record those onto
 * a stack so `/find-back` can replay them in reverse — a browser-style back
 * across `/find`, `/resume`, `/new`, `/fork`, and `/clone`.
 *
 * WHY THIS LIVES ON DISK, NOT IN MODULE MEMORY
 * A cross-cwd `/find` or `/find-back` switch makes pi invalidate the extension
 * module cache (`clearExtensionCache`, core/extensions/loader.js) and re-import
 * the module. Top-level `let` state would reset on every jump, leaving an empty
 * stack. The stack and the one-shot suppress flag therefore live in a JSON file
 * under the pi agent dir (`~/.pi/agent/session-finder/backstack.json`), which
 * survives the reload (and process restarts). The fs glue is in index.ts; this
 * module holds only pure, unit-testable logic.
 *
 * PING-PONG GUARD
 * `/find-back` is itself a switch, so it would trigger another `session_start`
 * and re-push the session we just left — making back toggle forever. To prevent
 * that, `/find-back` arms `suppressNext` (persisted) right before it switches;
 * the next `session_start` consumes it and records nothing. The flag is
 * consumed exactly once, so normal jumps resume recording immediately after.
 */

/** Maximum entries kept; oldest (bottom) is dropped when exceeded. */
export const MAX_BACK_DEPTH = 50;

export interface BackState {
	/** Previous-session file paths, oldest first; top (most recent) = last element. */
	stack: string[];
	/** Set by `/find-back` just before it switches; the next `session_start`
	 *  consumes it so the back-jump itself isn't recorded (avoids ping-pong). */
	suppressNext: boolean;
}

export function emptyState(): BackState {
	return { stack: [], suppressNext: false };
}

/** Apply a `session_start` transition: record the previous session unless the
 *  back-jump asked us to skip it. Pure — callers own the fs read/write. */
export function applySessionStart(
	state: BackState,
	previousFile: string | undefined | null,
): BackState {
	// `/find-back` armed this: consume the flag and record nothing.
	if (state.suppressNext) {
		return { stack: state.stack, suppressNext: false };
	}
	// `startup` / `reload` carry no previous session — nothing to record.
	if (!previousFile) return state;
	// Ignore a repeat of the current top (guards against reload-looking jumps).
	const top = state.stack[state.stack.length - 1];
	if (top === previousFile) return state;
	const stack = [...state.stack, previousFile];
	while (stack.length > MAX_BACK_DEPTH) stack.shift();
	return { stack, suppressNext: false };
}

/** Pop the most recent recorded session and arm the suppress flag for the
 *  switch that is about to happen. Returns null when the stack is empty. */
export function popForBack(state: BackState): { state: BackState; target: string } | null {
	if (state.stack.length === 0) return null;
	const target = state.stack[state.stack.length - 1];
	return {
		state: { stack: state.stack.slice(0, -1), suppressNext: true },
		target,
	};
}

/** Drop stale (missing) entries from the top of the stack. Returns the same
 *  object reference when nothing changed (so callers can skip a pointless write),
 *  a new state otherwise. `exists` is injected for testability. */
export function dropMissingTop(state: BackState, exists: (p: string) => boolean): BackState {
	let stack = state.stack;
	while (stack.length > 0 && !exists(stack[stack.length - 1])) {
		stack = stack.slice(0, -1);
	}
	return stack.length === state.stack.length ? state : { ...state, stack };
}
