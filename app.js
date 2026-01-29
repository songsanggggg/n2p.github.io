const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const guideCanvas = document.getElementById('guide');
const guideCtx = guideCanvas.getContext('2d');
const statusEl = document.getElementById('status');
const previewFrame = document.getElementById('previewFrame');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const modeInputs = document.querySelectorAll('input[name="mode"]');
const autoFrameToggle = document.getElementById('autoFrame');

const video = document.createElement('video');
video.setAttribute('playsinline', '');
video.setAttribute('autoplay', '');

let stream = null;
let rafId = null;
let frameCount = 0;
let lastBox = null;
let cvReady = Boolean(window.__cvReady);
const detectCanvas = document.createElement('canvas');
const detectCtx = detectCanvas.getContext('2d', { willReadFrequently: true });

function getMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function updateStatus(message, visible = true) {
  const shouldShow = visible && message.trim().length > 0;
  statusEl.textContent = message;
  statusEl.classList.toggle('hidden', !shouldShow);
}

async function startCamera() {
  if (stream) return;
  updateStatus('正在请求摄像头权限...');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
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
    syncCanvasSize();
    updateStatus('', false);
    previewFrame.classList.add('is-live');
    stopBtn.disabled = false;
    startBtn.disabled = true;
    renderLoop();
  } catch (error) {
    console.error(error);
    updateStatus('无法访问摄像头，请检查权限设置。');
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
  updateStatus('', false);
  previewFrame.classList.remove('is-live');
}

function syncCanvasSize() {
  const width = video.videoWidth || 1280;
  const height = video.videoHeight || 720;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    guideCanvas.width = width;
    guideCanvas.height = height;
  }
}

function detectFilmBox() {
  const targetWidth = Math.min(360, canvas.width);
  const scale = canvas.width / targetWidth;
  const targetHeight = Math.round(canvas.height / scale);
  detectCanvas.width = targetWidth;
  detectCanvas.height = targetHeight;
  detectCtx.drawImage(video, 0, 0, targetWidth, targetHeight);

  const image = detectCtx.getImageData(0, 0, targetWidth, targetHeight);
  const data = image.data;
  const gray = new Float32Array(targetWidth * targetHeight);

  for (let i = 0, j = 0; i < data.length; i += 4, j += 1) {
    gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  const w = targetWidth;
  const h = targetHeight;
  let sumMag = 0;
  const mag = new Float32Array(w * h);

  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const idx = y * w + x;
      const gx =
        -gray[idx - w - 1] - 2 * gray[idx - 1] - gray[idx + w - 1] +
        gray[idx - w + 1] + 2 * gray[idx + 1] + gray[idx + w + 1];
      const gy =
        -gray[idx - w - 1] - 2 * gray[idx - w] - gray[idx - w + 1] +
        gray[idx + w - 1] + 2 * gray[idx + w] + gray[idx + w + 1];
      const m = Math.abs(gx) + Math.abs(gy);
      mag[idx] = m;
      sumMag += m;
    }
  }

  const avgMag = sumMag / (w * h);
  const threshold = avgMag * 2.6;
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  let count = 0;

  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const idx = y * w + x;
      if (mag[idx] > threshold) {
        count += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  const minCount = w * h * 0.01;
  if (count < minCount) return null;

  const boxW = maxX - minX;
  const boxH = maxY - minY;
  const area = boxW * boxH;
  const areaRatio = area / (w * h);
  if (areaRatio < 0.1 || areaRatio > 0.9) return null;

  const ratio = boxW / boxH;
  if (ratio < 1.2 || ratio > 1.9) return null;

  return {
    x: minX * scale,
    y: minY * scale,
    w: boxW * scale,
    h: boxH * scale,
  };
}

function detectFilmBoxCv() {
  if (!window.cv || !cv.Mat) return null;
  const targetWidth = Math.min(420, canvas.width);
  const scale = canvas.width / targetWidth;
  const targetHeight = Math.round(canvas.height / scale);
  detectCanvas.width = targetWidth;
  detectCanvas.height = targetHeight;
  detectCtx.drawImage(video, 0, 0, targetWidth, targetHeight);

  const src = cv.imread(detectCanvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 60, 150);
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let bestRect = null;
    let bestArea = 0;

    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      const rect = cv.boundingRect(contour);
      const area = rect.width * rect.height;
      if (area < targetWidth * targetHeight * 0.12) continue;
      const ratio = rect.width / rect.height;
      if (ratio < 1.2 || ratio > 1.9) continue;
      if (area > bestArea) {
        bestArea = area;
        bestRect = rect;
      }
      contour.delete();
    }

    if (!bestRect) return null;
    return {
      x: bestRect.x * scale,
      y: bestRect.y * scale,
      w: bestRect.width * scale,
      h: bestRect.height * scale,
    };
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();
  }
}

function drawGuide(box) {
  guideCtx.clearRect(0, 0, guideCanvas.width, guideCanvas.height);
  if (!box) return;
  guideCtx.lineWidth = Math.max(2, guideCanvas.width / 320);
  guideCtx.strokeStyle = 'rgba(255, 138, 91, 0.9)';
  guideCtx.shadowColor = 'rgba(255, 138, 91, 0.35)';
  guideCtx.shadowBlur = 12;
  guideCtx.strokeRect(box.x, box.y, box.w, box.h);
  guideCtx.shadowBlur = 0;
}

function renderLoop() {
  rafId = requestAnimationFrame(renderLoop);
  syncCanvasSize();
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
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

  ctx.putImageData(frame, 0, 0);

  frameCount += 1;
  if (autoFrameToggle.checked && frameCount % 4 === 0) {
    if (!cvReady && window.__cvReady) cvReady = true;
    const box = cvReady ? detectFilmBoxCv() : detectFilmBox();
    if (box) lastBox = box;
  }
  drawGuide(autoFrameToggle.checked ? lastBox : null);
}

startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);

modeInputs.forEach((input) => {
  input.addEventListener('change', () => {
    if (stream) {
      updateStatus('', false);
    }
  });
});

window.addEventListener('beforeunload', stopCamera);
