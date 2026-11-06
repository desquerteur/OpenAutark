// Owns: the steps a person actually sees when installing, per platform. One source for /access/,
// /download/ and the /download/<platform>/ pages.
// Never: links to other pages or layout; names come from config.mjs, so they follow a rename.
// Written from what macOS, Windows and Android show for unsigned downloads; there is no Mac and no
// Android phone here to re-check the wording on (README.md, "Beim Release").
import { appUrl, release, site } from '../config.mjs';

const { files, app } = release;
const quarantine = `xattr -dr com.apple.quarantine "/Applications/${app.macBundle}"`;

export const installSteps = {
  windows: () => `
    <ol>
      <li><strong>Download</strong> <code>${files.windows}</code>. Your browser may warn that the file is not commonly downloaded; choose to keep it.</li>
      <li><strong>Start it.</strong> Windows shows a blue box, “Windows protected your PC”, with only a Don’t run button. Choose <em>More info</em>, then <em>Run anyway</em>.</li>
      <li><strong>Install.</strong> Keep “only for me”: no admin rights are needed. Pick a folder or keep the suggested one. A desktop shortcut is created.</li>
    </ol>
    <p><strong>If <em>Run anyway</em> is not offered:</strong> with Smart App Control turned on, Windows can block an unsigned installer outright, and there is no button to get past it. Turning Smart App Control off is a change to your whole PC and your decision. Read Microsoft’s note on it first, or use another PC.</p>`,
  mac: () => `
    <ol>
      <li><strong>Download</strong> the DMG and open it. Drag the app into <em>Applications</em>${release.renamed ? '' : `. It appears as <em>${app.name}</em>, the working name, until the rename release`}.</li>
      <li><strong>Open it.</strong> macOS refuses the first time and says Apple could not check it for malware. Close that box with <em>Done</em>, not <em>Move to Trash</em>.</li>
      <li><strong>macOS 15 and newer:</strong> open <em>System Settings → Privacy &amp; Security</em>, scroll down to <em>Security</em>, choose <em>Open Anyway</em> next to the app’s name and confirm with your password or Touch ID. <strong>macOS 14 and older:</strong> Control-click the app in Applications, choose <em>Open</em>, then <em>Open</em> again.</li>
      <li><strong>If macOS says the app “is damaged”,</strong> or still will not open it, the cause is the quarantine mark macOS puts on downloaded files. Check the file first (below), then remove the mark in Terminal:
        <br><code>${quarantine}</code> <button class="btn btn--sm btn--ghost" type="button" data-copy="${quarantine.replaceAll('"', '&quot;')}" style="margin-left:6px;vertical-align:middle">Copy</button></li>
    </ol>
    <p>That command tells macOS to stop treating this one app as an unchecked download. Nothing is repaired by it and nothing else on your Mac changes. ${site.name} has no Apple Developer ID yet: the app is signed ad hoc and not notarized, so macOS offers no way around these steps. macOS may ask again for access to your keychain after an update, because every build carries its own ad hoc signature.</p>`,
  linux: () => `
    <ol>
      <li><strong>Download</strong> <code>${files.linux}</code> and make it executable: <code>chmod +x ${files.linux}</code>.</li>
      <li><strong>Run it.</strong> It needs FUSE 2, a working Chromium sandbox and a running system keyring. Without a keyring, secrets cannot be stored; there is no plain-text fallback.</li>
    </ol>`,
  android: () => `
    <ol>
      <li><strong>Download</strong> <code>${files.android}</code> on the phone. Chrome may ask whether to keep the file; keep it.</li>
      <li><strong>Open it.</strong> The first time, Android asks to allow installs from your browser: choose <em>Settings</em>, turn on <em>Allow from this source</em>, go back and choose <em>Install</em>. If Play Protect says it does not know the developer, choose <em>More details</em>, then <em>Install anyway</em>.</li>
      <li><strong>Connect it to your company.</strong> Open ${site.name} on the phone and type your PC’s <em>Remote ID</em> (on the PC: Settings → Devices), or scan the QR code shown there. Both screens show the same short code. Choose <em>Accept</em> on the PC.</li>
      <li><strong>Done.</strong> The phone now belongs to your company, not to one PC: the same chats, tasks and notifications as on every PC you linked. Read on one device, read everywhere.</li>
    </ol>
    <p><strong>If you want agents to use your phone:</strong> turn on ${site.name} under <em>Settings → Accessibility</em>. It reads nothing until an agent asks, a small bubble shows while it acts, and tapping the bubble cancels. Android 13 and newer first want <em>App info → ⋮ → Allow restricted settings</em> for an app from outside the Play Store.</p>`,
  iphone: () => `
    <ol>
      <li><strong>Open <a href="${appUrl}/">${appUrl.replace(/^https?:\/\//, '')}/</a> in Safari</strong> on the iPhone. There is no App Store app and no Apple account is needed.</li>
      <li><strong>Tap <em>Share</em>, then <em>Add to Home Screen</em>.</strong> Open ${site.name} from the Home Screen: the pairing and notifications live there, Safari keeps separate storage.</li>
      <li><strong>Type your PC’s Remote ID.</strong> On the PC: Settings → Devices → Connect a phone. Scanning its QR code with the Camera shows the same ID to copy.</li>
      <li><strong>Compare the code</strong> both screens show and <strong>accept on the PC</strong>. From then on the iPhone shows your PC’s own screens, in any network, end to end encrypted through the meeting server.</li>
      <li><strong>Turn notifications on</strong> in Settings → Devices on the iPhone (iOS asks once).</li>
    </ol>
    <p><strong>What an iPhone cannot do:</strong> agents cannot use other iPhone apps for you. iOS offers no way for any third-party app to read the screen or tap. Chats, tasks, notifications and the microphone work.</p>`,
};
