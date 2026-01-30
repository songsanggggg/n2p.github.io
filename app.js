const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const guideCanvas = document.getElementById('guide');
const guideCtx = guideCanvas.getContext('2d');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const pauseBtn = document.getElementById('pauseBtn');
const saveBtn = document.getElementById('saveBtn');
const modeInputs = document.querySelectorAll('input[name="mode"]');
const frameCountSelect = document.getElementById('frameCount');
const reDetectBtn = document.getElementById('reDetectBtn');
const detectAggressiveness = document.getElementById('detectAggressiveness');
const detectAggressivenessValue = document.getElementById(
  'detectAggressivenessValue'
);

const video = document.createElement('video');
video.setAttribute('playsinline', '');
video.setAttribute('autoplay', '');

const detectCanvas = document.createElement('canvas');
const detectCtx = detectCanvas.getContext('2d', { willReadFrequently: true });
canvas.style.transition = 'opacity 180ms ease';
guideCanvas.style.transition = 'opacity 180ms ease';

let stream = null;
let rafId = null;
let frameCount = 0;
let lastBoxes = [];
let lockedBox = null;
let selectedIndex = -1;
let dragState = null;
let detectScale = 1;
let paused = false;
let pausedFrameCanvas = null;
let pausedFrameMeta = null;
let imageCapture = null;
let trackCapabilities = null;
let activeTrack = null;
let previewConstraints = null;
let captureConstraints = null;
const MAX_CANVAS_WIDTH = 1280;
const PREVIEW_MAX_STREAM_WIDTH = 1920;
const DETECT_INTERVAL_MS = 140;
let lastDetectTime = 0;
let detectBuffers = null;

function getMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function drawStatus(message) {
  if (!message) return;
  ctx.save();
  ctx.fillStyle = '#0b0d12';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(242, 243, 247, 0.85)';
  ctx.font = `${Math.max(18, canvas.width / 32)}px Manrope, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, canvas.width / 2, canvas.height / 2);
  ctx.restore();
}

async function startCamera() {
  if (stream) return;
  syncCanvasSize();
  drawStatus('正在请求摄像头权限...');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        focusMode: 'continuous',
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    if (!video.videoWidth || !video.videoHeight) {
      await new Promise((resolve) =>
        video.addEventListener('loadedmetadata', resolve, { once: true })
      );
    }
    await applyContinuousFocus(stream);
    imageCapture = null;
    trackCapabilities = null;
    activeTrack = null;
    previewConstraints = null;
    captureConstraints = null;
    const [track] = stream.getVideoTracks();
    if (track && window.ImageCapture) {
      try {
        imageCapture = new ImageCapture(track);
        if (track.getCapabilities) {
          trackCapabilities = track.getCapabilities();
          if (trackCapabilities.width && trackCapabilities.height) {
            const maxWidth = trackCapabilities.width.max || 0;
            const maxHeight = trackCapabilities.height.max || 0;
            const previewW = Math.min(
              maxWidth || PREVIEW_MAX_STREAM_WIDTH,
              PREVIEW_MAX_STREAM_WIDTH
            );
            const previewH = Math.min(
              maxHeight || Math.round((previewW * 9) / 16),
              Math.round((previewW * 9) / 16)
            );
            previewConstraints = {
              width: { ideal: previewW },
              height: { ideal: previewH },
            };
            captureConstraints = {
              width: { ideal: maxWidth || previewW },
              height: { ideal: maxHeight || previewH },
            };
            activeTrack = track;
            try {
              await track.applyConstraints(previewConstraints);
            } catch (error) {
              // Ignore if the device rejects these constraints.
            }
          }
        }
      } catch (error) {
        imageCapture = null;
      }
    }
    syncCanvasSize();
    stopBtn.disabled = false;
    startBtn.disabled = true;
    pauseBtn.disabled = false;
    saveBtn.disabled = true;
    reDetectBtn.disabled = true;
    paused = false;
    pausedFrameCanvas = null;
    pausedFrameMeta = null;
    pauseBtn.textContent = '暂停';
    renderLoop();
  } catch (error) {
    console.error(error);
    syncCanvasSize();
    drawStatus('无法访问摄像头，请检查权限设置。');
  }
}

async function applyContinuousFocus(activeStream) {
  const [track] = activeStream.getVideoTracks();
  if (!track || !track.applyConstraints) return;
  try {
    await track.applyConstraints({
      advanced: [
        { focusMode: 'continuous' },
        { focusDistance: 0 },
      ],
    });
  } catch (error) {
    console.warn('无法设置连续对焦:', error);
  }
}

function stopCamera() {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
  stream = null;
  cancelAnimationFrame(rafId);
  rafId = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  pauseBtn.disabled = true;
  saveBtn.disabled = true;
  reDetectBtn.disabled = true;
  paused = false;
  pausedFrameCanvas = null;
  pausedFrameMeta = null;
  pauseBtn.textContent = '暂停';
  // remove any live preview filter
  canvas.style.filter = 'none';
  syncCanvasSize();
  drawStatus('摄像头已停止');
}

function syncCanvasSize() {
  let width = video.videoWidth || 1280;
  let height = video.videoHeight || 720;
  // Cap internal drawing buffer to a reasonable max to keep CPU usage down
  if (width > MAX_CANVAS_WIDTH) {
    const aspect = height / width;
    width = MAX_CANVAS_WIDTH;
    height = Math.max(1, Math.round(MAX_CANVAS_WIDTH * aspect));
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    guideCanvas.width = width;
    guideCanvas.height = height;
  }
  syncDetectCanvasSize();
}

function syncDetectCanvasSize() {
  const sourceW = canvas.width || 1280;
  const sourceH = canvas.height || 720;
  const targetW = Math.min(720, sourceW);
  detectScale = targetW / sourceW;
  const targetH = Math.max(1, Math.round(sourceH * detectScale));
  if (detectCanvas.width !== Math.round(targetW) || detectCanvas.height !== targetH) {
    detectCanvas.width = Math.round(targetW);
    detectCanvas.height = targetH;
    if (detectBuffers) {
      releaseDetectBuffers();
    }
  }
}

function drawGuide(boxes) {
  guideCtx.clearRect(0, 0, guideCanvas.width, guideCanvas.height);
  if (!boxes || boxes.length === 0) {
    guideCanvas.style.display = 'none';
    guideCanvas.style.pointerEvents = 'none';
    return;
  }
  guideCanvas.style.display = 'block';
  guideCanvas.style.pointerEvents = paused ? 'auto' : 'none';
  guideCtx.lineWidth = Math.max(2, guideCanvas.width / 320);
  guideCtx.shadowBlur = 8;
  boxes.forEach((box, index) => {
    const isSelected = index === selectedIndex;
    guideCtx.strokeStyle = isSelected
      ? 'rgba(77, 214, 193, 0.95)'
      : 'rgba(255, 138, 91, 0.9)';
    guideCtx.shadowColor = isSelected
      ? 'rgba(77, 214, 193, 0.35)'
      : 'rgba(255, 138, 91, 0.35)';
    guideCtx.strokeRect(box.x, box.y, box.w, box.h);

    if (isSelected) {
      const handle = getHandleSize();
      const half = handle / 2;
      const points = [
        [box.x, box.y],
        [box.x + box.w, box.y],
        [box.x + box.w, box.y + box.h],
        [box.x, box.y + box.h],
      ];
      guideCtx.fillStyle = 'rgba(77, 214, 193, 0.95)';
      points.forEach(([x, y]) => {
        guideCtx.fillRect(x - half, y - half, handle, handle);
      });
    }
  });
  guideCtx.shadowBlur = 0;
}

function getHandleSize() {
  return Math.max(30, guideCanvas.width / 18);
}

function getHandleHitbox() {
  return Math.max(52, guideCanvas.width / 12);
}

function lerp(start, end, t) {
  return start + (end - start) * t;
}

function getDetectParams() {
  const value = Math.max(0, Math.min(100, Number(detectAggressiveness?.value || 70)));
  const t = value / 100;
  return {
    cannyLow: lerp(60, 20, t),
    cannyHigh: lerp(160, 80, t),
    minAreaRatio: lerp(0.008, 0.0018, t),
    ratioMax: lerp(5.5, 9.5, t),
    rectangularityMin: lerp(0.35, 0.12, t),
    dilateIters: Math.round(lerp(1, 3, t)),
    value,
  };
}

function updateAggressivenessLabel() {
  if (!detectAggressivenessValue) return;
  const value = Math.max(0, Math.min(100, Number(detectAggressiveness?.value || 70)));
  detectAggressivenessValue.textContent = `${value}%`;
}

function updateLockedInLastBoxes() {
  if (!lockedBox) return;
  if (!lastBoxes || lastBoxes.length === 0) {
    lastBoxes = [lockedBox];
    return;
  }
  let bestIndex = -1;
  let bestIou = 0;
  lastBoxes.forEach((box, index) => {
    const overlap = iou(box, lockedBox);
    if (overlap > bestIou) {
      bestIou = overlap;
      bestIndex = index;
    }
  });
  if (bestIndex >= 0 && bestIou > 0.2) {
    lastBoxes[bestIndex] = lockedBox;
  } else {
    lastBoxes = [lockedBox, ...lastBoxes].slice(0, 20);
  }
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  const inter = w * h;
  if (inter <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union ? inter / union : 0;
}

function detectFilmFrames(source) {
  if (!window.__cvReady) return [];
  const buffers = ensureDetectBuffers();
  if (!buffers) return [];
  const params = getDetectParams();
  const input = source || video;
  detectCtx.drawImage(input, 0, 0, detectCanvas.width, detectCanvas.height);

  const src = cv.imread(detectCanvas);
  cv.cvtColor(src, buffers.gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(buffers.gray, buffers.blur, new cv.Size(5, 5), 0);
  cv.Canny(buffers.blur, buffers.edges, params.cannyLow, params.cannyHigh);
  cv.dilate(
    buffers.edges,
    buffers.edges,
    buffers.kernel,
    new cv.Point(-1, -1),
    params.dilateIters
  );
  cv.findContours(
    buffers.edges,
    buffers.contours,
    buffers.hierarchy,
    cv.RETR_EXTERNAL,
    cv.CHAIN_APPROX_SIMPLE
  );

  const boxes = [];
  const minArea =
    detectCanvas.width * detectCanvas.height * params.minAreaRatio;
  for (let i = 0; i < buffers.contours.size(); i += 1) {
    const cnt = buffers.contours.get(i);
    const area = cv.contourArea(cnt);
    if (area < minArea) {
      cnt.delete();
      continue;
    }
    const rect = cv.minAreaRect(cnt);
    const width = Math.max(rect.size.width, 1);
    const height = Math.max(rect.size.height, 1);
    const ratio = Math.max(width, height) / Math.max(1, Math.min(width, height));
    const rectArea = width * height;
    const rectangularity = rectArea ? area / rectArea : 0;

    if (ratio > params.ratioMax || rectangularity < params.rectangularityMin) {
      cnt.delete();
      continue;
    }
    const bounds = cv.boundingRect(cnt);
    boxes.push({
      x: bounds.x,
      y: bounds.y,
      w: bounds.width,
      h: bounds.height,
      area: bounds.width * bounds.height,
    });
    cnt.delete();
  }

  src.delete();

  boxes.sort((a, b) => b.area - a.area);
  return boxes.slice(0, getDesiredFrameCount());
}

function getHandleAt(x, y, box) {
  const hitbox = getHandleHitbox();
  const half = hitbox / 2;
  const points = [
    { id: 'tl', x: box.x, y: box.y },
    { id: 'tr', x: box.x + box.w, y: box.y },
    { id: 'br', x: box.x + box.w, y: box.y + box.h },
    { id: 'bl', x: box.x, y: box.y + box.h },
  ];
  return points.find(
    (p) => x >= p.x - half && x <= p.x + half && y >= p.y - half && y <= p.y + half
  );
}

function clampBox(box) {
  const minSize = 40;
  const maxW = canvas.width;
  const maxH = canvas.height;
  box.w = Math.max(minSize, Math.min(box.w, maxW));
  box.h = Math.max(minSize, Math.min(box.h, maxH));
  box.x = Math.max(0, Math.min(box.x, maxW - box.w));
  box.y = Math.max(0, Math.min(box.y, maxH - box.h));
}

function createDefaultBox() {
  const margin = 0.1;
  const box = {
    x: canvas.width * margin,
    y: canvas.height * margin,
    w: canvas.width * (1 - margin * 2),
    h: canvas.height * (1 - margin * 2),
  };
  clampBox(box);
  return box;
}

function renderLoop() {
  rafId = requestAnimationFrame(renderLoop);
  syncCanvasSize();
  if (!paused && guideCanvas.style.display !== 'none') {
    guideCanvas.style.display = 'none';
  }
  if (paused) {
    const mode = getMode();
    if (mode === 'bw') {
      canvas.style.filter = 'grayscale(1) invert(1)';
    } else {
      canvas.style.filter = 'invert(1)';
    }
    if (pausedFrameCanvas) {
      ctx.drawImage(pausedFrameCanvas, 0, 0, canvas.width, canvas.height);
    }
    drawGuide(lastBoxes);
    return;
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  // For performance, use CSS filters for live preview. Do per-pixel processing only when saving.
  const mode = getMode();
  if (mode === 'bw') {
    canvas.style.filter = 'grayscale(1) invert(1)';
  } else {
    canvas.style.filter = 'invert(1)';
  }

  drawGuide(null);

  frameCount += 1;
}

startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);
pauseBtn.addEventListener('click', async () => {
  if (!stream) return;
  paused = !paused;
  pauseBtn.textContent = paused ? '继续' : '暂停';
  saveBtn.disabled = !paused;
  reDetectBtn.disabled = !paused;
  if (paused) {
    // Immediately freeze the current preview to avoid a white flash while capturing.
    const quickFreeze = document.createElement('canvas');
    quickFreeze.width = canvas.width;
    quickFreeze.height = canvas.height;
    quickFreeze.getContext('2d').drawImage(canvas, 0, 0);
    pausedFrameCanvas = quickFreeze;
    pausedFrameMeta = { canvas: quickFreeze, width: canvas.width, height: canvas.height };
    canvas.style.opacity = '0.2';
    guideCanvas.style.opacity = '0.2';
    await applyTrackConstraints(captureConstraints);
    pausedFrameMeta = await capturePausedFrame();
    pausedFrameCanvas = pausedFrameMeta.canvas;
    runDetectionOnPaused();
    requestAnimationFrame(() => {
      canvas.style.opacity = '1';
      guideCanvas.style.opacity = '1';
    });
  } else {
    pausedFrameCanvas = null;
    pausedFrameMeta = null;
    lastBoxes = [];
    lockedBox = null;
    selectedIndex = -1;
    await applyTrackConstraints(previewConstraints);
    canvas.style.opacity = '1';
    guideCanvas.style.opacity = '1';
  }
});

saveBtn.addEventListener('click', async () => {
  if (!paused) return;
  if (selectedIndex < 0 || !lastBoxes[selectedIndex]) return;
  lockedBox = { ...lastBoxes[selectedIndex] };
  const srcCanvas = document.createElement('canvas');
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const sourceCanvas = pausedFrameCanvas || canvas;
  const sourceW = pausedFrameMeta?.width || sourceCanvas.width;
  const sourceH = pausedFrameMeta?.height || sourceCanvas.height;
  srcCanvas.width = sourceW;
  srcCanvas.height = sourceH;
  srcCtx.drawImage(sourceCanvas, 0, 0, sourceW, sourceH);
  const frame = srcCtx.getImageData(0, 0, sourceW, sourceH);
  const data = frame.data;
  const mode = getMode();
  if (mode === 'bw') {
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      const inv = 255 - gray;
      data[i] = inv;
      data[i + 1] = inv;
      data[i + 2] = inv;
    }
  } else {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255 - data[i];
      data[i + 1] = 255 - data[i + 1];
      data[i + 2] = 255 - data[i + 2];
    }
  }
  srcCtx.putImageData(frame, 0, 0);
  const crop = document.createElement('canvas');
  const scaleX = srcCanvas.width / canvas.width;
  const scaleY = srcCanvas.height / canvas.height;
  const sx = Math.max(0, lockedBox.x * scaleX);
  const sy = Math.max(0, lockedBox.y * scaleY);
  const sw = Math.max(1, lockedBox.w * scaleX);
  const sh = Math.max(1, lockedBox.h * scaleY);
  crop.width = Math.round(sw);
  crop.height = Math.round(sh);
  const cropCtx = crop.getContext('2d');
  cropCtx.imageSmoothingEnabled = true;
  cropCtx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
  crop.toBlob((blob) => {
    if (!blob) return;
    const link = document.createElement('a');
    link.download = `frame-${Date.now()}.png`;
    link.href = URL.createObjectURL(blob);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }, 'image/png');
});

updateAggressivenessLabel();
detectAggressiveness?.addEventListener('input', updateAggressivenessLabel);

modeInputs.forEach((input) => {
  input.addEventListener('change', () => {
    if (stream) return;
  });
});

frameCountSelect?.addEventListener('change', () => {
  if (!paused) return;
  runDetectionOnPaused();
});

reDetectBtn?.addEventListener('click', () => {
  if (!paused) return;
  runDetectionOnPaused();
});

guideCanvas.addEventListener('pointerdown', (event) => {
  if (!paused) return;
  const rect = guideCanvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;

  if (!lastBoxes || lastBoxes.length === 0) {
    const fallback = createDefaultBox();
    lastBoxes = [fallback];
    selectedIndex = 0;
    lockedBox = { ...fallback };
  }
  let hitIndex = -1;
  for (let i = 0; i < lastBoxes.length; i += 1) {
    const box = lastBoxes[i];
    if (
      x >= box.x &&
      x <= box.x + box.w &&
      y >= box.y &&
      y <= box.y + box.h
    ) {
      hitIndex = i;
      break;
    }
  }
  if (hitIndex < 0) return;
  selectedIndex = hitIndex;
  lockedBox = { ...lastBoxes[selectedIndex] };

  const handle = getHandleAt(x, y, lockedBox);
  if (handle) {
    dragState = { type: handle.id, startX: x, startY: y, box: { ...lockedBox } };
  } else {
    dragState = { type: 'move', startX: x, startY: y, box: { ...lockedBox } };
  }

  guideCanvas.setPointerCapture(event.pointerId);
});

guideCanvas.addEventListener('pointermove', (event) => {
  if (!dragState || !lockedBox) return;
  const rect = guideCanvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
  const dx = x - dragState.startX;
  const dy = y - dragState.startY;
  const box = { ...dragState.box };

  if (dragState.type === 'move') {
    box.x += dx;
    box.y += dy;
  } else if (dragState.type === 'tl') {
    box.x += dx;
    box.y += dy;
    box.w -= dx;
    box.h -= dy;
  } else if (dragState.type === 'tr') {
    box.y += dy;
    box.w += dx;
    box.h -= dy;
  } else if (dragState.type === 'br') {
    box.w += dx;
    box.h += dy;
  } else if (dragState.type === 'bl') {
    box.x += dx;
    box.w -= dx;
    box.h += dy;
  }

  clampBox(box);
  lockedBox = box;
  if (selectedIndex >= 0) {
    lastBoxes[selectedIndex] = { ...lockedBox };
  }
});

guideCanvas.addEventListener('pointerup', (event) => {
  if (!dragState) return;
  dragState = null;
  guideCanvas.releasePointerCapture(event.pointerId);
});

guideCanvas.addEventListener('pointercancel', () => {
  dragState = null;
});

window.addEventListener('beforeunload', stopCamera);

function getDesiredFrameCount() {
  const value = Number(frameCountSelect?.value || 3);
  return Math.max(1, Math.min(8, value));
}

function runDetectionOnPaused() {
  if (!paused || !pausedFrameCanvas) return;
  const detected = detectFilmFrames(pausedFrameCanvas);
  const scaledBoxes = detected.map((box) => ({
    x: box.x / detectScale,
    y: box.y / detectScale,
    w: box.w / detectScale,
    h: box.h / detectScale,
  }));
  scaledBoxes.forEach(clampBox);
  if (scaledBoxes.length === 0) {
    const fallback = createDefaultBox();
    lastBoxes = [fallback];
    selectedIndex = 0;
    lockedBox = { ...fallback };
  } else {
    lastBoxes = scaledBoxes;
    selectedIndex = 0;
    lockedBox = { ...lastBoxes[selectedIndex] };
  }
  drawGuide(lastBoxes);
}

function ensureDetectBuffers() {
  if (!window.__cvReady) return null;
  if (
    detectBuffers &&
    detectBuffers.width === detectCanvas.width &&
    detectBuffers.height === detectCanvas.height
  ) {
    return detectBuffers;
  }
  releaseDetectBuffers();
  detectBuffers = {
    width: detectCanvas.width,
    height: detectCanvas.height,
    gray: new cv.Mat(),
    blur: new cv.Mat(),
    edges: new cv.Mat(),
    contours: new cv.MatVector(),
    hierarchy: new cv.Mat(),
    kernel: cv.Mat.ones(3, 3, cv.CV_8U),
  };
  return detectBuffers;
}

function releaseDetectBuffers() {
  if (!detectBuffers) return;
  detectBuffers.gray.delete();
  detectBuffers.blur.delete();
  detectBuffers.edges.delete();
  detectBuffers.contours.delete();
  detectBuffers.hierarchy.delete();
  detectBuffers.kernel.delete();
  detectBuffers = null;
}

async function capturePausedFrame() {
  const captureCanvas = document.createElement('canvas');
  const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });
  let sourceW = video.videoWidth || canvas.width;
  let sourceH = video.videoHeight || canvas.height;

  if (imageCapture && imageCapture.takePhoto) {
    try {
      let photoSettings = undefined;
      if (imageCapture.getPhotoCapabilities) {
        try {
          const caps = await imageCapture.getPhotoCapabilities();
          if (caps.imageWidth && caps.imageHeight) {
            photoSettings = {
              imageWidth: caps.imageWidth.max,
              imageHeight: caps.imageHeight.max,
            };
          }
        } catch (error) {
          // Ignore photo capability errors and fall back to default takePhoto.
        }
      }
      const blob = await imageCapture.takePhoto(photoSettings);
      const bitmap = await createImageBitmap(blob);
      sourceW = bitmap.width;
      sourceH = bitmap.height;
      captureCanvas.width = sourceW;
      captureCanvas.height = sourceH;
      captureCtx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return { canvas: captureCanvas, width: sourceW, height: sourceH };
    } catch (error) {
      // Fall through to grabFrame/preview capture
    }
  }

  if (imageCapture && imageCapture.grabFrame) {
    try {
      const bitmap = await imageCapture.grabFrame();
      sourceW = bitmap.width;
      sourceH = bitmap.height;
      captureCanvas.width = sourceW;
      captureCanvas.height = sourceH;
      captureCtx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return { canvas: captureCanvas, width: sourceW, height: sourceH };
    } catch (error) {
      // Fall through to preview capture
    }
  }

  sourceW = canvas.width;
  sourceH = canvas.height;
  captureCanvas.width = sourceW;
  captureCanvas.height = sourceH;
  captureCtx.drawImage(canvas, 0, 0, sourceW, sourceH);
  return { canvas: captureCanvas, width: sourceW, height: sourceH };
}

async function applyTrackConstraints(constraints) {
  if (!activeTrack || !constraints) return;
  try {
    await activeTrack.applyConstraints(constraints);
  } catch (error) {
    // Ignore if the device rejects these constraints.
  }
}
