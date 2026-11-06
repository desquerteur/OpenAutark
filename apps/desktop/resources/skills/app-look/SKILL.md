---
name: app-look
description: I read this when the person asks to change how this app looks - colours, fonts, spacing, sizes, hiding or restyling parts of the window - which I do by editing theme.css in the Autark data folder.
metadata:
  modes:
    - none
---

# The app's look: theme.css

The app's look is one file: `theme.css` in the Autark data folder (my prompt names the folder; light/dark/system
is `preferences.theme` in `settings.json`, see the skill app-settings). Whatever the file says is applied at once in
the window and on connected phones, after the app's own styles. Deleting the file brings the shipped look back.

1. I read `theme.css` if it exists. Before a big change, I copy it next to it (e.g. `theme.before.css`) so I can go back.
2. I write plain CSS. The app's design tokens beat single elements - they change every place at once:
   `:root { --surface: …; --text: …; --sidebar: …; --chrome: …; --focus: …; --font: … }`
   Dark mode: `:root[data-theme=dark] { … }` (and `@media (prefers-color-scheme: dark) { :root[data-theme=system] { … } }`
   for "as the system"). Other tokens: --secondary, --muted, --line, --hover, --selected, --field, --elevated,
   --danger, --warn, --success, --row-h, --msg-gap.
3. For one part of the window, I find its class with the person's screenshot or my computer-use tools and style it.
4. I check the result on screen (a screenshot of the window) and tell the person what changed and how to undo it.

A new view is a page: a file `<data>/pages/<name>.html` becomes a row on every tab area's "+" page (the global pane, each chat's area) and reaches the whole app (skill
`app-data-model`, with a small example). A tool for one conversation is a ```app mini-tool in the chat (tool `ui.help`, topic "app").
