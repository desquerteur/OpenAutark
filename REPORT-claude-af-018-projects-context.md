# Report AF-018-C – Projekt-Bezug im Rest der App

Branch: `claude/af-018-projects-context` · Basis: `f85e401` (Vertrag AF-018 auf main)

Der Vertrag (`shared/model/project.ts`, `shared/api/methods-projects.ts`, Events `project.upserted`/`project.removed`) ist
unverändert. `ui/projects/*`, Rail, Router und `views.ts` sind nicht angefasst.

## Umgesetzt

### AF-018-C.1 – Projekt-Chip im Chat-Kopf
- Arbeitet ein Agent des Chats in einem Projekt, steht hinter dem Chat-Namen ein kleiner Chip
  „<Projekt> · <branch> · N changed“ (ohne Git nur der Name, ohne Änderungen kein „changed“, bei detached HEAD die
  Kurz-SHA). Tooltip: Ordner und Zustand. Ein Klick öffnet `#/projects/<id>`.
- Welches Projekt? Zuerst eines, das den Chat als Session führt; sonst eines, in dessen Ordner ein Agent des Chats arbeitet
  (nur Agenten, die noch im Chat sind). Bei mehreren gewinnt das, dessen Agent gerade antwortet, sonst die Reihenfolge der
  Liste (angeheftet zuerst, dann nach Aktivität).
- Nur für den Besitzer (die Liste wird für niemanden sonst geladen) und nicht im Handy-Layout (zu wenig Platz in der Titelspur).
  Der Chip liegt in der festen Titelspur und verkürzt nur die Ellipse des Namens, damit sich bei Call, Chat-Tabs und Panel nichts verschiebt.
- Dateien: `src/ui/chat/project-chip.ts` (Model), `src/ui/chat/ProjectChip.tsx`, `src/ui/lib/projects.ts` (die Liste nur
  für den Besitzer: `projects.list`, aktuell gehalten über die Events, neu geladen bei jedem Verbindungsaufbau; dazu `openProjectPage`
  über den Hash, `addAndOpenProject`, `folderName`). Eingefügt: `src/ui/chat/ChatHeader.tsx` (der Namens-Zeile wurde ein
  Wrapper `.chat-head-line` um Button und Chip gegeben), `src/ui/styles/chat.css` (ein abgegrenzter Block „AF-018“).

### AF-018-C.2 – Befehlspalette
- Für den Besitzer pro Projekt „Open project: <Name>“ (Hinweis: die letzten zwei Ordnerteile oder „Folder missing“) und
  „New session in <Name>“ (nicht bei fehlendem Ordner), beide öffnen die Projektseite. Dazu „Add project…“: Ordner-Dialog,
  dann `projects.add`, dann die Projektseite (nur wo das Fenster einen Ordner wählen kann, also nicht im Browser oder auf dem Handy).
- Die Einträge stehen in der Gruppe „Projects“ und erscheinen beim Tippen (wie Agenten).
- Dateien: `src/ui/shell/palette-projects.ts` (Model), `src/ui/shell/CommandPalette.tsx` (eine Funktion `projects()` +
  Aufruf). Zusätzlich, nur ergänzend: der Ordner-Zweck `'project'` (`src/shared/api/desktop.ts`, `src/main/files-pick.ts`,
  Dialog „Choose the project folder“ / „Add project“) mit Test in `test/unit/main/files-pick-folder.test.ts`.

### AF-018-C.3 – „Open as project“
- **Agent-aus-Ordner-Dialog**: Nach „Create agent“ springt der Dialog nicht mehr direkt auf die Agentenseite, sondern zeigt
  „<Name> is ready and works in <Ordner>. Open the folder as a project to start sessions there.“ mit
  **Open as project** (primär) und **Open agent page**.
- **Agentenseite** (Abschnitt Access): eine eigene Zeile „Project“ mit dem Ordnernamen (Tooltip: ganzer Pfad) und dem Link
  „Open as project“, nur für den Besitzer. Das bisherige Anhängsel „Project folder: X“ am Modus-Hinweis ist weg (es steht jetzt in dieser Zeile).
- Beide rufen `projects.add` auf (für einen schon bekannten Ordner kommt dasselbe Projekt zurück) und öffnen die Projektseite.
- Dateien: `src/ui/team/OpenAsProject.tsx` (neu), `src/ui/team/FolderAgentDialog.tsx`, `src/ui/team/AccessSection.tsx`,
  Fenstertest `test/ui/folder-agent-window.test.mjs` an den neuen Schritt angepasst (nicht ausgeführt, siehe unten).

### AF-018-C.4 – Klarheit
Umgesetzt in den Texten, die ich ohnehin angefasst habe:
- Ordner-Dialog: „its turns start there“ → „The agent works in this folder (your project): it starts its work there …“.
- Agentenseite: „Project folder: X“ im Modus-Hinweis → eigene Zeile „Project · X“.
- Palette/Chip sprechen nur von Project, Folder, Session und „changed“ (kein Worktree, kein Home-Projekt).

