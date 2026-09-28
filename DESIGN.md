# DESIGN.md

The design language for Urban AI Assistant. `PROJECT_STATE.md` says how the
project is built; this says how it should look and feel. Any agent or person
generating UI here reads this first.

Concept: github.com/VoltAgent/awesome-design-md. Discipline: Leonxlnx/taste-skill
and vercel-labs/web-interface-guidelines.

---

## Brand read

A document-grounded assistant for UK planning and building regulations. The
people using it are checking whether something is allowed, and they need to
trust the answer enough to act on it. So the surface should feel like a good
reference publication — warm, quiet, authoritative, unhurried — not like a
consumer AI product.

**Warm paper, ink, and hairlines.** Colour lives in the *content* (confidence
scores, source cards, correction notices), never in the chrome. The interface
recedes; the evidence is the thing.

**Explicitly avoid:** violet/blue AI gradients, glassmorphism, glow effects,
three-equal-cards layouts, infinite looping animation, hover-scale-up on
buttons, emoji as UI iconography, and any second accent colour.

## Colour — locked, do not change

The warm-paper ground is deliberate and stays. It is a documented decision,
not a default.

| Token | Value | Role |
|---|---|---|
| `--paper` | `#f7f4ee` | Page ground |
| `--paper-raised` | `#fbf9f5` | Composer, cards — lifted off the ground |
| `--paper-sunken` | `#f2efe7` | Wells, code blocks, insets |
| `--ink` | `#1c1a16` | Primary text, primary button fill |
| `--ink-secondary` | `#4a453c` | Body text |
| `--ink-muted` | `#7a7367` | Metadata, timestamps |
| `--ink-faint` | `#a39b8d` | Placeholders, disabled |
| `--rule` | `rgb(61 52 38 / 0.10)` | Hairline borders |
| `--rule-strong` | `rgb(61 52 38 / 0.18)` | Emphasised borders |
| `--accent` | `#1c1a16` | The accent **is** ink |

**One accent, and it is ink.** No coloured brand button. Semantic colour is
reserved for meaning that must be read at a glance — groundedness, confidence,
errors, the amber correction notice — and nowhere else. A blue CTA on this page
would be the only cool thing in a warm room.

**Never** put a pure-black shadow on this ground; it reads as grey dirt. All
shadows are tinted warm (`shadow-paper-*`, built from `rgb(61 52 38 / …)`).

No dark mode. This is a single-mode surface by decision; the paper metaphor
does not survive inversion. Do not add `dark:` variants piecemeal.

## Typography

**Manrope** (`--font-sans`, via `next/font/google`), 400/500/600/700.

Inter is banned here as the default — it is the reflexive AI choice and reads
as such. Manrope keeps the neutrality a regulatory tool needs while having
actual character at display size.

- Body: `text-sm`/`text-base`, `leading-relaxed`, prose capped at `65ch`
- Headings: tight tracking, `text-wrap: balance`
- Numerals in metrics, timings and scores: `tabular-nums` (the `.tabular`
  class) so values do not jitter as they update
- `…` not `...`; curly quotes; `&nbsp;` in `10 MB`, `⌘ K`
- Loading copy ends in `…`
- **No serif.** Not for "editorial feel", not for emphasis. Emphasis is
  italic or bold of the same family.

## Shape — one system, applied everywhere

| Element | Radius |
|---|---|
| Interactive pills (buttons, chips, composer) | `--r-pill` / `rounded-full` |
| Containers (cards, overlays, panels) | `--r-container` / `rounded-2xl` (16px) |
| Inputs, small chips, code blocks | `--r-control` / `rounded-xl` (12px) |

Mixed radii are only acceptable because this rule exists and is followed. A
square card on a pill-button page is broken, not eclectic.

## Elevation

Low. Structure comes from hairlines and negative space, not from stacked cards.

`shadow-paper-xs` → resting chrome · `-sm` → composer, chips · `-md` → focused
input, hover on primary · `-lg` → overlays only.

