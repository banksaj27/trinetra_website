(function (global) {
  "use strict";

  function createFallbackCanvas(width, height) {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
    if (typeof document !== "undefined") return document.createElement("canvas");
    return null;
  }

  function createCityRuntime(options) {
    options = options || {};
    const canvas = options.canvas;
    const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
    const overlayCanvas = options.overlayCanvas || createFallbackCanvas(1, 1);
    const particleCtx = overlayCanvas ? overlayCanvas.getContext("2d", { alpha: true, desynchronized: true }) : null;
    const gridCanvas = createFallbackCanvas(1, 1);
    const gridCtx = gridCanvas.getContext("2d", { alpha: true, desynchronized: true });
    let dpr = Math.min(options.dpr || 1, 2);
    let reducedMotion = !!options.reducedMotion;
    let targetFPS = 60;
    let lastFrameTime = 0;
    const requestAnimationFrame = typeof global.requestAnimationFrame === "function"
      ? global.requestAnimationFrame.bind(global)
      : function (callback) { return global.setTimeout(function () { callback(performance.now()); }, 1000 / 60); };
    const cancelAnimationFrame = typeof global.cancelAnimationFrame === "function"
      ? global.cancelAnimationFrame.bind(global)
      : global.clearTimeout.bind(global);

// Camera
const PITCH       = 0.46;   // ~26 degrees
const FOCAL       = 720;
const CAM_HEIGHT  = 520;    // high aerial view for skyline and city depth
    const DOLLY_SPEED = 66;
    const CAM_X_DRIFT = 0;
const NEAR_PLANE  = 40;
const FAR_PLANE   = 4000;

// Street grid world geometry
const ST_PITCH    = 300;    // street-center to street-center
const ST_GAP      = 52;     // total street gap between block edges
const ST_SETBACK  = 14;     // sidewalk inside each block
const BLK_INNER   = ST_PITCH - ST_GAP;   // 248 - usable block width
const BUILD_ZONE  = BLK_INNER - ST_SETBACK * 2;  // 220 - parcel area

// Arc leapfrog proximity zones
const ARC_NEAR_MIN = 100;
const ARC_NEAR_MAX = 320;
const ARC_FAR_MIN  = 480;
const ARC_FAR_MAX  = 820;
const TARGET_ARCS  = 6;
const TARGET_HOT   = 12;

    const GRID_HALF_W = 2100;
    const GRID_EXTENT = 6800;

let W = 0;
let H = 0;
let HORIZON_Y = 0;
    let cameraX = 0;
    let cameraZ = 0;
    let lastTime = performance.now();
    let smoothDelta = 1 / 60;
    let buildings = [];
    let arcs = [];
let particles = [];
let running = true;
let frameId = null;
    let frameCount = 0;
let gridCacheDirty = true;
let gridMajorPath = null;
let gridMinorPath = null;
let shadowBudget = 20;
let shadowBlurCount = 0;
let qualityLevel = 0;
let qualityRestoreStarted = 0;
let renderCap = Infinity;
let windowDensityScale = 1;
const fpsSamples = new Float32Array(60);
let fpsSampleIndex = 0;
let fpsSampleCount = 0;
let fpsAverage = 60;
const drawList = [];
const sourceList = [];
const targetList = [];
const _p0 = { x: 0, y: 0, depth: 0, visible: false };
const _p1 = { x: 0, y: 0, depth: 0, visible: false };
const _p2 = { x: 0, y: 0, depth: 0, visible: false };
const _p3 = { x: 0, y: 0, depth: 0, visible: false };
const _arcDepthSample = { x: 0, y: 0, depth: 0, visible: false };
const _arcDepthPoint = { x: 0, y: 0, z: 0 };

const sinP = Math.sin(PITCH);
const cosP = Math.cos(PITCH);

function rand(min, max) { return min + Math.random() * (max - min); }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function hash01(n) { return Math.abs(Math.sin(n) * 43758.5453123) % 1; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function depthSortDesc(a, b) { return b.depth - a.depth; }
function setShadowBlur(value) {
  if (value > 0) shadowBlurCount++;
  ctx.shadowBlur = value;
}
function blendToFogString(r, g, b, mix) {
  return `rgb(${Math.round(r + (7 - r) * mix)}, ${Math.round(g + (10 - g) * mix)}, ${Math.round(b + (16 - b) * mix)})`;
}
function updateNormalColorCache(b, fog) {
  if (b.colorFog === fog) return;
  const mix = fog * 0.85;
  b.colorFog = fog;
  b.normalFrontFill = blendToFogString(b.baseFrontR, b.baseFrontG, b.baseFrontB, mix);
  b.normalSideFill = blendToFogString(b.baseSideR, b.baseSideG, b.baseSideB, mix);
  b.normalTopFill = blendToFogString(b.baseTopR, b.baseTopG, b.baseTopB, mix);
  b.roofBoxFrontFill = blendToFogString(b.roofFrontR, b.roofFrontG, b.roofFrontB, mix);
  b.roofBoxLeftFill = blendToFogString(b.roofLeftR, b.roofLeftG, b.roofLeftB, mix);
  b.roofBoxRightFill = blendToFogString(b.roofRightR, b.roofRightG, b.roofRightB, mix);
  b.roofBoxTopFill = blendToFogString(b.roofTopR, b.roofTopG, b.roofTopB, mix);
}

function parseRgb(color) {
  if (color[0] === "#") {
    const n = parseInt(color.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const match = color.match(/rgba?\(([^)]+)\)/);
  if (!match) return { r: 0, g: 0, b: 0, a: 1 };
  const parts = match[1].split(",").map((part) => parseFloat(part.trim()));
  return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] };
}

function lerpColor(color, target, t) {
  const a = parseRgb(color);
  const b = parseRgb(target);
  const mix = clamp(t, 0, 1);
  const r = Math.round(a.r + (b.r - a.r) * mix);
  const g = Math.round(a.g + (b.g - a.g) * mix);
  const bl = Math.round(a.b + (b.b - a.b) * mix);
  return `rgba(${r}, ${g}, ${bl}, ${a.a})`;
}

function fogForBuilding(b) {
  if (b.fogFrame >= 0 && frameCount % 2 !== 0) return b.fog;
  const dist = b.z - cameraZ;
  b.fog = clamp((dist - 1800) / 4600, 0, 1);
  b.fogFrame = frameCount;
  return b.fog;
}

function visualHot(b) {
  if (!b.hot) return false;
  const dist = b.z - cameraZ;
  if (dist < 80 || dist > 1600) return false;
  if (!projectInto(b.x, b.h, b.z, _p0)) return false;
  const projected = (Math.max(b.w, b.d) * FOCAL) / Math.max(_p0.depth, 1);
  return projected <= W * 0.28;
}

function generateParticles() {
  particles = [];
  for (let i = 0; i < 120; i++) {
    particles.push({
      x: rand(0, W),
      y: rand(0, H * 0.5),
      r: rand(0.5, 1.5),
      a: rand(0.1, 0.4)
    });
  }
}

function drawParticles() {
  if (!particleCtx) return;
  particleCtx.clearRect(0, 0, W, H);
  particleCtx.save();
  particleCtx.fillStyle = "#aabbdd";
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    particleCtx.globalAlpha = p.a;
    particleCtx.beginPath();
    particleCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    particleCtx.fill();
  }
  particleCtx.globalAlpha = 1;
  particleCtx.restore();
}

// Typology system

function pickType(radDist, isCenter) {
      const r = Math.random();
      if (radDist < 360 && r < 0.46) return "tower";
      if (radDist < 360) {
        if (r < 0.92) return "midrise";
        if (r < 0.98) return "lowcomm";
        return "irregular";
      }
      if (radDist < 720) {
        if (r < 0.22) return "tower";
        if (r < 0.88) return "midrise";
        if (r < 0.97) return "lowcomm";
        return "irregular";
      }
      if (r < 0.08) return "tower";
      if (r < 0.78) return "midrise";
      if (r < 0.94) return "lowcomm";
      return "irregular";
    }

    function dimsForType(type) {
      switch (type) {
    case "tower":     return { w: rand(48, 78),  d: rand(48, 78),  h: rand(220, 380) };
    case "midrise":   return { w: rand(62, 108), d: rand(62, 108), h: rand(120, 220) };
    case "lowcomm":   return { w: rand(85, 145), d: rand(70, 125), h: rand(55, 90) };
        case "irregular": return { w: rand(82, 150), d: rand(95, 170), h: rand(45, 80) };
    default:          return { w: rand(80, 130), d: rand(80, 130), h: rand(30, 60) };
      }
    }

    function makeRoofBoxes(w, d, h) {
      const n = h > 80 ? randInt(3, 5) : h > 48 ? randInt(2, 4) : randInt(1, 3);
      const boxes = [];
      for (let i = 0; i < n; i++) {
        boxes.push({
          rx: rand(-w * 0.32, w * 0.32),
          rz: rand(-d * 0.32, d * 0.32),
          rw: rand(7, Math.min(24, w * 0.26)),
          rd: rand(7, Math.min(24, d * 0.26)),
      rh: rand(4, 13),
      screen: [
        { x: 0, y: 0, depth: 0, visible: false },
        { x: 0, y: 0, depth: 0, visible: false },
        { x: 0, y: 0, depth: 0, visible: false },
        { x: 0, y: 0, depth: 0, visible: false },
        { x: 0, y: 0, depth: 0, visible: false },
        { x: 0, y: 0, depth: 0, visible: false },
        { x: 0, y: 0, depth: 0, visible: false },
        { x: 0, y: 0, depth: 0, visible: false }
      ]
        });
      }
      return boxes;
    }

    function buildWindowCache(widthUnits, heightUnits, salt) {
      const windows = [];
      if (heightUnits <= 40) return windows;
      const cols = Math.max(2, Math.floor(widthUnits / 12));
      const rows = Math.max(3, Math.floor(heightUnits / 8));
      for (let row = 1; row < rows; row++) {
        const v = row / rows;
        for (let col = 1; col < cols; col++) {
          const rnd = hash01(salt + row * 37.17 + col * 91.31);
          if (rnd < 0.3) continue;
          windows.push({ u: col / cols, v, bright: rnd > 0.95 });
        }
      }
      return windows;
    }

    function setBuildingGeometry(b) {
  const hw = b.w / 2;
  const hd = b.d / 2;
  const x0 = b.x - hw;
  const x1 = b.x + hw;
  const z0 = b.z - hd;
  const z1 = b.z + hd;
  const h = b.h;
  if (!b.corners) b.corners = new Float32Array(24);
  b.corners.set([
    x0, 0, z0,
    x1, 0, z0,
    x1, 0, z1,
    x0, 0, z1,
    x0, h, z0,
    x1, h, z0,
    x1, h, z1,
    x0, h, z1
  ]);
  if (!b.screen) {
    b.screen = [];
    for (let i = 0; i < 8; i++) b.screen.push({ x: 0, y: 0, depth: 0, visible: false });
  }
  if (!b.cullProj) b.cullProj = { x: 0, y: 0, depth: 0, visible: false };
  if (!b.miscProj) b.miscProj = { x: 0, y: 0, depth: 0, visible: false };
      b.radius = Math.sqrt(b.w * b.w + b.h * b.h + b.d * b.d) / 2;
  const t = b.seedTone || 0;
  b.baseFrontR = 13 + t;
  b.baseFrontG = 17 + t;
  b.baseFrontB = 24 + Math.round(t * 1.4);
  b.baseSideR = 10 + t;
  b.baseSideG = 14 + t;
  b.baseSideB = 20 + t;
  b.baseTopR = 19 + t;
  b.baseTopG = 26 + t;
  b.baseTopB = 38 + t;
  b.roofFrontR = 22 + t;
  b.roofFrontG = 30 + t;
  b.roofFrontB = 42 + t;
  b.roofLeftR = 18 + t;
  b.roofLeftG = 24 + t;
  b.roofLeftB = 34 + t;
  b.roofRightR = 16 + t;
  b.roofRightG = 22 + t;
  b.roofRightB = 32 + t;
  b.roofTopR = 30 + t;
  b.roofTopG = 40 + t;
  b.roofTopB = 56 + t;
  b.colorFog = null;
      b.frontWindows = buildWindowCache(b.w, b.h, b.x * 0.13 + b.z * 0.07);
      b.sideWindows = buildWindowCache(b.d, b.h, b.x * 0.19 + b.z * 0.11 + 19);
  b.projFrame = -1;
  b.fogFrame = -1;
    }

    function createBuilding(data) {
      setBuildingGeometry(data);
      return data;
    }

    function footprintsOverlap(a, b, pad) {
      return Math.abs(a.x - b.x) < (a.w + b.w) / 2 + pad &&
             Math.abs(a.z - b.z) < (a.d + b.d) / 2 + pad;
    }

    function placementIsClear(candidate, placed, pad, ignore) {
      for (let i = 0; i < placed.length; i++) {
        const other = placed[i];
        if (other === ignore) continue;
        if (footprintsOverlap(candidate, other, pad)) return false;
      }
      return true;
    }

    function makeBuildingInCell(xi, zi, forcedType) {
      const cityCenter = { x: 0, z: cameraZ + 2200 };
      const blockCX = xi * ST_PITCH;
      const blockCZ = zi * ST_PITCH + BLK_INNER / 2;
      const dx = blockCX - cityCenter.x;
      const dz = blockCZ - cityCenter.z;
      const radDist = Math.sqrt(dx * dx + dz * dz);
  const isCenter = radDist < 380;
  const type = forcedType || pickType(radDist, isCenter);
      const dims = dimsForType(type);
      const hw = dims.w / 2;
      const hd = dims.d / 2;

      const xMin = blockCX - BLK_INNER / 2 + ST_SETBACK;
      const xMax = blockCX + BLK_INNER / 2 - ST_SETBACK;
      const zMin = zi * ST_PITCH + ST_GAP / 2 + ST_SETBACK;
      const zMax = (zi + 1) * ST_PITCH - ST_GAP / 2 - ST_SETBACK;
      const xlo = xMin + hw;
      const xhi = xMax - hw;
      const zlo = zMin + hd;
      const zhi = zMax - hd;
      if (xlo > xhi || zlo > zhi) return null;

      return createBuilding({
        x: rand(xlo, xhi) + rand(-5, 5),
        z: rand(zlo, zhi) + rand(-5, 5),
        w: dims.w,
        d: dims.d,
        h: dims.h,
        type,
        hot: false,
        hotPhase: rand(0, Math.PI * 2),
        hotEndsAt: 0,
        infectedAt: 0,
        nextArcAt: 0,
        flickerStart: 0,
        seedTone: Math.floor(rand(0, 8)),
        floorH: rand(9, 14),
        roofBoxes: makeRoofBoxes(dims.w, dims.d, dims.h),
        version: 0
      });
    }

// City generation

    function generateCity() {
      buildings = [];
      const cityCenter = { x: 0, z: 2200 };

      for (let xi = -7; xi <= 7; xi++) {
        for (let zi = 0; zi <= 32; zi++) {
          const blockCX = xi * ST_PITCH;
          const blockCZ = zi * ST_PITCH + BLK_INNER / 2;

          const dx = blockCX - cityCenter.x;
          const dz = blockCZ - cityCenter.z;
          const radDist = Math.sqrt(dx * dx + dz * dz);

      // Sparse outer edges and lateral extremes
          const xEdge = Math.max(0, (Math.abs(xi) - 3) / 4);
          const leftEdge = Math.max(0, (-xi - 2) / 5);
          const farOut = Math.max(0, (radDist - 1800) / 1400);
          if (Math.random() < xEdge * 0.38 + leftEdge * 0.32 + farOut * 0.08) continue;

          const isCenter = radDist < 380;

      // Building zone boundaries for this block
      const xMin = blockCX - BLK_INNER / 2 + ST_SETBACK;
      const xMax = blockCX + BLK_INNER / 2 - ST_SETBACK;
      const zMin = zi * ST_PITCH + ST_GAP / 2 + ST_SETBACK;
      const zMax = (zi + 1) * ST_PITCH - ST_GAP / 2 - ST_SETBACK;

          const targetCount = Math.max(1, Math.round((isCenter ? randInt(5, 7)
            : radDist < 720 ? randInt(4, 6)
            : randInt(2, 4)) * (1 - xEdge * 0.55) * (1 - leftEdge * 0.5)));
          const blockPlaced = [];

      let attempts = 0;
          while (blockPlaced.length < targetCount && attempts < targetCount * 28) {
            attempts++;
        let type = pickType(radDist, isCenter);
            if (blockPlaced.filter((item) => item.type === "tower").length > 2 && type === "tower") type = "midrise";
        const dims = dimsForType(type);
        const hw = dims.w / 2;
        const hd = dims.d / 2;

        const xlo = xMin + hw;
        const xhi = xMax - hw;
        const zlo = zMin + hd;
        const zhi = zMax - hd;
        if (xlo > xhi || zlo > zhi) continue;

        const candidate = createBuilding({
          x: rand(xlo, xhi) + rand(-6, 6),
          z: rand(zlo, zhi) + rand(-6, 6),
          w: dims.w,
          d: dims.d,
          h: dims.h,
          type,
          hot: false,
          hotPhase: rand(0, Math.PI * 2),
          hotEndsAt: 0,
          infectedAt: 0,
          nextArcAt: 0,
          flickerStart: 0,
          seedTone: Math.floor(rand(0, 8)),
          floorH: rand(9, 14),
          roofBoxes: makeRoofBoxes(dims.w, dims.d, dims.h),
          version: 0
        });

        if (!placementIsClear(candidate, blockPlaced, 8)) continue;
            blockPlaced.push(candidate);
            buildings.push(candidate);
          }
        }
      }

  // Seed hot buildings in the near-forward zone
      const now = performance.now();
      const leftSeed = buildings.filter((b) => b.x < cameraX && b.z > 180 && b.z < 900);
      const rightSeed = buildings.filter((b) => b.x >= cameraX && b.z > 180 && b.z < 900);
      for (let i = 0; i < TARGET_HOT / 2; i++) {
        if (!leftSeed.length || !rightSeed.length) break;
        activate(leftSeed.splice(Math.floor(Math.random() * leftSeed.length), 1)[0], now);
        activate(rightSeed.splice(Math.floor(Math.random() * rightSeed.length), 1)[0], now);
      }
    }

    function activate(b, now) {
      if (!b || b.hot) return;
      const dist = b.z - cameraZ;
      if (dist < 160 || dist > 1200) return;
      b.hot = true;
      b.hotPhase = Math.random() * Math.PI * 2;
      b.flickerStart = now;
      b.hotEndsAt = Infinity;
      b.infectedAt = now;
      b.nextArcAt = now + rand(900, 1800);
}

function activateRandom(now) {
  // Prefer buildings 100-450 units ahead (3:1 weight)
  const nearPool = buildings.filter(
    (b) => !b.hot && (b.z - cameraZ) > 100 && (b.z - cameraZ) < 450
  );
  const midPool = buildings.filter(
    (b) => !b.hot && (b.z - cameraZ) >= 450 && (b.z - cameraZ) < 800
  );
  let pool;
  if (nearPool.length > 0 && Math.random() < 0.75) pool = nearPool;
  else if (midPool.length > 0) pool = midPool;
  else pool = buildings.filter((b) => !b.hot && (b.z - cameraZ) > 100 && (b.z - cameraZ) < 1400);
  if (!pool.length) return;
  activate(pool[Math.floor(Math.random() * pool.length)], now);
}

// Leapfrog arc system

    function maybeSpawnArc(now) {
  let liveCount = 0;
  for (let i = 0; i < arcs.length; i++) liveCount++;
  if (liveCount >= TARGET_ARCS) return;

  sourceList.length = 0;
      for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i];
        const dz = b.z - cameraZ;
    if (b.hot &&
        visualHot(b) &&
        b.nextArcAt &&
        now >= b.nextArcAt &&
        dz >= 160 &&
        dz <= ARC_FAR_MAX) {
      sourceList.push(b);
    }
  }
  sourceList.sort((a, b) => (a.z - cameraZ) - (b.z - cameraZ));

  for (let i = 0; i < sourceList.length && liveCount < TARGET_ARCS; i++) {
    const src = sourceList[i];
    targetList.length = 0;
        for (let k = 0; k < buildings.length; k++) {
          const b = buildings[k];
          const forward = b.z - src.z;
          const lateral = Math.abs(b.x - src.x);
          const camDist = b.z - cameraZ;
      if (!b.hot &&
          b !== src &&
          forward >= 420 &&
          forward <= 1150 &&
          lateral >= 80 &&
          lateral <= Math.max(220, forward * 0.58) &&
          camDist > ARC_NEAR_MAX &&
          camDist < 1200) {
        targetList.push(b);
      }
    }
    if (!targetList.length) {
          src.nextArcAt = now + rand(900, 1600);
          continue;
        }
    targetList.sort((a, b) => {
      const aForward = a.z - src.z;
      const bForward = b.z - src.z;
      const aLateral = Math.abs(a.x - src.x) / aForward;
      const bLateral = Math.abs(b.x - src.x) / bForward;
      const aIdeal = Math.abs(aLateral - 0.36);
      const bIdeal = Math.abs(bLateral - 0.36);
      return (aIdeal - aForward / 2600) - (bIdeal - bForward / 2600);
    });

    const fanout = Math.min(targetList.length, Math.random() < 0.35 ? 2 : 1);
    for (let j = 0; j < fanout && liveCount < TARGET_ARCS; j++) {
      const dst = targetList[j];
      const ax = src.x, ay = src.h, az = src.z;
      const bx = dst.x, by = dst.h, bz = dst.z;
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      const dist = Math.hypot(ax - bx, az - bz);
      const my = Math.max(ay, by) + Math.min(dist * 0.95, 620);
          arcs.push({
            a: src,
            b: dst,
        ax,
        ay,
        az,
        mx,
        my,
        mz,
        bx,
        by,
        bz,
            startedAt: now,
            pulseDuration: rand(1500, 2500),
            lifetime: rand(4200, 7000),
            arrivedAt: 0,
            bloomAt: 0,
        bloomDone: false,
            delivered: false,
        dotRadius: rand(5, 7),
        aP: { x: 0, y: 0, depth: 0, visible: false },
        bP: { x: 0, y: 0, depth: 0, visible: false },
        pP: { x: 0, y: 0, depth: 0, visible: false },
        lastPulseX: -9999,
        lastPulseY: -9999,
        lastEndpointX: -9999,
        lastEndpointY: -9999
      });
      liveCount++;
    }

        src.nextArcAt = now + rand(2600, 5200);
      }
    }

