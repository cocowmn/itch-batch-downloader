// Timestamped console logger matching the output format of the original script:
//   2024-01-01 12:00:00 [INFO] message
// Everything except progress bars and pagination dots can also be persisted
// to a log file (see setFile).

import { appendFileSync } from "node:fs";
import { timestamp } from "./time.ts";

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const YELLOW = useColor ? "\x1b[33m" : "";
const RED = useColor ? "\x1b[31m" : "";
const RESET = useColor ? "\x1b[0m" : "";
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences
const ANSI = /\x1b\[[0-9;]*m/g;

let debugEnabled = false;
/** Set when a progress line or dots are on screen so the next line starts fresh. */
let lineOpen = false;
let logFile: string | null = null;
/** Lines emitted before a log file was configured; flushed by setFile(). */
let pending: string[] = [];
const MAX_PENDING = 500;
/** Listeners that receive every persisted line (download-browser jobs). */
const taps = new Set<(line: string) => void>();

function closeLine(): void {
	if (lineOpen) {
		process.stdout.write("\n");
		lineOpen = false;
	}
}

function persist(line: string): void {
	const clean = line.replace(ANSI, "");
	for (const tap of taps) tap(clean);
	if (logFile === null) {
		// Only the start of a run is worth replaying into a log file opened
		// later; a long-running server without one must not hoard lines.
		if (pending.length < MAX_PENDING) pending.push(clean);
		return;
	}
	try {
		appendFileSync(logFile, `${clean}\n`);
	} catch {
		// Logging must never take the run down; the console still has the line.
	}
}

function out(line: string): void {
	closeLine();
	console.log(line);
	persist(line);
}

function emit(level: string, msg: string): void {
	out(`${timestamp()} ${level} ${msg}`);
}

export const log = {
	setDebug(on: boolean): void {
		debugEnabled = on;
	},
	isDebug(): boolean {
		return debugEnabled;
	},
	/**
	 * Start appending every logged line to `path`. Lines logged before this
	 * call (banner, config messages) are written first.
	 */
	setFile(path: string): void {
		logFile = path;
		const buffered = pending;
		pending = [];
		try {
			appendFileSync(path, `${buffered.map((l) => `${l}\n`).join("")}`);
		} catch (err) {
			logFile = null;
			log.error(`Cannot write log file ${path}`, err);
		}
	},
	/** Receive every logged line until the returned function is called. */
	tap(fn: (line: string) => void): () => void {
		taps.add(fn);
		return () => {
			taps.delete(fn);
		};
	},
	info(msg: string): void {
		emit("[INFO]", msg);
	},
	warn(msg: string): void {
		emit(`${YELLOW}[WARNING]${RESET}`, msg);
	},
	error(msg: string, err?: unknown): void {
		emit(`${RED}[ERROR]${RESET}`, msg);
		if (err !== undefined) {
			emit(`${RED}[ERROR]${RESET}`, "=====================================");
			out(err instanceof Error ? (err.stack ?? err.message) : String(err));
			emit(`${RED}[ERROR]${RESET}`, "=====================================");
		}
	},
	debug(msg: string): void {
		if (debugEnabled) emit("[DEBUG]", msg);
	},
	/** Print a plain line without timestamp (banner, blank separators). */
	raw(msg = ""): void {
		out(msg);
	},
	/** Terminal-only activity indicator (pagination); not persisted. */
	dot(): void {
		process.stdout.write(".");
		lineOpen = true;
	},
	/** Rewrite the current terminal line (download progress bar); not persisted. */
	progress(line: string): void {
		process.stdout.write(`\r${line}`);
		lineOpen = true;
	},
	/** Finish a progress line. */
	progressDone(): void {
		closeLine();
	},
};
