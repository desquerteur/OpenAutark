---
name: phone-adb
description: I read this for any task on the human's Android phone. Controlling it over ADB (wireless debugging or USB) on this PC or a linked PC - setting up adb with my shell, pairing (phone.pair), phone.ui_tree first, tap/swipe/type with verification, and disconnecting.
metadata:
  modes:
    - computer
---

# Phone control via ADB

The phone is the human's personal device: I stay within the task and stop when they say so.
`device` reaches a phone connected to a linked PC (`devices.list`).

## 1. Is a phone there?
I call `phone.devices` first. It lists connected phones with their state and phones nearby that
offer pairing or a connect port.
- **adb is not installed**: I install it with my shell – Windows `winget install --id Google.PlatformTools -e`
  (then adb is on the PATH of new processes), macOS `brew install android-platform-tools`, Linux the
  `android-tools-adb` / `android-tools` package. Then I call `phone.devices` again.
- **`device`**: ready - I go to step 3.
- **`unauthorized`**: the human unlocks the phone and accepts "Allow USB debugging".
- **`offline`** or nothing connected: I connect (step 2).

## 2. Connect (once per phone, then after restarts)
Developer options are a human step:
```ui
{"type":"checklist","id":"adb-setup","title":"Connect your Android phone (once)",
 "why":"Only you can change these settings on your phone.",
 "items":["Phone: Settings → About phone → tap 'Build number' 7 times",
          "Phone: Settings → System → Developer options → turn on 'Wireless debugging' (same Wi-Fi or tailnet as the PC)",
          "Phone: in 'Wireless debugging' tap 'Pair device with pairing code' and tell me the IP address:port and the 6-digit code"]}
```
Then I call `phone.pair` with `address` (the IP:port from the pairing dialog - not the one under
Wireless debugging) and `code`. It connects right after pairing when the phone announces its connect
port; otherwise I call `phone.connect` with the IP:port shown under Wireless debugging.
- A paired phone needs just `phone.connect` later. The port changes after every restart of the phone
  or of wireless debugging; `phone.devices` lists the new one under "Nearby" when the network allows
  discovery, otherwise I ask the human for it.
- USB: cable + "USB debugging" + accept the prompt on the phone. Android 10 and older have no pairing
  code: I connect by USB, then run `adb -s <serial> tcpip 5555` in my shell and `phone.connect` with
  `<phone Wi-Fi IP>:5555` – it stays on Wi-Fi until the phone restarts.
- Menu names differ by manufacturer; when a step does not match, I ask the human for a screenshot.
- Codes work only while the pairing dialog is open. I keep codes out of my messages.

## 3. Observe
- `phone.ui_tree` is the primary view: elements with class, text, description, id, tap or scroll
  ability and the centre point `@x,y`.
- `phone.screenshot` is for an empty tree or visual checks. Apps with secure flags
  (banking, some messengers) show black - expected.

## 4. Act
- `phone.tap` at the `@x,y` of an element from a fresh `phone.ui_tree`.
- `phone.swipe` to scroll (lower point to upper point, 300-500 ms).
- `phone.type` types ASCII into the focused field (I tap the field first); newlines press Enter.
- `phone.key`: back, home, recents, enter, delete, tab, escape, arrows, page up/down, wakeup.
- `phone.open` opens an http/https link or an installed app by package name (com.whatsapp).
- After every action I read `phone.ui_tree` again and see the expected change before the next step.
- When the screen changed in a way I did not cause, the human is using the phone: I wait and look again.

## Finish
- When the task is done, I `phone.disconnect` a wireless phone and tell the human they can turn
  wireless debugging off.

## Pitfalls
- Coordinates differ by device and orientation - I take them from a fresh tree each time.
- `phone.type` supports ASCII only: I type other characters in parts or pick suggestions.
- Several phones connected: `serial` from `phone.devices` picks one.
