/**
 * Terrace house viewer.
 *
 * Loads house.glb — a two-bedroom mid-terrace cottage, modelled
 * parametrically and exported with flat materials — and draws it in the
 * browser at sixty frames a second.
 *
 * This file is published to a public repository as part of the built
 * site, so keep it free of anything identifying the building.
 *
 * The CAD stage splits every material group by storey (split_storeys) and
 * at the plot boundary (split_plot), and those arrive here as glTF node
 * names of the form "<material>__<storey>[__context]". That naming is the
 * whole contract between the two stages: nothing here knows a dimension
 * of this house. Heights that look like dimensions — where a floor is,
 * where to cut a plan — are asked of the geometry with a raycast.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { collectColliders, groundBelow } from './collision.js';
import { daylight } from './daylight.js';
import { WalkMode } from './walk.js';
import { SectionPlane } from './section.js';
import { FurnitureLayer, CATALOGUE, exportLayout, importLayout } from './furniture.js';

const STOREYS = ['ground', 'first', 'roof'];
// The storeys a plan can be a plan of. The roof is a covering, not a
// floor you stand on, and a plan view turns it off.
const LEVELS = ['ground', 'first'];

// The neighbours' share of every terrace-wide element carries a
// "__context" suffix on the same <material>__<storey> name: their
// windows, their half of the roof, their length of the lintel band (see
// cad/house.split_plot). Before that split existed, hiding the
// neighbours left a row of windows in mid-air. Blender can append a
// ".001" when it disambiguates a name, so match the suffix loosely.
const CONTEXT_SUFFIX = /__context(\.\d+)?$/;

// Boundary treatment, not building: excluded when working out what the
// plan view should fill the screen with.
const FRAMING_EXCLUDES = new Set(['timber_fence']);

// The deck group, which wins a tie against anything set flush with it
// (separateCoplanarFaces). Named the same as collision.js's
// FLOOR_MATERIAL, and for the same reason: the CAD keeps decks apart
// from ceilings so this question has one answer.
const FLOOR_GROUP = 'floor';

// Metres above the floor the plan is cut at. The same height
// cad/drawings.py cuts its plans, so the viewer and the review PDF are
// drawings of the same section.
const PLAN_CUT = 1.10;

const state = {
  shown: new Set(STOREYS),
  shownBeforePlan: null,
  level: 'ground',  // which storey the plan is of
  context: true,
  plan: false,
  walk: false,
  furnitureMode: false,
  groups: {},       // storey -> [Object3D]
  contextNodes: [],
  building: [],     // everything the plan view should frame on
};

let colliders = null; // { walls, ceilings, floors, walkable } — built once the model loads
let walkMode = null;
let furniture = null;
let section = null;
let houseMaterials = [];
const clock = new THREE.Clock();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc8d2dd);

// stencil defaults to false since r163, and the plan view's cut faces
// are drawn with the stencil buffer (see section.js) — without it every
// cap quad passes its test and fills the screen.
const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// Two cameras rather than one that gets reconfigured: a plan view wants
// an orthographic projection (parallel rays, so a room's walls stay the
// same thickness wherever it sits in frame, which is the whole point of
// a plan) and the 3D view wants perspective.
// The far planes are fitted to the model once it loads (frameModel). The
// near one is set here and stays: 0.2 m is under the walker's own 0.28 m
// clearance from a wall, so nothing gets clipped by leaning on one.
const perspective = new THREE.PerspectiveCamera(50, 1, 0.2, 500);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -200, 400);

let controls = null;
let frame = { centre: new THREE.Vector3(), size: 20 };

function lighting() {
  // A rasteriser cannot bounce light, so the sky/ground hemisphere stands
  // in for everything the sun does not hit directly. Without it the north
  // elevation and every interior read as flat black.
  //
  // It is deliberately weaker than it was, and its ground colour lighter.
  // A hemisphere light shades from the normal's up component alone, so
  // turned up far enough to light the interior on its own it gives every
  // wall in the house the same value and every ceiling the ground
  // colour, which was the darkest thing in the scene. Most of the
  // interior light now comes through the windows instead (daylight.js),
  // and this is the fill behind it.
  scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x9a9384, 1.15));

  // Left where it was, on purpose. Physically it is on the wrong side —
  // this garden faces south, so a real sun would rake the garden
  // elevation and leave the street one in shade, which is what the
  // Blender views do. But the Blender views get a sun each, and this one
  // has to serve every angle you might swing the camera to: put it in
  // the south-west and the elevation you arrive at goes flat and dark.
  // The interior, which is what the change of lighting was for, is lit
  // through the windows either way (daylight.js).
  const sun = new THREE.DirectionalLight(0xfff4e2, 2.2);
  sun.position.set(-18, 26, 14);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const d = 22;
  Object.assign(sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1, far: 90 });
  scene.add(sun);
}

function sortNodes(root) {
  for (const storey of STOREYS) state.groups[storey] = [];

  root.traverse((node) => {
    if (!node.isMesh) return;
    node.castShadow = true;
    node.receiveShadow = true;

    // Names come from the STL filenames the CAD stage wrote. Blender can
    // append a .001 suffix when it disambiguates, so match a prefix
    // rather than requiring the name to end at the storey.
    const [material, rest] = node.name.split('__');
    const storey = STOREYS.find((s) => rest && rest.startsWith(s));
    if (storey) state.groups[storey].push(node);
    const isContext = CONTEXT_SUFFIX.test(node.name);
    if (isContext) state.contextNodes.push(node);
    // The garden runs sixteen metres south, so framing on it shrinks the
    // house to a thumbnail. The plan frames on our own building only.
    if (!isContext && !FRAMING_EXCLUDES.has(material)) state.building.push(node);
  });
}

function applyVisibility() {
  for (const storey of STOREYS) {
    const on = state.shown.has(storey);
    for (const node of state.groups[storey]) node.visible = on;
  }
  // Context is a second, independent switch: hiding the neighbours must
  // not bring back a storey the user turned off.
  if (!state.context) for (const node of state.contextNodes) node.visible = false;
  if (furniture) furniture.setVisibleStoreys(state.shown);
  if (section) section.update();
  // Deliberately does not reframe. Reframing on every visibility change
  // throws away a pan and a zoom the user has just made; the plan is
  // refitted where it changes what it is a plan of (setPlanLevel) and on
  // a resize.
  render();
}

// Which of ground/first is currently shown — the storey furniture is
// placed on and filtered by.
function currentStorey() {
  return STOREYS.find((s) => s !== 'roof' && state.shown.has(s)) || 'ground';
}

function syncStoreyChecks() {
  for (const storey of STOREYS) {
    const box = document.getElementById(`storey-${storey}`);
    if (box) box.checked = state.shown.has(storey);
  }
}


/**
 * What the plan is a plan of: the floor deck of the storey, and nothing
 * else. `margin` below then takes in the walls around it.
 *
 * Not everything on screen, which is what this used to do. The storey
 * split is by height, so the outhouse — one storey, but with gables
 * reaching above the main house's first-floor level — lands partly in
 * the "first" band, and it shares a mesh with the chimney stacks, so it
 * cannot be told apart node by node. Framing on that stretches the
 * first-floor plan to the length of the whole plot and leaves the rooms
 * at half size in the middle.
 */
