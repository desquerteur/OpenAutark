// B-055: opening the feedback tour from anywhere (the command palette's "Watch how it works", Settings › Feedback,
// the spotlight tour's feedback step – AF-002: the first run no longer shows it). The player (ui/tour/TourPlayer.tsx) is mounted by the shell while
// `tourOpen` is true.
// Owns: the open/close signal. Never: the player or its timeline.

import { signal } from '@preact/signals';

/** True while the tour is shown as a dialog over the app (not the first-run step). */
export const tourOpen = signal(false);

export function openTour(): void { tourOpen.value = true; }
export function closeTour(): void { tourOpen.value = false; }
