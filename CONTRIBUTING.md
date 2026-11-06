# Contributing

Issues and pull requests are welcome on GitHub. For a larger change, open an issue first and describe what you want to
change, so the work fits the direction of the app. Security problems go privately through [SECURITY.md](SECURITY.md),
never into a public issue.

## Licence

The code is licensed under the Apache License 2.0 ([LICENSE](LICENSE)). Unless you state otherwise, a contribution you
intentionally submit for inclusion is licensed under the same terms (section 5 of the licence). Contributions to
`library/` are published under CC BY 4.0 ([LICENSE.md](LICENSE.md)).

## Build and test

The desktop app lives in `apps/desktop` and needs Node.js 24.

```sh
cd apps/desktop
npm ci
npm run build     # bundles main, preload, runtime, CLI and UI into app/
npm run dev       # build, then start Electron
npm run check     # typecheck per layer, import boundaries, unit tests
npm run test:e2e  # runtime end-to-end tests
npm run test:ui   # build, then tests in real Electron windows
```

One area only: `node --test "test/unit/<area>/*.test.ts"`. The Android app, the website and the meeting server are
described in [README.md](README.md#building-from-source).

## Code rules

- TypeScript with erasable syntax only (no enums, namespaces or parameter properties), ESM, relative imports ending in
  `.ts`. Node 24 runs the tests directly.
- Layers `shared`, `runtime`, `main`, `preload` and `ui` with checked import rules (`npm run boundaries`).
- Every source file starts with a comment saying what it owns (`Owns:`) and what it must never do (`Never:`). Files stay
  under 300 lines where possible and never exceed 450.
- Event-driven, no polling loops; keep memory and CPU low (reference: an 8 GB laptop).
- Line endings are LF.
- Code, identifiers and UI text in English. Check visible changes in a real window: light, dark, 640×480 and phone width.
- Never commit secrets, tokens, personal data or absolute paths from your own machine.
