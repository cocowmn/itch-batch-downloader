import { describe, expect, test } from "bun:test";
import { findCoverImage } from "../src/features/artwork/artwork.ts";

describe("findCoverImage", () => {
	const banner = `<div class="goal_banner_widget base_widget"><div class="goal_banner_inner"><div style="background-image: url(&#039;https://img.itch.zone/abc/189x150%23/small.png&#039;)" class="cover_image"></div></div></div>`;

	test("prefers the Open Graph image", () => {
		const html = `<head><meta property="og:image" content="https://img.itch.zone/abc/original/big.png"/><meta property="twitter:image" content="https://img.itch.zone/abc/508x254%23mb/tw.png"/></head><body>${banner}</body>`;
		expect(findCoverImage(html)).toBe(
			"https://img.itch.zone/abc/original/big.png",
		);
	});

	test("falls back to twitter:image, then the goal banner", () => {
		expect(
			findCoverImage(
				`<meta name="twitter:image" content="https://img.itch.zone/abc/508x254%23mb/tw.png">${banner}`,
			),
		).toBe("https://img.itch.zone/abc/508x254%23mb/tw.png");
		expect(findCoverImage(banner)).toBe(
			"https://img.itch.zone/abc/189x150%23/small.png",
		);
	});

	test("returns null when there is no cover", () => {
		expect(findCoverImage("<html><body>nothing</body></html>")).toBeNull();
		expect(findCoverImage('<meta property="og:image" content="">')).toBeNull();
	});
});
