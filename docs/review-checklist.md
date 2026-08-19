# Reviewing this codebase

Written after a release where the clock check had been doing nothing at all for
months. Several review passes read that code and approved it, because the code
was fine — the failure was outside it. What follows is the set of questions that
would have caught it, and the ones that have caught everything since.

## Ask these, in this order

**1. What does this depend on that is not in the repository?**

List it: hosts, response formats, browser APIs, storage keys written by earlier
versions, the device clock. Then check each one *right now*, not by reading the
code. One `curl` would have found the dead time service in two seconds. Run
`npm run check:deps` — that is what it is for, and it is deliberately allowed to
fail on a working machine, because a red run means users are affected today.

**2. What real condition makes this feature quietly do nothing?**

Not "what input breaks it" — what state of the world makes it stop working while
still looking healthy. A host that stops answering. A network that blocks it. A
clock that is wrong. A permission that was never granted. Then: who finds out,
and how?

**3. Where does failure converge on success?**

Find every `catch {}`, every `?? default`, every early return, and ask what value
the caller sees. If "we could not measure" is indistinguishable from "everything
is fine", that is the bug, whatever the code around it does. Three states —
good, bad, unknown — must stay three states all the way to something the user
can see. Two booleans in a struct do not count if the UI reads only one.

**4. Does each comment still describe the code beside it?**

Comments explaining a decision are the ones reviewers trust, so they are the
ones worth checking. In the case that started this document, a comment promised
an asymmetric cache TTL and the code below it did not implement one. Both had
been read many times.

**5. Is the clock treated as a fact?**

`Date.now() - stamp > threshold` is wrong on any machine whose clock has moved
backwards, and it silently never fires. Use `ageOf()` from `utils/clock.ts` and
state the failure direction explicitly with `??`. Anything written down and read
back later gets `stampNow()`, not the raw clock.

**6. Is there a test for the failure, not just the feature?**

The suite covers the source being dead, the pool being unreachable, the clock
being wrong, the storage write being rejected. Those tests exist because none of
those cases were covered when they happened.

## When asking an agent to review

"Find bugs" produces logic errors in what is written. It does not find a feature
that stopped working. Ask instead:

- Give a CONFIRMED/REFUTED verdict on this specific claim, with file:line.
- List everything outside the repo this code depends on, and verify each one now.
- What condition makes this do nothing while appearing healthy?
- Which comments no longer match the code beside them?

And say what is not to be trusted: default to "refuted" when uncertain, and mark
each finding as traced end-to-end or inferred.

## Before a release

    npm run verify

Typecheck (`src`, `test` and `scripts` — see `tsconfig.test.json`; the build's
own config stops at `src`), tests, and the live dependency probe. The probe
needs the network on purpose: if it cannot run, you do not know whether the
release works.
