const UNICODE_LETTER = /\p{Letter}/u;
const UNICODE_MARK = /\p{Mark}/u;

// Arabic letters used by standard Arabic orthography. Extended Persian and Urdu
// letters are intentionally not included.
const STANDARD_ARABIC_LETTER = /^[\u0621-\u063A\u0641-\u064A\u0671]$/u;

const BLOCK_DISPLAYS = new Set([
  'block',
  'flow-root',
  'inline-block',
  'list-item',
  'table-cell',
  'table-caption',
]);

const LAYOUT_DISPLAYS = new Set([
  'flex',
  'inline-flex',
  'grid',
  'inline-grid',
  'table',
  'inline-table',
  'table-row',
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-column',
  'table-column-group',
]);

const DEFAULT_BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BODY',
  'DD',
  'DETAILS',
  'DIALOG',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HGROUP',
  'HR',
  'LI',
  'MAIN',
  'MENU',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

const EXCLUDED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'TEMPLATE',
  'NOSCRIPT',
  'PRE',
  'CODE',
  'KBD',
  'SAMP',
  'BUTTON',
  'SELECT',
  'OPTION',
  'OPTGROUP',
  'CANVAS',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'VIDEO',
  'AUDIO',
]);

const PROTECTED_SELECTOR = [
  'button',
  'select',
  'input',
  'textarea',
  'img',
  'picture',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[aria-hidden="true"]',
].join(',');

const CODE_EDITOR_SELECTOR = [
  '.CodeMirror',
  '.cm-editor',
  '.monaco-editor',
  '.ace_editor',
  '.hljs',
  '.prism',
  '.codejar-wrap',
  '[class*="code-editor" i]',
  '[class*="source-editor" i]',
  '[role="code"]',
  '[data-code-editor]',
  '[data-language]',
  '[data-mode^="text/"]',
].join(',');

// Every protected or code-editor test asks the same question — "does this element
// hold content that must not be reordered?" — so both selector lists are matched
// in one pass instead of two.
const UNSAFE_CONTENT_SELECTOR = `${PROTECTED_SELECTOR},${CODE_EDITOR_SELECTOR}`;

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'tel']);
const MAX_ANCESTOR_DEPTH = 64;
const MAX_DESCENDANT_ELEMENTS = 32;
const MAX_TEXT_NODES = 64;
const MAX_BOUNDARY_SIBLINGS = 16;
const MAX_FIRST_LETTER_CODE_POINTS = 8_192;
const MAX_DIRECTION_CODE_POINTS = 512;
const MAX_DIRECTION_WORDS = 32;
const MAX_WORD_SCORE = 4;
const MAX_LEADING_NON_ARABIC_WORDS = 3;
const MIN_ARABIC_SCORE = 8;
const ARABIC_RATIO_MULTIPLIER = 5;
const TOTAL_RATIO_MULTIPLIER = 3;
const MAX_COLLECTED_CODE_UNITS = 2 * (MAX_FIRST_LETTER_CODE_POINTS + MAX_DIRECTION_CODE_POINTS);

interface ElementFacts {
  epoch: number;
  style?: CSSStyleDeclaration | null;
  displayed?: boolean;
  excluded?: boolean;
  classification?: 'inline' | 'safe' | 'layout';
  container?: HTMLElement | null;
  editingHost?: HTMLElement | null;
}

// Facts that depend on an element's own attributes only. They survive epoch
// bumps because no ancestor, stylesheet, or layout change can alter them; the
// engine drops them per element when that element's observed attributes change.
interface IntrinsicFacts {
  selfExcluded?: boolean;
  unsafeContent?: boolean;
}

// Facts derived from computed styles are memoized per element within an epoch.
// The engine bumps the epoch when mutations, stylesheet loads, or resizes may
// have changed styles, so a full-page scan reads each element's style once
// instead of once per descendant text node.
let factsEpoch = 0;
const elementFacts = new WeakMap<Element, ElementFacts>();
let intrinsicFacts = new WeakMap<Element, IntrinsicFacts>();

/** Drops memoized computed-style facts. Called by the engine before rescanning. */
export function invalidateDetectionCaches(): void {
  factsEpoch += 1;
}

