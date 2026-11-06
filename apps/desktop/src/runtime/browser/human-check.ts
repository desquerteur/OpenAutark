// A page that shows a human check (reCAPTCHA, hCaptcha, Cloudflare Turnstile or its "Just a moment…" interstitial,
// "Verify you are human") is reported as a fact under every page result – the agents' own browsers (service.ts
// PageState.humanCheck) and the person's side browser (SideBrowserResult.humanCheck). Nothing is refused.
// Owns: the detection patterns and that one line.

// Only what the page shows counts – the accessibility snapshot holds visible content only, so an invisible
// reCAPTCHA v3 badge or a hidden widget frame is no check, and neither is a footer "protected by reCAPTCHA".
/** A check control: the named frame, checkbox or button of a check widget. */
const CHECK_CONTROL = /recaptcha|hcaptcha|cloudflare security challenge|i(?:'|’)?m not a robot|i am not a robot|verify (?:that )?you(?: are|'re) (?:a )?human|press (?:&|and) hold/i;
/** The words of a check page. */
const CHECK_TEXT = /verify (?:that )?you(?: are|'re) (?:a )?human|i(?:'|’)?m not a robot|are you a robot\?|checking (?:if the site connection is secure|your browser before accessing)|ich bin kein roboter|bestätigen sie, dass sie ein mensch sind/i;
/** Challenge pages by address. */
const CHECK_URL = /challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform\/|captcha-delivery\.com/i;
const CHECK_TITLE = /^(?:just a moment\.*|attention required!? \| cloudflare|verify you are human|ein moment bitte)/i;

/** Does this page ask for a human check? */
export function isHumanCheck(page: { snapshot: string; url: string; title: string }): boolean {
  if (CHECK_TITLE.test(page.title.trim()) || CHECK_URL.test(page.url)) return true;
  return page.snapshot.split('\n').some((line) => {
    const element = /^\s*- (\w+)/.exec(line)?.[1];
    if (element === 'iframe' || element === 'checkbox' || element === 'button') return CHECK_CONTROL.test(line);
    return (element === 'heading' || element === 'text' || element === 'paragraph' || element === 'generic') && CHECK_TEXT.test(line);
  });
}

/** The line below a page result that shows a human check. */
export const HUMAN_CHECK_NOTE = 'This page shows a human check (captcha).';
