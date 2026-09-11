# Changelog for itch-batch-downloader

## 0.2.0 (2026-09-10)

- Rewritten in TypeScript and run with Bun 1.4.2+. The Python sources, `requirements.txt` and the PyInstaller build script were removed; `bun build --compile` produces standalone executables instead.
- Added bundle filtering (`bundles = [...]` / `--bundle`): the run can be limited to the items of specific bundles, read straight from the bundle download pages. Unclaimed bundle items are reported (never claimed automatically).
- Added author filtering (`authors = [...]` / `--author`), matching the `author.itch.io` slug or the display name.
- Added a command line: `download`, `list-bundles`, `list-authors`, `list-games` plus options to override every config value, `--dry-run` and `--restart`.
- Configuration moved from `itch-batch-downloader.ini` to `appconfig.toml` (booleans instead of ON/OFF; the old strings are still accepted).
- Page captures now use `Bun.WebView` driving an installed Chrome/Chromium/Edge/Brave instead of Selenium + webdriver-manager; full-page PNG and PDF come straight from the browser, so `util.py`'s stitching workaround and Pillow are gone.
- Captures are now authenticated with the session cookies (the Python version's `driver.cookies = cookiejar` was a no-op).
- The browser is only launched when `create_png` or `create_pdf` is enabled, and a missing browser disables captures instead of aborting the run.
- Videos are downloaded by spawning the `yt-dlp` executable (`yt_dlp_path`), which is optional.
- `#HttpOnly_` lines in cookies.txt exports are honoured (they were silently dropped before).
- `cookies.txt` may also contain the raw `cookie` request header value (`name=value; ...`) copied from the browser's developer tools; it is converted on load, so no extension is needed.
- The default cookie file name is now `cookies.txt` (was `cookies-itch.txt`).
- Cookies are only sent to itch.io hosts, not to the CDN.
- A redirect to the login page is reported as "not properly authenticated" instead of failing on the login page's bot protection.
- The resume file also stores a fingerprint of the bundle/author selection so a changed selection restarts from the beginning; the legacy bare-number format is still read. `list-games` shows the item numbers it refers to.
- Added `create_log` (default `true`): all console output is also appended to `downloads.log` in the download directory (progress bars excluded, colours stripped).
- Added `log_download_progress` (default `true`): when `false`, downloads log a start line with the size, one line with the current speed, and a completion line instead of a live progress bar.
- Added `download_artwork` (default `true`): the product page's cover artwork (`og:image`, original size) is saved as `<item>_cover-artwork.<ext>`; existing covers are not re-downloaded.
- Added `download_manifest` (default `true`): writes `<item>_manifest.json` with the item's title, author, URLs, itch.io id, description, cover URL, info panel, tags, screenshots, embeds, source bundle(s) and the files in its directory.
- Added `download_name` (default `"{slug}"`, the directory names of earlier versions, `-n`/`--download-name`): a template for each item's directory with `/` for subdirectories and tokens for the item (`{title}`, `{slug}`, `{author}`, `{author_name}`, `{bundle}`), its product page (`{id}`, `{category}`, `{tags}`/`{tags:sep}`, `{genre}`, `{published}`, `{updated}`), the run (`{index}`, `{total}`) and the time the run started (`{yyyy}` … `{ms}`, `{date}`, `{time}`). Validated at start-up with a specific error; at least one identifying token is required.
- Every item directory gets a hidden `.itchio` marker file (title, slug, author, page URL; no keys) so the download browser finds items at any depth and can name items without a manifest. The manifest's `directory` is now the path relative to `download_directory`.
- Added `manifest_include_keys` (default `true`): set to `false` (or `--no-manifest-keys`) to leave the download key, download-page URL and bundle keys/URLs out of the manifests so they can be shared.
- Added `download_files` (default `true`) to turn the file downloads off, e.g. to re-run a library for artwork or captures only.
- Added `--skip <n>` to start at item n+1 of the selection, e.g. after a failure part-way through a run.
- Added the `download-browser` command: a local web UI (`http://127.0.0.1:3737/`, `--port`, `--no-open`) for browsing the download directory with grid, list and Finder-style gallery views, a fuzzy filter over titles, authors, tags, bundles and file names, and an inspector showing the manifest data, page captures and files (download, or reveal in the file manager). Items without a manifest or cover artwork are shown from their directory contents with a placeholder image.
- Bundles page parsing fixed for the current itch.io layout (`section.game_collection` / `a.collection_title`); bundle rows now also expose the author name.
- Unit tests for the HTML parsers, cookie handling, configuration, filters, logging and resume file (`bun test`).

## 0.1.2 (2026-03-22)

- Acknowledgments - Thanks to sumitaghosh for this release
- Important - UPX has not been used in this build
- Added a sample/default itch-batch-downloader.ini file to the repository.
- Added support in fetch_upload() for newer itch.io download button formats when data-upload_id is not present.
- Added fallback parsing of /download/ links from the upload block and, if needed, from the whole page.
- Added handling for Cloudflare-backed download URLs such as itchio-mirror.* and r2.cloudflarestorage.com.
- Added filename fallback logic in dltool.py when Content-Disposition is missing, using the URL path instead.
- Added support for treating the filename argument as either a directory or a full output path in dltool.py.
- Added protocol normalization for iframe video URLs, including protocol-relative URLs like //....
- Added extra repository ignore rules for .DS_Store, /downloads, /env, and *.xz.
- Changed fetch_upload() now accepts an extra full_page_soup argument and uses it as a fallback source for locating download buttons.
- Changed Download URL resolution now branches between:
- Changed the legacy POST {dlurl}/file/{upload_id} flow, and
- Changed a direct JSON GET flow for newer endpoints.
- Changed PDF generation was changed from a low-level Selenium command executor call to driver.print_page(...).
- Changed PDF output filename construction was cleaned up to use an f-string.
- Changed dltool.download_a_file() was reworked to:
- Changed detect Cloudflare-style mirrors,
- Changed use HEAD only for standard URLs,
- Changed use direct GET for Cloudflare URLs,
- Changed compute the final output path more flexibly,
- Changed apply skip-if-identical only when reliable metadata is available.
- Changed Dependency versions in requirements.txt were broadly refreshed to newer releases.
- Changed The README was substantially expanded and refreshed:
- Changed Python tested version updated from 3.10.7 to 3.14.3.
- Changed UPX tested version updated from 3.96 to 5.1.1.
- Changed Package installation instructions were rewritten.
- Changed Minor util.py adjustments.
- New guidance was added for Windows, macOS, and Linux packaging context.
- New More tips, caveats, and external tooling references were added.
- Fixed download detection for pages that no longer expose the old data-upload_id attribute.
- Fixed file download handling for Cloudflare mirror URLs that do not provide the same metadata as the legacy CDN flow.
- Fixed cases where downloads could still proceed even when Content-Disposition was missing.
- Fixed iframe video download URL construction so already absolute URLs are not blindly prefixed with https:.
- Improved non-200 handling in dltool.py by returning early when HEAD or GET requests fail.
- Improved old-file renaming logic to operate on the resolved final output path.
- Improved timestamp restoration to only run when Last-Modified exists.
- Documentation: README wording was updated in multiple places for clarity, grammar, and formatting. Configuration option descriptions were reformatted and emphasized. The known issues / caveats section was updated and expanded. Additional notes were added around claiming free games, browser extensions, cookie export, and compilation.

## 0.1.0 (2022-09-24)

- project forked from itch-downloader 0.5.3, initial release of itch-batch-downloader 0.1.0
- ability to download any purchased item (removed distinction between games and non-games)
- replaced code for downloading dumping webpages, screenshots and videos
- added support to export product page as .png and .pdf
- added support in tool (rather then external) for downloading iframe embedded videos, etc. within a product page
- file renaming for filesystem compatibility (unicode)
- logging system with debug info added (unicode, both for output to file and/or console)
- misc bug fixes, stability improvements and special cases handling

## 0.5.3 (2022-04-16)

- download now adds datestamp to archives
- renames already downloaded files appropriately
- added webpage screenshot of gamepage (user has to provide service url)
- added screenshot download option
- added operating system selection (not yet active)
- still hardcoded that only windows and android will be downloaded

## 0.5.2 (2022-04-12)

- added a primitive download continue (tracks download position and resumes download at number)
- fixed (hopefully) "SSL: DECRYPTION_FAILED_OR_BAD_RECORD_MAC"
- fixed missing content-disposition
- some reformatting

## 0.5.1 (2022-04-10)

- fixed config file reading
- some adjustments for win32 platform

## 0.5 (2022-04-10)

- first numbered revision
- configuration put into proper .ini file
- rewritten README.md
- Changelog.md
- displays xxx / number of games during downloading games
- proper requirements.txt

## unnamed revisions (2022-04-10)

- basic working revisions, ironed out bugs and such
- configuration baked into script
- total rewrite of bundle downloader
