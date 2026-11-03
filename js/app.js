// XC_INSTR — static, single-player build of the Xplosive Collision player.
//
// Same RNBO device (NOISE-GAME_v2, rnbo.js 1.4.2), same scene and the same
// accelerometer mapping as xplosive_collision's `src/clients/player.js`, but
// with no server: no soundworks, no shared state, no controller. It runs from
// any static host (GitHub Pages) and is meant to test the instrument on its own.
//
// What changed from the networked player:
//   - the other player is a GHOST: a fake opponent created at a random, hidden
//     position. The collision / proximity / periphery logic that XC's server
//     ran between two players runs here between you and the ghost, so the
//     ghost drives the device's modulation (proximity, periphery) and its
//     collisions (preset changes) exactly like a real opponent would.
//   - the controller's global switches become three small buttons at the
//     bottom of the page: show / hide the ghost, automate its movement, and
//     switch between the trial session (default, shows the sharpness) and the
//     game session (S-points race to 10).
//   - device motion is read from the browser directly (with the iOS permission
//     prompt on the enter button) instead of through @ircam/devicemotion.
//   - the enter screen replaces the soundworks platform-init screen.

import { html, render } from './vendor/lit-html.js';

// Where the RNBO export lives — drop a new export in this folder to update
const PATCH_EXPORT_URL = 'assets/rnbo_export/patch.export.json';

// Game settings — the defaults of XC's global state (src/global/global.js).
// Distances are in scene units: the scene is 0–100 on both axes.
const COLLISION_DISTANCE = 5;
const PROXIMITY_OFFSET = 10; // proximity radius = collision + offset
const PERIPHERY_OFFSET = 15; // periphery radius = proximity + offset
const PRESET_RANGE_MIN = 0; // presets drawn at random on each collision
const PRESET_RANGE_MAX = 6;
const INITIAL_PRESET = 1;
const WINNING_SCORE = 10;
// XC's controller can raise an "alarm": a collision then also sends the
// opponent's score to the device and turns the scene black & white. There is no
// controller here, so it stays off; set it to 1 to test that path.
const ALARM = 0;

// Ghost opponent
const GHOST_SPEED = 0.25; // scene units per animation frame when automated
const GHOST_MARGIN = 10; // keep the ghost (and its targets) this far from the edges
// In the game session the ghost earns S-points at a random rate, so that the
// race has an opponent: on average GHOST_SCORE_RATE points per second.
const GHOST_SCORE_RATE = 0.05;

// Accelerometer → scene mapping, as in XC
const MAX_G = 2.81;
const MOTION_SMOOTHING_WINDOW = 50;
const MOTION_FALLBACK_DELAY_MS = 1500;
const POINTER_DRAG_LERP = 0.35;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const clampCoord = v => clamp(Number(v) || 0, 0, 100);
const randomIn = (min, max) => min + Math.random() * (max - min);

// Load rnbo.js for the version the patch was exported with: the copy shipped
// in assets/rnbo/<version>/ first, then Cycling '74's CDN as a fallback.
function loadRNBOScript(version) {
  if (/^\d+\.\d+\.\d+-dev$/.test(version)) {
    return Promise.reject(new Error(`Patch exported with a debug RNBO version (${version}) — export a release build.`));
  }

  const v = encodeURIComponent(version);
  const sources = [
    `assets/rnbo/${v}/rnbo.min.js`,
    `https://c74-public.nyc3.digitaloceanspaces.com/rnbo/${v}/rnbo.min.js`,
  ];

  const tryLoad = i => new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = sources[i];
    if (i > 0) {
      el.crossOrigin = 'anonymous';
    }
    el.onload = resolve;
    el.onerror = () => {
      el.remove();
      if (i + 1 < sources.length) {
        console.warn(`[rnbo] ${sources[i]} not found, trying ${sources[i + 1]}`);
        tryLoad(i + 1).then(resolve, reject);
      } else {
        reject(new Error(`Failed to load rnbo.js v${version}`));
      }
    };
    document.body.append(el);
  });

  return tryLoad(0);
}

// iOS only delivers devicemotion after an explicit permission, which has to be
// requested from inside a user gesture.
function requestMotionPermission() {
  const DME = window.DeviceMotionEvent;
  if (DME && typeof DME.requestPermission === 'function') {
    return DME.requestPermission().catch(() => 'denied');
  }
  return Promise.resolve('granted');
}