/** Drops the attribute-derived facts of one element after its attributes change. */
export function invalidateElementFacts(element: Element): void {
  intrinsicFacts.delete(element);
}

/** Drops all attribute-derived facts after mutations occurred while unobserved. */
export function invalidateAllElementFacts(): void {
  intrinsicFacts = new WeakMap();
}

function factsFor(element: Element): ElementFacts {
  let facts = elementFacts.get(element);
  if (!facts || facts.epoch !== factsEpoch) {
    facts = { epoch: factsEpoch };
    elementFacts.set(element, facts);
  }
  return facts;
}

function intrinsicFor(element: Element): IntrinsicFacts {
  let facts = intrinsicFacts.get(element);
  if (!facts) {
    facts = {};
    intrinsicFacts.set(element, facts);
  }
  return facts;
}

// The declaration stays live, so cached reads see the current value; caching it
// avoids allocating one wrapper per visibility test, classification, and
// direction check of the same element.
export function computedStyleFor(element: Element): CSSStyleDeclaration | null {
  const facts = factsFor(element);
  if (facts.style === undefined) {
    facts.style = element.ownerDocument.defaultView?.getComputedStyle(element) ?? null;
  }
  return facts.style;
}

function hasUnsafeContent(element: Element): boolean {
  const intrinsic = intrinsicFor(element);
  intrinsic.unsafeContent ??= element.matches(UNSAFE_CONTENT_SELECTOR);
  return intrinsic.unsafeContent;
}

function firstUnicodeLetterIsStandardArabic(text: string, maxCodePoints: number): boolean | null {
  let inspectedCodePoints = 0;
  for (const character of text) {
    if (inspectedCodePoints === maxCodePoints) return null;
    inspectedCodePoints += 1;
    if (!UNICODE_LETTER.test(character)) continue;
    return STANDARD_ARABIC_LETTER.test(character);
  }
  return null;
}

export function textShouldUseRtl(text: string): boolean {
  let searchedCodePoints = 0;
  let inspectedCodePoints = 0;
  let fallbackStarted = false;
  let wordCount = 0;
  let arabicScore = 0;
  let totalScore = 0;
  let wordArabicLetters = 0;
  let wordOtherLetters = 0;
  let wordScore = 0;
  let earlyArabicWordSeen = false;

  for (const character of text) {
    if (!fallbackStarted) {
      if (searchedCodePoints === MAX_FIRST_LETTER_CODE_POINTS) return false;
      searchedCodePoints += 1;
      if (!UNICODE_LETTER.test(character)) continue;
      if (STANDARD_ARABIC_LETTER.test(character)) return true;
      fallbackStarted = true;
    }

    if (inspectedCodePoints === MAX_DIRECTION_CODE_POINTS || wordCount === MAX_DIRECTION_WORDS) break;
    inspectedCodePoints += 1;

    if (UNICODE_LETTER.test(character)) {
      const isArabic = STANDARD_ARABIC_LETTER.test(character);
      if (isArabic) wordArabicLetters += 1;
      else wordOtherLetters += 1;
      if (wordScore < MAX_WORD_SCORE) wordScore += 1;
      continue;
    }

    if (UNICODE_MARK.test(character) && wordScore !== 0) continue;
    if (wordScore === 0) continue;

    wordCount += 1;
    totalScore += wordScore;
    if (wordArabicLetters > wordOtherLetters) {
      arabicScore += wordScore;
      if (wordCount <= MAX_LEADING_NON_ARABIC_WORDS + 1) earlyArabicWordSeen = true;
    }
    if (wordCount === MAX_LEADING_NON_ARABIC_WORDS + 1 && !earlyArabicWordSeen) return false;

    wordArabicLetters = 0;
    wordOtherLetters = 0;
    wordScore = 0;
  }

  if (wordScore !== 0 && wordCount < MAX_DIRECTION_WORDS) {
    wordCount += 1;
    totalScore += wordScore;
    if (wordArabicLetters > wordOtherLetters) {
      arabicScore += wordScore;
      if (wordCount <= MAX_LEADING_NON_ARABIC_WORDS + 1) earlyArabicWordSeen = true;
    }
  }

  return (
    earlyArabicWordSeen &&
    arabicScore >= MIN_ARABIC_SCORE &&
    arabicScore * ARABIC_RATIO_MULTIPLIER >= totalScore * TOTAL_RATIO_MULTIPLIER
  );
}

