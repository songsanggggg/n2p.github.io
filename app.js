const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const rawCanvas = document.getElementById('raw');
const rawCtx = rawCanvas.getContext('2d');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const modeInputs = document.querySelectorAll('input[name="mode"]');

const video = document.createElement('video');
video.setAttribute('playsinline', '');
video.setAttribute('autoplay', '');

let stream = null;
let rafId = null;

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
}

function syncCanvasSize() {
  const width = video.videoWidth || 1280;
  const height = video.videoHeight || 720;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    rawCanvas.width = width;
    rawCanvas.height = height;
  }
}

function renderLoop() {
  rafId = requestAnimationFrame(renderLoop);
  syncCanvasSize();
  rawCtx.drawImage(video, 0, 0, rawCanvas.width, rawCanvas.height);
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
