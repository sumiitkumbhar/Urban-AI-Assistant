# Urban AI Assistant — UI revamp

Based on the supplied 1 September ZIP. The three edited existing UI files match
GitHub commit f1928d0603bfd8918c81cbcfa64c17008a44f299 exactly.

## What changed

- Kept the dark slate/navy, blue, purple and pink palette.
- Added a responsive workspace shell and navigation within the current conversation.
- Reworked typography, spacing, prompt suggestions and message presentation.
- Added a multiline composer, native response-mode selector and IME-safe Enter handling.
- Suggestions populate the composer for editing before sending.
- Retained Framer Motion for entrance, hover and press transitions.
- Respected reduced-motion preferences, including static loading dots.
- Added keyboard focus states, a skip link, error announcements and mobile navigation.
- Switched to system typography to avoid downloading a Google font at build time.
- Retained backend request handling, citation components and the dependency lockfile.

The sidebar is current-session navigation, not persistent chat history. Starting a
new conversation asks before clearing unsaved messages.

## Existing capability gaps

The supplied repository has no `/api/compliance-check`, `/api/analyze-drawing`,
or `/api/diagram` implementation. The old microphone control also had no handler.
The redesigned composer disables document uploads, explains drawing-upload
unavailability in feasibility mode, and omits the nonfunctional microphone.
Existing request-handling code remains for a future backend repair.
Diagram behavior elsewhere in answers is unchanged.

No SQL migration, database configuration, retrieval behavior or ingestion code
was changed. The separately uploaded council-aware migration is still pending review.

## Validation status

This is a draft implementation, not a production-validated release.
Dependency installation was blocked by the environment's network approval.
TypeScript checking, the Next.js production build, browser rendering,
motion smoothness, and live chat/API verification could not be completed.
No dependency versions or lockfile entries were changed.

## Before merging

With the project's normal environment configured:

1. Run `npm ci`, `npm run type-check`, and `npm run build`.
2. Check empty and populated chat at desktop, tablet, and 390px mobile widths.
3. Check Enter, Shift+Enter, IME input, suggestion editing and response modes.
4. Check mobile navigation, Escape, keyboard focus and 200% zoom.
5. Check reduced-motion behavior and loading/error states.
6. Send a real query and inspect citations against the original sources.

This change has not been merged or deployed.
