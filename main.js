/* 機械花藝拼裝台 — assembly engine + 3D stage + panel UI.
 *
 * 資料模型:
 *   state.slots[i] = steps[]  — 每個插槽一條組裝鏈
 *   step = { k:'stem'|'conn'|'end', v:pieceId, s:spinDegrees }
 *
 * 接法規則(由 UI 提供「下一步」選項來強制成立):
 *   pot slot → stem(莖尾)
 *   stem A 頭 → end(花/蓮葉)   ← 鏈完成
 *   stem B 頭 → conn(連接器) → stem …可持續延伸;conn 為最後一節也算完成
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { CATALOG, byId } from './catalog.js';
import GIF from 'gif.js/dist/gif.js';

/* ---------------- 三維舞台 ---------------- */
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#9a9a9a'); // 全不透明灰

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.01, 20);
camera.position.set(0.44, 0.3, 0.54);

const controls = new OrbitControls(camera, canvas);
controls.target.set(-0.05, 0.11, 0); // 稍偏左,讓本體落在面板右側的舞台中央
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.12;
controls.maxDistance = 2.2;
controls.maxPolarAngle = Math.PI * 0.495;
controls.autoRotateSpeed = 1.4;

const keyLight = new THREE.DirectionalLight(0xfff2dd, 2.4);
keyLight.position.set(0.5, 0.95, 0.45);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
Object.assign(keyLight.shadow.camera, { left: -0.4, right: 0.4, top: 0.4, bottom: -0.4, near: 0.1, far: 3 });
keyLight.shadow.bias = -0.0004;
keyLight.shadow.radius = 6;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xcfd8e8, 0.5);
fillLight.position.set(-0.7, 0.4, -0.5);
scene.add(fillLight);

