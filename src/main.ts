import './style.css';
import {
  BOX_REGION,
  EXTRA_FORMATS,
  RETAIL_FORMATS,
  beep,
  cameraErrorMessage,
  createGate,
  cropFrame,
  enableContinuousFocus,
  loadDetector,
  trackExtras,
  type FrameDetector,
} from './scanner';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const guide = $('guide');
const overlay = $('overlay');
const overlayText = $('overlayText');
const startBtn = $<HTMLButtonElement>('startBtn');
const cameraSelect = $<HTMLSelectElement>('cameraSelect');
const torchBtn = $<HTMLButtonElement>('torchBtn');
const zoomRow = $('zoomRow');
const zoom = $<HTMLInputElement>('zoom');
const zoomValue = $('zoomValue');
const engineSel = $<HTMLSelectElement>('engineSel');
const confirmSel = $<HTMLSelectElement>('confirmSel');
const areaSel = $<HTMLSelectElement>('areaSel');
const resSel = $<HTMLSelectElement>('resSel');
const gapInput = $<HTMLInputElement>('gapInput');
const extraFormats = $<HTMLInputElement>('extraFormats');
const soundChk = $<HTMLInputElement>('soundChk');
const logBody = $('logBody');
const saveFrameBtn = $<HTMLButtonElement>('saveFrameBtn');

const RES: Record<string, [number, number]> = { '720': [1280, 720], '1080': [1920, 1080], '2160': [3840, 2160] };
const DEVICE_KEY = 'camtest:device';

interface LogRow {
  n: number;
  code: string;
  format: string;
  latencyMs: number;
  at: Date;
}

let stream: MediaStream | null = null;
let running = false;
let session = 0;
let deviceId: string | undefined = readStorage(DEVICE_KEY);
const rows: LogRow[] = [];
const decodeTimes: number[] = [];
let decodesInWindow = 0;
let windowStart = performance.now();

function readStorage(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function showOverlay(text: string | null) {
  overlay.hidden = text === null;
  if (text !== null) overlayText.textContent = text;
}

async function start() {
  stop();
  const my = ++session;
  if (!window.isSecureContext) return showOverlay('The camera needs a secure (https) page. Open the Vercel link, not a local IP address.');
  if (!navigator.mediaDevices?.getUserMedia) return showOverlay('This browser cannot use the camera.');
  showOverlay('Starting camera…');
  startBtn.textContent = 'Stop camera';
  running = true;

  const formats = extraFormats.checked ? [...RETAIL_FORMATS, ...EXTRA_FORMATS] : RETAIL_FORMATS;
  const [w, h] = RES[resSel.value] ?? RES['1080']!;
  let detector: FrameDetector;
  try {
    const [d, media] = await Promise.all([
      loadDetector({ forceZxing: engineSel.value === 'zxing', formats }),
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
          width: { ideal: w },
          height: { ideal: h },
          frameRate: { ideal: 30 },
        },
      }),
    ]);
    if (my !== session) return media.getTracks().forEach((t) => t.stop());
    detector = d;
    stream = media;
  } catch (e) {
    if (my !== session) return;
    if (deviceId && e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) {
      deviceId = undefined; // saved camera gone: use the default one
      return start();
    }
    running = false;
    startBtn.textContent = 'Start camera';
    return showOverlay(cameraErrorMessage(e));
  }

  const track = stream.getVideoTracks()[0];
  void enableContinuousFocus(track);
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  showOverlay(null);
  guide.hidden = areaSel.value !== 'box';
  saveFrameBtn.disabled = false;
  $('engine').textContent = detector.engine === 'native' ? 'Built-in (native)' : 'ZXing (WebAssembly)';
  $('resolution').textContent = `${video.videoWidth}×${video.videoHeight}`;
  void refreshCameras();
  setupExtras(track);
  loop(detector, my);
}

function stop() {
  session++;
  running = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  startBtn.textContent = 'Start camera';
  saveFrameBtn.disabled = true;
  guide.hidden = true;
  torchBtn.hidden = true;
  zoomRow.hidden = true;
}

function loop(detector: FrameDetector, my: number) {
  const gate = createGate({ gapMs: Number(gapInput.value) || 350, confirmations: Number(confirmSel.value) });
  const canvas = document.createElement('canvas');
  const full = { x: 0, y: 0, w: 1, h: 1 };
  const onFrame = async () => {
    if (my !== session) return;
    if (video.readyState >= 2) {
      const t0 = performance.now();
      try {
        const source = cropFrame(video, canvas, areaSel.value === 'box' ? BOX_REGION : full) ?? video;
        const found = await detector.detect(source);
        recordDecode(performance.now() - t0);
        const hit = found[0];
        const code = hit?.rawValue.trim();
        if (code && my === session) {
          const firstSeen = gate.accept(code, performance.now());
          if (firstSeen !== null) onScan(code, hit!.format, performance.now() - firstSeen);
        }
      } catch {
        // one bad frame
      }
    }
    if (my !== session) return;
    if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(() => void onFrame());
    else window.setTimeout(() => void onFrame(), 33);
  };
  void onFrame();
}

