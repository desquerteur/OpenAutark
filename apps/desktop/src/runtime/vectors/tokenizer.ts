// The local embedding model's tokenizer: Hugging Face's tokenizer.json of a Unigram model (XLM-R, as multilingual-e5
// uses it). Text goes NFKC + single spaces, spaces become the Metaspace mark, and Viterbi picks the best-scoring
// pieces; ids are <s> … </s>. NFKC stands in for the file's precompiled charsmap (compared with Hugging Face's own
// tokenizer on German, English, CJK, Arabic and code: the same ids). The class is self-contained: local-worker.ts embeds
// its source in the worker thread.
// Owns: loading the vocabulary and turning text into ids. Never: runs the model or reads anything but the file it gets.

export interface UnigramFile {
  model: { type: string; unk_id?: number; vocab: Array<[string, number]> };
}

export class UnigramTokenizer {
  ids: Map<string, number>;
  scores: Float32Array;
  unkId: number;
  unkScore: number;
  longest: number;

  constructor(file: UnigramFile) {
    if (file.model.type !== 'Unigram' || !Array.isArray(file.model.vocab)) throw new Error('not a Unigram tokenizer');
    const vocab = file.model.vocab;
    this.ids = new Map();
    this.scores = new Float32Array(vocab.length);
    let lowest = 0;
    let longest = 1;
    for (let id = 0; id < vocab.length; id++) {
      const piece = vocab[id][0];
      this.ids.set(piece, id);
      this.scores[id] = vocab[id][1];
      if (vocab[id][1] < lowest) lowest = vocab[id][1];
      if (piece.length > longest) longest = piece.length;
    }
    this.unkId = file.model.unk_id ?? 3;
    this.unkScore = lowest - 10;
    this.longest = Math.min(longest, 32);
  }

  /** The ids of `text` between <s> (0) and </s> (2), at most `max` in all (a longer text is cut at the end). */
  encode(text: string, max = 512): number[] {
    const ids = this.pieces(text);
    return [0, ...(ids.length > max - 2 ? ids.slice(0, max - 2) : ids), 2];
  }

  /** Viterbi over the pieces: the best-scoring split of the normalized text. */
  pieces(text: string): number[] {
    const clean = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    const mark = '▁';
    const marked = mark + clean.replaceAll(' ', mark);
    const size = marked.length;
    const best = new Float64Array(size + 1).fill(-Infinity);
    const from = new Int32Array(size + 1).fill(-1);
    best[0] = 0;
    for (let start = 0; start < size; start++) {
      if (best[start] === -Infinity) continue;
      const stop = Math.min(size, start + this.longest);
      let found = false;
      for (let end = start + 1; end <= stop; end++) {
        const id = this.ids.get(marked.slice(start, end));
        if (id === undefined) continue;
        found = true;
        const score = best[start] + this.scores[id];
        if (score > best[end]) { best[end] = score; from[end] = start; }
      }
      if (!found) { // no piece starts here: one unknown character (a surrogate pair stays whole)
        const end = Math.min(size, start + ((marked.codePointAt(start) ?? 0) > 0xffff ? 2 : 1));
        if (best[start] + this.unkScore > best[end]) { best[end] = best[start] + this.unkScore; from[end] = start; }
      }
    }
    const out: number[] = [];
    for (let end = size; end > 0; end = from[end]) {
      const start = from[end];
      if (start < 0) break;
      out.push(this.ids.get(marked.slice(start, end)) ?? this.unkId);
    }
    return out.reverse();
  }
}
