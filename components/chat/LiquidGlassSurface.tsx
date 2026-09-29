"use client";

/**
 * Thin React wrapper around a vendored copy of dashersw/liquid-glass-js's
 * `Container` class (public/vendor/liquid-glass/container.js - see that
 * file's header for the two small patches made to it). Added 2026-09-28
 * as an ISOLATED PROOF OF CONCEPT scoped to exactly one surface: the main
 * floating chat composer bar (FloatingComposerShell's `glass` prop,
 * wired only at its ChatInterface.tsx call site, gated behind
 * `FEATURES.liquidGlassComposer`). Not used anywhere else yet - not the
 * report-edit composer, not the voice button, not popovers - per explicit
 * product direction: prove this one surface out first.
 *
 * === Why this exists as a wrapper instead of using the library directly ===
 * The upstream library is script-tag-oriented vanilla JS with no
 * npm/ESM packaging (see its own README roadmap: "Bundle for NPM",
 * "TypeScript rewrite", "React/Vue component wrappers" are all still
 * unchecked). This component owns everything the brief asked for:
 * dynamic script loading (once, cached, shared across instances),
 * feature/support detection with a plain-CSS fallback, resize handling
 * (the library has none of its own), WebGL lifecycle + best-effort
 * cleanup on unmount, and a debug mode for confirming the effect is
 * really rendering before tuning it down to something subtle.
 *
 * === What benchmarking this PoC found (read before enabling elsewhere) ===
 * 1. STALE BACKGROUND SNAPSHOT: `Container.pageSnapshot` is a single
 *    `html2canvas(document.body)` capture, taken ONCE for the whole page
 *    session (cached as a static class field) and never retaken - not on
 *    scroll, not when chat messages stream in behind the composer. The
 *    refraction you see is always a snapshot of whatever the page looked
 *    like at the moment the FIRST glass surface anywhere on the page was
 *    created, not live content. For a composer that floats over a
 *    constantly-updating chat feed, this is a real, inherent limitation
 *    of the library, not a bug in this wrapper.
 * 2. NO RESIZE HANDLING: the library never listens for `resize` or uses
 *    a `ResizeObserver`. This wrapper adds both (see the effect below)
 *    and manually calls `updateSizeFromDOM()` + `render()` so the glass
 *    canvas stays sized/positioned correctly when the sidebar toggles or
 *    the window resizes - without this, the effect visibly desyncs from
 *    the real composer bounds the moment either changes.
 * 3. NO CLEANUP/DESTROY: neither `Container` nor `Button` has a
 *    destroy method anywhere in the source. `startRenderLoop()` installs
 *    a `window.addEventListener('scroll', ...)` closure that captures
 *    `this` (and therefore the WebGL context) forever - there is no way
 *    to remove it from outside the class without reaching into private
 *    internals. This wrapper does the best it can on unmount (detaches
 *    the DOM node, drops our own ref), but the scroll listener and its
 *    GL context genuinely leak for the rest of the page's life. Repeated
 *    mount/unmount cycles (e.g. navigating between chats) will
 *    accumulate live WebGL contexts - most browsers cap the number of
 *    simultaneous WebGL contexts per page (commonly ~8-16) and start
 *    silently losing the oldest ones once that cap is hit. This is the
 *    single biggest reason NOT to spread this to more surfaces without
 *    upstream adding real cleanup.
 * 4. WEBGL1, NOT WEBGL2: the README's browser-support table claims
 *    "WebGL 2.0", but the code calls `canvas.getContext('webgl', ...)` -
 *    that's the WebGL1 API. Support detection below checks for `webgl`
 *    accordingly, not `webgl2`.
 * 5. NO devicePixelRatio SCALING: `canvas.width`/`canvas.height` are set
 *    to the CSS pixel size directly, with no `* devicePixelRatio`
 *    anywhere in the source. On a Retina/2x display the WebGL layer
 *    renders at half the effective resolution of the crisp DOM content
 *    stacked above it - acceptable (even fitting) for a soft-blur glass
 *    look, but worth knowing if the refraction ever looks softer than
 *    expected.
 * 6. The uncapped-per-frame-render-loop risk flagged before this PoC was
 *    built lives in `Button.startNestedRenderLoop()` (button.js, NOT
 *    vendored here) - only triggered when a `Button` instance is added
 *    as a nested child of a `Container`. This PoC deliberately never
 *    instantiates `Button` (the composer's own icon buttons are plain
 *    React/DOM, added to the glass Container as an ordinary
 *    `{element: ...}` child, not a glass Button), so it does NOT hit
 *    that render loop. `Container`'s own render loop (see container.js)
 *    only redraws once at init and again on `window scroll` events - it
 *    is NOT continuous, which is a much lighter runtime cost than the
 *    Button path.
 * 7. HONESTY-CLAUSE FINDING (2026-09-29): with `?liquidGlassDebug=1` (every
 *    shader parameter exaggerated ~2x, see readDebugParam/glassControls
 *    below) live against real chat content scrolled behind the composer,
 *    the WebGL refraction was visually indistinguishable from the plain
 *    CSS frosted-glass material this component now always layers underneath
 *    it (`materialClassName`, see the render logic below, which now applies
 *    it unconditionally) - same near-imperceptible ghosting, no visible
 *    edge distortion or rim highlight beyond what the CSS material alone
 *    produces. Combined
 *    with points 1-5 above, this is why `FEATURES.liquidGlassComposer`
 *    (ChatInterface.tsx) now defaults to false: the CSS material is the
 *    shipped default, and this component - and the WebGL path through it -
 *    is kept as an opt-in (`?liquidGlass=on`) for a future revisit, not
 *    deleted, per this codebase's "dead but type-correct code stays,
 *    documented" convention.
 */