function recordDecode(ms: number) {
  decodeTimes.push(ms);
  if (decodeTimes.length > 60) decodeTimes.shift();
  decodesInWindow++;
  const now = performance.now();
  if (now - windowStart >= 1000) {
    const avg = decodeTimes.reduce((a, b) => a + b, 0) / decodeTimes.length;
    $('decodeMs').textContent = `${avg.toFixed(0)} ms`;
    $('fps').textContent = ((decodesInWindow * 1000) / (now - windowStart)).toFixed(0);
    decodesInWindow = 0;
    windowStart = now;
  }
}

function onScan(code: string, format: string, latencyMs: number) {
  const row: LogRow = { n: rows.length + 1, code, format, latencyMs, at: new Date() };
  rows.push(row);
  if (soundChk.checked) {
    beep();
    navigator.vibrate?.(40);
  }
  guide.classList.add('hit');
  window.setTimeout(() => guide.classList.remove('hit'), 180);
  $('lastCode').textContent = code;
  $('lastMeta').textContent = `${format.toUpperCase()} · counted ${latencyMs.toFixed(0)} ms after first seen`;
  $('scanCount').textContent = String(rows.length);
  $('uniqueCount').textContent = String(new Set(rows.map((r) => r.code)).size);
  const tr = document.createElement('tr');
  for (const v of [String(row.n), row.code, row.format, `${row.latencyMs.toFixed(0)} ms`, row.at.toLocaleTimeString([], { hour12: false })]) {
    const td = document.createElement('td');
    td.textContent = v;
    tr.appendChild(td);
  }
  logBody.prepend(tr);
}

async function refreshCameras() {
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    cameraSelect.hidden = cams.length < 2;
    const current = stream?.getVideoTracks()[0]?.getSettings().deviceId;
    cameraSelect.replaceChildren(
      ...cams.map((c, i) => {
        const o = document.createElement('option');
        o.value = c.deviceId;
        o.textContent = c.label || `Camera ${i + 1}`;
        o.selected = c.deviceId === current;
        return o;
      }),
    );
  } catch {
    cameraSelect.hidden = true;
  }
}

function setupExtras(track: MediaStreamTrack | undefined) {
  const extras = trackExtras(track);
  torchBtn.hidden = !extras.torch;
  torchBtn.setAttribute('aria-pressed', 'false');
  torchBtn.onclick = async () => {
    const on = torchBtn.getAttribute('aria-pressed') !== 'true';
    try {
      await extras.setTorch(on);
      torchBtn.setAttribute('aria-pressed', String(on));
    } catch {
      torchBtn.hidden = true;
    }
  };
  zoomRow.hidden = !extras.zoom;
  if (extras.zoom) {
    zoom.min = String(extras.zoom.min);
    zoom.max = String(extras.zoom.max);
    zoom.step = String(extras.zoom.step || 0.1);
    zoom.value = String(extras.zoom.min);
    zoomValue.textContent = `${Number(zoom.value).toFixed(1)}×`;
    zoom.oninput = () => {
      zoomValue.textContent = `${Number(zoom.value).toFixed(1)}×`;
      void extras.setZoom(Number(zoom.value)).catch(() => undefined);
    };
  }
}

/** Download the full camera frame (what the decoder sees) to share a barcode that won't read. */
function saveFrame() {
  if (!video.videoWidth) return;
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d')?.drawImage(video, 0, 0);
  c.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `frame-${video.videoWidth}x${video.videoHeight}-${Date.now()}.png`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}

startBtn.addEventListener('click', () => (running ? stop() : void start()));
cameraSelect.addEventListener('change', () => {
  deviceId = cameraSelect.value;
  try {
    localStorage.setItem(DEVICE_KEY, deviceId);
  } catch {
    // session only
  }
  void start();
});
for (const el of [engineSel, areaSel, resSel, extraFormats]) el.addEventListener('change', () => running && void start());
for (const el of [confirmSel, gapInput]) el.addEventListener('change', () => running && void start());
saveFrameBtn.addEventListener('click', saveFrame);
$('clearBtn').addEventListener('click', () => {
  rows.length = 0;
  logBody.replaceChildren();
  $('scanCount').textContent = '0';
  $('uniqueCount').textContent = '0';
  $('lastCode').textContent = '—';
  $('lastMeta').textContent = '';
});
$('copyBtn').addEventListener('click', async () => {
  const csv = ['n,code,format,seen_to_counted_ms,time', ...rows.map((r) => `${r.n},${r.code},${r.format},${r.latencyMs.toFixed(0)},${r.at.toISOString()}`)].join('\n');
  try {
    await navigator.clipboard.writeText(csv);
    $('copyBtn').textContent = 'Copied ✓';
  } catch {
    $('copyBtn').textContent = 'Copy failed';
  }
  window.setTimeout(() => ($('copyBtn').textContent = 'Copy CSV'), 1500);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && running) stop();
});

// Load the decoder in the background so the first scan is instant.
window.setTimeout(() => void loadDetector({ forceZxing: false, formats: RETAIL_FORMATS }).catch(() => undefined), 300);
