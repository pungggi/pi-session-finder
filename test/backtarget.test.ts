import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBackTarget } from "../src/index.js";

/**
 * resolveBackTarget picks a resumable back-target: the origin if it exists,
 * otherwise the most-recent real session in the same project (so /find-back
 * works even when you /find from a fresh, never-saved session).
 */

function touch(file: string, mtimeSecondsAgo = 0): void {
	writeFileSync(file, "", "utf8");
	const d = new Date(Date.now() - mtimeSecondsAgo * 1000);
	const t = d.getTime() / 1000;
	try {
		// best-effort mtime backdate; exact value not required, only ordering
		utimesSync(file, t, t);
	} catch {
		/* fall back to "now" ordering — tests below rely only on relative recency */
	}
}

describe("resolveBackTarget", () => {
	it("returns the origin when it exists on disk", () => {
		const dir = mkdtempSync(join(tmpdir(), "rbt-"));
		try {
			const origin = join(dir, "me.jsonl");
			touch(origin);
			expect(resolveBackTarget(origin, join(dir, "other.jsonl"))).toBe(origin);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to the most-recent real session in the project when the origin is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "rbt-"));
		try {
			// Origin path doesn't exist (fresh empty session). Two real sessions exist,
			// with distinct mtimes (older backdated so ordering is deterministic).
			const origin = join(dir, "fresh-never-saved.jsonl");
			const older = join(dir, "2026-08-01A.jsonl");
			const newer = join(dir, "2026-08-02B.jsonl");
			touch(older, 120); // 120s ago
			touch(newer, 0); // now → strictly more recent
			expect(statSync(newer).mtimeMs).toBeGreaterThan(statSync(older).mtimeMs);

			const target = resolveBackTarget(origin, join(dir, "target.jsonl"));
			expect(target).toBe(newer); // most recent wins
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never returns the excludePath (the session we're jumping TO)", () => {
		const dir = mkdtempSync(join(tmpdir(), "rbt-"));
		try {
			const origin = join(dir, "fresh.jsonl"); // missing
			const only = join(dir, "only.jsonl");
			touch(only);
			// The only candidate IS the exclude path → must not pick it.
			expect(resolveBackTarget(origin, only)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns null when the origin is missing and the project has no sessions", () => {
		const dir = mkdtempSync(join(tmpdir(), "rbt-"));
		try {
			expect(resolveBackTarget(join(dir, "fresh.jsonl"), join(dir, "x.jsonl"))).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns null when origin is undefined", () => {
		expect(resolveBackTarget(undefined, "/whatever.jsonl")).toBeNull();
	});

	it("ignores non-.jsonl files in the project dir", () => {
		const dir = mkdtempSync(join(tmpdir(), "rbt-"));
		try {
			const txt = join(dir, "notes.txt");
			touch(txt);
			// only a .txt file present → no resumable session
			expect(resolveBackTarget(join(dir, "fresh.jsonl"), join(dir, "x.jsonl"))).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
