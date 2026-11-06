// B-055: opening the feedback tour from anywhere (the command palette's "Watch how it works"; the
// first run shows it itself). The player (ui/tour/TourPlayer.tsx) is mounted by the shell while
// `tourOpen` is true.
// Owns: the open/close signal. Never: the player or its timeline.

import { signal } from '@preact/signals';

/** True while the tour is shown as a dialog over the app (not the first-run step). */
export const tourOpen = signal(false);

export function openTour(): void { tourOpen.value = true; }
export function closeTour(): void { tourOpen.value = false; }