/* 地面:柔和接觸影 + 一圈細基線 */
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(1.1, 64),
  new THREE.ShadowMaterial({ opacity: 0.34 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const plinth = new THREE.Mesh(
  new THREE.RingGeometry(0.16, 0.163, 128),
  new THREE.MeshBasicMaterial({ color: 0x3a4034, transparent: true, opacity: 0.8 })
);
plinth.rotation.x = -Math.PI / 2;
plinth.position.y = 0.0008;
scene.add(plinth);

const assembly = new THREE.Group();
scene.add(assembly);

/* ---------------- 資產載入 ---------------- */
const assets = {};  // id → { template, head:Matrix4|null, out:Matrix4|null, slots:[{matrix}] , headKind, clip? }
const gltfLoader = new GLTFLoader();

/* 動畫花:petal 軌道單調地從閉(t=0)開到最後一幀(t=duration,全開),
 * 「全開」直接對應 clip 結尾。花蕊等軌道在過程中另有動態。 */

function parseMarkers(a, gltfScene, id) {
  a.slots = [];
  gltfScene.updateMatrixWorld(true);
  gltfScene.traverse(node => {
    const name = node.name.toLowerCase();
    if (/^stem_slot\d+$/.test(name) && node !== gltfScene) {
      a.slots.push({ matrix: node.matrix.clone(), index: parseInt(name.replace(/stem_slot/i, ''), 10) });
    } else if (/e_slot/.test(name) && id.startsWith('stem_')) {
      a.head = node.matrix.clone(); a.headKind = 'end';
    } else if (/c_slot/.test(name) && id.startsWith('stem_')) {
      a.head = node.matrix.clone(); a.headKind = 'conn';
    } else if (/^stem_slot$/.test(name) && id.startsWith('c_')) {
      a.out = node.matrix.clone();
    }
  });
  a.slots.sort((x, y) => x.index - y.index);
}

/* 模型來源:优先 HTTP 伺服器的 models/ 資料夾(方便日後直接加檔案);
 * file:// 雙開時改用 data/*.js 的內嵌快取(gzip+base64) */
const MODEL_BASE = './models/';
let httpModelMode = false;

async function detectModelMode() {
  try {
    const probe = await fetch(MODEL_BASE + 'Pot/pot_1.glb', { method: 'HEAD' });
    httpModelMode = probe.ok;
  } catch { httpModelMode = false; }
}

async function decodeModelB64(b64) {
  const raw = atob(b64);
  const bin = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bin[i] = raw.charCodeAt(i);
  if (!('DecompressionStream' in globalThis)) {
    throw new Error('This browser does not support DecompressionStream. Please use a newer Chrome / Edge / Firefox.');
  }
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

async function loadAll(onProgress) {
  const ids = Object.keys(byId);
  let done = 0;
  const queue = [...ids];
  const workers = Array.from({ length: 10 }, async () => {
    while (queue.length) {
      const id = queue.pop();
      const def = byId[id];
      let gltf = null;
      if (httpModelMode) {
        try {
          gltf = await gltfLoader.loadAsync(MODEL_BASE + def.path);
        } catch (e) {
          console.warn('models/ fetch failed, falling back to embedded data:', def.path);
        }
      }
      if (!gltf) {
        const b64 = window.__MODEL_DATA?.[id];
        if (!b64) { console.warn('Missing model data:', id); done++; continue; }
        let buf;
        try {
          buf = await decodeModelB64(b64);
        } finally {
          window.__MODEL_DATA[id] = null; // 解碼完即釋放 base64 字串
        }
        gltf = await new Promise((res, rej) => gltfLoader.parse(buf, '', res, rej));
      }
      const a = { template: gltf.scene };
      parseMarkers(a, gltf.scene, id);
      if (gltf.animations?.length) {
        a.clip = gltf.animations[0];
        byId[id].anime = true;
      }
      // 零件本地包圍盒(gltf 場景根在原點時即為零件座標系)— 供碰撞 OBB 使用
      gltf.scene.updateMatrixWorld(true);
      const bbox = new THREE.Box3().setFromObject(gltf.scene);
      a.bboxCenter = bbox.getCenter(new THREE.Vector3());
      a.bboxHalf = bbox.getSize(new THREE.Vector3()).multiplyScalar(0.475); // 微縮,降低假陽性
      assets[id] = a;
      done++;
      onProgress(done, ids.length, id);
    }
  });
  await Promise.all(workers);
}

/* ---------------- Piece thumbnails (separate mini renderer; dataURLs are reused) ---------------- */
const piecePreviews = {};

function makePiecePreviews() {
  const r2 = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  r2.setSize(160, 160);
  r2.setPixelRatio(1);
  const s2 = new THREE.Scene();
  s2.background = new THREE.Color('#20241f');
  s2.add(new THREE.HemisphereLight(0xffffff, 0x37402f, 1.7));
  const d = new THREE.DirectionalLight(0xfff2dd, 2.2);
  d.position.set(0.5, 1, 0.6);
  s2.add(d);
  const d2 = new THREE.DirectionalLight(0xcfd8e8, 0.6);
  d2.position.set(-0.7, 0.3, -0.6);
  s2.add(d2);
  const cam = new THREE.PerspectiveCamera(33, 1, 0.01, 10);
  for (const p of CATALOG.filter(x => x.kind === 'pot' || x.kind === 'end' || x.kind === 'conn' || x.kind === 'stem')) {
    const obj = assets[p.id].template;
    s2.add(obj);
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const c = box.getCenter(new THREE.Vector3());
    const radius = Math.max(...box.getSize(new THREE.Vector3()).toArray()) * 0.5;
    cam.position.copy(c).addScaledVector(new THREE.Vector3(0.55, 0.42, 0.72).normalize(), radius * 3.1);
    cam.lookAt(c);
    r2.render(s2, cam);
    piecePreviews[p.id] = r2.domElement.toDataURL('image/png');
    s2.remove(obj);
  }
  r2.dispose();
  r2.forceContextLoss();
}

/* ---------------- 狀態 ---------------- */
const STORAGE_KEY = 'mechanical-floral-layout';
let state = { pot: null, slots: [] };

/* UTF-8 安全的 state ↔ hash 編碼 */
function encodeState(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

function decodeState(str) {
  const bytes = Uint8Array.from(atob(str), c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* 私密模式等情況,略過 */ }
  if (typeof activeDesign === 'number' && activeDesign >= 0) saveDesign(activeDesign);
}

/* ---------------- Design slots:3 個自動儲存的設計 ---------------- */
const DESIGN_COUNT = 3;
let activeDesign = -1; // -1 = 未在任何 design 中
const designKey = i => `mechanical-floral-design-${i}`;

function loadDesign(i) {
  try { const raw = localStorage.getItem(designKey(i)); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function saveDesign(i) {
  if (i < 0) return;
  try {
    localStorage.setItem(designKey(i), JSON.stringify({ pot: state.pot, slots: state.slots }));
    const dot = $('#designRow')?.children[i]?.querySelector('.dot');
    if (dot) dot.classList.add('filled');
  } catch { /* 略過 */ }
}

function renderDesignRow() {
  const row = $('#designRow');
  row.innerHTML = '';
  for (let i = 0; i < DESIGN_COUNT; i++) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.setAttribute('aria-pressed', String(activeDesign === i));
    const has = !!loadDesign(i);
    const dot = document.createElement('span');
    dot.className = 'dot' + (has ? ' filled' : '');
    const t = document.createElement('span');
    t.textContent = `Design ${i + 1}`;
    b.append(dot, t);
    b.title = has ? 'Saved design — click to switch' : 'Empty — click to start a new design';
    b.onclick = () => switchDesign(i);
    row.appendChild(b);
  }
}

function switchDesign(i) {
  if (activeDesign === i) return;
  if (activeDesign >= 0) saveDesign(activeDesign); // 先存目前
  activeDesign = i;
  localStorage.setItem('mechanical-floral-design-active', String(i));
  const d = loadDesign(i);
  state.pot = d?.pot || 'pot_1';
  state.slots = Array.isArray(d?.slots) ? d.slots.filter(Boolean) : [];
  migrateSlots();
  saveState();
  selectedSlot = -1;
  $('#secBuilder').hidden = true;
  rebuild();
  renderPotSelect();
  renderSlotRow();
  renderDesignRow();
}

function loadState() {
  if (location.hash.length > 2) {
    try { state = decodeState(location.hash.slice(1)); } catch { /* hash 不合法就忽略 */ }
  }
  if (!state.pot) {
    try { const s = localStorage.getItem(STORAGE_KEY); if (s) state = JSON.parse(s); } catch { /* 略過 */ }
  }
}

/* ---------------- 組裝計算 ---------------- */
const QY = deg => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg));

/* 回傳鏈上每個零件的 Object3D;同時把 nextFrame 回寫到 ctx 變數(用返回值組合) */
function placeChain(rootFrame, steps, slotIdx) {
  const placed = [];
  let frame = rootFrame; // { pos:Vector3, quat:Quaternion }
  const UNIT_S = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const a = assets[st.v];
    if (!a) continue;
    const obj = a.template.clone(true);
    cloneMaterials(obj);
    obj.position.copy(frame.pos);
    obj.quaternion.copy(frame.quat).multiply(QY(st.s));
    obj.scale.setScalar(1);
    obj.userData = { slotIdx, stepIndex: i, pieceId: st.v, kind: st.k };
    assembly.add(obj);
    placed.push(obj);

    if (st.k === 'end' && a.clip) setupFlowerBloom(obj, a, slotIdx, i, st);
    if (st.k === 'stem' && a.head) frame = nextFrame(obj, a.head);
    else if (st.k === 'conn' && a.out) {
      // 連接器的自轉只轉動本件(葉片朝向);下游沿原軸繼續,不跟著旋轉
      const m2 = new THREE.Matrix4().compose(frame.pos, frame.quat, UNIT_S).multiply(a.out);
      frame = decompose(m2);
    }
    else break; // end:鏈到此為止
  }
  return placed;
}

/* ---------------- 花朵開闔 ---------------- */
let flowerMixers = [];  // { mixer, action, peak, obj, slotIdx, stepIndex, bloom, playing, t }
const bloomRowRefs = new Map();     // "slot:step" → { input, output } 鏈條列的開花滑桿
const bloomPlayRefs = new Map();    // "slot:step" → 單朵播放按鈕
const BLOOM_CYCLE = 5;              // 一次開→收的秒數

function setupFlowerBloom(obj, a, slotIdx, stepIndex, st) {
  const mixer = new THREE.AnimationMixer(obj);
  const action = mixer.clipAction(a.clip);
  action.play();
  const entry = { mixer, action, peak: a.clip.duration, obj, slotIdx, stepIndex, bloom: 0, playing: false, t: 0 };
  flowerMixers.push(entry);
  setFlowerBloom(entry, st.b ?? 1); // 預設全開
  return entry;
}

function setFlowerBloom(entry, b) {
  entry.bloom = THREE.MathUtils.clamp(b, 0, 1);
  entry.action.paused = true;
  entry.action.time = entry.bloom * entry.peak;
  entry.mixer.update(0);
  // 同步回狀態與鏈條列滑桿(供儲存/分享)
  const steps = state.slots[entry.slotIdx];
  if (steps?.[entry.stepIndex]?.k === 'end') steps[entry.stepIndex].b = entry.bloom;
  const ref = bloomRowRefs.get(`${entry.slotIdx}:${entry.stepIndex}`);
  if (ref && document.activeElement !== ref.input) {
    const pct = Math.round(entry.bloom * 100);
    ref.input.value = pct;
    ref.output.textContent = `${pct}%`;
  }
}

function updatePlayUI() {
  bloomPlayRefs.forEach((pb, key) => {
    const entry = flowerMixers.find(e => `${e.slotIdx}:${e.stepIndex}` === key);
    const on = !!entry?.playing;
    pb.textContent = on ? '⏸' : '▶';
    pb.setAttribute('aria-pressed', String(on));
    pb.title = on ? "Stop this flower's bloom cycle" : "Play this flower's bloom cycle";
  });
}

function nextFrame(obj, localMat) {
  obj.updateMatrixWorld(true);
  return decompose(obj.matrixWorld.clone().multiply(localMat));
}

function decompose(m) {
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
  m.decompose(pos, quat, scl);
  return { pos, quat };
}

function cloneMaterials(root) {
  root.traverse(o => { if (o.isMesh) o.material = o.material.clone(); });
}

/* ---------------- 場景重建 ---------------- */
const slotMarkers = new THREE.Group();     // 黃銅光圈(空插槽)
const slotPicks = new THREE.Group();       // 無形拾取球
scene.add(slotMarkers, slotPicks);
let pickables = [];      // 全部可點的 mesh(slot pick + piece meshes)

function potSlotFrames(potId) {
  const potObj = assets[potId].template;
  potObj.updateMatrixWorld(true);
  return assets[potId].slots.map(s => decompose(potObj.matrixWorld.clone().multiply(s.matrix)));
}

let slotFrames = [];

/* ---------------- 碰撞檢測 ----------------
 * 有網路時載入 three-mesh-bvh:三角形級精確檢測(花盆口是洞,莖尾穿過不會誤報);
 * 載入失敗(離線)時退回 OBB/SAT 方塊近似(僅零件 vs 零件)。
 * 同一鏈條相鄰的零件本來就會接觸,一律排除。*/
let collisions = { bySlot: new Set(), byStep: new Set(), pairs: [] };
let lastObbs = [];
let lastPot = null; // { meshes:[{geom,mw}], bbox:Box3 }
let bvhReady = false;

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/* BVH 精確測試:A 的 mesh 與 B 的 mesh 之間是否有三角形相交 */
function exactMeshPair(A, B) {
  for (const ma of A.meshes) {
    const inv = ma.mw.clone().invert();
    for (const mb of B.meshes) {
      const toA = new THREE.Matrix4().multiplyMatrices(inv, mb.mw);
      try {
        if (ma.geom.boundsTree.intersectsGeometry(mb.geom, toA)) return true;
      } catch { /* 幾何不可比,略過 */ }
    }
  }
  return false;
}

async function initBVH() {
  for (const a of Object.values(assets)) {
    a.template.traverse(o => {
      if (o.isMesh && !o.geometry.boundsTree) {
        try { o.geometry.computeBoundsTree(); } catch { /* 空幾何等,略過 */ }
      }
    });
  }
  bvhReady = true;
}

function obbAxes(q) {
  return [
    new THREE.Vector3(1, 0, 0).applyQuaternion(q),
    new THREE.Vector3(0, 1, 0).applyQuaternion(q),
    new THREE.Vector3(0, 0, 1).applyQuaternion(q),
  ];
}

function obbsCollide(a, b) {
  const A = a.axes, B = b.axes;
  const d = new THREE.Vector3().subVectors(b.c, a.c);
  const T = [d.dot(A[0]), d.dot(A[1]), d.dot(A[2])];
  const ae = [a.e.x, a.e.y, a.e.z], be = [b.e.x, b.e.y, b.e.z];
  const R = A.map(ax => B.map(bx => ax.dot(bx)));          // R[i][j] = A[i]·B[j]
  const RA = R.map(r => r.map(Math.abs));
  // 分離軸:A 的三個軸
  for (let i = 0; i < 3; i++) {
    const radA = ae[i];
    const radB = RA[i][0] * be[0] + RA[i][1] * be[1] + RA[i][2] * be[2];
    if (Math.abs(T[i]) > radA + radB) return false;
  }
  // 分離軸:B 的三個軸
  for (let j = 0; j < 3; j++) {
    const t = T[0] * R[0][j] + T[1] * R[1][j] + T[2] * R[2][j];
    const radA = ae[0] * RA[0][j] + ae[1] * RA[1][j] + ae[2] * RA[2][j];
    if (Math.abs(t) > radA + be[j]) return false;
  }
  // 分離軸:Ai × Bj(9 個)
  for (let i = 0; i < 3; i++) {
    const i1 = (i + 1) % 3, i2 = (i + 2) % 3;
    for (let j = 0; j < 3; j++) {
      const j1 = (j + 1) % 3, j2 = (j + 2) % 3;
      if (Math.abs(R[i][j]) < 0.999) {
        const t = T[i1] * R[i2][j] - T[i2] * R[i1][j];
        const radA = ae[i1] * RA[i2][j] + ae[i2] * RA[i1][j];
        const radB = be[j1] * RA[i][j2] + be[j2] * RA[i][j1];
        if (Math.abs(t) > radA + radB) return false;
      }
    }
  }
  return true;
}

function computeCollisions() {
  const next = { bySlot: new Set(), byStep: new Set(), pairs: [] };
  const list = lastObbs = [];
  assembly.updateMatrixWorld(true);
  assembly.children.forEach(obj => {
    if (obj.userData.pieceId === undefined) return; // 花盆在 BVH 模式才參與
    const a = assets[obj.userData.pieceId];
    if (!a?.bboxHalf) return;
    const c = a.bboxCenter.clone().applyQuaternion(obj.quaternion).add(obj.position);
    const meshes = [];
    if (bvhReady) {
      obj.traverse(mo => {
        if (mo.isMesh && mo.geometry.boundsTree) meshes.push({ geom: mo.geometry, mw: mo.matrixWorld });
      });
    }
    list.push({ s: obj.userData.slotIdx, i: obj.userData.stepIndex, c, q: obj.quaternion.clone(), e: a.bboxHalf, axes: obbAxes(obj.quaternion), meshes });
  });
  const potObj = assembly.children.find(o => o.userData.pieceId === undefined);
  if (bvhReady && potObj) {
    potObj.updateMatrixWorld(true);
    const potMeshes = [];
    potObj.traverse(mo => {
      if (mo.isMesh && mo.geometry.boundsTree) {
        potMeshes.push({ geom: mo.geometry, mw: mo.matrixWorld, name: mo.name });
      }
    });
    // 排除花盆的插座(vase_connector):莖尾插進去是設計上的正常接合,不算碰撞
    lastPot = {
      meshes: potMeshes.filter(m => !/connect/i.test(m.name)),
      bbox: new THREE.Box3().setFromObject(potObj),
    };
  }
  const record = (a, b, label) => {
    next.pairs.push({ a: { s: a.s, i: a.i }, b: label ? null : { s: b.s, i: b.i }, label });
    next.bySlot.add(a.s); if (!label) next.bySlot.add(b.s);
    next.byStep.add(`${a.s}:${a.i}`); if (!label) next.byStep.add(`${b.s}:${b.i}`);
  };
  for (let p = 0; p < list.length; p++) {
    for (let r = p + 1; r < list.length; r++) {
      const a = list[p], b = list[r];
      if (a.s === b.s) continue; // 同一條鏈上:零件經接頭相連,尖端互入是接頭幾何(葉片迴圈)造成的設計性接觸,不視為碰撞
      if (!obbsCollide(a, b)) continue;                      // OBB 快速排除
      if (bvhReady) {
        if (exactMeshPair(a, b)) record(a, b, null);
      } else {
        record(a, b, null); // 退化:OBB 為準
      }
    }
    if (bvhReady && lastPot) {
      const a = list[p];
      const potObb = {
        c: lastPot.bbox.getCenter(new THREE.Vector3()),
        e: lastPot.bbox.getSize(new THREE.Vector3()).multiplyScalar(0.5),
        q: new THREE.Quaternion(), axes: obbAxes(new THREE.Quaternion())
      };
      if (obbsCollide(a, potObb) && exactMeshPair(a, lastPot)) {
        record(a, { s: a.s, i: -1 }, 'pot');
      }
    }
  }
  collisions = next;
}

/* 除錯鉗子:console 可用 window.__dbg 檢查 */
window.__dbg = { collisions: () => collisions, obbs: () => lastObbs, sat: obbsCollide, bvh: () => bvhReady, exact: exactMeshPair, pot: () => lastPot, target: () => controls.target, camera: () => camera.position };

function rebuild() {
  // 幾何是各模板共享的,不能 dispose;只釋放每個放置實體 clone 出來的材質
  assembly.traverse(o => { if (o.isMesh) o.material?.dispose?.(); });
  assembly.clear();
  // 光圈與拾取球是每次新建的,連同其幾何與材質一起釋放
  slotMarkers.traverse(o => { if (o.isMesh) { o.geometry?.dispose(); o.material?.dispose(); } });
  slotPicks.traverse(o => { if (o.isMesh) o.geometry?.dispose(); });
  slotMarkers.clear();
  slotPicks.clear();
  pickables = [];
  flowerMixers = [];
  bloomRowRefs.clear();

  if (!state.pot) return;

  const potObj = assets[state.pot].template.clone(true);
  potObj.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.castShadow = o.receiveShadow = true; } });
  assembly.add(potObj);

  slotFrames = potSlotFrames(state.pot);

  state.slots.forEach((steps, i) => {
    if (!steps?.length) return;
    const placed = placeChain(slotFrames[i], steps, i);
    placed.forEach(p => p.traverse(o => {
      if (o.isMesh) { o.castShadow = o.receiveShadow = true; pickables.push(o); }
    }));
  });

  buildSlotMarkers();
  pickables.push(...collectPickAndMarkers());
  computeCollisions();
  updateCollideStatus();
}

