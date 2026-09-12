// "Download from itch.io" job status shared by the download-browser server and its UI.

export type JobState = "running" | "done" | "failed" | "cancelled";

export interface JobStatus {
	id: string;
	state: JobState;

	/** The library item(s) the job was started for. */
	directories: string[];
	/** The item's title, or "n items" for a batch. */
	title: string;
	/** Items the pipeline has finished with so far (batches). */
	completed: number;

	/** Why it failed, or what to show when done. */
	message: string;

	/** The most recent log lines of the pipeline. */
	log: string[];
	startedAt: string;
	finishedAt: string | null;

	/** Bytes fetched, known once done. */
	size: number | null;
}
