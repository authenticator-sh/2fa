# Contributing to 2FA Authenticator

Thanks for your interest in contributing.

## Security Issues

**Do not open public issues for security vulnerabilities.** See [SECURITY.md](SECURITY.md) and email security@authenticator.sh instead.

## Bug Reports

Open an issue with:
- Extension version (visible in the popup or in `chrome://extensions`)
- Chrome version
- Steps to reproduce
- Expected vs actual behavior
- Screenshots if relevant

If the issue exposes account data or TOTP secrets, follow the security disclosure path above instead.

## Pull Requests

We accept PRs but cannot guarantee review timelines. To increase your chances of a merge:

1. **Open an issue first** for any non-trivial change to discuss the approach.
2. **Keep PRs focused.** One concern per PR.
3. **Match existing code style.** Run the build and verify it produces a clean `dist/`.
4. **No new permissions.** This extension's value comes from minimal permissions. Any PR that adds a new permission to `manifest.json` will need very strong justification.
5. **No new network endpoints.** The extension is offline-first. New outbound requests require discussion — and any endpoint that ships must be added to `SOURCES`-style inventory covered by `npm run check:deps`, so that its death is a failing check rather than a silent regression.
6. **No telemetry or analytics.** This is non-negotiable.

## Development Setup

```bash
npm ci
npm run dev     # watch mode
npm run build   # production build into dist/
npm run verify  # typecheck, tests, and a live probe of every external service
```

`docs/review-checklist.md` is worth reading before reviewing anything here. It
exists because a feature once stopped working for every user without a single
failing check, and it lists the questions that would have caught it.

Then load `dist/` as an unpacked extension in `chrome://extensions` with Developer mode enabled.

## Releasing

```bash
npm run verify               # must pass, including the live dependency probe
npm run build
npm run checksums            # writes SHA256SUMS-v<version>.txt from dist/
npm run checksums -- --check # re-verify dist/ against that file
```

The sums file ships with the GitHub release. The README and the website both
promise it for *every* release, so a release without one makes a published
claim false — do not skip this step.

## Translations

UI strings live in `src/utils/locales/<lang>.ts` — one file per language, all
sharing the key set declared in `src/utils/i18n-keys.ts`, so `tsc` fails if a
locale is missing a key. `src/utils/i18n.ts` is only the loader. The store
listing name and description are separate, in
`public/translations/<lang>/messages.json`.

New languages or fixes welcome — please test the popup renders correctly in your
language.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
