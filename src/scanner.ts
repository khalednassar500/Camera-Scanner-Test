/**
 * Camera barcode scanning engine — same logic as the POS register
 * (src/services/scanner/cameraScanner.ts in the POS), with test switches.
 *
 * Decoder: the browser's native BarcodeDetector when present (Chrome on
 * Android / macOS), otherwise ZXing-C++ compiled to WebAssembly and served
 * from this site (iPhone Safari, Windows, Firefox).
 */

export const RETAIL_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'];
/** Extra formats for experiments only (ITF and Code 39 cause most false reads). */
export const EXTRA_FORMATS = ['itf', 'code_39', 'data_matrix'];

export interface Detected {
  rawValue: string;
  format: string;
}

export interface FrameDetector {
  engine: 'native' | 'zxing';
  detect(source: HTMLVideoElement | HTMLCanvasElement): Promise<Detected[]>;
}

interface NativeCtor {
  new (o: { formats: string[] }): { detect(s: CanvasImageSource): Promise<Detected[]> };
  getSupportedFormats(): Promise<string[]>;
}

const cache = new Map<string, Promise<FrameDetector>>();

export function loadDetector(opts: { forceZxing: boolean; formats: string[] }): Promise<FrameDetector> {
  const key = `${opts.forceZxing}|${opts.formats.join(',')}`;
  let p = cache.get(key);
  if (!p) {
    p = createDetector(opts).then(warmUp);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

async function createDetector({ forceZxing, formats }: { forceZxing: boolean; formats: string[] }): Promise<FrameDetector> {
  const native = (globalThis as { BarcodeDetector?: NativeCtor }).BarcodeDetector;
  if (native && !forceZxing) {
    try {
      const supported = await native.getSupportedFormats();
      if (['ean_13', 'code_128'].every((f) => supported.includes(f))) {
        const d = new native({ formats: formats.filter((f) => supported.includes(f)) });
        return { engine: 'native', detect: (s) => d.detect(s) };
      }
    } catch {
      // fall back to ZXing
    }
  }
  const [{ BarcodeDetector, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
    import('barcode-detector/ponyfill'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  await prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
    fireImmediately: true,
  });
  const d = new BarcodeDetector({ formats: formats as never });
  return { engine: 'zxing', detect: async (s) => (await d.detect(s)).map((r) => ({ rawValue: r.rawValue, format: r.format })) };
}

async function warmUp(detector: FrameDetector): Promise<FrameDetector> {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    c.getContext('2d')?.fillRect(0, 0, 64, 64);
    await detector.detect(c);
  } catch {
    // best effort
  }
  return detector;
}

/**
 * A code counts after `confirmations` identical reads in a row; then it is
 * ignored while in view and counts again after `gapMs` out of view.
 */
export function createGate(opts: { gapMs: number; confirmations: number; confirmWindowMs?: number }) {
  const windowMs = opts.confirmWindowMs ?? 400;
  let last: string | null = null;
  let lastSeen = 0;
  let candidate: string | null = null;
  let count = 0;
  let candidateAt = 0;
  let firstSeenAt = 0;
  return {
    /** Returns the time the code was first seen (for latency) when accepted, else null. */
    accept(code: string, now: number): number | null {
      if (code === last && now - lastSeen < opts.gapMs) {
        lastSeen = now;
        return null;
      }
      if (code === candidate && now - candidateAt < windowMs) count += 1;
      else {
        candidate = code;
        count = 1;
        firstSeenAt = now;
      }
      candidateAt = now;
      if (count < opts.confirmations) return null;
      last = code;
      lastSeen = now;
      candidate = null;
      count = 0;
      return firstSeenAt;
    },
    reset() {
      last = candidate = null;
      count = 0;
    },
  };
}

/** The guide box plus margin, as fractions of the frame. */
export const BOX_REGION = { x: 0.08, y: 0.2, w: 0.84, h: 0.6 };
const MAX_DECODE_WIDTH = 1920;

export function cropFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement, region = BOX_REGION): HTMLCanvasElement | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const sw = Math.round(vw * region.w);
  const sh = Math.round(vh * region.h);
  const scale = Math.min(1, MAX_DECODE_WIDTH / sw);
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);
  if (canvas.width !== dw) canvas.width = dw;
  if (canvas.height !== dh) canvas.height = dh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, Math.round(vw * region.x), Math.round(vh * region.y), sw, sh, 0, 0, dw, dh);
  return canvas;
}

export async function enableContinuousFocus(track: MediaStreamTrack | undefined): Promise<void> {
  try {
    const caps = track?.getCapabilities?.() as (MediaTrackCapabilities & { focusMode?: string[] }) | undefined;
    if (track && caps?.focusMode?.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] });
    }
  } catch {
    // not supported
  }
}

/** Phone extras (Chrome on Android): flashlight and optical/digital zoom. */
export function trackExtras(track: MediaStreamTrack | undefined) {
  const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean; zoom?: { min: number; max: number; step: number } };
  return {
    torch: Boolean(caps.torch),
    zoom: caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null,
    async setTorch(on: boolean) {
      await track?.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
    },
    async setZoom(value: number) {
      await track?.applyConstraints({ advanced: [{ zoom: value } as MediaTrackConstraintSet] });
    },
  };
}

let audio: AudioContext | null = null;
export function beep(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    if (audio.state === 'suspended') void audio.resume();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 1800;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.06);
  } catch {
    // silent
  }
}

export function cameraErrorMessage(e: unknown): string {
  const name = e instanceof DOMException || e instanceof Error ? e.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was blocked. Allow the camera for this site in the browser settings, then tap Start again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No matching camera was found. Try another camera or a lower resolution.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is in use by another app. Close it and tap Start again.';
    default:
      return `The camera could not start (${name || String(e)}).`;
  }
}
