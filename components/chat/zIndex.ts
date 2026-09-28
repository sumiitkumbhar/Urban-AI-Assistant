/**
 * Explicit z-index scale for the chat/document split view (ChatInterface.tsx
 * + DocumentPanel.tsx). Added 2026-09-28 per an explicit product request:
 * "establish an explicit layering system instead of continually increasing
 * random z-index values." Every stacking z-index anywhere in that split
 * view should come from this object, not a bare Tailwind z-* class chosen
 * ad hoc - that's what let a panel-edge control end up with more z-index
 * than it needed and paint over the report header in the first place.
 *
 * Ordering rationale (lowest to highest):
 *  - PAGE_CONTENT: the ordinary scrollable content of either column (chat
 *    messages, report body). Establishes nothing above its own siblings.
 *  - PANEL_CONTENT: reserved for a panel's own in-flow body content that
 *    needs to sit above PAGE_CONTENT within the SAME column (currently
 *    unused directly, kept for parity with the product brief's scale and
 *    as the natural slot for any future panel-body overlay).
 *  - PANEL_HEADER: a panel's header/tab row (DocumentPanel's title bar and
 *    Report/Document tabs). Higher than page content so a panel's own
 *    header always wins against anything scrolling underneath it, but
 *    still well below the floating composer/fade layers, which belong to
 *    a different column entirely and must never be out-ranked by a
 *    header.
 *  - BOTTOM_FADE: the non-interactive gradient/blur layer behind a
 *    floating composer (see FloatingComposerShell). Sits above ordinary
 *    content so the fade reads correctly, below the composer itself.
 *  - FLOATING_COMPOSER: the floating input bar (main chat and report
 *    edit) - FloatingComposerShell's own root.
 *  - REVISION_CHOOSER: transient popovers anchored to the composer or a
 *    report block (undo/redo history, alternatives picker).
 *  - POPOVER: any other intentional, explicitly-triggered popover/menu
 *    (dropdowns, tooltips) - the top of the scale by design, never a
 *    catch-all for "make this show up."
 */
export const Z = {
  PAGE_CONTENT: 1,
  PANEL_CONTENT: 10,
  PANEL_HEADER: 20,
  BOTTOM_FADE: 30,
  FLOATING_COMPOSER: 40,
  REVISION_CHOOSER: 50,
  POPOVER: 60,
  // Added 2026-09-28, live-diagnostic overlap-bug fix: the report panel's
  // fullscreen mode. Confirmed via a live diagnostic build that fullscreen
  // was implemented as `width: 100%` inside the SAME flex row as the
  // sidebar/chat column, so those never actually left the layout - they
  // just got squeezed into a near-zero-width sliver, and the chat
  // column's own absolutely-positioned floating composer (still measured
  // and placed relative to that squeezed sliver) rendered as a visible
  // strip bleeding out at the edge, painting over the "fullscreen"
  // report's own header/tabs/edit composer. The real fix is structural,
  // not a z-index bump: fullscreen now renders via `fixed inset-0`
  // (DocumentPanel.tsx), a true viewport-covering overlay OUTSIDE the
  // flex row entirely, so the sidebar/chat column and everything
  // positioned relative to them are fully covered regardless of the
  // row's own width math. This tier exists so that overlay's own
  // z-index is still drawn from the shared scale instead of a bare
  // number, and sits above every other layer here by design - it is
  // meant to eclipse the entire rest of the app, not just out-rank one
  // sibling.
  FULLSCREEN_OVERLAY: 70,
} as const;

export type ZLayer = keyof typeof Z;
