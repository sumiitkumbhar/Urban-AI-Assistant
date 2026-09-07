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
