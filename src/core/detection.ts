const UNICODE_LETTER = /\p{Letter}/u;

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

const UNSAFE_TARGET_TAGS = new Set(['LI', 'SUMMARY']);

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'tel']);
const MAX_ANCESTOR_DEPTH = 64;
const MAX_DESCENDANT_ELEMENTS = 32;
const MAX_TEXT_NODES = 64;
const MAX_INSPECTED_CODE_POINTS = 8_192;

interface ElementFacts {
  epoch: number;
  displayed?: boolean;
  excluded?: boolean;
  classification?: 'inline' | 'safe' | 'layout';
}

// Facts derived from computed styles are memoized per element within an epoch.
// The engine bumps the epoch when mutations, stylesheet loads, or resizes may
// have changed styles, so a full-page scan reads each element's style once
// instead of once per descendant text node.
let factsEpoch = 0;
const elementFacts = new WeakMap<Element, ElementFacts>();

/** Drops memoized computed-style facts. Called by the engine before rescanning. */
export function invalidateDetectionCaches(): void {
  factsEpoch += 1;
}

function factsFor(element: Element): ElementFacts {
  let facts = elementFacts.get(element);
  if (!facts || facts.epoch !== factsEpoch) {
    facts = { epoch: factsEpoch };
    elementFacts.set(element, facts);
  }
  return facts;
}

export function firstUnicodeLetterIsArabic(text: string): boolean {
  let inspected = 0;
  for (const character of text) {
    if (inspected++ >= MAX_INSPECTED_CODE_POINTS) return false;
    if (!UNICODE_LETTER.test(character)) continue;
    return STANDARD_ARABIC_LETTER.test(character);
  }

  return false;
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
  const view = element.ownerDocument.defaultView;
  const display = view?.getComputedStyle(element).display?.trim();
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

  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
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
  let current: Element | null = node.nodeType === 3 ? (node as Text).parentElement : (node as Element);
  let inlineFallback: HTMLElement | null = null;
  let depth = 0;

  if (!current || isExcluded(current) || !isDisplayed(current)) return null;

  while (current && depth++ < MAX_ANCESTOR_DEPTH) {
    if (current.tagName === 'HTML' || current.tagName === 'BODY') return null;
    if (UNSAFE_TARGET_TAGS.has(current.tagName)) return inlineFallback;

    const classification = classifyContainer(current);
    if (classification === 'layout') return inlineFallback;
    if (isEditableBoundary(current)) {
      return current instanceof current.ownerDocument.defaultView!.HTMLElement
        ? (current as HTMLElement)
        : null;
    }
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
    if (child.matches(PROTECTED_SELECTOR) || child.matches(CODE_EDITOR_SELECTOR)) return true;
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
      if (current.matches(PROTECTED_SELECTOR) || current.matches(CODE_EDITOR_SELECTOR)) return true;
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
  if (
    container.tagName === 'HTML' ||
    container.tagName === 'BODY' ||
    UNSAFE_TARGET_TAGS.has(container.tagName)
  ) {
    return false;
  }
  if (classifyContainer(container) === 'layout') return false;
  return !hasUnsafeDescendant(container);
}

export function getContainerText(container: HTMLElement): string {
  const document = container.ownerDocument;
  const nodeFilter = document.defaultView?.NodeFilter;
  const walker = document.createTreeWalker(container, nodeFilter?.SHOW_TEXT ?? 4);
  const parts: string[] = [];

  let inspected = 0;
  let current = walker.nextNode();
  while (current && inspected++ < MAX_TEXT_NODES) {
    const text = current as Text;
    if (text.data) {
      if (!UNICODE_LETTER.test(text.data)) {
        // Punctuation cannot decide direction, so avoid an expensive repeated
        // container/visibility lookup for it.
        parts.push(text.data);
      } else if (findTextContainer(text) === container) {
        parts.push(text.data);
        break;
      }
    }
    current = walker.nextNode();
  }

  return parts.join('');
}
