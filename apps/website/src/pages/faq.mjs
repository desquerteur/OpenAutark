import { site, maker } from '../config.mjs';
import { page, pageHero, esc } from '../layout.mjs';
import { icon } from '../icons.mjs';
import { faq } from '../data/faq.mjs';

const topics = [
  { id: 'basics', title: 'The basics', qs: ['What is Autark?', 'What does "proactive" mean here?', 'What happens on the first start?', 'Can the AI change the app itself?', 'Is it free?', 'Who makes Autark?', 'Was "Proactive Agent Workforce" the same product?', 'Is Autark open source?'] },
  { id: 'ai', title: 'AI plans and engines', qs: ['Which AI subscriptions does it use?', 'Do I need API keys?', 'What hardware do I need?'] },
  { id: 'access', title: 'Access and data', qs: ['What can agents do on my PC?', 'Can agents spend money or delete things?', 'How do I stop everything at once?', 'How are my passwords and keys handled?', 'Does my data go to your servers?', 'Does Autark read my ChatGPT or Claude password or tokens?'] },
  { id: 'daily', title: 'Everyday use', qs: ['Do agents keep working when I close the window?', 'Can I use it from my phone?', 'Can colleagues join my company?'] },
  { id: 'install', title: 'Download and updates', qs: ['Which platforms are supported?', 'Why does Windows warn me about the installer?', 'Why does my Mac refuse to open it?', 'How do updates work?'] },
];

// Questions are written with the product name; swap it if the name changes.
const named = (s) => s.replaceAll('Autark', site.name);

export default function faqPage(rel) {
  const byQ = Object.fromEntries(faq.map((f) => [f.q, f]));
  const used = new Set(topics.flatMap((t) => t.qs));
  const rest = faq.filter((f) => !used.has(f.q));
  const all = topics.map((t) => ({ ...t, items: t.qs.map((q) => byQ[q]).filter(Boolean) }));
  if (rest.length) all.push({ id: 'more', title: 'More', items: rest });
  return page({
    slug: 'faq',
    rel,
    title: 'Questions and answers',
    description: `Answers about ${site.name}: what it is, what it costs, which ChatGPT and Claude plans it uses, what agents can do on your PC, where your data lives, how agents handle money, phone access, updates and more.`,
    ld: [{ '@type': 'FAQPage', '@id': `${site.url}/faq/#faq`, mainEntity: faq.map((f) => ({ '@type': 'Question', name: named(f.q), acceptedAnswer: { '@type': 'Answer', text: named(f.a) } })) }],
    body: (root) => `
${pageHero({ root, crumb: 'FAQ', title: 'Questions, <em>answered.</em>', lead: `Everything people ask before they let an AI company work for them. Missing something? <a href="${maker.feedbackUrl}" rel="noopener">Ask on GitHub</a> or <a href="${maker.contactUrl}" rel="noopener">contact ${maker.company}</a>.` })}
<section class="section">
  <div class="wrap layout-doc">
    <nav class="toc" aria-label="Topics"><b>Topics</b>${all.map((t) => `<a href="#${t.id}">${t.title}</a>`).join('')}</nav>
    <div>
      ${all.map((t, i) => `
      <section id="${t.id}" style="${i ? 'margin-top:72px' : ''}" aria-labelledby="${t.id}-h">
        <span class="eyebrow"><span class="eyebrow__n">${String(i + 1).padStart(2, '0')}</span> ${t.items.length} questions</span>
        <h2 class="h3" id="${t.id}-h" style="margin:16px 0 20px;font-size:clamp(28px,3vw,40px)">${t.title}</h2>
        <div class="faq">${t.items.map((f) => `<details><summary>${esc(named(f.q))}</summary><div><p>${esc(named(f.a))}</p></div></details>`).join('')}</div>
      </section>`).join('')}
      <div class="callout" style="margin-top:64px">${icon('book')}<div><strong>Want the details?</strong> Read <a href="${root}how-it-works/">how it works</a>, <a href="${root}access/">what agents can reach</a> or the <a href="${root}product/">full list of capabilities</a>. AI assistants can read everything at once in <a href="${root}llms-full.txt">llms-full.txt</a>.</div></div>
    </div>
  </div>
</section>`,
  });
}
