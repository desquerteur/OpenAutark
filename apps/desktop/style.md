# Autark desktop – style

The app's look comes from the theme tokens in `src/ui/styles/tokens.css` (light, dark and the person's own themes,
AF-008). Components use tokens only – no hard-coded colors. This file lists what each area uses; add to it when a
screen's look changes.

## Base (all screens)

| What | Token / value |
|---|---|
| Font | `--font` (UI), `--mono` (paths, SHAs, code) |
| Text | `--text`; secondary `--secondary`; quiet `--muted` |
| Surfaces | `--surface` (cards), `--field` (inputs, composers), `--sidebar` |
| Lines | `--line`; on hover `--elevated-line` |
| States | hover `--hover`, selected `--selected`, focus ring `--focus` (2 px) |
| Signals | `--warn` (changes), `--danger` (missing / destructive), `--success`, `--update` (drop target) |
| Radii | `--r-sm` rows, `--r-md` drop outlines, `--r-lg` cards, `--r-composer` composers |
| Shadows | `--shadow-composer` for composers |
| Row text | `.row-title` 14/20, `.row-preview` 12/18 muted (chat.css) |

## Projects (AF-018) – `src/ui/styles/projects.css`

- **Rail / phone tab:** icon `folders` (assets/icons/folders.svg), after Chats.
- **Sidebar list:** rows min-height 48 px, padding 0 8 px, radius `--r-sm`; folder icon 16 px in `--secondary`;
  pin 12 px `--muted`; changed-files badge 18 px high, radius 9 px, `--warn` on 18 % `--warn`. Sessions of the open
  project indent 22 px with a 1 px `--line` guide, 13 px text, a 6 px `--muted` dot (spinner while working).
- **Drop target:** 2 px dashed `--update` at 60 %, offset −6 px, radius `--r-md`.
- **Start page:** column max 640 px, padding 48/24 px; title 24/32 600; lead 14/22 `--secondary`; cards in a grid
  `minmax(240px, 1fr)`, gap 12 px, max 880 px; card padding 14/16 px, 1 px `--line`, radius `--r-lg`, `--surface`.
- **Project page:** column max 760 px, gap 20 px, padding 24 px. The session field is the page's focus: `--field`,
  1 px `--line` (focus: `--focus`), radius `--r-composer`, `--shadow-composer`, 16/24 text, min 96 px high, a primary
  "Start session" button. Facts as a 110 px label column (`--secondary`) and a value column, 13/20.
- **Narrow (≤ 640 px):** paddings 16 px, facts stack in one column.
