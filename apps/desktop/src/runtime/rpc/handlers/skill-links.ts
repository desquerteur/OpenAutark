// RPC handlers (AF-007) of skills from a link: skills.previewLink, skills.linkTargets, skills.installLink, skills.linked,
// skills.checkUpdate, skills.applyUpdate – all with 'manage', like skills.save (people of the organisation reach none).
// Owns: param checks. Never: business logic (skills/links/service.ts through compose/skill-links.ts).

import type { SkillInstallTarget } from '../../../shared/model/skill-links.ts';
import '../../../shared/api/methods-skill-links.ts'; // the method shapes (module augmentation)
import { skillLinksOf } from '../../compose/skill-links.ts';
import { bad, fileId as blobId, id, input, obj, oneOf, onlyKeys, optText, text } from '../params.ts';
import type { HandlerTable } from '../table.ts';

const MANAGE = { capability: 'manage' } as const;

function target(o: Record<string, unknown>): SkillInstallTarget {
  const given = obj(o, 'target');
  const kind = oneOf(given, 'kind', ['shared', 'agent', 'project'] as const);
  if (kind === 'shared') { onlyKeys(given, ['kind'], 'target'); return { kind }; }
  onlyKeys(given, ['kind', 'agentId'], 'target');
  return { kind, agentId: id(given, 'agentId') };
}

export function register(table: HandlerTable): void {
  table.add('skills.previewLink', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['url', 'fileId']);
    const url = optText(o, 'url', { max: 2048 });
    const fileId = o.fileId === undefined || o.fileId === null ? undefined : blobId(o);
    if (!url === !fileId) bad('url', 'a link, or fileId: an uploaded ZIP');
    return skillLinksOf(ctx.services).preview({ ...(url ? { url } : {}), ...(fileId ? { fileId } : {}) });
  }, MANAGE);
  table.add('skills.linkTargets', (_params, ctx) => skillLinksOf(ctx.services).targets(), MANAGE);
  table.add('skills.installLink', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['previewId', 'routes', 'target']);
    const routes = o.routes;
    if (!Array.isArray(routes) || !routes.length || routes.length > 100 || routes.some((route) => typeof route !== 'string' || route.length > 400 || /[\u0000-\u001f\u007f]/.test(route))) bad('routes', 'the folders of the chosen skills (1–100)');
    return skillLinksOf(ctx.services).install({ previewId: text(o, 'previewId', { max: 128 }), routes: routes as string[], target: target(o) });
  }, MANAGE);
  table.add('skills.linked', (_params, ctx) => skillLinksOf(ctx.services).linked(), MANAGE);
  table.add('skills.checkUpdate', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['path', 'fileId']);
    const fileId = o.fileId === undefined || o.fileId === null ? undefined : blobId(o);
    return skillLinksOf(ctx.services).checkUpdate({ path: text(o, 'path', { max: 2048 }), ...(fileId ? { fileId } : {}) });
  }, MANAGE);
  table.add('skills.applyUpdate', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['previewId']);
    return skillLinksOf(ctx.services).applyUpdate({ previewId: text(o, 'previewId', { max: 128 }) });
  }, MANAGE);
}