/* 完整重建(3D + 面板 UI)— 用於結構性改變(加減零件、換花盆) */
function rebuildFull() {
  rebuild();
  renderSlotRow();
  if (!$('#secBuilder').hidden) renderBuilder();
  updatePlayUI();
  frameAssembly();
}

/* 只重建某個插槽的鏈(滑桿拖曳中用,避免整場重建造成卡頓) */
function replaceChain(slotIdx) {
  for (const child of [...assembly.children]) {
    if (child.userData.pieceId !== undefined && child.userData.slotIdx === slotIdx) {
      child.traverse(o => { if (o.isMesh) o.material?.dispose?.(); });
      const root = child;
      pickables = pickables.filter(m => {
        // 以最頂層祖先判定是否屬於被移除的鏈
        let p = m;
        while (p.parent) p = p.parent;
        return p !== root;
      });
      assembly.remove(child);
    }
  }
  const steps = state.slots[slotIdx];
  if (steps?.length) {
    placeChain(slotFrames[slotIdx], steps, slotIdx).forEach(p =>
      p.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; pickables.push(o); } })
    );
  }
  computeCollisions();
  updateCollideStatus();
}

/* 空插槽:黃銅光圈;已占用:淡圈仍可點(選中鏈) */
function buildSlotMarkers() {
  slotFrames.forEach((f, i) => {
    const occupied = !!state.slots[i]?.length;
    const ring = new THREE.Mesh(
      occupied
        ? new THREE.RingGeometry(0.009, 0.0105, 48).rotateX(-Math.PI / 2)
        : new THREE.RingGeometry(0.008, 0.012, 48).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0xb08a3e, metalness: 0.85, roughness: 0.35,
        emissive: 0xb08a3e, emissiveIntensity: occupied ? 0.25 : 0.55,
        transparent: false, side: THREE.DoubleSide,
        depthTest: false, // 插槽多在花盆口內,穿透顯示像 AR 標記
      })
    );
    ring.renderOrder = 999;
    ring.position.copy(f.pos);
    ring.position.y += 0.0022;
    ring.userData.slotIdx = i;
    slotMarkers.add(ring);

    const pick = new THREE.Mesh(
      new THREE.SphereGeometry(0.016, 10, 8),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, opacity: 0 })
    );
    pick.position.copy(f.pos);
    pick.position.y += 0.01;
    pick.userData.slotIdx = i;
    slotPicks.add(pick);
  });
}

