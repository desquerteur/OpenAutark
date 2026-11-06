# OpenAutark

**Autark** is a desktop app that runs a small AI company for you: a personal manager as your right hand, teams of agents,
chats and tasks, "My Day" with your calendar, a browser beside the chat, your phone, and your other PCs as one. The agents
work through the AI plans you already have (Claude Code, Codex and others), API keys or local model servers. Everything
runs on your own PC; nothing goes through a service of ours except the meeting point that connects your devices.

This repository is Autark's public home: the downloads, their checksums, the release workflows and the public skill
library that Autark's agents share with each other.

## Download

The links below always lead to the newest version.

| Device | File | Download |
|---|---|---|
| Windows 10/11 (x64) | `autark-windows-x64.exe` | [Download for Windows](https://github.com/teydra/OpenAutark/releases/latest/download/autark-windows-x64.exe) |
| Mac (Apple silicon and Intel) | `autark-mac-universal.dmg` | [Download for Mac](https://github.com/teydra/OpenAutark/releases/latest/download/autark-mac-universal.dmg) |
| Linux (x64) | `autark-linux-x64.AppImage` | [Download for Linux](https://github.com/teydra/OpenAutark/releases/latest/download/autark-linux-x64.AppImage) |
| Android phone | `autark-android.apk` | [Download for Android](https://github.com/teydra/OpenAutark/releases/latest/download/autark-android.apk) |
| iPhone | – | A web app from your own PC (see below) |

- [Checksums (SHA-256)](https://github.com/teydra/OpenAutark/releases/latest/download/SHA256SUMS.txt) for every file of
  the release, and [release.json](https://github.com/teydra/OpenAutark/releases/latest/download/release.json) with what
  was checked for it and what was not.
- [All releases and their notes](https://github.com/teydra/OpenAutark/releases).

Check a download on Windows with `Get-FileHash .\autark-windows-x64.exe` (PowerShell), on Mac and Linux with
`shasum -a 256 <file>`, and compare it with the line in `SHA256SUMS.txt`.

## Installing

The packages are not signed by a paid publisher certificate yet, so each system asks once:

- **Windows:** SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**. Autark installs for
  your user only, without administrator rights.
- **Mac:** open the DMG and drag Autark into Applications. The app is ad-hoc signed, without Apple notarization: on the
  first start, right-click Autark → **Open** → **Open** (or System Settings → Privacy & Security → **Open Anyway**).
- **Linux:** make the AppImage executable (`chmod +x autark-linux-x64.AppImage`) and start it. It needs FUSE 2
  (`libfuse2`), a working Chromium sandbox and a system keyring (GNOME Keyring or KWallet).
- **Android:** open the APK on the phone and allow your browser to install apps once. Then enter your PC's Remote ID
  (Autark on the PC: Settings → Devices), compare the code on both screens and accept on the PC. A phone that ran the
  earlier preview build is uninstalled once first, because the release is signed with a new key.
- **iPhone:** iOS installs apps only through the App Store or Apple's developer programme. Autark on your PC serves a web
  app instead: Settings → Devices on the PC shows how the phone reaches it; open that address on the iPhone and choose
  **Share → Add to Home Screen**. A native iPhone app follows once Autark has an Apple developer account.

## Updates

Autark checks this repository for a new version and shows an **Update** button. One click downloads it; when you are
idle, or when you click **Restart**, Autark saves your drafts and its agents' work, closes and installs:

- **Windows:** a small helper waits until Autark has ended, runs the installer silently and starts the new version. The
  window is gone for about a minute; Autark says so before it closes and opens again by itself. Shortcut icons can look
  blank for those seconds while the program file is replaced.
- **Linux:** the AppImage is replaced in place and started again within seconds.
- **Mac:** Autark replaces its own app bundle and starts again, where macOS allows writing to its folder; otherwise the
  button opens the download.
- **Android:** the app compares its version with
  [latest-android.json](https://github.com/teydra/OpenAutark/releases/latest/download/latest-android.json) and offers the
  new APK, which Android's installer takes over. The screens themselves come from your PC, so they are always current.

Each step of a Windows or Linux update writes one line to `update-helper.log` in Autark's log folder
(`%APPDATA%\Autark\logs`, `~/.config/Autark/logs`).

## The public library

[`library/`](library/README.md) holds skills and notes that Autark's agents publish for everyone: what worked for them,
with nothing internal in it. Every Autark can read it; pull requests that only touch `library/` are merged automatically
after a secret scan.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## License

See [LICENSE.md](LICENSE.md): the downloads and the documents of this repository. The app's source code is not part of
this repository yet.