import React, { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    Container?: new (options: {
      borderRadius?: number;
      type?: "rounded" | "circle" | "pill";
      tintOpacity?: number;
    }) => LiquidGlassContainerInstance;
    glassControls?: Record<string, number>;
    html2canvas?: unknown;
  }
}

interface LiquidGlassContainerInstance {
  element: HTMLDivElement;
  addChild: (child: { element: HTMLElement }) => void;
  updateSizeFromDOM: () => void;
  render?: () => void;
}

export type LiquidGlassStatus = "loading" | "active" | "unsupported" | "error";

const CONTAINER_SCRIPT_SRC = "/vendor/liquid-glass/container.js";

let scriptLoadPromise: Promise<void> | null = null;

/** Loads html2canvas (already an npm dependency in this repo - bundled, not CDN-fetched) as `window.html2canvas`, then the vendored container.js script, exactly once per page load, shared across every LiquidGlassSurface instance. */
function loadLiquidGlassRuntime(): Promise<void> {
  if (scriptLoadPromise) return scriptLoadPromise;

  scriptLoadPromise = (async () => {
    if (!window.html2canvas) {
      const mod = await import("html2canvas");
      window.html2canvas = mod.default ?? mod;
    }

    if (window.Container) return;

    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector(`script[src="${CONTAINER_SCRIPT_SRC}"]`);
      if (existing) {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error("liquid-glass container.js failed to load")));
        return;
      }
      const script = document.createElement("script");
      script.src = CONTAINER_SCRIPT_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("liquid-glass container.js failed to load"));
      document.head.appendChild(script);
    });
  })();

  return scriptLoadPromise;
}

/** Support/opt-out gate, checked once per mount. WebGL1 context creation (see file header - the library uses `getContext('webgl')`, not `webgl2`) + `prefers-reduced-motion` + an explicit `?liquidGlass=off` escape hatch for the side-by-side fallback comparison this PoC needs to produce. */
function evaluateSupport(): { supported: boolean; forcedOff: boolean } {
  if (typeof window === "undefined") return { supported: false, forcedOff: false };

  const params = new URLSearchParams(window.location.search);
  if (params.get("liquidGlass") === "off") return { supported: false, forcedOff: true };

  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return { supported: false, forcedOff: false };
  }

  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl");
    return { supported: !!gl, forcedOff: false };
  } catch {
    return { supported: false, forcedOff: false };
  }
}

/** `?liquidGlassDebug=1` (or the `debug` prop) exaggerates every shader parameter well past "subtle" so the effect is unmistakable - read once, before the Container is constructed, since the vendored `setupShader()` bakes `window.glassControls` into GL uniforms only at init time (it is not re-read per frame). Reload the page with the param to flip it; this is intentionally a load-time toggle, not a live slider. */
function readDebugParam(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("liquidGlassDebug") === "1";
}

