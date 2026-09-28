"use client";

/**
 * Shared visual shell for every floating composer in this app (added
 * 2026-09-28, per an explicit product request to unify the main chat
 * composer and the report-edit composer under one design system instead
 * of two independently-built ones). This component owns PRESENTATION
 * ONLY - width, radius, shadow, border, backdrop surface, bottom
 * positioning, the non-interactive fade layer behind it, and its
 * z-index. It owns NONE of a composer's business logic or state: the
 * caller supplies its own content as `children` (MainChatComposer,
 * ReportEditComposer/FullscreenEditBar, ...), and this shell never
 * imports or knows about either.
 *
 * Usage contract - this must be rendered as a sibling of the scrollable
 * content it floats over, both inside a shared `relative` (or grid)
 * container that fills the workspace:
 *
 *   <div className="relative flex-1 overflow-hidden">
 *     <div className="h-full overflow-y-auto" style={{ paddingBottom: reserve }}>
 *       ...scrollable content...
 *     </div>
 *     <FloatingComposerShell onMeasure={setReserve} fadeBackground="...">
 *       <MainChatComposer ... />
 *     </FloatingComposerShell>
 *   </div>
 *
 * `onMeasure` reports this shell's own rendered height (composer bar +
 * fade zone) via ResizeObserver, so the caller can reserve exactly that
 * much bottom padding on its scrollable content - the same technique
 * DocumentPanel/StructuredReportView already used for its own composer
 * before this component existed (see FullscreenEditBar's prior
 * `composerReserve` state, now superseded by this shared shell).
 *
 * Deliberately NOT responsible for: message/document content, scroll
 * behavior of the content itself, or any composer-specific state (text
 * value, attachments, voice, edit targets). Two composers that use this
 * shell share its look, never each other's state.
 */

import React, { useEffect, useRef } from "react";
import { Z } from "./zIndex";
import { LiquidGlassSurface } from "./LiquidGlassSurface";

export interface FloatingComposerShellProps {
  children: React.ReactNode;
  /**
   * Optional secondary content rendered BELOW the rounded composer bar,
   * still inside the same floating/centered column, but WITHOUT the
   * bar's own border/shadow/background - quiet chips and pills, not a
   * second "giant rounded rectangle" competing with the composer (see
   * MainChatComposer's active-review chip and Cloud/Local pill row).
   * Omit for a composer that's just the one bar (e.g. the report-edit
   * composer).
   */
  belowChildren?: React.ReactNode;
  /**
   * Called with the shell's own total rendered height (bar + fade zone +
   * belowChildren, i.e. the full floating stack) whenever it changes, so
   * the caller can reserve that much bottom padding on its scrollable
   * content. Omit if the caller handles its own spacing.
   */
  onMeasure?: (height: number) => void;
  /**
   * The solid color the fade gradient ends on - must match whatever's
   * actually behind it in that workspace (the main chat column's warm
   * paper tone vs. the document panel's neutral-100 body), or the fade
   * reads as a visible seam instead of a smooth disappearance.
   */
  fadeBackground: string;
  /**
   * Desktop cap on the floating stack's width, in px (not a className -
   * see the centering-fix comment above the component below for why).
   * Default matches the 2026-09-28 visual-redesign brief's 720-760px
   * target - narrower than this component's original 680-820px range,
   * which read as "almost full-width" on a normal desktop viewport.
   * Below `maxWidthPx + 32`, the stack fills the workspace minus a
   * fixed 16px each side (`calc(100% - 32px)`) instead.
   */
  maxWidthPx?: number;
  /** Extra classes merged onto the composer bar's own rounded shell (background/border color differs slightly between the two composers). Ignored when `bare` is true. */
  barClassName?: string;
  /**
   * Opt-in: 2026-09-28 Liquid Glass proof of concept
   * (components/chat/LiquidGlassSurface.tsx - read its file header before
   * enabling this anywhere else). When true and `!bare`, the bar surface
   * is rendered by the WebGL glass runtime instead of the plain
   * translucent CSS div, falling back automatically (same visual
   * classes) when WebGL/glass is unsupported, disabled via
   * `?liquidGlass=off`, or still loading. Default false - deliberately
   * NOT wired to every FloatingComposerShell caller, only the main chat
   * composer for now.
   */
  glass?: boolean;
  /**
   * When true, the shell renders NO chrome of its own around `children`
   * (no rounded-[28px]/border/bg/shadow/backdrop-blur) - only the
   * structural wrapper (centering, max width, pointer-events split,
   * positioning, z-index). Use this when the composer being wrapped
   * already supplies its own fully-styled card (e.g. the report editor's
   * FullscreenEditBar, which uses this app's --paper-raised/--rule
   * document tokens rather than the main chat composer's generic
   * white/90 style) - the shell still owns WHERE it floats and HOW it
   * fades, just not what its card looks like.
   */
  bare?: boolean;
  /** Px from the bottom of the workspace to the composer bar. Product brief: 20-28px. */
  bottomOffsetPx?: number;
  /** Height of the fade zone in px. Product brief: 120-180px. */
  fadeHeightPx?: number;
  /**
   * When false, the shell stays mounted (so a composer with its own
   * internal state - e.g. FullscreenEditBar's in-progress instruction
   * text, or an open alternatives popup - survives being "closed" and
   * reopened) but is hidden and non-interactive. Default true. Distinct
   * from actually unmounting `children`.
   */
  visible?: boolean;
}

