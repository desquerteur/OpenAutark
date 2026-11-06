// The iPhone web app's own screens before the PC's UI takes over (B-078 follow-up): Add to Home Screen (Safari, not
// installed yet), Connect (the PC's Remote ID, typed in 3-3-3 groups or pasted), the code to compare with the PC, waiting
// for the PC (with "Forget this phone" in a fixed row once the PCs stop answering), "This phone was removed" (it comes
// back over the PC's UI), "Update Autark on your PC", "could not start" and "this iPhone is too old". Plain DOM in one fixed, centred frame (styles in
// the website's app page, light and dark, safe-area insets): the title, the body, a status slot that is always two lines
// tall and the honest iOS line – a click never moves a neighbour. The frame goes once the PC UI has mounted.
// Owns: these screens' markup and wording. Never: pairing, connecting or storage (shell.ts drives them).

import { remoteIdOfPairText } from '../../shared/api/methods-phone.ts';
import { IOS_PHONE_USE as IOS_LINE } from '../pwa/hosted.ts';

type Child = Node | string;

function el(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

function button(label: string, kind: 'primary' | 'ghost', onClick: () => void): HTMLButtonElement {
  const node = el('button', { type: 'button', class: `hs-button hs-${kind}` }, label) as HTMLButtonElement;
  node.addEventListener('click', onClick);
  return node;
}

/** "482913071" → "482 913 071" (as far as typed). */
export function groupDigits(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 9);
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ');
}

export class Screens {
  private readonly host: HTMLElement;
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly slot: HTMLElement;
  private forgetButton: HTMLButtonElement | undefined;
  private forgetShown = false;

  constructor(host: HTMLElement) {
    this.host = host;
    this.title = el('h1', { class: 'hs-title' });
    this.body = el('div', { class: 'hs-body' });
    this.slot = el('p', { class: 'hs-status', role: 'status', 'aria-live': 'polite' });
    this.root = el('div', { class: 'hs', id: 'hosted-shell' },
      el('div', { class: 'hs-card' }, el('div', { class: 'hs-brand' }, 'Autark'), this.title, this.body, this.slot, el('p', { class: 'hs-note' }, IOS_LINE)));
    host.append(this.root);
  }

  status(text: string): void { this.slot.textContent = text; }

  hide(): void { this.root.hidden = true; }
  show(): void { this.root.hidden = false; }
  remove(): void { this.root.remove(); }

  private screen(title: string, ...children: Child[]): void {
    if (!this.root.isConnected) this.host.append(this.root); // back over the PC's UI (removed, refused)
    this.forgetButton = undefined;
    this.show();
    this.title.textContent = title;
    this.body.replaceChildren(...children);
    this.status('');
  }

  install(onContinue: () => void): void {
    this.screen('Add Autark to your Home Screen',
      el('ol', { class: 'hs-steps' },
        el('li', {}, 'Tap ', el('b', {}, 'Share'), ' in Safari’s toolbar.'),
        el('li', {}, 'Tap ', el('b', {}, 'Add to Home Screen'), ', then ', el('b', {}, 'Add'), '.'),
        el('li', {}, 'Open ', el('b', {}, 'Autark'), ' from your Home Screen and connect there.')),
      el('p', { class: 'hs-muted' }, 'Notifications and your pairing live in the Home Screen app; Safari keeps its own, separate storage.'),
      el('div', { class: 'hs-actions' }, button('Continue in Safari', 'ghost', onContinue)));
  }

  connect(onConnect: (remoteId: string) => void, initial = ''): void {
    const input = el('input', {
      class: 'hs-input', inputmode: 'numeric', autocomplete: 'off', placeholder: '000 000 000', 'aria-label': 'Remote ID of your PC', maxlength: '11',
    }) as HTMLInputElement;
    input.value = groupDigits(initial);
    const connect = button('Connect', 'primary', () => { const id = input.value.replace(/\D/g, ''); if (id.length === 9) onConnect(id); });
    const ready = () => { connect.disabled = input.value.replace(/\D/g, '').length !== 9; };
    input.addEventListener('input', () => { input.value = groupDigits(input.value); ready(); });
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') connect.click(); });
    const paste = button('Paste', 'ghost', () => {
      void navigator.clipboard?.readText?.().then((text) => {
        const id = remoteIdOfPairText(text);
        if (id) { input.value = groupDigits(id); ready(); } else this.status('The clipboard holds no Remote ID.');
      }).catch(() => this.status('Paste is blocked here. Type the nine digits.'));
    });
    ready();
    this.screen('Connect to your PC',
      el('p', { class: 'hs-muted' }, 'On your PC: Settings › Devices › Connect a phone shows its Remote ID.'),
      input,
      el('div', { class: 'hs-actions' }, connect, paste));
  }

  code(code: string, pcName: string, onCancel: () => void): void {
    this.screen('Compare this code',
      el('div', { class: 'hs-code', 'aria-label': `Code ${code.split('').join(' ')}` }, code),
      el('p', { class: 'hs-muted' }, `Accept on ${pcName} when it shows the same code.`),
      el('div', { class: 'hs-actions' }, button('Cancel', 'ghost', onCancel)));
  }

  /** The spinner, and a fixed row where "Forget this phone" appears when the PCs stop answering (offerForget). */
  waiting(title = 'Connecting to your PC', onForget?: () => void): void {
    const forget = button('Forget this phone', 'ghost', () => onForget?.());
    forget.hidden = !(onForget && this.forgetShown);
    this.screen(title, el('div', { class: 'hs-spinner', 'aria-hidden': 'true' }), el('div', { class: 'hs-actions' }, forget));
    if (onForget) this.forgetButton = forget;
  }

  /** Shows or hides the waiting screen's Forget (its row keeps its height either way). */
  offerForget(shown: boolean): void {
    this.forgetShown = shown;
    if (this.forgetButton) this.forgetButton.hidden = !shown;
  }

  removed(onForget: () => void): void {
    this.screen('This phone was removed',
      el('p', { class: 'hs-muted' }, 'Your PC no longer knows this phone. Forget it here, then connect again with your PC’s Remote ID.'),
      el('div', { class: 'hs-actions' }, button('Forget this phone', 'primary', onForget)));
  }

  failed(text: string): void {
    this.screen('Autark could not start', el('p', { class: 'hs-muted' }, text),
      el('div', { class: 'hs-actions' }, button('Try again', 'primary', () => location.reload())));
  }

  update(onForget: () => void): void {
    this.screen('Update Autark on your PC',
      el('p', { class: 'hs-muted' }, 'Your PC runs a version of Autark that does not serve the iPhone app yet. Update it there (the small update icon), then open this app again.'),
      el('div', { class: 'hs-actions' }, button('Try again', 'primary', () => location.reload()), button('Forget this phone', 'ghost', onForget)));
  }

  unsupported(text: string): void {
    this.screen('This iPhone cannot run Autark', el('p', { class: 'hs-muted' }, text));
  }
}
