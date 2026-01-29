const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const guideCanvas = document.getElementById('guide');
const guideCtx = guideCanvas.getContext('2d');
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
let lastBoxes = [];
let lockedBox = null;
let lockedCorners = null;
let prevGray = null;
let cvReady = Boolean(window.__cvReady);
const detectCanvas = document.createElement('canvas');
const detectCtx = detectCanvas.getContext('2d', { willReadFrequently: true });

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
    stopBtn.disabled = false;
    startBtn.disabled = true;
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
  syncCanvasSize();
  drawStatus('摄像头已停止');
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

function getDetectConfig() {
  const targetWidth = Math.min(480, canvas.width);
  const scale = canvas.width / targetWidth;
  const targetHeight = Math.round(canvas.height / scale);
  return { targetWidth, targetHeight, scale };
}

function detectFilmBox() {
  const { targetWidth, targetHeight, scale } = getDetectConfig();
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

  return [
    {
    x: minX * scale,
    y: minY * scale,
    w: boxW * scale,
    h: boxH * scale,
    },
  ];
}

function detectFilmBoxesCv() {
  if (!window.cv || !cv.Mat) return null;
  const { targetWidth, targetHeight, scale } = getDetectConfig();
  detectCanvas.width = targetWidth;
  detectCanvas.height = targetHeight;
  detectCtx.drawImage(video, 0, 0, targetWidth, targetHeight);

  const src = cv.imread(detectCanvas);
  const gray = new cv.Mat();
  const invGray = new cv.Mat();
  const blurred = new cv.Mat();
  const darkMask = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.bitwise_not(gray, invGray);
    cv.GaussianBlur(invGray, blurred, new cv.Size(5, 5), 0);
    cv.threshold(blurred, darkMask, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    cv.morphologyEx(darkMask, darkMask, cv.MORPH_CLOSE, kernel);
    cv.findContours(darkMask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const boxes = [];

    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      const rect = cv.boundingRect(contour);
      const area = rect.width * rect.height;
      if (area < targetWidth * targetHeight * 0.04) continue;
      if (area > targetWidth * targetHeight * 0.9) continue;
      const ratio = rect.width / rect.height;
      if (ratio < 1.2 || ratio > 1.9) continue;

      // Border darkness check: edge darker than center
      const edgeRect = new cv.Rect(
        Math.max(rect.x, 0),
        Math.max(rect.y, 0),
        Math.max(rect.width, 1),
        Math.max(rect.height, 1)
      );
      const roi = invGray.roi(edgeRect);
      const innerRect = new cv.Rect(
        Math.floor(rect.width * 0.18),
        Math.floor(rect.height * 0.18),
        Math.max(Math.floor(rect.width * 0.64), 1),
        Math.max(Math.floor(rect.height * 0.64), 1)
      );
      const inner = roi.roi(innerRect);
      const edgeMean = cv.mean(roi)[0];
      const innerMean = cv.mean(inner)[0];
      roi.delete();
      inner.delete();

      if (edgeMean > innerMean - 10) continue;

      const score = area * (innerMean - edgeMean);
      boxes.push({
        x: rect.x * scale,
        y: rect.y * scale,
        w: rect.width * scale,
        h: rect.height * scale,
        score,
      });
      contour.delete();
    }

    if (!boxes.length) return null;
    boxes.sort((a, b) => b.score - a.score);
    return boxes.slice(0, 4);
  } finally {
    src.delete();
    gray.delete();
    invGray.delete();
    blurred.delete();
    darkMask.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
  }
}

function drawGuide(boxes) {
  guideCtx.clearRect(0, 0, guideCanvas.width, guideCanvas.height);
  if (!boxes || boxes.length === 0) {
    guideCanvas.style.display = 'none';
    return;
  }
  guideCanvas.style.display = 'block';
  guideCtx.lineWidth = Math.max(2, guideCanvas.width / 320);
  guideCtx.shadowBlur = 10;
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
  });
  guideCtx.shadowBlur = 0;
}