export function FloatingComposerShell({
  children,
  belowChildren,
  onMeasure,
  fadeBackground,
  maxWidthPx = 760,
  barClassName = "",
  glass = false,
  bare = false,
  bottomOffsetPx = 20,
  fadeHeightPx = 130,
  visible = true,
}: FloatingComposerShellProps) {
  const wrapRef = useRef<HTMLDivElement>(null);

  // Reports the shell's own height (fade zone height, which is fixed, PLUS
  // however much the composer bar itself grows past the fade zone via
  // bottomOffsetPx - i.e. the true bottom-to-top extent of this whole
  // layer) so the caller can reserve exactly enough scroll padding. Fires
  // on mount and on every resize (composer growing for an attachment
  // list, a popup, textarea autosize, etc.) - the same ResizeObserver
  // technique DocumentPanel's composerReserve used before this shell
  // existed.
  useEffect(() => {
    if (!onMeasure || !wrapRef.current) return;
    const el = wrapRef.current;
    const measure = () => onMeasure(el.getBoundingClientRect().height + bottomOffsetPx);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onMeasure, bottomOffsetPx]);

  return (
    <div className={visible ? undefined : "hidden"}>
      {/* Fade layer - non-interactive, sits behind the composer bar so
          content appears to pass underneath it and fade out rather than
          hit a hard rectangular wall. A sibling of the bar (not a parent),
          so it can have its own fixed height independent of the bar's
          actual (possibly-taller, e.g. with an attachment list) height. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0"
        style={{
          height: fadeHeightPx,
          zIndex: Z.BOTTOM_FADE,
          background: `linear-gradient(to top, ${fadeBackground} 0%, ${fadeBackground} 42%, transparent 100%)`,
          backdropFilter: "blur(1px)",
          WebkitBackdropFilter: "blur(1px)",
        }}
      />

      {/* Positioning layer - spans the workspace edge to edge
          (inset-x-0), but owns NO width/centering of its own beyond
          that. Its containing block is whatever `position: relative`
          ancestor the caller supplies (see this component's usage
          contract above) - the chat column or report body, never the
          viewport - so this naturally stays scoped to that workspace
          even while a sidebar or the other panel changes its width. */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0"
        style={{ paddingBottom: bottomOffsetPx, zIndex: Z.FLOATING_COMPOSER }}
      >
        {/* FloatingComposerStack - the ONE element that owns width and
            centering for everything that floats (composer bar +
            belowChildren metadata). 2026-09-28 centering fix: previously
            the bar and belowChildren were each independently
            `w-full` + a shared max-width className, centered as siblings
            by the parent's `items-center` - two boxes that happened to
            agree on width rather than one box guaranteeing it. Now there
            is exactly one width, set here with the literal formula
            `min(maxWidthPx, workspace width - 32px)` and centered with
            `margin-inline: auto` (container-relative - never
            `left: 50%; transform: translateX(-50%)`, which would be
            wrong the moment this were ever positioned against something
            other than a same-workspace `relative` ancestor). Everything
            below is simply width: 100% of this, so the composer and the
            "Answers from" row underneath it can never drift apart. */}
        <div
          ref={wrapRef}
          className="pointer-events-none flex flex-col items-stretch gap-1.5"
          style={{ width: `min(${maxWidthPx}px, calc(100% - 32px))`, marginInline: "auto" }}
        >
          {glass && !bare ? (
            // 2026-09-28 Liquid Glass PoC - identical visual classes to
            // the plain-CSS branch below, passed as the fallback so
            // loading/unsupported/`?liquidGlass=off` states are
            // pixel-identical to what already shipped.
            <LiquidGlassSurface
              outerClassName="pointer-events-auto w-full"
              fallbackVisualClassName={
                "rounded-[26px] bg-[rgba(251,249,245,0.9)] shadow-[0_3px_16px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.04] backdrop-blur-xl " +
                barClassName
              }
              type="pill"
              tintOpacity={0.14}
            >
              {children}
            </LiquidGlassSurface>
          ) : (
            <div
              className={
                "pointer-events-auto w-full " +
                (bare
                  ? ""
                  : // One clean floating surface, not a container-around-a-container:
                    // no outer border (a hairline `ring` stands in for the "very
                    // subtle 1px internal stroke" the 2026-09-28 visual-redesign
                    // brief allows, since the warm-on-warm translucent fill needs
                    // *some* definition against a similarly warm page background),
                    // a tight/soft elevation shadow instead of the old wide diffuse
                    // one, and a warm-neutral fill (matches --paper-raised) instead
                    // of generic white.
                    "rounded-[26px] bg-[rgba(251,249,245,0.9)] shadow-[0_3px_16px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.04] backdrop-blur-xl " +
                    barClassName)
              }
            >
              {children}
            </div>
          )}
          {belowChildren && (
            <div className="pointer-events-auto flex w-full flex-col items-center gap-1.5">
              {belowChildren}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default FloatingComposerShell;