Weitere Vorschläge (bewusst nicht umgebaut):
| Datei | Heute | Vorschlag |
|---|---|---|
| `ui/team/TeamNav.tsx:55` | Add › „Agent from folder…“ | Wenn der Projekte-Tab da ist: „Agent for a project folder…“, oder den Eintrag zum Projekte-Tab verschieben („Add project…“ legt bei Bedarf den Agenten an). |
| `ui/team/TeamNav.tsx` (Add-Menü) | „Group agents by folder“ | „Group agents by project“ – dasselbe Konzept wie der Tab. |
| `ui/team/TeamNav.tsx:253` / Spaces | Gruppen nach „Space“ (company/brand/private) | Für Noriels Programmierarbeit ist der Ordner die Gruppe; „Space“ in der Team-Leiste erst bei mehreren Spaces zeigen. |
| `ui/chat/WorkingPopover.tsx:156` | „Splits are not available here“ | „Parallel parts are not shown here“. |
| `ui/splits/SplitRows.tsx:131,175` | Verb „Split“ | „Parallel parts“ (oder „Split into N parts“) – „Split“ allein ist ein Fachwort. |
| `ui/splits/SplitView.tsx` | Seite „<Agent> · Part n of m“ mit Branch/Worktree-Daten | Den Worktree nur als „own copy of the folder“ beschreiben; der Branch als Chip wie im Chat-Kopf. |
| `ui/settings/feedback-text.ts:40` | „N home projects“ | „N project folders“. |
| `shared/model/access.ts` (Label) | „Auto in project folder“ | passt; Kurzform „Project“ in der Modus-Zelle ist gut – so lassen. |

## Bewusst anders gelöst / offen
- **Navigation per Hash**: `openProjectPage(id)` setzt `location.hash = '#/projects/<id>'` (der Router folgt `hashchange`).
  Beim Merge kann das auf `go.project(id)` umgestellt werden (eine Stelle: `src/ui/lib/projects.ts`).
- **Eigene Projektliste** `src/ui/lib/projects.ts`: Der UI-Branch hat vermutlich einen eigenen Store in `ui/projects/*`.
  Beim Merge die beiden zu einem zusammenführen (Signal `projectList`, `watchProjects`).
- **„New session in <Name>“** öffnet nur die Projektseite: eine Session braucht den Prompt, und der wird dort eingetippt
  (so wie Codex/Claude Code). Ein Fokus-Parameter (`?new=1`) wäre denkbar, steht aber nicht im Vertrag – nicht erfunden.
- **Ordner-Zweck `'project'`** ist eine ergänzende Erweiterung der Desktop-Bridge (nicht des AF-018-Vertrags). Falls der UI-Branch
  denselben Zweck anlegt, gibt es beim Merge einen trivialen Konflikt in derselben Zeile.
- **Ablauf nach „Create agent“**: ein Klick mehr bis zur Agentenseite, dafür ist der Projektweg sichtbar. Wer lieber direkt
  springt: die Primärtaste tauschen.
- `src/runtime/rpc/method-docs.generated.ts` erzeugt `npm run build` aus dem Vertrag neu. Ich habe diese Datei **nicht**
  committet (sie gehört zum Runtime-Branch, damit kein Konflikt entsteht).
- Eine Notiz des Leads (`AF018-CONTEXT-NOTE.md`, „Delete this note before committing“) lag im Worktree; ich habe sie gelöscht.

## Ausprobieren in der App (nach dem Merge mit Runtime und UI)
1. Einen Ordner über die Palette (Ctrl+K → „Add project…“) hinzufügen → die Projektseite öffnet sich.
2. Ctrl+K, den Projektnamen tippen → „Open project: …“ / „New session in …“.
3. Einen Chat mit einem Agenten öffnen, dessen Home-Ordner ein Git-Repo ist → Chip „<Projekt> · main · N changed“ hinter
   dem Namen; eine Datei im Repo ändern → die Zahl steigt (über `project.upserted`); ein Klick → Projektseite.
4. Team › Add › „Agent from folder…“ → Create → „Open as project“.
5. Agentenseite → Access → Zeile „Project“ → „Open as project“.
Ohne den Runtime-Branch liefert `projects.list` einen Fehler → kein Chip, keine Projekteinträge (das ist so gewollt; nichts bricht).

## Tests
Aus `apps/desktop`:
- `npm run build` – grün.
- `npm run typecheck` – grün.
- `npm run boundaries` – grün (68 Warnungen zur Dateilänge, alle vorher schon da, keine von mir).
- Neu: `node --test test/unit/ui/project-context.test.ts` – 5/5 grün (Chip-Zuordnung, Chip-Text, Palette-Einträge,
  Ordnernamen/Hash/Listen-Update); `test/unit/main/files-pick-folder.test.ts` – 2/2 grün.
- `node --test "test/unit/ui/**/*.test.ts" "test/unit/main/**/*.test.ts" "test/unit/styles/**/*.test.ts" "test/unit/folder-agents/**/*.test.ts" "test/unit/rpc/s1-table.test.ts"`:
  1147 Tests, 1136 grün, 7 übersprungen, 4 rot – **alle vier waren schon vor meiner Änderung rot** und betreffen Dateien, die ich nicht anfasse:
  - `rpc/s1-table.test.ts` – der Vertrag `projects.*` hat auf main noch keine Handler (kommt mit dem Runtime-Branch).
  - `ui/plan-setup.test.ts` – „Continue waits for a usable model“.
  - `ui/settings-hint-punctuation.test.ts` – `skill-links-model.ts: "Up to date – nothing changes."`.
  - `ui/tour-player.test.ts` – `spotlight-model.ts imports ../lib/router.ts`.
  - `ui/chat-loading.test.ts` schlug einmal unter Last fehl, allein dreimal grün (wackelt, hat mit dieser Änderung nichts zu tun).
- `test/ui/*` (echte Electron-Fenster) habe ich laut Auftrag **nicht** ausgeführt; `folder-agent-window.test.mjs` ist an den neuen
  Schritt angepasst, aber ungeprüft. Auch die Sichtprüfung im Fenster (hell, dunkel, 640×480, Handybreite) steht noch aus.
