// The app's start text, which the Manager's chat receives as the person's own line when the first-run layer ends:
// resources/prompts/onboarding.md (or the person's own <data>/prompts/onboarding.md, context/templates.ts) rendered
// with the profile's name, company and language.
// Owns: these values and the rendering. Never: account labels, e-mails, keys, base URLs or ids.

import type { RuntimeServices } from '../contracts.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { languageName } from '../context/prompt-stable.ts';
import { renderTemplate } from '../context/templates.ts';

/** An own prompt far too long for one chat line is cut. */
export const BRIEF_MAX = 3800;

/** Used when neither an own version nor the shipped prompt can be read: the shipped text. */
const FALLBACK = 'Automatic message from the app, not typed by me: I just installed Autark, entered {{name}}{{^name}}no name{{/name}}{{#company}} and {{company}}{{/company}} and clicked Start. Please set this up for me – you are my personal manager, my right hand. Get to know me first: talk with me, read what is on this PC and on the web about me, my earlier conversations with other AIs (ChatGPT, Claude and others, in their apps or in my browser) and the memories they keep about me, and see how I work. Then build the structure that fits: a head for each area my work really has (for example programming or social media), each set up like you and working beside you, while you stay my personal contact. For parallel work you split yourself (Ultra) instead of hiring many agents. Which language we work in you find out with me – this PC\'s is a first guess. How you go about it is your call. Set yourself up on the way: the passwords saved in my browsers belong in the secrets catalog (exported and imported unread), so you and I can fill logins everywhere, and the models you run on now – for the work, for decisions, for search by meaning – can likely be better: you will see what a real decision model and a real search model would change for me and what I already have for them (my keys and plans, a model this PC can run, a provider\'s offer).';

/** The start text for the Manager's chat (at most BRIEF_MAX characters). */
export function setupBrief(s: RuntimeServices): string {
  let template = '';
  try { template = s.prompts?.text('onboarding') ?? ''; } catch (error) { s.log.warn('onboarding prompt unreadable', { error: String(error) }); }
  const profile = s.settings.get().profile;
  const text = renderTemplate(template.trim() || FALLBACK, {
    name: excerpt(profile.name.trim(), 80), company: excerpt(profile.company.trim(), 120), language: languageName(profile.language),
  });
  return text.length > BRIEF_MAX ? `${text.slice(0, BRIEF_MAX - 1).trimEnd()}…` : text;
}
