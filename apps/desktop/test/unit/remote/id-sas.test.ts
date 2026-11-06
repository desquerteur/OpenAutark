// Remote IDs (remote/id.ts) and the match-code exchange (remote/sas.ts): IDs are 9 digits derived
// from the key with a Luhn check digit (every single-digit typo is caught), the typed target is
// an ID or a name; an honest exchange gives both sides the same code and key, a changed nonce
// breaks A's commitment, and a party in the middle (two exchanges) gets equal codes only by chance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { formatRemoteId, luhnDigit, parseTarget, remoteIdOf, validRemoteId } from '../../../src/runtime/remote/id.ts';
import { commitment, matchCode, newEphemeral, newNonce, sessionKey, signedBytes, transcript, verifySide } from '../../../src/runtime/remote/sas.ts';
import { b64url, fingerprintOf, generateEd25519, rawPublic, signEd25519 } from '../../../src/runtime/devices/keys.ts';
import type { PeerInfo } from '../../../src/runtime/devices/pair-proof.ts';

const fp = (seed: string) => fingerprintOf(Buffer.from(seed.padEnd(32, 'x')));

test('Remote ID: 9 digits from the key, stable, Luhn-checked, formatted in groups of three', () => {
  const id = remoteIdOf(fp('laptop'));
  assert.match(id, /^\d{9}$/);
  assert.equal(remoteIdOf(fp('laptop')), id, 'the same key gives the same ID');
  assert.notEqual(remoteIdOf(fp('tower')), id);
  assert.ok(validRemoteId(id));
  assert.equal(luhnDigit(id.slice(0, 8)), id[8]);
  assert.equal(formatRemoteId(id), `${id.slice(0, 3)} ${id.slice(3, 6)} ${id.slice(6)}`);
  // Every single wrong digit is caught before anything is sent.
  for (let index = 0; index < 9; index++) {
    for (let digit = 0; digit < 10; digit++) {
      if (String(digit) === id[index]) continue;
      assert.equal(validRemoteId(id.slice(0, index) + digit + id.slice(index + 1)), false, `typo at ${index}`);
    }
  }
  // Spread: 2 000 keys, almost no collisions in 10^8.
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) seen.add(remoteIdOf(fingerprintOf(randomBytes(32))));
  assert.ok(seen.size >= 1998);
});

test('typed target: an ID with spaces or dashes, a name, or a clear error', () => {
  const id = remoteIdOf(fp('laptop'));
  assert.deepEqual(parseTarget(` ${formatRemoteId(id)} `), { remoteId: id });
  assert.deepEqual(parseTarget(`${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`), { remoteId: id });
  assert.throws(() => parseTarget('12345'), /9 digits/);
  const typo = id.slice(0, 8) + String((Number(id[8]) + 1) % 10);
  assert.throws(() => parseTarget(typo), /typo/);
  assert.deepEqual(parseTarget(' 203.0.113.5 '), { address: 'http://203.0.113.5:47812' }, 'an address gets the peer port');
  assert.deepEqual(parseTarget('pc.example.org:5000'), { address: 'http://pc.example.org:5000' });
  assert.deepEqual(parseTarget('https://pc.example.org'), { address: 'https://pc.example.org:47812' });
  assert.throws(() => parseTarget('   '), /Remote ID or the address/);
  assert.throws(() => parseTarget('http://user:pw@pc.example.org'), /address such as/);
});

function party(name: string) {
  const pair = generateEd25519();
  const pub = rawPublic(pair.publicKey);
  const info: PeerInfo = { id: `dev_${name.toLowerCase().padEnd(12, 'x')}`, name, role: 'home', pub: b64url(pub), addresses: [] };
  return { info, sign: (data: Uint8Array) => signEd25519(pair.privateKey, data) };
}

/** One exchange between target `a` and requester `b`; `swapNa` replaces A's revealed nonce. */
function exchange(a: ReturnType<typeof party>, b: ReturnType<typeof party>, swapNa = false) {
  const ephA = newEphemeral();
  const ephB = newEphemeral();
  const na = newNonce();
  const commit = commitment(ephA.pub, ephB.pub, na);
  const nb = newNonce();
  const t = transcript({ a: a.info, b: b.info, ephA: ephA.pub, ephB: ephB.pub, commit, role: 'ceo' });
  const revealed = swapNa ? newNonce() : na;
  return {
    commitOk: commitment(ephA.pub, ephB.pub, revealed) === commit,
    codeA: matchCode(t, na, nb), codeB: matchCode(t, revealed, nb),
    keyA: sessionKey(ephA.privateKey, ephB.pub, t), keyB: sessionKey(ephB.privateKey, ephA.pub, t),
    sigA: b64url(a.sign(signedBytes('A', t))), sigB: b64url(b.sign(signedBytes('B', t))), t,
  };
}

test('honest exchange: same 4-digit code and key on both sides; signatures bind the long-term keys', () => {
  const a = party('Laptop');
  const b = party('Tower');
  const run = exchange(a, b);
  assert.ok(run.commitOk);
  assert.match(run.codeA, /^\d{4}$/);
  assert.equal(run.codeA, run.codeB);
  assert.deepEqual(run.keyA, run.keyB);
  assert.ok(verifySide(a.info.pub, 'A', run.t, run.sigA));
  assert.ok(verifySide(b.info.pub, 'B', run.t, run.sigB));
  assert.ok(!verifySide(b.info.pub, 'A', run.t, run.sigB), 'a B signature is no A signature');
  assert.ok(!verifySide(party('Mallory').info.pub, 'A', run.t, run.sigA), 'another key does not verify');
});

test('a nonce changed after the commitment is caught; a party in the middle gets equal codes only by chance', () => {
  const a = party('Laptop');
  const b = party('Tower');
  assert.equal(exchange(a, b, true).commitOk, false, 'A cannot pick Na after seeing Nb');
  // In the middle: Mallory runs one exchange with B (posing as the target) and one with A.
  const m = party('Laptop');
  let equal = 0;
  for (let i = 0; i < 300; i++) if (exchange(m, b).codeB === exchange(a, m).codeA) equal++;
  assert.ok(equal <= 2, `codes matched ${equal} times in 300`);
});
