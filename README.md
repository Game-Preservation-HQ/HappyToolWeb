# HappyTool web

A browser version of HappyTool's Game Data editor. It runs entirely in the page: files you open stay on your PC, and saving downloads the edited copy.

## What it does

- Opens files, whole folders, or anything dropped on the page.
- Unwraps BFBR (Blowfish + SHA-256), BSRS (read only, as in HappyTool) and ZRES (zlib), and wraps edited files the same way on save.
- BRES bundles: browse, open, extract (several entries go in a .zip), replace, add, rename, delete, extract all. Bundles inside bundles open the same way, and edits are written back level by level.
- `.lng` text tables: edit per language with the other languages beside each key, add and delete keys, export and import CSV.
- JSON and text: edit, with Format and Minify for JSON. The game's JSON files contain `//` and `/* */` comments, which are accepted as in HappyTool; Format and Minify keep every string and number exactly as written and ask before dropping comments. The original encoding (UTF-8, UTF-8 with BOM, UTF-16) and each line's CRLF or LF ending are kept.
- DDS textures (DXT1/3/5, ATI1/ATI2, DX10 BC1–BC5, uncompressed RGB) and PNG/JPEG/GIF/BMP: preview with zoom, export to PNG.
- Everything else: a paged hex view.

The desktop app's other tools are not part of this version.

## Run it

Browsers only load this page's modules over http(s), and BFBR's SHA-256 check needs a secure address (`https://` or `http://localhost`). Opening `index.html` straight from disk does not work.

From this folder:

```powershell
py serve.py
```

Then open http://localhost:8000/. `serve.py` binds to 127.0.0.1 only and sends correct MIME types (plain `py -m http.server` can serve `.js` as `text/plain` on Windows, which breaks the page).

To host it, copy this folder to any static host that serves HTTPS. There is no build step and no server code.

## Layout

- `index.html`, `css/app.css`, `js/app.js`: the page, styles and app shell (file list, navigation, save).
- `js/formats/`: format code ported from HappyTool's C# (`bres.js`, `lng.js`, `wrappers.js`, `blowfish.js`, `dds.js`, `zip.js`, `sniff.js`), plus `json.js` for comment-tolerant JSON.
- `js/views/`: one view per content type (bundle table, text table, text editor, image preview, hex).

## Checks

The format code was checked against all 1356 files in the Steam release's `Data` folder, comparing the results with HappyTool's own C# classes. All 341 bundles and 64 text tables rebuild byte-for-byte identical to their unwrapped originals, every entry's name, size, command and SHA-256 match the C# results, and all 4788 DDS textures decode.
