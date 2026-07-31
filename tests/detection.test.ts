import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computedStyleFor,
  editingHostFor,
  isDisplayed,
  isExcluded,
  findTextContainer,
  getContainerText,
  isSafeTextContainer,
  textShouldUseRtl,
} from '../src/core/detection';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function appendNestedElements(depth: number): { root: HTMLElement; leaf: HTMLElement } {
  const root = document.createElement('div');
  let leaf = root;
  for (let index = 1; index < depth; index += 1) {
    const child = document.createElement('div');
    leaf.append(child);
    leaf = child;
  }
  document.body.append(root);
  return { root, leaf };
}

describe('textShouldUseRtl', () => {
  it('accepts substantial mixed-language text', () => {
    expect(textShouldUseRtl('mgrep: بحث بالمعنى داخل المشروع لوكلاء البرمجة')).toBe(true);
    expect(textShouldUseRtl('Google مفيد للبحث ثم نستخدم Chrome للوصول إلى النتيجة')).toBe(true);
    expect(textShouldUseRtl('This is نص عربي طويل وواضح')).toBe(true);
    expect(textShouldUseRtl('JavaScript في نص عربي')).toBe(true);
  });

  it('rejects incidental Arabic and four leading non-Arabic words', () => {
    expect(textShouldUseRtl('API العربية')).toBe(false);
    expect(textShouldUseRtl('English text with one كلمة')).toBe(false);
    expect(textShouldUseRtl('https://example.com شرح عربي قصير')).toBe(false);
    expect(textShouldUseRtl('one two three four عربي عربي عربي عربي عربي عربي')).toBe(false);
  });

  it('requires eight Arabic score points and a sixty-percent share', () => {
    expect(textShouldUseRtl('EnglishWord العربية')).toBe(false);
    expect(textShouldUseRtl('one aa عربي عربي')).toBe(true);
    expect(textShouldUseRtl('one two عربي عربي')).toBe(false);
    expect(textShouldUseRtl('test word عربي عربي عربي')).toBe(true);
  });

  it('caps each word at four score points', () => {
    expect(textShouldUseRtl('EnglishWord عربي عربي')).toBe(true);
    expect(textShouldUseRtl('English العربيةالعربيةالعربية')).toBe(false);
  });

  it('allows at most three leading non-Arabic words', () => {
    expect(textShouldUseRtl('one two three عربي عربي عربي عربي عربي')).toBe(true);
    expect(textShouldUseRtl('one two three four عربي عربي عربي عربي عربي عربي')).toBe(false);
  });

  it('treats punctuation, digits, emoji, and combining marks as neutral', () => {
    expect(textShouldUseRtl('123 — 👋 English... عَرَبِي، عَرَبِي!')).toBe(true);
    expect(textShouldUseRtl('\u0654English ع\u0654ربي عر\u0652بي')).toBe(true);
    expect(textShouldUseRtl('123 — 👋 \u0654\u0652')).toBe(false);
  });

  it('uses Unicode letters while keeping Persian- and Urdu-only letters non-Arabic', () => {
    expect(textShouldUseRtl('پژگچ عربي')).toBe(false);
    expect(textShouldUseRtl('𐐀 عربي عربي')).toBe(true);
    expect(textShouldUseRtl('پ فارسی')).toBe(false);
    expect(textShouldUseRtl('English عربپ عربي')).toBe(true);
    expect(textShouldUseRtl('English عرپچ عربي عربي')).toBe(false);
  });

  it('does not score words after the thirty-second', () => {
    const text = `word ${'عربي '.repeat(19)}${'word '.repeat(12)}عربي`;
    expect(textShouldUseRtl(text)).toBe(false);
  });

  it('inspects at most 512 code points', () => {
    const neutralPrefix = '.'.repeat(700);
    expect(textShouldUseRtl(`${neutralPrefix}a${'.'.repeat(501)} عربي عربي`)).toBe(true);
    expect(textShouldUseRtl(`${neutralPrefix}a${'.'.repeat(502)} عربي عربي`)).toBe(false);
  });

  it('preserves the immediate Arabic-first result regardless of later text', () => {
    expect(textShouldUseRtl(`${'.'.repeat(512)}العربية ${'English '.repeat(100)}`)).toBe(true);
    expect(textShouldUseRtl(`  ١٢٣ — 👋 َإسلام ${'English '.repeat(100)}`)).toBe(true);
    expect(textShouldUseRtl(`\u0654اَلْعَرَبِيَّة ${'English '.repeat(100)}`)).toBe(true);
    expect(textShouldUseRtl(`ٱلسَّلَام ${'English '.repeat(100)}`)).toBe(true);
  });
});

