# Contributing to Tayamun

Thanks for helping improve Tayamun.

## Before opening a pull request

1. Use Node.js 20.19 or newer.
2. Install the locked dependencies with `npm ci`.
3. Keep changes focused and preserve the extension’s safety constraints in `SPECS.md`.
4. Run `npm run check` and `npm run build`.

## Project rules

- Never rewrite page text, add bidirectional control characters, or reorder layout elements.
- Keep all processing local; do not add analytics, remote code, remote fonts, or data transmission.
- Preserve page-authored styles and restore them when Tayamun stops applying a fix.
- Keep DOM work bounded and responsive on large or dynamic pages.
- Add only high-value regression tests. Do not add trivial or overlapping tests.
- Include the Tajawal OFL license and attribution if font files are changed.

For security issues, follow `SECURITY.md` instead of opening a public issue.