function collectPickAndMarkers() {
  const out = [];
  slotPicks.traverse(o => { if (o.isMesh) out.push(o); });
  return out;
}

/* ---------------- 鏡頭構圖 ---------------- */
const camGoal = { target: new THREE.Vector3(-0.05, 0.11, 0), dist: 0.75, frames: 0 };

function frameAssembly() {
  if (assembly.children.length === 0) return;
  const box = new THREE.Box3().setFromObject(assembly);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const r = Math.max(size.x, size.z, size.y * 0.9) * 0.55 + 0.05;
  camGoal.target.set(center.x * 0.5, box.min.y + size.y * 0.42, center.z * 0.5);
  camGoal.dist = THREE.MathUtils.clamp(r * 2.9, 0.4, 2.0);
  camGoal.frames = 110; // 只有剛改動後的一段時間會拉鏡頭
}

/* ---------------- 拾取與懸停 ---------------- */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hoveredSlot = -1;
let hoveredPiece = null;
let downPos = null;

/* 插槽光圈顯示開關(隱藏時也停用 3D 插槽點擊,面板晶片仍可用) */
let ringsVisible = true;

function pickAt(ev) {
  const rect = canvas.getBoundingClientRect();
  pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  let hits = raycaster.intersectObjects(pickables, false);
  if (!ringsVisible) hits = hits.filter(h => h.object.userData.stepIndex !== undefined); // 跳過插槽拾取球
  if (hits.length) {
    const h = hits[0];
    if (h.object.userData.slotIdx !== undefined && h.object.userData.stepIndex === undefined)
      return { slot: h.object.userData.slotIdx };
    let o = h.object;
    while (o && o.userData.slotIdx === undefined) o = o.parent;
    if (o) return { slot: o.userData.slotIdx, stepIndex: o.userData.stepIndex, pieceId: o.userData.pieceId };
  }
  return null;
}

canvas.addEventListener('pointerdown', ev => { downPos = [ev.clientX, ev.clientY]; });
canvas.addEventListener('pointerup', ev => {
  if (!downPos) return;
  const moved = Math.hypot(ev.clientX - downPos[0], ev.clientY - downPos[1]);
  downPos = null;
  if (moved > 5) return; // 視為拖曳,不是點擊
  const hit = pickAt(ev);
  if (hit) selectSlot(hit.slot);
});

function setPieceTint(root, on) {
  root.traverse(o => {
    if (!o.isMesh) return;
    const m = o.material;
    if (m.userData.baseEmissive === undefined) m.userData.baseEmissive = m.emissive.clone();
    m.emissive.copy(on ? new THREE.Color(0x2e4a28) : m.userData.baseEmissive);
  });
}

canvas.addEventListener('pointermove', ev => {
  const hit = pickAt(ev);
  canvas.style.cursor = hit ? 'pointer' : '';
  const slot = hit?.slot ?? -1;
  if (slot !== hoveredSlot) {
    hoveredSlot = slot;
    // 光圈亮淡交給 loop() 的 pulse 邏輯,這裡只記錄
  }
  const prev = hoveredPiece;
  hoveredPiece = hit && hit.stepIndex !== undefined
    ? assembly.children.find(c => c.userData.slotIdx === hit.slot && c.userData.stepIndex === hit.stepIndex) ?? null
    : null;
  if (prev !== hoveredPiece) {
    if (prev) setPieceTint(prev, false);
    if (hoveredPiece) setPieceTint(hoveredPiece, true);
    showSpecimen(hit);
  } else if (hit) showSpecimen(hit);
  else hideSpecimen();
});

canvas.addEventListener('pointerleave', () => { hoveredSlot = -1; hoveredPiece = null; hideSpecimen(); });

/* ---------------- UI 工具 ---------------- */
const $ = s => document.querySelector(s);
const toastEl = $('#toast');
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2400);
}

const specimen = $('#specimen');
function showSpecimen(hit) {
  const piece = byId[hit?.pieceId];
  const steps = state.slots[hit?.slot] || [];
  $('#specimenText').innerHTML = piece
    ? `${pieceDisplayName(piece)}<br><span class="sub">Slot ${hit.slot + 1} · ${steps.length} part(s) in this slot · click to adjust</span>`
    : '';
  specimen.hidden = !piece;
}
function hideSpecimen() { specimen.hidden = true; }

/* ---------------- Display names ---------------- */
const SIDE_EN = { L: 'L', R: 'R' };
function pieceDisplayName(p) {
  if (p.kind === 'pot') return `Pot ${p.id.slice(4)}`;
  if (p.kind === 'stem') {
    const ang = p.angle === 0 ? 'Straight' : `${p.angle}°${SIDE_EN[p.side]}`;
    return `Type-${p.group} Stem (${p.len === 1 ? 'Short' : 'Long'}) ${ang}`;
  }
  if (p.kind === 'conn') {
    if (!p.leaf) return 'Plain Connector';
    return `${{ tulip: 'Tulip', mum: 'Mum', rose: 'Rose' }[p.leaf.flower]} Leaf ${p.leaf.variant.toUpperCase()} ${SIDE_EN[p.leaf.side.toUpperCase()]}`;
  }
  return p.display || p.id;
}

/* ---------------- Panel: pot (select button + right-side submenu) ---------------- */
let selectedSlot = -1;
const potLabel = p => `Pot ${p.id.slice(4)}`;
const potSlotCount = p => assets[p.id]?.slots.length ?? '?';

function renderPotSelect() {
  const btn = $('#potBtn');
  const cur = CATALOG.find(p => p.id === state.pot) || CATALOG.find(p => p.kind === 'pot');
  btn.querySelector('.name').textContent = potLabel(cur);
  btn.querySelector('.meta').textContent = `${potSlotCount(cur)} slots`;
  renderPotMenu();
}

