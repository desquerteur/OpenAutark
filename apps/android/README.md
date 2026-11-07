# Autark für Android (0.3.3, B-078)

Die Android-App verbindet sich über **Autarks Treffpunkt** (`wss://telecoding-relay.onrender.com/autark`) mit den PCs der eigenen Firma – kein Tailscale, kein VPN, keine erreichbare PC-Adresse. Agenten, Modelle und Daten bleiben auf den PCs; die App zeigt die **unveränderte Handy-Oberfläche** des PCs, ohne eigene Werkzeugleiste.

## Verbinden (eine Kopplung wie zwischen PCs)

1. Auf dem PC: **Settings → Devices → Connect a phone** zeigt die **Remote ID** und einen QR-Code, der nur sie trägt (`https://metajarvis.teydralab.com/autark/pair/#<ID>`; ohne App zeigt die Seite der Website die ID und die Downloads; ältere QR-Codes ohne `/` vor `#` liest die App weiter).
2. Am Handy den QR-Code mit der Kamera scannen (App Links öffnen die App) oder die Remote ID in das eine Feld tippen, **Connect**.
3. Beide Bildschirme zeigen denselben 4-stelligen Code; auf dem PC erscheint „Phone <Modell> asks to connect“ → **Accept**.
4. Danach öffnet sich die Handy-Oberfläche. Beim nächsten Start verbindet die App von selbst – mit dem ersten PC der Firma, der online ist (die Liste kommt über `phoneUse.attach`; die anderen PCs kennen das Handy über den Roster).
5. Entfernen: auf dem PC das Handy unter Devices entfernen (auf allen PCs) und/oder in der App Profilmenü → **Forget this phone**.

Kein „Phone access“-Schalter mehr: Zugang besteht genau, solange die akzeptierte Gerätezeile existiert. Die alte `phone`-Code-Nachricht (0.2.x/0.3.2-APK) beantworten neue PCs mit „Update the Autark app“.

## Zurück

Die Zurück-Geste ruft per `evaluateJavascript` `window.autarkBack()` (`ui/pwa/back.ts`): erst Dialoge, das globale Blatt, der Chat-Bereich, dann ein geöffneter Bildschirm, ein Einstellungsabschnitt, ein anderer Tab → Mein Tag. Liefert es `false` (Mein Tag), geht die App mit `moveTaskToBack(true)` in den Hintergrund – sie schließt sich nie selbst.

## Handy-Bedienung durch die KI (Phone use)

- `phoneuse/UseService`: AccessibilityService, liest nichts, bis der PC fragt (`res/xml/accessibility_service.xml`: nur `typeWindowStateChanged`, ignoriert). Schritte: `ui_tree` (`ScreenTree`, rein, Host-Test), `screenshot` (Android 11+), `tap` (ACTION_CLICK am Element, sonst kurzer Druck), `swipe` (gekrümmter, leicht verwackelter Pfad, `Gestures`), `type` (ACTION_SET_TEXT, Enter zwischen Zeilen), `key` (back/home/recents/notifications/quick_settings/enter), `open` (App oder Link).
- `UseBubble`: Blase oben (TYPE_ACCESSIBILITY_OVERLAY, keine Extra-Berechtigung) „Autark is using this phone · Tap to stop“ – Tippen bricht ab und pausiert 30 s; beim ersten Zugriff auf eine App fragt sie einmal „Let the AI use <App>?“ (`AppConsent`, gemerkt je Paket).
- `UseLink`: zweiter WebSocket der App zu `/ws` durch denselben lokalen Eingang (Gate-Cookie + Handy-Token), `phoneUse.attach` → hört `phoneUse.request` nur für dieses Gerät, antwortet mit `phoneUse.reply`. Ist die Bedienung aus, antwortet er `off` und zeigt `EnablePrompt` (Benachrichtigung „Let the AI use this phone“ → Bedienungshilfen; Hinweis auf „Allow restricted settings“ ab Android 13 bei Sideload).
- PC-Seite: `runtime/phone/app-driver.ts` (20 s je Schritt), `phone/drivers.ts` (ADB + App), `rpc/handlers/phone-use.ts`.
- iOS: keine App; Drittanbieter-Apps können iPhones nicht bedienen. Das iPhone nutzt die Web-App über Tailscale (Skill `phone-access`).

