const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const guideCanvas = document.getElementById('guide');
const guideCtx = guideCanvas.getContext('2d');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const pauseBtn = document.getElementById('pauseBtn');
const saveBtn = document.getElementById('saveBtn');
const modeInputs = document.querySelectorAll('input[name="mode"]');
const autoFrameToggle = document.getElementById('autoFrame');
const detectAggressiveness = document.getElementById('detectAggressiveness');
const detectAggressivenessValue = document.getElementById(
  'detectAggressivenessValue'
);

const video = document.createElement('video');
video.setAttribute('playsinline', '');
video.setAttribute('autoplay', '');

const detectCanvas = document.createElement('canvas');
const detectCtx = detectCanvas.getContext('2d', { willReadFrequently: true });

let stream = null;
let rafId = null;
let frameCount = 0;
let lastBoxes = [];
let lockedBox = null;
let dragState = null;
let manualLock = false;
let detectScale = 1;
let paused = false;
let imageCapture = null;
let trackCapabilities = null;
const MAX_CANVAS_WIDTH = 1280;

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
    const [track] = stream.getVideoTracks();
    if (track && window.ImageCapture) {
      try {
        imageCapture = new ImageCapture(track);
        if (track.getCapabilities) {
          trackCapabilities = track.getCapabilities();
          if (trackCapabilities.width && trackCapabilities.height) {
            const maxWidth = trackCapabilities.width.max || 0;
            const maxHeight = trackCapabilities.height.max || 0;
            // Avoid forcing the camera to its absolute max resolution — cap to a reasonable size
            const desiredW = Math.min(maxWidth || MAX_CANVAS_WIDTH, MAX_CANVAS_WIDTH);
            const desiredH = Math.min(maxHeight || Math.round((desiredW * 9) / 16), Math.round((desiredW * 9) / 16));
            try {
              await track.applyConstraints({
                width: { ideal: desiredW },
                height: { ideal: desiredH },
              });
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
    saveBtn.disabled = false;
    paused = false;
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
  paused = false;
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
  guideCanvas.style.pointerEvents = autoFrameToggle.checked || paused ? 'auto' : 'none';
  guideCtx.lineWidth = Math.max(2, guideCanvas.width / 320);
  guideCtx.shadowBlur = 8;
  boxes.forEach((box) => {
    const isLocked =
      lockedBox &&
      Math.abs(box.x - lockedBox.x) < 1 &&
      Math.abs(box.y - lockedBox.y) < 1;
    guideCtx.strokeStyle = isLocked
      ? 'rgba(77, 214, 193, 0.95)'
      : 'rgba(255, 138, 91, 0.9)';
    guideCtx.shadowColor = isLocked
      ? 'rgba(77, 214, 193, 0.35)'
      : 'rgba(255, 138, 91, 0.35)';
    guideCtx.strokeRect(box.x, box.y, box.w, box.h);

    if (isLocked) {
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
  return Math.max(20, guideCanvas.width / 26);
}

function getHandleHitbox() {
  return Math.max(34, guideCanvas.width / 16);
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

function detectFilmFrames() {
  if (!window.__cvReady) return [];
  const params = getDetectParams();
  detectCtx.drawImage(video, 0, 0, detectCanvas.width, detectCanvas.height);

  const src = cv.imread(detectCanvas);
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
  cv.Canny(blur, edges, params.cannyLow, params.cannyHigh);
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), params.dilateIters);
  cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  const boxes = [];
  const minArea =
    detectCanvas.width * detectCanvas.height * params.minAreaRatio;
  for (let i = 0; i < contours.size(); i += 1) {
    const cnt = contours.get(i);
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

  kernel.delete();
  src.delete();
  gray.delete();
  blur.delete();
  edges.delete();
  contours.delete();
  hierarchy.delete();

  boxes.sort((a, b) => b.area - a.area);
  return boxes.length > 0 ? [boxes[0]] : [];
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
  if (guideCanvas.style.display !== 'none' && !autoFrameToggle.checked) {
    guideCanvas.style.display = 'none';
  }
  if (paused) {
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

  if (autoFrameToggle.checked) {
    if (!dragState && frameCount % 6 === 0) {
      const detected = detectFilmFrames();
      if (detected.length > 0) {
        const scaled = {
          x: detected[0].x / detectScale,
          y: detected[0].y / detectScale,
          w: detected[0].w / detectScale,
          h: detected[0].h / detectScale,
        };
        clampBox(scaled);
        if (!manualLock) {
          lockedBox = { ...scaled };
          lastBoxes = [lockedBox];
        } else if (lockedBox) {
          lastBoxes = [lockedBox];
        }
      } else if (lastBoxes.length === 0) {
        lockedBox = createDefaultBox();
        lastBoxes = [lockedBox];
      }
    }
    drawGuide(lastBoxes);
  } else {
    drawGuide(null);
  }

  frameCount += 1;
}

startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);
pauseBtn.addEventListener('click', () => {
  if (!stream) return;
  paused = !paused;
  pauseBtn.textContent = paused ? '继续' : '暂停';
  if (paused && autoFrameToggle.checked) {
    lastBoxes = lockedBox ? [lockedBox] : lastBoxes;
    drawGuide(lastBoxes);
  }
});

saveBtn.addEventListener('click', async () => {
  if (!lockedBox) {
    lockedBox = createDefaultBox();
    lastBoxes = [lockedBox];
  }
  const srcCanvas = document.createElement('canvas');
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  let sourceW = video.videoWidth || canvas.width;
  let sourceH = video.videoHeight || canvas.height;
  let frameSource = video;

  if (imageCapture && imageCapture.takePhoto) {
    try {
      const blob = await imageCapture.takePhoto();
      const bitmap = await createImageBitmap(blob);
      sourceW = bitmap.width;
      sourceH = bitmap.height;
      srcCanvas.width = sourceW;
      srcCanvas.height = sourceH;
      srcCtx.drawImage(bitmap, 0, 0);
      bitmap.close();
      frameSource = null;
    } catch (error) {
      frameSource = video;
    }
  }

  if (frameSource && imageCapture && imageCapture.grabFrame) {
    try {
      const bitmap = await imageCapture.grabFrame();
      sourceW = bitmap.width;
      sourceH = bitmap.height;
      srcCanvas.width = sourceW;
      srcCanvas.height = sourceH;
      srcCtx.drawImage(bitmap, 0, 0);
      bitmap.close();
      frameSource = null;
    } catch (error) {
      frameSource = video;
    }
  }

  if (frameSource === video) {
    // Use the visible (possibly scaled) `canvas` contents for cropping to avoid
    // coordinate mismatches between the guide overlay and the saved image.
    srcCanvas.width = sourceW;
    srcCanvas.height = sourceH;
    // Draw the current visual canvas into the source canvas. We'll apply pixel
    // processing (invert/grayscale) here before cropping.
    srcCtx.drawImage(canvas, 0, 0, sourceW, sourceH);
  }
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

autoFrameToggle.addEventListener('change', () => {
  if (!autoFrameToggle.checked) {
    lastBoxes = [];
    lockedBox = null;
    manualLock = false;
    drawGuide(null);
  }
});

guideCanvas.addEventListener('pointerdown', (event) => {
  if (!autoFrameToggle.checked && !paused) return;
  const rect = guideCanvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;

  if (!lockedBox && lastBoxes.length > 0) {
    lockedBox = { ...lastBoxes[0] };
    manualLock = true;
  } else if (!lockedBox) {
    lockedBox = createDefaultBox();
    lastBoxes = [lockedBox];
  }

  if (!lockedBox) {
    return;
  }
  const handle = getHandleAt(x, y, lockedBox);
  if (handle) {
    dragState = { type: handle.id, startX: x, startY: y, box: { ...lockedBox } };
  } else if (
    x >= lockedBox.x &&
    x <= lockedBox.x + lockedBox.w &&
    y >= lockedBox.y &&
    y <= lockedBox.y + lockedBox.h
  ) {
    dragState = { type: 'move', startX: x, startY: y, box: { ...lockedBox } };
  } else {
    lockedBox = createDefaultBox();
    lastBoxes = [lockedBox];
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
  manualLock = true;
  lastBoxes = [lockedBox];
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
