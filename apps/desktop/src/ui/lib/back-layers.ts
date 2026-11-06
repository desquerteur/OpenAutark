// The small layers above everything – the shared context menu (context-menu.tsx) and the confirm/askText dialog
// (dialog.tsx) – register here, so the phone's Back (ui/pwa/back.ts) closes them first without importing their markup.
// Owns: that list. Never: draws anything.

interface BackLayer { open: () => boolean; close: () => void }

const layers: BackLayer[] = [];

export function addBackLayer(layer: BackLayer): void {
  layers.push(layer);
}

/** Whether a menu or a confirm is open now. */
export function backLayerOpen(): boolean {
  return layers.some((layer) => layer.open());
}

/** Closes what is open (a confirm counts as cancelled). */
export function closeBackLayer(): void {
  for (const layer of layers) if (layer.open()) layer.close();
}
