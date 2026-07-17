<div align="center">
  <img src="public/icon-128.png" width="96" height="96" alt="Tayamun logo">

# Tayamun · تَيَامُن

**Readable mixed Arabic and English text without rewriting page content.**

[![CI](https://github.com/h4ni0/tayamun/actions/workflows/ci.yml/badge.svg)](https://github.com/h4ni0/tayamun/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

Tayamun is an open-source Manifest V3 extension for Chrome and Firefox. It detects text blocks whose first Unicode letter is Arabic and fixes their display direction while preserving the page’s text and layout.

![Tayamun Arabic popup and corrected mixed-language text](store/assets/screenshot-popup-1280x800.png)

## Features

- Processes visible text, dynamic content, text fields, frames, and open Shadow DOM.
- Never rewrites text, adds bidirectional markers, or reorders layout elements.
- Excludes code, editors, passwords, email and URL fields, and non-text inputs.
- Offers exact-host settings for enabling Tayamun, right alignment, and the bundled Tajawal font.
- Restores page-authored behavior when text changes or Tayamun is disabled.
- Uses bounded scheduled work to keep large pages responsive.

## Privacy and permissions

Tayamun works entirely inside the browser. It contains no analytics or remote code, makes no network requests, and does not collect or transmit data. Exact hostnames and their three preferences are stored only in local extension storage.

Access to `http://*/*` and `https://*/*` is required to inspect displayed text and apply the selected local presentation fixes. See the [permission rationale](store/ar/permissions-and-data-declarations.md) and [public privacy policy](https://fikhulbarmajah.com/tayamun/privacy/).

## Development

Requires Node.js 20.19 or newer.

```sh
npm ci
npm run dev          # Chrome
npm run dev:firefox  # Firefox
```

## Checks and builds

```sh
npm run check    # TypeScript + focused regression tests
npm run build    # unpacked Chrome and Firefox builds
npm run release  # checks + store ZIPs + Firefox source ZIP
```

Build output is written to `.output/`. Production packages are generated locally and are not uploaded automatically.

## Project structure

- `src/core/` — Unicode detection, safe container selection, restoration, and scheduled DOM engine.
- `src/entrypoints/` — content script, popup, and open-Shadow-DOM bridge.
- `public/` — localized messages, icons, and bundled Tajawal files.
- `tests/` — small regression suite focused on safety and prior performance failures.
- `store/` — store listings, privacy/reviewer notes, attribution, and upload assets.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Tayamun’s source code and original project assets are licensed under the [MIT License](LICENSE). Bundled Tajawal font files are licensed separately under the SIL Open Font License 1.1; see [`public/fonts/OFL.txt`](public/fonts/OFL.txt) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## العربية

تَيَامُن إضافة مفتوحة المصدر لمتصفحي Chrome وFirefox تجعل النصوص العربية والإنجليزية المختلطة أسهل قراءةً، من دون إعادة كتابة المحتوى أو تغيير تخطيط الصفحة. تعمل محليًا بالكامل، ولا تجمع البيانات أو ترسلها، وتحفظ الخيارات محليًا لكل اسم مضيف دقيق.