export function isTextInput(element: Element): element is HTMLInputElement {
  return element.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((element.getAttribute('type') ?? '').toLowerCase());
}

export function isTextField(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  return isTextInput(element) || element.tagName === 'TEXTAREA';
}

export function getTextFieldValue(element: HTMLInputElement | HTMLTextAreaElement): string {
  return element.value || element.getAttribute('placeholder') || '';
}

export function composedParent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;

  const root = element.getRootNode();
  return root.nodeType === 11 && 'host' in root ? (root as ShadowRoot).host : null;
}

function computedDisplay(element: Element): string {
  const display = computedStyleFor(element)?.display?.trim();
  if (display) return display;
  if (element.tagName === 'LI') return 'list-item';
  if (element.tagName === 'TD' || element.tagName === 'TH') return 'table-cell';
  if (element.tagName === 'TABLE') return 'table';
  if (element.tagName === 'TR') return 'table-row';
  if (DEFAULT_BLOCK_TAGS.has(element.tagName)) return 'block';
  return 'inline';
}

function isEditableBoundary(element: Element): boolean {
  const value = element.getAttribute('contenteditable');
  return value !== null && value.toLowerCase() !== 'false';
}

/**
 * Editing host that owns the element's DOM, looking through non-editable islands.
 * Nested `contenteditable=true` nodes are part of the outer editor unless a
 * `contenteditable=false` island separates a genuinely nested field. Styling a
 * redundant inner editable makes reconciling editors remove our writes.
 *
 * A whole-document host (design mode) is reported as none. It is a page being
 * edited rather than one field, and no editor reconciles that DOM.
 */
export function editingHostFor(element: Element): HTMLElement | null {
  const facts = factsFor(element);
  if (facts.editingHost !== undefined) return facts.editingHost;

  const chain: Element[] = [];
  let current: Element | null = element;
  let host: HTMLElement | null = null;
  let ownedCount = 0;
  while (current) {
    const editable = current.getAttribute('contenteditable');
    const isBoundary = editable !== null;
    const isNonEditableBoundary = isBoundary && editable.toLowerCase() === 'false';
    if (isNonEditableBoundary && host) break;

    if (current !== element) {
      const cached = elementFacts.get(current);
      if (cached && cached.epoch === factsEpoch && cached.editingHost !== undefined) {
        if (cached.editingHost) {
          host = cached.editingHost;
          ownedCount = chain.length;
        }
        break;
      }
    }

    if (isBoundary && !isNonEditableBoundary) {
      const view = current.ownerDocument.defaultView;
      host =
        current.tagName !== 'BODY' &&
        current.tagName !== 'HTML' &&
        view &&
        current instanceof view.HTMLElement
          ? current
          : null;
      ownedCount = host ? chain.length + 1 : 0;
    }
    chain.push(current);
    current = composedParent(current);
  }
  for (let index = 0; index < chain.length; index += 1) {
    factsFor(chain[index]!).editingHost = index < ownedCount ? host : null;
  }
  return host;
}

function isForbiddenInput(element: Element): boolean {
  return element.tagName === 'INPUT' && !isTextInput(element);
}

export function isExcluded(element: Element): boolean {
  const facts = factsFor(element);
  if (facts.excluded !== undefined) return facts.excluded;

  // Fold the result down the uncached ancestor segment so each element's
  // exclusion is derived once per epoch instead of re-walking shared chains.
  const chain: Element[] = [];
  let current: Element | null = element;
  let excluded = false;
  while (current) {
    if (current !== element) {
      const cached = elementFacts.get(current);
      if (cached && cached.epoch === factsEpoch && cached.excluded !== undefined) {
        excluded = cached.excluded;
        break;
      }
    }
    if (isSelfExcluded(current)) {
      excluded = true;
      factsFor(current).excluded = true;
      break;
    }
    chain.push(current);
    current = composedParent(current);
  }
  for (const item of chain) factsFor(item).excluded = excluded;
  return excluded;
}

function isSelfExcluded(element: Element): boolean {
  const intrinsic = intrinsicFor(element);
  intrinsic.selfExcluded ??= computeSelfExcluded(element);
  return intrinsic.selfExcluded;
}