function renderPotMenu() {
  const menu = $('#potMenu');
  menu.innerHTML = '';
  CATALOG.filter(p => p.kind === 'pot').forEach(p => {
    const b = document.createElement('button');
    b.className = 'pot-item';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(state.pot === p.id));
    const img = document.createElement('img');
    img.className = 'pot-item-thumb';
    img.src = piecePreviews[p.id] || '';
    img.alt = potLabel(p);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = potLabel(p);
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${potSlotCount(p)} slots`;
    b.append(img, name, meta);
    b.onclick = () => {
      const changed = state.pot !== p.id;
      if (changed) {
        state.pot = p.id;
        state.slots = [];
        selectedSlot = -1;
        $('#secBuilder').hidden = true;
        saveState();
        rebuild();
      }
      closePotMenu();
      renderPotSelect();
      renderSlotRow();
    };
    menu.appendChild(b);
  });
}

function updatePotMenu(open) {
  const menu = $('#potMenu');
  const btn = $('#potBtn');
  if (open) {
    menu.hidden = false; // display first so it can be measured
    const r = btn.getBoundingClientRect();
    menu.style.left = `${r.right + 10}px`;
    menu.style.top = `${Math.max(12, Math.min(r.top, innerHeight - menu.offsetHeight - 12))}px`;
    btn.setAttribute('aria-expanded', 'true');
  } else {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
}
const closePotMenu = () => updatePotMenu(false);
$('#potBtn').onclick = () => updatePotMenu($('#potMenu').hidden);
document.addEventListener('pointerdown', ev => {
  if ($('#potMenu').hidden) return;
  if (!ev.target.closest('#potMenu') && !ev.target.closest('#potBtn')) closePotMenu();
});
$('#panel').addEventListener('scroll', () => { if (!$('#potMenu').hidden) closePotMenu(); }, { passive: true });

/* 面板整體收合 / 展開:切換鈕在面板開啟時浮在 Pot 列右側,收起時移回品牌下方 */
function positionPanelToggle() {
  const btn = $('#btnPanel');
  const panel = $('#panel');
  if (panel.hidden) {
    btn.style.left = '-13px';
    btn.style.top = `${Math.round(innerHeight / 2 - btn.offsetHeight / 2)}px`;
  } else {
    const r = panel.getBoundingClientRect();
    btn.style.left = `${Math.round(r.right - 13)}px`;
    btn.style.top = `${Math.round(r.top + r.height / 2 - btn.offsetHeight / 2)}px`;
  }
}

$('#btnPanel').onclick = () => {
  const panel = $('#panel');
  const show = panel.hidden;
  panel.hidden = !show;
  $('#btnPanel').setAttribute('aria-pressed', String(show));
  if (!show) closePotMenu();
  positionPanelToggle();
};

/* Slots 區塊收合:外框按鈕隨內容變大 */
$('#slotsToggle').onclick = () => {
  const open = !$('#slotsBody').hidden;
  $('#slotsBody').hidden = open;
  $('#slotsGroup').classList.toggle('open', !open);
  $('#slotsToggle').setAttribute('aria-expanded', String(!open));
};

/* ---------------- 面板:插槽(依 slot 實際位置擺放的圓形按鈕) ---------------- */
function chainDone(steps) {
  if (!steps.length) return 'empty';
  const last = steps[steps.length - 1];
  return (last.k === 'end' || last.k === 'conn') ? 'done' : 'warn';
}

function updateCollideStatus() {
  const el = $('#collideStatus');
  if (!collisions.pairs.length) { el.hidden = true; return; }
  const keys = new Set();
  for (const p of collisions.pairs) {
    if (!p.b) keys.add(`slot ${p.a.s + 1} (piece vs pot)`);
    else if (p.a.s === p.b.s) keys.add(`slot ${p.a.s + 1} (pieces clash)`);
    else keys.add(`slot ${Math.min(p.a.s, p.b.s) + 1} × slot ${Math.max(p.a.s, p.b.s) + 1}`);
  }
  el.textContent = bvhReady ? `⚠ Collision: ${[...keys].join(', ')}` : `⚠ Possible overlap (approximate): ${[...keys].join(', ')}`;
  el.hidden = false;
}

function renderSlotRow() {
  const map = $('#slotRow');
  map.className = 'slot-grid';
  map.innerHTML = '';
  if (!state.pot || !slotFrames.length) { map.hidden = true; return; }
  map.hidden = false;
  // 每行格數 = ceil(sqrt(n))(2→1 行 2 格、4→2x2、9→3x3、16→4x4);第 4 欄軌道同尺寸、可空
  const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(slotFrames.length))));
  for (let i = 0; i < slotFrames.length; i++) {
    const b = document.createElement('button');
    b.className = 'slot-node';
    b.textContent = i + 1;
    b.title = `slot ${i + 1}`;
    const st = chainDone(state.slots[i] || []);
    if (collisions.bySlot.has(i)) b.classList.add('collide');
    else if (st === 'warn') b.classList.add('warn');
    else if (st === 'done') b.classList.add('filled');
    b.setAttribute('aria-pressed', String(selectedSlot === i));
    b.style.gridColumn = String((i % cols) + 1);
    b.onclick = () => selectSlot(i);
    map.appendChild(b);
  }
}

function selectSlot(i) {
  selectedSlot = i;
  $('#secBuilder').hidden = false;
  $('#builderTitle').textContent = `Assemble slot ${i + 1}`;
  renderSlotRow();
  renderBuilder();
}

/* ---------------- 面板:鏈組裝 ---------------- */
function suggestSpin(slotFrame, piece) {
  // 讓第一根莖的彎頭朝插槽對外的方向
  if (!piece || piece.kind !== 'stem' || piece.angle === 0) return 0;
  const d = new THREE.Vector3(slotFrame.pos.x, 0, slotFrame.pos.z);
  if (d.lengthSq() < 1e-6) return 0;
  d.normalize();
  const lx = piece.side === 'L' ? -1 : 1;
  const rad = Math.atan2(-lx * d.z, lx * d.x);
  return Math.round((THREE.MathUtils.radToDeg(rad) + 360) / 5) * 5 % 360;
}

/* Resolve a stem step's concrete model from its parameters */
function stemPieceFor(group, len, angle, side) {
  return CATALOG.find(x => x.kind === 'stem' && x.group === group &&
    x.len === len && x.angle === angle &&
    (angle === 0 ? !x.side : (x.side || '').toUpperCase() === (side || 'L').toUpperCase()));
}
function resolveStem(st) {
  const p = stemPieceFor(st.group, st.len, st.angle, st.side);
  if (p) st.v = p.id;
  return p;
}
/* Older saved chains keep only v: derive stem parameters back from the catalog.
   Also drop broken/null steps left by previous versions, and re-map stem ids
   renamed across naming conventions (stem_1B_15L → stem_1B_15_L). */
function migrateSlots() {
  state.slots = (state.slots || []).map(steps => steps.filter(st => st && st.v));
  for (const steps of state.slots) for (const st of steps) {
    if (st.k !== 'stem') continue;
    if (!st.group) {
      const p = byId[st.v];
      if (p) { st.group = p.group; st.len = p.len; st.angle = p.angle; st.side = p.side; continue; }
    }
    if (!byId[st.v]) {
      // Unknown stem id (e.g. renamed files): parse the old id and resolve anew
      const m = /^stem_([13])([AB])_(\d+)(?:_?)([LR])?/i.exec(st.v || '');
      if (m) {
        st.group = m[2].toUpperCase(); st.len = +m[1]; st.angle = +m[3];
        st.side = m[4] ? m[4].toUpperCase() : null;
      }
      resolveStem(st); // may set v again; stays broken if still unresolvable
    }
  }
}

/* Standard labelled slider row */
function ctlRow(label, min, max, step, value, fmt, oninput) {
  const row = document.createElement('div');
  row.className = 'spin-row';
  row.innerHTML = `<label></label><input type="range" min="${min}" max="${max}" step="${step}" value="${value}"><output></output>`;
  row.querySelector('label').textContent = label;
  const input = row.querySelector('input');
  const out = row.querySelector('output');
  out.textContent = fmt(value);
  input.oninput = () => { out.textContent = fmt(+input.value); oninput(+input.value); };
  return { row, input, out };
}
const sideFmtLR = val => (val ? 'R' : 'L');

/* Leaf-folder options = leaf connectors + lotus-leaf ends */
function leafOptions() {
  return CATALOG.filter(x => (x.kind === 'conn' && x.leaf) || (x.kind === 'end' && x.type === 'lotus-leaf'));
}
const flowerOptions = () => CATALOG.filter(x => x.kind === 'end' && x.type === 'flower');

/* Shared right-side dropdown submenu (fixed, next to the anchor button) */
const pieceMenu = $('#pieceMenu');
function closePieceMenu() { pieceMenu.hidden = true; }
function openPieceMenu(anchor, options, metaFor, onPick) {
  pieceMenu.innerHTML = '';
  options.forEach(p => {
    const b = document.createElement('button');
    b.className = 'pot-item';
    b.setAttribute('role', 'option');
    const img = document.createElement('img');
    img.className = 'pot-item-thumb';
    img.src = piecePreviews[p.id] || '';
    img.alt = pieceDisplayName(p);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = pieceDisplayName(p);
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = metaFor(p);
    b.append(img, name, meta);
    b.onclick = () => { closePieceMenu(); onPick(p); };
    pieceMenu.appendChild(b);
  });
  pieceMenu.hidden = false; // display first so it can be measured
  const r = anchor.getBoundingClientRect();
  pieceMenu.style.left = `${r.right + 10}px`;
  pieceMenu.style.top = `${Math.max(12, Math.min(r.top, innerHeight - pieceMenu.offsetHeight - 12))}px`;
}

/* Commit the chain after structural changes (models added/removed/swapped) */
function setStemGroup(st, group) {
  if (st.group === group) return;
  st.group = group;
  resolveStem(st);
  saveState();
  replaceChain(selectedSlot);
  renderSlotRow();
}
function newStem(group, len, angle, side) {
  const piece = stemPieceFor(group, len, angle, side) || CATALOG.find(p => p.kind === 'stem');
  const s = suggestSpin(slotFrames[selectedSlot], piece);
  return { k: 'stem', group, len, angle, side: side ?? null, s, v: piece.id };
}

/* Which buttons follow the chain */
function renderNextPicker() {
  const target = $('#nextPicker');
  target.innerHTML = '';
  const steps = state.slots[selectedSlot] || [];
  const last = steps[steps.length - 1];

  const addBtn = () => {
    const b = document.createElement('button');
    b.className = 'btn-add';
    b.textContent = '+ Add stem';
    b.onclick = () => addStep(steps.length, newStem('A', 1, 0, null));
    return b;
  };

  if (!last) { target.appendChild(addBtn()); return; }

  if (last.k === 'end') {
    const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'This chain is complete — pick another slot.';
    target.appendChild(p);
    return;
  }

  if (last.k === 'conn') { target.appendChild(addBtn()); return; }

  /* last is a stem → its head can still take Leaf / Stem / Flower */
  const btns = document.createElement('div');
  btns.className = 'next-choices';
  const make = (label, onclick) => {
    const b = document.createElement('button');
    b.className = 'chip choice';
    b.textContent = label;
    b.setAttribute('data-menu-anchor', 'yes');
    b.onclick = onclick;
    btns.appendChild(b);
    return b;
  };
  make('Leaf', () => {
    setStemGroup(last, 'A');
    openPieceMenu(btns.querySelector('.choice'), leafOptions(),
      p2 => (p2.kind === 'conn' ? 'Chain continues' : 'Chain ends here'),
      p2 => {
        if (p2.kind === 'conn') addStep(steps.length, { k: 'conn', v: p2.id, s: 0 });
        else addStep(steps.length, { k: 'end', v: p2.id, s: 0, b: 1 });
        renderBuilder();
      });
  });
  make('Stem', () => {
    setStemGroup(last, 'B');
    addStep(steps.length, { k: 'conn', v: 'c_connector', s: 0 });
    addStep(steps.length, newStem('A', 1, 0, null));
    renderBuilder();
  });
  make('Flower', () => {
    setStemGroup(last, 'A');
    openPieceMenu(btns.querySelectorAll('.choice')[2], flowerOptions(),
      () => 'Blooms', p2 => {
        addStep(steps.length, { k: 'end', v: p2.id, s: 0, b: 1 });
        renderBuilder();
      });
  });
  target.appendChild(btns);
}

function renderChainTree() {
  const tree = $('#chainTree');
  tree.innerHTML = '';
  bloomRowRefs.clear();
  bloomPlayRefs.clear();
  const steps = state.slots[selectedSlot] || [];
  steps.forEach((st, i) => {
    const row = document.createElement('div');
    row.className = 'chain-step';
    row.dataset.kind = st.k;
    if (collisions.byStep.has(`${selectedSlot}:${i}`)) row.classList.add('collide');

    /* head: remove + label + (play) + fold toggle — same order as section buttons */
    const head = document.createElement('div');
    head.className = 'head-row';
    const x = document.createElement('button');
    x.className = 'x'; x.textContent = '×'; x.title = 'Remove from this step onward';
    x.onclick = () => removeStepFrom(i);
    head.appendChild(x);
    const kindEN = st.k === 'stem' ? 'Stem'
      : st.k === 'conn' ? (byId[st.v]?.leaf ? pieceDisplayName(byId[st.v]) : 'Connector')
      : pieceDisplayName(byId[st.v]);
    const label = document.createElement('span');
    label.className = 'v';
    label.textContent = kindEN;
    head.appendChild(label);
    // Animated flower: per-flower play button (▶ open / ⏸ stop)
    if (st.k === 'end' && byId[st.v]?.anime) {
      const pb = document.createElement('button');
      pb.className = 'mini-play';
      pb.textContent = '▶';
      pb.title = "Play this flower's bloom cycle";
      pb.setAttribute('aria-pressed', 'false');
      pb.onclick = () => toggleFlowerPlay(selectedSlot, i);
      head.appendChild(pb);
      bloomPlayRefs.set(`${selectedSlot}:${i}`, pb);
    }
    // Re-choose the end piece without removing the step
    if (st.k === 'end') {
      const isFlower = byId[st.v]?.type === 'flower';
      const swap = document.createElement('button');
      swap.className = 'mini-play';
      swap.textContent = '⇄';
      swap.title = isFlower ? 'Change flower' : 'Change lotus leaf';
      const opts = isFlower ? flowerOptions() : CATALOG.filter(q => q.kind === 'end' && q.type === 'lotus-leaf');
      swap.setAttribute('data-menu-anchor', 'yes');
      swap.onclick = () => openPieceMenu(swap, opts,
        () => (isFlower ? 'Blooms' : 'Chain ends here'),
        p2 => {
          if (p2.id === st.v) { closePieceMenu(); return; }
          st.v = p2.id;
          replaceChain(selectedSlot);
          saveState();
          renderBuilder();
        });
      head.appendChild(swap);
    }
    const fold = document.createElement('button');
    fold.className = 'fold';
    fold.title = 'Collapse / expand settings';
    fold.setAttribute('aria-expanded', 'true');
    fold.innerHTML = `<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;
    head.appendChild(fold);
    row.appendChild(head);

    /* collapsible settings body */
    const body = document.createElement('div');
    body.className = 'ctl-body';
    fold.onclick = () => {
      body.hidden = !body.hidden;
      fold.setAttribute('aria-expanded', String(!body.hidden));
    };
    row.appendChild(body);

    if (st.k === 'stem') {
      /* Height: short (1) / long (3) */
      body.appendChild(ctlRow('Height', 0, 1, 1, st.len === 1 ? 0 : 1, val => (val ? 'Long' : 'Short'),
        val => { st.len = val ? 3 : 1; resolveStem(st); replaceChain(selectedSlot); saveState(); renderSlotRow(); }).row);
      /* Curvature: 0..90 in 15° steps */
      body.appendChild(ctlRow('Curvature', 0, 90, 15, st.angle, ang => (ang === 0 ? 'Straight' : `${ang}°`),
        ang => {
          st.angle = ang; if (ang === 0) st.side = null; else if (!st.side) st.side = 'L';
          resolveStem(st); replaceChain(selectedSlot); saveState(); renderSlotRow();
        }).row);
      /* Left / Right — always selectable; on straight stems the side is kept but visually unused */
      body.appendChild(ctlRow('L / R', 0, 1, 1, st.side === 'R' ? 1 : 0, sideFmtLR,
        val => { st.side = val ? 'R' : 'L'; if (st.angle > 0) { resolveStem(st); replaceChain(selectedSlot); } saveState(); }).row);
      /* Rotation */
      body.appendChild(ctlRow('Rotation', 0, 355, 5, st.s, deg => `${deg}°`,
        val => { st.s = val; replaceChain(selectedSlot); saveState(); }).row);
    } else if (st.k === 'conn' && byId[st.v]?.leaf) {
      /* Leaf connector: side L/R + rotation */
      const p = byId[st.v];
      body.appendChild(ctlRow('L / R', 0, 1, 1, p.leaf.side.toUpperCase() === 'R' ? 1 : 0, sideFmtLR,
        val => {
          const side = val ? 'R' : 'L';
          const np = CATALOG.find(q => q.kind === 'conn' && q.leaf &&
            q.leaf.flower === p.leaf.flower && q.leaf.variant === p.leaf.variant &&
            q.leaf.side.toUpperCase() === side);
          if (np) { st.v = np.id; replaceChain(selectedSlot); saveState(); }
        }).row);
      body.appendChild(ctlRow('Rotation', 0, 355, 5, st.s, deg => `${deg}°`,
        val => { st.s = val; replaceChain(selectedSlot); saveState(); }).row);
    } else if (st.k === 'end') {
      /* Flower: blooming %; both end types get rotation */
      if (byId[st.v]?.anime) {
        const bloomRow = document.createElement('div');
        bloomRow.className = 'spin-row';
        bloomRow.innerHTML = `<label>Blooming</label><input type="range" min="0" max="100" step="1" value="${Math.round((st.b ?? 1) * 100)}"><output>${Math.round((st.b ?? 1) * 100)}%</output>`;
        const br = bloomRow.querySelector('input');
        const bo = bloomRow.querySelector('output');
        bloomRowRefs.set(`${selectedSlot}:${i}`, { input: br, output: bo });
        br.oninput = () => {
          bo.textContent = `${br.value}%`;
          const entry = flowerMixers.find(e => e.slotIdx === selectedSlot && e.stepIndex === i);
          if (entry) setFlowerBloom(entry, +br.value / 100);
          saveState();
        };
        body.appendChild(bloomRow);
      }
      body.appendChild(ctlRow('Rotation', 0, 355, 5, st.s, deg => `${deg}°`,
        val => { st.s = val; replaceChain(selectedSlot); saveState(); }).row);
    }

    tree.appendChild(row);
  });
  if (steps.length && chainDone(steps) === 'warn') {
    const tip = document.createElement('p');
    tip.className = 'hint';
    tip.textContent = 'Chain incomplete: the stem head is still open.';
    tree.appendChild(tip);
  }
}

