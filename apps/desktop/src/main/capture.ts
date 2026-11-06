// Screen and window capture for the runtime (computer use) and the renderer (feedback screenshots).
// Displays are full resolution (physical pixels via desktopCapturer thumbnails); the app window via
// webContents.capturePage. B-055: the feedback shot
// (windowDataUrl) shows what the person sees – the page plus the visible native views over it (the
// side browser's tab: a WebContentsView the page's own capture leaves out), copied into the page's
// bitmap at their bounds (blit, windowLayers).
// Owns: display listing (index order = screen.getAllDisplays()), source ↔ display matching,
// PNG/JPEG encoding, compositing the window shot. Never: records video, keeps images, or imports
// electron (objects injected).

import { WorkforceError } from '../shared/errors.ts';

export interface ImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  toPNG(): Uint8Array;
  toJPEG(quality: number): Uint8Array;
  toDataURL(): string;
  /** Raw pixels, 4 bytes each, rows packed (nativeImage.toBitmap). */
  toBitmap?(): Uint8Array;
}

export interface LayerRect { x: number; y: number; width: number; height: number }

/** The app window's visible native views over its page (DIP bounds) and the page's width in DIP. */
export interface WindowLayers {
  width: number;
  views: Array<{ bounds: LayerRect; capturePage(): Promise<ImageLike> }>;
}

/** The structural part of a BrowserWindow that windowLayers reads (no electron import here). */
export interface LayeredWindow {
  isDestroyed(): boolean;
  getContentBounds(): LayerRect;
  webContents: { id: number };
  contentView: { children: readonly unknown[] };
}

interface ViewLike {
  getVisible?(): boolean;
  getBounds(): LayerRect;
  webContents: { id: number; isDestroyed(): boolean; capturePage(): Promise<ImageLike> };
}

const isWebView = (view: unknown): view is ViewLike =>
  typeof view === 'object' && view !== null && 'webContents' in view && typeof (view as ViewLike).getBounds === 'function';

/** The window's visible web views besides its own page (the side browser's shown tab), in stacking order. */
export function windowLayers(window: LayeredWindow | null): WindowLayers | null {
  if (!window || window.isDestroyed()) return null;
  const views = window.contentView.children.filter(isWebView).filter((view) =>
    view.webContents.id !== window.webContents.id && !view.webContents.isDestroyed() && (view.getVisible?.() ?? true));
  return {
    width: window.getContentBounds().width,
    views: views.map((view) => ({ bounds: view.getBounds(), capturePage: () => view.webContents.capturePage() })),
  };
}

export interface Bitmap { data: Uint8Array; width: number; height: number }

/** Copies `layer` into `base` with its top-left at (x, y), clipped to `base` (4 bytes per pixel, packed rows). */
export function blit(base: Bitmap, layer: Bitmap, x: number, y: number): void {
  if (layer.data.length < layer.width * layer.height * 4 || base.data.length < base.width * base.height * 4) return;
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(base.width, x + layer.width);
  const bottom = Math.min(base.height, y + layer.height);
  if (right <= left || bottom <= top) return;
  const bytes = (right - left) * 4;
  for (let row = top; row < bottom; row++) {
    const from = ((row - y) * layer.width + (left - x)) * 4;
    base.data.set(layer.data.subarray(from, from + bytes), (row * base.width + left) * 4);
  }
}

export interface DisplayLike {
  id: number;
  size: { width: number; height: number }; // DIP
  scaleFactor: number;
}

export interface CaptureDeps {
  screen: { getAllDisplays(): DisplayLike[]; getPrimaryDisplay(): DisplayLike };
  /** desktopCapturer.getSources */
  getSources(options: { types: Array<'screen'>; thumbnailSize: { width: number; height: number } }): Promise<Array<{ display_id: string; thumbnail: ImageLike }>>;
  /** Our window's webContents, null when the window is closed. */
  appContents(): { capturePage(): Promise<ImageLike> } | null;
  /** B-055: the native views over the page (windowLayers); missing = the page alone. */
  appLayers?(): WindowLayers | null;
  /** nativeImage.createFromBitmap – the composited window shot; missing = the page alone. */
  fromBitmap?(data: Uint8Array, size: { width: number; height: number }): ImageLike;
}

export interface DisplayInfo { index: number; width: number; height: number; scale: number; primary: boolean }
export interface Shot { data: Uint8Array; width: number; height: number; mime: string }

const JPEG_QUALITY = 85;

