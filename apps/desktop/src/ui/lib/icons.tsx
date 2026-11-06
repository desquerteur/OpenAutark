// Icon component: Phosphor "regular" SVGs copied to assets/icons (served at icons/<name>.svg).
// Rendered as a CSS mask so icons take `currentColor` and follow the theme without inlining SVG.
// Owns: the icon name list and the <Icon> element. Never: fetches or inlines SVG markup.
// To add an icon: copy node_modules/@phosphor-icons/core/assets/regular/<name>.svg into
// apps/desktop/assets/icons and add the name below.

export type IconName =
  | 'house' | 'chat-circle' | 'chat-circle-dots' | 'check-circle' | 'list-checks' | 'users-three' | 'users' | 'user' | 'user-plus'
  | 'sidebar-simple' | 'magnifying-glass' | 'plus' | 'x' | 'copy' | 'check' | 'caret-down' | 'caret-right' | 'caret-left' | 'caret-up'
  | 'microphone' | 'stop' | 'waveform' | 'arrow-up' | 'arrow-down' | 'arrow-left' | 'paperclip' | 'image' | 'calendar-blank'
  | 'squares-four' | 'magic-wand' | 'chat-text' | 'megaphone' | 'gear-six' | 'chart-bar' | 'shield' | 'shield-check'
  | 'arrow-clockwise' | 'arrow-counter-clockwise' | 'download-simple' | 'push-pin' | 'bell' | 'bell-slash' | 'archive' | 'trash'
  | 'pencil-simple' | 'dots-three' | 'info' | 'warning-circle' | 'exclamation-mark' | 'folder' | 'file' | 'crown' | 'lightning'
  | 'at' | 'smiley' | 'app-window' | 'sparkle' | 'clock' | 'camera' | 'monitor' | 'command' | 'circle-notch'
  | 'paperclip' | 'plugs' | 'speaker-high' | 'sun' | 'arrow-bend-up-left'
  | 'git-branch' | 'git-merge' | 'arrow-right' | 'globe' | 'key'
  | 'lightbulb'
  | 'phone' | 'phone-disconnect' // live calls in chats
  | 'arrows-out-simple' | 'arrows-in-simple' | 'share' // B-044: workspace full view, Give to agent
  | 'list-plus' | 'stop-circle' // B-044: the palette's New task, the emergency stop (not a checkbox square)
  | 'play' | 'hourglass-simple' // B-044: My day's focus timer Start and the estimate (not the same clock twice)
  | 'terminal-window' | 'brain' | 'file-text' | 'wrench' | 'eye-slash' // D5: run step lines (command, thought, read, tool, kept internal)
  | 'lock-simple' | 'speaker-slash' | 'dots-three-vertical' | 'clock-counter-clockwise' | 'browsers' // B-055: the browser's connection, a muted tab, its menu, history, the chat's browser
  | 'sign-out'; // F-52: Leave chat (a person's app)

export function Icon(props: { name: IconName; size?: number; class?: string; title?: string }) {
  const size = props.size ?? 18;
  return (
    <span
      class={`icon${props.class ? ` ${props.class}` : ''}`}
      style={{ '--icon': `url("icons/${props.name}.svg")`, width: `${size}px`, height: `${size}px` }}
      aria-hidden={props.title ? undefined : 'true'}
      role={props.title ? 'img' : undefined}
      aria-label={props.title}
    />
  );
}