function renderBuilder() {
  renderChainTree();
  renderNextPicker();
}

function addStep(stepIndex, step) {
  const steps = state.slots[selectedSlot] || [];
  steps.length = stepIndex; // 一定加在鏈尾
  steps.push(step);
  state.slots[selectedSlot] = steps;
  saveState();
  rebuildFull();
}

function removeStepFrom(i) {
  state.slots[selectedSlot].length = i;
  if (!state.slots[selectedSlot].length) state.slots[selectedSlot] = [];
  saveState();
  rebuildFull();
  renderBuilder();
}

/* ---------------- 頂部按鈕 ---------------- */
$('#btnRotate').onclick = () => {
  controls.autoRotate = !controls.autoRotate;
  $('#btnRotate').setAttribute('aria-pressed', controls.autoRotate);
  if (controls.autoRotate) {
    // 繞組裝本體的中心軸旋轉,外圈(地面圓)不會晃
    const box = new THREE.Box3().setFromObject(assembly);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    camGoal.target.set(c.x, controls.target.y, c.z);
    camGoal.frames = 110;
  } else {
    frameAssembly(); // 關閉時恢復原本構圖
  }
};

/* ---------------- 截圖 / GIF ---------------- */
/* 以組裝本體的外接框投影到螢幕,加邊距後回傳裁切區 */
function computeCrop() {
  renderer.render(scene, camera);
  const box = new THREE.Box3().setFromObject(assembly);
  const v = new THREE.Vector3();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(camera);
    const px = (v.x * 0.5 + 0.5) * canvas.width;
    const py = (-v.y * 0.5 + 0.5) * canvas.height;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  const pad = Math.max(16, Math.min(maxX - minX, maxY - minY) * 0.05);
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(canvas.width, maxX + pad); maxY = Math.min(canvas.height, maxY + pad);
  return {
    sx: Math.round(minX), sy: Math.round(minY),
    cw: Math.max(1, Math.round(maxX - minX)), ch: Math.max(1, Math.round(maxY - minY)),
  };
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* 匯出時提高解析度:只放大 WebGL 繪製緩衝,#stage 的 CSS 尺寸不變,畫面外觀不受影響 */
async function withExportResolution(fn) {
  const pr = renderer.getPixelRatio();
  renderer.setPixelRatio(pr * 2); // 匯出解析度 = 螢幕的 2 倍
  renderer.setSize(innerWidth, innerHeight, false);
  try { return await fn(); } finally {
    renderer.setPixelRatio(pr);
    renderer.setSize(innerWidth, innerHeight, false);
  }
}

function shootPng() {
  withExportResolution(() => {
    const { sx, sy, cw, ch } = computeCrop();
    const c2 = document.createElement('canvas');
    c2.width = cw; c2.height = ch;
    c2.getContext('2d').drawImage(canvas, sx, sy, cw, ch, 0, 0, cw, ch);
    c2.toBlob(blob => {
      downloadBlob(blob, 'mechanical-floral.png');
      toast(`PNG downloaded (${cw}×${ch}).`);
    });
  });
}

/* 360° 迴轉 GIF:鏡頭繞組裝中心軸旋轉一圈,花保持當下狀態 */
async function shootGifOn(progress) {
  progress.textContent = 'Capturing frames…';
  const wasAuto = controls.autoRotate;
  controls.autoRotate = false;
  const box = new THREE.Box3().setFromObject(assembly);
  const c = box.getCenter(new THREE.Vector3());
  const camStart = camera.position.clone();
  const tgtStart = controls.target.clone();
  const look = new THREE.Vector3(c.x, tgtStart.y, c.z);
  const a0 = Math.atan2(camStart.z - c.z, camStart.x - c.x);
  const radius = Math.hypot(camStart.x - c.x, camStart.z - c.z);
  const frames = 80, fps = 8; // 80 幀 × 125ms = 10s 一圈
  const pose = angle => {
    camera.position.set(
      c.x + radius * Math.cos(a0 + angle), camStart.y, c.z + radius * Math.sin(a0 + angle)
    );
    camera.lookAt(look);
  };

  let crop;
  await withExportResolution(async () => {
    pose(0);
    crop = computeCrop(); // 在第 0 幀視角量裁切區
    const { sx, sy, cw, ch } = crop;
    const c2 = document.createElement('canvas');
    c2.width = cw; c2.height = ch;
    const ctx = c2.getContext('2d');
    const gif = new GIF({ workers: 2, quality: 8, width: cw, height: ch, workerScript: 'gif.worker.js' });
    for (let i = 0; i < frames; i++) {
      pose((i / frames) * Math.PI * 2);
      renderer.render(scene, camera);
      ctx.drawImage(canvas, sx, sy, cw, ch, 0, 0, cw, ch);
      gif.addFrame(ctx, { copy: true, delay: Math.round(1000 / fps) });
      if (i % 6 === 0) {
        progress.textContent = `Capturing ${i + 1}/${frames}…`;
        await new Promise(r => setTimeout(r, 0));
      }
    }
    camera.position.copy(camStart);
    controls.target.copy(tgtStart);
    controls.update();
    if (wasAuto) controls.autoRotate = true;
    progress.textContent = 'Encoding GIF…';
    await new Promise(resolve => {
      gif.on('finished', blob => {
        downloadBlob(blob, 'mechanical-floral.gif');
        resolve();
      });
      gif.render();
    });
  });
  progress.textContent = 'GIF downloaded.';
}

const btnShot = $('#btnShot');
btnShot.onclick = () => { $('#shootModal').hidden = false; };
$('#btnShotClose').onclick = () => { $('#shootModal').hidden = true; };
$('#shootModal').addEventListener('click', ev => { if (ev.target.id === 'shootModal') $('#shootModal').hidden = true; });
$('#btnShotPng').onclick = () => shootPng();
$('#btnShotGif').onclick = () => shootGifOn($('#shootProgress'));

$('#btnShare').onclick = () => {
  state.pot && saveState();
  history.replaceState(null, '', '#' + encodeState({ pot: state.pot, slots: state.slots }));
  navigator.clipboard?.writeText(location.href).then(() => toast('Share link copied.'), () => toast('URL updated — copy it from the address bar.'));
};

$('#btnRule').onclick = () => { $('#ruleModal').hidden = false; };
$('#btnRings').onclick = () => {
  ringsVisible = !ringsVisible;
  slotMarkers.visible = ringsVisible;
  $('#btnRings').setAttribute('aria-pressed', String(!ringsVisible)); // icon 由 aria-pressed 驅動 CSS 切換
  if (!ringsVisible) { hoveredSlot = -1; hoveredPiece = null; hideSpecimen(); }
};
$('#btnRuleClose').onclick = () => { $('#ruleModal').hidden = true; };
$('#ruleModal').addEventListener('click', ev => { if (ev.target.id === 'ruleModal') $('#ruleModal').hidden = true; });

/* Used-parts modal: aggregate pieces across all chains */
function renderPartsList() {
  const list = $('#partsList');
  list.innerHTML = '';
  const counts = new Map();
  (state.slots || []).forEach(steps => {
    if (!Array.isArray(steps)) return;
    steps.forEach(st => { if (st?.v) counts.set(st.v, (counts.get(st.v) || 0) + 1); });
  });
  const KIND_ORDER = { pot: 0, stem: 1, conn: 2, end: 3 };
  const used = CATALOG.filter(p => (p.kind === 'pot' && p.id === state.pot) || counts.has(p.id));
  used.sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || pieceDisplayName(a).localeCompare(pieceDisplayName(b)));
  used.forEach(p => {
    const n = p.kind === 'pot' ? 1 : counts.get(p.id);
    const row = document.createElement('div');
    row.className = 'parts-row';
    const img = document.createElement('img');
    img.className = 'thumb';
    img.src = piecePreviews[p.id] || '';
    img.alt = pieceDisplayName(p);
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = pieceDisplayName(p);
    const count = document.createElement('span');
    count.className = 'pcount';
    count.textContent = `× ${n}`;
    row.append(img, name, count);
    list.appendChild(row);
  });
  if (!used.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Nothing assembled yet.';
    list.appendChild(p);
  }
}
$('#btnParts').onclick = () => { renderPartsList(); $('#partsModal').hidden = false; };
$('#btnPartsClose').onclick = () => { $('#partsModal').hidden = true; };
$('#partsModal').addEventListener('click', ev => { if (ev.target.id === 'partsModal') $('#partsModal').hidden = true; });
addEventListener('keydown', ev => {
  if (ev.key === 'Escape') {
    $('#ruleModal').hidden = true;
    $('#partsModal').hidden = true;
    $('#shootModal').hidden = true;
    closePieceMenu();
  }
});

