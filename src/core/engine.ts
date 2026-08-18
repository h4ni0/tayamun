import type { SiteSettings } from '../settings';
import {
  composedParent,
  computedStyleFor,
  editingHostFor,
  findTextContainer,
  textShouldUseRtl,
  getContainerText,
  getTextFieldValue,
  invalidateAllElementFacts,
  invalidateDetectionCaches,
  invalidateElementFacts,
  isDisplayed,
  isExcluded,
  isSafeTextContainer,
  isTextField,
} from './detection';
import { OwnedStyles } from './owned-styles';

type ObservableRoot = Document | ShadowRoot;

interface WorkJob {
  step(): boolean;
  cancel?(): void;
}

interface TargetJob extends WorkJob {
  refreshAffectedAlignment: boolean;
}

interface SubtreeJob extends WorkJob {
  root: Node;
  cancelled: boolean;
  rerun: boolean;
  refreshAffectedAlignment: boolean;
  followUps: Map<Node, boolean>;
  invalidateIntrinsicFacts: boolean;
  rerunWithIntrinsicInvalidation: boolean;
  intrinsicInvalidationFollowUps: Set<Node>;
}

interface DebouncedSubtree {
  dueAt: number;
  deadline: number;
  delayMs: number;
  quietRescans: number;
  refreshAffectedAlignment: boolean;
  refreshRootAlignment: boolean;
  waitForQuiet: boolean;
}

export interface TayamunWorkScheduler {
  now(): number;
  schedule(callback: () => void): () => void;
}

export interface TayamunEngineOptions {
  scheduler?: TayamunWorkScheduler;
  sliceBudgetMs?: number;
  maxStepsPerSlice?: number;
  classMutationDebounceMs?: number;
}

const ELEMENT_OR_TEXT = 1 | 4;
const DEFAULT_SLICE_BUDGET_MS = 4;
const DEFAULT_MAX_STEPS_PER_SLICE = 100;
const DEFAULT_CLASS_DEBOUNCE_MS = 150;
const MAX_ANCESTOR_DEPTH = 64;
// A page that keeps rewriting classes must not postpone its rescan forever: the
// dirty set would grow without bound and a real change would never be observed.
const SUBTREE_DEBOUNCE_MAX_WAIT_FACTOR = 4;
// Cosmetic class churn (spinners, scroll state, theme flags) repeats forever.
// Once consecutive rescans of a subtree change nothing, stretch its debounce
// instead of re-deriving the same result at the page's animation rate.
const QUIET_RESCANS_BEFORE_BACKOFF = 2;
const MAX_SUBTREE_DEBOUNCE_MS = 1_200;
const AFFECTED_ATTRIBUTE = 'data-tayamun-affected-q7m3';
const FONT_ATTRIBUTE = 'data-tayamun-font-q7m3';
const MAX_EDITOR_MIGRATION_NODES = 512;
// Mirrors src/core/content.css, which does not reach inside a shadow root.
const SHADOW_FONT_CSS = `[${AFFECTED_ATTRIBUTE}] { direction: rtl !important; unicode-bidi: isolate !important; } li[${AFFECTED_ATTRIBUTE}], summary[${AFFECTED_ATTRIBUTE}] { list-style-position: inside !important; } [${FONT_ATTRIBUTE}] { font-family: "Tajawal Tayamun", Tajawal, sans-serif !important; }`;
const VISIBILITY_STYLE_PROPERTIES = new Set([
  'display',
  'visibility',
  'content-visibility',
  'opacity',
  'direction',
  'unicode-bidi',
  'text-align',
]);

function nodeRoot(node: Node): ObservableRoot | null {
  if (node.nodeType === 9) return node as Document;
  const root = node.getRootNode();
  return root.nodeType === 9 || root.nodeType === 11 ? (root as ObservableRoot) : null;
}

function relevantInlineStyle(cssText: string | null): string {
  if (!cssText) return '';
  const fingerprints = new Set<string>();
  for (const declaration of cssText.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    if (!VISIBILITY_STYLE_PROPERTIES.has(property)) continue;
    const value = declaration
      .slice(separator + 1)
      .replace(/\s*!important\s*$/i, '')
      .trim()
      .toLowerCase();
    if (property === 'display') fingerprints.add(`display:${value}`);
    if (property === 'visibility') fingerprints.add(`visibility:${value}`);
    if (property === 'content-visibility') fingerprints.add(`content-visibility:${value}`);
    if (property === 'direction') fingerprints.add(`direction:${value}`);
    if (property === 'unicode-bidi') fingerprints.add(`unicode-bidi:${value}`);
    if (property === 'text-align') fingerprints.add(`text-align:${value}`);
    if (property === 'opacity' && Number.parseFloat(value) === 0) {
      fingerprints.add('opacity:hidden');
    }
  }
  return [...fingerprints].sort().join(';');
}

function customPropertyFingerprint(cssText: string | null): string {
  if (!cssText) return '';
  const properties: string[] = [];
  for (const declaration of cssText.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim();
    if (property.startsWith('--')) properties.push(`${property}:${declaration.slice(separator + 1).trim()}`);
  }
  return properties.sort().join(';');
}

function isUnchangedAttribute(element: Element, name: string, oldValue: string | null): boolean {
  return element.getAttribute(name) === oldValue;
}

function createDefaultScheduler(document: Document): TayamunWorkScheduler {
  const view = document.defaultView;
  // One bounded slice per macrotask. MessageChannel yields to rendering and
  // timers between slices without setTimeout clamping, and without the
  // idle-period re-entry that starved Firefox timers under
  // requestIdleCallback.
  const Channel = view?.MessageChannel ?? globalThis.MessageChannel;
  if (!Channel) {
    return {
      now: () => view?.performance.now() ?? performance.now(),
      schedule(callback) {
        const id = view?.setTimeout(callback, 16) ?? setTimeout(callback, 16);
        return () => (view?.clearTimeout(id) ?? clearTimeout(id));
      },
    };
  }
  const channel = new Channel();
  const queue: (() => void)[] = [];
  channel.port1.onmessage = () => {
    queue.shift()?.();
  };
  return {
    now: () => view?.performance.now() ?? performance.now(),
    schedule(callback) {
      queue.push(callback);
      channel.port2.postMessage(null);
      return () => {
        const index = queue.indexOf(callback);
        if (index >= 0) queue.splice(index, 1);
      };
    },
  };
}

