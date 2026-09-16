#!/usr/bin/env bun

// Build the release archives for every supported platform into dist/:
//   itch-batch-downloader-<version>-<os>-<arch>.tar.gz   (macOS, Linux)
//   itch-batch-downloader-<version>-<os>-<arch>.zip      (Windows)
// Each holds a folder with the binary, appconfig.example.toml, README.md and
// LICENSE. Bun cross-compiles from any host, so this runs on one machine.
//
//   bun run build:all                       every target
//   bun run build:all --only macos-arm64    a subset (repeatable)
//   bun run build:all --keep                keep the unpacked folders

import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import pkg from "../package.json";
import { zipDirectory } from "../src/www/server/zip.ts";

interface Target {
	/** `bun build --target` value. */
	bun: string;
	os: "macos" | "windows" | "linux";
	arch: "arm64" | "x64";
}

const TARGETS: Target[] = [
	{ bun: "bun-darwin-arm64", os: "macos", arch: "arm64" },
	{ bun: "bun-darwin-x64", os: "macos", arch: "x64" },
	{ bun: "bun-windows-x64", os: "windows", arch: "x64" },
	{ bun: "bun-windows-arm64", os: "windows", arch: "arm64" },
	{ bun: "bun-linux-x64", os: "linux", arch: "x64" },
	{ bun: "bun-linux-arm64", os: "linux", arch: "arm64" },
];

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const NAME = "itch-batch-downloader";
/** Shipped next to the binary. */
const EXTRAS = ["appconfig.example.toml", "README.md", "LICENSE"];

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		only: { type: "string", multiple: true },
		keep: { type: "boolean" },
	},
});

const selected = values.only?.length
	? TARGETS.filter((t) => values.only?.includes(`${t.os}-${t.arch}`))
	: TARGETS;
if (selected.length === 0) {
	console.error(
		`No such target. Known: ${TARGETS.map((t) => `${t.os}-${t.arch}`).join(", ")}`,
	);
	process.exit(2);
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

const built: { file: string; size: number }[] = [];
for (const target of selected) {
	const folder = `${NAME}-${pkg.version}-${target.os}-${target.arch}`;
	const dir = join(DIST, folder);
	const binary = join(dir, target.os === "windows" ? `${NAME}.exe` : NAME);
	console.log(`\n== ${folder} (${target.bun})`);
	await mkdir(dir, { recursive: true });
	await $`bun build --compile --target=${target.bun} src/cli.ts --outfile ${binary}`.cwd(
		ROOT,
	);
	for (const extra of EXTRAS)
		await copyFile(join(ROOT, extra), join(dir, extra));

	const archive =
		target.os === "windows"
			? await writeZip(dir, folder)
			: await writeTarGz(dir, folder);
	if (!values.keep) await rm(dir, { recursive: true, force: true });
	built.push({ file: archive, size: Bun.file(archive).size });
}

// Checksums so people can verify what they downloaded.
const sums: string[] = [];
for (const { file } of built) {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(await Bun.file(file).arrayBuffer());
	sums.push(`${hasher.digest("hex")}  ${file.slice(DIST.length + 1)}`);
}
await Bun.write(join(DIST, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);

console.log(`\nBuilt ${built.length} archive(s) in dist/:`);
for (const { file, size } of built)
	console.log(
		`  ${(size / 1024 / 1024).toFixed(1).padStart(6)} MB  ${file.slice(DIST.length + 1)}`,
	);
console.log("          SHA256SUMS.txt");

/** tar keeps the executable bit, which zip tools on macOS/Linux often drop. */
async function writeTarGz(dir: string, folder: string): Promise<string> {
	const archive = `${dir}.tar.gz`;
	await $`tar -czf ${archive} -C ${DIST} ${folder}`;
	return archive;
}

/** The same zip writer as the download browser: no external tool needed. */
async function writeZip(dir: string, folder: string): Promise<string> {
	const archive = `${dir}.zip`;
	const stream = await zipDirectory(dir, { rootName: folder });
	await Bun.write(archive, new Response(stream));
	return archive;
}
