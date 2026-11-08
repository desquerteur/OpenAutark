# Updates aus dem eigenen Fork veröffentlichen

Diese Version von Autark holt ihre Updates aus **`desquerteur/OpenAutark`** (deinem Fork), nicht mehr aus
`teydra/OpenAutark`. So überschreibt ein offizielles Update deine eigenen Änderungen nicht.

## In der App

**Einstellungen → Updates**

- **Version** – welche Version installiert ist und was gerade los ist (z. B. „Up to date“).
- **Check for updates now** – fragt sofort bei der gewählten Quelle nach.
- **Source** – woher die Updates kommen:
  - `desquerteur/OpenAutark` (Standard, dein Fork)
  - `teydra/OpenAutark` (das Original – Achtung: dessen Updates ersetzen deine Änderungen)
  - eine andere GitHub-Adresse im Format `besitzer/name`
- **Check automatically** – ein: prüft beim Start und regelmäßig; aus: nur noch per Knopf.
- **Channel** – *Stable* (nur fertige Versionen) oder *Prereleases* (auch Testversionen wie `0.3.6-beta.1`).

Die Einstellung liegt in `update-source.json` im Datenordner von Autark.

Gibt es ein Update, erscheint unten rechts ein Hinweis mit Version und Änderungen und den Knöpfen
**Install now** (Entwürfe werden gesichert, Autark startet neu) und **Later**.

Hat die Quelle noch gar kein Release, sagt die App das ruhig („No update has been published in … yet“) – das ist
kein Fehler.

## Ein neues Update veröffentlichen

Du brauchst nur drei Schritte. Den Rest macht GitHub (`.github/workflows/build-desktop.yml`).

1. **Version erhöhen** in `apps/desktop/package.json`, z. B. von `0.3.4` auf `0.3.5`, und committen:

   ```bash
   cd apps/desktop
   npm version 0.3.5 --no-git-tag-version
   git commit -am "Version 0.3.5"
   ```

   Die neue Version muss **höher** sein als die installierte, sonst bietet die App sie nicht an.

2. **Optional: Änderungen aufschreiben** in `docs/releases/v0.3.5.md`. Dieser Text erscheint in der App im
   Update-Hinweis. Fehlt die Datei, schreibt GitHub die Liste der Commits hinein.

3. **Tag pushen:**

   ```bash
   git tag v0.3.5
   git push fork main
   git push fork v0.3.5
   ```

**Fertig.** Nach etwa 15–25 Minuten liegt unter *Releases* im Fork ein neues Release mit:

| Datei | Wofür |
| --- | --- |
| `autark-windows-x64.exe` | der Installer (Windows, unsigniert) |
| `autark-windows-x64.exe.blockmap` | damit Updates schneller laden |
| `latest.yml` | sagt der App, welche Version es gibt (mit SHA-512 – die App prüft den Download damit) |
| `SHA256SUMS.txt` | Prüfsummen zum Nachprüfen von Hand |
| `release.json` | Version, Commit und Prüfsummen als JSON |

Den Fortschritt siehst du im Fork unter **Actions → Build desktop packages**. Das Release ist erst ein Entwurf und wird veröffentlicht, wenn alles gebaut ist.

### Auch Mac und Linux

Ein Tag baut nur Windows. Für Mac und Linux: im Fork unter *Actions → Build desktop packages → Run workflow* den Tag
eintragen und als Plattform `mac`, `linux` oder `all` wählen. Die Dateien kommen in dasselbe Release, und
`SHA256SUMS.txt` und `release.json` werden neu berechnet. Die Android-App lädst du wie bisher vom Release-PC hoch –
danach den Workflow einmal laufen lassen, damit die Prüfsummen auch die APK enthalten.

### Testversion (Prerelease)

Ein Tag mit Bindestrich, z. B. `v0.3.6-beta.1`, wird als **Prerelease** veröffentlicht. Diese Version bekommen nur
Apps, die in den Einstellungen den Kanal **Prereleases** gewählt haben.

### Wenn etwas schiefgeht

- **Der Workflow ist rot:** in *Actions* auf den Lauf klicken und den roten Schritt lesen. Danach Fehler beheben,
  den Tag löschen und neu setzen (`git tag -d v0.3.5`, `git push fork :refs/tags/v0.3.5`, dann Schritt 3) – oder
  unter *Actions → Build desktop packages → Run workflow* den vorhandenen Tag noch einmal bauen lassen.
- **Windows warnt beim Installieren** („Der Computer wurde durch Windows geschützt“): Der Installer ist nicht
  signiert. „Weitere Informationen“ → „Trotzdem ausführen“.
- **Die App findet das Update nicht:** Ist die Version höher als die installierte? Ist das Release veröffentlicht
  (kein Entwurf)? Stimmt in den Einstellungen die Quelle?

## Hinweise

- Der alte Workflow `release-from-compiled.yml` (und `verify-mac-intel.yml`) gehört zu `teydra/OpenAutark` und läuft
  im Fork nicht.
- Eine Version, die **vor** dieser Änderung gebaut wurde (z. B. die selbst gebaute 0.3.4), schaut noch bei
  `teydra/OpenAutark` nach. Erst nach der Installation einer Version mit dieser Änderung gilt der Fork als Quelle.
