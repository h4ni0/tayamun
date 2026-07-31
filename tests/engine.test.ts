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
      '<style>.review-left { text-align: left; } .review-center { text-align: center; }</style>';
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

    dynamic.style.cssText = 'direction: rtl; text-align: left';
    await settle();
    expect(dynamic.style.textAlign).toBe('left');
    dynamic.style.cssText = 'direction: ltr; text-align: left';
    await settle();
    expect(dynamic.style.textAlign).toBe('right');

    engine.updateSettings({ enabled: false, alignRight: false, improveFont: false });
    engine.flush();
    expect(left.style.textAlign).toBe('left');
    expect(native.style.textAlign).toBe('left');
  });

});
