// Owns: the receiver's small platform contracts. Never: client credentials or database access.
export interface Statement {
  bind(...args: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface Database { prepare(sql: string): Statement }
export interface Env {
  DB: Database;
  GITHUB_OWNER: string;
  PUBLIC_REPO: string;
  PRIVATE_REPO: string;
  APP_ENCRYPTION_KEY: string;
}
export type { FeedbackSubmission as Payload } from '../../../apps/desktop/src/shared/model/feedback-delivery.ts';
export interface StoredReport { id: string; hash: string; payload: string; state: string; url: string | null; created_at: number }
export type Fetch = typeof fetch;
