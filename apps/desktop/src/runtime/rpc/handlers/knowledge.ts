// RPC handlers: knowledge (search, paged list, save as the human, expire, history, pin, forget – delete is delete),
// skills (list/get/save/delete) and modes (list; CTX8: save/delete the person's own modes).
// Owns: param checks and the knowledge list cursor (a numeric offset as string).
// Never: business logic – it delegates to the knowledge, skill and mode services. Items the
// human saves are trusted user knowledge; agents' items keep their own source.
// Tiers: knowledge, skill reads and modes with 'chat'; skills.save with 'manage';
// skills.delete and knowledge.forget (permanent, needs confirm: true) stay owner-only, and so
// do modes.save and modes.delete (CTX8; the mode library validates the fields).

import { WorkforceError } from '../../../shared/errors.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { fingerprint, mentions } from '../../privacy/mentions.ts';
import '../../contracts/ledger.ts';
import type { KnowledgeItem, KnowledgeKind, KnowledgeListFilter, KnowledgeQuery, KnowledgeScope } from '../../../shared/model/knowledge.ts';
import {
  bad, id, input, notFound, oneOf, onlyKeys, optBool, optId, optNum, optOneOf, optStrings, optText, text,
} from '../params.ts';
import type { HandlerTable } from '../table.ts';
import { LIMITS, MODE_CATEGORIES, MODE_QUALIFIED_TIERS, MODE_TIERS, MODE_WORKSPACES } from '../../modes/service.ts';

const CHAT = { capability: 'chat' } as const;
const MANAGE = { capability: 'manage' } as const;
const SCOPES: readonly KnowledgeScope[] = ['global', 'space', 'agent', 'conversation', 'website', 'app', 'mode', 'reference']; // mode: scopeId = mode key (CTX3)
const KINDS: readonly KnowledgeKind[] = ['fact', 'preference', 'experience', 'procedure', 'plan', 'observation', 'note', 'reference'];
const PAGE = 50;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function listFilter(values: unknown, key: string, allowed: readonly string[]): string[] | undefined {
  const list = optStrings({ [key]: values }, key, { maxItems: allowed.length, max: 40 });
  if (list?.some((value) => !allowed.includes(value))) bad(key, `values from ${allowed.join(', ')}`);
  return list;
}

function skillName(o: Record<string, unknown>): string {
  const name = text(o, 'name', { max: 64 });
  if (!SKILL_NAME.test(name)) bad('name', 'a lowercase-hyphen skill name');
  return name;
}