// Projection

function projectInto(wx, wy, wz, out) {
  const dx = wx - cameraX;
  const dy = wy - CAM_HEIGHT;
  const dz = wz - cameraZ;
  const ry = dy * cosP + dz * sinP;
  let rz = -dy * sinP + dz * cosP;
  if (rz < NEAR_PLANE + 5) {
    out.visible = false;
    return false;
  }
  out.x = W / 2 + (dx * FOCAL) / rz;
  out.y = HORIZON_Y - (ry * FOCAL) / rz + Math.tan(PITCH) * FOCAL;
  out.depth = rz;
  out.visible = true;
  return true;
}

function cameraDepth(wx, wy, wz) {
  return -(wy - CAM_HEIGHT) * sinP + (wz - cameraZ) * cosP;
}

function buildingInView(b) {
  if (!projectInto(b.x, b.h * 0.5, b.z, b.cullProj)) return false;
  if (b.cullProj.depth < NEAR_PLANE || b.cullProj.depth > FAR_PLANE) return false;
  const r = (b.radius * FOCAL) / Math.max(b.cullProj.depth, 1);
  return b.cullProj.x >= -r &&
         b.cullProj.x <= W + r &&
         b.cullProj.y >= -r &&
         b.cullProj.y <= H + r;
}

function projectBuilding(b, hot) {
  const dist = b.z - cameraZ;
  if (!hot && dist > 500 && b.projFrame >= 0 && frameCount % 2 !== 0) return true;
  const c = b.corners;
  for (let i = 0; i < 8; i++) {
    const j = i * 3;
    if (!projectInto(c[j], c[j + 1], c[j + 2], b.screen[i])) return false;
  }
  b.projFrame = frameCount;
  return true;
}

