// What embeds a text: the one interface, and the OpenAI-compatible /embeddings client for local servers (Ollama, LM
// Studio …) and API keys. Models that take a shorter vector without losing much (Matryoshka) are cut to MRL_DIMENSIONS,
// Qwen3 queries get the instruction Qwen asks for. A failed connection is repeated once; a redirect is never followed
// (the texts stay with the host they were meant for).
// Owns: the Embedder shape and that client (what a call used goes to its `onUsage`). Never: chooses a model (models/embeddings.ts) or stores anything.

export interface Embedder {
  /** Model and preprocessing: vectors of two ids are never compared. */
  readonly id: string;
  /** Texts per call. */
  readonly batch: number;
  /** The text leaves this PC (it is redacted first). */
  readonly remote: boolean;
  /** One unit vector per text. */
  embed(texts: string[], purpose: 'query' | 'document'): Promise<Float32Array[]>;
}

export type EmbedFetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

const MRL_DIMENSIONS = 512;
const MRL: readonly RegExp[] = [/qwen3-embedding/i, /text-embedding-3-(small|large)/i, /gemini-embedding/i, /jina-embeddings-v[45]/i];
const QWEN_QUERY = 'Instruct: Given a question or work context, retrieve relevant messages, notes, files or tool results\nQuery:';
const TIMEOUT_MS = 60_000;
const RETRY_PAUSE_MS = 250;

export function unit(vector: ArrayLike<number>, cut?: number): Float32Array {
  const out = Float32Array.from(cut && vector.length > cut ? Array.prototype.slice.call(vector, 0, cut) as number[] : vector as ArrayLike<number>);
  let length = 0;
  for (let i = 0; i < out.length; i++) length += out[i] * out[i];
  length = Math.sqrt(length) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= length;
  return out;
}

/** The embeddings address of a base URL that ends in its API version (".../v1", ".../openai") or has none yet. */
export function embeddingsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/(v\d+[a-z0-9]*|openai)$/i.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`;
}

export interface HttpEmbedderOptions {
  provider: string;
  baseUrl: string;
  model: string;
  remote: boolean;
  /** The server takes the `dimensions` field (a local one is only cut here). */
  sendDimensions: boolean;
  apiKey: () => Promise<string | undefined>;
  fetch?: EmbedFetch;
  /** What a call used, as the server says it (OpenRouter `cost`, DeepInfra `estimated_cost`): the spend journal's input. */
  onUsage?: (use: { tokens: number; costUsd?: number }) => void;
}

export class HttpEmbedder implements Embedder {
  readonly id: string;
  readonly batch = 32;
  readonly remote: boolean;
  private readonly options: HttpEmbedderOptions;
  private readonly dimensions?: number;

  constructor(options: HttpEmbedderOptions) {
    this.options = options;
    this.remote = options.remote;
    this.dimensions = MRL.some((pattern) => pattern.test(options.model)) ? MRL_DIMENSIONS : undefined;
    this.id = `${options.provider}:${options.model}${this.dimensions ? `:d${this.dimensions}` : ''}`;
  }

  async embed(texts: string[], purpose: 'query' | 'document'): Promise<Float32Array[]> {
    const prefix = purpose === 'query' && /qwen3-embedding/i.test(this.options.model) ? `${QWEN_QUERY} ` : '';
    const key = await this.options.apiKey();
    const body = JSON.stringify({
      model: this.options.model,
      input: texts.map((text) => prefix + text),
      ...(this.dimensions && this.options.sendDimensions ? { dimensions: this.dimensions } : {}),
    });
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
    const response = await this.post(embeddingsUrl(this.options.baseUrl), headers, body);
    if (!response.ok) throw new Error(`The embedding server answered ${response.status}.`);
    const answer = await response.json() as { data?: Array<{ embedding?: number[]; index?: number }>; usage?: { prompt_tokens?: number; total_tokens?: number; cost?: number; estimated_cost?: number } };
    const rows = [...(answer.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length !== texts.length) throw new Error('The embedding server answered with the wrong number of vectors.');
    const tokens = answer.usage?.total_tokens ?? answer.usage?.prompt_tokens;
    const costUsd = answer.usage?.cost ?? answer.usage?.estimated_cost;
    if (tokens !== undefined) this.options.onUsage?.({ tokens, ...(costUsd !== undefined ? { costUsd } : {}) });
    return rows.map((row) => unit(row.embedding ?? [], this.dimensions));
  }

  private async post(url: string, headers: Record<string, string>, body: string): ReturnType<EmbedFetch> {
    const send = this.options.fetch ?? fetch;
    for (let attempt = 1; ; attempt++) {
      try {
        return await send(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
      } catch (error) {
        if (attempt >= 2 || (error as Error).name === 'TimeoutError') throw new Error('The embedding server could not be reached.', { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    }
  }
}
