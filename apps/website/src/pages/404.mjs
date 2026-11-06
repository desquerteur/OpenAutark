import { site } from '../config.mjs';
import { page } from '../layout.mjs';
import { icon } from '../icons.mjs';

// Served by the host for unknown addresses. Links are absolute to the site
// because the page can be shown at any depth.
export default function notFound(rel) {
  const html = page({
    slug: '',
    rel,
    title: `Page not found · ${site.name}`,
    description: `This page does not exist. ${site.name}: your own AI company on your own computer.`,
    body: () => `
<section class="phero" style="min-height:80svh;display:flex;align-items:center;border:0">
  <div class="wrap">
    <span class="eyebrow">404</span>
    <h1 style="margin-top:24px">Nobody here. <em>Not even an agent.</em></h1>
    <p class="lead">The page you are looking for does not exist or has moved.</p>
    <div class="btns phero__actions"><a class="btn btn--ink btn--lg" href="${site.url}/">Go to the start${icon('arrow', 'ic--move')}</a><a class="btn btn--ghost btn--lg" href="${site.url}/download/">Download</a></div>
  </div>
</section>`,
  });
  // The shared frame uses relative links; on a 404 they must be absolute.
  return html.replace(/(href|src)="\.\/(?!\/)/g, `$1="${site.url}/`).replace('<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">', '<meta name="robots" content="noindex">');
}
