// Owns: /pair/, where a phone lands when it scans the QR code a PC shows for connecting a phone
// (the code carries only the PC's Remote ID, as /pair/#<id>). It shows the ID and the way in.
// On Android it also offers "Open in Autark" (an intent:// link to the app, falling back to the Android page),
// because without App Links (/.well-known/assetlinks.json at the host root) the scan lands here. On an iPhone the Camera
// opens this page in Safari, whose storage is not the Home Screen app's: it says to type the ID in the installed app
// (Copy), and links to the app (config.mjs appUrl, its own origin) when it is not added yet.
// Never: pairing itself; that happens in the Android app or the iPhone web app (appUrl).
import { site, appUrl } from '../config.mjs';
import { page, pageHero, platformRows, abs } from '../layout.mjs';
import { icon } from '../icons.mjs';

// applicationId in apps/android/app/build.gradle (release build).
const ANDROID_PACKAGE = 'com.teydralab.autark.android';

export default function pair(rel) {
  return page({
    slug: 'pair',
    rel,
    noindex: true,
    title: 'Connect your phone',
    description: `Connect your phone to your ${site.name} company with your PC's Remote ID.`,
    body: (root) => `
${pageHero({
  root, crumb: 'Connect your phone',
  title: `Connect your <em>phone.</em>`,
  lead: `This QR code comes from your PC. Open ${site.name} on the phone and type this Remote ID; both screens then show the same code, and you accept on the PC.`,
})}
<section class="section section--tight">
  <div class="wrap">
    <div class="pair" data-reveal>
      <span class="tiny muted">Remote ID</span>
      <div class="pair__id" data-pair-id>Scan the code on your PC again</div>
      <div class="btns">
        <a class="btn btn--ink btn--sm" data-pair-open data-package="${ANDROID_PACKAGE}" data-fallback="${abs('download/android')}" hidden>${icon('android')}<span>Open in ${site.name}</span></a>
        <button class="btn btn--ghost btn--sm" type="button" data-pair-copy hidden>${icon('check')}<span>Copy</span></button>
      </div>
      <p class="small" data-pair-ios hidden style="margin:16px 0 0">On an iPhone: open ${site.name} from your Home Screen, tap <em>Connect</em> and type this ID (Safari keeps its own storage, so the pairing belongs in the Home Screen app). Not added yet? <a href="${appUrl}/">Open the iPhone app</a> and follow the steps there.</p>
    </div>
    <p class="small muted" style="margin:28px 0 40px">No ${site.name} on this phone yet? Android: install the app. iPhone: add <a href="${appUrl}/">the web app</a> to the Home Screen.</p>
    ${platformRows(root)}
  </div>
</section>`,
  });
}