describe('text container selection', () => {
  it('groups inline text at its nearest block in DOM order', () => {
    document.body.innerHTML =
      '<p id="target"><span>١٢٣، </span><strong>العربية</strong><em> English text</em></p>';
    const paragraph = document.querySelector<HTMLElement>('#target')!;
    const text = paragraph.querySelector('strong')!.firstChild as Text;

    expect(findTextContainer(text)).toBe(paragraph);
    expect(getContainerText(paragraph)).toBe('١٢٣، العربية');
    expect(isSafeTextContainer(paragraph)).toBe(true);
  });

  it('collects following inline nodes when an English prefix needs fallback scoring', () => {
    document.body.innerHTML =
      '<p id="target"><strong>mgrep:</strong> بحث بالمعنى داخل المشروع لوكلاء البرمجة</p>';
    const paragraph = document.querySelector<HTMLElement>('#target')!;
    const text = getContainerText(paragraph);

    expect(text).toBe('mgrep: بحث بالمعنى داخل المشروع لوكلاء البرمجة');
    expect(textShouldUseRtl(text)).toBe(true);
  });

  it('ignores hidden neutral text that would otherwise consume the fallback window', () => {
    document.body.innerHTML =
      `<p id="target">JavaScript<span hidden>${'1'.repeat(512)}</span> في نص عربي</p>`;
    const text = getContainerText(document.querySelector<HTMLElement>('#target')!);

    expect(text).toBe('JavaScript في نص عربي');
    expect(textShouldUseRtl(text)).toBe(true);
  });

  it('preserves rendered word boundaries in rich editors', () => {
    document.body.innerHTML = [
      '<div id="breaks" contenteditable>JavaScript<br>في<br>نص<br>عربي</div>',
      '<div id="blocks" contenteditable><p>JavaScript</p><p>في</p><p>نص</p><p>عربي</p></div>',
      '<div id="gaps" contenteditable><span>JavaScript</span><br><i hidden></i><span>في نص عربي</span></div>',
    ].join('');
    const breaks = getContainerText(document.querySelector<HTMLElement>('#breaks')!);
    const blocks = getContainerText(document.querySelector<HTMLElement>('#blocks')!);
    const gaps = getContainerText(document.querySelector<HTMLElement>('#gaps')!);

    expect(breaks).toBe('JavaScript في نص عربي');
    expect(blocks).toBe('JavaScript في نص عربي');
    expect(gaps).toBe('JavaScript في نص عربي');
    expect(textShouldUseRtl(breaks)).toBe(true);
    expect(textShouldUseRtl(blocks)).toBe(true);
    expect(textShouldUseRtl(gaps)).toBe(true);
  });

  it('keeps a word continuous across inline formatting nodes', () => {
    document.body.innerHTML =
      '<div id="target" contenteditable><p><span>Java</span><em>Script</em> في نص عربي</p></div>';
    const text = getContainerText(document.querySelector<HTMLElement>('#target')!);

    expect(text).toBe('JavaScript في نص عربي');
    expect(textShouldUseRtl(text)).toBe(true);
  });

  it('keeps the Arabic-first collection window beyond the fallback limit', () => {
    const prefix = '.'.repeat(2_000);
    document.body.innerHTML =
      `<p id="target">${prefix}<strong>العربية</strong><em> English text</em></p>`;
    const text = getContainerText(document.querySelector<HTMLElement>('#target')!);

    expect(text).toBe(`${prefix}العربية`);
    expect(textShouldUseRtl(text)).toBe(true);
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

describe('bounded ancestor folds', () => {
  it('conservatively stops every cold walk at the ancestor cap and reuses its cached suffix', () => {
    const { leaf } = appendNestedElements(256);
    const sibling = document.createElement('div');
    leaf.parentElement!.append(sibling);

    const styleReads = vi.spyOn(window, 'getComputedStyle');
    expect(isDisplayed(leaf)).toBe(false);
    expect(styleReads).toHaveBeenCalledTimes(64);
    styleReads.mockClear();
    expect(isDisplayed(sibling)).toBe(false);
    expect(styleReads).toHaveBeenCalledTimes(1);
    styleReads.mockRestore();

    const selectorMatches = vi.spyOn(Element.prototype, 'matches');
    expect(isExcluded(leaf)).toBe(true);
    expect(selectorMatches).toHaveBeenCalledTimes(64);
    selectorMatches.mockClear();
    expect(isExcluded(sibling)).toBe(true);
    expect(selectorMatches).toHaveBeenCalledTimes(1);
    selectorMatches.mockRestore();

    const attributeReads = vi.spyOn(Element.prototype, 'getAttribute');
    expect(editingHostFor(leaf)).toBeNull();
    expect(attributeReads).toHaveBeenCalledTimes(64);
    attributeReads.mockClear();
    expect(editingHostFor(sibling)).toBeNull();
    expect(attributeReads).toHaveBeenCalledTimes(2);

    expect(isSafeTextContainer(leaf)).toBe(false);
    expect(isSafeTextContainer(sibling)).toBe(false);
  });

  it('still resolves ordinary visibility, exclusions, and editing hosts within the cap', () => {
    // These elements plus BODY and HTML fill the 64-element walk. Shared
    // document-node facts may already be cached by earlier cases in this file.
    const { root, leaf } = appendNestedElements(62);
    root.setAttribute('contenteditable', 'true');

    const styleReads = vi.spyOn(window, 'getComputedStyle');
    expect(isDisplayed(leaf)).toBe(true);
    expect(styleReads.mock.calls.length).toBeLessThanOrEqual(64);
    expect(styleReads.mock.calls.length).toBeGreaterThan(0);
    styleReads.mockRestore();

    const selectorMatches = vi.spyOn(Element.prototype, 'matches');
    expect(isExcluded(leaf)).toBe(false);
    expect(selectorMatches.mock.calls.length).toBeLessThanOrEqual(64);
    expect(selectorMatches.mock.calls.length).toBeGreaterThan(0);
    selectorMatches.mockRestore();

    const attributeReads = vi.spyOn(Element.prototype, 'getAttribute');
    expect(editingHostFor(leaf)).toBe(root);
    expect(attributeReads.mock.calls.length).toBeLessThanOrEqual(64);
    expect(attributeReads.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('detection fact epochs', () => {
  it('memoizes repeated computed-style reads within the same epoch', () => {
    const target = document.createElement('div');
    document.body.append(target);
    const styleReads = vi.spyOn(window, 'getComputedStyle');

    const first = computedStyleFor(target);
    const second = computedStyleFor(target);

    expect(second).toBe(first);
    expect(styleReads).toHaveBeenCalledTimes(1);
  });
});