// Log-weighted moving average over the last N samples (XC's motion smoothing)
const MOTION_LOG_WEIGHTS = Array.from(
  { length: MOTION_SMOOTHING_WINDOW },
  (_, i) => Math.log(i + 2),
);

function smoothMotionValue(history, next) {
  history.push(next);
  if (history.length > MOTION_SMOOTHING_WINDOW) {
    history.shift();
  }
  const offset = MOTION_SMOOTHING_WINDOW - history.length;
  let sum = 0;
  let weights = 0;
  for (let i = 0; i < history.length; i += 1) {
    const w = MOTION_LOG_WEIGHTS[offset + i];
    sum += history[i] * w;
    weights += w;
  }
  return weights > 0 ? sum / weights : next;
}

// Tilt → dot position on the scene (0–100, y down)
function mapAccelToSceneCoords(accX, accY) {
  const nx = clamp((Number.isFinite(accX) ? accX : 0) / MAX_G, -1, 1);
  const ny = clamp((Number.isFinite(accY) ? accY : 0) / MAX_G, -1, 1);
  return {
    x: Math.round(((nx + 1) * 0.5) * 100),
    y: Math.round((1 - ((ny + 1) * 0.5)) * 100),
  };
}

// Tilt → values sent to the `accelerometer` inport (-10 – 10)
function mapAccelToDeviceCoords(accX, accY) {
  const nx = clamp((Number.isFinite(accX) ? accX : 0) / MAX_G, -1, 1);
  const ny = clamp((Number.isFinite(accY) ? accY : 0) / MAX_G, -1, 1);
  return { x: Math.round(nx * 10), y: Math.round(ny * 10) };
}

// Dragged dot position → `accelerometer` values, for devices without sensors
function mapPointerCoordsToAccelerometer(coords) {
  const xNorm = clampCoord(coords.x) / 100;
  const yNorm = clampCoord(coords.y) / 100;
  return { x: (xNorm * 20) - 10, y: ((1 - yNorm) * 20) - 10, z: 0 };
}

// A random spot for the ghost, outside the periphery of the player's dot, so
// that the session doesn't start with a collision.
function randomGhostPosition(avoid) {
  const minDistance = COLLISION_DISTANCE + PROXIMITY_OFFSET + PERIPHERY_OFFSET;
  let pos = null;
  for (let i = 0; i < 50; i += 1) {
    pos = {
      x: randomIn(GHOST_MARGIN, 100 - GHOST_MARGIN),
      y: randomIn(GHOST_MARGIN, 100 - GHOST_MARGIN),
    };
    if (Math.hypot(pos.x - avoid.x, pos.y - avoid.y) >= minDistance) {
      break;
    }
  }
  return pos;
}