function physical(display: DisplayLike): { width: number; height: number } {
  return { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
}

/**
 * Bytes that own their whole ArrayBuffer. Structured clone (postMessage to the runtime) copies the
 * entire underlying buffer of a view – a slice of Node's shared Buffer pool would leak along.
 */
export function ownBytes(data: Uint8Array): Uint8Array {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return new Uint8Array(data.buffer);
  return new Uint8Array(data); // copy out of a shared pool
}

function encode(image: ImageLike, format: 'png' | 'jpeg'): Shot {
  if (image.isEmpty()) throw new WorkforceError('unavailable', 'The screen could not be captured.');
  const { width, height } = image.getSize();
  const data = format === 'jpeg' ? image.toJPEG(JPEG_QUALITY) : image.toPNG();
  return { data: ownBytes(data), width, height, mime: format === 'jpeg' ? 'image/jpeg' : 'image/png' };
}

export class Capture {
  private readonly deps: CaptureDeps;

  constructor(deps: CaptureDeps) {
    this.deps = deps;
  }

  /** Width/height are physical pixels (what a full-resolution screenshot has); scale = DPI factor. */
  displays(): DisplayInfo[] {
    const primary = this.deps.screen.getPrimaryDisplay().id;
    return this.deps.screen.getAllDisplays().map((display, index) => ({
      index, ...physical(display), scale: display.scaleFactor, primary: display.id === primary,
    }));
  }

  async screenshot(target: { display?: number; window?: 'app' }, format: 'png' | 'jpeg' = 'png'): Promise<Shot> {
    if (target.window === 'app') return encode(await this.windowImage(), format);
    return encode(await this.displayImage(target.display), format);
  }

  /** PNG data URL of our window as the person sees it – with the side browser's view (feedback screenshot). */
  async windowDataUrl(): Promise<string> {
    // The views are read and captured together with the page, right now: what is shown at the press
    // (a menu opening a moment later hides the side browser's view – native-surface.ts).
    const layers = this.deps.appLayers?.() ?? null;
    const start = (view: WindowLayers['views'][number]): Promise<ImageLike> => { try { return view.capturePage(); } catch (error) { return Promise.reject(error); } };
    const views = (layers?.views ?? []).map((view) => ({ bounds: view.bounds, image: start(view) }));
    for (const view of views) view.image.catch(() => undefined); // never an unhandled rejection
    const image = await this.windowImage();
    if (image.isEmpty()) throw new WorkforceError('unavailable', 'The window could not be captured.');
    return (await this.withViews(image, layers?.width ?? 0, views).catch(() => image)).toDataURL();
  }

  /** The page's image with the visible native views copied in at their bounds (scaled DIP → pixels). */
  private async withViews(page: ImageLike, width: number, views: Array<{ bounds: LayerRect; image: Promise<ImageLike> }>): Promise<ImageLike> {
    const fromBitmap = this.deps.fromBitmap;
    if (!views.length || !fromBitmap || !page.toBitmap) return page;
    const shots = await Promise.all(views.map(async (view) => ({ bounds: view.bounds, image: await view.image })));
    const size = page.getSize();
    const scale = size.width / Math.max(1, width);
    const base: Bitmap = { data: page.toBitmap(), ...size };
    let copied = false;
    for (const { bounds, image } of shots) {
      if (image.isEmpty() || !image.toBitmap) continue;
      blit(base, { data: image.toBitmap(), ...image.getSize() }, Math.round(bounds.x * scale), Math.round(bounds.y * scale));
      copied = true;
    }
    return copied ? fromBitmap(base.data, size) : page;
  }

  /** PNG data URL of the primary display. */
  async screenDataUrl(): Promise<string> {
    const image = await this.displayImage(undefined);
    if (image.isEmpty()) throw new WorkforceError('unavailable', 'The screen could not be captured.');
    return image.toDataURL();
  }

  private async windowImage(): Promise<ImageLike> {
    const contents = this.deps.appContents();
    if (!contents) throw new WorkforceError('unavailable', 'The app window is closed.');
    return contents.capturePage();
  }

  /** `index` into getAllDisplays(); undefined = primary display. */
  private async displayImage(index: number | undefined): Promise<ImageLike> {
    const all = this.deps.screen.getAllDisplays();
    const primary = this.deps.screen.getPrimaryDisplay();
    if (index !== undefined && (!Number.isSafeInteger(index) || index < 0 || index >= all.length)) {
      throw new WorkforceError('bad_request', 'There is no display with this number.');
    }
    const position = index ?? Math.max(0, all.findIndex(item => item.id === primary.id));
    const display: DisplayLike = all[position] ?? primary;
    // Thumbnails are scaled to fit this box: the chosen display's physical size = full resolution.
    const sources = await this.deps.getSources({ types: ['screen'], thumbnailSize: physical(display) });
    const source = sources.find(item => item.display_id === String(display.id))
      ?? (sources.length === all.length ? sources[position] : undefined)
      ?? (all.length === 1 ? sources[0] : undefined);
    if (!source) throw new WorkforceError('unavailable', 'The screen could not be captured.');
    return source.thumbnail;
  }
}
