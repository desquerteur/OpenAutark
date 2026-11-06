// Ambient declarations for non-TS imports of the UI bundle (esbuild handles them).
// Owns: the `*.css` side-effect import used by main.tsx. Never: real types of app code.

declare module '*.css';