async function main($container, audioContext) {
  // ── RNBO device ────────────────────────────────────────────────────────────

  const response = await fetch(PATCH_EXPORT_URL);
  if (!response.ok) {
    throw new Error(`Could not fetch ${PATCH_EXPORT_URL} (${response.status})`);
  }
  const patcher = await response.json();

  if (!window.RNBO) {
    await loadRNBOScript(patcher.desc.meta.rnboversion);
  }

  const device = await RNBO.createDevice({ context: audioContext, patcher });
  console.log(`[rnbo] ${patcher.desc.meta.name} — rnbo.js ${patcher.desc.meta.rnboversion}`);

  //   [device.node] ──► [outputNode] ──► [analyser] ──► [destination]
  const outputNode = audioContext.createGain();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.68;
  device.node.connect(outputNode);
  outputNode.connect(analyser);
  analyser.connect(audioContext.destination);

  const inports = new Set(
    device.messages
      .filter(m => m.type === RNBO.MessagePortType.Inport)
      .map(m => m.tag),
  );

  function sendMessageToInport(tag, values) {
    if (!inports.has(tag)) {
      return;
    }
    device.scheduleEvent(new RNBO.MessageEvent(RNBO.TimeNow, tag, values));
  }

  const presets = Array.isArray(patcher.presets) ? patcher.presets : [];

  function loadPresetAtIndex(index) {
    const preset = presets[Math.floor(Number(index))];
    if (!preset) {
      console.warn('Ignoring invalid preset index:', index);
      return;
    }
    device.setPreset(preset.preset);
  }

  function randomPresetIndex() {
    if (presets.length === 0) {
      return 0;
    }
    const last = presets.length - 1;
    let min = clamp(PRESET_RANGE_MIN, 0, last);
    let max = clamp(PRESET_RANGE_MAX, 0, last);
    if (max < min) {
      [min, max] = [max, min];
    }
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  // ── Session state ──────────────────────────────────────────────────────────
  // What XC kept in the shared `user` / `control` states and in `global`.

  const session = {
    mode: 'trial', // 'trial' (shows the sharpness) | 'game' (S-points race)
    running: true, // false once a game is over
    myScore: 0,
    ghostScore: 0,
    sharpness: 0,
    endState: 0, // 1 win, -1 lose
    collide: false,
    proximity: false,
    periphery: false,
    state: 0, // the device `state` inport (1 while alarmed collision)
  };

  const me = { x: 50, y: 50 };
  const ghost = { ...randomGhostPosition(me), visible: false, auto: false };
  let ghostTarget = randomGhostPosition(ghost);

  // ── Interface ──────────────────────────────────────────────────────────────

  function renderApp() {
    const isTrial = session.mode === 'trial';
    render(html`
      <div id="app-root" class="cloud-app ${isTrial ? 'is-training-mode' : ''}">
        <div id="gameover-overlay" role="status" aria-live="polite"
             style="display: ${session.mode === 'game' && !session.running ? 'flex' : 'none'}"
             @click=${startGame}>
          <div id="gameover-text">${endgameText()}</div>
          <div class="gameover-hint">tap to play again</div>
        </div>
        <div class="player-points-hud">
          <span class="player-points-label">My S-Points:</span>
          <span id="points-counter-value"></span>
        </div>
        <div class="player-points-hud player-points-hud-other">
          <span class="player-points-label">Other S-Points:</span>
          <span id="other-points-counter-value"></span>
        </div>
        <div class="player-points-hud player-points-hud-sharpness">
          <span class="player-points-label">Sharpness:</span>
          <span id="sharpness-counter-value"></span>
        </div>
        <img id="alarm-warning" class="alarm-warning ${ALARM > 0 ? 'is-visible' : ''}"
             src="assets/images/warning.png" alt="Alarm warning">
        <div class="cloud-layer cloud-layer-a"></div>
        <div class="cloud-layer cloud-layer-b"></div>
        <div class="cloud-layer cloud-layer-c"></div>
        <div class="noise-reactive-layer" aria-hidden="true"></div>
        <div id="motion-scene">
          <div id="ghost-dot" aria-hidden="true"></div>
          <div id="motion-dot" aria-hidden="true"></div>
        </div>
        <nav class="scene-controls" aria-label="test controls">
          <button type="button" class="scene-btn ${ghost.visible ? 'active' : ''}"
                  aria-pressed=${ghost.visible} title="show / hide the ghost opponent"
                  @click=${toggleGhostVisible}>ghost</button>
          <button type="button" class="scene-btn ${ghost.auto ? 'active' : ''}"
                  aria-pressed=${ghost.auto} title="automate the ghost's movement"
                  @click=${toggleGhostAuto}>auto</button>
          <button type="button" class="scene-btn ${isTrial ? '' : 'active'}"
                  title="switch between trial and game session"
                  @click=${toggleMode}>${isTrial ? 'trial' : 'game'}</button>
        </nav>
      </div>
    `, $container);
    // HUD values are written directly (they change at audio rate), not bound
    updateText('#points-counter-value', session.myScore);
    updateText('#other-points-counter-value', session.ghostScore);
    updateText('#sharpness-counter-value', session.sharpness);
  }

  renderApp();

  const $root = $container.querySelector('#app-root');
  const $scene = $container.querySelector('#motion-scene');
  const $dot = $container.querySelector('#motion-dot');
  const $ghost = $container.querySelector('#ghost-dot');

  function endgameText() {
    if (session.endState > 0) {
      return 'YOU WIN';
    }
    if (session.endState < 0) {
      return 'you lose';
    }
    return 'game over';
  }

  function updateDots() {
    $dot.style.left = `${me.x}%`;
    $dot.style.top = `${me.y}%`;
    $dot.classList.toggle('is-collision-active', session.collide);
    $ghost.style.left = `${ghost.x}%`;
    $ghost.style.top = `${ghost.y}%`;
    $ghost.classList.toggle('is-visible', ghost.visible);
    $ghost.classList.toggle('is-collision-active', session.collide);
    $ghost.classList.toggle('is-proximate', session.proximity);
  }

  function updateText(selector, value) {
    const el = $container.querySelector(selector);
    if (el) {
      el.textContent = Number(value).toFixed(2);
    }
  }

  // ── Reactive black & white background (while `state` is 1) ───────────────

  const noiseData = new Uint8Array(analyser.frequencyBinCount);
  let backgroundRAF = null;
  let noisePhase = 0;
  let noiseLevel = 0;
  const NOISE_PROPS = ['--noise-opacity', '--noise-scale', '--noise-contrast',
    '--noise-brightness', '--noise-pos-x', '--noise-pos-y'];

  function renderReactiveBackgroundFrame() {
    analyser.getByteFrequencyData(noiseData);
    let sum = 0;
    for (let i = 0; i < noiseData.length; i += 2) {
      sum += noiseData[i];
    }
    const bins = Math.max(1, Math.ceil(noiseData.length / 2));
    noiseLevel = (noiseLevel * 0.82) + ((sum / (bins * 255)) * 0.18);
    const intensity = clamp(noiseLevel * 1.6, 0, 1);
    noisePhase += 0.7 + (intensity * 9);

    $root.style.setProperty('--noise-opacity', (0.2 + intensity * 0.55).toFixed(3));
    $root.style.setProperty('--noise-scale', `${20 + intensity * 38}px`);
    $root.style.setProperty('--noise-contrast', `${105 + intensity * 85}%`);
    $root.style.setProperty('--noise-brightness', `${84 + intensity * 30}%`);
    $root.style.setProperty('--noise-pos-x', `${((noisePhase * 0.83) % 180).toFixed(1)}px`);
    $root.style.setProperty('--noise-pos-y', `${((noisePhase * 1.31) % 220).toFixed(1)}px`);
    backgroundRAF = requestAnimationFrame(renderReactiveBackgroundFrame);
  }

  function setReactiveBackground(enabled) {
    $root.classList.toggle('is-reactive-bw', enabled);
    if (enabled && backgroundRAF === null) {
      renderReactiveBackgroundFrame();
    } else if (!enabled) {
      if (backgroundRAF !== null) {
        cancelAnimationFrame(backgroundRAF);
        backgroundRAF = null;
      }
      noisePhase = 0;
      noiseLevel = 0;
      NOISE_PROPS.forEach(p => $root.style.removeProperty(p));
    }
  }

  function setDeviceState(value) {
    if (session.state === value) {
      return;
    }
    session.state = value;
    sendMessageToInport('state', [value]);
    setReactiveBackground(value > 0);
  }

  // ── Collisions (XC's server-side evaluateCollisions, for the pair me/ghost) ─

  function triggerCollision() {
    loadPresetAtIndex(randomPresetIndex());
    if (ALARM > 0) {
      sendMessageToInport('score', [session.ghostScore]);
      setDeviceState(1);
    }
  }

  function evaluateCollisions() {
    const proximityDistance = COLLISION_DISTANCE + PROXIMITY_OFFSET;
    const peripheryDistance = proximityDistance + PERIPHERY_OFFSET;
    const dx = me.x - ghost.x;
    const dy = me.y - ghost.y;
    const d2 = dx * dx + dy * dy;

    const collide = d2 < COLLISION_DISTANCE * COLLISION_DISTANCE;
    const proximity = d2 < proximityDistance * proximityDistance;
    const periphery = d2 < peripheryDistance * peripheryDistance;

    if (proximity !== session.proximity) {
      session.proximity = proximity;
      if (session.running) {
        sendMessageToInport('proximity', [proximity ? 1 : 0]);
      }
    }
    if (periphery !== session.periphery) {
      session.periphery = periphery;
      if (session.running) {
        sendMessageToInport('periphery', [periphery ? 1 : 0]);
      }
    }
    if (collide !== session.collide) {
      session.collide = collide;
      if (collide) {
        triggerCollision();
      } else {
        setDeviceState(0);
      }
    }
    updateDots();
  }

  // ── Ghost ──────────────────────────────────────────────────────────────────

  let ghostRAF = null;

  function stepGhost() {
    const dx = ghostTarget.x - ghost.x;
    const dy = ghostTarget.y - ghost.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 2) {
      ghostTarget = randomGhostPosition(ghost);
    } else {
      const step = Math.min(dist, GHOST_SPEED);
      ghost.x = clamp(ghost.x + (dx / dist) * step, GHOST_MARGIN, 100 - GHOST_MARGIN);
      ghost.y = clamp(ghost.y + (dy / dist) * step, GHOST_MARGIN, 100 - GHOST_MARGIN);
    }
    evaluateCollisions();
    ghostRAF = requestAnimationFrame(stepGhost);
  }

  function toggleGhostVisible() {
    ghost.visible = !ghost.visible;
    updateDots();
    renderApp();
  }

  function toggleGhostAuto() {
    ghost.auto = !ghost.auto;
    if (ghost.auto && ghostRAF === null) {
      ghostTarget = randomGhostPosition(ghost);
      ghostRAF = requestAnimationFrame(stepGhost);
    } else if (!ghost.auto && ghostRAF !== null) {
      cancelAnimationFrame(ghostRAF);
      ghostRAF = null;
    }
    renderApp();
  }

  // ── Trial / game session ───────────────────────────────────────────────────

  let ghostScoreTimer = null;

  function stopGhostScore() {
    if (ghostScoreTimer !== null) {
      clearInterval(ghostScoreTimer);
      ghostScoreTimer = null;
    }
  }

  function setRunning(running) {
    session.running = running;
    sendMessageToInport('start', [running ? 1 : 0]);
    if (running) {
      // resend the modulation flags, which are only sent while running
      sendMessageToInport('proximity', [session.proximity ? 1 : 0]);
      sendMessageToInport('periphery', [session.periphery ? 1 : 0]);
    }
  }

  function endGame(endState) {
    if (!session.running) {
      return;
    }
    stopGhostScore();
    session.endState = endState;
    setRunning(false);
    renderApp();
  }

  function startGame() {
    session.mode = 'game';
    session.myScore = 0;
    session.ghostScore = 0;
    session.endState = 0;
    sendMessageToInport('score', [0]);
    // restart the patch so its S-points start from zero
    sendMessageToInport('start', [0]);
    setRunning(true);

    stopGhostScore();
    ghostScoreTimer = setInterval(() => {
      session.ghostScore = Math.min(WINNING_SCORE,
        session.ghostScore + Math.random() * GHOST_SCORE_RATE * 2 * 0.25);
      updateText('#other-points-counter-value', session.ghostScore);
      if (session.ghostScore >= WINNING_SCORE) {
        endGame(-1);
      }
    }, 250);
    renderApp();
  }

  function startTrial() {
    stopGhostScore();
    session.mode = 'trial';
    session.endState = 0;
    session.sharpness = 0;
    if (!session.running) {
      setRunning(true);
    }
    renderApp();
  }

  function toggleMode() {
    if (session.mode === 'trial') {
      startGame();
    } else {
      startTrial();
    }
  }

  // ── Device outports ────────────────────────────────────────────────────────

  device.messageEvent.subscribe(ev => {
    const value = Number(Array.isArray(ev.payload) ? ev.payload[0] : ev.payload);
    if (!Number.isFinite(value)) {
      return;
    }
    if (ev.tag === 'out2') { // sharpness
      session.sharpness = value;
      if (session.mode === 'trial') {
        updateText('#sharpness-counter-value', value);
      }
    } else if (ev.tag === 'out3') { // S-points
      if (session.mode !== 'game' || !session.running) {
        return;
      }
      session.myScore = value;
      updateText('#points-counter-value', value);
      if (value >= WINNING_SCORE) {
        endGame(1);
      }
    }
  });

  // ── Motion ─────────────────────────────────────────────────────────────────

  const motionXHistory = [];
  const motionYHistory = [];
  const motionZHistory = [];
  let motionEventReceived = false;
  let pointerDragEnabled = false;

  function setPointerDrag(enabled) {
    pointerDragEnabled = enabled;
    $scene.classList.toggle('is-pointer-drag-enabled', enabled);
  }

  function moveMe(coords) {
    me.x = clampCoord(coords.x);
    me.y = clampCoord(coords.y);
    evaluateCollisions();
  }

  if (typeof window.DeviceMotionEvent !== 'undefined') {
    window.addEventListener('devicemotion', e => {
      const acc = e.accelerationIncludingGravity || {};
      // Desktop browsers may fire empty events — ignore those
      if (typeof acc.x !== 'number' && typeof acc.y !== 'number' && typeof acc.z !== 'number') {
        return;
      }
      if (!motionEventReceived) {
        motionEventReceived = true;
        setPointerDrag(false);
      }
      const x = smoothMotionValue(motionXHistory, typeof acc.x === 'number' ? acc.x : 0);
      const y = smoothMotionValue(motionYHistory, typeof acc.y === 'number' ? acc.y : 0);
      const z = smoothMotionValue(motionZHistory, typeof acc.z === 'number' ? acc.z : 0);
      const deviceCoords = mapAccelToDeviceCoords(x, y);
      sendMessageToInport('accelerometer', [deviceCoords.x, deviceCoords.y, z]);
      moveMe(mapAccelToSceneCoords(x, y));
    });
  }

  // No sensor (desktop) or no permission: drag the dot instead
  setTimeout(() => {
    if (!motionEventReceived) {
      setPointerDrag(true);
    }
  }, MOTION_FALLBACK_DELAY_MS);

  let dragPointerId = null;

  function applyPointer(e) {
    const rect = $scene.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    const target = {
      x: clampCoord(((e.clientX - rect.left) / rect.width) * 100),
      y: clampCoord(((e.clientY - rect.top) / rect.height) * 100),
    };
    const coords = {
      x: me.x + ((target.x - me.x) * POINTER_DRAG_LERP),
      y: me.y + ((target.y - me.y) * POINTER_DRAG_LERP),
    };
    const accel = mapPointerCoordsToAccelerometer(coords);
    sendMessageToInport('accelerometer', [accel.x, accel.y, accel.z]);
    moveMe(coords);
  }

  $scene.addEventListener('pointerdown', e => {
    if (!pointerDragEnabled || (typeof e.button === 'number' && e.button !== 0)) {
      return;
    }
    dragPointerId = e.pointerId;
    applyPointer(e);
    try {
      $scene.setPointerCapture(e.pointerId);
    } catch {
      // no-op
    }
  });
  $scene.addEventListener('pointermove', e => {
    if (pointerDragEnabled && dragPointerId === e.pointerId) {
      applyPointer(e);
    }
  });
  const stopDrag = e => {
    if (dragPointerId === e.pointerId) {
      dragPointerId = null;
    }
  };
  $scene.addEventListener('pointerup', stopDrag);
  $scene.addEventListener('pointercancel', stopDrag);
  $scene.addEventListener('pointerleave', stopDrag);

  // ── Start ──────────────────────────────────────────────────────────────────

  loadPresetAtIndex(INITIAL_PRESET);
  sendMessageToInport('state', [0]);
  sendMessageToInport('score', [0]);
  sendMessageToInport('alarm', [ALARM]);
  sendMessageToInport('accelerometer', [0, 0, 0]);
  setRunning(true);
  evaluateCollisions();

  // Expose the session for testing from the console
  window.xc = { session, me, ghost, device };
}

