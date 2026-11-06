// `wf feedback setup` (B-055 Q3) on the team's PC: makes the team's key pair (unless the vault has one; --rotate
// makes a new one), puts the private key and the Google service account into the vault (no agent may use either),
// writes resources/feedback/receiver.json (public key, project, web API key – it ships with the next build) and
// answers with the Firestore rules to paste. The team's only other steps are in the Google Cloud console (a Firestore
// project and a service account for it).
// Owns: those steps, in this order. Never: returns or logs the private key or the service account, contacts Google.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { FeedbackSetupResult } from '../../shared/model/feedback-delivery.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { KvRepo } from '../store/kv.ts';
import { parseServiceAccount } from './google.ts';
import { RECEIVER_KEY_ID, SERVICE_ACCOUNT_ID, SETUP_KEY } from './inbox.ts';
import { API_KEY, PROJECT_ID, RULES_FILE, feedbackResources, readReceiver, receiverPath, writeReceiver } from './receiver.ts';
import { generateReceiverKeys, publicKeyOf } from './seal.ts';

export interface SetupInput {
  project: string;
  apiKey: string;
  /** Absolute path of the service account key file (Firebase console › Project settings › Service accounts). */
  serviceAccountPath: string;
  rotate?: boolean;
}

const MAX_ACCOUNT_FILE = 64 * 1024;

function readAccount(file: string): string {
  if (!path.isAbsolute(file)) throw new WorkforceError('bad_request', 'Give the service account file as an absolute path.');
  try {
    if (statSync(file).size > MAX_ACCOUNT_FILE) throw new WorkforceError('bad_request', 'The service account file is too large.');
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof WorkforceError) throw error;
    throw new WorkforceError('not_found', 'The service account file was not found.');
  }
}

export async function setupReceiver(s: RuntimeServices, input: SetupInput): Promise<FeedbackSetupResult> {
  if (!PROJECT_ID.test(input.project)) throw new WorkforceError('bad_request', 'The project id has 6–30 lower-case letters, digits or hyphens (Firebase console › Project settings).');
  if (!API_KEY.test(input.apiKey)) throw new WorkforceError('bad_request', 'The web API key looks wrong (Firebase console › Project settings › Web API key).');
  const accountText = readAccount(input.serviceAccountPath);
  const account = parseServiceAccount(accountText);
  if (account.project_id && account.project_id !== input.project) {
    throw new WorkforceError('bad_request', `The service account belongs to the project "${account.project_id}", not "${input.project}".`);
  }

  const held = s.secrets.list().some((entry) => entry.id === RECEIVER_KEY_ID);
  let publicKey: string;
  let createdKey = false;
  if (held && !input.rotate) {
    publicKey = publicKeyOf(await s.secrets.use(RECEIVER_KEY_ID, SYSTEM_ID));
  } else {
    const keys = generateReceiverKeys();
    await s.secrets.save({
      id: RECEIVER_KEY_ID, label: 'Feedback team key', kind: 'token', value: keys.privateKey, tags: ['feedback'],
      description: 'Opens the feedback people send to the team (Settings › Feedback › Inbox). No agent can read it.',
    });
    publicKey = keys.publicKey;
    createdKey = true;
  }
  await s.secrets.save({
    id: SERVICE_ACCOUNT_ID, label: 'Feedback mailbox service account', kind: 'token', value: accountText, tags: ['feedback'],
    source: 'firebase.google.com',
    description: `Fetches and deletes feedback letters in the Firebase project ${input.project}. No agent can read it.`,
  });

  const receiver = { publicKey, project: input.project, apiKey: input.apiKey };
  new KvRepo(s.db).set(SETUP_KEY.ns, SETUP_KEY.key, receiver, s.clock.now());
  // From source (npm run dev/start) resources/ is the source tree: the file ships with the next build. A packaged
  // app cannot write into its archive – the owner saves the answer's `receiver` there instead.
  let receiverFile: string | undefined;
  if (!s.host.app.packaged) {
    const endpoint = readReceiver(s)?.endpoint; // a local test fake keeps its endpoint
    receiverFile = writeReceiver(receiverPath(s), { ...receiver, ...(endpoint ? { endpoint } : {}) });
  }
  let rules = '';
  try { rules = readFileSync(path.join(feedbackResources(s), RULES_FILE), 'utf8'); } catch { /* answered without the rules text */ }
  s.log.info('feedback receiver set up', { project: input.project, createdKey, rotated: Boolean(input.rotate && held) }); // never a key
  return { publicKey, project: input.project, createdKey, ...(receiverFile ? { receiverFile } : {}), receiver, rules };
}
