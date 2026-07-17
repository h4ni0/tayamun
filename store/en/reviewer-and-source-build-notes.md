# Reviewer and Source Build Notes

## Reviewer notes

- Tayamun’s only purpose is to improve the display direction of mixed Arabic text blocks whose first Unicode letter is a standard Arabic letter.
- The extension does not rewrite text, wrap it in new elements, add bidirectional control characters, or reorder page layout.
- It makes no network requests and contains no analytics, remote code, or data collection.
- The bundled `shadow-main-world.js` bridge temporarily patches `attachShadow` only to notify the content script when an open Shadow DOM is created. It restores the original function when the extension context ends. It does not read or transmit page data.
- Text is processed locally. Code, code editors, passwords, email fields, URL fields, and non-text inputs are excluded.
- Settings are stored locally for each exact hostname.
- Six Tajawal font files and the corresponding `fonts/OFL.txt` license are included in the extension.

## Build tools

The extension is written in TypeScript and built with:

- Node.js 24.16.0
- npm 11.16.0
- WXT 0.20.27
- TypeScript 5.9.3
- Vite 8.1.4, invoked by WXT for bundling and production minification

WXT/Vite combine and process the TypeScript, JavaScript, and CSS files included in the final extension. No web template engine, custom code generator, proprietary build tool, or remote code is used.

## Rebuilding the Firefox package

The verified build environment is Linux x86_64. From the root of the submitted source archive, run:

```sh
npm ci
npm run check
npm run zip:firefox
```

The resulting files are created under `.output/`:

- `.output/tayamun-0.1.2-firefox.zip` — Firefox extension package
- `.output/tayamun-0.1.2-sources.zip` — source archive
- `.output/firefox-mv3/` — unpacked Firefox build

`npm ci` downloads the exact dependencies recorded in `package-lock.json`. After dependency installation, the build requires no network access, environment variables, credentials, private services, or proprietary tools.

Use `npm ci`, not `npm install`, to reproduce the reviewed dependency versions.
