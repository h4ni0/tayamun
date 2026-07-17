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
});

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

});
