import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../src/utils/log.ts";

describe("log file", () => {
	test("buffers lines until setFile, strips ANSI, skips progress output", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ibd-log-"));
		try {
			log.raw("banner");
			log.warn("careful");
			const path = join(dir, "downloads.log");
			log.setFile(path);
			log.info("hello");
			log.progress("50% |XXXX----|");
			log.dot();
			log.error("boom", new Error("details"));
			log.progressDone();

			const text = await Bun.file(path).text();
			const lines = text.trimEnd().split("\n");
			// other test files may have logged before this one; find our banner
			const at = lines.indexOf("banner");
			expect(at).toBeGreaterThanOrEqual(0);
			expect(lines[at + 1]).toMatch(
				/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[WARNING\] careful$/,
			);
			expect(lines[at + 2]).toMatch(/\[INFO\] hello$/);
			expect(text).not.toContain("XXXX");
			expect(text).not.toContain("\x1b[");
			expect(text).toContain("[ERROR] boom");
			expect(text).toContain("Error: details");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