export function register(table: HandlerTable): void {
  // ---------------------------------------------------------------- knowledge
  table.add('knowledge.search', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['text', 'agentId', 'conversationId', 'scopes', 'kinds', 'at', 'includeExpired', 'limit', 'before', 'rank']); // rank: older apps send it
    const query: KnowledgeQuery = {
      text: text(o, 'text', { max: 1000, multiline: true }), agentId: optId(o, 'agentId'), conversationId: optId(o, 'conversationId'),
      scopes: listFilter(o.scopes, 'scopes', SCOPES) as KnowledgeScope[] | undefined, kinds: listFilter(o.kinds, 'kinds', KINDS) as KnowledgeKind[] | undefined,
      at: optNum(o, 'at', { min: 0 }), includeExpired: optBool(o, 'includeExpired'), limit: optNum(o, 'limit', { min: 1, max: 100 }),
      before: optNum(o, 'before', { min: 0 }),
    };
    return ctx.services.knowledge.search(query);
  }, CHAT);
  table.add('knowledge.list', async (params, ctx) => {
    const o = input(params);
    const cursor = optText(o, 'cursor', { max: 12 });
    if (cursor !== undefined && !/^\d{1,9}$/.test(cursor)) bad('cursor', 'the cursor from the previous page');
    const offset = cursor ? Number(cursor) : 0;
    const limit = optNum(o, 'limit', { min: 1, max: 200 }) ?? PAGE;
    // One extra row tells whether another page exists.
    const filter: KnowledgeListFilter = {
      scope: optOneOf(o, 'scope', SCOPES), scopeId: optText(o, 'scopeId', { max: 200, allowEmpty: true }) || undefined, kind: optOneOf(o, 'kind', KINDS),
      kinds: listFilter(o.kinds, 'kinds', KINDS), pinned: optBool(o, 'pinned'), limit: limit + 1, offset,
      before: optNum(o, 'before', { min: 0 }),
    };
    const rows = await ctx.services.knowledge.list(filter);
    const items = rows.slice(0, limit);
    // The first page also names the kinds stored at all.
    const kinds = offset === 0 ? await ctx.services.knowledge.kinds?.() : undefined;
    return { items, ...(rows.length > limit ? { next: String(offset + limit) } : {}), ...(kinds ? { kinds } : {}) };
  }, CHAT);
  table.add('knowledge.save', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'scope', 'scopeId', 'kind', 'title', 'body', 'tags', 'confidence', 'pinned', 'validFrom', 'validTo']);
    const item: Partial<KnowledgeItem> & { title: string; body: string; scope: KnowledgeScope; createdBy: string } = {
      title: text(o, 'title', { max: 300 }), body: text(o, 'body', { max: 50_000, multiline: true }), scope: oneOf(o, 'scope', SCOPES),
      createdBy: HUMAN_ID, source: { kind: 'user', trusted: true },
    };
    const itemId = optId(o, 'id');
    if (itemId) item.id = itemId;
    const scopeId = optText(o, 'scopeId', { max: 200, allowEmpty: true });
    if (scopeId) item.scopeId = scopeId;
    // A new mode item names an existing specialist mode (CTX3; general work shares through global); an edit keeps its place.
    if (!itemId && item.scope === 'mode' && (!scopeId || scopeId === 'general' || ctx.services.modes.get(scopeId).key !== scopeId)) bad('scopeId', 'the key of a mode other than general');
    const kind = optOneOf(o, 'kind', KINDS);
    if (kind) item.kind = kind;
    const tags = optStrings(o, 'tags', { maxItems: 30, max: 60 });
    if (tags) item.tags = tags;
    const confidence = optNum(o, 'confidence', { min: 0, max: 1, integer: false });
    if (confidence !== undefined) item.confidence = confidence;
    const pinned = optBool(o, 'pinned');
    if (pinned !== undefined) item.pinned = pinned;
    const validFrom = optNum(o, 'validFrom', { min: 0 });
    if (validFrom !== undefined) item.validFrom = validFrom;
    const validTo = optNum(o, 'validTo', { min: 0 });
    if (validTo !== undefined) item.validTo = validTo;
    return ctx.services.knowledge.save(item);
  }, CHAT);
  table.add('knowledge.expire', (params, ctx) => {
    const o = input(params);
    ctx.services.knowledge.expire(id(o), HUMAN_ID, optText(o, 'reason', { max: 500, multiline: true }));
    return { ok: true };
  }, CHAT);
  table.add('knowledge.history', (params, ctx) => {
    const itemId = id(input(params));
    const chain = ctx.services.knowledge.history(itemId);
    return chain.length ? chain : notFound('Knowledge item', { id: itemId });
  }, CHAT);
  table.add('knowledge.pin', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'pinned']);
    const pinned = optBool(o, 'pinned');
    if (pinned === undefined) bad('pinned', 'true or false');
    return ctx.services.knowledge.pin(id(o), pinned, HUMAN_ID);
  }, CHAT);
  // Owner only: deletes every version. Without confirm: true nothing happens.
  table.add('knowledge.forget', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'confirm']);
    const itemId = id(o);
    if (o.confirm !== true) bad('confirm', 'true (forgetting deletes every version and cannot be undone)');
    const print = fingerprint(ctx.services.knowledge.history(itemId).flatMap((item) => [item.title, item.body]));
    const ids = ctx.services.knowledge.forget(itemId, HUMAN_ID).ids;
    try { ctx.services.ledger?.forget?.((text) => mentions(text, print)); } catch (error) { ctx.services.log.warn('forget: the context ledger was not cleared', { error: String(error) }); } // what the agents' working context still holds of it
    ctx.services.subconscious?.forget?.((text) => mentions(text, print)); // what still waits to be shown to them
    return { ok: true, ids };
  });

  // ---------------------------------------------------------------- skills & modes
  table.add('skills.list', (params, ctx) => (input(params).every === true ? ctx.services.skills.every?.() : undefined) ?? ctx.services.skills.list(), CHAT);
  table.add('skills.get', (params, ctx) => {
    const name = skillName(input(params));
    return ctx.services.skills.get(name) ?? notFound('Skill', { name });
  }, CHAT);
  table.add('skills.save', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['name', 'description', 'body', 'ownerAgentId', 'modes']);
    return ctx.services.skills.save({
      name: skillName(o), description: text(o, 'description', { max: 1024 }), body: text(o, 'body', { max: 200_000, multiline: true }),
      ownerAgentId: optId(o, 'ownerAgentId'),
      modes: optStrings(o, 'modes', { maxItems: 30, max: 64 }), // CTX4: [] = every mode, absent keeps them (keys checked by the service)
    });
  }, MANAGE);
  table.add('skills.delete', (params, ctx) => {
    const name = skillName(input(params));
    if (!ctx.services.skills.get(name)) notFound('Skill', { name });
    ctx.services.skills.remove(name);
    return { ok: true };
  });
  table.add('modes.list', (_params, ctx) => ctx.services.modes.list(), CHAT);
  // CTX8, owner only: fields left out keep the mode's values (or those of `from`); unknown skills are reported.
  table.add('modes.save', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['key', 'from', 'name', 'description', 'instructions', 'skills', 'tools', 'category', 'workspace', 'verifier', 'minTier', 'qualifiedTier']);
    return ctx.services.modes.save({
      key: text(o, 'key', { max: 64 }), from: optText(o, 'from', { max: 64 }),
      name: optText(o, 'name', { max: LIMITS.name }), description: optText(o, 'description', { max: LIMITS.description }),
      instructions: optText(o, 'instructions', { max: LIMITS.instructions, multiline: true }),
      skills: optStrings(o, 'skills', { maxItems: LIMITS.items, max: 64 }), tools: optStrings(o, 'tools', { maxItems: LIMITS.items, max: 64 }),
      category: optOneOf(o, 'category', MODE_CATEGORIES), workspace: optOneOf(o, 'workspace', ['', ...MODE_WORKSPACES] as const),
      verifier: optText(o, 'verifier', { max: LIMITS.verifier, allowEmpty: true }), minTier: optOneOf(o, 'minTier', MODE_TIERS),
      qualifiedTier: optOneOf(o, 'qualifiedTier', ['', ...MODE_QUALIFIED_TIERS] as const),
    });
  });
  // CTX8, owner only: deletes a user mode; a built-in mode of the same key comes back (`restored`).
  table.add('modes.delete', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['key']);
    return { ok: true, ...ctx.services.modes.remove(text(o, 'key', { max: 64 })) };
  });
  // B-044, owner only: Settings › Modes › Open folder – <data>/modes in this PC's file manager (a file there is a mode).
  table.add('modes.openFolder', async (params, ctx) => {
    onlyKeys(input(params ?? {}), []);
    const folder = ctx.services.modes.folder?.();
    if (!folder) throw new WorkforceError('unavailable', 'This runtime keeps no modes of its own.');
    await ctx.services.host.openPath(folder, false);
    return { ok: true as const };
  });
}