function computeSelfExcluded(element: Element): boolean {
  if (EXCLUDED_TAGS.has(element.tagName) || isForbiddenInput(element)) return true;
  if (element.matches(CODE_EDITOR_SELECTOR)) return true;
  return Boolean(element.namespaceURI) && element.namespaceURI !== 'http://www.w3.org/1999/xhtml';
}

export function isDisplayed(element: Element): boolean {
  const facts = factsFor(element);
  if (facts.displayed !== undefined) return facts.displayed;

  const chain: Element[] = [];
  let current: Element | null = element;
  let displayed = true;
  while (current) {
    if (current !== element) {
      const cached = elementFacts.get(current);
      if (cached && cached.epoch === factsEpoch && cached.displayed !== undefined) {
        displayed = cached.displayed;
        break;
      }
    }
    if (!isSelfDisplayed(current)) {
      displayed = false;
      factsFor(current).displayed = false;
      break;
    }
    chain.push(current);
    current = composedParent(current);
  }
  for (const item of chain) factsFor(item).displayed = displayed;
  return displayed;
}

function isSelfDisplayed(element: Element): boolean {
  if (element.hasAttribute('hidden')) return false;

  const style = computedStyleFor(element);
  if (style) {
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.contentVisibility === 'hidden') return false;
    if (Number.parseFloat(style.opacity) === 0) return false;
  }
  return true;
}

function classifyContainer(element: Element): 'inline' | 'safe' | 'layout' {
  const facts = factsFor(element);
  facts.classification ??= computeClassification(element);
  return facts.classification;
}

function computeClassification(element: Element): 'inline' | 'safe' | 'layout' {
  const display = computedDisplay(element);
  if (display === 'contents' || display === 'inline') return 'inline';
  if (LAYOUT_DISPLAYS.has(display) || display.includes('flex') || display.includes('grid')) return 'layout';
  if (BLOCK_DISPLAYS.has(display)) return 'safe';

  // Unknown inline-* boxes are independent formatting contexts; treating them as
  // the target is safer than climbing into a layout ancestor.
  if (display.startsWith('inline-')) return 'safe';
  return 'safe';
}

export function findTextContainer(node: Text | Element): HTMLElement | null {
  const start = node.nodeType === 3 ? (node as Text).parentElement : (node as Element);
  if (!start) return null;

  // Every text node under the same element resolves to the same container, and
  // reconciliation asks again for each of them. Memoize per starting element:
  // the answer depends only on facts that already invalidate with the epoch.
  const facts = factsFor(start);
  if (facts.container !== undefined) return facts.container;
  const container = resolveTextContainer(start);
  facts.container = container;
  return container;
}

function resolveTextContainer(start: Element): HTMLElement | null {
  let current: Element | null = start;
  let inlineFallback: HTMLElement | null = null;
  let depth = 0;

  if (isExcluded(current) || !isDisplayed(current)) return null;

  // Text being written into an editor belongs to the host, however deeply the
  // editor nests it. A host laid out as flex would reorder its own children, so
  // leave those editors untouched rather than target something inside them.
  const host = editingHostFor(start);
  if (host) {
    return isDisplayed(host) && !isExcluded(host) && classifyContainer(host) !== 'layout' ? host : null;
  }

  while (current && depth++ < MAX_ANCESTOR_DEPTH) {
    if (current.tagName === 'HTML' || current.tagName === 'BODY') return null;
    const classification = classifyContainer(current);
    if (classification === 'layout') return inlineFallback;
    if (classification === 'inline') {
      if (current instanceof current.ownerDocument.defaultView!.HTMLElement) {
        inlineFallback = current as HTMLElement;
      }
      current = composedParent(current);
      continue;
    }

    if (classification === 'safe') {
      if (!(current instanceof current.ownerDocument.defaultView!.HTMLElement)) return null;
      const container = current as HTMLElement;
      // For small common icon/control rows, use an existing inline wrapper so
      // changing text direction cannot move the sibling. Deeper safety analysis
      // is deferred to reconciliation and bounded independently.
      return inlineFallback && hasDirectUnsafeChild(container) ? inlineFallback : container;
    }

    current = composedParent(current);
  }

  return inlineFallback;
}

