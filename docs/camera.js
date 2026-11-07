/* Camera monitoring for the exam page.
 * Runs entirely in the student's browser: nothing is recorded or uploaded.
 * Uses Google MediaPipe to detect faces and (optionally) mobile phones.
 *
 * Status values reported to the page:
 *   OFF             camera not started
 *   LOADING         camera on, detector still loading
 *   OK              exactly one face, nothing blocking
 *   NO_FACE         no face visible
 *   CAMERA_BLOCKED  image is dark or blank (lens covered)
 *   MULTIPLE_FACES  more than one face
 *   PHONE_DETECTED  a mobile phone is visible
 *   CAMERA_OFF      the camera stopped (unplugged, permission revoked)
 */
window.ExamCamera = (function () {
  'use strict';

  const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1';
  const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
  const PHONE_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite';
  const CHECK_MS = 500;        // face check interval
  const PHONE_CHECK_MS = 1500; // phone check interval (heavier model)

  let stream = null;
  let video = null;
  let faceDetector = null;
  let phoneDetector = null;
  let timer = null;
  let onStatus = () => {};
  let status = 'OFF';
  let since = 0;
  let phoneSeen = false;
  let lastPhoneCheck = 0;
  let lastTs = 0;
  const probe = document.createElement('canvas');
  probe.width = 32; probe.height = 24;
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });

  function friendlyError(err) {
    const n = err && err.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      return 'Camera permission was blocked. Click the camera icon in the address bar, choose "Allow", then click "Turn on camera" again.';
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No camera was found. This exam requires a webcam.';
    if (n === 'NotReadableError' || n === 'AbortError') return 'The camera is being used by another app (for example Zoom or Teams). Close that app and try again.';
    return 'Face detection could not be loaded. Check your internet connection and reload the page.';
  }

  async function openStream() {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
    stream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => setStatus('CAMERA_OFF')));
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
  }

  /** Starts the camera and loads the detectors. Throws an Error with a friendly message. */
  async function start(videoEl, options) {
    video = videoEl;
    onStatus = options.onStatus || onStatus;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw Object.assign(new Error('no media'), { name: 'NotFoundError' });
      }
      if (!stream || !stream.active) await openStream();
      setStatus('LOADING');
      if (!faceDetector) {
        const vision = await import(MP_BASE + '/vision_bundle.mjs');
        const files = await vision.FilesetResolver.forVisionTasks(MP_BASE + '/wasm');
        faceDetector = await vision.FaceDetector.createFromOptions(files, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'CPU' },
          runningMode: 'VIDEO',
          minDetectionConfidence: 0.6,
        });
        if (options.phoneDetection) {
          phoneDetector = await vision.ObjectDetector.createFromOptions(files, {
            baseOptions: { modelAssetPath: PHONE_MODEL, delegate: 'CPU' },
            runningMode: 'VIDEO',
            scoreThreshold: 0.45,
            categoryAllowlist: ['cell phone'],
            maxResults: 1,
          });
        }
      }
    } catch (err) {
      const e = new Error(friendlyError(err));
      e.cause = err;
      setStatus('OFF');
      throw e;
    }
    clearInterval(timer);
    timer = setInterval(check, CHECK_MS);
    check();
  }

  /** Turns the camera back on after it stopped (no new permission prompt if already allowed). */
  async function restart() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    await openStream();
    since = Date.now();
    check();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    setStatus('OFF');
  }

  /** Shows the same camera picture in another <video> (e.g. inside the warning box). */
  function mirrorTo(otherVideo) {
    if (!stream) return;
    otherVideo.srcObject = stream;
    otherVideo.muted = true;
    otherVideo.playsInline = true;
    otherVideo.play().catch(() => {});
  }

  /** Keeps the main preview playing after it was moved in the page. */
  function resume() {
    if (video && video.paused) video.play().catch(() => {});
  }

  function isBlocked() {
    probeCtx.drawImage(video, 0, 0, probe.width, probe.height);
    const d = probeCtx.getImageData(0, 0, probe.width, probe.height).data;
    let sum = 0, sumSq = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      sum += y; sumSq += y * y;
    }
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    return mean < 18 || sd < 5; // very dark, or one flat colour (finger, tape, cover)
  }

  function check() {
    if (!stream || !stream.active || stream.getVideoTracks().every((t) => t.readyState === 'ended')) {
      if (status !== 'OFF') setStatus('CAMERA_OFF');
      return;
    }
    if (!faceDetector || !video || video.readyState < 2) return;
    let ts = Math.round(performance.now());
    if (ts <= lastTs) ts = lastTs + 1;
    lastTs = ts;
    try {
      let next;
      if (isBlocked()) {
        next = 'CAMERA_BLOCKED';
      } else {
        const faces = faceDetector.detectForVideo(video, ts).detections.length;
        if (phoneDetector && ts - lastPhoneCheck >= PHONE_CHECK_MS) {
          lastPhoneCheck = ts;
          phoneSeen = phoneDetector.detectForVideo(video, ts).detections.length > 0;
        }
        next = faces === 0 ? 'NO_FACE' : faces > 1 ? 'MULTIPLE_FACES' : phoneSeen ? 'PHONE_DETECTED' : 'OK';
      }
      setStatus(next);
    } catch (e) {
      console.warn('face check failed', e);
    }
  }

  function setStatus(next) {
    if (next !== status) { status = next; since = Date.now(); }
    onStatus(status, Date.now() - since);
  }

  return {
    start, restart, stop, mirrorTo, resume,
    status: () => status,
    statusAge: () => Date.now() - since,
  };
})();
