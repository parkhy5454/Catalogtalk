// Mobile keyboard helper: when an input gains focus, scroll it into the
// visible area so the on-screen keyboard does not cover it.
// Pair with <meta name="viewport" ... interactive-widget=resizes-content> (set in app/layout.tsx).
export function scrollIntoViewOnFocus(e: { currentTarget: HTMLElement }) {
  const el = e.currentTarget
  window.setTimeout(() => {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, 300)
}
