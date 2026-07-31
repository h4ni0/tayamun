import { afterEach, describe, expect, it } from 'vitest';
import {
  editingHostFor,
  findTextContainer,
  firstUnicodeLetterIsArabic,
  getContainerText,
  isSafeTextContainer,
} from '../src/core/detection';

afterEach(() => {
  document.body.replaceChildren();
});

describe('firstUnicodeLetterIsArabic', () => {
  it('skips non-letters and recognizes the standard Arabic alphabet', () => {
    expect(firstUnicodeLetterIsArabic('  ١٢٣ — 👋 َإسلام')).toBe(true);
    expect(firstUnicodeLetterIsArabic('\u0654اَلْعَرَبِيَّة')).toBe(true);
    expect(firstUnicodeLetterIsArabic('ٱلسَّلَام')).toBe(true);
  });

  it('leaves text unchanged when the first letter is not standard Arabic', () => {
    expect(firstUnicodeLetterIsArabic('123 Hello العربية')).toBe(false);
    expect(firstUnicodeLetterIsArabic('پ فارسی')).toBe(false);
    expect(firstUnicodeLetterIsArabic('🧭 — ١٢٣')).toBe(false);
    expect(firstUnicodeLetterIsArabic('𐐀 العربية')).toBe(false);
  });
});

describe('text container selection', () => {
  it('groups inline text at its nearest block in DOM order', () => {
    document.body.innerHTML = '<p id="target"><span>١٢٣، </span><strong>العربية</strong></p>';
    const paragraph = document.querySelector<HTMLElement>('#target')!;
    const text = paragraph.querySelector('strong')!.firstChild as Text;

    expect(findTextContainer(text)).toBe(paragraph);
    expect(getContainerText(paragraph)).toBe('١٢٣، العربية');
    expect(isSafeTextContainer(paragraph)).toBe(true);
  });

  it('targets a list item itself so its marker follows the text it labels', () => {
    document.body.innerHTML = [
      '<ul><li id="item">العربية</li><li><span id="wrapped-item">العربية</span></li></ul>',
      '<details><summary id="summary">العربية</summary></details>',
    ].join('');

    const item = document.querySelector<HTMLElement>('#item')!;
    const summary = document.querySelector<HTMLElement>('#summary')!;
    const wrappedItem = document.querySelector<HTMLElement>('#wrapped-item')!;

    expect(findTextContainer(item.firstChild as Text)).toBe(item);
    expect(findTextContainer(summary.firstChild as Text)).toBe(summary);
    // The whole item flips, not the inline wrapper: flipping the wrapper alone
    // leaves the bullet on the opposite side of the text.
    expect(findTextContainer(wrappedItem.firstChild as Text)).toBe(wrappedItem.parentElement);
    expect(isSafeTextContainer(item)).toBe(true);
    expect(isSafeTextContainer(summary)).toBe(true);
  });

  it('leaves list items that hold controls or icons alone', () => {
    document.body.innerHTML = [
      '<ul><li id="checkbox-item"><input type="checkbox"> العربية</li></ul>',
      '<nav><ul><li id="nav-item"><a href="#a"><svg viewBox="0 0 1 1"></svg> العربية</a></li></ul></nav>',
      '<ul><li id="nested-item">العربية<ul><li id="leaf">العربية</li></ul></li></ul>',
    ].join('');

    const checkboxItem = document.querySelector<HTMLElement>('#checkbox-item')!;
    const navItem = document.querySelector<HTMLElement>('#nav-item')!;
    const nestedItem = document.querySelector<HTMLElement>('#nested-item')!;
    const leaf = document.querySelector<HTMLElement>('#leaf')!;

    expect(isSafeTextContainer(checkboxItem)).toBe(false);
    expect(isSafeTextContainer(navItem)).toBe(false);
    expect(isSafeTextContainer(nestedItem)).toBe(false);
    expect(isSafeTextContainer(leaf)).toBe(true);
  });

  it('preserves code editors while allowing prose links', () => {
    document.body.innerHTML = [
      '<textarea id="code" data-language="typescript">العربية</textarea>',
      '<p id="link">العربية <a href="#more">رابط</a></p>',
      '<p><span id="wrapped-icon">العربية</span><img alt="" src="icon.png"></p>',
    ].join('');

    const codeEditor = document.querySelector<HTMLElement>('#code')!;
    const linkParagraph = document.querySelector<HTMLElement>('#link')!;
    const wrappedIconText = document.querySelector('#wrapped-icon')!.firstChild as Text;

    expect(isSafeTextContainer(codeEditor)).toBe(false);
    expect(isSafeTextContainer(linkParagraph)).toBe(true);
    expect(findTextContainer(wrappedIconText)).toBe(wrappedIconText.parentElement);
  });
});

describe('editing hosts', () => {
  it('targets the host itself, never the blocks an editor rebuilds inside it', () => {
    document.body.innerHTML =
      '<div id="host" contenteditable="true"><p id="line">العربية</p><p>سطر ثانٍ</p></div>';
    const host = document.querySelector<HTMLElement>('#host')!;
    const line = document.querySelector<HTMLElement>('#line')!;

    expect(editingHostFor(line)).toBe(host);
    expect(findTextContainer(line.firstChild as Text)).toBe(host);
    // Block children are the editor's own paragraphs, so they must not disqualify
    // the host the way they would disqualify an ordinary block.
    expect(isSafeTextContainer(host)).toBe(true);
  });

  it('uses the outer editor for redundant nested editables without leaking that host to siblings', () => {
    document.body.innerHTML = [
      '<div id="outer" contenteditable="true"><p id="inner" contenteditable="true">العربية</p></div>',
      '<p id="sibling">العربية</p>',
    ].join('');
    const outer = document.querySelector<HTMLElement>('#outer')!;
    const inner = document.querySelector<HTMLElement>('#inner')!;
    const sibling = document.querySelector<HTMLElement>('#sibling')!;

    expect(editingHostFor(inner)).toBe(outer);
    expect(editingHostFor(sibling)).toBeNull();
    expect(findTextContainer(sibling.firstChild as Text)).toBe(sibling);
  });

  it('recognizes a genuinely nested field separated by a non-editable island', () => {
    document.body.innerHTML =
      '<div id="outer" contenteditable="true"><div contenteditable="false"><p id="nested" contenteditable="true">العربية</p></div></div>';
    const nested = document.querySelector<HTMLElement>('#nested')!;

    expect(editingHostFor(nested)).toBe(nested);
    expect(findTextContainer(nested.firstChild as Text)).toBe(nested);
  });

  it('resolves text in a non-editable island to the surrounding host', () => {
    document.body.innerHTML =
      '<div id="host" contenteditable="true"><span id="chip" contenteditable="false">مرجع</span> نص</div>';
    const host = document.querySelector<HTMLElement>('#host')!;
    const chip = document.querySelector<HTMLElement>('#chip')!;

    expect(findTextContainer(chip.firstChild as Text)).toBe(host);
    expect(getContainerText(host)).toContain('مرجع');
  });

  it('leaves an ordinary block outside any editor unaffected', () => {
    document.body.innerHTML = '<p id="prose">العربية</p>';
    const prose = document.querySelector<HTMLElement>('#prose')!;

    expect(editingHostFor(prose)).toBeNull();
    expect(findTextContainer(prose.firstChild as Text)).toBe(prose);
  });
});