function hasDirectUnsafeChild(container: HTMLElement): boolean {
  if (container.childElementCount > 16) return true;
  for (const child of container.children) {
    if (hasUnsafeContent(child)) return true;
    if (DEFAULT_BLOCK_TAGS.has(child.tagName) || classifyContainer(child) !== 'inline') return true;
  }
  return false;
}

function hasUnsafeDescendant(container: HTMLElement): boolean {
  const document = container.ownerDocument;
  const walker = document.createTreeWalker(
    container,
    document.defaultView?.NodeFilter.SHOW_ELEMENT ?? 1,
  );
  let inspected = 0;
  let current = walker.nextNode() as Element | null;
  while (current && inspected++ < MAX_DESCENDANT_ELEMENTS) {
    if (isDisplayed(current)) {
      if (hasUnsafeContent(current)) return true;
      if (classifyContainer(current) !== 'inline') return true;
    }
    current = walker.nextNode() as Element | null;
  }

  // Skip unusually complex blocks rather than risk changing layout or creating
  // an unbounded task. Their smaller nested text blocks are handled separately.
  return current !== null;
}

export function isSafeTextContainer(container: HTMLElement): boolean {
  if (!container.isConnected || !isDisplayed(container) || isExcluded(container)) return false;
  if (container.tagName === 'HTML' || container.tagName === 'BODY') return false;
  if (classifyContainer(container) === 'layout') return false;
  // An editing host holds text the user is writing, not page structure, so its
  // own content decides its direction exactly like a text field does.
  if (isEditableBoundary(container)) return true;
  return !hasUnsafeDescendant(container);
}

function hasRenderedBoundaryBefore(previousText: Text, text: Text, container: HTMLElement): boolean {
  let current: Node | null = text;
  let depth = 0;
  while (current && current !== container && depth++ < MAX_ANCESTOR_DEPTH) {
    if (
      current.nodeType === 1 &&
      !(current as Element).contains(previousText) &&
      classifyContainer(current as Element) !== 'inline'
    ) {
      return true;
    }

    let inspectedSiblings = 0;
    let sibling = current.previousSibling;
    while (sibling && inspectedSiblings++ < MAX_BOUNDARY_SIBLINGS) {
      if (sibling.nodeType === 1) {
        const element = sibling as Element;
        if (isDisplayed(element) && (element.tagName === 'BR' || classifyContainer(element) !== 'inline')) {
          return true;
        }
        if (element.contains(previousText)) return false;
      } else if (sibling === previousText) {
        return false;
      }
      sibling = sibling.previousSibling;
    }
    if (sibling) return true;
    current = current.parentNode;
  }
  return false;
}

export function getContainerText(container: HTMLElement): string {
  const document = container.ownerDocument;
  const nodeFilter = document.defaultView?.NodeFilter;
  const walker = document.createTreeWalker(container, nodeFilter?.SHOW_TEXT ?? 4);
  const parts: string[] = [];

  let inspected = 0;
  let collectedCodeUnits = 0;
  let firstLetterSeen = false;
  let previousText: Text | null = null;
  let current = walker.nextNode();
  while (current && inspected++ < MAX_TEXT_NODES && collectedCodeUnits < MAX_COLLECTED_CODE_UNITS) {
    const text = current as Text;
    if (text.data && findTextContainer(text) === container) {
      if (previousText && hasRenderedBoundaryBefore(previousText, text, container)) {
        parts.push(' ');
        collectedCodeUnits += 1;
      }

      if (collectedCodeUnits < MAX_COLLECTED_CODE_UNITS) {
        const remaining = MAX_COLLECTED_CODE_UNITS - collectedCodeUnits;
        const part = text.data.length <= remaining ? text.data : text.data.slice(0, remaining);
        const partFirstLetterIsArabic = firstUnicodeLetterIsStandardArabic(part, MAX_FIRST_LETTER_CODE_POINTS);
        parts.push(part);
        collectedCodeUnits += part.length;
        previousText = text;
        if (!firstLetterSeen && partFirstLetterIsArabic !== null) {
          firstLetterSeen = true;
          if (partFirstLetterIsArabic) break;
        }
      }
    }
    current = walker.nextNode();
  }

  return parts.join('');
}
