# itch batch downloader

A command-line tool, written in TypeScript and run with [Bun](https://bun.com), that downloads the items bound to your itch.io account in batch — the whole library, or just the items from specific bundles or specific authors.

## The downloader

- Retrieves items currently bound to your itch.io account/library.
- Optionally limits the run to specific **bundles** and/or specific **authors**.
- Attempts to download all available files it can access automatically.
- Optionally captures product pages as PNG and PDF.
- Downloads embedded videos (via yt-dlp).
- Preserves historical versions where possible.
- Supports interrupting and resuming batch download progress.

The goal of the tool is to create the most complete local archive possible of your itch.io purchases.

This tool only downloads items bound to your account and does not bypass itch.io permissions. It never claims bundle items on your behalf.

## Requirements

- [Bun](https://bun.com) **1.4.2 or newer** (`curl -fsSL https://bun.sh/install | bash`, or `bun upgrade`).
- Sufficient disk space for your library.
- Your itch.io session cookies saved as `cookies.txt` — either a Netscape-format export or the raw `cookie` header copied from the browser's developer tools. Browser cookies eventually expire: if the downloader reports that you are not authenticated, re-export them.

### Optional (only needed for some features)

#### A Chromium based browser — for `create_png` / `create_pdf`

Page captures use `Bun.WebView`, which drives an installed **Google Chrome, Chromium, Microsoft Edge or Brave** through the DevTools protocol. Bun looks for the browser in the usual install locations and on `PATH`; you can point it at a specific executable with `chrome_path` in the config (or `--chrome-path`, or the `BUN_CHROME_PATH` environment variable).

If no browser is found the downloader prints an error, disables captures for the run and keeps downloading files. You can also turn captures off:

```toml
create_pdf = false
create_png = false
```

#### [yt-dlp](https://github.com/yt-dlp/yt-dlp) — for `download_videos`

Embedded videos (YouTube, Vimeo, …) are downloaded by spawning `yt-dlp`. Install it and make sure it is on `PATH`, or set `yt_dlp_path`. Without it, videos are skipped with a warning.

The tool is cross-platform (macOS, Linux, Windows).

## Usage

### 1. Login to itch.io

Open [https://itch.io](https://itch.io) and log in to your account. The tool needs your authenticated session cookies to access your library and download owned content.

### 2. Export your itch.io cookies

Get your itch.io cookies out of the browser and into a text file. Either of the two routes below works.

#### Option A: browser extension

- [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) (Chrome / Chromium browsers).
- [cookies.txt](https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/) (Firefox).

With itch.io open, click the extension and export the cookies for the **current site only**. Exporting all cookies also works, but is unsafe from a cybersecurity standpoint.

#### Option B: developer tools, no extension

itch.io's session cookies are `HttpOnly`, so they cannot be read from the console with `document.cookie` — but the browser shows the cookie header it sends, and the downloader accepts that header as-is:

1. Logged in on itch.io, open the developer tools (`F12`, or `⌥⌘I` on macOS), go to the **Network** tab and reload the page.
2. Click the first request in the list (the `itch.io` document). Under **Headers → Request Headers** find the `cookie` header, right-click its value and choose **Copy value** (Firefox: the "Raw" toggle makes it easy to select the whole line).
3. Create `cookies.txt` at the project root and paste. The file then contains a single line like

```text
itchio=...; itchio_token=...; _ga=...
```

That is all: when the downloader reads `cookies.txt` it detects this `name=value; name=value` format and converts it internally (binding the cookies to `itch.io` and its subdomains). A leading `cookie:` prefix or line breaks in the pasted text are fine. The `itchio` and `itchio_token` cookies are the ones that matter; extra cookies are harmless.

#### Either way

The cookie file is your login — treat it like a password. It is only ever sent to `itch.io` and its subdomains, and `cookies*` is in `.gitignore`.

Save the file in the project directory as:

```text
cookies.txt
```

### 3. Install and configure

```bash
bun install
bun start
```

The first run creates `appconfig.toml` next to the script and exits. Edit it (see [Configuration file](#configuration-file)) — at minimum check the download directory — then run again.

### 4. Run

```bash
bun start                     # download everything selected by the config
bun start --author cool-dev   # ...or narrow the selection from the command line
```

Run `bun start --help` for the full list of options.

## Commands

| Command | What it does |
|---|---|
| `download` (default) | Process the selected items. |
| `list-bundles` | List the bundles bound to your account, with their names and keys. |
| `list-authors` | List the authors in the current selection with item counts. |
| `list-games` | List the selected items with the numbers used by the resume file. |
| `download-browser` | Browse what has been downloaded in a local web UI (see [Browsing your downloads](#browsing-your-downloads)). Works best if you enable downloading cover art and manifests with your content. |

Every command accepts the same options:

```text
  -c, --config <file>       Config file (default: appconfig.toml)
  -d, --download-dir <dir>  Override download_directory
      --cookie-file <file>  Override cookie_file
  -b, --bundle <name|key|url>
                            Only items of this bundle (repeatable)
  -a, --author <slug>       Only items by this author (repeatable)
      --png / --no-png      Enable/disable PNG page captures
      --pdf / --no-pdf      Enable/disable PDF page captures
      --files / --no-files  Enable/disable downloading the items' files
      --artwork / --no-artwork
                            Enable/disable saving the cover artwork
      --manifest / --no-manifest
                            Enable/disable writing <item>_manifest.json
      --manifest-keys / --no-manifest-keys
                            Include/omit your download keys in manifests
      --videos / --no-videos
                            Enable/disable embedded video downloads
      --chrome-path <file>  Browser executable used for captures
      --yt-dlp-path <file>  yt-dlp executable
      --progress / --no-progress
                            Show/hide the live download progress bar
      --log / --no-log      Enable/disable writing downloads.log
      --dry-run             Resolve the selection and list it, download nothing
      --restart             Ignore the resume file and start from the first item
      --skip <n>            Skip the first n items of the selection
      --port <n>            Port for download-browser (default: 3737)
      --host <addr>         Interface for download-browser (default: 127.0.0.1;
                            0.0.0.0 makes it reachable from other devices)
      --open / --no-open    Open download-browser in the default browser
      --debug               Verbose logging
```

Command-line options override the values in the config file.

## Limiting the run to bundles or authors

### By bundle

```bash
bun start list-bundles                        # find the bundle names / keys you own
bun start --bundle "Bundle for Ukraine"       # by name (case-insensitive)
bun start --bundle abc123def                  # by key
bun start --bundle https://itch.io/bundle/download/abc123def
```

Or in the config file:

```toml
bundles = ["Bundle for Ukraine", "abc123def"]
```

When bundles are selected the tool reads the bundle's own download pages instead of your purchases list, so it does not matter whether the items also appear under [my-purchases](https://itch.io/my-purchases).

**Unclaimed items.** itch.io only lets you download a bundle item after it has been claimed ("added to your library"). The downloader never claims items for you: unclaimed items are skipped and a warning tells you how many there are and where to claim them (`--debug` lists each one). Claim them on the bundle page — the tools mentioned in [Tips and tricks](#tips-and-tricks) can do that in bulk — and run again.

### By author

```bash
bun start list-authors          # authors in your library, with item counts
bun start --author cool-dev     # the "cool-dev" in https://cool-dev.itch.io
```

```toml
authors = ["cool-dev", "another-author"]
```

Matching is case-insensitive and also accepts the author's display name as shown on itch.io.

Bundle and author filters combine: `--bundle X --author Y` downloads only Y's items from bundle X.

Use `list-games` (or `--dry-run`) to preview exactly what a selection contains before downloading.

## What happens when the tool runs

1. Read the configuration file and command-line options.
2. Load the cookies from `cookies.txt`.
3. Retrieve your library — or the contents of the selected bundles — and apply the author filter.
4. Iterate through each item:
   - work out its directory from `download_name` (see [Naming the item directories](#naming-the-item-directories)) and drop a small hidden `.itchio` marker file into it;
   - download all available files while attempting to avoid duplicates (`download_files`);
   - capture the product page as PNG / PDF (if enabled);
   - save the product page's cover artwork as `<item>_cover-artwork.<ext>` (`download_artwork`);
   - write `<item>_manifest.json` describing the item (`download_manifest`);
   - download embedded videos (if enabled).
5. Save everything into `download_directory/<download_name>/`; the generated files (`_cover-artwork`, `_webpage_screenshot_*`, `_manifest.json`, videos) are prefixed with the directory's own name.

Progress and warnings are printed to the console. Files already present with the same size and modification date as the remote file are skipped; changed files are downloaded again and the previous version is kept with an `.old` suffix.

## Naming the item directories

`download_name` decides where each item goes inside `download_directory`. It is a template: `/` creates subdirectories, and `{tokens}` are replaced per item. Every token value is made safe for file names (`/ \ : * ? " < > |` and control characters become `-`, leading/trailing dots are stripped, Windows-reserved names are prefixed, 120 characters max per segment), so a template can never write outside the download directory.

```toml
download_name = "{slug}"                               # default
download_name = "{title}"                              # the full name of the project
download_name = "{author}/{title}"                     # one directory per author
download_name = "{yyyy}-{mm}-{dd}/{author}--{index}"   # dated run folders
download_name = "{category}/{author}/{title}"          # Assets/… Game/… Tool/…
```

| Token | Value |
|---|---|
| `{slug}` ★ | The item's itch.io URL slug (`brawlpack` for `penusbmic.itch.io/brawlpack`) |
| `{title}` ★ | The item's title as shown on itch.io. |
| `{author}` | Author slug, the `x` in `x.itch.io`. |
| `{author_name}` | Author display name. |
| `{bundle}` | Name of the bundle the item was selected from on `--bundle` runs; `library` otherwise. |
| `{id}` ★ ⁽ᵖ⁾ | Numeric itch.io id. |
| `{category}` ⁽ᵖ⁾ | `Assets`, `Game`, `Tool`, … |
| `{tags}` ⁽ᵖ⁾ | Tags, joined with `, ` — or a separator of your choice after a colon: `{tags:--}` → `2D--Pixel Art--Sprites`, `{tags:_}` → `2D_Pixel Art_Sprites`. No trailing separator; `untagged` when there are none. |
| `{genre}` ⁽ᵖ⁾ | Genres, joined like `{tags}`. |
| `{published}`, `{updated}` ⁽ᵖ⁾ | Publication / last update date as `yyyy-mm-dd`. |
| `{index}` ★ | Position of the item in the run, zero-padded to the width of the total (`007`). |
| `{total}` | Number of items in the run. |
| `{yyyy}` `{yy}` `{mm}` `{dd}` | Year, two-digit year, month, day the run started. |
| `{hh}` `{min}` `{ss}` `{ms}` | Hour (24h), minute, second, millisecond the run started. |
| `{date}` `{time}` | `yyyy-mm-dd` and `hh-min-ss`, same moment. |

★ *identifying* — at least one of these must appear, otherwise the tool refuses to start (all items would end up in the same directory). ⁽ᵖ⁾ *product page* — the item's public page is loaded before its files so these can be resolved; if it cannot be loaded, the item is skipped with an error.

The template is validated at start-up and the tool exits with a message saying what is wrong: empty template, `..`/`.` segments, empty segments (`//`, leading or trailing `/`), absolute paths, `\`, characters that are illegal in file names, unbalanced braces, unknown tokens, a separator on a token that is not a list, or no identifying token. Two things are only warned about: a template without `{title}` or `{slug}` (directories become hard to tell apart) and time or `{index}`/`{total}` tokens (they change between runs, so a re-run downloads into new directories instead of skipping the files it already has). `--dry-run` prints the directory each item would get, and items that would share a directory are reported.

Changing `download_name` does not move anything: the next run downloads into the new locations and the old directories stay.

Every item directory receives a hidden `.itchio` file (JSON: title, slug, author, public page URL, the template used — no keys). It is how the download browser finds items wherever the template put them, how it names items that have no manifest, and where it remembers that an admin hid the item; leave it in place.

## Download progress tracking

While running, a file named `itch-batch-downloader-track.txt` is kept in the download directory. It records the number of the item currently being processed (plus a fingerprint of the bundle/author selection), which lets the tool resume where it left off after an interruption.

- **Restart from the beginning:** run with `--restart`, or delete the file.
- **Resume from a specific item:** run with `--skip <n>` to skip the first *n* items — if a run of 35 items failed at item 31, `--skip 30` starts at item 31. `bun start list-games` shows the item numbers. (`--skip` overrides the resume file for that run.)
- If the selection (bundles/authors) changes between runs the index is ignored automatically.
- A corrupted file is ignored.

## Stopping the tool

Press `CTRL + C`. Fully downloaded files remain on disk; an interrupted download leaves a `.incomplete` file that is overwritten on the next run.

## Manifest files

With `download_manifest` on, every item directory gets a `<item>_manifest.json`, for example:

```json
{
  "manifestVersion": 1,
  "generatedAt": "2026-09-11T06:44:11.192Z",
  "title": "Sci-fi Character Pack 1",
  "author": { "slug": "penusbmic", "name": "Penusbmic", "url": "https://penusbmic.itch.io" },
  "urls": {
    "page": "https://penusbmic.itch.io/characterpack1",
    "downloadPage": "https://penusbmic.itch.io/characterpack1/download/KEY"
  },
  "downloadKey": "KEY",
  "directory": "penusbmic/Sci-fi Character Pack 1",
  "bundles": [{ "name": "Complete Library Bundle", "key": "…", "url": "https://itch.io/bundle/download/…" }],
  "itchId": 653649,
  "description": "Contains 1 Free sprite!",
  "coverImageUrl": "https://img.itch.zone/…/original/ZFXsXs.png",
  "info": { "Status": "Released", "Category": "Assets", "Genre": "Platformer", "Author": "Penusbmic" },
  "tags": ["2D", "Pixel Art", "Sprites"],
  "screenshots": ["https://img.itch.zone/…/original/ZFXsXs.png"],
  "embeds": [],
  "files": ["characterpack1_cover-artwork.png", "Sci-fi Character Pack 1.zip"]
}
```

`bundles` is only filled on bundle-based runs (`--bundle`). `files` is the directory listing at the time of writing, so the manifest is written last for each item. The manifest is overwritten on every run; nothing else is.

**Manifests contain your download keys by default.** `downloadKey`, `urls.downloadPage` and the bundles' `key`/`url` all grant access to the downloads on your account, so treat manifests like `cookies.txt` while `manifest_include_keys = true` — don't share or publish them. Set `manifest_include_keys = false` (or run with `--no-manifest-keys`) to leave all three out; the manifest is then a plain description of the content (title, author, public page URL, tags, bundle *names*, files) that is safe to share. Since manifests are rewritten on every run, a `--no-files --no-png --no-pdf --no-videos --no-manifest-keys` run strips the keys from an existing library.

## Browsing your downloads

```bash
bun start download-browser
```

starts a small local web app on `http://127.0.0.1:3737/` (opened in your default browser automatically; `--no-open` skips that, `--port` changes the port) that shows everything in `download_directory`:

- **Grid, list and gallery views** — switch with the buttons top right or the `1`, `2`, `3` keys. The gallery view is Finder-style: a large preview with a filmstrip below it, `←`/`→` to move.
- **A fuzzy filter** — press `/` (or `⌘K` / `Ctrl+K`) and type anything related to an item: title, author, tag, bundle, genre, file name or folder name. Every word has to match somewhere; the list narrows as you type. Clicking a tag or bundle chip in the inspector filters by it.
- **Sorting** by title, author, last change or size (click a column header in list view to flip the direction).
- **An inspector** that slides in for the selected item (a full-screen sheet on phones; in the gallery view there, tap *Details*): cover artwork, description, tags, the "More information" panel, the bundle(s) it came from, page captures and the file list. "Open on itch.io" links to the product page.
- **Download folder** — the item's whole directory as a zip, streamed while it is built (`.incomplete` and hidden files are left out; the manifest goes in without its keys). Zips are limited to 4 GB; above that the button is disabled and the files can be downloaded one by one.
- **Download from itch.io** — fetches a fresh copy of the item through the downloader (same settings as a CLI run: files, cover, captures, videos, manifest) into a temporary directory on the server and hands it over as a zip; an overlay shows progress and can cancel. It needs the item's download page, which manifests only carry when `manifest_include_keys` is on, and the server needs `cookies.txt`. One download runs at a time; the temporary files are removed after the zip is sent (or after ten minutes). The zip's manifest is always written without keys. Your library on disk is not touched.
- **Page captures** — the newest capture shows as a strip with chips for the PNG (opens the viewer) and the PDF (opens in a new tab); older captures fold away underneath.
- **A file browser** — folders expand in place (any depth), and each folder can be *flattened* (the ⋮≡ button on the row, or the one in the section header for all folders) to list everything inside it at once, images first — handy for flipping through a sprite pack. Every row has a download button; the folder button next to it reveals the file in Finder / Explorer (only when the page is opened on the machine running the server).
- **A viewer** — clicking a file opens it full screen: images on a checkerboard with nearest-neighbour scaling and *Fit / 1× / 2× / 4× / 8×* integer zoom (pixel art stays crisp; toggle to smooth for photos), JSON with highlighting, markdown and text rendered, PDFs, video and audio inline, and a file card with a download button for everything else (archives, `.aseprite`, …). `←`/`→`, the arrows or a swipe move through the files in the order they are listed; `Esc` closes.

Items are found through their `.itchio` marker at any depth, so any `download_name` layout works; top-level directories without a marker (downloads from 0.1.x) are listed too. Items with a manifest get the rich information from `<item>_manifest.json`; without one the marker supplies title, author and page link, and directories with neither are listed by their directory and file names, marked *no manifest*. Missing cover artwork is replaced by a placeholder; a later run with `download_artwork = true` fills it in.

The server serves nothing outside the download directory. The refresh button (or reloading the page) rescans the directory, so it can run while a download is in progress. Nothing is written unless an admin hides or deletes an item (below).

### Admin: hiding and deleting items

`appconfig.toml` gets a random `admin_password` when it is created (change it to anything you like, or remove the line to turn the admin features off). **Long-press the library icon** at the left of the top bar to sign in; the session lasts until the tab or the server closes. Signed in, you get:

- **Hide item** in the details panel — a hidden item disappears from the library for everyone else, and its files, zip and "Download from itch.io" stop being served to them. An eye button appears next to refresh to show hidden items (marked with a *hidden* badge); the details panel then offers *Unhide item*.
- **Delete item** in red at the bottom of the details panel — removes the item's folder from disk after a confirmation. This cannot be undone.

Hiding writes `"hidden": true` into the item's `.itchio` marker (an item from 0.1.x without one gets a marker holding just that flag), so the state moves with the directory and survives a re-download. Five wrong passwords from one address lock it out for 30 seconds; sign-ins and failures are logged.

### Browsing from a phone or another computer

By default the server only listens on the loopback interface. To open it to your network:

```bash
bun start download-browser --host 0.0.0.0
```

The startup log lists the addresses other devices can use (`http://192.168.x.x:3737/`). Your download keys never leave the machine: the library data and the `<item>_manifest.json` files are served without `downloadKey`, `urls.downloadPage` and the bundles' keys, and the same goes for the manifests inside zips. Everything else — files, artwork, captures, the zip and "Download from itch.io" — is available to anyone who can reach the port, so keep it to networks you trust. "Reveal in Finder" only appears when the page is opened on the machine that runs the server (the server refuses it from any other address).

## Log file

By default every line printed to the console is also appended to `downloads.log` in the download directory (`create_log = false` or `--no-log` turns this off). Progress bars and pagination dots are not written to the file, and colour codes are stripped, so it is a plain-text record of every run: the command line, the items processed, every file downloaded with its size and speed, captures, and any warnings or errors.

The live download progress bar can be turned off with `log_download_progress = false` (or `--no-progress`); each download then logs one line with its size, one line with the current speed about a second in, and one line on completion. This keeps the console (and the log) readable on long runs.

## Debug mode

Set `debug_logs = true` in the config or pass `--debug` to print every HTTP request, every item discovered, the browser capture details and yt-dlp's output.

## Tips and tricks

- To associate free games with your account in batch, tools such as [ItchClaim](https://github.com/Smart123s/ItchClaim) exist.
- itch.io does not automatically add bundle items to your library; they stay on the bundle page until claimed. With `--bundle` this tool can still see them, but it can only download the ones you have claimed. User scripts such as [itch.io bundle to library](https://greasyfork.org/en/scripts/427686-itch-io-bundle-to-library) (for [Tampermonkey](https://www.tampermonkey.net/)) claim a whole bundle page with one click, and the Chrome extension [itch.io Bundle Auto Add to Library](https://chromewebstore.google.com/detail/itchio-bundle-auto-add-to/pbolegaohnnpillkpklefebilhanameg) may automate it as well.
- Some adult-only product pages show a confirmation pop-up in captures. Page captures are made with your session cookies, so confirm the warning once in your browser (tick "do not ask again"), re-export the cookies, and the captures will show the actual page.

## Configuration file

The first run creates `appconfig.toml`. A copy of the defaults is in `appconfig.example.toml`:

```toml
download_directory = "downloads"
download_name = "{slug}"
cookie_file = "cookies.txt"
create_pdf = true
create_png = true
download_files = true
download_artwork = true
download_manifest = true
manifest_include_keys = true
download_videos = true
debug_logs = false
log_download_progress = true
create_log = true
bundles = []
authors = []
# chrome_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# yt_dlp_path = "yt-dlp"
admin_password = "generated-on-first-run"
```

| Option | Default | Description |
|---|---|---|
| `download_directory` | `"downloads"` | Where downloads are stored. Relative paths are resolved from the current directory; absolute paths work too. Created if missing. |
| `download_name` | `"{slug}"` | Template for each item's directory inside `download_directory`; `/` nests, `{tokens}` are replaced per item — see [Naming the item directories](#naming-the-item-directories). The default keeps the directory names of earlier versions. |
| `cookie_file` | `"cookies.txt"` | Your itch.io session cookies: a Netscape-format `cookies.txt` export, or the raw `cookie` header value pasted from the developer tools. |
| `create_pdf` | `true` | Print the product page to PDF next to the downloaded files. Recreated only when the item received new downloads; older captures are kept. |
| `create_png` | `true` | Full-page PNG screenshot of the product page, same rules as `create_pdf`. |
| `download_files` | `true` | Download the item's files (the entries of its download page). Turn off to re-run for artwork/captures only. |
| `download_artwork` | `true` | Save the cover artwork from the product page (`og:image`, original size) as `<item>_cover-artwork.<ext>`. Skipped when a cover file already exists. |
| `download_manifest` | `true` | Write `<item>_manifest.json` next to the files: title, author, page and download-page URLs, itch.io id, description, cover URL, the "More information" panel (status, category, genre, …), tags, screenshot URLs, embeds, the bundle(s) the item was selected from, and the files in the directory. Refreshed on every run. |
| `manifest_include_keys` | `true` | Include your download keys in the manifest (`downloadKey`, `urls.downloadPage`, the bundles' `key` and `url`). **Manifests are private files while this is on.** `false` writes a manifest that only describes the content and is safe to share. |
| `download_videos` | `true` | Download videos embedded in the product page with yt-dlp. Videos with the same id are overwritten. |
| `debug_logs` | `false` | Verbose logging. |
| `log_download_progress` | `true` | Live progress bar while downloading. When `false`, one line at the start (size), one with the current speed shortly after, one at completion. |
| `create_log` | `true` | Append all console output to `<download_directory>/downloads.log`. |
| `bundles` | `[]` | Bundle names, keys or URLs to limit the run to. Empty = whole library. |
| `authors` | `[]` | Author slugs (or display names) to limit the run to. Empty = everyone. |
| `chrome_path` | — | Explicit browser executable for page captures. |
| `yt_dlp_path` | `"yt-dlp"` | yt-dlp executable. |
| `admin_password` | random | Unlocks hiding and deleting items in the download browser (long-press the library icon to sign in). A fresh random one is written when the file is created; remove the line to turn the admin features off. |

The legacy `"ON"` / `"OFF"` strings from the old `.ini` file are still accepted for the boolean options.

## Building a standalone executable

Bun can bundle the tool and the runtime into a single binary:

```bash
bun run build            # produces ./itch-batch-downloader (or .exe on Windows)
./itch-batch-downloader list-bundles
```

Cross-compile with `bun build --compile --target=bun-windows-x64 src/cli.ts --outfile itch-batch-downloader.exe` (see the [Bun docs](https://bun.com/docs/bundler/executables) for the list of targets). The browser and yt-dlp remain external requirements.

## Development

```bash
bun install
bun test              # unit tests (HTML parsers, cookies, config, filters, resume file, browser)
bun run typecheck     # tsc --noEmit for the tool and for the browser UI
bun run format        # biome check --write
```

The download browser's front end lives in `src/www/client/` (plain TypeScript + CSS, bundled by Bun's HTML import at start-up and into the compiled binary; icons from [Lucide](https://lucide.dev)).

## Known bugs and caveats

- No filtering by operating system: every file of an item is downloaded.
- No blacklist to exclude individual items.
- Some external links for videos may fail because the host is not supported by yt-dlp (Spotify, SoundCloud, …).
- Videos in the comments are not downloaded, only those in the product page.
- Videos with the same id but modified contents get overwritten.
- Files hosted outside itch.io (Google Drive, Dropbox, …) cannot be downloaded automatically; a warning is printed.
- Download file names are only lightly sanitized; very long paths may fail on Windows.
- The itch.io HTML layout may change; the parsers are the most likely thing to break.
- Screenshots of extremely tall pages are capped at 16384 px.

## Corner cases to keep in mind for testing

- Items whose files live on Google Drive or Dropbox, e.g. [this one](https://nattwentea.itch.io/deadly-revelation).
- Adult-only pages with a confirmation pop-up, e.g. [here](https://xoshdarkheart.itch.io/midnights-kiss) or [here](https://adira.itch.io/tension).
- Bundle items purchased but not yet claimed.
- Items with many screenshots, e.g. [here](https://bootdiskrevolution.itch.io/bleed).

## FAQ

### Why are some bundle items missing from the downloader?

Without `--bundle`, the downloader only processes items in your [purchases list](https://itch.io/my-purchases). With `--bundle`, it reads the bundle page but can only download items that have been claimed. Claim the missing items (see [Tips and tricks](#tips-and-tricks)) and run again.

### Why do some downloads fail or show warnings?

Some projects host their files on external platforms (Dropbox, Google Drive, SoundCloud, Spotify, …). Those cannot be automated; download them manually from the project page.

### "Not properly authenticated"

itch.io redirected the request to its login page. Your cookies are missing, expired or for a different account — re-export them.

## Honourable mention

This project was originally based on https://github.com/shakeyourbunny/itch-downloader with some modifications.