/* 花朵開闔:組裝列內單朵播放 */

/* 單朵播放按鈕 */
function toggleFlowerPlay(slotIdx, stepIndex) {
  const entry = flowerMixers.find(e => e.slotIdx === slotIdx && e.stepIndex === stepIndex);
  if (!entry) return;
  entry.playing = !entry.playing;
  entry.t = 0;
  updatePlayUI();
}

/* ---------------- 啟動 ---------------- */
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  positionPanelToggle();
});

let pulseT = 0;
let lastLoopT = performance.now();
function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min((now - lastLoopT) / 1000, 0.1);
  lastLoopT = now;
  pulseT += dt;
  // 各自播放中的花獨立推進(與全域播放共用同一套 entry.playing 機制)
  if (flowerMixers.some(e => e.playing)) {
    for (const e of flowerMixers) {
      if (e.playing) {
        e.t += dt;
        const phase = (1 - Math.cos((e.t / BLOOM_CYCLE) * Math.PI * 2)) / 2; // 0→1→0 往返
        setFlowerBloom(e, phase);
      }
    }
  }
  if (camGoal.frames > 0) {
    camGoal.frames--;
    controls.target.lerp(camGoal.target, 0.06);
    const dir = camera.position.clone().sub(controls.target).normalize();
    const dist = camera.position.distanceTo(controls.target);
    const want = dist + (camGoal.dist - dist) * 0.06;
    camera.position.copy(controls.target).addScaledVector(dir, want);
  }
  slotMarkers.children.forEach(r => {
    if (!state.slots[r.userData.slotIdx]?.length) {
      const base = r.userData.slotIdx === hoveredSlot ? 1.0 : 0.55;
      r.material.emissiveIntensity = r.userData.slotIdx === hoveredSlot
        ? 1.0
        : base + Math.sin(pulseT * 2.4 + r.userData.slotIdx) * 0.18;
    }
    const target = r.userData.slotIdx === hoveredSlot ? 1.45 : 1;
    r.scale.setScalar(r.scale.x + (target - r.scale.x) * 0.2);
  });
  controls.update();
  renderer.render(scene, camera);
}

(async function init() {
  const fill = $('#loadingFill');
  const msg = $('#loadingMsg');
  await detectModelMode();
  await loadAll((done, total, id) => {
    fill.style.width = `${(done / total) * 100}%`;
    msg.textContent = `Loading parts ${done}/${total} — ${id}`;
  });
  makePiecePreviews();
  await initBVH();
  loadState();
  migrateSlots();
  /* 還原上次使用的 design 槽 */
  const ad = parseInt(localStorage.getItem('mechanical-floral-design-active') || '-1', 10);
  if (ad >= 0 && ad < DESIGN_COUNT) activeDesign = ad;
  renderDesignRow();
  if (!state.pot) state.pot = 'pot_1';
  if (!Array.isArray(state.slots)) state.slots = [];
  rebuild();
  renderPotSelect();
  renderSlotRow();
  positionPanelToggle();
  loop();
  setTimeout(() => { $('#loading').classList.add('done'); }, 250);
  controls.update();
})();