function faceVisible(nx, ny, nz, cx, cy, cz) {
  return nx * (cameraX - cx) + ny * (CAM_HEIGHT - cy) + nz * (cameraZ - cz) > 0;
}

function arcPointInto(arc, t, out) {
  const omt = 1 - t;
  out.x = omt * omt * arc.ax + 2 * omt * t * arc.mx + t * t * arc.bx;
  out.y = omt * omt * arc.ay + 2 * omt * t * arc.my + t * t * arc.by;
  out.z = omt * omt * arc.az + 2 * omt * t * arc.mz + t * t * arc.bz;
}

function drawArcTrailSegment(arc, t0, t1, alpha) {
  const span = t1 - t0;
  arcPointInto(arc, t0, _p0);
  arcPointInto(arc, t1, _p2);

  const dx0 = (1 - t0) * (arc.mx - arc.ax) + t0 * (arc.bx - arc.mx);
  const dy0 = (1 - t0) * (arc.my - arc.ay) + t0 * (arc.by - arc.my);
  const dz0 = (1 - t0) * (arc.mz - arc.az) + t0 * (arc.bz - arc.mz);
  _p1.x = _p0.x + span * dx0;
  _p1.y = _p0.y + span * dy0;
  _p1.z = _p0.z + span * dz0;

  if (!projectInto(_p0.x, _p0.y, _p0.z, _p0) || !projectInto(_p1.x, _p1.y, _p1.z, _p1) || !projectInto(_p2.x, _p2.y, _p2.z, _p2)) {
    return;
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.strokeStyle = "rgba(204, 0, 0, 0.06)";
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(_p0.x, _p0.y);
  ctx.quadraticCurveTo(_p1.x, _p1.y, _p2.x, _p2.y);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255, 34, 34, 0.35)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(_p0.x, _p0.y);
  ctx.quadraticCurveTo(_p1.x, _p1.y, _p2.x, _p2.y);
  ctx.stroke();

  ctx.shadowColor = "rgba(255, 51, 51, 0.65)";
  setShadowBlur(shadowBudget-- > 0 ? 8 : 0);
  ctx.strokeStyle = "rgba(255, 238, 238, 0.95)";
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(_p0.x, _p0.y);
  ctx.quadraticCurveTo(_p1.x, _p1.y, _p2.x, _p2.y);
  ctx.stroke();
  ctx.restore();
}

