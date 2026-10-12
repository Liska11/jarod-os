/*
 * Two panes side by side with a movable divider (the Hermes page: the conversation and what it produced).
 * Pure: the page measures, this decides. The right pane can be dragged away completely; the left one never
 * goes below its minimum.
 */

export interface SplitState {
  /** The share of the row the left pane takes, 0..1 (what it is worth while the right pane is shown). */
  ratio: number
  /** The right pane is hidden and the left one takes the whole row. */
  collapsed: boolean
}

export interface SplitLimits {
  minLeft: number
  minRight: number
  /** Dragging the right pane narrower than this hides it. */
  snapRight: number
}

export const DEFAULT_SPLIT: SplitState = { ratio: 0.45, collapsed: false }

const between = (value: number, low: number, high: number): number => Math.max(low, Math.min(value, high))

/** The widest the left pane may be while the right pane is shown. */
function widestLeft(total: number, limits: SplitLimits): number {
  return Math.max(0, total - limits.minRight)
}

/** The width of the left pane, in pixels, for a row `total` pixels wide. */
export function leftWidth(total: number, state: SplitState, limits: SplitLimits): number {
  if (state.collapsed) {
    return total
  }

  // A row too narrow for both minimums shares them in proportion.
  if (total < limits.minLeft + limits.minRight) {
    return Math.round((total * limits.minLeft) / (limits.minLeft + limits.minRight))
  }

  return Math.round(between(total * state.ratio, limits.minLeft, widestLeft(total, limits)))
}

/** The state after the divider was moved to `left` pixels from the left edge of the row. */
export function dragTo(total: number, left: number, limits: SplitLimits): SplitState {
  if (total <= 0) {
    return DEFAULT_SPLIT
  }

  if (total - left < limits.snapRight) {
    return { ratio: Math.max(0, widestLeft(total, limits)) / total, collapsed: true }
  }

  return { ratio: between(left, limits.minLeft, Math.max(limits.minLeft, widestLeft(total, limits))) / total, collapsed: false }
}

/** The state after the divider was nudged by `delta` pixels (the keyboard); a hidden right pane comes back on the way left. */
export function nudge(total: number, state: SplitState, delta: number, limits: SplitLimits): SplitState {
  if (state.collapsed) {
    return delta < 0 && total > 0 ? { ratio: Math.max(0, widestLeft(total, limits)) / total, collapsed: false } : state
  }

  return dragTo(total, leftWidth(total, state, limits) + delta, limits)
}

/** A stored state, or the default when the stored value is not one. */
export function parseSplit(raw: string | null | undefined): SplitState {
  if (!raw) {
    return DEFAULT_SPLIT
  }

  try {
    const value = JSON.parse(raw) as Partial<SplitState> | null

    if (value && typeof value.ratio === 'number' && Number.isFinite(value.ratio) && value.ratio > 0 && value.ratio <= 1 && typeof value.collapsed === 'boolean') {
      return { ratio: value.ratio, collapsed: value.collapsed }
    }
  } catch {
    // Not JSON: the default.
  }

  return DEFAULT_SPLIT
}