Use a card only when elevation communicates real hierarchy. Otherwise group
with `border-t`, `divide-y`, or space.

## Motion

One easing — `--ease-settle` (`cubic-bezier(0.16, 1, 0.3, 1)`) — and one
duration scale: `--t-fast` 140ms · `--t-base` 220ms · `--t-slow` 420ms.

Movement should *settle*, never bounce. Rules:

- Animate `transform` and `opacity` only. Never `width`, `height`, `top`, `left`.
- Never `transition: all` — list the properties.
- Messages enter with `.rise` (fade + 10px lift), staggered by `--i`, capped at
  6 steps so restoring a long conversation does not crawl.
- Buttons **depress** on `:active` (`.press`) — they do not scale up on hover.
  Hover changes background and shadow only.
- No scroll listeners, no `requestAnimationFrame` loops touching React state.
  IntersectionObserver, CSS, or Framer Motion values.
- The thinking indicator (rotating crystal) is the one piece of ornamental
  motion. It earns its place because it covers real latency.
- Everything collapses under `prefers-reduced-motion: reduce`. Non-negotiable.

## Component states

Every interactive element defines: rest, hover, `:focus-visible`, `:active`,
disabled — and every data surface defines loading, empty, and error.

- **Focus:** 2px solid ink ring, 2px offset, `:focus-visible` only. Never
  remove an outline without replacing it.
- **Loading:** skeletons shaped like the content they replace (`.skeleton-line`),
  not a spinner in dead space.
- **Empty:** composed, and says how to fill it.
- **Errors:** inline next to the field; toasts only for transient events.
- Labels sit **above** inputs. Placeholder is never the label.

## Voice

Sentence case in body copy, Title Case for buttons. Second person. Active
voice. Specific button labels — "Start voice conversation", not "Continue".
Errors state the fix, not just the problem. One label per intent across the
whole app.

## Reference discipline: Apple HIG & SF Symbols (principles, not imitation)

Apple's Human Interface Guidelines and SF Symbols are read here as a
*discipline* — how a mature, high-craft system reasons about hierarchy,
legibility, feedback, spacing, and restraint — not as a visual template.
Urban AI Assistant is a warm-paper reference tool for UK planning law, not an
Apple product, and must never start looking like one. Every rule below
re-expresses Apple's *reasoning* entirely in this system's own tokens (paper/
ink/rule, Manrope, `--ease-settle`, the pill/container/control radius set).
Nothing here introduces SF Pro, Apple's blue, glass materials, dark mode, or
bounce easing — those stay excluded per Anti-patterns below.

**Hierarchy.** HIG's Clarity/Deference/Depth: content leads, chrome recedes,
importance is shown through scale/weight/position, not added ornamentation.
Warm-paper already is a deference system by design ("colour lives in the
content, never the chrome"). Rule for new UI: reach for size, weight, and
position in the existing type scale before reaching for a card, a border, or
a colour. At most one primary action per screen/section in solid `--ink`;
everything else is `secondary`/`ghost`-weight or plain text. Two things
competing for the same visual weight means one of them is wrong.

**Legibility.** HIG's Dynamic Type floor is 17pt body at arm's length, with
tabular figures wherever a number must not jitter. Keep `text-sm`/`text-base`
+ `leading-relaxed` + the 65ch cap as this product's legibility floor — a
laptop/tablet compliance document, not a glanced-at phone — and never drop
body copy smaller anywhere evidence or compliance language appears. Keep
`.tabular` on every score, percentage, timestamp, and page number: a shifting
digit reads as an unstable answer, which this product cannot afford to look
like.

**Interaction feedback.** HIG: a control confirms it received input,
distinctly from confirming the input's *result* is ready. `.press` (depress
on `:active`) already gives immediate press feedback separate from `.rise`'s
result-arrived feedback. Extend that split to every new async control: depress
instantly on click ("I heard you"), only start a skeleton/`.rise` state once a
result begins arriving ("here's what happened") — never leave a beat of
nothing between the two.

