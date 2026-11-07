// AF-009 an account's picture and kind (ui/lib/account-face.ts) and the rail's reset wait (ui/lib/limits.ts shortReset,
// railWait): logo → avatar → initials, never an empty slot, never a picture from the network; "Max subscription",
// "API key", "Local server"; "2d 5h" when a plan has no 5-hour reset to count down.
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountFace, accountKind, faceColor, faceInitials, isLocalImage, kindText, logoOf } from '../../../src/ui/lib/account-face.ts';
import { railWait, shortReset, shortWait } from '../../../src/ui/lib/limits.ts';
import { PROVIDER_NAMES } from '../../../src/ui/settings/providers.ts';

const AVATAR = 'blob:app://local/4f1c';
const NOW = Date.UTC(2026, 10, 7, 9, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('the picture is the logo first, then the avatar, then the initials', () => {
  // 1. a provider with a mark: the logo, even when the account has an avatar
  assert.deepEqual(accountFace({ provider: 'claude', name: 'alex', avatar: AVATAR }), { kind: 'logo', logo: 'anthropic' });
  assert.deepEqual(accountFace({ provider: 'codex', name: 'work' }), { kind: 'logo', logo: 'openai' });
  // 2. no mark: the account's own avatar
  assert.deepEqual(accountFace({ provider: 'lmstudio', name: 'LM Studio', avatar: AVATAR }), { kind: 'avatar', src: AVATAR });
  // 3. no mark and no avatar: the initials
  const initials = accountFace({ provider: 'lmstudio', name: 'LM Studio' });
  assert.equal(initials.kind, 'initials');
  assert.equal(initials.kind === 'initials' && initials.text, 'LS');
});

test('an avatar that does not load falls back to the initials; a remote picture is never shown', () => {
  const failed = accountFace({ provider: 'xai', name: 'xAI', avatar: AVATAR }, true);
  assert.equal(failed.kind, 'initials');
  assert.equal(failed.kind === 'initials' && failed.text, 'X');
  for (const remote of ['https://example.com/me.png', 'http://127.0.0.1/a.png', '//cdn.example.com/a.png', 'javascript:alert(1)', '  ']) {
    assert.equal(accountFace({ provider: 'deepseek', name: 'DeepSeek', avatar: remote }).kind, 'initials', remote);
  }
  assert.equal(isLocalImage('data:image/png;base64,AAAA'), true);
  assert.equal(isLocalImage('data:text/html,<b>'), false);
  // the failure belongs to that picture: a working one still shows
  assert.equal(accountFace({ provider: 'vllm', name: 'vLLM', avatar: AVATAR }).kind, 'avatar');
});

test('every provider gets a picture – a logo or letters, never an empty slot', () => {
  for (const provider of Object.keys(PROVIDER_NAMES)) {
    for (const name of [PROVIDER_NAMES[provider as keyof typeof PROVIDER_NAMES], '', '  ', '…']) {
      const face = accountFace({ provider, name });
      if (face.kind === 'logo') continue;
      assert.equal(face.kind, 'initials', provider);
      assert.ok(face.kind === 'initials' && face.text.length >= 1 && face.text.length <= 2, `${provider} / "${name}": ${JSON.stringify(face)}`);
      assert.ok(face.kind === 'initials' && face.color >= 0 && face.color < 6);
    }
  }
});

test('the marks: Anthropic, OpenAI, Gemini, Ollama, GitHub – by provider, else by the connection\'s named service', () => {
  assert.equal(logoOf('anthropic'), 'anthropic');
  assert.equal(logoOf('openai'), 'openai');
  assert.equal(logoOf('google'), 'gemini');
  assert.equal(logoOf('gemini-cli'), 'gemini');
  assert.equal(logoOf('ollama'), 'ollama');
  assert.equal(logoOf('copilot'), 'github');
  assert.equal(logoOf('compatible', 'openai'), 'openai', 'an OpenAI-compatible key on api.openai.com');
  assert.equal(logoOf('compatible', 'mistral'), undefined);
  assert.equal(logoOf('compatible'), undefined);
  assert.equal(logoOf('toString'), undefined, 'no prototype key is a mark');
  assert.deepEqual(accountFace({ provider: 'compatible', name: 'Mistral', service: 'mistral' }), { kind: 'initials', text: 'M', color: faceColor('Mistral') });
});

test('initials: two words or one letter, punctuation ignored; the colour is stable', () => {
  assert.equal(faceInitials('llama.cpp'), 'LC');
  assert.equal(faceInitials('Kimi (Moonshot)'), 'KM');
  assert.equal(faceInitials('OpenRouter'), 'O');
  assert.equal(faceInitials('—'), '?');
  assert.equal(faceColor('Groq'), faceColor('Groq'));
});

test('the kind: a CLI sign-in is a subscription with its tier, a local server, else an API key', () => {
  assert.equal(kindText({ provider: 'claude', auth: 'cli', plan: 'max' }), 'Max subscription');
  assert.equal(kindText({ provider: 'codex', auth: 'cli', plan: 'pro' }), 'Pro subscription');
  assert.equal(kindText({ provider: 'codex', auth: 'cli' }), 'Subscription');
  assert.equal(kindText({ provider: 'openai', auth: 'api_key', plan: 'ignored' }), 'API key');
  assert.equal(kindText({ provider: 'anthropic', auth: 'env' }), 'API key');
  assert.equal(kindText({ provider: 'ollama', auth: 'local' }), 'Local server');
  assert.equal(accountKind({ provider: 'compatible', auth: 'local' }), 'local');
  assert.equal(accountKind({ provider: 'lmstudio', auth: 'none' }), 'local');
  assert.equal(accountKind({ provider: 'gemini-cli', auth: 'cli' }), 'plan');
});

test('the rail\'s wait: the 5-hour reset while it counts down, else the weekly reset in days and hours', () => {
  assert.equal(shortReset(NOW + 42 * MIN, NOW), '42m', 'within a day it is shortWait');
  assert.equal(shortReset(NOW + 2 * DAY + 5 * HOUR + 10 * MIN, NOW), '2d 5h');
  assert.equal(shortReset(NOW + 5 * DAY, NOW), '5d');
  assert.equal(shortReset(NOW + 2 * DAY + 23 * HOUR + 50 * MIN, NOW), '3d', 'a rounded 24 h is the next day');
  assert.equal(shortReset(NOW - MIN, NOW), undefined, 'a passed reset says nothing');
  assert.equal(railWait(NOW + 42 * MIN, NOW + 2 * DAY, NOW), shortWait(NOW + 42 * MIN, NOW));
  assert.equal(railWait(undefined, NOW + 2 * DAY + HOUR, NOW), '2d 1h', 'no 5-hour window: the weekly reset');
  assert.equal(railWait(NOW - MIN, NOW + 5 * DAY, NOW), '5d', 'the 5-hour reset passed: the weekly reset');
  assert.equal(railWait(undefined, undefined, NOW), undefined);
});
