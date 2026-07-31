export interface TayamunStyleOptions {
  alignRight: boolean;
  improveFont: boolean;
  overrideDirection: boolean;
  /** Computed `text-align` of the block, read before this class owns it. */
  pageAlignment: string;
  /** Whether Tayamun changed the block's page direction from LTR to RTL. */
  directionFlipped: boolean;
}

type OwnedProperty = 'direction' | 'unicode-bidi' | 'text-align' | 'font-family';

interface PropertyState {
  originalPriority: string;
  originalValue: string;
  desiredValue: string;
}

interface ElementState {
  hadStyleAttribute: boolean;
  alignRight: boolean;
  preserveAlignment: boolean;
  directionFlipped: boolean;
  correctPhysicalLeft: boolean;
  properties: Map<OwnedProperty, PropertyState>;
}

const DIRECTION_PROPERTIES: Readonly<Record<'direction' | 'unicode-bidi', string>> = {
  direction: 'rtl',
  'unicode-bidi': 'isolate',
};

const PROTECTED_ALIGNMENTS = new Set([
  'center',
  '-webkit-center',
  '-moz-center',
  'justify',
  'justify-all',
]);

// `left` is a physical keyword an author wrote for a left-to-right page. Once the
// block reads right-to-left it pins the text to the end edge, which is the defect
// a reader sees as "nothing happened". Logical `start`/`end` need no correction.
const PHYSICAL_LEFT_ALIGNMENTS = new Set(['left', '-webkit-left', '-moz-left']);

export class OwnedStyles {
  private readonly states = new Map<HTMLElement, ElementState>();
  private pendingStyleMutations = new WeakMap<HTMLElement, number>();

  apply(element: HTMLElement, options: TayamunStyleOptions): void {
    const correctPhysicalLeft =
      options.directionFlipped && PHYSICAL_LEFT_ALIGNMENTS.has(options.pageAlignment.toLowerCase());
    let state = this.states.get(element);
    if (
      !state &&
      !options.overrideDirection &&
      !options.alignRight &&
      !options.improveFont &&
      !correctPhysicalLeft
    ) {
      return;
    }
    if (!state) {
      state = {
        hadStyleAttribute: element.hasAttribute('style'),
        alignRight: options.alignRight,
        directionFlipped: options.directionFlipped,
        preserveAlignment: false,
        correctPhysicalLeft,
        properties: new Map(),
      };
      this.states.set(element, state);
    } else {
      state.alignRight = options.alignRight;
      state.directionFlipped = options.directionFlipped;
      // Only trust the reported alignment while the page still owns the property;
      // afterwards the computed value is this class's own declaration.
      if (!state.properties.has('text-align')) state.correctPhysicalLeft = correctPhysicalLeft;
    }

    if (options.alignRight && !state.properties.has('text-align')) {
      // Read computed alignment only when the option needs it. This avoids a
      // forced style calculation for every block during ordinary/font-only scans.
      state.preserveAlignment = this.hasProtectedAlignment(element);
    }

    const desired = new Map<OwnedProperty, string>();
    if (options.overrideDirection) {
      for (const [property, value] of Object.entries(DIRECTION_PROPERTIES) as [OwnedProperty, string][]) {
        desired.set(property, value);
      }
    }
    if ((options.alignRight && !state.preserveAlignment) || state.correctPhysicalLeft) {
      desired.set('text-align', 'right');
    }
    if (options.improveFont) desired.set('font-family', '"Tajawal Tayamun", Tajawal, sans-serif');

    for (const property of [...state.properties.keys()]) {
      if (!desired.has(property)) this.restoreProperty(element, state, property);
    }

    for (const [property, desiredValue] of desired) {
      let propertyState = state.properties.get(property);
      if (!propertyState) {
        propertyState = {
          originalValue: element.style.getPropertyValue(property),
          originalPriority: element.style.getPropertyPriority(property),
          desiredValue,
        };
        state.properties.set(property, propertyState);
      } else {
        propertyState.desiredValue = desiredValue;
      }

      this.writeDesired(element, property, propertyState);
    }
  }

  /**
   * Reconciles page-authored changes to an inline style while Tayamun owns one
   * or more declarations. Mutations caused by our own writes are ignored because
   * their current value already equals the desired declaration.
   */
  consumeOwnStyleMutation(element: HTMLElement): boolean {
    const pending = this.pendingStyleMutations.get(element) ?? 0;
    if (pending === 0) return false;
    if (pending === 1) this.pendingStyleMutations.delete(element);
    else this.pendingStyleMutations.set(element, pending - 1);
    return true;
  }

  needsRepair(element: HTMLElement): boolean {
    const state = this.states.get(element);
    if (!state) return false;
    for (const [property, propertyState] of state.properties) {
      if (
        element.style.getPropertyValue(property) !== propertyState.desiredValue ||
        element.style.getPropertyPriority(property) !== 'important'
      ) {
        return true;
      }
    }
    return false;
  }

