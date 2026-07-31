import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TayamunDirectionEngine,
  type TayamunWorkScheduler,
} from '../src/core/engine';
import type { SiteSettings } from '../src/settings';

const defaults: SiteSettings = {
  enabled: true,
  alignRight: false,
  improveFont: false,
};

let engine: TayamunDirectionEngine | undefined;

class FakeScheduler implements TayamunWorkScheduler {
  private readonly callbacks: Array<{ callback: () => void; cancelled: boolean }> = [];
  private clock = 0;

  now(): number {
    return this.clock++;
  }

  schedule(callback: () => void): () => void {
    const entry = { callback, cancelled: false };
    this.callbacks.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  runNext(): void {
    const next = this.callbacks.find((entry) => !entry.cancelled);
    if (!next) return;
    next.cancelled = true;
    next.callback();
  }

  get pending(): number {
    return this.callbacks.filter((entry) => !entry.cancelled).length;
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  engine?.flush();
}

afterEach(() => {
  engine?.destroy();
  engine?.flush();
  engine = undefined;
  document.body.replaceChildren();
  document.head.replaceChildren();
  vi.useRealTimers();
});

// A subtree walk started by the scanner is the observable signal that a rescan
// ran: reconciliation walks the same root with different filters.
function subtreeScans(spy: { mock: { calls: unknown[][] } }, root: Node): number {
  return spy.mock.calls.filter((call) => call[0] === root && call[1] === 5).length;
}

describe('TayamunDirectionEngine', () => {
  it('returns from startup before traversing the document and bounds each scheduled slice', () => {
    document.body.innerHTML = Array.from({ length: 500 }, (_, index) => `<p>العربية ${index}</p>`).join('');
    const scheduler = new FakeScheduler();
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');
    engine = new TayamunDirectionEngine(document, defaults, {
      scheduler,
      sliceBudgetMs: 8,
      maxStepsPerSlice: 1_000,
    });

    engine.start();

    expect(walkerSpy).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>('p')!.style.direction).toBe('');
    expect(scheduler.pending).toBe(1);

    scheduler.runNext();
    const partiallyProcessed = document.querySelectorAll<HTMLElement>('p[style*="direction"]');
    expect(partiallyProcessed.length).toBeLessThan(500);
    expect(scheduler.pending).toBe(1);

    engine.flush();
    expect(document.querySelectorAll('p[style*="direction"]').length).toBe(500);
    walkerSpy.mockRestore();
  });

  it('restyles large affected sets over bounded scheduler slices', () => {
    document.body.innerHTML = Array.from({ length: 500 }, (_, index) => `<p>العربية ${index}</p>`).join('');
    const scheduler = new FakeScheduler();
    engine = new TayamunDirectionEngine(document, defaults, {
      scheduler,
      sliceBudgetMs: 8,
      maxStepsPerSlice: 1_000,
    });
    engine.start();
    engine.flush();

    engine.updateSettings({ enabled: true, alignRight: true, improveFont: false });
    scheduler.runNext();

    const partiallyRestyled = document.querySelectorAll<HTMLElement>('p[style*="text-align"]');
    expect(partiallyRestyled.length).toBeGreaterThan(0);
    expect(partiallyRestyled.length).toBeLessThan(500);
    expect(scheduler.pending).toBe(1);

    engine.flush();
    expect(document.querySelectorAll('p[style*="text-align"]').length).toBe(500);
  });

  it('does not rescan an existing parent subtree when a child is added', async () => {
    document.body.innerHTML = `<main>${Array.from({ length: 300 }, (_, index) => `<p>العربية ${index}</p>`).join('')}</main>`;
    const scheduler = new FakeScheduler();
    engine = new TayamunDirectionEngine(document, defaults, { scheduler });
    engine.start();
    engine.flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    engine.flush();

    const walkerSpy = vi.spyOn(document, 'createTreeWalker');
    const span = document.createElement('span');
    span.textContent = 'العربية الجديدة';
    document.querySelector('main')!.append(span);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    engine.flush();

    expect(span.style.direction).toBe('rtl');
    expect(walkerSpy.mock.calls.length).toBeLessThan(10);
    walkerSpy.mockRestore();
  });

  it('queues bulk sibling insertion as bounded work instead of observer-side O(N²)', async () => {
    document.body.innerHTML = '<main><p>العربية الأصلية</p></main>';
    const scheduler = new FakeScheduler();
    engine = new TayamunDirectionEngine(document, defaults, { scheduler });
    engine.start();
    engine.flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    engine.flush();

    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 1_000; index += 1) {
      const paragraph = document.createElement('p');
      paragraph.textContent = `العربية ${index}`;
      fragment.append(paragraph);
    }
    document.querySelector('main')!.append(fragment);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(scheduler.pending).toBe(1);
    scheduler.runNext();
    expect(document.querySelectorAll('[data-tayamun-affected-q7m3]').length).toBeLessThan(1_001);
    engine.flush();
    expect(document.querySelectorAll('[data-tayamun-affected-q7m3]').length).toBe(1_001);
  });

  it('captures many individual mutation records in one resumable batch job', async () => {
    document.body.innerHTML = '<main></main>';
    const scheduler = new FakeScheduler();
    engine = new TayamunDirectionEngine(document, defaults, { scheduler });
    engine.start();
    engine.flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    engine.flush();

    const main = document.querySelector('main')!;
    for (let index = 0; index < 500; index += 1) {
      const paragraph = document.createElement('p');
      paragraph.textContent = `العربية ${index}`;
      main.append(paragraph);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(scheduler.pending).toBe(1);
    scheduler.runNext();
    expect(document.querySelectorAll('[data-tayamun-affected-q7m3]').length).toBeLessThan(500);
    engine.flush();
    expect(document.querySelectorAll('[data-tayamun-affected-q7m3]').length).toBe(500);
  });

  it('overrides explicit important LTR without rewriting content and restores it on text change', async () => {
    document.body.innerHTML =
      '<p id="target" style="direction: ltr !important; text-align: center; color: red"><em>العربية</em> English</p>';
    const paragraph = document.querySelector<HTMLElement>('#target')!;
    const originalMarkup = paragraph.innerHTML;

    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();

    expect(paragraph.style.getPropertyValue('direction')).toBe('rtl');
    expect(paragraph.style.getPropertyPriority('direction')).toBe('important');
    expect(paragraph.style.textAlign).toBe('center');
    expect(paragraph.innerHTML).toBe(originalMarkup);

    paragraph.querySelector('em')!.textContent = 'English';
    await settle();

    expect(paragraph.style.getPropertyValue('direction')).toBe('ltr');
    expect(paragraph.style.getPropertyPriority('direction')).toBe('important');
    expect(paragraph.style.textAlign).toBe('center');
    expect(paragraph.style.color).toBe('red');
  });

  it('applies optional alignment and font only while enabled, preserving center and justify', async () => {
    document.body.innerHTML = [
      '<p id="target" style="text-align: justify">العربية English</p>',
      '<p id="left" style="text-align: left">العربية English</p>',
    ].join('');
    const paragraph = document.querySelector<HTMLElement>('#target')!;
    const leftParagraph = document.querySelector<HTMLElement>('#left')!;
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();

    expect(paragraph.style.textAlign).toBe('justify');
    expect(paragraph.style.fontFamily).toBe('');

    engine.updateSettings({ enabled: true, alignRight: true, improveFont: true });
    engine.flush();
    expect(paragraph.style.textAlign).toBe('justify');
    expect(leftParagraph.style.getPropertyValue('text-align')).toBe('right');
    expect(leftParagraph.style.getPropertyPriority('text-align')).toBe('important');
    expect(paragraph.hasAttribute('data-tayamun-font-q7m3')).toBe(true);
    expect(paragraph.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(paragraph.style.fontFamily).toBe('');

    leftParagraph.style.setProperty('text-align', 'center');
    await settle();
    expect(leftParagraph.style.textAlign).toBe('center');

    engine.updateSettings({ enabled: false, alignRight: true, improveFont: true });
    engine.flush();
    expect(paragraph.style.direction).toBe('');
    expect(paragraph.style.textAlign).toBe('justify');
    expect(paragraph.style.fontFamily).toBe('');
    expect(paragraph.hasAttribute('data-tayamun-font-q7m3')).toBe(false);
    expect(paragraph.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(leftParagraph.style.textAlign).toBe('center');
  });

  it('updates optional styles without rescanning the entire document', async () => {
    document.body.innerHTML = '<p>العربية</p><p>العربية English</p>';
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');

    engine.updateSettings({ enabled: true, alignRight: false, improveFont: true });
    await settle();

    expect(walkerSpy).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>('p')!.hasAttribute('data-tayamun-font-q7m3')).toBe(true);
    expect(document.querySelector<HTMLElement>('p')!.style.fontFamily).toBe('');
    walkerSpy.mockRestore();
  });

  it('ignores irrelevant inline animation styles and reacts to actual visibility changes', async () => {
    document.body.innerHTML = '<p id="target">العربية</p>';
    const scheduler = new FakeScheduler();
    engine = new TayamunDirectionEngine(document, defaults, { scheduler });
    engine.start();
    engine.flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    engine.flush();
    const paragraph = document.querySelector<HTMLElement>('#target')!;
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');

    paragraph.style.transform = 'translateX(10px)';
    paragraph.style.opacity = '0.5';
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(scheduler.pending).toBe(1);
    engine.flush();
    expect(walkerSpy).not.toHaveBeenCalled();

    paragraph.style.opacity = '0';
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(scheduler.pending).toBe(1);
    engine.flush();
    expect(paragraph.style.direction).toBe('');
    walkerSpy.mockRestore();
  });

  it('restores an affected block when its inline display changes to flex', async () => {
    document.body.innerHTML = '<div id="target" style="display: block">العربية <span>English</span></div>';
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    const target = document.querySelector<HTMLElement>('#target')!;
    expect(target.style.direction).toBe('rtl');

    target.style.display = 'flex';
    await settle();
    expect(target.style.direction).toBe('');
  });

  it('does not alter flex containers or blocks that could reorder controls', () => {
    document.body.innerHTML = [
      '<div id="layout" style="display:flex"><span id="first">العربية</span><span id="second">English</span></div>',
      '<p id="control">العربية <button>حفظ</button></p>',
      '<div style="display:flex"><p id="safe">العربية English</p><button>Action</button></div>',
    ].join('');

    const layout = document.querySelector<HTMLElement>('#layout')!;
    const children = [...layout.children];
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();

    expect(layout.style.direction).toBe('');
    expect(document.querySelector<HTMLElement>('#control')!.style.direction).toBe('');
    expect(document.querySelector<HTMLElement>('#safe')!.style.direction).toBe('rtl');
    expect([...layout.children]).toEqual(children);
  });

  it('applies mixed-language direction to the containing block without touching inline markup', () => {
    document.body.innerHTML = [
      '<p id="positive"><strong>mgrep:</strong> بحث بالمعنى داخل المشروع لوكلاء البرمجة</p>',
      '<p id="negative">English text with one كلمة</p>',
    ].join('');
    const positive = document.querySelector<HTMLElement>('#positive')!;
    const negative = document.querySelector<HTMLElement>('#negative')!;
    const inline = positive.querySelector<HTMLElement>('strong')!;

    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();

    expect(positive.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(positive.style.direction).toBe('rtl');
    expect(inline.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(inline.style.direction).toBe('');
    expect(negative.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(negative.style.direction).toBe('');
  });

  it('tracks live text fields while excluding sensitive and non-text inputs', () => {
    document.body.innerHTML = [
      '<input id="text" type="text" placeholder="العربية">',
      '<textarea id="area"></textarea>',
      '<input id="password" type="password" value="العربية">',
      '<input id="email" type="email" value="العربية@example.test">',
      '<input id="url" type="url" value="العربية.test">',
      '<input id="number" type="number" value="123">',
    ].join('');

    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    const input = document.querySelector<HTMLInputElement>('#text')!;
    const area = document.querySelector<HTMLTextAreaElement>('#area')!;

    expect(input.style.direction).toBe('rtl');
    for (const id of ['password', 'email', 'url', 'number']) {
      expect(document.querySelector<HTMLElement>(`#${id}`)!.style.direction).toBe('');
    }

    input.value = 'English العربية';
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    engine.flush();
    expect(input.style.direction).toBe('');

    input.value = 'mgrep: بحث بالمعنى داخل المشروع لوكلاء البرمجة';
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    engine.flush();
    expect(input.style.direction).toBe('rtl');

    area.value = '١٢٣، العربية';
    area.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    engine.flush();
    expect(area.style.direction).toBe('rtl');
  });

  it('observes dynamic content and every discovered open shadow root', async () => {
    const firstHost = document.createElement('first-host');
    const firstRoot = firstHost.attachShadow({ mode: 'open' });
    firstRoot.innerHTML = '<p id="first">العربية</p>';
    document.body.append(firstHost);

    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    const firstParagraph = firstRoot.querySelector<HTMLElement>('#first')!;
    expect(getComputedStyle(firstParagraph).direction).toBe('rtl');

    engine.updateSettings({ enabled: true, alignRight: false, improveFont: true });
    engine.flush();
    expect(firstParagraph.hasAttribute('data-tayamun-font-q7m3')).toBe(true);
    expect(firstParagraph.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(firstRoot.querySelector('[data-tayamun-shadow-style-q7m3]')).not.toBeNull();
    engine.updateSettings({ enabled: true, alignRight: false, improveFont: false });
    engine.flush();
    expect(firstParagraph.hasAttribute('data-tayamun-font-q7m3')).toBe(false);

    const secondHost = document.createElement('second-host');
    const secondRoot = secondHost.attachShadow({ mode: 'open' });
    secondRoot.innerHTML = '<p id="second">العربية</p>';
    document.body.append(secondHost);
    await settle();
    const secondParagraph = secondRoot.querySelector<HTMLElement>('#second')!;
    expect(getComputedStyle(secondParagraph).direction).toBe('rtl');

    secondParagraph.textContent = 'English العربية';
    await settle();
    expect(secondParagraph.style.direction).toBe('');

    const lateHost = document.createElement('late-host');
    document.body.append(lateHost);
    await settle();
    const lateRoot = lateHost.attachShadow({ mode: 'open' });
    lateRoot.innerHTML = '<p id="late">العربية</p>';
    engine.registerOpenShadowRoot(lateRoot);
    engine.flush();
    expect(getComputedStyle(lateRoot.querySelector<HTMLElement>('#late')!).direction).toBe('rtl');

    // A component can replace the root immediately after attachShadow returns;
    // the extension stylesheet must be restored without polling the document.
    lateRoot.innerHTML = '<p id="replaced">العربية بعد الاستبدال</p>';
    await settle();
    expect(lateRoot.querySelector('[data-tayamun-shadow-style-q7m3]')).not.toBeNull();
    expect(getComputedStyle(lateRoot.querySelector<HTMLElement>('#replaced')!).direction).toBe('rtl');
  });

  it('refreshes affected alignment inside an already observed open shadow root', async () => {
    const host = document.createElement('alignment-host');
    host.className = 'page-ltr';
    const shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = [
      '<style>',
      ':host(.page-ltr) p { direction: ltr; text-align: left; }',
      ':host(.page-rtl) p { direction: rtl; text-align: left; }',
      '</style>',
      '<p id="target">العربية</p>',
    ].join('');
    document.body.append(host);
    engine = new TayamunDirectionEngine(document, defaults, { classMutationDebounceMs: 0 });
    engine.start();
    engine.flush();

    const target = shadowRoot.querySelector<HTMLElement>('#target')!;
    expect(target.style.textAlign).toBe('right');

    host.className = 'page-rtl';
    await settle();
    await settle();

    expect(target.style.textAlign).toBe('');
    expect(getComputedStyle(target).textAlign).toBe('left');
  });

  it('propagates a shadow host dir change to affected shadow descendants', async () => {
    const host = document.createElement('direction-host');
    host.dir = 'ltr';
    const shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = [
      '<style>',
      ':host([dir="ltr"]) p { direction: ltr; text-align: left; }',
      ':host([dir="rtl"]) p { direction: rtl; text-align: left; }',
      '</style>',
      '<p id="target">العربية</p>',
    ].join('');
    document.body.append(host);
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();

    const target = shadowRoot.querySelector<HTMLElement>('#target')!;
    expect(target.style.textAlign).toBe('right');

    host.dir = 'rtl';
    await settle();
    await settle();

    expect(target.style.textAlign).toBe('');
    expect(getComputedStyle(target).textAlign).toBe('left');
  });

  it('survives a rapid disable and re-enable during bounded restoration', async () => {
    document.body.innerHTML = Array.from({ length: 100 }, () => '<p>العربية</p>').join('');
    const scheduler = new FakeScheduler();
    engine = new TayamunDirectionEngine(document, defaults, { scheduler });
    engine.start();
    engine.flush();
    const paragraph = document.querySelector<HTMLElement>('p')!;

    engine.updateSettings({ enabled: false, alignRight: false, improveFont: false });
    scheduler.runNext();
    engine.updateSettings({ enabled: true, alignRight: false, improveFont: false });
    engine.flush();

    paragraph.style.setProperty('direction', 'ltr', 'important');
    await settle();
    expect(paragraph.style.direction).toBe('rtl');
    paragraph.textContent = 'English';
    await settle();
    expect(paragraph.style.direction).toBe('ltr');
  });

  it('refreshes retained affected alignment after partial restore and rapid reactivation', () => {
    document.head.innerHTML = '<style>[dir="rtl"] { direction: rtl; }</style>';
    document.body.innerHTML = Array.from(
      { length: 100 },
      () => '<p style="text-align: left">العربية</p>',
    ).join('');
    const scheduler = new FakeScheduler();
    engine = new TayamunDirectionEngine(document, defaults, { scheduler });
    engine.start();
    engine.flush();

    const target = document.querySelectorAll<HTMLElement>('p')[99]!;
    expect(target.style.textAlign).toBe('right');

    engine.updateSettings({ ...defaults, enabled: false });
    scheduler.runNext();
    target.dir = 'rtl';
    engine.updateSettings(defaults);
    engine.flush();

    expect(target.style.textAlign).toBe('left');
    expect(getComputedStyle(target).direction).toBe('rtl');
  });

  it('refreshes exclusions changed while mutation observers are disconnected', () => {
    document.body.innerHTML = '<div id="editor">العربية</div>';
    const editor = document.querySelector<HTMLElement>('#editor')!;
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    expect(editor.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);

    engine.updateSettings({ ...defaults, enabled: false });
    engine.flush();
    editor.className = 'CodeMirror';
    engine.updateSettings(defaults);
    engine.flush();

    expect(editor.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
  });

  it('ignores exact attribute rewrites but rescans serialized class changes', async () => {
    document.body.innerHTML = '<div id="target" class="one two" dir="rtl">العربية</div>';
    engine = new TayamunDirectionEngine(document, defaults, {
      scheduler: new FakeScheduler(),
      classMutationDebounceMs: 0,
    });
    engine.start();
    engine.flush();
    await settle();
    const target = document.querySelector<HTMLElement>('#target')!;
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');

    target.setAttribute('class', 'one two');
    target.setAttribute('dir', 'rtl');
    await settle();
    await settle();
    expect(subtreeScans(walkerSpy, target)).toBe(0);

    // Raw class attribute selectors can distinguish token order and whitespace.
    target.setAttribute('class', 'two  one');
    await settle();
    await settle();
    expect(subtreeScans(walkerSpy, target)).toBe(1);

    target.setAttribute('class', 'one three');
    await settle();
    await settle();
    expect(subtreeScans(walkerSpy, target)).toBe(2);
    walkerSpy.mockRestore();
  });

  it('keeps cosmetic class churn free of marker and style writes, including on an editing host', async () => {
    document.head.innerHTML =
      '<style>[data-tayamun-affected-q7m3] { direction: rtl !important; unicode-bidi: isolate !important; }</style>';
    document.body.innerHTML = [
      '<p id="ordinary">العربية</p>',
      '<div id="host" contenteditable="true">العربية مرحبا</div>',
    ].join('');
    engine = new TayamunDirectionEngine(document, defaults, { classMutationDebounceMs: 0 });
    engine.start();
    engine.flush();
    await settle();

    const ordinary = document.querySelector<HTMLElement>('#ordinary')!;
    const host = document.querySelector<HTMLElement>('#host')!;
    expect(ordinary.style.cssText).toBe('');
    expect(host.style.cssText).toBe('');
    const hostText = host.firstChild!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(hostText, 4);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    const ordinaryRecords: MutationRecord[] = [];
    const hostRecords: MutationRecord[] = [];
    let editorRebuilds = 0;
    const ordinaryObserver = new MutationObserver((records) => ordinaryRecords.push(...records));
    const editorObserver = new MutationObserver((records) => {
      hostRecords.push(...records);
      editorRebuilds += 1;
      host.replaceChildren(document.createTextNode(host.textContent ?? ''));
    });
    const observedAttributes = {
      attributes: true,
      subtree: true,
      attributeFilter: ['data-tayamun-affected-q7m3', 'style'],
    };
    ordinaryObserver.observe(ordinary, observedAttributes);
    editorObserver.observe(host, observedAttributes);
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');

    for (let index = 0; index < 20; index += 1) {
      const className = index % 2 === 0 ? 'focused cosmetic-a' : 'focused cosmetic-b';
      ordinary.className = className;
      host.className = className;
    }
    await settle();
    await settle();
    ordinaryObserver.disconnect();
    editorObserver.disconnect();

    expect(ordinaryRecords).toHaveLength(0);
    expect(hostRecords).toHaveLength(0);
    expect(editorRebuilds).toBe(0);
    expect(selection.anchorNode).toBe(hostText);
    expect(selection.anchorOffset).toBe(4);
    expect(subtreeScans(walkerSpy, host)).toBe(0);
    expect(host.querySelectorAll('[data-tayamun-affected-q7m3], [style]')).toHaveLength(0);
    walkerSpy.mockRestore();
  });

  it('keeps editor input and character data free of extension writes and caret rebuilds', async () => {
    document.head.innerHTML =
      '<style>[data-tayamun-affected-q7m3] { direction: rtl !important; unicode-bidi: isolate !important; }</style>';
    document.body.innerHTML =
      '<div id="host" contenteditable="true">العربية مرحبا</div>';
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    await settle();

    const host = document.querySelector<HTMLElement>('#host')!;
    const hostText = host.firstChild as Text;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(hostText, 4);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    const extensionWrites: MutationRecord[] = [];
    let editorRebuilds = 0;
    const observer = new MutationObserver((records) => {
      extensionWrites.push(...records);
      editorRebuilds += 1;
      host.replaceChildren(document.createTextNode(host.textContent ?? ''));
    });
    observer.observe(host, {
      attributes: true,
      subtree: true,
      attributeFilter: ['data-tayamun-affected-q7m3', 'style'],
    });

    host.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await settle();
    hostText.data = `${hostText.data} `;
    await settle();
    observer.disconnect();

    expect(extensionWrites).toHaveLength(0);
    expect(editorRebuilds).toBe(0);
    expect(selection.anchorNode).toBe(hostText);
    expect(selection.anchorOffset).toBe(4);
    expect(host.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(host.style.cssText).toBe('');
  });

  it('does not expose affected blocks or editing hosts for irrelevant inline style churn', async () => {
    document.head.innerHTML =
      '<style>[data-tayamun-affected-q7m3] { direction: rtl !important; unicode-bidi: isolate !important; }</style>';
    document.body.innerHTML = [
      '<p id="ordinary">العربية</p>',
      '<div id="host" contenteditable="true">العربية مرحبا</div>',
    ].join('');
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    await settle();

    const ordinary = document.querySelector<HTMLElement>('#ordinary')!;
    const host = document.querySelector<HTMLElement>('#host')!;
    const hostText = host.firstChild!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(hostText, 4);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    const markerRecords: MutationRecord[] = [];
    let editorRebuilds = 0;
    const ordinaryObserver = new MutationObserver((records) => markerRecords.push(...records));
    const editorObserver = new MutationObserver((records) => {
      markerRecords.push(...records);
      editorRebuilds += 1;
      host.replaceChildren(document.createTextNode(host.textContent ?? ''));
    });
    const markerOnly = {
      attributes: true,
      subtree: true,
      attributeFilter: ['data-tayamun-affected-q7m3'],
    };
    ordinaryObserver.observe(ordinary, markerOnly);
    editorObserver.observe(host, markerOnly);
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');

    for (let index = 0; index < 20; index += 1) {
      const transform = `translateX(${index}px)`;
      const opacity = index % 2 === 0 ? '0.5' : '0.75';
      ordinary.style.transform = transform;
      ordinary.style.opacity = opacity;
      host.style.transform = transform;
      host.style.opacity = opacity;
    }
    await settle();
    await settle();
    ordinaryObserver.disconnect();
    editorObserver.disconnect();

    expect(markerRecords).toHaveLength(0);
    expect(editorRebuilds).toBe(0);
    expect(selection.anchorNode).toBe(hostText);
    expect(selection.anchorOffset).toBe(4);
    expect(ordinary.style.length).toBe(2);
    expect(host.style.length).toBe(2);
    expect(ordinary.style.transform).toBe('translateX(19px)');
    expect(host.style.opacity).toBe('0.75');
    expect(subtreeScans(walkerSpy, host)).toBe(0);
    expect(host.querySelectorAll('[data-tayamun-affected-q7m3], [style]')).toHaveLength(0);
    walkerSpy.mockRestore();
  });

  it('debounces custom-property alignment exposure instead of writing markers per mutation', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p id="target" style="text-align: left">العربية</p>';
    let clock = 0;
    const scheduler: TayamunWorkScheduler = {
      now: () => clock,
      schedule(callback) {
        const id = setTimeout(callback, 0);
        return () => clearTimeout(id);
      },
    };
    engine = new TayamunDirectionEngine(document, defaults, {
      scheduler,
      classMutationDebounceMs: 1_000,
    });
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    engine.flush();
    await vi.advanceTimersByTimeAsync(0);
    engine.flush();

    const target = document.querySelector<HTMLElement>('#target')!;
    expect(target.style.textAlign).toBe('right');
    const markerRecords: MutationRecord[] = [];
    const observer = new MutationObserver((records) => markerRecords.push(...records));
    observer.observe(target, {
      attributes: true,
      attributeFilter: ['data-tayamun-affected-q7m3'],
    });

    for (let index = 0; index < 60; index += 1) {
      target.style.setProperty('--animation-progress', String(index));
      clock += 20;
      await vi.advanceTimersByTimeAsync(20);
      engine.flush();
    }
    await Promise.resolve();
    expect(markerRecords).toHaveLength(0);

    clock += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    engine.flush();
    await Promise.resolve();
    expect(markerRecords).toHaveLength(2);
    expect(target.style.textAlign).toBe('right');
    observer.disconnect();
  });

  it('rescans a class-churning subtree at a bounded, self-throttling interval', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="target">العربية</div>';
    let clock = 0;
    const scheduler: TayamunWorkScheduler = {
      now: () => clock,
      schedule(callback) {
        const id = setTimeout(callback, 0);
        return () => clearTimeout(id);
      },
    };
    engine = new TayamunDirectionEngine(document, defaults, {
      scheduler,
      classMutationDebounceMs: 100,
    });
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    engine.flush();

    const target = document.querySelector<HTMLElement>('#target')!;
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');
    const scanTimes: number[] = [];
    const churn = async (steps: number): Promise<void> => {
      for (let step = 0; step < steps; step += 1) {
        target.setAttribute('class', `tick-${clock}`);
        clock += 50;
        await vi.advanceTimersByTimeAsync(50);
        engine!.flush();
        while (scanTimes.length < subtreeScans(walkerSpy, target)) scanTimes.push(clock);
      }
    };

    // Rewrites arrive faster than the debounce: a reset-only timer would never fire.
    await churn(4);
    expect(scanTimes).toEqual([]);

    await churn(56);
    expect(scanTimes.length).toBeGreaterThan(0);
    const gaps = scanTimes.map((time, index) => (index === 0 ? time : time - scanTimes[index - 1]!));
    expect(gaps.at(-1)!).toBeGreaterThan(gaps[0]!);
    expect(target.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    walkerSpy.mockRestore();
  });

  it('backs off a quiet churning subtree despite membership changes in a disjoint sibling', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="quiet">العربية</div><div id="changing">العربية</div>';
    let clock = 0;
    const scheduler: TayamunWorkScheduler = {
      now: () => clock,
      schedule(callback) {
        const id = setTimeout(callback, 0);
        return () => clearTimeout(id);
      },
    };
    engine = new TayamunDirectionEngine(document, defaults, {
      scheduler,
      classMutationDebounceMs: 100,
    });
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    engine.flush();

    const quiet = document.querySelector<HTMLElement>('#quiet')!;
    const changing = document.querySelector<HTMLElement>('#changing')!;
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');
    const quietScanTimes: number[] = [];
    let changingIsArabic = true;
    for (let step = 0; step < 120; step += 1) {
      quiet.className = `tick-${clock}`;
      if ((step + 1) % 4 === 0) {
        changingIsArabic = !changingIsArabic;
        changing.textContent = changingIsArabic ? 'العربية' : 'English';
      }
      clock += 50;
      await vi.advanceTimersByTimeAsync(50);
      engine.flush();
      while (quietScanTimes.length < subtreeScans(walkerSpy, quiet)) {
        quietScanTimes.push(clock);
      }
    }

    const gaps = quietScanTimes.slice(1).map((time, index) => time - quietScanTimes[index]!);
    expect(gaps.some((gap) => gap >= 800)).toBe(true);
    expect(gaps.at(-1)!).toBeGreaterThan(gaps[0]!);
    walkerSpy.mockRestore();
  });

  it('routes native text controls inside rich editors as independent live fields', async () => {
    document.body.innerHTML = [
      '<div id="host" contenteditable="true">',
      '<input id="input" value="English">',
      '<textarea id="area">English</textarea>',
      '</div>',
    ].join('');
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();

    const host = document.querySelector<HTMLElement>('#host')!;
    const input = document.querySelector<HTMLInputElement>('#input')!;
    const area = document.querySelector<HTMLTextAreaElement>('#area')!;
    input.value = 'البحث باللغة العربية';
    area.value = 'كتابة ملاحظة باللغة العربية';
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    area.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    engine.flush();

    expect(input.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(area.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(host.querySelectorAll('[data-tayamun-affected-q7m3]')).toHaveLength(2);

    input.value = 'English';
    area.value = 'English';
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    area.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    engine.flush();

    expect(input.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(area.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
  });

  it('restores an affected nested text input when its type becomes password', async () => {
    document.body.innerHTML =
      '<div contenteditable="true"><input id="field" value="البحث باللغة العربية"></div>';
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    await settle();

    const field = document.querySelector<HTMLInputElement>('#field')!;
    expect(field.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);

    field.type = 'password';
    await settle();

    expect(field.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(field.style.direction).toBe('');
  });

  it('discovers independent fields in an added editor subtree without walking ordinary blocks', async () => {
    document.body.innerHTML = '<div id="host" contenteditable="true">English</div>';
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();

    const host = document.querySelector<HTMLElement>('#host')!;
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');
    const wrapper = document.createElement('section');
    wrapper.innerHTML = [
      '<p><span>ordinary editor rewrite</span></p>',
      '<div><input id="added-input" value="البحث باللغة العربية"></div>',
      '<div contenteditable="false">',
      '<article id="added-host" contenteditable="true">كتابة باللغة العربية</article>',
      '</div>',
    ].join('');
    host.append(wrapper);
    await settle();

    const input = wrapper.querySelector<HTMLInputElement>('#added-input')!;
    const nestedHost = wrapper.querySelector<HTMLElement>('#added-host')!;
    expect(input.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(nestedHost.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(wrapper.querySelector('p')!.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(subtreeScans(walkerSpy, wrapper)).toBe(0);
    walkerSpy.mockRestore();
  });

  it('slices and completes discovery for one huge editor insertion', async () => {
    document.body.innerHTML = '<div id="host" contenteditable="true">English</div>';
    const scheduler = new FakeScheduler();
    engine = new TayamunDirectionEngine(document, defaults, {
      scheduler,
      maxStepsPerSlice: 1,
    });
    engine.start();
    engine.flush();
    await settle();

    const host = document.querySelector<HTMLElement>('#host')!;
    const wrapper = document.createElement('section');
    for (let index = 0; index < 10_000; index += 1) {
      wrapper.append(document.createElement('span'));
    }
    const selectorSpy = vi.spyOn(wrapper, 'querySelectorAll');
    const testEngine = engine as unknown as {
      processEditorMutationNode(
        node: Node,
        removing: boolean,
        enqueueRemovedRoot: (root: Node) => void,
      ): void;
    };
    const visitSpy = vi.spyOn(testEngine, 'processEditorMutationNode');

    host.append(wrapper);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (let slice = 0; slice < 12; slice += 1) {
      const callsBefore = visitSpy.mock.calls.length;
      scheduler.runNext();
      expect(visitSpy.mock.calls.length - callsBefore).toBeLessThanOrEqual(1);
    }
    engine.flush();

    expect(visitSpy.mock.calls.length).toBe(10_001);
    expect(selectorSpy).not.toHaveBeenCalled();
    visitSpy.mockRestore();
    selectorSpy.mockRestore();
  });

  it('discovers an independent field after more than 512 inert added descendants', async () => {
    document.body.innerHTML = '<div id="host" contenteditable="true">English</div>';
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    await settle();

    const wrapper = document.createElement('section');
    wrapper.innerHTML = [
      ...Array.from({ length: 600 }, () => '<span>ordinary</span>'),
      '<div contenteditable="false">',
      '<p id="last-field" contenteditable="true">كتابة باللغة العربية</p>',
      '</div>',
    ].join('');
    document.querySelector<HTMLElement>('#host')!.append(wrapper);
    await settle();

    expect(
      wrapper
        .querySelector<HTMLElement>('#last-field')!
        .hasAttribute('data-tayamun-affected-q7m3'),
    ).toBe(true);
  });

  it('keeps ordinary editor removal local with ten thousand unrelated affected nodes', async () => {
    document.body.innerHTML =
      '<div id="host" contenteditable="true"><span id="removed">ordinary</span></div>';
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    await settle();

    const affected: Set<HTMLElement> = Reflect.get(engine, 'affected');
    for (let index = 0; index < 10_000; index += 1) {
      affected.add(document.createElement('p'));
    }
    const removed = document.querySelector<HTMLElement>('#removed')!;
    const containsSpy = vi.spyOn(removed, 'contains');
    const testEngine = engine as unknown as {
      processEditorMutationNode(
        node: Node,
        removing: boolean,
        enqueueRemovedRoot: (root: Node) => void,
      ): void;
    };
    const visitSpy = vi.spyOn(testEngine, 'processEditorMutationNode');

    removed.remove();
    await settle();

    expect(visitSpy.mock.calls.filter((call) => call[1]).length).toBe(1);
    expect(containsSpy).not.toHaveBeenCalled();
    affected.clear();
    visitSpy.mockRestore();
    containsSpy.mockRestore();
  });

  it('discovers a new field independently of a large removed editor subtree', async () => {
    document.body.innerHTML = [
      '<div id="host" contenteditable="true">',
      '<section id="old">',
      ...Array.from({ length: 600 }, () => '<span>ordinary</span>'),
      '</section>',
      '</div>',
    ].join('');
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    await settle();

    const input = document.createElement('input');
    input.value = 'البحث باللغة العربية';
    document.querySelector<HTMLElement>('#host')!.replaceChildren(input);
    await settle();

    expect(input.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
  });

  it('restores an owned nested host beyond one removal traversal window', async () => {
    document.body.innerHTML = [
      '<div id="host" contenteditable="true">',
      '<section id="removed">',
      ...Array.from({ length: 600 }, () => '<span>ordinary</span>'),
      '<div contenteditable="false">',
      '<p id="nested" contenteditable="true">كتابة باللغة العربية</p>',
      '</div>',
      '</section>',
      '</div>',
    ].join('');
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    await settle();

    const removed = document.querySelector<HTMLElement>('#removed')!;
    const nested = document.querySelector<HTMLElement>('#nested')!;
    expect(nested.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);

    removed.remove();
    await settle();

    expect(nested.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
  });

  it('abandons a sliced removal immediately when its editor subtree reconnects', async () => {
    document.body.innerHTML = [
      '<div id="host" contenteditable="true">',
      '<section id="wrapper">',
      ...Array.from({ length: 40 }, () => '<span>ordinary</span>'),
      '<div contenteditable="false">',
      '<p id="nested" contenteditable="true">كتابة باللغة العربية</p>',
      '</div>',
      '</section>',
      '</div>',
    ].join('');
    const scheduler = new FakeScheduler();
    engine = new TayamunDirectionEngine(document, defaults, {
      scheduler,
      maxStepsPerSlice: 1,
    });
    engine.start();
    engine.flush();
    await settle();

    const host = document.querySelector<HTMLElement>('#host')!;
    const wrapper = document.querySelector<HTMLElement>('#wrapper')!;
    const nested = document.querySelector<HTMLElement>('#nested')!;
    const markerRemoveSpy = vi.spyOn(nested, 'removeAttribute');
    const testEngine = engine as unknown as {
      processEditorMutationNode(
        node: Node,
        removing: boolean,
        enqueueRemovedRoot: (root: Node) => void,
      ): void;
    };
    const visitSpy = vi.spyOn(testEngine, 'processEditorMutationNode');

    wrapper.remove();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (let slice = 0; slice < 40; slice += 1) {
      scheduler.runNext();
      const removalVisits = visitSpy.mock.calls.filter((call) => call[1]);
      if (removalVisits.length >= 4) break;
    }
    expect(visitSpy.mock.calls.some((call) => call[0] === nested && call[1])).toBe(false);

    host.append(wrapper);
    await settle();

    expect(nested.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(markerRemoveSpy).not.toHaveBeenCalledWith('data-tayamun-affected-q7m3');
    visitSpy.mockRestore();
    markerRemoveSpy.mockRestore();
  });

  it('registers a prebuilt open shadow root added below an existing editor', async () => {
    document.body.innerHTML = '<div id="host" contenteditable="true">English</div>';
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    await settle();

    const component = document.createElement('dynamic-editor');
    const shadowRoot = component.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = [
      '<div contenteditable="false">',
      '<p id="shadow-field" contenteditable="true">كتابة باللغة العربية</p>',
      '</div>',
    ].join('');
    document.querySelector<HTMLElement>('#host')!.append(component);
    await settle();

    expect(
      shadowRoot
        .querySelector<HTMLElement>('#shadow-field')!
        .hasAttribute('data-tayamun-affected-q7m3'),
    ).toBe(true);
    expect(shadowRoot.querySelector('[data-tayamun-shadow-style-q7m3]')).not.toBeNull();
  });

  it('migrates nested editing hosts in both contenteditable topology directions', async () => {
    document.body.innerHTML = [
      '<div id="outer" contenteditable="true">النص العربي',
      '<div id="island" contenteditable="false">',
      '<article id="nested" contenteditable="true">كتابة باللغة العربية</article>',
      '</div>',
      '</div>',
    ].join('');
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();

    const outer = document.querySelector<HTMLElement>('#outer')!;
    const island = document.querySelector<HTMLElement>('#island')!;
    const nested = document.querySelector<HTMLElement>('#nested')!;
    expect(nested.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);

    island.removeAttribute('contenteditable');
    await settle();

    expect(outer.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(nested.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);

    island.setAttribute('contenteditable', 'false');
    await settle();

    expect(nested.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
  });


  it('cascades an outer direction refresh through an unaffected nested editing host', async () => {
    document.head.innerHTML = [
      '<style>',
      '#outer[dir="ltr"] #field { direction: ltr; }',
      '#outer[dir="rtl"] #field { direction: rtl; }',
      '</style>',
    ].join('');
    document.body.innerHTML = [
      '<div id="outer" dir="ltr" contenteditable="true">',
      '<div contenteditable="false">',
      '<p id="nested" contenteditable="true">',
      '<input id="field" style="text-align: left" value="البحث باللغة العربية">',
      '</p>',
      '</div>',
      '</div>',
    ].join('');
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    await settle();

    const outer = document.querySelector<HTMLElement>('#outer')!;
    const nested = document.querySelector<HTMLElement>('#nested')!;
    const field = document.querySelector<HTMLInputElement>('#field')!;
    expect(nested.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(field.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(field.style.textAlign).toBe('right');

    outer.dir = 'rtl';
    await settle();

    expect(getComputedStyle(field).direction).toBe('rtl');
    expect(field.style.textAlign).toBe('left');
  });

  it('reveals a tracked hidden nested field from an outer editor style alone', async () => {
    document.body.innerHTML = [
      '<div id="outer" style="display: none" contenteditable="true">',
      '<div contenteditable="false">',
      '<p contenteditable="true">',
      '<input id="field" style="text-align: left" value="البحث باللغة العربية">',
      '</p>',
      '</div>',
      '</div>',
    ].join('');
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    await settle();

    const outer = document.querySelector<HTMLElement>('#outer')!;
    const field = document.querySelector<HTMLInputElement>('#field')!;
    const registry: WeakMap<HTMLElement, Set<HTMLElement>> = Reflect.get(
      engine,
      'independentEditorFields',
    );
    expect(registry.get(outer)?.has(field)).toBe(true);
    expect(field.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');

    outer.style.display = 'block';
    await settle();

    expect(subtreeScans(walkerSpy, outer)).toBe(0);
    expect(field.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(field.style.textAlign).toBe('right');
    walkerSpy.mockRestore();
  });

  it('resets independent field registries across disabled editor rebuilds', async () => {
    document.body.innerHTML = [
      '<div id="outer" contenteditable="true"><div contenteditable="false">',
      '<p contenteditable="true"><input id="old-field" value="البحث باللغة العربية"></p>',
      '</div></div>',
    ].join('');
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    await settle();

    const outer = document.querySelector<HTMLElement>('#outer')!;
    const oldField = document.querySelector<HTMLInputElement>('#old-field')!;
    const oldRegistry: WeakMap<HTMLElement, Set<HTMLElement>> = Reflect.get(
      engine,
      'independentEditorFields',
    );
    expect(oldRegistry.get(outer)?.has(oldField)).toBe(true);

    engine.updateSettings({ ...defaults, enabled: false });
    engine.flush();
    const disabledRegistry: WeakMap<HTMLElement, Set<HTMLElement>> = Reflect.get(
      engine,
      'independentEditorFields',
    );
    expect(disabledRegistry).not.toBe(oldRegistry);
    expect(disabledRegistry.get(outer)).toBeUndefined();

    outer.innerHTML =
      '<div contenteditable="false"><p contenteditable="true"><input id="new-field" value="كتابة باللغة العربية"></p></div>';
    engine.updateSettings(defaults);
    engine.flush();
    await settle();

    const newField = document.querySelector<HTMLInputElement>('#new-field')!;
    const newRegistry: WeakMap<HTMLElement, Set<HTMLElement>> = Reflect.get(
      engine,
      'independentEditorFields',
    );
    expect(newRegistry.get(outer)?.has(oldField)).not.toBe(true);
    expect(newRegistry.get(outer)?.has(newField)).toBe(true);
    expect(oldField.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(newField.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
  });

  it('forgets repeatedly removed unaffected native fields from an editor registry', async () => {
    document.body.innerHTML = '<div id="outer" contenteditable="true"></div>';
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    await settle();

    const outer = document.querySelector<HTMLElement>('#outer')!;
    for (let index = 0; index < 20; index += 1) {
      const field = document.createElement('input');
      field.value = 'English';
      outer.append(field);
      await settle();
      field.remove();
      await settle();
    }
    const registry: WeakMap<HTMLElement, Set<HTMLElement>> = Reflect.get(
      engine,
      'independentEditorFields',
    );
    expect(registry.get(outer)?.size ?? 0).toBe(0);
  });

  it('restores tracked fields across an outer code-editor transition', async () => {
    document.body.innerHTML = [
      '<div id="outer" contenteditable="true"><div contenteditable="false">',
      '<p id="nested" contenteditable="true">كتابة باللغة العربية</p>',
      '<input id="field" value="البحث باللغة العربية">',
      '</div></div>',
    ].join('');
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    await settle();

    const outer = document.querySelector<HTMLElement>('#outer')!;
    const nested = document.querySelector<HTMLElement>('#nested')!;
    const field = document.querySelector<HTMLInputElement>('#field')!;
    expect(nested.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(field.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);

    outer.dataset.codeEditor = '';
    await settle();
    expect(nested.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(field.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    const registry: WeakMap<HTMLElement, Set<HTMLElement>> = Reflect.get(
      engine,
      'independentEditorFields',
    );
    expect(registry.get(outer)?.has(nested)).toBe(true);
    expect(registry.get(outer)?.has(field)).toBe(true);
  });

  it('registers one pending definition across reinsertion and activation cycles', async () => {
    document.body.innerHTML = '<div id="outer" contenteditable="true"></div>';
    const whenDefinedSpy = vi.spyOn(customElements, 'whenDefined');
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    await settle();

    const outer = document.querySelector<HTMLElement>('#outer')!;
    const custom = document.createElement('never-defined-editor-q7m3');
    for (let cycle = 0; cycle < 5; cycle += 1) {
      outer.append(custom);
      await settle();
      custom.remove();
      await settle();
    }
    outer.append(custom);
    await settle();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      engine.updateSettings({ ...defaults, enabled: false });
      engine.flush();
      engine.updateSettings(defaults);
      engine.flush();
      await settle();
    }

    expect(
      whenDefinedSpy.mock.calls.filter((call) => call[0] === 'never-defined-editor-q7m3'),
    ).toHaveLength(1);
    whenDefinedSpy.mockRestore();
  });

  it('cleans rejected reserved custom-element definition tracking', async () => {
    document.body.innerHTML = '<div id="outer" contenteditable="true"></div>';
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    await settle();

    const reserved = document.createElement('font-face');
    document.querySelector<HTMLElement>('#outer')!.append(reserved);
    await settle();
    await Promise.resolve();

    const tracked: Set<Element> = Reflect.get(engine, 'trackedCustomElements');
    expect(tracked.has(reserved)).toBe(false);
  });

  it('debounces editor-host custom properties without scanning internals and refreshes nested hosts', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = [
      '<div id="outer" style="--nested-direction: ltr" contenteditable="true">النص العربي',
      '<div contenteditable="false">',
      '<p id="nested" style="direction: var(--nested-direction) !important; text-align: left" contenteditable="true">كتابة باللغة العربية</p>',
      '</div>',
      '</div>',
    ].join('');
    let clock = 0;
    const scheduler: TayamunWorkScheduler = {
      now: () => clock,
      schedule(callback) {
        const id = setTimeout(callback, 0);
        return () => clearTimeout(id);
      },
    };
    engine = new TayamunDirectionEngine(document, defaults, {
      scheduler,
      classMutationDebounceMs: 150,
    });
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    engine.flush();
    await vi.advanceTimersByTimeAsync(0);
    engine.flush();

    const outer = document.querySelector<HTMLElement>('#outer')!;
    const nested = document.querySelector<HTMLElement>('#nested')!;
    expect(nested.style.textAlign).toBe('right');
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');
    const extensionRecords: MutationRecord[] = [];
    let frameworkRenders = 0;
    const observer = new MutationObserver((records) => {
      extensionRecords.push(...records);
      frameworkRenders += 1;
    });
    observer.observe(nested, {
      attributes: true,
      attributeFilter: ['data-tayamun-affected-q7m3', 'style'],
    });

    for (let index = 0; index < 60; index += 1) {
      outer.style.setProperty('--unused-animation-value', String(index));
      clock += 20;
      await vi.advanceTimersByTimeAsync(20);
      engine.flush();
    }
    await Promise.resolve();
    expect(extensionRecords).toHaveLength(0);
    expect(frameworkRenders).toBe(0);

    outer.style.setProperty('--nested-direction', 'rtl');
    clock += 20;
    await vi.advanceTimersByTimeAsync(20);
    engine.flush();
    expect(extensionRecords).toHaveLength(0);

    clock += 150;
    await vi.advanceTimersByTimeAsync(150);
    engine.flush();
    await Promise.resolve();

    expect(subtreeScans(walkerSpy, outer)).toBe(0);
    expect(
      extensionRecords.filter(
        (record) => record.attributeName === 'data-tayamun-affected-q7m3',
      ),
    ).toHaveLength(2);
    expect(extensionRecords.length).toBeLessThanOrEqual(6);
    expect(frameworkRenders).toBe(1);
    expect(nested.style.textAlign).toBe('left');
    expect(getComputedStyle(nested).direction).toBe('rtl');
    expect(getComputedStyle(nested).textAlign).toBe('left');
    observer.disconnect();
    walkerSpy.mockRestore();
  });

  it('restores removed nested fields and disconnects their observed open shadow roots', async () => {
    document.body.innerHTML = [
      '<div id="outer" contenteditable="true">',
      '<div id="island" contenteditable="false">',
      '<article id="nested" contenteditable="true">كتابة باللغة العربية</article>',
      '<removed-editor id="component"></removed-editor>',
      '</div>',
      '</div>',
    ].join('');
    const component = document.querySelector<HTMLElement>('#component')!;
    const shadowRoot = component.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML =
      '<p id="shadow-text" contenteditable="true">كتابة باللغة العربية</p>';
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();

    const island = document.querySelector<HTMLElement>('#island')!;
    const nested = document.querySelector<HTMLElement>('#nested')!;
    const shadowText = shadowRoot.querySelector<HTMLElement>('#shadow-text')!;
    expect(nested.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(shadowText.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(shadowRoot.querySelector('[data-tayamun-shadow-style-q7m3]')).not.toBeNull();
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');

    island.remove();
    await settle();

    expect(nested.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(shadowText.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(shadowRoot.querySelector('[data-tayamun-shadow-style-q7m3]')).toBeNull();
    expect(subtreeScans(walkerSpy, island)).toBe(0);
    expect(subtreeScans(walkerSpy, component)).toBe(0);

    shadowRoot.innerHTML = '<p id="after-removal">نص عربي جديد</p>';
    await settle();
    expect(
      shadowRoot.querySelector<HTMLElement>('#after-removal')!.hasAttribute(
        'data-tayamun-affected-q7m3',
      ),
    ).toBe(false);
    walkerSpy.mockRestore();
  });

  it('leaves the DOM an editor rebuilds untouched while keeping its host fixed', async () => {
    document.body.innerHTML =
      '<div id="host" contenteditable="true"><p><span>العربية</span></p></div>';
    engine = new TayamunDirectionEngine(document, defaults, { scheduler: new FakeScheduler() });
    engine.start();
    engine.flush();
    await settle();

    const host = document.querySelector<HTMLElement>('#host')!;
    expect(host.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(host.querySelectorAll('[data-tayamun-affected-q7m3]').length).toBe(0);

    // Replaying what a reconciler does on every keystroke: the block is rebuilt.
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');
    const paragraph = document.createElement('p');
    const span = document.createElement('span');
    span.textContent = 'العربية مرحبا';
    paragraph.append(span);
    host.replaceChildren(paragraph);
    await settle();

    // Marking or scanning the rebuilt block is what makes an editor reconcile
    // again, so neither may happen.
    expect(host.querySelectorAll('[data-tayamun-affected-q7m3]').length).toBe(0);
    expect(subtreeScans(walkerSpy, paragraph)).toBe(0);
    expect(subtreeScans(walkerSpy, span)).toBe(0);
    expect(host.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    walkerSpy.mockRestore();
  });

  it('refreshes editor text facts without scanning or marking rebuilt descendants', async () => {
    document.body.innerHTML =
      '<div id="host" contenteditable="true"><span id="lead">English</span><span>العربية</span></div>';
    const host = document.querySelector<HTMLElement>('#host')!;
    const lead = document.querySelector<HTMLElement>('#lead')!;
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    expect(host.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');

    lead.style.display = 'none';
    await settle();

    expect(host.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(host.querySelectorAll('[data-tayamun-affected-q7m3]')).toHaveLength(0);
    expect(subtreeScans(walkerSpy, host)).toBe(0);
    walkerSpy.mockRestore();
  });

  it('moves a live editor host into and out of the mixed-language verdict without touching its subtree', async () => {
    document.body.innerHTML =
      '<div id="host" contenteditable="true">English text with one كلمة</div>';
    const host = document.querySelector<HTMLElement>('#host')!;
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();

    expect(host.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(host.style.direction).toBe('');
    expect(host.querySelectorAll('[data-tayamun-affected-q7m3]')).toHaveLength(0);
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');

    host.innerHTML = 'JavaScript<br>في<br>نص<br>عربي';
    await settle();

    expect(host.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(host.style.direction).toBe('rtl');
    expect(host.querySelectorAll('[data-tayamun-affected-q7m3]')).toHaveLength(0);
    expect(subtreeScans(walkerSpy, host)).toBe(0);

    host.textContent = 'API العربية';
    await settle();

    expect(host.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(host.style.direction).toBe('');
    expect(host.querySelectorAll('[data-tayamun-affected-q7m3]')).toHaveLength(0);
    expect(subtreeScans(walkerSpy, host)).toBe(0);
    walkerSpy.mockRestore();
  });

  it('re-evaluates moved editor content against its new host', async () => {
    document.body.innerHTML = [
      '<div id="first" contenteditable="true"><span id="text">العربية</span></div>',
      '<div id="second" contenteditable="true"></div>',
    ].join('');
    const first = document.querySelector<HTMLElement>('#first')!;
    const second = document.querySelector<HTMLElement>('#second')!;
    const text = document.querySelector<HTMLElement>('#text')!;
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    expect(first.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);

    second.append(text);
    await settle();

    expect(first.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(second.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(second.querySelectorAll('[data-tayamun-affected-q7m3]')).toHaveLength(0);
  });

  it('keeps host class churn and code-editor transitions out of editor internals', async () => {
    document.body.innerHTML = [
      '<div id="host" contenteditable="true"><p>العربية</p><p>سطر ثان</p></div>',
      '<div id="wrapper"><p id="line">العربية</p></div>',
    ].join('');
    const host = document.querySelector<HTMLElement>('#host')!;
    const wrapper = document.querySelector<HTMLElement>('#wrapper')!;
    const line = document.querySelector<HTMLElement>('#line')!;
    engine = new TayamunDirectionEngine(document, defaults, { classMutationDebounceMs: 0 });
    engine.start();
    engine.flush();
    expect(line.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    const walkerSpy = vi.spyOn(document, 'createTreeWalker');

    host.className = 'focused';
    wrapper.setAttribute('data-code-editor', '');
    await settle();
    await settle();

    expect(subtreeScans(walkerSpy, host)).toBe(0);
    expect(host.querySelectorAll('[data-tayamun-affected-q7m3]')).toHaveLength(0);
    expect(line.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    walkerSpy.mockRestore();
  });

  it('corrects physical left only for a flip and releases it when page alignment changes', async () => {
    document.head.innerHTML =
      '<style>[dir="ltr"] { direction: ltr; } [dir="rtl"] { direction: rtl; } .review-left { direction: ltr; text-align: left; } .review-native-left { direction: rtl; text-align: left; } .review-center { text-align: center; }</style>';
    document.body.innerHTML = [
      '<p id="left" style="text-align: left">العربية English</p>',
      '<p id="centered" style="text-align: center">العربية</p>',
      '<p id="plain">العربية</p>',
      '<p id="native" style="direction: rtl; text-align: left">العربية</p>',
      '<p id="dynamic" class="review-left">العربية</p>',
    ].join('');
    engine = new TayamunDirectionEngine(document, defaults, { classMutationDebounceMs: 0 });
    engine.start();
    engine.flush();

    const left = document.querySelector<HTMLElement>('#left')!;
    const centered = document.querySelector<HTMLElement>('#centered')!;
    const plain = document.querySelector<HTMLElement>('#plain')!;
    const native = document.querySelector<HTMLElement>('#native')!;
    const dynamic = document.querySelector<HTMLElement>('#dynamic')!;

    // alignRight is off: this is not that preference, it only corrects a physical
    // keyword when Tayamun actually changed the block from LTR to RTL.
    expect(left.style.getPropertyValue('text-align')).toBe('right');
    expect(left.style.getPropertyPriority('text-align')).toBe('important');
    expect(centered.style.textAlign).toBe('center');
    expect(plain.style.textAlign).toBe('');
    expect(native.style.textAlign).toBe('left');
    expect(dynamic.style.textAlign).toBe('right');

    dynamic.className = 'review-center';
    await settle();
    await settle();
    expect(dynamic.style.textAlign).toBe('');
    expect(getComputedStyle(dynamic).textAlign).toBe('center');

    dynamic.className = 'review-native-left';
    await settle();
    await settle();
    expect(dynamic.style.textAlign).toBe('');
    expect(getComputedStyle(dynamic).textAlign).toBe('left');

    dynamic.className = 'review-left';
    await settle();
    await settle();
    expect(dynamic.style.textAlign).toBe('right');

    dynamic.style.cssText = 'direction: rtl; text-align: left';
    await settle();
    expect(dynamic.style.textAlign).toBe('left');
    dynamic.style.cssText = 'direction: ltr; text-align: left';
    await settle();
    expect(dynamic.style.textAlign).toBe('right');

    left.dir = 'rtl';
    await settle();
    expect(left.style.textAlign).toBe('left');
    left.dir = 'ltr';
    await settle();
    expect(left.style.textAlign).toBe('right');

    engine.updateSettings({ enabled: false, alignRight: false, improveFont: false });
    engine.flush();
    expect(left.style.textAlign).toBe('left');
    expect(native.style.textAlign).toBe('left');
  });

  it('keeps computed CSS direction authoritative over a conflicting dir attribute', async () => {
    document.body.innerHTML =
      '<p id="target" dir="rtl" style="direction: ltr !important; text-align: left">العربية</p>';
    engine = new TayamunDirectionEngine(document, defaults, { classMutationDebounceMs: 0 });
    engine.start();
    engine.flush();

    const target = document.querySelector<HTMLElement>('#target')!;
    expect(target.style.textAlign).toBe('right');

    target.className = 'cosmetic';
    await settle();
    await settle();

    expect(target.style.direction).toBe('rtl');
    expect(target.style.textAlign).toBe('right');
  });

  it('refreshes affected descendants when a parent class changes inherited alignment', async () => {
    document.head.innerHTML =
      '<style>.inherited-left { text-align: left; } .inherited-center { text-align: center; }</style>';
    document.body.innerHTML =
      '<section id="parent" class="inherited-left"><p id="child">العربية</p></section>';
    engine = new TayamunDirectionEngine(document, defaults, { classMutationDebounceMs: 0 });
    engine.start();
    engine.flush();

    const parent = document.querySelector<HTMLElement>('#parent')!;
    const child = document.querySelector<HTMLElement>('#child')!;
    expect(child.style.textAlign).toBe('right');

    parent.className = 'inherited-center';
    await settle();
    await settle();
    expect(child.style.textAlign).toBe('');
    expect(getComputedStyle(child).textAlign).toBe('center');

    parent.className = 'inherited-left';
    await settle();
    await settle();
    expect(child.style.textAlign).toBe('right');
  });

  it('refreshes owned alignment after a resize style epoch without touching unrelated markers', async () => {
    document.head.innerHTML = [
      '<style id="responsive">',
      '.responsive { direction: ltr; text-align: left; }',
      '[data-tayamun-affected-q7m3] { direction: rtl !important; unicode-bidi: isolate !important; }',
      '</style>',
    ].join('');
    document.body.innerHTML = [
      '<p id="changing" class="responsive">العربية</p>',
      '<p id="stable" style="direction: rtl">العربية</p>',
    ].join('');
    engine = new TayamunDirectionEngine(document, defaults, { classMutationDebounceMs: 0 });
    engine.start();
    engine.flush();
    await settle();

    const changing = document.querySelector<HTMLElement>('#changing')!;
    const stable = document.querySelector<HTMLElement>('#stable')!;
    expect(changing.style.textAlign).toBe('right');
    const stableMarkerRecords: MutationRecord[] = [];
    const observer = new MutationObserver((records) => stableMarkerRecords.push(...records));
    observer.observe(stable, {
      attributes: true,
      attributeFilter: ['data-tayamun-affected-q7m3'],
    });

    const stylesheet = document.querySelector<HTMLStyleElement>('#responsive')!;
    stylesheet.textContent =
      '.responsive { direction: rtl; text-align: left; } [data-tayamun-affected-q7m3] { direction: rtl !important; unicode-bidi: isolate !important; }';
    window.dispatchEvent(new Event('resize'));
    await settle();
    await settle();

    expect(changing.style.textAlign).toBe('');
    expect(getComputedStyle(changing).textAlign).toBe('left');
    expect(stableMarkerRecords).toHaveLength(0);
    observer.disconnect();
  });

  it('refreshes owned alignment when a stylesheet load exposes a new page direction', async () => {
    document.head.innerHTML =
      '<style id="loaded">.loaded { direction: ltr; text-align: left; }</style>';
    document.body.innerHTML = '<p id="target" class="loaded">العربية</p>';
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();

    const target = document.querySelector<HTMLElement>('#target')!;
    expect(target.style.textAlign).toBe('right');
    const stylesheet = document.querySelector<HTMLStyleElement>('#loaded')!;
    stylesheet.textContent = '.loaded { direction: rtl; text-align: left; }';
    stylesheet.dispatchEvent(new Event('load', { bubbles: true }));
    await settle();

    expect(target.style.textAlign).toBe('');
    expect(getComputedStyle(target).textAlign).toBe('left');
  });

  it('refreshes owned alignment when stylesheet text is replaced', async () => {
    document.head.innerHTML =
      '<style id="rules">.rule-target { direction: ltr; text-align: left; }</style>';
    document.body.innerHTML = '<p id="target" class="rule-target">العربية</p>';
    engine = new TayamunDirectionEngine(document, defaults, { classMutationDebounceMs: 0 });
    engine.start();
    engine.flush();

    const target = document.querySelector<HTMLElement>('#target')!;
    expect(target.style.textAlign).toBe('right');
    document.querySelector<HTMLStyleElement>('#rules')!.textContent =
      '.rule-target { direction: rtl; text-align: left; }';
    await settle();
    await settle();

    expect(target.style.textAlign).toBe('');
    expect(getComputedStyle(target).textAlign).toBe('left');
  });

  it('refreshes style facts for character data and input after CSSOM and focus changes', async () => {
    document.head.innerHTML = '<style>#focus-target:focus { display: flex; }</style>';
    document.body.innerHTML = [
      '<div id="cssom-target">العربية</div>',
      '<div id="focus-target" contenteditable="true">العربية</div>',
    ].join('');
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();

    const cssomTarget = document.querySelector<HTMLElement>('#cssom-target')!;
    const focusTarget = document.querySelector<HTMLElement>('#focus-target')!;
    expect(cssomTarget.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);
    expect(focusTarget.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);

    const originalCssomRemove = cssomTarget.style.removeProperty.bind(cssomTarget.style);
    const originalFocusRemove = focusTarget.style.removeProperty.bind(focusTarget.style);
    const cssomRemoveSpy = vi
      .spyOn(cssomTarget.style, 'removeProperty')
      .mockImplementation((property) => {
        if (property === 'direction') {
          expect(cssomTarget.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
        }
        return originalCssomRemove(property);
      });
    const focusRemoveSpy = vi
      .spyOn(focusTarget.style, 'removeProperty')
      .mockImplementation((property) => {
        if (property === 'direction') {
          expect(focusTarget.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
        }
        return originalFocusRemove(property);
      });

    const sheet = document.styleSheets[0]!;
    sheet.insertRule('#cssom-target { display: flex; }');
    focusTarget.focus();
    expect(getComputedStyle(cssomTarget).display).toBe('flex');
    expect(getComputedStyle(focusTarget).display).toBe('flex');

    (cssomTarget.firstChild as Text).data = 'العربية بعد تغيير CSSOM';
    focusTarget.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await settle();

    expect(cssomTarget.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(focusTarget.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(cssomTarget.style.direction).toBe('');
    expect(focusTarget.style.direction).toBe('');
    expect(cssomRemoveSpy).toHaveBeenCalledWith('direction');
    expect(focusRemoveSpy).toHaveBeenCalledWith('direction');
  });

  it('drops detached descendant exclusions before scanning a reinserted subtree', async () => {
    document.body.innerHTML =
      '<section id="wrapper"><div id="line">العربية داخل المحرر</div></section>';
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();

    const wrapper = document.querySelector<HTMLElement>('#wrapper')!;
    const line = document.querySelector<HTMLElement>('#line')!;
    expect(line.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);

    wrapper.remove();
    await settle();
    expect(line.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    line.className = 'CodeMirror';
    document.body.append(wrapper);
    await settle();

    expect(line.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(line.style.direction).toBe('');
  });

  it('refreshes a detached wrapper exclusion before reusing its nested native field', async () => {
    document.body.innerHTML = [
      '<div id="host" contenteditable="true">',
      '<section id="wrapper">',
      '<input id="field" value="البحث باللغة العربية">',
      '</section>',
      '</div>',
    ].join('');
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    await settle();

    const host = document.querySelector<HTMLElement>('#host')!;
    const wrapper = document.querySelector<HTMLElement>('#wrapper')!;
    const field = document.querySelector<HTMLInputElement>('#field')!;
    expect(field.hasAttribute('data-tayamun-affected-q7m3')).toBe(true);

    wrapper.remove();
    await settle();
    expect(field.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);

    wrapper.className = 'CodeMirror';
    host.append(wrapper);
    await settle();

    expect(field.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
    expect(field.style.direction).toBe('');
  });

  it('refreshes owned alignment before CSSOM-only text and input reconciliation', async () => {
    document.head.innerHTML = [
      '<style>',
      '.dynamic-direction { direction: ltr; text-align: left; }',
      '[data-tayamun-affected-q7m3] { direction: rtl !important; unicode-bidi: isolate !important; }',
      '</style>',
    ].join('');
    document.body.innerHTML = [
      '<p id="text-target" class="dynamic-direction">العربية</p>',
      '<input id="input-target" class="dynamic-direction" value="العربية">',
    ].join('');
    engine = new TayamunDirectionEngine(document, defaults);
    engine.start();
    engine.flush();
    await settle();

    const textTarget = document.querySelector<HTMLElement>('#text-target')!;
    const inputTarget = document.querySelector<HTMLInputElement>('#input-target')!;
    expect(textTarget.style.textAlign).toBe('right');
    expect(inputTarget.style.textAlign).toBe('right');

    const sheet = document.querySelector<HTMLStyleElement>('style')!.sheet!;
    sheet.deleteRule(0);
    sheet.insertRule('.dynamic-direction { direction: rtl; text-align: left; }', 0);
    (textTarget.firstChild as Text).data = 'العربية بعد تغيير الاتجاه';
    inputTarget.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await settle();

    expect(inputTarget.style.textAlign).toBe('');
    expect(textTarget.style.textAlign).toBe('');
    expect(getComputedStyle(textTarget).textAlign).toBe('left');
    expect(getComputedStyle(inputTarget).textAlign).toBe('left');
  });

  it('bounds parent coalescing for a deeply inserted and class-mutated subtree', async () => {
    engine = new TayamunDirectionEngine(document, defaults, { classMutationDebounceMs: 0 });
    engine.start();
    engine.flush();

    type SyntheticNode = { readonly parentNode: SyntheticNode | null };
    let parent: SyntheticNode | null = null;
    let ancestrySteps = 0;
    for (let depth = 0; depth < 10_000; depth += 1) {
      const nextParent = parent;
      parent = {
        get parentNode(): SyntheticNode | null {
          ancestrySteps += 1;
          return nextParent;
        },
      };
    }
    // This synthetic chain isolates enqueue's parent reads from DOM-emulator
    // recursion; the observable deep-DOM verdict is exercised below.
    const syntheticRoot = parent as unknown as Node;
    const testEngine = engine as unknown as {
      enqueueSubtree(root: Node, refreshAlignment: boolean, invalidateIntrinsic: boolean): void;
    };
    testEngine.enqueueSubtree(syntheticRoot, false, true);
    expect(ancestrySteps).toBe(64);
    engine.flush();

    const deepRoot = document.createElement('div');
    let deepest = deepRoot;
    for (let depth = 0; depth < 128; depth += 1) {
      const child = document.createElement('div');
      deepest.append(child);
      deepest = child;
    }
    const inserted = document.createElement('p');
    inserted.textContent = 'العربية';
    deepest.append(inserted);
    document.body.append(deepRoot);
    await settle();
    expect(inserted.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);

    inserted.className = 'changed';
    await settle();
    await settle();
    expect(inserted.hasAttribute('data-tayamun-affected-q7m3')).toBe(false);
  });

});