function planBox() {
  const box = new THREE.Box3();
  let any = false;
  for (const node of colliders.floors) {
    if (!node.visible || !node.name.includes(`__${state.level}`)) continue;
    box.expandByObject(node);
    any = true;
  }
  return any ? box : null;
}

function fitPlan() {
  const box = planBox();
  if (!box) return;

  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const margin = 1.12;

  const aspect = window.innerWidth / window.innerHeight;
  // ortho.up is -Z, so the screen's vertical axis is the model's z.
  const halfHeight = Math.max(size.z, size.x / aspect) * 0.5 * margin;
  ortho.top = halfHeight;
  ortho.bottom = -halfHeight;
  ortho.left = -halfHeight * aspect;
  ortho.right = halfHeight * aspect;
  ortho.position.set(centre.x, box.max.y + frame.size, centre.z);
  ortho.lookAt(centre.x, centre.y, centre.z);
  ortho.updateProjectionMatrix();
  if (controls && state.plan) controls.target.set(centre.x, centre.y, centre.z);
}

/**
 * Show a plan of one storey. A plan of the ground floor with the first
 * floor over it is a plan of the first floor, so the level is exclusive:
 * this is the control that moves you between them.
 */
function setPlanLevel(level) {
  state.level = level;
  state.shown = new Set([level]);
  syncStoreyChecks();
  updateLevelUI();
  // Order matters: visibility, then the cut height, then the frame. The
  // frame is worked out from what the cut passes through, so fitting
  // before moving the cut fits the floor you have just left.
  applyVisibility();
  updateCut();
  fitPlan();
  render();
}