**Spacing.** HIG's layout grid (8pt, 4pt subdivisions) keeps arbitrary numbers
out of layout, and whitespace does hierarchy work so borders don't have to.
Translation: use a 4px-based scale (4/8/12/16/24/32/48 — i.e. Tailwind's
`gap-1`/`-2`/`-3`/`-4`/`-6`/`-8`) as the only spacing values in new classes;
avoid arbitrary values like `gap-[13px]`. Where two elements need separation
but not a border, add space, not a hairline; where they need `--rule`, stop
there — don't add both.

**Accessibility.** HIG/WCAG: AA contrast (4.5:1 body, 3:1 large text/UI), and
colour is never the only carrier of meaning. Spot-check every `--ink-*` step
against its background — `--ink-faint` (`#a39b8d`) on `--paper` is worth
re-checking since it currently serves both placeholders and disabled controls,
two states with different information stakes. Every colour-carrying status
signal (the amber correction notice, a red error, a green "present" status)
must also carry a word or icon, never colour alone — already true of the
amber notice's copy; hold every future status chip to the same bar.

**Motion restraint.** HIG: motion clarifies a state change, never performs for
its own sake, and fully respects `prefers-reduced-motion`. This is already the
strictest section of this system — `--ease-settle`, the three-step duration
scale, transform/opacity-only, and the reduced-motion collapse are stricter
than HIG's own iOS motion (which allows spring/bounce). Nothing to add here;
HIG is the one reference this system already exceeds rather than needs to
catch up to. Hold the line against a second easing curve or a bounce, even
under pressure to make something feel "livelier."

**Icon consistency (SF Symbols).** HIG: icon and type are *one system* — every
glyph shares the type's optical weight, sits on the same baseline grid, scales
in matched steps; filled vs. outline carries meaning (state), never
decoration. What's actually here, checked directly rather than assumed: this
app doesn't render icons from a package at all — every icon is a hand-rolled
inline SVG, mostly sharing `components/ui/icons.tsx`'s one `<Svg>` wrapper
(24×24 viewBox, `currentColor`, 1.8 stroke, round caps), which is already
close to SF Symbols' own discipline. `@heroicons/react` and `lucide-react`
both sit in `package.json` as near-dead weight — Heroicons wasn't imported
anywhere, and lucide-react's only use was `Loader2` inside the unused
`components/ui/button.tsx`. **Fixed 2026-09-28**: that `Loader2` was replaced
with a new `Spinner` in `components/ui/icons.tsx` (matching the circular-track
spinner `ConversationSidebar.tsx` already hand-rolled, consolidated instead of
duplicated a third time), so lucide-react has no remaining call site in the
app. Stroke width had drifted in a few file-local icon definitions
(`DocumentPanel.tsx` at `2`, one at `1.75`; one in `ChatInterface.tsx` at `2`)
against the shared `1.8` — normalized to `1.8` throughout. `@heroicons/react`
being an unused dependency is a separate, minor cleanup (removing it from
`package.json`), not done here. A filled/solid variant reserved for exactly
one meaning — active/selected/current — the same way HIG reserves filled
symbols for a selected tab, is still worth holding as a rule for future icons;
nothing in the current hand-rolled set needed correcting on that point.

