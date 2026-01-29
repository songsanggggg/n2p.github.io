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
let dragState = null;

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

function drawGuide(boxes) {
  guideCtx.clearRect(0, 0, guideCanvas.width, guideCanvas.height);
  if (!boxes || boxes.length === 0) {
    guideCanvas.style.display = 'none';
    return;
  }
  guideCanvas.style.display = 'block';
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
      const handle = Math.max(10, guideCanvas.width / 40);
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

function getHandleAt(x, y, box) {
  const handle = Math.max(12, guideCanvas.width / 36);
  const half = handle / 2;
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

  if (autoFrameToggle.checked) {
    lastBoxes = lockedBox ? [lockedBox] : [];
    drawGuide(lastBoxes);
  } else {
    drawGuide(null);
  }
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
    drawGuide(null);
  }
});

guideCanvas.addEventListener('pointerdown', (event) => {
  if (!autoFrameToggle.checked) return;
  const rect = guideCanvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;

  if (!lockedBox) {
    lockedBox = createDefaultBox();
    lastBoxes = [lockedBox];
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