function updateCut() {
  if (!section) return;
  section.setHeight(storeyFloorY(state.level) + PLAN_CUT);
}

function updateLevelUI() {
  const row = document.getElementById('level-row');
  if (!row) return;
  row.hidden = !state.plan;
  const i = LEVELS.indexOf(state.level);
  document.getElementById('level-name').textContent = `${state.level} floor`;
  document.getElementById('level-down').disabled = i <= 0;
  document.getElementById('level-up').disabled = i >= LEVELS.length - 1;
}

/**
 * Give every material of the house its own depth bias.
 *
 * Where two pieces finish flush — the lintel band against the render it
 * runs across, a floor deck dying into the wall that carries it — the CAD
 * stage hands the viewer two faces at exactly the same depth. Neither
 * wins the depth test, so the pixel goes to whichever was drawn last; and
 * draw order is sorted by distance from the camera, so it changes as the
 * view moves and the join flickers between the two colours. In a still it
 * looks like banding, which is how it was reported.
 *
 * Depth precision does not fix this. The two depths are equal, not close,
 * so there is no buffer fine enough to tell them apart. What fixes it is
 * removing the tie: one offset per material, assigned in a stable order so
 * it is the same every frame and the same on every reload. The unit is a
 * depth-buffer step rather than a metre, so a dozen materials apart is
 * still far under a millimetre of geometry — nothing moves, the join just
 * stops arguing with itself.
 */
function separateCoplanarFaces(root) {
  // Grouped by the CAD stage's material key, read off the node name —
  // the same "<material>__<storey>" contract collision.js reads. Not off
  // material.name: the Blender stage names materials for people ("Black
  // stained timber", "Waxed pine", "Floor structure"), so sorting on that
  // gives an order with no relation to the groups, which is deterministic
  // but cannot be reasoned about or given an exception.
  const byGroup = new Map();
  root.traverse((node) => {
    if (!node.isMesh || !node.material) return;
    const key = node.name.split('__')[0];
    if (!byGroup.has(key)) byGroup.set(key, new Set());
    byGroup.get(key).add(node.material);
    // Everything loaded, not just what the plan frames on: the fence is
    // left out of the framing and still meets the paving it stands in.
  });

  const keys = [...byGroup.keys()].sort();
  for (const [key, materials] of byGroup) {
    // A rung each, and the deck gets one above the top of the ladder.
    // Which piece wins a tie is otherwise arbitrary, and arbitrary was
    // wrong in a way you could see: the CAD sets the landing balustrade's
    // feet at FF_LEVEL on a deck whose top face is also FF_LEVEL
    // (interior.py's landing_balustrade against shell.py's floors), and
    // where the timber won that tie it read as coming up through the
    // floor along the banister. A deck is the surface you stand on and
    // look at, so it takes the tie and the piece reads as sitting on it.
    const rung = key === FLOOR_GROUP ? keys.length + 1 : keys.indexOf(key) + 1;
    for (const material of materials) {
      material.polygonOffset = true;
      material.polygonOffsetFactor = 0;
      material.polygonOffsetUnits = -rung;
      material.needsUpdate = true;
    }
  }
}

