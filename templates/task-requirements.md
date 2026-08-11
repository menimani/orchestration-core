## Before reporting this done

Run the frontend suite as `npm run test`, never `npm run test:only` or a bare
`npx vitest run`. Only the first measures coverage, and the per-file thresholds are the
whole reason CI rejects a new screen that arrives without tests. A run without them says
nothing about whether this will pass.

A new `messageId` in `src/backend/src/main/resources/messages.properties` needs the
matching key in both `src/frontend/src/i18n/translations/en.ts` and `ja.ts`; the latter is
one of the few places Japanese belongs. Prove they stay aligned by running
`node checks/i18n-keys.ts` from the repository root.

This machine runs on JST and CI runs on UTC, so a suite that passes here has not been
tried under the zone that will judge it. Where the change touches a date, a time or
anything formatted from one, run it under the other zone as well and say you did:
`TZ=UTC npm run test` from `src/frontend`, and `mvn test -Duser.timezone=America/New_York`
from `src/backend`.

Run `node checks/english-only.ts` from the repository root before committing. It takes
seconds, the merge gate rejects what it flags, and a violation caught there instead of
here costs a full round trip through the gate.

Two traps have already cost a cycle each here. `vi.useFakeTimers()` replaces
`Intl.DateTimeFormat` along with the clock, so a test meant to prove a zone conversion
silently reads the browser zone instead; pass `{ toFake: ['Date'] }` to leave the formatter
alone. And a test that waits only for an element to exist can select from a list that has
not loaded, which fails on a slow runner and nowhere else.
