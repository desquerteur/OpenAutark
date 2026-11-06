# Third-party notice

Components that ship with or are fetched by Autark besides its npm dependencies. The project itself is Apache-2.0 (LICENSE).

## ONNX Runtime Web (onnxruntime-web, onnxruntime-common)

Runs the local embedding model in a worker thread (apps/desktop, src/runtime/vectors/local-model.ts); shipped in the desktop package.
Copyright (c) Microsoft Corporation. MIT License, https://github.com/microsoft/onnxruntime/blob/main/LICENSE

## paraphrase-multilingual-MiniLM-L12-v2

The small embedding model this PC runs itself (384 numbers, 50+ languages). Not shipped: downloaded on first need from Hugging Face, the int8 ONNX export and tokenizer by Xenova (https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2) of the sentence-transformers model (https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2).
Copyright the sentence-transformers authors. Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0

## elkjs

The ELK graph layout that mermaid (a dependency of the desktop UI) bundles for its diagrams; shipped unmodified inside the desktop package. Its source: https://github.com/kieler/elkjs (npm package `elkjs`).
Copyright (c) Kiel University and others. Eclipse Public License 2.0, https://www.eclipse.org/legal/epl-2.0/

## Geist, Geist Mono and Instrument Serif

The fonts of the website (apps/website/public/fonts), self-hosted as WOFF2 subsets. The licence with the copyright lines is next to them in `apps/website/public/fonts/OFL.txt`.
Geist and Geist Mono: Copyright 2024 The Geist Project Authors (originally Copyright (c) 2023 Vercel, in collaboration with basement.studio), https://github.com/vercel/geist-font
Instrument Serif: Copyright 2022 The Instrument Serif Project Authors, https://github.com/Instrument/instrument-serif
SIL Open Font License 1.1, https://openfontlicense.org
