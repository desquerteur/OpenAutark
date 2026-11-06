---
name: phone-access
description: I read this when the person wants Autark on their phone, wants me to use their phone (phone use), or wants to reach this app or another PC from outside the home network. The Android app paired by Remote ID, phone use through it, the iPhone web app paired by Remote ID (Tailscale as the other way), linking another PC by its Remote ID, and the meeting server that lets devices in different networks find each other.
metadata:
  modes:
    - none
---

# The phone, phone use, and the meeting server

The phone belongs to the company, not to one PC: once paired, every PC of the person knows it (the roster between
their PCs carries it), its notifications come from whichever PC decides one, and it opens the first PC that is online.
Settings live in `settings.json` (skill `app-settings`); the app applies a change within a second.

## Android: the Autark app (the normal way)
- The person installs the APK (the website's download, or the newest release in github.com/teydra/OpenAutark); the app
  offers its own updates.
- Pairing is the same as between PCs: on the PC, Settings › Devices › **Connect a phone** shows this PC's Remote ID and a
  QR code that carries only it. The person scans it with the camera (it opens the app) or types the Remote ID in the
  app. Both screens show the same 4-digit code; the person taps **Accept** on the PC. That tap is theirs – comparing the
  code is the proof that the phone is theirs.
- The app reaches the PC through the meeting server: no VPN, no address, no switch to turn on. Access exists exactly as
  long as the phone's row in Settings › Devices does; Remove ends it on all their PCs.
- The paired phone is the owner's: chats, tasks, settings, secrets, plans and API keys all work from it. A CLI sign-in
  (Codex, Claude Code) started on the phone opens its page as a tab in this PC's own browser pane, which the phone
  mirrors – the person finishes it there from the phone. Kimi and Copilot sign in inside a terminal on the PC; those
  two stay a PC step.
- "Forget this phone" is in the profile menu inside the app.

## Phone use (Android): I operate the person's phone
- `phone.devices` lists the app phone (serial = its device id) next to ADB phones; `phone.ui_tree`, `phone.tap`,
  `phone.swipe`, `phone.type`, `phone.key`, `phone.open` and `phone.screenshot` work the same on it – no ADB, no cable.
  Swipes through the app follow a light, slightly jittered curve like a finger.
- It works while the app's connection lives, also with the app in the background. The service reads nothing until I
  ask, so it costs next to no battery.
- The first time, the step fails with "phone use is off": the phone shows the person a notification "Let the AI use this
  phone"; one tap opens Android's Accessibility settings (Autark › Use this phone). A sideloaded app on Android 13+
  first needs App info › ⋮ › Allow restricted settings – I tell the person that in one line.
- While I act, a bubble shows at the top of the phone; when the person taps it, my step stops and phone use pauses for
  30 s. That is their brake – I wait and look again instead of retrying at once.
- The first time I reach an app, the bubble asks "Let the AI use <App>?" once; their Allow is kept for that app. A
  "consent" error means the person has not let me into that app (yet).
- I read `phone.ui_tree` before each next step; nothing I do there is verified until I looked.

## iPhone: the web app, paired by Remote ID (the normal way)
There is no App Store app, and iOS gives no third-party app a way to operate the phone – phone use exists only on
Android; I say that plainly when the person asks. Chats, tasks, notifications and the microphone work. The way in, the
same Remote ID pairing as Android, through the meeting server, in any network:
1. On the iPhone, the person opens **https://autark-theta.vercel.app/app/** in Safari (no Apple account), taps
   Share › **Add to Home Screen** and opens Autark from the Home Screen – the pairing and notifications live there,
   Safari's own tab keeps separate storage.
2. They type this PC's Remote ID (Settings › Devices › **Connect a phone** shows it; scanning its QR code with the
   Camera shows the ID to copy).
3. Both screens show the same 4-digit code; the person taps **Accept** on the PC. From then on the iPhone shows this
   PC's own screens, end to end encrypted, and belongs to the company like the Android app.
4. Notifications: Settings › Devices on the iPhone, Notifications on (iOS asks once).
"Forget this phone" in the app's profile menu removes it on the PCs too.

Another way, without the meeting server: the PC's own web app over HTTPS on the tailnet. I check `tailscale status`
(not installed: `winget install Tailscale.Tailscale` on Windows; the person signs in once in its window and needs the
Tailscale app on the iPhone with the same account), serve the app on its own port so an existing `/` mapping stays
(`tailscale serve --bg --https=8443 http://127.0.0.1:47811`; `tailscale serve status` shows the address; `"pwa":
{ "bind": "localhost" }` stays), and `pwa.link` gives a one-time link with its QR code and a 6-digit code (10 minutes)
for the Home Screen app to type. `tailscale serve --https=8443 off` undoes it. In the same network a browser also works
with `"pwa": { "bind": "lan" }`; without HTTPS it gets no secrets, plans, notifications or microphone. A fixed IP or
forwarded port only with HTTPS in front (a reverse proxy such as Caddy); I tell the person what is then reachable from
the internet.

## PCs in different networks: the meeting server
Linking a PC: `devices.connect` with the other PC's Remote ID (Settings › Devices there shows it); both screens show
the same code and the person accepts on the other PC. On the same network the PCs find each other directly. In
different networks they find each other by Remote ID at the meeting server (`devices.relay`; by default Autark's own,
`wss://telecoding-relay.onrender.com/autark`) and then talk directly where they can; a sealed tunnel through it is the
last way and cannot read anything. The Android app and the iPhone web app use the same server. `devices.list` shows `meetingServer`.
- Setting it: `"devices": { "relay": "wss://<host>" }` on every PC ("" = off; phones then have no way in).
- Running one on a PC with a public address: the app carries it as `app/meet.mjs` (in an installed app under
  `resources/app.asar.unpacked/app/meet.mjs`). `ELECTRON_RUN_AS_NODE=1 <the Autark program> <meet.mjs>` runs it with
  the app's own Node. `RELAY_PORT` (default 8787) and `RELAY_TRUST_PROXY=1` behind a TLS reverse proxy, which gives the
  `wss://` address; `services/remote-relay/Dockerfile` for a container host.

I say in one line what I changed and what is still the person's step (scan or type the ID, Accept on the PC, the
Accessibility switch, Add to Home Screen on the iPhone, sign in to Tailscale).