// ── Enter screen ─────────────────────────────────────────────────────────────
// Audio (and, on iOS, motion sensors) can only start from a user gesture.

function renderEnter($container, { busy = false, error = null } = {}) {
  render(html`
    <div id="enter-overlay">
      <div id="enter-content">
        <div id="enter-title">XPLOSIVE COLLISION</div>
        <div id="enter-text">tilt your phone to move the dot.
somewhere in the space hides a ghost opponent:
get close to it to bend the noise, collide to make it explode.

turn the volume up gently — this gets loud.</div>
        ${error ? html`<div class="enter-error">${error}</div>` : null}
        <button id="enter-button" type="button" ?disabled=${busy} @click=${() => start($container)}>
          ${busy ? 'loading…' : '>>>'}
        </button>
      </div>
    </div>
  `, $container);
}

let starting = false;

async function start($container) {
  if (starting) {
    return;
  }
  starting = true;

  // Both of these must be called synchronously inside the click
  const motionPermission = requestMotionPermission();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioCtx();
  const resumed = audioContext.resume();

  renderEnter($container, { busy: true });

  try {
    await Promise.all([motionPermission, resumed]);
    await main($container, audioContext);
  } catch (err) {
    console.error(err);
    audioContext.close().catch(() => {});
    starting = false;
    renderEnter($container, { error: `Could not start the device: ${err.message || err}` });
  }
}

const $app = document.getElementById('app');
renderEnter($app);