// Street grid

function drawStreetGrid() {
  const shouldRebuildGrid = gridCacheDirty || frameCount % 3 === 0 || !gridMajorPath || !gridMinorPath;
  if (shouldRebuildGrid) {
    gridMajorPath = new Path2D();
    gridMinorPath = new Path2D();

    // Z-axis streets (run across viewport)
    const zStart = Math.floor(cameraZ / ST_PITCH) * ST_PITCH - ST_PITCH;
    for (let z = zStart; z < cameraZ + GRID_EXTENT; z += ST_PITCH) {
      for (let oi = 0; oi < 2; oi++) {
        const off = oi === 0 ? -ST_GAP / 2 : ST_GAP / 2;
        if (projectInto(-GRID_HALF_W, 0, z + off, _p0) && projectInto(GRID_HALF_W, 0, z + off, _p1)) {
          gridMajorPath.moveTo(_p0.x, _p0.y);
          gridMajorPath.lineTo(_p1.x, _p1.y);
        }
      }
    }

    // X-axis streets (run forward into depth)
    for (let xi = -7; xi <= 8; xi++) {
      const x = xi * ST_PITCH;
      for (let oi = 0; oi < 2; oi++) {
        const xp = x + (oi === 0 ? -ST_GAP / 2 : ST_GAP / 2);
        if (projectInto(xp, 0, cameraZ, _p0) && projectInto(xp, 0, cameraZ + GRID_EXTENT, _p1)) {
          gridMajorPath.moveTo(_p0.x, _p0.y);
          gridMajorPath.lineTo(_p1.x, _p1.y);
        }
      }
    }

    const minorStartZ = Math.floor(cameraZ / 60) * 60 - 60;
    for (let z = minorStartZ; z < cameraZ + GRID_EXTENT; z += 60) {
      if (projectInto(-GRID_HALF_W, 0, z, _p0) && projectInto(GRID_HALF_W, 0, z, _p1)) {
        gridMinorPath.moveTo(_p0.x, _p0.y);
        gridMinorPath.lineTo(_p1.x, _p1.y);
      }
    }
    for (let x = -GRID_HALF_W; x <= GRID_HALF_W; x += 60) {
      if (projectInto(x, 0, cameraZ, _p0) && projectInto(x, 0, cameraZ + GRID_EXTENT, _p1)) {
        gridMinorPath.moveTo(_p0.x, _p0.y);
        gridMinorPath.lineTo(_p1.x, _p1.y);
      }
    }
    gridCacheDirty = false;
  }

  if (shouldRebuildGrid || frameCount % 2 === 0) {
    gridCtx.clearRect(0, 0, W, H);
    gridCtx.save();
    gridCtx.strokeStyle = "rgba(26, 58, 90, 0.4)";
    gridCtx.shadowColor = "#1a4a8a";
    gridCtx.shadowBlur = shadowBudget-- > 0 ? 4 : 0;
    if (gridCtx.shadowBlur > 0) shadowBlurCount++;
    gridCtx.lineWidth = 0.5;
    gridCtx.stroke(gridMajorPath);

    gridCtx.shadowBlur = 0;
    gridCtx.strokeStyle = "rgba(26, 58, 90, 0.15)";
    gridCtx.lineWidth = 0.5;
    gridCtx.stroke(gridMinorPath);
    gridCtx.restore();
  }
  ctx.drawImage(gridCanvas, 0, 0, W, H);
}

// Building renderer

function drawPolygon(points) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
}

function faceDepth(points) {
  let total = 0;
  for (let i = 0; i < points.length; i++) total += points[i].depth;
  return total / points.length;
}

function pushFace(queue, points, fill, stroke, lineWidth, glowColor, glowBlur, details) {
  if (points.some((p) => !p)) return;
  queue.push({
    points,
    fill,
    stroke,
    lineWidth,
    glowColor,
    glowBlur,
    details: details || [],
    depth: faceDepth(points)
  });
}

function pushLine(details, a, b) {
  if (a && b) details.push([a, b]);
}

