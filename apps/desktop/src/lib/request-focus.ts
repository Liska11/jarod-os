import { isEditable } from '../store/edit-target.ts'

// V-20: ported from upstream #172 (d1ca5d2, MIT, same lineage).

/**
 * Focus for a request card that has just appeared. A field being typed in keeps the focus, so a key
 * meant for it cannot answer the card; otherwise the card itself takes it, never one of its answers,
 * unless `take` is false. The returned function, for when the card goes, gives the focus back to where
 * it last came into the card from, unless the person has since put it somewhere else.
 */
export function takeRequestFocus(card: HTMLElement, { take = true }: { take?: boolean } = {}): () => void {
  let before = document.activeElement
  const cameFrom = (event: FocusEvent) => {
    const from = event.relatedTarget

    if (from instanceof HTMLElement && !card.contains(from)) {
      before = from
    }
  }

  card.addEventListener('focusin', cameFrom)

  if (take && !isEditable(before) && !card.contains(before)) {
    card.focus({ preventScroll: true })
  }

  return () => {
    card.removeEventListener('focusin', cameFrom)
    const now = document.activeElement
    const lost = now === null || now === document.body || card.contains(now)

    if (lost && before instanceof HTMLElement && before !== document.body && before.isConnected && !card.contains(before)) {
      before.focus({ preventScroll: true })
    }
  }
}
