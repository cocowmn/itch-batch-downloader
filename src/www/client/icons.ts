// Lucide icons (ISC) and the project's own file icons, bundled as inline SVG
// so the UI works offline.

import arrowUpDown from "lucide-static/icons/arrow-up-down.svg" with {
	type: "text",
};
import calendar from "lucide-static/icons/calendar.svg" with { type: "text" };
import camera from "lucide-static/icons/camera.svg" with { type: "text" };
import caseSensitive from "lucide-static/icons/case-sensitive.svg" with {
	type: "text",
};
import check from "lucide-static/icons/check.svg" with { type: "text" };
import chevronDown from "lucide-static/icons/chevron-down.svg" with {
	type: "text",
};
import chevronLeft from "lucide-static/icons/chevron-left.svg" with {
	type: "text",
};
import chevronRight from "lucide-static/icons/chevron-right.svg" with {
	type: "text",
};
import chevronUp from "lucide-static/icons/chevron-up.svg" with {
	type: "text",
};
import clock from "lucide-static/icons/clock.svg" with { type: "text" };
import cloudDownload from "lucide-static/icons/cloud-download.svg" with {
	type: "text",
};
import download from "lucide-static/icons/download.svg" with { type: "text" };
import expand from "lucide-static/icons/expand.svg" with { type: "text" };
import externalLink from "lucide-static/icons/external-link.svg" with {
	type: "text",
};
import eye from "lucide-static/icons/eye.svg" with { type: "text" };
import eyeOff from "lucide-static/icons/eye-off.svg" with { type: "text" };
import file from "lucide-static/icons/file.svg" with { type: "text" };
import fileArchive from "lucide-static/icons/file-archive.svg" with {
	type: "text",
};
import fileAudio from "lucide-static/icons/file-audio.svg" with {
	type: "text",
};
import fileCode from "lucide-static/icons/file-code.svg" with { type: "text" };
import fileImage from "lucide-static/icons/file-image.svg" with {
	type: "text",
};
import fileJson from "lucide-static/icons/file-json.svg" with { type: "text" };
import fileText from "lucide-static/icons/file-text.svg" with { type: "text" };
import fileVideo from "lucide-static/icons/file-video.svg" with {
	type: "text",
};
import folder from "lucide-static/icons/folder.svg" with { type: "text" };
import folderDown from "lucide-static/icons/folder-down.svg" with {
	type: "text",
};
import folderOpen from "lucide-static/icons/folder-open.svg" with {
	type: "text",
};
import galleryHorizontal from "lucide-static/icons/gallery-horizontal.svg" with {
	type: "text",
};
import grid2x2 from "lucide-static/icons/grid-2x2.svg" with { type: "text" };
import hardDrive from "lucide-static/icons/hard-drive.svg" with {
	type: "text",
};
import imageOff from "lucide-static/icons/image-off.svg" with { type: "text" };
import info from "lucide-static/icons/info.svg" with { type: "text" };
import layers from "lucide-static/icons/layers.svg" with { type: "text" };
import layoutGrid from "lucide-static/icons/layout-grid.svg" with {
	type: "text",
};
import libraryBig from "lucide-static/icons/library-big.svg" with {
	type: "text",
};
import list from "lucide-static/icons/list.svg" with { type: "text" };
import listTree from "lucide-static/icons/list-tree.svg" with { type: "text" };
import loaderCircle from "lucide-static/icons/loader-circle.svg" with {
	type: "text",
};
import lock from "lucide-static/icons/lock.svg" with { type: "text" };
import logOut from "lucide-static/icons/log-out.svg" with { type: "text" };
import packageOpen from "lucide-static/icons/package-open.svg" with {
	type: "text",
};
import pipette from "lucide-static/icons/pipette.svg" with { type: "text" };
import refreshCw from "lucide-static/icons/refresh-cw.svg" with {
	type: "text",
};
import rows3 from "lucide-static/icons/rows-3.svg" with { type: "text" };
import search from "lucide-static/icons/search.svg" with { type: "text" };
import shieldCheck from "lucide-static/icons/shield-check.svg" with {
	type: "text",
};
import tag from "lucide-static/icons/tag.svg" with { type: "text" };
import trash2 from "lucide-static/icons/trash-2.svg" with { type: "text" };
import triangleAlert from "lucide-static/icons/triangle-alert.svg" with {
	type: "text",
};
import user from "lucide-static/icons/user.svg" with { type: "text" };
import x from "lucide-static/icons/x.svg" with { type: "text" };
import asepriteFile from "../../assets/aseprite-file-icon.svg" with {
	type: "text",
};
import type { FileKind, LibraryFile } from "../../models/library.ts";
import { extension } from "./text.ts";