function drawFace(face) {
  ctx.save();
  if (face.glowColor) {
    ctx.shadowColor = face.glowColor;
    setShadowBlur(face.glowBlur);
  }
  ctx.fillStyle = face.fill;
  drawPolygon(face.points);
  ctx.fill();
  setShadowBlur(0);

  if (face.stroke) {
    ctx.strokeStyle = face.stroke;
    ctx.lineWidth = face.lineWidth;
    ctx.stroke();
  }

  if (face.details.length) {
    ctx.strokeStyle = "rgba(145, 178, 228, 0.16)";
    ctx.lineWidth = 0.5;
    for (let i = 0; i < face.details.length; i++) {
      const line = face.details[i];
      ctx.beginPath();
      ctx.moveTo(line[0].x, line[0].y);
      ctx.lineTo(line[1].x, line[1].y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawWindowDots(windows, leftBottom, rightBottom, rightTop, leftTop, hot, fog, dist) {
  if (!windows || !windows.length) return;
  const distanceOpacity = 1 - clamp((dist - 700) / 3600, 0, 0.84);
  const fogOpacity = (1 - fog * 0.85) * distanceOpacity;
  const step = windowDensityScale;
  const drawHot = hot;
  ctx.save();
  ctx.globalAlpha = fogOpacity;
  ctx.beginPath();
  for (let i = 0; i < windows.length; i += step) {
    const win = windows[i];
    if (win.bright) continue;
    const leftX = leftBottom.x + (leftTop.x - leftBottom.x) * win.v;
    const leftY = leftBottom.y + (leftTop.y - leftBottom.y) * win.v;
    const rightX = rightBottom.x + (rightTop.x - rightBottom.x) * win.v;
    const rightY = rightBottom.y + (rightTop.y - rightBottom.y) * win.v;
    const x = leftX + (rightX - leftX) * win.u;
    const y = leftY + (rightY - leftY) * win.u;
    ctx.moveTo(x + 1.15, y);
    ctx.arc(x, y, 1.15, 0, Math.PI * 2);
  }
  ctx.fillStyle = drawHot ? "rgba(255, 72, 48, 0.82)" : "rgba(220, 238, 255, 0.88)";
  ctx.fill();

  {
    ctx.beginPath();
    for (let i = 0; i < windows.length; i += step) {
      const win = windows[i];
      if (!win.bright) continue;
      const leftX = leftBottom.x + (leftTop.x - leftBottom.x) * win.v;
      const leftY = leftBottom.y + (leftTop.y - leftBottom.y) * win.v;
      const rightX = rightBottom.x + (rightTop.x - rightBottom.x) * win.v;
      const rightY = rightBottom.y + (rightTop.y - rightBottom.y) * win.v;
      const x = leftX + (rightX - leftX) * win.u;
      const y = leftY + (rightY - leftY) * win.u;
      ctx.moveTo(x + 1.6, y);
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
    }
    ctx.fillStyle = drawHot ? "rgba(255, 124, 96, 0.95)" : "rgb(248, 252, 255)";
    ctx.fill();
  }
  if (drawHot) {
    ctx.beginPath();
    for (let i = 0; i < windows.length; i += Math.max(step, 5)) {
      const win = windows[i];
      const leftX = leftBottom.x + (leftTop.x - leftBottom.x) * win.v;
      const leftY = leftBottom.y + (leftTop.y - leftBottom.y) * win.v;
      const rightX = rightBottom.x + (rightTop.x - rightBottom.x) * win.v;
      const rightY = rightBottom.y + (rightTop.y - rightBottom.y) * win.v;
      const x = leftX + (rightX - leftX) * win.u;
      const y = leftY + (rightY - leftY) * win.u;
      ctx.moveTo(x + 1.45, y);
      ctx.arc(x, y, 1.45, 0, Math.PI * 2);
    }
    ctx.fillStyle = "rgba(255, 178, 150, 0.82)";
    ctx.fill();
  }
  ctx.restore();
}

function drawRedGroundGlow(b) {
  if (!projectInto(b.x, 0, b.z, b.miscProj)) return;
  const nearFade = clamp((b.z - cameraZ - 55) / 105, 0, 1);
  if (nearFade <= 0) return;
  const radius = Math.max(42, Math.min(170, ((Math.max(b.w, b.d) * 1.35 * FOCAL) / Math.max(b.miscProj.depth, 1)) * 0.5));
  const gradient = ctx.createRadialGradient(b.miscProj.x, b.miscProj.y, 0, b.miscProj.x, b.miscProj.y, radius);
  gradient.addColorStop(0, "rgba(255, 34, 0, 0.34)");
  gradient.addColorStop(1, "rgba(255, 34, 0, 0)");
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = nearFade;
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(b.miscProj.x, b.miscProj.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawArcMarker(p, radius, alpha) {
  if (!p) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = "#ff0000";
  setShadowBlur(shadowBudget-- > 0 ? 15 : 0);
  ctx.fillStyle = "rgb(255, 68, 68)";
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBuilding(b, now) {
  const hw = b.w / 2, hd = b.d / 2;
  const x0 = b.x - hw, x1 = b.x + hw;
  const z0 = b.z - hd, z1 = b.z + hd;
  const y1 = b.h;
  const midY = y1 * 0.5;
  const s = b.screen;
  const fl = s[0], fr = s[1], br = s[2], bl = s[3];
  const tfl = s[4], tfr = s[5], tbr = s[6], tbl = s[7];

  const dist = b.z - cameraZ;
  const hot = b.drawHot;
  const fog = fogForBuilding(b);
  let alpha = 1;
  let frontFill, sideFill, topFill, edgeColor, topEdge;
  let glowColor = null, glowBlur = 0;

  if (hot) {
    const flickT = Math.min(1, (now - b.flickerStart) / 400);
    const pulse  = 0.85 + 0.15 * Math.sin((now / 900) * Math.PI + b.hotPhase);
    alpha = flickT * pulse;
    frontFill = `rgba(140, 18, 8, ${0.92 * alpha})`;
    sideFill  = `rgba(110, 14, 6, ${0.88 * alpha})`;
    topFill   = `rgba(255, 50, 25, ${alpha})`;
    edgeColor = `rgba(255, 100, 70, ${Math.max(0.5, 0.85 * alpha)})`;
    topEdge   = `rgba(255, 140, 100, ${Math.max(0.65, alpha)})`;
    glowColor = "rgba(255, 51, 0, 0.85)";
    glowBlur  = 52 + 8 * Math.sin(now / 700 + b.hotPhase);
    frontFill = lerpColor(frontFill, "#070a10", fog * 0.85);
    sideFill = lerpColor(sideFill, "#070a10", fog * 0.85);
    topFill = lerpColor(topFill, "#070a10", fog * 0.85);
  } else {
    updateNormalColorCache(b, fog);
    frontFill = b.normalFrontFill;
    sideFill  = b.normalSideFill;
    topFill   = b.normalTopFill;
    edgeColor = "rgba(80, 110, 150, 0.14)";
    topEdge   = "rgba(100, 140, 185, 0.22)";
  }

  ctx.save();
  if (glowColor) {
    ctx.shadowColor = glowColor;
    setShadowBlur(glowBlur);
  }

  // Back and left faces keep buildings reading as closed volumes.
  if (faceVisible(0, 0, 1, b.x, midY, z1)) {
    ctx.fillStyle = sideFill;
    ctx.beginPath();
    ctx.moveTo(br.x, br.y); ctx.lineTo(bl.x, bl.y);
    ctx.lineTo(tbl.x, tbl.y); ctx.lineTo(tbr.x, tbr.y);
    ctx.closePath(); ctx.fill();
  }

  if (faceVisible(-1, 0, 0, x0, midY, b.z)) {
    ctx.fillStyle = sideFill;
    ctx.beginPath();
    ctx.moveTo(bl.x, bl.y); ctx.lineTo(fl.x, fl.y);
    ctx.lineTo(tfl.x, tfl.y); ctx.lineTo(tbl.x, tbl.y);
    ctx.closePath(); ctx.fill();
  }

  // Front face
  const showFront = faceVisible(0, 0, -1, b.x, midY, z0);
  if (showFront) {
    ctx.fillStyle = frontFill;
    ctx.beginPath();
    ctx.moveTo(fl.x, fl.y); ctx.lineTo(fr.x, fr.y);
    ctx.lineTo(tfr.x, tfr.y); ctx.lineTo(tfl.x, tfl.y);
    ctx.closePath(); ctx.fill();
  }

  if (!hot && showFront) {
    const frontGlow = ctx.createLinearGradient(0, (fl.y + fr.y) / 2, 0, (tfl.y + tfr.y) / 2);
    frontGlow.addColorStop(0, "rgba(26, 42, 74, 0.55)");
    frontGlow.addColorStop(0.4, "rgba(26, 42, 74, 0.18)");
    frontGlow.addColorStop(1, "rgba(26, 42, 74, 0)");
    ctx.save();
    setShadowBlur(0);
    ctx.globalAlpha = 1 - fog * 0.85;
    ctx.fillStyle = frontGlow;
    ctx.beginPath();
    ctx.moveTo(fl.x, fl.y); ctx.lineTo(fr.x, fr.y);
    ctx.lineTo(tfr.x, tfr.y); ctx.lineTo(tfl.x, tfl.y);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // Side face
  const showRight = faceVisible(1, 0, 0, x1, midY, b.z);
  if (showRight) {
    ctx.fillStyle = sideFill;
    ctx.beginPath();
    ctx.moveTo(fr.x, fr.y); ctx.lineTo(br.x, br.y);
    ctx.lineTo(tbr.x, tbr.y); ctx.lineTo(tfr.x, tfr.y);
    ctx.closePath(); ctx.fill();
  }

  // Roof
  ctx.fillStyle = topFill;
  ctx.beginPath();
  ctx.moveTo(tfl.x, tfl.y); ctx.lineTo(tfr.x, tfr.y);
  ctx.lineTo(tbr.x, tbr.y); ctx.lineTo(tbl.x, tbl.y);
  ctx.closePath(); ctx.fill();

  if (hot) {
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = "rgba(255, 204, 204, 0.6)";
    ctx.beginPath();
    ctx.moveTo(tfl.x, tfl.y); ctx.lineTo(tfr.x, tfr.y);
    ctx.lineTo(tbr.x, tbr.y); ctx.lineTo(tbl.x, tbl.y);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  setShadowBlur(0);

  // Lobby podium band for tall buildings
  if (!hot && b.h > 58) {
    const ph = 9;
    if (projectInto(x0, 0, z0, _p0) &&
        projectInto(x1, 0, z0, _p1) &&
        projectInto(x0, ph, z0, _p2) &&
        projectInto(x1, ph, z0, _p3)) {
      ctx.fillStyle = "rgba(28, 37, 53, 0.9)";
      ctx.beginPath();
      ctx.moveTo(_p0.x, _p0.y); ctx.lineTo(_p1.x, _p1.y);
      ctx.lineTo(_p3.x, _p3.y); ctx.lineTo(_p2.x, _p2.y);
      ctx.closePath(); ctx.fill();
    }
  }

  // Roof edge outline
  ctx.strokeStyle = topEdge;
  ctx.lineWidth = hot ? 1.2 : 0.7;
  ctx.beginPath();
  ctx.moveTo(tfl.x, tfl.y); ctx.lineTo(tfr.x, tfr.y);
  ctx.lineTo(tbr.x, tbr.y); ctx.lineTo(tbl.x, tbl.y);
  ctx.closePath(); ctx.stroke();

  // Roof seams and parapet lines add scale cues on flat blocks.
  if (dist < 5200) {
    ctx.strokeStyle = hot ? "rgba(255, 160, 120, 0.28)" : "rgba(145, 178, 228, 0.13)";
    ctx.lineWidth = 0.5;
    const roofXLines = Math.max(1, Math.floor(b.w / 42));
    for (let i = 1; i <= roofXLines; i++) {
      const t = i / (roofXLines + 1);
      ctx.beginPath();
      ctx.moveTo(tfl.x + (tfr.x - tfl.x) * t, tfl.y + (tfr.y - tfl.y) * t);
      ctx.lineTo(tbl.x + (tbr.x - tbl.x) * t, tbl.y + (tbr.y - tbl.y) * t);
      ctx.stroke();
    }
    const roofZLines = Math.max(1, Math.floor(b.d / 48));
    for (let i = 1; i <= roofZLines; i++) {
      const t = i / (roofZLines + 1);
      ctx.beginPath();
      ctx.moveTo(tfl.x + (tbl.x - tfl.x) * t, tfl.y + (tbl.y - tfl.y) * t);
      ctx.lineTo(tfr.x + (tbr.x - tfr.x) * t, tfr.y + (tbr.y - tfr.y) * t);
      ctx.stroke();
    }
  }

  // Window grid - floor lines + window bay divisions
  if (dist < 5600) {
    const ga = Math.max(0.04, 0.22 - dist / 9500);
    ctx.strokeStyle = hot ? "rgb(58, 17, 17)" : "rgb(145, 178, 228)";
    ctx.globalAlpha = hot ? Math.max(0.18, ga) : ga;
    ctx.lineWidth = 0.5;

    // Horizontal floor lines on front face
    const floorH = b.floorH || 11;
    const floorCount = Math.max(1, Math.floor(b.h / floorH));
    for (let i = 1; i < floorCount; i++) {
      const t = i / floorCount;
      ctx.beginPath();
      ctx.moveTo(fl.x + (tfl.x - fl.x) * t, fl.y + (tfl.y - fl.y) * t);
      ctx.lineTo(fr.x + (tfr.x - fr.x) * t, fr.y + (tfr.y - fr.y) * t);
      ctx.stroke();
    }
    // Vertical bay lines on front face
    if (showFront) {
      const bayW = 17;
      const bayCount = Math.max(1, Math.floor(b.w / bayW));
      for (let i = 1; i < bayCount; i++) {
        const t = i / bayCount;
        ctx.beginPath();
        ctx.moveTo(fl.x + (fr.x - fl.x) * t, fl.y + (fr.y - fl.y) * t);
        ctx.lineTo(tfl.x + (tfr.x - tfl.x) * t, tfl.y + (tfr.y - tfl.y) * t);
        ctx.stroke();
      }
    }
    // Horizontal floor lines on side face
    for (let i = 1; i < floorCount; i++) {
      const t = i / floorCount;
      ctx.beginPath();
      ctx.moveTo(fr.x + (tfr.x - fr.x) * t, fr.y + (tfr.y - fr.y) * t);
      ctx.lineTo(br.x + (tbr.x - br.x) * t, br.y + (tbr.y - br.y) * t);
      ctx.stroke();
    }
    // Vertical bay lines on side face
    if (showRight) {
      const bayD = 17;
      const bayDCount = Math.max(1, Math.floor(b.d / bayD));
      for (let i = 1; i < bayDCount; i++) {
        const t = i / bayDCount;
        ctx.beginPath();
        ctx.moveTo(fr.x + (br.x - fr.x) * t, fr.y + (br.y - fr.y) * t);
        ctx.lineTo(tfr.x + (tbr.x - tfr.x) * t, tfr.y + (tbr.y - tfr.y) * t);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  if (dist < 6200 && b.h > 40) {
    if (showFront) drawWindowDots(b.frontWindows, fl, fr, tfr, tfl, hot, fog, dist);
    if (showRight) drawWindowDots(b.sideWindows, fr, br, tbr, tfr, hot, fog, dist);
  }

  // Rooftop HVAC boxes and service cores (closer buildings only)
  if (dist < 1800 && b.roofBoxes && b.roofBoxes.length) {
    for (let boxIndex = 0; boxIndex < b.roofBoxes.length; boxIndex++) {
      const box = b.roofBoxes[boxIndex];
      const bx0 = b.x + box.rx - box.rw / 2;
      const bx1 = b.x + box.rx + box.rw / 2;
      const bz0 = b.z + box.rz - box.rd / 2;
      const bz1 = b.z + box.rz + box.rd / 2;
      const by0 = b.h, by1 = b.h + box.rh;
      const rs = box.screen;
      if (!projectInto(bx0, by0, bz0, rs[0]) ||
          !projectInto(bx1, by0, bz0, rs[1]) ||
          !projectInto(bx0, by1, bz0, rs[2]) ||
          !projectInto(bx1, by1, bz0, rs[3]) ||
          !projectInto(bx1, by1, bz1, rs[4]) ||
          !projectInto(bx0, by1, bz1, rs[5]) ||
          !projectInto(bx0, by0, bz1, rs[6]) ||
          !projectInto(bx1, by0, bz1, rs[7])) continue;
      ctx.fillStyle = hot ? "rgba(100, 18, 10, 0.92)" : b.roofBoxFrontFill;
      ctx.beginPath();
      ctx.moveTo(rs[0].x, rs[0].y); ctx.lineTo(rs[1].x, rs[1].y);
      ctx.lineTo(rs[3].x, rs[3].y); ctx.lineTo(rs[2].x, rs[2].y);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = hot ? "rgba(130, 24, 12, 0.9)" : b.roofBoxLeftFill;
      ctx.beginPath();
      ctx.moveTo(rs[6].x, rs[6].y); ctx.lineTo(rs[0].x, rs[0].y);
      ctx.lineTo(rs[2].x, rs[2].y); ctx.lineTo(rs[5].x, rs[5].y);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = hot ? "rgba(120, 20, 10, 0.9)" : b.roofBoxRightFill;
      ctx.beginPath();
      ctx.moveTo(rs[1].x, rs[1].y); ctx.lineTo(rs[7].x, rs[7].y);
      ctx.lineTo(rs[4].x, rs[4].y); ctx.lineTo(rs[3].x, rs[3].y);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = hot ? "rgba(255, 70, 35, 0.92)" : b.roofBoxTopFill;
      ctx.beginPath();
      ctx.moveTo(rs[2].x, rs[2].y); ctx.lineTo(rs[3].x, rs[3].y);
      ctx.lineTo(rs[4].x, rs[4].y); ctx.lineTo(rs[5].x, rs[5].y);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = hot ? "rgba(255, 170, 130, 0.45)" : "rgba(120, 155, 205, 0.22)";
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
  }

  // Corner edge lines
  ctx.strokeStyle = edgeColor;
  ctx.lineWidth = hot ? 1 : 0.5;
  ctx.beginPath();
  ctx.moveTo(fl.x, fl.y);   ctx.lineTo(tfl.x, tfl.y);
  ctx.moveTo(tfr.x, tfr.y); ctx.lineTo(fr.x, fr.y);
  ctx.moveTo(tfr.x, tfr.y); ctx.lineTo(tbr.x, tbr.y);
  ctx.moveTo(bl.x, bl.y);   ctx.lineTo(tbl.x, tbl.y);
  ctx.moveTo(br.x, br.y);   ctx.lineTo(tbr.x, tbr.y);
  ctx.stroke();

  if (hot) drawRedGroundGlow(b);

  ctx.restore();
}

// Arc renderer

function drawArc(arc, now) {
        const elapsed = now - arc.startedAt;
        const travelT = Math.min(1, elapsed / arc.pulseDuration);
  const arrived = travelT >= 1;
  const ax = arc.ax, ay = arc.ay, az = arc.az;
  const mx = arc.mx, my = arc.my, mz = arc.mz;
  const bx = arc.bx, by = arc.by, bz = arc.bz;

  if (cameraDepth(ax, ay, az) < NEAR_PLANE &&
      cameraDepth(mx, my, mz) < NEAR_PLANE &&
      cameraDepth(bx, by, bz) < NEAR_PLANE) return false;

  const aP = arc.aP;
  const bP = arc.bP;
  const aVisible = projectInto(ax, ay, az, aP);
  const bVisible = projectInto(bx, by, bz, bP);

  let alpha = 1;
  if (elapsed < 280) alpha = elapsed / 280;
        if (arc.arrivedAt) {
          const fadeElapsed = now - arc.arrivedAt - arc.lifetime;
          if (fadeElapsed > 0) alpha *= Math.max(0, 1 - fadeElapsed / 500);
        }

  if (aVisible) drawArcMarker(aP, 5, alpha);

  // Pulse dot - world-space quadratic interpolation, larger radius
  const t   = travelT;
  const omt = 1 - t;
  const px  = omt * omt * ax + 2 * omt * t * mx + t * t * bx;
  const py  = omt * omt * ay + 2 * omt * t * my + t * t * by;
  const pz  = omt * omt * az + 2 * omt * t * mz + t * t * bz;
  const pP = arc.pP;
  if (projectInto(px, py, pz, pP) && t < 1) {
    ctx.shadowColor = "#ff3333";
    setShadowBlur(shadowBudget-- > 0 ? 20 : 0);
    ctx.globalAlpha = 0.98 * alpha;
    ctx.fillStyle   = "#ffffff";
    ctx.beginPath();
    ctx.arc(pP.x, pP.y, arc.dotRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    setShadowBlur(0);
  }
  arc.lastPulseX = pP.visible ? pP.x : arc.lastPulseX;
  arc.lastPulseY = pP.visible ? pP.y : arc.lastPulseY;
  arc.lastEndpointX = aP.x + bP.x;
  arc.lastEndpointY = aP.y + bP.y;

  // Arrival bloom
  if (arc.bloomAt && bVisible) {
    const bloomT = (now - arc.bloomAt) / 300;
    if (bloomT < 1) {
      const pulseScale = 1 + bloomT * 1.5;
      ctx.shadowColor = "#ff0000";
      setShadowBlur(shadowBudget-- > 0 ? 15 : 0);
      ctx.globalAlpha = (1 - bloomT) * alpha;
      ctx.fillStyle = "rgb(255, 68, 68)";
      ctx.beginPath();
      ctx.arc(bP.x, bP.y, 7 * pulseScale, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      setShadowBlur(0);
    }
  }
  return true;
}

function updateArcs(now) {
  let write = 0;
  for (let i = 0; i < arcs.length; i++) {
    const arc = arcs[i];
    const elapsed = now - arc.startedAt;
    const t = Math.min(1, elapsed / arc.pulseDuration);
    if (cameraDepth(arc.ax, arc.ay, arc.az) < NEAR_PLANE &&
        cameraDepth(arc.mx, arc.my, arc.mz) < NEAR_PLANE &&
        cameraDepth(arc.bx, arc.by, arc.bz) < NEAR_PLANE) continue;

    if (t >= 1 && !arc.delivered) {
      arc.delivered = true;
      arc.arrivedAt = now;
      arc.bloomAt = now;
      activate(arc.b, now);
    }
    if (arc.arrivedAt && now - arc.arrivedAt > arc.lifetime + 500) continue;

    const ax = arc.ax, ay = arc.ay, az = arc.az;
    const mx = arc.mx, my = arc.my, mz = arc.mz;
    const bx = arc.bx, by = arc.by, bz = arc.bz;
    const omt = 1 - t;
    const px = omt * omt * ax + 2 * omt * t * mx + t * t * bx;
    const py = omt * omt * ay + 2 * omt * t * my + t * t * by;
    const pz = omt * omt * az + 2 * omt * t * mz + t * t * bz;

    if (projectInto(px, py, pz, arc.pP) && t < 1) {
      if (Math.hypot(arc.pP.x - arc.lastPulseX, arc.pP.y - arc.lastPulseY) > 2) {
        arc.lastPulseX = arc.pP.x;
        arc.lastPulseY = arc.pP.y;
      }
    }
    if (projectInto(ax, ay, az, arc.aP) && projectInto(bx, by, bz, arc.bP)) {
      if (Math.hypot((arc.aP.x + arc.bP.x) - arc.lastEndpointX, (arc.aP.y + arc.bP.y) - arc.lastEndpointY) > 2) {
        arc.lastEndpointX = arc.aP.x + arc.bP.x;
        arc.lastEndpointY = arc.aP.y + arc.bP.y;
      }
    }
    if (arc.bloomAt && now - arc.bloomAt < 300) {
    } else if (arc.bloomAt && !arc.bloomDone) {
      arc.bloomDone = true;
    }
    arcs[write++] = arc;
  }
  arcs.length = write;
}

function updateQuality(deltaTime, now) {
  const fps = deltaTime > 0 ? 1 / deltaTime : 60;
  fpsSamples[fpsSampleIndex] = fps;
  fpsSampleIndex = (fpsSampleIndex + 1) % fpsSamples.length;
  fpsSampleCount = Math.min(fpsSampleCount + 1, fpsSamples.length);
  let total = 0;
  for (let i = 0; i < fpsSampleCount; i++) total += fpsSamples[i];
  fpsAverage = total / fpsSampleCount;

  if (fpsAverage < 40) {
    qualityLevel = 2;
    qualityRestoreStarted = 0;
  } else if (fpsAverage < 50 && qualityLevel < 1) {
    qualityLevel = 1;
    qualityRestoreStarted = 0;
  } else if (fpsAverage > 58) {
    if (!qualityRestoreStarted) qualityRestoreStarted = now;
    if (now - qualityRestoreStarted > 5000) qualityLevel = 0;
  } else {
    qualityRestoreStarted = 0;
  }

  renderCap = Infinity;
  windowDensityScale = 2;
}

// Recycle & update

function recycleAndUpdate(now) {
      for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i];
        if (b.z + b.d / 2 - cameraZ < -120) {
          let replacement = null;
          for (let attempt = 0; attempt < 24 && !replacement; attempt++) {
            const zi = Math.floor((cameraZ + rand(3200, 8200)) / ST_PITCH);
            const xi = randInt(-7, 7);
            const candidate = makeBuildingInCell(xi, zi);
        if (candidate && placementIsClear(candidate, buildings, 10, b)) {
          replacement = candidate;
        }
          }
          if (replacement) {
        b.x = replacement.x;
        b.z = replacement.z;
        b.w = replacement.w;
        b.d = replacement.d;
        b.h = replacement.h;
        b.type = replacement.type;
        b.hot = false;
        b.hotPhase = replacement.hotPhase;
        b.hotEndsAt = 0;
        b.infectedAt = 0;
        b.nextArcAt = 0;
        b.flickerStart = 0;
        b.seedTone = replacement.seedTone;
        b.floorH = replacement.floorH;
        b.roofBoxes = replacement.roofBoxes;
            setBuildingGeometry(b);
        b.version = (b.version || 0) + 1;
          }
        }
      }
    }

// Main loop

    function frame(now) {
      if (!running) {
        frameId = null;
        return;
      }
      now = now || performance.now();
      const minInterval = 1000 / targetFPS;
      if (targetFPS < 60 && now - lastFrameTime < minInterval) {
    frameId = requestAnimationFrame(frame);
        return;
      }
      lastFrameTime = now;
      const rawDelta = (now - lastTime) / 1000;
      const deltaTime = Math.min(rawDelta, 0.05);
      smoothDelta = smoothDelta * 0.9 + deltaTime * 0.1;
  lastTime  = now;
      frameCount++;
  shadowBudget = 14;
  shadowBlurCount = 0;
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
  updateQuality(smoothDelta, now);

      if (!reducedMotion) {
        cameraZ += DOLLY_SPEED * smoothDelta;
        cameraX += CAM_X_DRIFT * smoothDelta;
      }

  recycleAndUpdate(now);
      maybeSpawnArc(now);
      updateArcs(now);

  ctx.clearRect(0, 0, W, H);
  drawStreetGrid();

  drawList.activeLength = 0;
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    const nearEdge = b.z + b.d / 2 - cameraZ;
    const farEdge = b.z - b.d / 2 - cameraZ;
    if (nearEdge < -120 || farEdge > FAR_PLANE) continue;
    if (!buildingInView(b)) continue;
    b.drawDepth = cameraDepth(b.x, b.h * 0.5, b.z);
    b.drawHot = visualHot(b);
    pushDrawItem("building", b, b.drawDepth);
  }
  for (let i = 0; i < arcs.length; i++) {
    const arc = arcs[i];
    const elapsed = now - arc.startedAt;
    const travelT = Math.min(1, elapsed / arc.pulseDuration);
    let alpha = elapsed < 280 ? elapsed / 280 : 1;
    if (arc.arrivedAt) {
      const fadeElapsed = now - arc.arrivedAt - arc.lifetime;
      if (fadeElapsed > 0) alpha *= Math.max(0, 1 - fadeElapsed / 500);
    }

    const segmentCount = Math.max(3, Math.ceil(18 * travelT));
    for (let j = 0; j < segmentCount; j++) {
      const t0 = (j / segmentCount) * travelT;
      const t1 = ((j + 1) / segmentCount) * travelT;
      const depth = arcSegmentDepth(arc, t0, t1);
      if (depth > NEAR_PLANE && depth < FAR_PLANE) pushArcSegment(arc, t0, t1, alpha, depth);
    }
    arc.drawDepth = arcDotDepth(arc, travelT);
    if (arc.drawDepth > NEAR_PLANE && arc.drawDepth < FAR_PLANE) pushDrawItem("arc", arc, arc.drawDepth);
  }
  drawList.length = drawList.activeLength;
  drawList.sort(depthSortDesc);
  const start = renderCap === Infinity ? 0 : Math.max(0, drawList.activeLength - renderCap);
  for (let i = start; i < drawList.activeLength; i++) {
    const item = drawList[i];
    if (item.type === "building") {
      const b = item.ref;
      if (projectBuilding(b, b.drawHot)) drawBuilding(b, now);
    } else if (item.type === "arcSegment") {
      drawArcTrailSegment(item.ref, item.t0, item.t1, item.alpha);
        } else {
      drawArc(item.ref, now);
    }
  }

  ctx.save();
  ctx.font = '11px "DM Mono", monospace';
  ctx.fillStyle = "#444";
  ctx.fillText(`${Math.round(1 / Math.max(deltaTime, 0.001))} fps`, 10, 20);
  ctx.restore();

  frameId = requestAnimationFrame(frame);
}

function arcDepth(arc) {
  const elapsed = performance.now() - arc.startedAt;
  const travelT = Math.min(1, elapsed / arc.pulseDuration);
  const t = Math.max(0.12, travelT * 0.5);
  arcPointInto(arc, t, _arcDepthPoint);
  if (projectInto(_arcDepthPoint.x, 0, _arcDepthPoint.z, _arcDepthSample)) return _arcDepthSample.depth;
  if (projectInto(arc.mx, 0, arc.mz, _arcDepthSample)) return _arcDepthSample.depth;
  return cameraDepth(_arcDepthPoint.x, 0, _arcDepthPoint.z);
}

function arcDotDepth(arc, travelT) {
  arcPointInto(arc, travelT, _arcDepthPoint);
  if (projectInto(_arcDepthPoint.x, 0, _arcDepthPoint.z, _arcDepthSample)) return _arcDepthSample.depth;
  return cameraDepth(_arcDepthPoint.x, 0, _arcDepthPoint.z);
}

function arcSegmentDepth(arc, t0, t1) {
  arcPointInto(arc, (t0 + t1) * 0.5, _arcDepthPoint);
  if (projectInto(_arcDepthPoint.x, 0, _arcDepthPoint.z, _arcDepthSample)) return _arcDepthSample.depth;
  return cameraDepth(_arcDepthPoint.x, 0, _arcDepthPoint.z);
}

function pushDrawItem(type, ref, depth) {
  const index = drawList.activeLength || 0;
  let item = drawList[index];
  if (!item) {
    item = { type: "", ref: null, depth: 0 };
    drawList[index] = item;
  }
  drawList.activeLength = index + 1;
  item.type = type;
  item.ref = ref;
  item.depth = depth;
}

function pushArcSegment(arc, t0, t1, alpha, depth) {
  const index = drawList.activeLength || 0;
  let item = drawList[index];
  if (!item) {
    item = { type: "", ref: null, depth: 0, t0: 0, t1: 0, alpha: 1 };
    drawList[index] = item;
  }
  drawList.activeLength = index + 1;
  item.type = "arcSegment";
  item.ref = arc;
  item.depth = depth;
  item.t0 = t0;
  item.t1 = t1;
  item.alpha = alpha;
    }

    function resize(width, height, nextDpr) {
  W = width;
  H = height;
      dpr = Math.min(nextDpr || 1, 2);
  canvas.width  = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  if (overlayCanvas) {
    overlayCanvas.width = canvas.width;
    overlayCanvas.height = canvas.height;
  }
  gridCanvas.width = canvas.width;
  gridCanvas.height = canvas.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (particleCtx) particleCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  HORIZON_Y = H * 0.32;
  generateParticles();
  drawParticles();
  gridCacheDirty = true;
    }

    function start() {
      if (!buildings.length) generateCity();
      running = true;
      lastTime = performance.now();
      smoothDelta = 1 / 60;
      lastFrameTime = 0;
  if (reducedMotion) {
      frame(performance.now());
    stop();
    return;
  }
  if (frameId !== null) cancelAnimationFrame(frameId);
  frameId = requestAnimationFrame(frame);
    }

    function stop() {
      running = false;
      if (frameId !== null) {
    cancelAnimationFrame(frameId);
        frameId = null;
      }
    }



    function setVisibility(hidden) {
      if (hidden) stop();
      else start();
    }

    function setThrottle(fps) {
      targetFPS = fps || 60;
    }

    resize(options.width || 0, options.height || 0, dpr);
    if (!options.hidden) start();

    return { resize, start, stop, setVisibility, setThrottle };
  }

  if (typeof document === "undefined") {
    let runtime = null;
    global.onmessage = function (event) {
      const data = event.data || {};
      if (data.type === "init") {
        runtime = createCityRuntime(data);
      } else if (runtime && data.type === "resize") {
        runtime.resize(data.width, data.height, data.dpr);
      } else if (runtime && data.type === "visibility") {
        runtime.setVisibility(data.hidden);
      } else if (runtime && data.type === "throttle") {
        runtime.setThrottle(data.fps);
      }
    };
  } else {
    global.initCityMainThread = createCityRuntime;
  }
})(typeof self !== "undefined" ? self : window);
