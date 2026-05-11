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
5. **No new network endpoints.** The extension is offline-first. New outbound requests require discussion.
6. **No telemetry or analytics.** This is non-negotiable.

## Development Setup

```bash
npm ci
npm run dev    # watch mode
npm run build  # production build into dist/
```

Then load `dist/` as an unpacked extension in `chrome://extensions` with Developer mode enabled.

## Translations

UI translations live in `public/translations/<lang>/messages.json` and `src/utils/i18n.ts`. New languages or fixes welcome — please test the popup renders correctly in your language.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