export interface LiquidGlassSurfaceProps {
  children: React.ReactNode;
  /** Always-applied structural classes (layout/positioning) - kept regardless of glass/fallback state. */
  outerClassName?: string;
  /**
   * 2026-09-29 renamed from `fallbackVisualClassName`: this is no longer
   * just a fallback. It is the CSS frosted-glass material (translucent
   * fill, blur, border, top-highlight - see app/globals.css's
   * `.uaa-glass-pill`) applied UNCONDITIONALLY - while the glass runtime is
   * still loading, as the permanent look when WebGL/glass is unsupported or
   * disabled, AND (Part 8 of the 2026-09-29 material-pass brief) layered
   * underneath the WebGL canvas when it IS active, so the canvas only ever
   * adds refraction on top of real glass-like translucency instead of being
   * the sole visual signal (which the honesty-clause finding in this file's
   * header, point 7, found was not enough on its own).
   */
  materialClassName: string;
  type?: "rounded" | "circle" | "pill";
  borderRadius?: number;
  tintOpacity?: number;
  /** Force debug (exaggerated) parameters regardless of the `?liquidGlassDebug=1` URL param. */
  debug?: boolean;
  /**
   * 2026-09-29 glass-blur-bounds debug aid (see FloatingComposerShell's
   * `readComposerOutlineDebugParam`, which computes this from
   * `?composerDebug=1`). When true, outlines this surface's own host div
   * (green - "composer rect"), the glass runtime's `.glass-container`
   * element (blue - "glass host rect"), and its canvas (red -
   * "blur/canvas rect") so the three can be visually compared: if red
   * extends past green/blue, the blur region is bigger than the
   * composer. Purely visual (outline, not border - adds no layout), and
   * only takes effect at mount (matches `debug`'s own load-time-only
   * semantics above).
   */
  debugOutline?: boolean;
  onStatusChange?: (status: LiquidGlassStatus) => void;
}