function trackLockedBox() {
  if (!cvReady || !lockedCorners || !prevGray) return null;
  const { targetWidth, targetHeight, scale } = getDetectConfig();
  detectCanvas.width = targetWidth;
  detectCanvas.height = targetHeight;
  detectCtx.drawImage(video, 0, 0, targetWidth, targetHeight);

  const src = cv.imread(detectCanvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const prevPts = cv.matFromArray(4, 1, cv.CV_32FC2, lockedCorners);
  const nextPts = new cv.Mat();
  const status = new cv.Mat();
  const err = new cv.Mat();

  try {
    cv.calcOpticalFlowPyrLK(prevGray, gray, prevPts, nextPts, status, err);
    const statusData = status.data;
    const nextData = nextPts.data32F;
    const good = [];
    for (let i = 0; i < 4; i += 1) {
      if (statusData[i] === 1) {
        good.push(nextData[i * 2], nextData[i * 2 + 1]);
      }
    }

    if (good.length >= 6) {
      let minX = targetWidth;
      let minY = targetHeight;
      let maxX = 0;
      let maxY = 0;
      for (let i = 0; i < good.length; i += 2) {
        const x = good[i];
        const y = good[i + 1];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      lockedCorners = [
        minX,
        minY,
        maxX,
        minY,
        maxX,
        maxY,
        minX,
        maxY,
      ];
      lockedBox = {
        x: minX * scale,
        y: minY * scale,
        w: (maxX - minX) * scale,
        h: (maxY - minY) * scale,
      };
      prevGray.delete();
      prevGray = gray.clone();
      return lockedBox;
    }
  } finally {
    src.delete();
    gray.delete();
    prevPts.delete();
    nextPts.delete();
    status.delete();
    err.delete();
  }
  return null;
}

function updatePrevGray() {
  if (!cvReady) return;
  const { targetWidth, targetHeight } = getDetectConfig();
  detectCanvas.width = targetWidth;
  detectCanvas.height = targetHeight;
  detectCtx.drawImage(video, 0, 0, targetWidth, targetHeight);
  const src = cv.imread(detectCanvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  if (prevGray) prevGray.delete();
  prevGray = gray.clone();
  src.delete();
  gray.delete();
}

function setLockedBox(box) {
  if (!box) return;
  const { scale } = getDetectConfig();
  const minX = box.x / scale;
  const minY = box.y / scale;
  const maxX = (box.x + box.w) / scale;
  const maxY = (box.y + box.h) / scale;
  lockedCorners = [minX, minY, maxX, minY, maxX, maxY, minX, maxY];
  lockedBox = { ...box };
  updatePrevGray();
}

function renderLoop() {
  rafId = requestAnimationFrame(renderLoop);
  syncCanvasSize();
  if (guideCanvas.style.display !== 'none' && !autoFrameToggle.checked) {
    guideCanvas.style.display = 'none';
  }
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
    if (lockedBox && cvReady) {
      const tracked = trackLockedBox();
      if (tracked) {
        lastBoxes = [tracked];
      } else {
        lockedBox = null;
        lockedCorners = null;
      }
    }
    if (!lockedBox) {
      const boxes = cvReady ? detectFilmBoxesCv() : detectFilmBox();
      if (boxes) lastBoxes = boxes;
    }
  }
  drawGuide(autoFrameToggle.checked ? lastBoxes : null);
}

startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);

modeInputs.forEach((input) => {
  input.addEventListener('change', () => {
    if (stream) return;
  });
});

autoFrameToggle.addEventListener('change', () => {
  if (!autoFrameToggle.checked) {
    lastBoxes = [];
    lockedBox = null;
    lockedCorners = null;
    if (prevGray) {
      prevGray.delete();
      prevGray = null;
    }
    drawGuide(null);
  }
});

canvas.addEventListener('pointerdown', (event) => {
  if (!autoFrameToggle.checked || !lastBoxes.length) return;
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
  const hit = lastBoxes.find(
    (box) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h
  );
  if (!hit) return;
  if (lockedBox && hit === lockedBox) {
    lockedBox = null;
    lockedCorners = null;
    if (prevGray) {
      prevGray.delete();
      prevGray = null;
    }
    return;
  }
  setLockedBox(hit);
  lastBoxes = [hit];
});

window.addEventListener('beforeunload', stopCamera);