export class TayamunDirectionEngine {
  private settings: SiteSettings;
  private readonly styles = new OwnedStyles();
  private readonly affected = new Set<HTMLElement>();
  private readonly observers = new Map<ObservableRoot, MutationObserver>();
  private readonly trackedCustomElements = new Set<Element>();
  private readonly jobs: WorkJob[] = [];
  private readonly reconcileQueued = new Set<HTMLElement>();
  private readonly targetJobs = new Map<Node, TargetJob>();
  private readonly subtreeJobs = new Map<Node, SubtreeJob>();
  private readonly removedJobs = new Map<Node, WorkJob>();
  private readonly editorMutationJobs = new Set<WorkJob>();
  private independentEditorFields = new WeakMap<HTMLElement, Set<HTMLElement>>();
  private independentEditorOwners = new WeakMap<HTMLElement, Set<HTMLElement>>();
  private readonly independentRefreshQueued = new Set<HTMLElement>();
  private readonly styleRepairQueued = new Set<HTMLElement>();
  private readonly alignmentRefreshQueued = new Set<HTMLElement>();
  private debouncedSubtrees = new Set<Node>();
  private readonly debounceStates = new WeakMap<Node, DebouncedSubtree>();
  private subtreeDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private subtreeDebounceFlushActive = false;
  private earliestSubtreeDueAt = 0;
  private readonly pendingDebounceRescans = new WeakMap<Node, DebouncedSubtree>();
  private readonly markedAffected = new WeakSet<HTMLElement>();
  private readonly markedFont = new WeakSet<HTMLElement>();
  private readonly shadowFontStyles = new Map<ShadowRoot, HTMLStyleElement>();
  private readonly directionFlipped = new WeakMap<HTMLElement, boolean>();
  private readonly shadowStyleRepairQueued = new Set<ShadowRoot>();
  private readonly scheduler: TayamunWorkScheduler;
  private readonly sliceBudgetMs: number;
  private readonly maxStepsPerSlice: number;
  private readonly classMutationDebounceMs: number;
  private cancelScheduledWork: (() => void) | undefined;
  private restyleJob: WorkJob | undefined;
  private fontRestyleJob: WorkJob | undefined;
  private alignmentRevision = 0;
  private fontRevision = 0;
  private started = false;
  private active = false;
  private runningSynchronously = false;

