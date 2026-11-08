# Autark desktop

The desktop app of Autark: an Electron app (Node.js 24, TypeScript) with its own agent runtime. One AI company per person – a manager, teams and a secretary – with chats, tasks, "My day" with a calendar, a browser beside the chat, phone access and linked PCs. Agents run through Claude Code, Codex, other plans, API keys or local servers.

## The system is a few files

The runtime keeps everything in one data folder `<data>` and an SQLite database. What the person or the AI may change is a plain file:

- `settings.json` – the only place for settings (only differences from the defaults; an invalid section keeps its last good value).
- `theme.css` – the look of the app, applied live.
- `connectors/mcp.json`, `connectors/mail.json` – connected services; secrets are written as `secret://<id>` handles.
- `agents/<id>/SYSTEM.md` and `agents/<id>/skills/` – an agent's instructions and its main skills; `prompts/` and `modes/` hold own versions of the shipped prompts and modes.

The README in the data folder lists every file and what editing it changes. The AI changes the app by editing these files (skills `app-settings`, `app-look`, `connect-apps`) or through the running app: `wf call <method>` (`npm run wf -- call <method>` in the source tree) or `POST /rpc` with the token from `runtime.json` ([EXTERNAL_PROTOCOL](../../docs/EXTERNAL_PROTOCOL.md)).

## Settings

One page with five groups: **Models** (the plans found on this PC, plus four fixed buttons: Claude plan, Codex plan, API key, Local server), **Abilities** (what the AI can see, hear and make, each with a one-line explanation and "Set up with AI"), **Voice**, **Devices** (Remote ID, phone QR code, PCs on the network, connect by Remote ID or address as CEO or employee) and **Advanced** (open the data folder or `settings.json`, version and update, back up and restore, start with Windows). Everything else is done by telling the AI.

Codex and Claude Code use their installed official CLIs: sign-in goes through `codex login` / `claude auth login`, and the app never reads or copies their tokens. Missing CLIs are installed by the first-run flow or by the AI.

## Feedback

The header's feedback cell sends a Bug or an Idea, sealed on this PC for the team's key, to the team's write-only Firestore mailbox. A build can only send when it ships `resources/feedback/receiver.json` (team public key, Firebase project, web API key – written on the team PC by `wf feedback setup`); without it every report is only saved on the PC, the form says "sending is not set up", `npm run package` warns, and `<data>/logs/runtime.log` has `feedback sending is not set up` at start. A delivered report shows "Report no. …" (the same number appears in the team's inbox); a failed send says "Not sent." with the reason and logs `feedback send failed` with `reason` (`offline`, `timeout`, `server`, `refused`, `not_set_up`).

Test without the real mailbox: in an unpackaged app `WORKFORCE_FEEDBACK_RECEIVER=<file>` names another receiver file, whose `endpoint` may be a loopback origin; `test/e2e/lib/feedback-submit.mjs` is such a local fake (`node --test test/ui/af003-feedback-send-window.test.mjs`). `services/feedback` is a retired prototype and is not used.

## Run and verify

Requires Node.js 24.

```powershell
cd apps/desktop
npm ci
npm run build          # bundles main, preload, runtime, CLI and UI into app/
npm start              # starts the built app
npm run check          # typecheck per layer, import boundaries, unit tests (about 5 minutes)
npm run test:e2e       # runtime end-to-end tests
npm run test:ui        # builds, then real Electron window tests
npm run package -- --win --x64
```

A single file: `node --test test/unit/<area>/<file>.test.ts`. Some window and end-to-end tests still describe features that were removed and are being rewritten. Package targets are Windows x64 NSIS, Linux x64 AppImage and macOS universal DMG/ZIP; macOS must be built on macOS.

## Release and updates

Public binaries: https://github.com/desquerteur/OpenAutark (from 0.3.3; up to 0.3.2 they were in `teydra/proactive-agent-workforce-releases`, which carries the bridge release 0.3.3 for older installs). Stable links use GitHub's `releases/latest/download` redirect:

- Windows: `.../releases/latest/download/autark-windows-x64.exe`
- Linux: `.../releases/latest/download/autark-linux-x64.AppImage`
- macOS: `.../releases/latest/download/autark-mac-universal.dmg`
- Android: `.../releases/latest/download/autark-android.apk` (its version: `latest-android.json`)
- Version: `.../releases/latest/download/release.json`

GitHub decides which release is latest; installed apps check through `electron-updater` from it. The install itself is the app's own: on Windows and Linux a small relaunch helper (`src/main/updates/install-helper.ts`) waits for the app to end, installs (NSIS silently / the AppImage swapped in place) and starts the new version, with one line per step in `<data>/logs/update-helper.log`; on a Mac `mac-self-update.ts` swaps the bundle. The release scripts are in `scripts/desktop-release/`. Production signing (Windows certificate, Apple notarization) and native ARM64 packaging are open.

## Documentation

[README](../../README.md) (the project, licence and how to contribute) · [ARCHITECTURE](../../docs/ARCHITECTURE.md) (how it is built) · [EXTERNAL_PROTOCOL](../../docs/EXTERNAL_PROTOCOL.md) (how a program talks to the running app). Every source file starts with a header comment "Owns / Never".
