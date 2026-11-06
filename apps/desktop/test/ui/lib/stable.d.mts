// Types of test/ui/lib/stable.mjs (B-044 §2 layout stability helper for window tests; the unit test
// test/unit/ui/stable-helper.test.ts drives it with a fake page).

/** An element's box as getBoundingClientRect reports it. */
export interface StableBox { x: number; y: number; width: number; height: number }

/** The part of a Playwright page the helper uses. */
export interface StablePage { evaluate(fn: unknown, arg?: unknown): Promise<unknown> }

/** Box of the first element per selector (null when nothing matches), measured in one go. */
export function measureBoxes(page: StablePage, selectors: Iterable<string>): Promise<Array<StableBox | null>>;

/** One line per selector whose box changed by more than `tolerance` px. */
export function layoutChanges(selectors: readonly string[], before: ReadonlyArray<StableBox | null>, after: ReadonlyArray<StableBox | null>, tolerance?: number): string[];

/** Runs `action` and fails when any of `selectors` moved or resized by more than `tolerance` px (every selector must match before). */
export function expectStable(page: StablePage, selectors: Iterable<string>, action: () => unknown, options?: { tolerance?: number }): Promise<{ before: StableBox[]; after: StableBox[] }>;
