# تَيَامُن — Specification

## Goal
Make mixed Arabic/English text readable on any website without changing submitted content or page layout.

## Platforms
- Chrome and Firefox
- WXT + TypeScript
- Store-ready, upload-only release
- Fully Arabic interface

## Detection
1. Inspect visible text in displayed blocks and editable fields.
2. Skip whitespace, numbers, punctuation, symbols, emoji, and diacritics.
3. If the first Unicode letter is from the standard Arabic alphabet, mark the text RTL immediately.
4. For other mixed text, inspect only a bounded prefix and mark it RTL only when Arabic-dominant words appear near the start and provide a strong majority; otherwise leave it unchanged.
5. Apply the fix to the nearest text-holding block only, never its layout ancestors.
6. Treat a rich editor as one field: fix its editing host and never style, mark, or rescan the DOM the editor rebuilds inside it.
7. Re-evaluate dynamic content and live editor input.

## Behavior
- Enabled on every permitted website by default.
- Override explicit LTR on affected blocks, including a physical `text-align: left` that the flip turns into the end edge. Centered and justified text is preserved.
- Never reorder flex/grid items, icons, or controls.
- Flip a list item as a whole so its bullet or number stays beside its text, and keep that marker inside the item so a left-to-right list cannot clip it.
- Never rewrite, wrap, or add bidi markers to user content.
- Exclude code, code editors, passwords, email, URL, and non-text fields.
- Restore original behavior when text changes or the extension is disabled.

## Per-site Controls
Stored locally by exact hostname.

- **تفعيل تَيَامُن** — default on.
- **محاذاة النص يمينًا** — default off; preserve centered and justified text.
- **حسّن الخط** — default off; apply bundled Tajawal to affected blocks only.

## Privacy
- No data collection or transmission.
- No remote font requests.
- Tajawal is bundled with its OFL license.

## Release Deliverables
- Chrome and Firefox upload packages
- Arabic popup, messages, and store listing
- Icons and promotional assets
- Privacy documentation and font attribution

## Limitations
- The fix is visible only to users with the extension.
- Browser-internal pages and closed shadow DOM cannot be modified.