**Control sizing.** HIG: 44×44pt minimum hit target, sized for a real hand or
cursor independent of how small the glyph inside looks. The existing
`--r-control`/`--r-pill` shapes already set the look; the gap is hit-area. The
two `h-10 w-10` elements originally flagged here turned out, on inspection, to
be decorative avatar containers (the assistant logo, the user glyph) with no
click handler — not actually controls, so HIG's tap-target rule doesn't apply
to them; that first pass was a false positive from grepping class names
without checking for `onClick`. The real instances are the composer's
icon-only `h-8 w-8` (32px) buttons — attach file, dictate, voice, send.
**Fixed 2026-09-28** for the one that's genuinely standalone: the attach-file
control got an invisible `before:-inset-1.5` hit-slop (visible pill stays
32px, clickable area grows to 44px), since nothing else sits within 6px of it.
The dictate/voice/send trio share an 8px `gap-2` in one toolbar row — padding
each the same way would make their invisible hit zones overlap and risk
mis-targeted clicks between adjacent buttons, so they were left at 32px rather
than risk that blind. Getting them to a real 44px means loosening the
composer toolbar's own spacing, a layout change, not a token fix — flagged
here as a genuine follow-up, not fixed in this pass. This is a floor, not a
target to standardize everything to — a dense evidence table's row-level icon
buttons can stay smaller as long as they're not the primary way to trigger an
action.

**Focus states.** HIG: focus is always visible, never removed without an
equally clear replacement. Already locked here (`:focus-visible`, 2px solid
ink ring, 2px offset) and already stricter than most web apps default to. One
addition: verify the ring specifically against `--paper-raised` and
`--paper-sunken`, not just `--paper` — a ring visible on the page ground can
still wash out on a raised card or a sunken well, exactly the surfaces the
composer and report panels use.

**Clear state transitions.** HIG: every control defines rest/hover/focus/
active/disabled, every data surface defines loading/empty/error — no state is
allowed to just not exist. Already the letter of Component states above.
Translation: hold this session's new review states to the same bar —
`compliance_status`'s `final`/`incomplete`/`failed` and `assessment_coverage`
are states this system didn't have when Component states was written, and
"Incomplete" deserves the same considered rest/hover/focus treatment on its
badge and stat tile as every other state, not just a colour swap.

**Scope note — Icon Composer, Pass Designer, Reality Composer Pro.** Icon
Composer is filed as a future resource for the actual app icon (browser tab /
PWA icon) only, not part of this pass. Pass Designer (Wallet passes) and
Reality Composer Pro (visionOS/AR authoring) have no surface in a Next.js
planning-compliance web app and are excluded entirely, not just deprioritized.

**Fixed 2026-09-28, all verified with a clean `tsc --noEmit` (same 43
pre-existing, unrelated `voice-service` vendored-template errors as every
prior pass in this doc, zero new ones):**
- `components/ui/button.tsx` — an unused-anywhere-in-the-app component (dead
  but type-correct, kept per this file's own convention) — no longer renders
  `bg-blue-600`/`bg-red-600`/`bg-green-600` fills or a `whileHover={{ scale:
  1.02 }}` hover-scale (both direct violations of this document's own locked
  rules); it now uses `--ink`/`--paper-*` tokens, `--r-pill`, `.press`, and an
  ink `:focus-visible` ring, and `success` folds onto the same ink treatment
  as `primary` rather than being a second accent colour. `danger` keeps red —
  DESIGN.md reserves semantic colour for "errors" by name.
- Icon library and stroke-width drift, per Icon consistency above.
- The composer's attach-file hit-area, per Control sizing above. The
  dictate/voice/send trio's tight toolbar spacing was left alone rather than
  risk a layout change unverified — noted as a real follow-up above.

**Not yet done:** `@heroicons/react` as a fully unused `package.json`
dependency; loosening the composer toolbar's spacing so the dictate/voice/
send buttons can also reach 44px; none of this was visually verified in a
live browser (no browser access from the sandbox this pass ran in) — only
`tsc` and direct reading of the diffs.

## Anti-patterns — specific to this product

- A second accent colour anywhere in the chrome
- Pure-black shadows on the warm ground
- Inter, or any serif, as a display face
- Hover-scale-up on buttons
- Spinners where a skeleton would fit
- Citations rendered without a working link to the source document
- Confidence or groundedness shown without a number behind it
- Any control that implies a capability the backend does not have — see the
  `FEATURES` flags in `components/chat/ChatInterface.tsx`