function frameModel(root) {
  const box = new THREE.Box3().setFromObject(root);
  box.getCenter(frame.centre);
  frame.size = Math.max(...box.getSize(new THREE.Vector3()).toArray());

  perspective.position.set(
    frame.centre.x + frame.size * 0.75,
    frame.centre.y + frame.size * 0.55,
    frame.centre.z + frame.size * 0.95,
  );
  // Both ranges now bracket the model rather than the horizon, which is
  // the other half of the banding: depth precision is spent across the
  // span between the planes, and 0.1–500 m spent nearly all of it on
  // empty air. The far planes still take in the ground, which is six
  // model-widths across, so nothing is clipped that was drawn before.
  perspective.far = frame.size * 12;
  perspective.updateProjectionMatrix();

  ortho.position.set(frame.centre.x, frame.centre.y + frame.size, frame.centre.z);
  ortho.up.set(0, 0, -1); // look down the model's length, street at the bottom
  ortho.near = -frame.size;
  ortho.far = frame.size * 4;
  ortho.lookAt(frame.centre);
  ortho.updateProjectionMatrix();

  addGround(box);
}

function addGround(box) {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(frame.size * 6, frame.size * 6),
    new THREE.MeshStandardMaterial({ color: 0x5d6b4a, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(frame.centre.x, box.min.y - 0.01, frame.centre.z);
  ground.receiveShadow = true;
  ground.name = 'ground_plane';
  scene.add(ground);
}

/**
 * Where a storey's floor actually is.
 *
 * Asked of the geometry at one point rather than taken as a box round
 * the storey's slabs: a box has its top wherever the highest of them is,
 * which for the ground floor is the outhouse's roof deck — and, before
 * the CAD stage separated decks from ceilings, was the kitchen's ceiling
 * at 2.25 m, which is where furniture was being dropped.
 */
function storeyFloorY(storey) {
  const decks = colliders.floors.filter((node) => node.name.includes(`__${storey}`));
  if (!decks.length) return 0;
  const box = new THREE.Box3();
  for (const node of decks) box.expandByObject(node);
  const centre = box.getCenter(new THREE.Vector3());
  const span = box.max.y - box.min.y + 1;
  return groundBelow(centre.x, centre.z, box.max.y, decks, 0.05, span, box.max.y);
}

// Which storey's floor furniture should sit on.
function currentFloorY() {
  return storeyFloorY(currentStorey());
}

/**
 * Somewhere sensible to stand. The centre of the *whole* model is the
 * middle of a sixteen-metre garden — which is where walk mode used to
 * start you, outside the house with no floor under your feet. Our own
 * building, with the fence and the neighbours left out, centres on the
 * Sitting/Dining room instead, and the ground floor is the storey to
 * arrive on.
 */
function spawnPoint() {
  const box = new THREE.Box3();
  for (const node of state.building) box.expandByObject(node);
  const centre = box.getCenter(new THREE.Vector3());
  return new THREE.Vector3(centre.x, storeyFloorY('ground') + 1.0, centre.z);
}

function activeCamera() {
  return state.plan ? ortho : perspective;
}

function setControls() {
  if (controls) controls.dispose();
  controls = new OrbitControls(activeCamera(), renderer.domElement);
  controls.target.copy(frame.centre);
  controls.enableDamping = true;
  // Rotating a plan view turns it into an awkward oblique; pan and zoom
  // are what you actually want there.
  controls.enableRotate = !state.plan;
  controls.maxPolarAngle = Math.PI * 0.495; // don't drop below the ground
  controls.enabled = !state.walk;
  controls.update();
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);

  perspective.aspect = w / h;
  perspective.updateProjectionMatrix();

  if (state.plan) fitPlan();
  render();
}

function render() {
  renderer.render(scene, activeCamera());
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (state.walk && walkMode) walkMode.update(dt);
  else if (controls) controls.update();
  render();
}

function buildUI() {
  const panel = document.getElementById('panel');

  // Picking storeys and choosing a plan's level are the same decision
  // asked two ways, and the tick boxes are the way that can be answered
  // nonsensically — "ground and first at once" is not a plan of anything.
  // So the whole group stands down in plan view and the level stepper
  // below is the only control (see updateModeUI).
  const storeyRows = document.createElement('div');
  storeyRows.id = 'storey-rows';
  for (const storey of STOREYS) {
    const id = `storey-${storey}`;
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" id="${id}" checked> ${storey}`;
    storeyRows.appendChild(label);
    label.querySelector('input').addEventListener('change', (e) => {
      e.target.checked ? state.shown.add(storey) : state.shown.delete(storey);
      applyVisibility();
    });
  }
  panel.appendChild(storeyRows);

  // Not part of that group: a terrace's neighbours are context in a plan
  // as much as in the 3D view — the party walls are half the drawing — so
  // this switch stays wherever you are.
  const ctx = document.createElement('label');
  ctx.innerHTML = '<input type="checkbox" id="ctx" checked> neighbours';
  panel.appendChild(ctx);
  ctx.querySelector('input').addEventListener('change', (e) => {
    state.context = e.target.checked;
    applyVisibility();
  });

  const plan = document.createElement('button');
  plan.id = 'plan-toggle';
  plan.textContent = 'Plan view';
  plan.addEventListener('click', () => setPlanMode(!state.plan));
  panel.appendChild(plan);

  // Moving between floors in a plan. Three independent tick boxes can
  // express "ground and first at once", which is not a plan of anything,
  // so the plan gets its own exclusive control.
  const levelRow = document.createElement('div');
  levelRow.id = 'level-row';
  levelRow.hidden = true;
  levelRow.innerHTML = `
    <div class="section-label">Level</div>
    <div class="row">
      <button id="level-down">▼</button>
      <span id="level-name" class="level-name"></span>
      <button id="level-up">▲</button>
    </div>`;
  levelRow.querySelector('#level-down').addEventListener('click', () => {
    setPlanLevel(LEVELS[Math.max(0, LEVELS.indexOf(state.level) - 1)]);
  });
  levelRow.querySelector('#level-up').addEventListener('click', () => {
    setPlanLevel(LEVELS[Math.min(LEVELS.length - 1, LEVELS.indexOf(state.level) + 1)]);
  });
  panel.appendChild(levelRow);

  const walk = document.createElement('button');
  walk.textContent = 'Walk mode';
  walk.addEventListener('click', () => enterWalkMode());
  panel.appendChild(walk);

  buildFurnitureDrawer();
  updateModeUI();
}

/** Show only the controls that mean something where you currently are. */
function updateModeUI() {
  const storeyRows = document.getElementById('storey-rows');
  if (storeyRows) storeyRows.hidden = state.plan;

  // Walk mode has its own HUD and its own way out. Leaving the panel up
  // put "Plan view" a thumb's width from someone who was walking, and
  // that set a plan up over a walk mode still running underneath it: the
  // two then took it in turns and the 3D view could not be reached at all.
  const panel = document.getElementById('panel');
  if (panel) panel.hidden = state.walk;

  // Furniture is placed in the plan and nowhere else, so the drawer is
  // not merely disabled outside it — it is not there.
  const drawer = document.getElementById('furniture-panel');
  if (drawer) drawer.hidden = !state.plan;

  updateLevelUI();
}

function setPlanMode(on) {
  // Walking and reading a plan are alternatives, not a stack. Left live
  // underneath, walk mode goes on consuming the pointer and moving the
  // perspective camera while the plan is on screen, and the only mode you
  // can reach from there is the other one.
  if (state.walk) exitWalkMode();
  if (state.plan === on) return;
  if (on) state.shownBeforePlan = new Set(state.shown);
  state.plan = on;
  document.getElementById('plan-toggle').textContent = on ? '3D view' : 'Plan view';

  if (on) {
    setPlanLevel(state.level);
  } else {
    setFurnitureMode(false);
    // Back to whatever was on screen before, rather than the one storey
    // the plan narrowed it to.
    state.shown = state.shownBeforePlan || new Set(STOREYS);
    syncStoreyChecks();
    applyVisibility();
  }
  section.setEnabled(on, houseMaterials);
  updateModeUI();
  setControls();
  furniture.setEnabled(on && state.furnitureMode);
  resize();
}

function enterWalkMode() {
  setPlanMode(false);
  state.walk = true;
  setFurnitureMode(false);
  furniture.setEnabled(false);
  // A half-shown house is not something to walk round, and the stair
  // leads nowhere unless the storey above it is there.
  state.shown = new Set(STOREYS);
  syncStoreyChecks();
  applyVisibility();
  updateModeUI();
  setControls();
  walkMode.enter(spawnPoint());
  resize();
}

function exitWalkMode() {
  if (!state.walk) return;
  state.walk = false;
  walkMode.exit();

  // Stand the 3D view back up round where you were, which takes a target
  // *and* somewhere to look at it from. Copying the walker's position
  // into both — which is what this did — leaves OrbitControls with an
  // orbit of radius zero: there is no direction from camera to target, so
  // there is nothing to rotate about, nothing to zoom along and nothing
  // to pan across. The view then looks frozen however you drag it, and
  // walk mode reads as a door that only opens one way.
  const forward = new THREE.Vector3();
  perspective.getWorldDirection(forward);
  forward.y = 0;
  if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1);
  forward.normalize();

  const radius = Math.max(frame.size * 0.6, 6);
  frame.centre.copy(walkMode.position);
  perspective.position
    .copy(walkMode.position)
    .addScaledVector(forward, -radius)
    .setY(walkMode.position.y + radius * 0.45);

  updateModeUI();
  setControls();
  resize();
}