  constructor(
    private readonly document: Document,
    initialSettings: SiteSettings,
    options: TayamunEngineOptions = {},
  ) {
    this.settings = { ...initialSettings };
    this.scheduler = options.scheduler ?? createDefaultScheduler(document);
    this.sliceBudgetMs = options.sliceBudgetMs ?? DEFAULT_SLICE_BUDGET_MS;
    this.maxStepsPerSlice = options.maxStepsPerSlice ?? DEFAULT_MAX_STEPS_PER_SLICE;
    this.classMutationDebounceMs = options.classMutationDebounceMs ?? DEFAULT_CLASS_DEBOUNCE_MS;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.settings.enabled) this.activate();
  }

  destroy(restore = true): Promise<void> {
    if (!this.started) return Promise.resolve();
    this.started = false;
    this.active = false;
    this.removeDocumentListeners();
    this.disconnectObservers();
    this.cancelAllWork();

    if (restore) {
      return new Promise((resolve) => {
        this.enqueueRestoreAll(() => this.enqueueShadowStyleRemoval(resolve));
      });
    }

    // The page is being discarded; avoid any final DOM work.
    this.styles.discardAll();
    this.affected.clear();
    this.shadowFontStyles.clear();
    return Promise.resolve();
  }

  /** Registers and scans an open root reported by an attachShadow bridge. */
  registerOpenShadowRoot(root: ShadowRoot): void {
    if (this.active && root.mode === 'open') this.observeRoot(root);
  }

  updateSettings(settings: SiteSettings): void {
    if (
      this.settings.enabled === settings.enabled &&
      this.settings.alignRight === settings.alignRight &&
      this.settings.improveFont === settings.improveFont
    ) {
      return;
    }

    const wasEnabled = this.settings.enabled;
    const alignmentChanged = this.settings.alignRight !== settings.alignRight;
    const fontChanged = this.settings.improveFont !== settings.improveFont;
    this.settings = { ...settings };
    if (alignmentChanged) this.alignmentRevision += 1;
    if (fontChanged) this.fontRevision += 1;
    if (!this.started) return;

    if (wasEnabled && !settings.enabled) {
      this.deactivateAndRestore();
      return;
    }

    if (!wasEnabled && settings.enabled) {
      this.cancelAllWork();
      this.activate();
      return;
    }

    if (!this.active) return;
    if (fontChanged) this.enqueueFontRestyle();
    if (alignmentChanged) this.enqueueRestyleAffected();
  }

  /** Drains all queued work synchronously for deterministic tests. */
  flush(): void {
    this.cancelScheduledWork?.();
    this.cancelScheduledWork = undefined;
    this.runningSynchronously = true;
    try {
      while (this.jobs.length > 0) {
        const job = this.jobs.shift()!;
        if (!job.step()) this.jobs.push(job);
      }
    } finally {
      this.runningSynchronously = false;
    }
  }

  private activate(): void {
    if (this.active) return;
    this.active = true;
    this.styles.discardPendingStyleMutations();
    // Styles may have changed while observers were disconnected.
    invalidateAllElementFacts();
    invalidateDetectionCaches();
    this.document.addEventListener('input', this.handleInput, true);
    this.document.addEventListener('change', this.handleInput, true);
    this.document.addEventListener('compositionend', this.handleInput, true);
    this.document.addEventListener('load', this.handleLoad, true);
    this.document.defaultView?.addEventListener('resize', this.handleResize, { passive: true });
    this.observeRoot(this.document, true);
  }

  private deactivateAndRestore(): void {
    this.active = false;
    this.removeDocumentListeners();
    this.disconnectObservers();
    this.cancelAllWork();
    this.enqueueRestoreAll();
  }

  private removeDocumentListeners(): void {
    this.document.removeEventListener('input', this.handleInput, true);
    this.document.removeEventListener('change', this.handleInput, true);
    this.document.removeEventListener('compositionend', this.handleInput, true);
    this.document.removeEventListener('load', this.handleLoad, true);
    this.document.defaultView?.removeEventListener('resize', this.handleResize);
  }

  private disconnectObservers(): void {
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
  }

  private readonly handleInput = (event: Event): void => {
    const source = event.composedPath?.()[0] ?? event.target;
    // Focus pseudo-classes and CSSOM edits can change classification without a
    // DOM mutation. Input reconciliation must therefore start a style epoch.
    invalidateDetectionCaches();
    if (source && 'nodeType' in source) this.enqueueTarget(source as Node, true);
  };

  private readonly handleResize = (): void => {
    if (!this.active) return;
    invalidateDetectionCaches();
    this.debounceSubtree(this.document, true);
    this.armSubtreeDebounce();
  };

  private readonly handleLoad = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof this.document.defaultView!.Element)) return;
    if (target.tagName !== 'LINK' && target.tagName !== 'STYLE') return;
    // A newly loaded stylesheet can change computed styles page-wide.
    invalidateDetectionCaches();
    const root = nodeRoot(target);
    if (root) this.enqueueSubtree(root, true);
  };

  private observeRoot(root: ObservableRoot, refreshAffectedAlignment = false): void {
    if (!this.active || this.observers.has(root)) return;
    if (root.nodeType === 11) this.ensureShadowFontStyle(root as ShadowRoot);
    const MutationObserverConstructor = this.document.defaultView?.MutationObserver;
    if (!MutationObserverConstructor) return;

    const observer = new MutationObserverConstructor((records) => this.handleMutations(records));
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: [
        'class',
        'style',
        'hidden',
        'dir',
        'type',
        'contenteditable',
        'placeholder',
        'value',
        'role',
        'href',
        'aria-hidden',
        'open',
        // Read by the code-editor selector, so a change must drop the element's
        // memoized exclusion.
        'data-code-editor',
        'data-language',
        'data-mode',
      ],
    });
    this.observers.set(root, observer);
    this.enqueueSubtree(root, refreshAffectedAlignment);
  }

  private handleMutations(records: MutationRecord[]): void {
    if (!this.active || records.length === 0) return;
    let index = 0;
    this.enqueueJob({
      step: () => {
        if (!this.active) return true;
        const record = records[index++];
        if (record) this.processMutation(record);
        if (index < records.length) return false;
        this.armSubtreeDebounce();
        return true;
      },
    });
  }

  private processMutation(record: MutationRecord): void {
    const source = record.target;
    // Text is often the first observed event after a focus pseudo-class or a
    // CSSOM-only style change, neither of which produces an attribute record.
    if (record.type === 'characterData') invalidateDetectionCaches();
    const sourceElement = source.nodeType === 1 ? (source as Element) : source.parentElement;
    const attributeName = record.attributeName ?? '';
    const previousHost = sourceElement ? editingHostFor(sourceElement) : null;
    if (record.type === 'attributes' && attributeName === 'contenteditable') {
      const element = source as Element;
      if (isUnchangedAttribute(element, attributeName, record.oldValue)) return;
      invalidateElementFacts(element);
      invalidateDetectionCaches();

      // Editable topology changes are rare and can change ownership for every
      // nested host. Migrate this bounded subtree so newly independent hosts are
      // found and previously independent, affected hosts are restored.
      this.enqueueSubtree(element);
      if (previousHost) this.enqueueReconcile(previousHost);
      const currentHost = editingHostFor(element);
      if (currentHost) this.enqueueReconcile(currentHost);
      return;
    }

    const host = sourceElement ? editingHostFor(sourceElement) : null;
    const sourceHTMLElement =
      sourceElement instanceof this.document.defaultView!.HTMLElement ? sourceElement : null;
    const sourceIsIndependent =
      sourceHTMLElement !== null &&
      (sourceHTMLElement.tagName === 'INPUT' ||
        sourceHTMLElement.tagName === 'TEXTAREA' ||
        (record.type === 'attributes' && this.affected.has(sourceHTMLElement)));
    if (host && !sourceIsIndependent && (record.type !== 'attributes' || source !== host)) {
      // Editor-internal writes never need a descendant scan, but topology,
      // visibility, and exclusions used while reading the host's text must be
      // current. Otherwise a hidden leading run or a moved editor block keeps
      // deciding direction from stale facts.
      if (record.type === 'childList') {
        invalidateDetectionCaches();
      } else if (record.type === 'attributes') {
        const element = source as Element;
        if (attributeName !== 'style') {
          if (isUnchangedAttribute(element, attributeName, record.oldValue)) return;
          invalidateElementFacts(element);
        }
        invalidateDetectionCaches();
      }
      if (host && (record.type !== 'attributes' || source !== host)) {
        this.enqueueReconcile(host);
        if (record.type === 'childList') {
          this.enqueueEditorTraversal(record.addedNodes, false);
          this.enqueueEditorTraversal(record.removedNodes, true);
        }
        return;
      }
    }

    if (record.type === 'childList') {
      // Reparenting can move elements under differently styled ancestors.
      invalidateDetectionCaches();
      const parent = record.target;
      const mutationRoot = nodeRoot(parent);
      if (mutationRoot?.nodeType === 11) {
        const shadowRoot = mutationRoot as ShadowRoot;
        if (!this.shadowFontStyles.get(shadowRoot)?.isConnected) {
          this.enqueueShadowStyleRepair(shadowRoot);
        }
      }
      if (
        parent.nodeType === 1 &&
        ((parent as Element).tagName === 'STYLE' || (parent as Element).tagName === 'LINK')
      ) {
        const root = nodeRoot(parent);
        if (root) this.debounceSubtree(root, true);
        return;
      }

      // A child change can alter the parent's own text, but must not rescan
      // the parent's entire existing subtree.
      this.enqueueTarget(parent);
      this.enqueueNodeBatch(record.addedNodes, (node) => this.enqueueSubtree(node, false, true));
      this.enqueueNodeBatch(record.removedNodes, (node) => this.enqueueRemoved(node));
      return;
    }

    if (record.type === 'characterData') {
      this.enqueueTarget(record.target, true);
      return;
    }

    const target = record.target;
    if (attributeName !== 'style' && target.nodeType === 1) {
      const element = target as Element;
      // A rewrite that lands on the current value changes nothing, so it must
      // not invalidate memoized facts or schedule a rescan.
      if (isUnchangedAttribute(element, attributeName, record.oldValue)) return;
      // Only this element's own attribute-derived facts can have changed.
      invalidateElementFacts(element);
    }

    if (!(target instanceof this.document.defaultView!.HTMLElement)) {
      this.enqueueSubtree(target);
      return;
    }

    if (attributeName === 'style') {
      if (this.styles.consumeOwnStyleMutation(target)) return;
      if (this.styles.needsRepair(target)) this.enqueueStyleRepair(target);
      const currentStyle = target.getAttribute('style');
      if (record.oldValue === currentStyle) return;
      const relevantStyleChanged =
        relevantInlineStyle(record.oldValue) !== relevantInlineStyle(currentStyle);
      const customPropertiesChanged =
        customPropertyFingerprint(record.oldValue) !== customPropertyFingerprint(currentStyle);
      if (this.affected.has(target) && relevantStyleChanged) {
        this.enqueueAlignmentRefresh(target);
      }
      invalidateDetectionCaches();
      const targetIsEditingHost = editingHostFor(target) === target;
      if (relevantStyleChanged) {
        if (targetIsEditingHost) this.enqueueReconcile(target);
        if (targetIsEditingHost) this.enqueueIndependentEditorRefresh(target);
        else this.enqueueSubtree(target, true);
      } else if (customPropertiesChanged) {
        this.debounceSubtree(target, true, true, targetIsEditingHost);
      }
      return;
    }

    if (attributeName === 'class') {
      invalidateDetectionCaches();
      if (this.styles.needsClassAlignmentRefresh(target)) {
        this.enqueueAlignmentRefresh(target);
      }
      if (editingHostFor(target) === target) this.enqueueReconcile(target);
      if (editingHostFor(target) === target) this.enqueueIndependentEditorRefresh(target);
      else this.debounceSubtree(target, true);
      return;
    }

    if (
      attributeName === 'role' ||
      attributeName === 'aria-hidden' ||
      attributeName === 'data-code-editor' ||
      attributeName === 'data-language' ||
      attributeName === 'data-mode'
    ) {
      invalidateAllElementFacts();
    }
    invalidateDetectionCaches();
    if (attributeName === 'dir') {
      if (this.affected.has(target)) this.enqueueAlignmentRefresh(target);
      if (editingHostFor(target) === target) this.enqueueIndependentEditorRefresh(target);
    }
    if (
      attributeName === 'hidden' ||
      attributeName === 'dir' ||
      attributeName === 'contenteditable' ||
      attributeName === 'role' ||
      attributeName === 'aria-hidden' ||
      attributeName === 'open' ||
      attributeName === 'data-code-editor' ||
      attributeName === 'data-language' ||
      attributeName === 'data-mode'
    ) {
      if (attributeName !== 'contenteditable' && editingHostFor(target) === target) {
        this.enqueueReconcile(target);
        this.enqueueIndependentEditorRefresh(target);
      } else {
        this.enqueueSubtree(target, attributeName === 'dir');
      }
    } else {
      this.enqueueTarget(target);
    }
  }

  private debounceSubtree(
    target: Node,
    refreshAffectedAlignment = false,
    refreshRootAlignment = false,
    waitForQuiet = false,
  ): void {
    if (!nodeRoot(target)) return;
    let state = this.debounceStates.get(target);
    if (!state) {
      state = {
        dueAt: 0,
        deadline: 0,
        delayMs: this.classMutationDebounceMs,
        quietRescans: 0,
        refreshAffectedAlignment: false,
        refreshRootAlignment: false,
        waitForQuiet: false,
      };
      this.debounceStates.set(target, state);
    }
    if (refreshAffectedAlignment) state.refreshAffectedAlignment = true;
    if (refreshRootAlignment) state.refreshRootAlignment = true;
    state.waitForQuiet = waitForQuiet;

    const now = this.scheduler.now();
    if (state.waitForQuiet) {
      state.deadline = 0;
      state.dueAt = now + state.delayMs;
    } else {
      if (state.deadline === 0) {
        state.deadline = now + state.delayMs * SUBTREE_DEBOUNCE_MAX_WAIT_FACTOR;
      }
      state.dueAt = Math.min(now + state.delayMs, state.deadline);
    }
    this.debouncedSubtrees.add(target);
    if (this.earliestSubtreeDueAt === 0 || state.dueAt < this.earliestSubtreeDueAt) {
      this.earliestSubtreeDueAt = state.dueAt;
    }
  }

  private armSubtreeDebounce(): void {
    if (this.subtreeDebounceFlushActive || this.debouncedSubtrees.size === 0) return;
    clearTimeout(this.subtreeDebounceTimer);
    const delay = Math.max(0, this.earliestSubtreeDueAt - this.scheduler.now());
    this.subtreeDebounceTimer = setTimeout(() => this.flushDebouncedSubtrees(), delay);
  }

  private flushDebouncedSubtrees(): void {
    this.subtreeDebounceTimer = undefined;
    if (!this.active) {
      this.debouncedSubtrees.clear();
      this.earliestSubtreeDueAt = 0;
      return;
    }

    // Swap the set in O(1), then inspect one deadline per scheduler step. New
    // mutations accumulate independently while this bounded batch is draining.
    const batch = this.debouncedSubtrees;
    this.debouncedSubtrees = new Set();
    this.earliestSubtreeDueAt = 0;
    this.subtreeDebounceFlushActive = true;
    const iterator = batch.values();
    this.enqueueJob({
      step: () => {
        if (!this.active) {
          this.subtreeDebounceFlushActive = false;
          return true;
        }
        const next = iterator.next();
        if (next.done) {
          this.subtreeDebounceFlushActive = false;
          this.armSubtreeDebounce();
          return true;
        }

        const node = next.value;
        const state = this.debounceStates.get(node);
        if (!state) return false;
        const now = this.scheduler.now();
        if (state.dueAt > now) {
          this.debouncedSubtrees.add(node);
          if (this.earliestSubtreeDueAt === 0 || state.dueAt < this.earliestSubtreeDueAt) {
            this.earliestSubtreeDueAt = state.dueAt;
          }
          return false;
        }

        const refreshAffectedAlignment = state.refreshAffectedAlignment;
        const refreshRootAlignment = state.refreshRootAlignment;
        state.refreshAffectedAlignment = false;
        state.refreshRootAlignment = false;
        state.waitForQuiet = false;
        state.deadline = 0;
        if (node.isConnected) {
          if (
            refreshRootAlignment &&
            node instanceof this.document.defaultView!.HTMLElement &&
            this.styles.needsClassAlignmentRefresh(node)
          ) {
            this.enqueueAlignmentRefresh(node);
          }
          if (
            node instanceof this.document.defaultView!.HTMLElement &&
            editingHostFor(node) === node
          ) {
            const wasAffected = this.affected.has(node);
            this.enqueueReconcile(node);
            this.enqueueIndependentEditorRefresh(node);
            this.enqueueJob({
              step: () => {
                this.adjustRescanDelay(state, this.affected.has(node) !== wasAffected);
                return true;
              },
            });
          } else {
            this.pendingDebounceRescans.set(node, state);
            this.enqueueSubtree(node, refreshAffectedAlignment);
          }
        }
        return false;
      },
    });
  }

  /**
   * Grows a subtree's debounce only after its own scan leaves every candidate's
   * affected membership unchanged. Work in disjoint subtrees cannot keep a
   * cosmetic animation at the base scan rate.
   */
  private adjustRescanDelay(state: DebouncedSubtree, membershipChanged: boolean): void {
    if (!membershipChanged) {
      state.quietRescans += 1;
      if (state.quietRescans > QUIET_RESCANS_BEFORE_BACKOFF) {
        state.delayMs = Math.min(state.delayMs * 2, MAX_SUBTREE_DEBOUNCE_MS);
      }
    } else {
      state.quietRescans = 0;
      state.delayMs = this.classMutationDebounceMs;
    }
  }

  private enqueueShadowStyleRepair(root: ShadowRoot): void {
    if (this.shadowStyleRepairQueued.has(root)) return;
    this.shadowStyleRepairQueued.add(root);
    this.enqueueJob({
      step: () => {
        this.shadowStyleRepairQueued.delete(root);
        if (this.active && root.host.isConnected) this.ensureShadowFontStyle(root);
        return true;
      },
    });
  }

  private enqueueStyleRepair(element: HTMLElement): void {
    if (this.styleRepairQueued.has(element)) return;
    this.styleRepairQueued.add(element);
    this.enqueueJob({
      step: () => {
        this.styleRepairQueued.delete(element);
        if (this.active && element.isConnected) {
          this.styles.handleStyleMutation(element);
          this.enqueueTarget(element);
        }
        return true;
      },
    });
  }

  private enqueueAlignmentRefresh(element: HTMLElement): void {
    if (this.alignmentRefreshQueued.has(element)) return;
    this.alignmentRefreshQueued.add(element);
    this.enqueueJob({
      step: () => {
        this.alignmentRefreshQueued.delete(element);
        if (!this.active || !element.isConnected) return true;

        // Expose the page's declarations for one synchronous read. Owned inline
        // direction/alignment and the marker are restored before rendering.
        const removeMarker =
          this.markedAffected.has(element) && element.hasAttribute(AFFECTED_ATTRIBUTE);
        if (removeMarker) element.removeAttribute(AFFECTED_ATTRIBUTE);
        const directionFlipped = this.styles.refreshAlignment(element);
        this.directionFlipped.set(element, directionFlipped);
        if (removeMarker) element.setAttribute(AFFECTED_ATTRIBUTE, '');
        return true;
      },
    });
  }

  private enqueueNodeBatch(nodes: NodeList, enqueue: (node: Node) => void): void {
    if (nodes.length === 0) return;
    if (nodes.length === 1) {
      const node = nodes[0];
      if (node) enqueue(node);
      return;
    }
    let index = 0;
    this.enqueueJob({
      step: () => {
        const node = nodes[index++];
        if (node) enqueue(node);
        return index >= nodes.length;
      },
    });
  }

  private enqueueEditorTraversal(roots: NodeList, removing: boolean): void {
    if (roots.length === 0) return;

    let rootIndex = 0;
    let extraRootIndex = 0;
    let visited = 0;
    const extraRoots: Node[] = [];
    const frames: Array<{ node: Node; entered: boolean; childIndex: number }> = [];
    let activeRoot: Node | null = null;
    const nextRoot = (): Node | null => roots[rootIndex++] ?? extraRoots[extraRootIndex++] ?? null;

    const job: WorkJob = {
      step: () => {
        if (!this.active) {
          this.editorMutationJobs.delete(job);
          return true;
        }
        if (!removing && visited >= MAX_EDITOR_MIGRATION_NODES) {
          visited = 0;
          return false;
        }

        if (
          activeRoot &&
          ((removing && activeRoot.isConnected) || (!removing && !activeRoot.isConnected))
        ) {
          frames.length = 0;
          activeRoot = null;
          return false;
        }

        const frame = frames.at(-1);
        if (!frame) {
          const root = nextRoot();
          if (!root) {
            this.editorMutationJobs.delete(job);
            return true;
          }
          if ((removing && root.isConnected) || (!removing && !root.isConnected)) return false;
          activeRoot = root;
          frames.push({ node: root, entered: false, childIndex: 0 });
          return false;
        }

        if (!frame.entered) {
          frame.entered = true;
          visited += 1;
          this.processEditorMutationNode(frame.node, removing, (root) => {
            extraRoots.push(root);
          });
          return false;
        }

        const parent =
          frame.node.nodeType === 1 || frame.node.nodeType === 9 || frame.node.nodeType === 11
            ? (frame.node as ParentNode)
            : null;
        const child = parent?.children.item(frame.childIndex++) ?? null;
        if (child) {
          frames.push({ node: child, entered: false, childIndex: 0 });
        } else {
          frames.pop();
          if (frames.length === 0) activeRoot = null;
        }
        return false;
      },
    };
    this.editorMutationJobs.add(job);
    this.enqueueJob(job);
  }

  private processEditorMutationNode(
    node: Node,
    removing: boolean,
    enqueueRemovedRoot: (root: Node) => void,
  ): void {
    if (node.nodeType !== 1) return;
    const element = node as Element;
    // This element may have changed while detached and unobserved. Refresh each
    // lazily visited wrapper before a descendant reuses its exclusion facts.
    invalidateElementFacts(element);

    if (removing) {
      if (element instanceof this.document.defaultView!.HTMLElement) {
        this.forgetIndependentEditorField(element);
        if (this.affected.has(element)) this.restore(element);
      }
      if (element.shadowRoot) {
        this.observers.get(element.shadowRoot)?.disconnect();
        this.observers.delete(element.shadowRoot);
        this.removeShadowFontStyle(element.shadowRoot);
        enqueueRemovedRoot(element.shadowRoot);
      }
      return;
    }

    if (element.shadowRoot) this.registerOpenShadowRoot(element.shadowRoot);
    this.trackCustomElement(element);
    if (
      element.tagName !== 'INPUT' &&
      element.tagName !== 'TEXTAREA' &&
      !element.hasAttribute('contenteditable') &&
      !(element instanceof this.document.defaultView!.HTMLElement && this.affected.has(element))
    ) {
      return;
    }

    if (!(element instanceof this.document.defaultView!.HTMLElement)) return;
    if (
      isTextField(element) ||
      this.affected.has(element) ||
      editingHostFor(element) === element
    ) {
      this.enqueueReconcile(element);
    }
  }
  private enqueueTarget(node: Node, refreshAffectedAlignment = false): void {
    if (!this.active) return;
    const existing = this.targetJobs.get(node);
    if (existing) {
      if (refreshAffectedAlignment) existing.refreshAffectedAlignment = true;
      return;
    }

    // Native text controls remain independent fields even when embedded in a
    // rich editor. Routing them through the host loses their live value.
    const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
    if (
      element instanceof this.document.defaultView!.HTMLElement &&
      (element.tagName === 'INPUT' ||
        element.tagName === 'TEXTAREA' ||
        isTextField(element) ||
        this.affected.has(element))
    ) {
      if (
        refreshAffectedAlignment &&
        this.affected.has(element) &&
        editingHostFor(element) !== element
      ) {
        this.enqueueAlignmentRefresh(element);
      }
      this.enqueueReconcile(element);
      return;
    }

    // One reconcile of the host covers every text node the editor just rewrote,
    // and skips walking children the editor re-creates on each keystroke.
    const host = element ? editingHostFor(element) : null;
    if (host) {
      this.enqueueReconcile(host);
      return;
    }
    const candidates = new Set<HTMLElement>();
    let childIndex = 0;
    let initialized = false;
    let ancestor: Element | null | undefined;
    const job: TargetJob = {
      refreshAffectedAlignment,
      step: () => {
        if (!this.active || !node.isConnected) {
          this.targetJobs.delete(node);
          return true;
        }

        if (!initialized) {
          initialized = true;
          if (node.nodeType === 3) {
            const candidate = findTextContainer(node as Text);
            if (candidate) candidates.add(candidate);
            ancestor = (node as Text).parentElement;
          } else if (node.nodeType === 1) {
            const element = node as Element;
            if (isTextField(element)) candidates.add(element as HTMLElement);
            if (
              element instanceof this.document.defaultView!.HTMLElement &&
              this.affected.has(element as HTMLElement)
            ) {
              candidates.add(element as HTMLElement);
            }

            ancestor = composedParent(element);
          }
        }
        if (ancestor) {
          if (
            ancestor instanceof this.document.defaultView!.HTMLElement &&
            this.affected.has(ancestor as HTMLElement)
          ) {
            candidates.add(ancestor as HTMLElement);
          }
          ancestor = composedParent(ancestor);
          return false;
        }

        if (node.nodeType === 1) {
          const children = node.childNodes;
          if (childIndex < children.length) {
            const child = children[childIndex++];
            if (child?.nodeType === 3) {
              const candidate = findTextContainer(child as Text);
              if (candidate) candidates.add(candidate);
            }
            return false;
          }
        }
        if (job.refreshAffectedAlignment) {
          for (const candidate of candidates) {
            if (
              this.affected.has(candidate) &&
              editingHostFor(candidate) !== candidate
            ) {
              this.enqueueAlignmentRefresh(candidate);
            }
          }
        }

        for (const candidate of candidates) this.enqueueReconcile(candidate);
        this.targetJobs.delete(node);
        return true;
      },
    };
    this.targetJobs.set(node, job);
    this.enqueueJob(job);
  }

  private enqueueSubtree(
    root: Node,
    refreshAffectedAlignment = false,
    invalidateIntrinsicFacts = false,
  ): void {
    if (!this.active) return;
    // A raced reinsertion may still be under sliced removal cleanup. Check it
    // together with queued-ancestor coalescing in one bounded parent walk.
    if (this.removedJobs.has(root)) return;
    const existing = this.subtreeJobs.get(root);
    if (existing) {
      if (refreshAffectedAlignment) existing.refreshAffectedAlignment = true;
      if (invalidateIntrinsicFacts) existing.rerunWithIntrinsicInvalidation = true;
      existing.rerun = true;
      return;
    }

    // Parent coalescing prevents O(N²) sibling comparisons. Very deep trees get
    // an independent invalidating job instead: duplicate work is safer than
    // either blocking cleanup or trusting facts beyond the bounded prefix.
    let ancestor = root.parentNode;
    let remainingDepth = MAX_ANCESTOR_DEPTH;
    while (ancestor && remainingDepth > 0) {
      remainingDepth -= 1;
      if (this.removedJobs.has(ancestor)) return;
      const queuedAncestor = this.subtreeJobs.get(ancestor);
      if (queuedAncestor) {
        this.addSubtreeFollowUp(
          queuedAncestor,
          root,
          refreshAffectedAlignment,
          invalidateIntrinsicFacts,
        );
        return;
      }
      if (remainingDepth === 0) {
        invalidateIntrinsicFacts = true;
        break;
      }
      ancestor = ancestor.parentNode;
    }
    const debounceState = this.pendingDebounceRescans.get(root);
    this.pendingDebounceRescans.delete(root);


    let walker: TreeWalker | undefined;
    let current: Node | null | undefined;
    let reconciledCandidate: HTMLElement | undefined;
    let candidateWasAffected = false;
    let membershipChanged = false;
    const candidates = new Set<HTMLElement>();
    const job: SubtreeJob = {
      root,
      cancelled: false,
      rerun: false,
      refreshAffectedAlignment,
      invalidateIntrinsicFacts,
      rerunWithIntrinsicInvalidation: false,
      intrinsicInvalidationFollowUps: new Set(),
      followUps: new Map(),
      step: () => {
        if (job.cancelled || !this.active) {
          this.finishSubtreeJob(job);
          return true;
        }
        if (
          reconciledCandidate &&
          this.affected.has(reconciledCandidate) !== candidateWasAffected
        ) {
          membershipChanged = true;
        }
        reconciledCandidate = undefined;


        if (current === undefined) {
          const ownerDocument = root.nodeType === 9 ? (root as Document) : root.ownerDocument;
          if (!ownerDocument) {
            this.finishSubtreeJob(job);
            return true;
          }
          current = root.nodeType === 1 || root.nodeType === 3 ? root : null;
          if (root.nodeType !== 3) {
            walker = ownerDocument.createTreeWalker(root, ELEMENT_OR_TEXT);
            if (current === null) current = walker.nextNode();
          }
        }

        if (current) {
          if (job.invalidateIntrinsicFacts && current.nodeType === 1) {
            invalidateElementFacts(current as Element);
          }
          const candidate = this.collectNodeCandidate(current, job.refreshAffectedAlignment);
          if (candidate && !candidates.has(candidate)) {
            candidates.add(candidate);
            reconciledCandidate = candidate;
            candidateWasAffected = this.affected.has(candidate);
            if (
              job.refreshAffectedAlignment &&
              current !== root &&
              this.affected.has(candidate) &&
              this.styles.needsClassAlignmentRefresh(candidate)
            ) {
              this.enqueueAlignmentRefresh(candidate);
            }
            this.enqueueReconcile(candidate);
          }
          current = walker?.nextNode() ?? null;
          return false;
        }

        if (debounceState) this.adjustRescanDelay(debounceState, membershipChanged);
        this.finishSubtreeJob(job);
        return true;
      },
    };
    this.subtreeJobs.set(root, job);
    this.enqueueJob(job);
  }

  private addSubtreeFollowUp(
    job: SubtreeJob,
    root: Node,
    refreshAffectedAlignment: boolean,
    invalidateIntrinsicFacts: boolean,
  ): void {
    // Map insertion is intentionally O(1). Parent/child duplicates are harmless
    // bounded jobs; pairwise normalization makes bulk sibling insertion O(N²).
    job.followUps.set(root, job.followUps.get(root) === true || refreshAffectedAlignment);
    if (invalidateIntrinsicFacts) job.intrinsicInvalidationFollowUps.add(root);
  }

  private finishSubtreeJob(job: SubtreeJob): void {
    if (this.subtreeJobs.get(job.root) === job) this.subtreeJobs.delete(job.root);
    if (job.cancelled || !this.active) return;
    if (job.rerun && job.root.isConnected) {
      this.enqueueSubtree(
        job.root,
        job.refreshAffectedAlignment,
        job.rerunWithIntrinsicInvalidation,
      );
      return;
    }
    if (job.followUps.size > 0) {
      const iterator = job.followUps.entries();
      this.enqueueJob({
        step: () => {
          const next = iterator.next();
          if (next.done) return true;
          const [root, refreshAffectedAlignment] = next.value;
          if (root.isConnected) {
            this.enqueueSubtree(
              root,
              refreshAffectedAlignment,
              job.intrinsicInvalidationFollowUps.has(root),
            );
          }
          return false;
        },
      });
    }
  }

  private collectNodeCandidate(
    node: Node,
    refreshAffectedAlignment: boolean,
  ): HTMLElement | null {
    if (node.nodeType === 3) return findTextContainer(node as Text);
    if (node.nodeType !== 1) return null;

    const element = node as Element;
    if (element.shadowRoot) {
      this.registerOpenShadowRoot(element.shadowRoot);
      if (refreshAffectedAlignment) this.enqueueSubtree(element.shadowRoot, true);
    }
    this.trackCustomElement(element);
    if (isTextField(element)) return element as HTMLElement;
    if (
      element instanceof this.document.defaultView!.HTMLElement &&
      this.affected.has(element as HTMLElement)
    ) {
      return element as HTMLElement;
    }
    return null;
  }

  private enqueueRemoved(root: Node): void {
    if (this.removedJobs.has(root)) return;
    let walker: TreeWalker | undefined;
    let current: Node | null | undefined;
    const finish = (): boolean => {
      this.removedJobs.delete(root);
      if (this.active && root.isConnected) this.enqueueSubtree(root, false, true);
      return true;
    };
    const job: WorkJob = {
      step: () => {
        if (current === undefined) {
          const ownerDocument = root.nodeType === 9 ? (root as Document) : root.ownerDocument;
          if (!ownerDocument) return finish();
          current = root.nodeType === 1 ? root : null;
          walker = ownerDocument.createTreeWalker(root, 1);
          if (current === null) current = walker.nextNode();
        }

        if (!current) return finish();

        const element = current as Element;
        // The removal walk is already scheduler-sliced. Refresh intrinsic facts
        // here and again during a raced reinsertion scan so detached attribute
        // changes cannot survive regardless of where this live walker was.
        invalidateElementFacts(element);
        if (!element.isConnected) {
          if (
            element instanceof this.document.defaultView!.HTMLElement &&
            this.affected.has(element as HTMLElement)
          ) {
            this.restore(element as HTMLElement);
          }
          if (element.shadowRoot) {
            const observer = this.observers.get(element.shadowRoot);
            observer?.disconnect();
            this.observers.delete(element.shadowRoot);
            this.removeShadowFontStyle(element.shadowRoot);
            this.enqueueRemoved(element.shadowRoot);
          }
        }
        current = walker!.nextNode();
        return false;
      },
    };
    this.removedJobs.set(root, job);
    this.enqueueJob(job);
  }

  private enqueueReconcile(element: HTMLElement): void {
    if (this.reconcileQueued.has(element)) return;
    this.reconcileQueued.add(element);
    this.enqueueJob({
      step: () => {
        this.reconcileQueued.delete(element);
        if (this.active || this.affected.has(element)) this.reconcile(element);
        return true;
      },
    });
  }

  private enqueueRestyleAffected(): void {
    if (this.restyleJob) return;
    let appliedRevision = this.alignmentRevision;
    let remaining = this.affected.size;
    let iterator = this.affected.values();
    const job: WorkJob = {
      step: () => {
        if (!this.active) {
          this.restyleJob = undefined;
          return true;
        }
        if (remaining > 0) {
          const next = iterator.next();
          if (!next.done) {
            remaining -= 1;
            if (next.value.isConnected) {
              this.styles.apply(next.value, {
                alignRight: this.settings.alignRight,
                improveFont: this.settings.improveFont,
                overrideDirection: this.needsDirectionOverride(next.value),
                pageAlignment: computedStyleFor(next.value)?.textAlign ?? '',
                directionFlipped: this.directionFlipped.get(next.value) ?? false,
              });
            } else {
              this.restore(next.value);
            }
            return false;
          }
          remaining = 0;
        }
        if (appliedRevision !== this.alignmentRevision) {
          appliedRevision = this.alignmentRevision;
          remaining = this.affected.size;
          iterator = this.affected.values();
          return false;
        }
        this.restyleJob = undefined;
        return true;
      },
    };
    this.restyleJob = job;
    this.enqueueJob(job);
  }

  private enqueueFontRestyle(): void {
    if (this.fontRestyleJob) return;
    let appliedRevision = this.fontRevision;
    let remaining = this.affected.size;
    let iterator = this.affected.values();
    const job: WorkJob = {
      step: () => {
        if (!this.active) {
          this.fontRestyleJob = undefined;
          return true;
        }
        if (remaining > 0) {
          const next = iterator.next();
          if (!next.done) {
            remaining -= 1;
            if (next.value.isConnected) {
              this.setElementFont(next.value, this.settings.improveFont);
              const pageStyle = computedStyleFor(next.value);
              this.styles.apply(next.value, {
                alignRight: this.settings.alignRight,
                improveFont: this.settings.improveFont,
                overrideDirection: this.needsDirectionOverride(next.value),
                pageAlignment: pageStyle?.textAlign ?? '',
                directionFlipped: this.directionFlipped.get(next.value) ?? false,
              });
            } else {
              this.restore(next.value);
            }
            return false;
          }
          remaining = 0;
        }
        if (appliedRevision !== this.fontRevision) {
          appliedRevision = this.fontRevision;
          remaining = this.affected.size;
          iterator = this.affected.values();
          return false;
        }
        this.fontRestyleJob = undefined;
        return true;
      },
    };
    this.fontRestyleJob = job;
    this.enqueueJob(job);
  }

  private enqueueRestoreAll(onComplete?: () => void): void {
    const iterator = this.affected.values();
    this.enqueueJob({
      step: () => {
        const next = iterator.next();
        if (next.done) {
          this.styles.restoreAll();
          onComplete?.();
          return true;
        }
        this.restore(next.value);
        return false;
      },
    });
  }

  private enqueueShadowStyleRemoval(onComplete?: () => void): void {
    const iterator = this.shadowFontStyles.entries();
    this.enqueueJob({
      step: () => {
        const next = iterator.next();
        if (next.done) {
          this.shadowFontStyles.clear();
          onComplete?.();
          return true;
        }
        const [root, style] = next.value;
        style.remove();
        this.shadowFontStyles.delete(root);
        return false;
      },
    });
  }

  private outerEditingHostsFor(element: HTMLElement): Set<HTMLElement> {
    const owners = new Set<HTMLElement>();
    let ancestor = composedParent(element);
    for (let depth = 0; ancestor && depth < 64; depth += 1) {
      const host = editingHostFor(ancestor);
      if (host && host !== element) owners.add(host);
      ancestor = composedParent(ancestor);
    }
    return owners;
  }

  private rememberIndependentEditorField(element: HTMLElement): void {
    const owners = this.outerEditingHostsFor(element);
    const previousOwners = this.independentEditorOwners.get(element);
    if (
      previousOwners?.size === owners.size &&
      [...previousOwners].every((owner) => owners.has(owner))
    ) {
      return;
    }
    this.forgetIndependentEditorField(element);
    if (owners.size === 0) return;

    for (const owner of owners) {
      let fields = this.independentEditorFields.get(owner);
      if (!fields) {
        fields = new Set();
        this.independentEditorFields.set(owner, fields);
      }
      fields.add(element);
    }
    this.independentEditorOwners.set(element, owners);
  }

  private forgetIndependentEditorField(element: HTMLElement): void {
    const owners = this.independentEditorOwners.get(element);
    if (!owners) return;
    for (const owner of owners) this.independentEditorFields.get(owner)?.delete(element);
    this.independentEditorOwners.delete(element);
  }

  private enqueueIndependentEditorRefresh(host: HTMLElement): void {
    const fields = this.independentEditorFields.get(host);
    if (!fields || fields.size === 0 || this.independentRefreshQueued.has(host)) return;

    this.independentRefreshQueued.add(host);
    const iterator = fields.values();
    this.enqueueJob({
      step: () => {
        if (!this.active) {
          this.independentRefreshQueued.delete(host);
          return true;
        }
        const next = iterator.next();
        if (next.done) {
          this.independentRefreshQueued.delete(host);
          return true;
        }

        const field = next.value;
        if (!field.isConnected || !this.outerEditingHostsFor(field).has(host)) {
          this.forgetIndependentEditorField(field);
          return false;
        }
        invalidateElementFacts(field);
        invalidateDetectionCaches();
        if (this.affected.has(field)) this.enqueueAlignmentRefresh(field);
        this.enqueueReconcile(field);
        return false;
      },
    });
  }

  private reconcile(element: HTMLElement): void {
    let text = '';
    const nativeField = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA';
    if (nativeField) this.rememberIndependentEditorField(element);
    if (isTextField(element)) {
      if (!element.isConnected || !isDisplayed(element) || isExcluded(element)) {
        this.restore(element);
        return;
      }
      text = getTextFieldValue(element);
    } else {
      const editingHost = editingHostFor(element);
      if (editingHost === element) this.rememberIndependentEditorField(element);
      if (editingHost && editingHost !== element) {
        this.restore(element);
        this.enqueueReconcile(editingHost);
        return;
      }
      if (!isSafeTextContainer(element)) {
        this.restore(element);
        return;
      }
      text = getContainerText(element);
    }

    if (!textShouldUseRtl(text)) {
      this.restore(element);
      return;
    }

    const pageStyle = computedStyleFor(element);
    const pageDirection = pageStyle?.direction ?? '';
    const pageAlignment = pageStyle?.textAlign ?? '';
    const directionFlipped =
      this.directionFlipped.get(element) ?? pageDirection.toLowerCase() !== 'rtl';
    this.directionFlipped.set(element, directionFlipped);
    this.markAffected(element);
    this.setElementFont(element, this.settings.improveFont);
    this.styles.apply(element, {
      alignRight: this.settings.alignRight,
      improveFont: this.settings.improveFont,
      overrideDirection: this.needsDirectionOverride(element),
      pageAlignment,
      directionFlipped,
    });
    if (!this.affected.has(element)) {
      this.affected.add(element);
    }
    this.rememberIndependentEditorField(element);
  }

  private needsDirectionOverride(element: HTMLElement): boolean {
    if (this.styles.ownsDirection(element)) return true;
    return computedStyleFor(element)?.direction !== 'rtl';
  }

  private restore(element: HTMLElement): void {
    const editingHost = element.isConnected ? editingHostFor(element) : null;
    if (
      this.active &&
      element.isConnected &&
      (element.tagName === 'INPUT' ||
        element.tagName === 'TEXTAREA' ||
        editingHost === element)
    ) {
      this.rememberIndependentEditorField(element);
    } else {
      this.forgetIndependentEditorField(element);
    }
    this.directionFlipped.delete(element);
    this.affected.delete(element);
    this.unmarkAffected(element);
    this.styles.restore(element);
  }

  private markAffected(element: HTMLElement): void {
    if (element.hasAttribute(AFFECTED_ATTRIBUTE)) return;
    element.setAttribute(AFFECTED_ATTRIBUTE, '');
    this.markedAffected.add(element);
  }

  private unmarkAffected(element: HTMLElement): void {
    this.setElementFont(element, false);
    if (!this.markedAffected.has(element)) return;
    element.removeAttribute(AFFECTED_ATTRIBUTE);
    this.markedAffected.delete(element);
  }

  private setElementFont(element: HTMLElement, enabled: boolean): void {
    if (enabled) {
      if (!element.hasAttribute(FONT_ATTRIBUTE)) {
        element.setAttribute(FONT_ATTRIBUTE, '');
        this.markedFont.add(element);
      }
    } else if (this.markedFont.has(element)) {
      element.removeAttribute(FONT_ATTRIBUTE);
      this.markedFont.delete(element);
    }
  }

  private ensureShadowFontStyle(root: ShadowRoot): void {
    const existing = this.shadowFontStyles.get(root);
    if (existing?.isConnected && existing.getRootNode() === root) return;
    existing?.remove();
    const style = this.document.createElement('style');
    style.setAttribute('data-tayamun-shadow-style-q7m3', '');
    style.textContent = SHADOW_FONT_CSS;
    root.prepend(style);
    this.shadowFontStyles.set(root, style);
  }

  private removeShadowFontStyle(root: ShadowRoot): void {
    this.shadowFontStyles.get(root)?.remove();
    this.shadowFontStyles.delete(root);
  }

  private trackCustomElement(element: Element): void {
    if (!element.localName.includes('-') || element.shadowRoot || this.trackedCustomElements.has(element)) return;
    const registry = this.document.defaultView?.customElements;
    if (!registry) return;

    this.trackedCustomElements.add(element);
    void registry.whenDefined(element.localName).then(
      () => {
        this.trackedCustomElements.delete(element);
        if (!this.active || !element.isConnected || !element.shadowRoot) return;
        this.registerOpenShadowRoot(element.shadowRoot);
      },
      () => {
        this.trackedCustomElements.delete(element);
      },
    );
  }

  private enqueueJob(job: WorkJob): void {
    this.jobs.push(job);
    this.scheduleWork();
  }

  private scheduleWork(): void {
    if (this.runningSynchronously || this.cancelScheduledWork || this.jobs.length === 0) return;
    this.cancelScheduledWork = this.scheduler.schedule(() => {
      this.cancelScheduledWork = undefined;
      this.runSlice();
    });
  }

  private runSlice(): void {
    const startedAt = this.scheduler.now();
    let steps = 0;
    while (
      this.jobs.length > 0 &&
      steps < this.maxStepsPerSlice &&
      this.scheduler.now() - startedAt < this.sliceBudgetMs
    ) {
      const job = this.jobs.shift()!;
      if (!job.step()) this.jobs.push(job);
      steps += 1;
    }
    this.scheduleWork();
  }

  private cancelAllWork(): void {
    this.cancelScheduledWork?.();
    this.cancelScheduledWork = undefined;
    this.jobs.length = 0;
    this.reconcileQueued.clear();
    this.targetJobs.clear();
    this.subtreeJobs.clear();
    this.removedJobs.clear();
    this.editorMutationJobs.clear();
    this.styleRepairQueued.clear();
    this.alignmentRefreshQueued.clear();
    this.independentRefreshQueued.clear();
    this.independentEditorFields = new WeakMap();
    this.independentEditorOwners = new WeakMap();
    this.shadowStyleRepairQueued.clear();
    this.restyleJob = undefined;
    this.fontRestyleJob = undefined;
    clearTimeout(this.subtreeDebounceTimer);
    this.subtreeDebounceTimer = undefined;
    this.debouncedSubtrees.clear();
    this.subtreeDebounceFlushActive = false;
    this.earliestSubtreeDueAt = 0;
  }
}
