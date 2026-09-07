# UI revamp — original palette preserved

The latest supplied archive, Urban-AI-Assistant-main 2.zip, is the source of truth.
Its page, layout, chat component and global stylesheet match the corresponding
files in the previous supplied archive.

## Correction to the first draft

The earlier draft retained the colour family but changed surfaces and shades.
That interpretation was too broad. This revision restores the original page
background, gradients, font setup and component paint classes.

- app/page.tsx is byte-for-byte identical to the latest uploaded version.
- app/globals.css and tailwind.config.js are unchanged.
- app/layout.tsx retains the original font, body classes and metadata, with only
  the layout-only stylesheet import added.
- app/workspace.css contains no colour, background, opacity, shadow or palette
  declarations. Focus outlines inherit existing text colours.
- The revised chat component introduces no new colour-related utility classes.
- Original message, suggestion, input, toolbar and loading colours are retained.

## Interface improvements

- Cleaner header with a new-chat action that asks before clearing unsaved messages.
- More deliberate typography, spacing and three-column desktop prompt cards.
- Responsive mobile layout and larger touch targets.
- Multiline composer with Shift+Enter and IME-safe Enter handling.
- Suggestions can be edited before sending.
- Restrained entrance, hover and press animations using the existing Framer Motion dependency.
- Reduced-motion support, including static loading dots.
- Original upload controls and request handlers retained. The original microphone
  had no handler; it is explicitly disabled and labelled unavailable.

No sidebar, persistent history, backend repair or SQL migration is included.

## Verification

Source checks passed: unchanged original page/global styles, no new colour
utility classes, and no paint declarations in the new stylesheet.

Dependency installation was previously blocked by the environment's network
approval. Type checking, production build, browser rendering and live API
verification remain outstanding. This is a draft, not a validated release.

Before merging, run npm ci, npm run type-check and npm run build in the configured
project environment, then check desktop/mobile layouts, reduced motion, keyboard
navigation, chat replies and source citations.

Existing missing upload/diagram backend routes are unchanged. No merge or
deployment has been performed.
