import { afterEach, describe, expect, it } from 'vitest';
import {
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

  it('preserves list, disclosure, and code-editor controls while allowing prose links', () => {
    document.body.innerHTML = [
      '<ul><li id="item">العربية</li><li><span id="wrapped-item">العربية</span></li></ul>',
      '<details><summary id="summary">العربية</summary></details>',
      '<textarea id="code" data-language="typescript">العربية</textarea>',
      '<p id="link">العربية <a href="#more">رابط</a></p>',
      '<p><span id="wrapped-icon">العربية</span><img alt="" src="icon.png"></p>',
    ].join('');

    const itemText = document.querySelector('#item')!.firstChild as Text;
    const summaryText = document.querySelector('#summary')!.firstChild as Text;
    const wrappedItem = document.querySelector<HTMLElement>('#wrapped-item')!;
    const codeEditor = document.querySelector<HTMLElement>('#code')!;
    const linkParagraph = document.querySelector<HTMLElement>('#link')!;
    const wrappedIconText = document.querySelector('#wrapped-icon')!.firstChild as Text;

    expect(findTextContainer(itemText)).toBeNull();
    expect(findTextContainer(summaryText)).toBeNull();
    expect(findTextContainer(wrappedItem.firstChild as Text)).toBe(wrappedItem);
    expect(isSafeTextContainer(codeEditor)).toBe(false);
    expect(isSafeTextContainer(linkParagraph)).toBe(true);
    expect(findTextContainer(wrappedIconText)).toBe(wrappedIconText.parentElement);
  });
});