## Updates

`UpdateCheck` liest höchstens einmal am Tag (nur im Release-Build) `https://github.com/desquerteur/OpenAutark/releases/latest/download/latest-android.json` und bietet bei höherem `versionCode` **Update** an (öffnet die APK-Adresse im Browser).

## Wie es funktioniert

- **Handy-Schlüssel:** eigener Ed25519-Geräteschlüssel (BouncyCastle, Android 8+), im privaten App-Speicher (kein Backup).
- **Koppeln:** `relay/RemotePair` – byte-gleich mit `remote/sas.ts` (Host-Test `test/RemotePairTest.java` mit Vektoren aus dem Desktop-Code): remote1 (Rolle `phone`, eigene Schlüssel), Commitment des PCs, remote2, Code, remote3 wartet auf Accept; die Annahme trägt das Geräte-Token (versiegelt über den Treffpunkt).
- **Verbinden:** Alle PCs der Firma pinnen das Handy am Treffpunkt; die App pinnt alle PCs und tunnelt zum ersten erreichbaren. Darüber läuft derselbe Pinned-Key-Handshake wie zwischen PCs; der Kanal trägt Byte-Ströme zum HTTP-Port der PC-Runtime. Der Treffpunkt sieht nur Chiffretext.
- **Oberfläche:** lokaler Eingang nur auf `127.0.0.1` (Port 47920), sicherer Kontext für Chromium; nur mit dem Gate-Cookie dieser App. Klartext-HTTP nur für `127.0.0.1`.

## Dateien

- `relay/` (ohne Android, Host-JVM): `Crypto`, `Json`, `WebSocketClient`, `RelayLink` (mehrere gepinnte PCs), `Tunnel`, `PeerChannel`, `StreamProxy`, `RemotePair`, `PhoneConnection`.
- `phoneuse/`: `UseService`, `ScreenTree`, `Gestures`, `UseBubble`, `AppConsent`, `UseLink`, `EnablePrompt`.
- `MainActivity` (ein Feld, Code, „Can't reach“-Bildschirm, Zurück), `PhoneNavigation` (`autark-app:forget`), `PhoneChrome`, `ConnectionAddress`, `UpdateCheck`.

## Bauen und Tests

- **Debug:** `.\build.ps1` – Paket `com.teydralab.autark.android.preview`, mit dem Debug-Schlüssel signiert; installiert sich neben der Release-App.
- **Release:** `.\build.ps1 -Release` mit dem Schlüssel aus `new-release-key.ps1` (liegt außerhalb des Repos unter `%USERPROFILE%\.autark-release\android`) – Paket `com.teydralab.autark.android`, `versionCode 3` / `0.3.3`, veröffentlicht als `autark-android.apk` in `teydra/OpenAutark` (dazu `latest-android.json` für `UpdateCheck`).
- **Host-Tests:** `.\test.ps1` (nur `javac`/`java`, kein Gradle; BouncyCastle aus dem Gradle-Cache): `ConnectionAddressTest`, `RelayCryptoTest`, `relay.RemotePairTest` (SAS-Vektoren aus `remote/sas.ts`) und `phoneuse.ScreenTreeTest` (Baum, Tippziel, Gesten).

**Nicht geprüft (Stand B-078):** kein Android-Gerät, kein Emulator – Installation, App Links (brauchen `assetlinks.json` mit dem Signaturzertifikat auf der Website), WebView, Zurück, Bedienungshilfen-Dienst, Blase, Gesten, Screenshot, Hintergrund/Doze und Netzwechsel sind offen.
