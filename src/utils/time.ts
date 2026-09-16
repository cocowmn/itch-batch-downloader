// Date formatting shared by the logger and the file names of downloads and captures.

export function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** `2024-01-01 12:00:00`, the log line format. */
export function timestamp(d = new Date()): string {
	return (
		`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
		`${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
	);
}

/** `20240101`, the stamp in capture and download file names. */
export function dateStamp(d = new Date()): string {
	return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

/** `20240101120000`, used to name superseded downloads (`*.old`). */
export function compactTimestamp(d = new Date()): string {
	return (
		`${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
		`${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
	);
}

/** `7 h 30 min`, `48 min`, `27 s`: a rounded, human readable duration. */
export function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