/** Open or shut the furniture drawer. Shut, the plan is just a plan: a
 * drag pans it rather than picking a sofa up. */
function setFurnitureMode(on) {
  state.furnitureMode = on;
  const drawer = document.getElementById('furniture-panel');
  if (drawer) drawer.classList.toggle('open', on);
  const body = document.getElementById('furniture-body');
  if (body) body.hidden = !on;
  const tab = document.getElementById('furniture-tab');
  if (tab) tab.setAttribute('aria-expanded', String(on));
  furniture.setEnabled(state.plan && on);
}

function selectedToolbar(item) {
  const bar = document.getElementById('furniture-selected');
  if (!bar) return;
  bar.hidden = !item;
  if (item) bar.querySelector('.name').textContent = item.spec.label;
}

/**
 * The furniture drawer: its own box on the right-hand edge of the plan,
 * opened by the tab that is all you see of it when it is shut.
 *
 * Off the mode panel entirely, because it is only ever a plan-view tool
 * and it is the one control you want out of the way of the thing you are
 * arranging.
 */
function buildFurnitureDrawer() {
  const drawer = document.getElementById('furniture-body');
  document.getElementById('furniture-tab')
    .addEventListener('click', () => setFurnitureMode(!state.furnitureMode));

  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = 'Add furniture';
  drawer.appendChild(label);

  const select = document.createElement('select');
  for (const item of CATALOGUE) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = `${item.label} (${item.w}×${item.d} m)`;
    select.appendChild(opt);
  }
  drawer.appendChild(select);

  const add = document.createElement('button');
  add.textContent = 'Add to the middle of the view';
  add.addEventListener('click', () => {
    // Where the plan camera is looking, which follows a pan — not the
    // centre of the whole model, which is halfway down the garden.
    furniture.addFromCatalogue(select.value, ortho.position.x, ortho.position.z, currentStorey());
  });
  drawer.appendChild(add);

  const selectedBar = document.createElement('div');
  selectedBar.id = 'furniture-selected';
  selectedBar.hidden = true;
  selectedBar.innerHTML = `
    <div class="name" style="font-size:12px;color:#556;margin-top:2px;"></div>
    <div class="row">
      <button data-act="rotate-left">⟲ 15°</button>
      <button data-act="rotate-right">15° ⟳</button>
      <button data-act="delete">Delete</button>
    </div>`;
  selectedBar.addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (!act || !furniture.selected) return;
    if (act === 'rotate-left') furniture.rotateSelected(-Math.PI / 12);
    if (act === 'rotate-right') furniture.rotateSelected(Math.PI / 12);
    if (act === 'delete') furniture.remove(furniture.selected);
  });
  drawer.appendChild(selectedBar);

  const ioRow = document.createElement('div');
  ioRow.className = 'row';
  const exportBtn = document.createElement('button');
  exportBtn.textContent = 'Export layout';
  exportBtn.addEventListener('click', () => exportLayout(furniture.serialize()));
  const importBtn = document.createElement('button');
  importBtn.textContent = 'Import layout';
  importBtn.addEventListener('click', () => document.getElementById('import-file').click());
  ioRow.append(exportBtn, importBtn);
  drawer.appendChild(ioRow);

  document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      furniture.replaceAll(await importLayout(file));
    } catch (err) {
      fail(`Could not import layout: ${err.message || err}`);
    }
  });
}

