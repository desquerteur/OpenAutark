# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: **Security → Report a vulnerability** in this repository
(a private advisory that only the maintainers see). Do not open a public issue for them.

Helpful in a report: the Autark version (Settings → About), the operating system, what an attacker can reach or do, and
the steps to see it. You get an answer within a few days; a fix ships as a normal update, which installed apps pick up
by themselves.

## What is in scope

- The desktop app and its downloads in this repository's releases (Windows, Mac, Linux), the Android app and the web app
  a PC serves to a phone.
- The connection between your own devices (end-to-end encrypted; the meeting point only forwards encrypted bytes).
- The release workflows in `.github/workflows/` and the automatic merge of `library/` pull requests.
- Anything in `library/` that exposes a secret or personal data: report it the same way, and it is removed at once.

## How Autark handles secrets

- Sign-ins to AI plans go through the providers' own command-line tools; Autark does not read their tokens. Between your
  own PCs they travel only inside the encrypted device link.
- Stored secrets are encrypted with the system keychain (Windows DPAPI, macOS Keychain, the Linux secret service).
  Agents see a secret's ID, never its value; logs and prompts carry no secret values.
- Every download is listed with its SHA-256 in `SHA256SUMS.txt`, and the updater checks the SHA-512 of each update file
  before it installs it.

## Signing

The Windows installer is not yet signed with a publisher certificate, and the Mac app is ad-hoc signed without Apple
notarization. The checksums above are the way to verify a download until then.