  handleStyleMutation(element: HTMLElement): void {
    const state = this.states.get(element);
    if (!state) return;

    const changed: [OwnedProperty, PropertyState][] = [];
    const pageHadStyleAttribute = element.hasAttribute('style');
    for (const [property, propertyState] of state.properties) {
      const currentValue = element.style.getPropertyValue(property);
      const currentPriority = element.style.getPropertyPriority(property);
      if (currentValue === propertyState.desiredValue && currentPriority === 'important') continue;

      // The page replaced or removed the declaration. Remember its latest intent,
      // then keep the extension override active until the block is restored.
      propertyState.originalValue = currentValue;
      propertyState.originalPriority = currentPriority;
      if (property === 'text-align') {
        // The page just restated its own intent, so both alignment verdicts are
        // derived again from the value it wrote.
        const alignment = this.computedAlignment(element);
        state.preserveAlignment = PROTECTED_ALIGNMENTS.has(alignment);
        state.correctPhysicalLeft =
          state.directionFlipped && PHYSICAL_LEFT_ALIGNMENTS.has(alignment);
      }
      changed.push([property, propertyState]);
    }

    if (changed.length === 0) return;
    state.hadStyleAttribute = pageHadStyleAttribute;
    for (const [property, propertyState] of changed) this.writeDesired(element, property, propertyState);
  }

  refreshAlignment(element: HTMLElement): boolean {
    const state = this.states.get(element);
    const direction = state?.properties.get('direction');
    const alignment = state?.properties.get('text-align');
    for (const [property, propertyState] of [
      ['direction', direction],
      ['text-align', alignment],
    ] as const) {
      if (!propertyState) continue;
      this.recordStyleWrite(element);
      if (propertyState.originalValue) {
        element.style.setProperty(property, propertyState.originalValue, propertyState.originalPriority);
      } else {
        element.style.removeProperty(property);
      }
    }

    const pageStyle = element.ownerDocument.defaultView?.getComputedStyle(element);
    const pageDirection = (pageStyle?.direction ?? '').toLowerCase();
    const pageAlignment = (pageStyle?.textAlign ?? '').toLowerCase();
    const directionFlipped = pageDirection !== 'rtl';
    if (!state) return directionFlipped;

    state.directionFlipped = directionFlipped;
    state.preserveAlignment = PROTECTED_ALIGNMENTS.has(pageAlignment);
    state.correctPhysicalLeft =
      directionFlipped && PHYSICAL_LEFT_ALIGNMENTS.has(pageAlignment);
    if (direction) this.writeDesired(element, 'direction', direction);
    if (!alignment) return directionFlipped;

    if ((state.alignRight && !state.preserveAlignment) || state.correctPhysicalLeft) {
      this.writeDesired(element, 'text-align', alignment);
    } else {
      state.properties.delete('text-align');
    }
    return directionFlipped;
  }

  restore(element: HTMLElement): void {
    const state = this.states.get(element);
    if (!state) return;

    this.states.delete(element);
    for (const property of [...state.properties.keys()]) {
      this.restoreProperty(element, state, property);
    }

    if (!state.hadStyleAttribute && element.style.length === 0 && element.hasAttribute('style')) {
      this.recordStyleWrite(element);
      element.removeAttribute('style');
    }
  }

  restoreAll(): void {
    for (const element of [...this.states.keys()]) this.restore(element);
    this.discardPendingStyleMutations();
  }

  discardPendingStyleMutations(): void {
    this.pendingStyleMutations = new WeakMap();
  }

  discardAll(): void {
    this.states.clear();
    this.discardPendingStyleMutations();
  }

  owns(element: HTMLElement): boolean {
    return this.states.has(element);
  }

  ownsDirection(element: HTMLElement): boolean {
    const state = this.states.get(element);
    return state?.properties.has('direction') === true;
  }

  private hasProtectedAlignment(element: HTMLElement): boolean {
    return PROTECTED_ALIGNMENTS.has(this.computedAlignment(element));
  }

  private computedAlignment(element: HTMLElement): string {
    return (element.ownerDocument.defaultView?.getComputedStyle(element).textAlign ?? '').toLowerCase();
  }

  private writeDesired(element: HTMLElement, property: OwnedProperty, state: PropertyState): void {
    if (
      element.style.getPropertyValue(property) === state.desiredValue &&
      element.style.getPropertyPriority(property) === 'important'
    ) {
      return;
    }

    this.recordStyleWrite(element);
    element.style.setProperty(property, state.desiredValue, 'important');
  }

  private recordStyleWrite(element: HTMLElement): void {
    this.pendingStyleMutations.set(element, (this.pendingStyleMutations.get(element) ?? 0) + 1);
  }

  private restoreProperty(element: HTMLElement, state: ElementState, property: OwnedProperty): void {
    const propertyState = state.properties.get(property);
    if (!propertyState) return;

    state.properties.delete(property);
    this.recordStyleWrite(element);
    if (propertyState.originalValue) {
      element.style.setProperty(property, propertyState.originalValue, propertyState.originalPriority);
    } else {
      element.style.removeProperty(property);
    }
  }
}