export function LiquidGlassSurface({
  children,
  outerClassName = "",
  materialClassName,
  type = "pill",
  borderRadius = 26,
  tintOpacity = 0.14,
  debug = false,
  debugOutline = false,
  onStatusChange,
}: LiquidGlassSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<LiquidGlassContainerInstance | null>(null);
  const [status, setStatus] = useState<LiquidGlassStatus>("loading");

  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  useEffect(() => {
    let cancelled = false;
    const { supported, forcedOff } = evaluateSupport();

    if (!supported) {
      setStatus(forcedOff ? "unsupported" : "unsupported");
      return;
    }
    if (!hostRef.current || !contentRef.current) return;

    const useDebug = debug || readDebugParam();

    loadLiquidGlassRuntime()
      .then(() => {
        if (cancelled || !window.Container || !hostRef.current || !contentRef.current) return;

        window.glassControls = useDebug
          ? {
              blurRadius: 12,
              edgeIntensity: 0.05,
              rimIntensity: 0.18,
              baseIntensity: 0.035,
              edgeDistance: 0.15,
              rimDistance: 0.8,
              baseDistance: 0.1,
              cornerBoost: 0.05,
              rippleEffect: 0.2,
            }
          : {
              // Restrained/"Apple-like": visible enough to read as glass,
              // subtle enough not to fight the text/icons above it.
              blurRadius: 6,
              edgeIntensity: 0.016,
              rimIntensity: 0.06,
              baseIntensity: 0.012,
              edgeDistance: 0.15,
              rimDistance: 0.8,
              baseDistance: 0.1,
              cornerBoost: 0.02,
              rippleEffect: 0.08,
            };

        const instance = new window.Container({ borderRadius, type, tintOpacity });
        instanceRef.current = instance;

        // CRITICAL, and the actual root cause of a real bug found via
        // live measurement (getBoundingClientRect on the canvas vs. its
        // parent) after this PoC first shipped: the vendored container.js
        // was written assuming upstream's OWN glass.css is also loaded
        // (`.glass-container { position: relative; ... }`), which this
        // wrapper never does - we only vendor the JS. Without it,
        // `.glass-container`'s `position` computes as the browser default
        // `static`, so the canvas's `position:absolute; left:0; top:0`
        // (set inline by createElement(), see container.js) resolves
        // against a DIFFERENT, further-up positioned ancestor instead of
        // this element - the canvas (the visible glass pill) then renders
        // measurably offset from the real composer bounds while the
        // actual DOM controls (icons/textarea, laid out normally) stay
        // put, i.e. exactly the "glass surface detached from the icons"
        // symptom. `position: relative` is the one rule from glass.css
        // that is functionally required, not just cosmetic (the other
        // glass-container rules - flex/padding/gap/aspect-ratio - are for
        // the library's own demo layout and are correctly neutralized
        // below, not restored).
        instance.element.style.position = "relative";
        // Neutralize the library's own opinionated `.glass-container`
        // CSS (flex + 10px padding + 20px gap, meant for the library's
        // own demo layout) - our content div already supplies its own
        // flex/padding/gap (MainChatComposerBar's `flex items-center
        // gap-2 p-2`), so this would otherwise double up spacing.
        instance.element.style.padding = "0";
        instance.element.style.gap = "0";
        instance.element.style.width = "100%";

        hostRef.current.appendChild(instance.element);
        instance.addChild({ element: contentRef.current });

        setStatus("active");
      })
      .catch((err) => {
        console.error("[LiquidGlassSurface] failed to initialize", err);
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
      // Best-effort cleanup - see file header point 3. This does NOT
      // stop the library's internal `window scroll` listener or free its
      // WebGL context; it only detaches the DOM node so nothing visible
      // remains and our own reference is dropped.
      const instance = instanceRef.current;
      if (instance?.element?.parentNode) {
        instance.element.parentNode.removeChild(instance.element);
      }
      instanceRef.current = null;
    };
    // Intentionally mount-once: `type`/`borderRadius`/`tintOpacity`/`debug`
    // changing after mount would require tearing down and recreating the
    // whole WebGL instance (no live-update path exists in the vendored
    // library) - out of scope for this PoC, whose props are static at
    // each call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2026-09-29 glass-blur-bounds debug aid (see debugOutline prop doc
  // above). Reactive - not folded into the mount-once init effect above
  // - so it applies correctly even though `debugOutline` typically
  // becomes true one render AFTER this component first mounts (the
  // parent reads `?composerDebug=1` in its own effect, which runs after
  // this child's effects on first paint).
  useEffect(() => {
    if (status !== "active") return;
    const instance = instanceRef.current;
    const canvasEl = instance?.element?.querySelector("canvas") as HTMLCanvasElement | null;
    if (!instance?.element) return;
    if (debugOutline) {
      // Blue = glass host rect (`.glass-container`, i.e. instance.element).
      instance.element.style.outline = "2px solid #3b82f6";
      instance.element.style.outlineOffset = "-3px";
      // Red = blur/canvas rect.
      if (canvasEl) {
        canvasEl.style.outline = "2px solid #ef4444";
        canvasEl.style.outlineOffset = "-6px";
      }
    } else {
      instance.element.style.outline = "";
      instance.element.style.outlineOffset = "";
      if (canvasEl) {
        canvasEl.style.outline = "";
        canvasEl.style.outlineOffset = "";
      }
    }
  }, [debugOutline, status]);

  // The library has no resize/ResizeObserver handling of its own (file
  // header point 2) - without this, the glass canvas silently desyncs
  // from the real composer bounds the moment the sidebar toggles or the
  // window resizes.
  useEffect(() => {
    if (status !== "active") return;
    const resync = () => {
      instanceRef.current?.updateSizeFromDOM();
      // updateSizeFromDOM() only pushes new uniforms when width/height
      // actually changed; a resize that only *moves* the composer
      // (sidebar toggling without a width change) needs an explicit
      // render() to refresh u_containerPosition.
      requestAnimationFrame(() => instanceRef.current?.render?.());
    };
    const ro = new ResizeObserver(resync);
    if (contentRef.current) ro.observe(contentRef.current);
    window.addEventListener("resize", resync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", resync);
    };
  }, [status]);

  // 2026-09-29: always applied now, not gated on `status !== "active"` -
  // see `materialClassName`'s own doc comment above (Part 8 of the brief).
  return (
    <div
      ref={hostRef}
      className={`${outerClassName} ${materialClassName}`.trim()}
      style={debugOutline ? { outline: "2px solid #22c55e", outlineOffset: "0px" } : undefined}
    >
      <div ref={contentRef}>{children}</div>
    </div>
  );
}

export default LiquidGlassSurface;