const ICONS: Record<string, string> = {
	"file-aseprite": asepriteFile,
	"chevron-down": chevronDown,
	"cloud-download": cloudDownload,
	expand,
	eye,
	"eye-off": eyeOff,
	"folder-down": folderDown,
	"grid-2x2": grid2x2,
	"list-tree": listTree,
	"loader-circle": loaderCircle,
	"rows-3": rows3,
	"arrow-up-down": arrowUpDown,
	calendar,
	camera,
	"case-sensitive": caseSensitive,
	check,
	"chevron-left": chevronLeft,
	"chevron-right": chevronRight,
	"chevron-up": chevronUp,
	clock,
	download,
	"external-link": externalLink,
	file,
	"file-archive": fileArchive,
	"file-audio": fileAudio,
	"file-code": fileCode,
	"file-image": fileImage,
	"file-json": fileJson,
	"file-text": fileText,
	"file-video": fileVideo,
	folder,
	"folder-open": folderOpen,
	"gallery-horizontal": galleryHorizontal,
	"hard-drive": hardDrive,
	"image-off": imageOff,
	info,
	layers,
	"layout-grid": layoutGrid,
	"library-big": libraryBig,
	list,
	lock,
	"log-out": logOut,
	"package-open": packageOpen,
	pipette,
	"refresh-cw": refreshCw,
	search,
	"shield-check": shieldCheck,
	tag,
	"trash-2": trash2,
	"triangle-alert": triangleAlert,
	user,
	x,
};

/** Inline SVG markup for an icon; sized by the `.icon` CSS class. */
export function iconSvg(name: string): string {
	const raw = ICONS[name] ?? file;
	const cls = `class="icon icon-${name}"`;
	const svg = raw
		.replace(/<!--[\s\S]*?-->/, "")
		.replace(/\swidth="24"/, "")
		.replace(/\sheight="24"/, "")
		.trim();
	// Lucide icons carry a class to replace; our own SVGs get one added.
	return /class="lucide[^"]*"/.test(svg)
		? svg.replace(/class="lucide[^"]*"/, cls)
		: svg.replace(/^<svg\b/, `<svg ${cls}`);
}

export function icon(name: string): HTMLElement {
	const span = document.createElement("span");
	span.className = "icon-wrap";
	span.innerHTML = iconSvg(name);
	return span;
}

/**
 * An icon followed by a spinner: while an ancestor has the `busy` class the
 * icon is hidden and the spinner shown (see `.idle-icon` / `.busy-icon`).
 */
export function busyIcon(name: string): HTMLElement[] {
	const idle = icon(name);
	idle.classList.add("idle-icon");
	const spinner = icon("loader-circle");
	spinner.classList.add("busy-icon");
	return [idle, spinner];
}

/** Fill every `[data-icon]` placeholder of `root` with its icon. */
export function hydrateIcons(root: ParentNode): void {
	for (const el of root.querySelectorAll<HTMLElement>("[data-icon]")) {
		const name = el.dataset.icon;
		if (name) {
			el.innerHTML = iconSvg(name);
			el.classList.add("icon-wrap");
		}
	}
}

export function kindIcon(kind: FileKind): string {
	switch (kind) {
		case "archive":
			return "file-archive";
		case "image":
			return "file-image";
		case "audio":
			return "file-audio";
		case "video":
			return "file-video";
		case "document":
			return "file-text";
		case "code":
			return "file-code";
		case "folder":
			return "folder";
		default:
			return "file";
	}
}

/** File-type specific icons come first, then the icon of the file's kind. */
export function fileIcon(file: Pick<LibraryFile, "name" | "kind">): string {
	switch (extension(file.name)) {
		case "ase":
		case "aseprite":
			return "file-aseprite";
		default:
			return kindIcon(file.kind);
	}
}
