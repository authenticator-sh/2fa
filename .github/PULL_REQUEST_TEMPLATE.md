## What this changes

<!-- One paragraph. Link the issue if there is one. -->

## Why

<!-- What was wrong, or what this makes possible. -->

## Checks

- [ ] `npm run verify` passes (typecheck, tests, live dependency probe)
- [ ] No new permission in `manifest.json`
- [ ] No new outbound endpoint — or one added to the inventory `npm run check:deps` probes
- [ ] No telemetry or analytics of any kind
- [ ] Nothing here can lose a user's accounts: storage, vault and backup paths are covered by tests

<!-- A vulnerability does not belong in a pull request either: email
     security@authenticator.sh first. See SECURITY.md. -->