function fail(message) {
  // #status is removed once the model has loaded; after that, a failure
  // (e.g. a bad imported layout file) gets a transient toast instead.
  const status = document.getElementById('status');
  if (status) {
    status.textContent = message;
    status.className = 'error';
    return;
  }
  const toast = document.createElement('div');
  toast.id = 'status';
  toast.className = 'error';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// MODEL_URL is rewritten by viewer/package.py to a data: URI in the
// single-file build, because Safari refuses to fetch a sibling file when
// the page itself was opened from disk.
const MODEL_URL = window.__HOUSE_GLB__ || 'house.glb';

lighting();
new GLTFLoader().load(
  MODEL_URL,
  (gltf) => {
    scene.add(gltf.scene);
    sortNodes(gltf.scene);
    frameModel(gltf.scene);
    colliders = collectColliders(gltf.scene);
    gltf.scene.updateMatrixWorld(true);

    // One light per window, found in the glazing itself. Filed under the
    // storey its window is in, so turning a storey off takes its daylight
    // with it — otherwise the ground floor stays lit by first-floor
    // windows that are no longer on screen.
    const centre = new THREE.Box3();
    for (const node of state.building) centre.expandByObject(node);
    for (const { light, storey } of daylight(
      scene, gltf.scene, centre.getCenter(new THREE.Vector3()), colliders.ceilings,
    )) {
      if (storey) state.groups[storey].push(light);
    }

    houseMaterials = [...new Set(
      state.building.concat(state.contextNodes).map((node) => node.material),
    )];
    separateCoplanarFaces(gltf.scene);
    section = new SectionPlane({ renderer, scene });
    section.build(
      state.building.concat(state.contextNodes),
      frame.size * 2,
      frame.centre,
    );

    walkMode = new WalkMode({
      colliders,
      camera: perspective,
      domElement: renderer.domElement,
      hud: {
        root: document.getElementById('walk-hud'),
        joystick: document.getElementById('joystick'),
        joystickKnob: document.querySelector('#joystick .knob'),
        headroom: document.getElementById('headroom'),
      },
    });
    document.getElementById('exit-walk').addEventListener('click', exitWalkMode);

    furniture = new FurnitureLayer({
      scene,
      camera: ortho,
      domElement: renderer.domElement,
      getWalls: () => colliders && colliders.walls,
      getFloorY: currentFloorY,
      onChange: selectedToolbar,
      setControlsEnabled: (on) => { if (controls) controls.enabled = on; },
    });
    furniture.setVisibleStoreys(state.shown);

    buildUI();
    setControls();
    resize();
    document.getElementById('status').remove();
    // A handle for driving the viewer headlessly, which is how the storey
    // split, the cut and the walk were checked (see AGENTS.md). Read-only
    // in spirit: nothing in the app reads it back.
    window.__viewer = { THREE, state, scene, renderer, ortho, perspective, frame, colliders,
                        section, walkMode, storeyFloorY, spawnPoint, activeCamera, render,
                        // `controls` is here so a headless run can aim the
                        // camera: OrbitControls rewrites the camera from
                        // its own target every frame, so setting
                        // camera.position alone is undone before the next
                        // paint.
                        get controls() { return controls; } };
    tick();
  },
  undefined,
  (err) => fail(`Could not load the model: ${err.message || err}`),
);

window.addEventListener('resize', resize);
