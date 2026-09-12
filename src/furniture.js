/**
 * Loose furniture: viewer *data*, never CAD geometry. A layout is a JSON
 * array of placed items (catalogue id, position, rotation) that lives in
 * localStorage and can be exported/imported as a file — the single-file
 * build has no server to save to, and a layout should be able to move
 * between the hosted build and the offline file.
 *
 * Placement happens in the plan view: a pointer's screen position is
 * raycast onto the ground plane at the current storey's floor height, so
 * dragging tracks the orthographic pan/zoom for free. Each piece is drawn
 * as a plain box at its real footprint — enough to judge whether it fits.
 */

import * as THREE from 'three';
import { nearestWall } from './collision.js';

export const CATALOGUE = [
  { id: 'sofa_2s', label: 'Sofa (2-seat)', w: 1.6, d: 0.85, h: 0.8, color: 0x7a6a53 },
  { id: 'sofa_3s', label: 'Sofa (3-seat)', w: 2.0, d: 0.9, h: 0.8, color: 0x7a6a53 },
  { id: 'armchair', label: 'Armchair', w: 0.8, d: 0.85, h: 0.85, color: 0x8a7a5f },
  { id: 'dining_table', label: 'Dining table (4)', w: 1.4, d: 0.8, h: 0.75, color: 0x9c7a4f },
  { id: 'dining_chair', label: 'Dining chair', w: 0.45, d: 0.5, h: 0.9, color: 0x9c7a4f },
  { id: 'kitchen_table', label: 'Small kitchen table', w: 0.9, d: 0.7, h: 0.75, color: 0x9c7a4f },
  { id: 'double_bed', label: 'Double bed', w: 1.5, d: 2.0, h: 0.6, color: 0xb9c6d6 },
  { id: 'single_bed', label: 'Single bed', w: 0.9, d: 1.9, h: 0.6, color: 0xb9c6d6 },
  { id: 'wardrobe', label: 'Wardrobe', w: 1.2, d: 0.6, h: 1.9, color: 0x5b4a38 },
  { id: 'chest_of_drawers', label: 'Chest of drawers', w: 0.8, d: 0.45, h: 0.9, color: 0x5b4a38 },
  { id: 'desk', label: 'Desk', w: 1.2, d: 0.6, h: 0.75, color: 0x9c7a4f },
  { id: 'bookcase', label: 'Bookcase', w: 0.9, d: 0.3, h: 1.8, color: 0x5b4a38 },
];

const CATALOGUE_BY_ID = Object.fromEntries(CATALOGUE.map((c) => [c.id, c]));

const STORAGE_KEY = 'terrace-house-viewer:furniture-layout:v1';
const SNAP_RANGE = 0.35; // metres a piece will reach out to find a wall
const SNAP_NUDGE = 0.02; // clearance left between a snapped piece and the wall face

let nextInstanceId = 1;

export function loadLayout() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const items = JSON.parse(raw);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

export function saveLayout(items) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Private browsing / storage full: the layout still exists in memory
    // and can be recovered with Export, so this is not fatal.
  }
}

export function exportLayout(items) {
  const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'furniture-layout.json';
  a.click();
  URL.revokeObjectURL(url);
}

export function importLayout(file) {
  return file.text().then((text) => {
    const items = JSON.parse(text);
    if (!Array.isArray(items)) throw new Error('not a layout file');
    return items.filter((it) => it && CATALOGUE_BY_ID[it.catalogueId]);
  });
}

function makeMesh(spec) {
  const geometry = new THREE.BoxGeometry(spec.w, spec.h, spec.d);
  geometry.translate(0, spec.h / 2, 0);
  const material = new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.85 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }),
  );
  mesh.add(edges);
  return mesh;
}

/** One placed piece: its catalogue spec, its object in the scene, and a
 * thin highlight box shown only while selected. */
class PlacedItem {
  constructor(record, group) {
    this.id = record.id;
    this.catalogueId = record.catalogueId;
    this.spec = CATALOGUE_BY_ID[record.catalogueId];
    this.storey = record.storey || 'ground';
    this.object = makeMesh(this.spec);
    this.object.position.set(record.x, record.y ?? 0, record.z);
    this.object.rotation.y = record.rotationY ?? 0;
    group.add(this.object);
  }

  toRecord() {
    return {
      id: this.id,
      catalogueId: this.catalogueId,
      storey: this.storey,
      x: this.object.position.x,
      y: this.object.position.y,
      z: this.object.position.z,
      rotationY: this.object.rotation.y,
    };
  }

  dispose(group) {
    group.remove(this.object);
    this.object.geometry.dispose();
    this.object.material.dispose();
  }
}

export class FurnitureLayer {
  constructor({ scene, camera, domElement, getWalls, getFloorY, onChange, setControlsEnabled }) {
    this.group = new THREE.Group();
    this.group.name = 'furniture';
    scene.add(this.group);
    this.camera = camera;
    this.dom = domElement;
    this.getWalls = getWalls;
    this.getFloorY = getFloorY;
    this.onChange = onChange;
    this.setControlsEnabled = setControlsEnabled || (() => {});

    this.items = new Map(); // id -> PlacedItem
    this.selected = null;
    this.enabled = false;

    this._raycaster = new THREE.Raycaster();
    this._groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._drag = null; // { item, offset } | { item, kind: 'rotate', startAngle, startRotation }

    for (const record of loadLayout()) this._add(record);

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (enabled) {
      this.dom.addEventListener('pointerdown', this._onDown);
      this.dom.addEventListener('pointermove', this._onMove);
      this.dom.addEventListener('pointerup', this._onUp);
    } else {
      this.dom.removeEventListener('pointerdown', this._onDown);
      this.dom.removeEventListener('pointermove', this._onMove);
      this.dom.removeEventListener('pointerup', this._onUp);
      this.select(null);
    }
  }

  _add(record) {
    const item = new PlacedItem(record, this.group);
    this.items.set(item.id, item);
    return item;
  }

  addFromCatalogue(catalogueId, x, z, storey) {
    const id = `f${Date.now()}_${nextInstanceId++}`;
    const item = this._add({ id, catalogueId, storey, x, y: this.getFloorY(), z, rotationY: 0 });
    this._persist();
    this.select(item);
    return item;
  }

  /** Show only the furniture belonging to a currently-shown storey — kept
   * in step with the building's own storey toggles. */
  setVisibleStoreys(shown) {
    for (const item of this.items.values()) item.object.visible = shown.has(item.storey);
  }

  remove(item) {
    if (!item) return;
    item.dispose(this.group);
    this.items.delete(item.id);
    if (this.selected === item) this.select(null);
    this._persist();
  }

  rotateSelected(deltaRadians) {
    if (!this.selected) return;
    this.selected.object.rotation.y += deltaRadians;
    this._persist();
  }

  select(item) {
    if (this.selected) this.selected.object.remove(this.selected.object.userData.highlight);
    this.selected = item;
    if (item) {
      const spec = item.spec;
      const box = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(spec.w + 0.04, spec.h + 0.04, spec.d + 0.04)),
        new THREE.LineBasicMaterial({ color: 0xff5533 }),
      );
      box.position.y = spec.h / 2;
      item.object.userData.highlight = box;
      item.object.add(box);
    }
    if (this.onChange) this.onChange(item);
  }

  replaceAll(records) {
    for (const item of [...this.items.values()]) item.dispose(this.group);
    this.items.clear();
    this.select(null);
    for (const record of records) this._add(record);
    this._persist();
  }

  serialize() {
    return [...this.items.values()].map((it) => it.toRecord());
  }

  _persist() {
    saveLayout(this.serialize());
  }

  _groundPoint(event) {
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(ndc, this.camera);
    this._groundPlane.constant = -this.getFloorY();
    const point = new THREE.Vector3();
    return this._raycaster.ray.intersectPlane(this._groundPlane, point) ? point : null;
  }

  _pickItem(event) {
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(ndc, this.camera);
    const hits = this._raycaster.intersectObjects(this.group.children, true);
    if (!hits.length) return null;
    let obj = hits[0].object;
    while (obj && obj.parent !== this.group) obj = obj.parent;
    for (const item of this.items.values()) if (item.object === obj) return item;
    return null;
  }

  _onDown(event) {
    const item = this._pickItem(event);
    if (!item) {
      this.select(null);
      return;
    }
    this.select(item);
    const ground = this._groundPoint(event);
    if (!ground) return;
    // Rotation is a toolbar button (rotateSelected), not a drag gesture —
    // a modifier-key drag has no equivalent on a touchscreen.
    this._drag = {
      item,
      offsetX: item.object.position.x - ground.x,
      offsetZ: item.object.position.z - ground.z,
    };
    this.dom.setPointerCapture(event.pointerId);
    // Otherwise this drag also pans the plan view underneath the item.
    this.setControlsEnabled(false);
  }

  _onMove(event) {
    if (!this._drag) return;
    const ground = this._groundPoint(event);
    if (!ground) return;
    const { item } = this._drag;
    item.object.position.x = ground.x + this._drag.offsetX;
    item.object.position.z = ground.z + this._drag.offsetZ;
  }

  _onUp() {
    if (!this._drag) return;
    const { item } = this._drag;
    this._snapToWall(item);
    this._drag = null;
    this._persist();
    this.setControlsEnabled(true);
  }

  /** Nudge a dropped piece flush against a nearby wall and square to it,
   * checking the item's own four edge directions rather than the world
   * axes so it works whatever the item's current rotation is. */
  _snapToWall(item) {
    const walls = this.getWalls();
    if (!walls || !walls.length) return;
    const spec = item.spec;
    const pos = item.object.position;
    const rot = item.object.rotation.y;

    const localEdges = [
      { dir: new THREE.Vector3(0, 0, -1), half: spec.d / 2 },
      { dir: new THREE.Vector3(0, 0, 1), half: spec.d / 2 },
      { dir: new THREE.Vector3(-1, 0, 0), half: spec.w / 2 },
      { dir: new THREE.Vector3(1, 0, 0), half: spec.w / 2 },
    ];

    let best = null;
    for (const edge of localEdges) {
      const worldDir = edge.dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), rot);
      const origin = pos.clone().addScaledVector(worldDir, edge.half).setY(pos.y + 0.4);
      const hit = nearestWall(origin, worldDir, walls, SNAP_RANGE);
      if (hit && (!best || hit.distance < best.distance)) best = { ...hit, worldDir, half: edge.half };
    }
    if (!best) return;

    // Move the item so this edge sits `SNAP_NUDGE` off the wall face.
    const travel = best.distance - SNAP_NUDGE;
    pos.addScaledVector(best.worldDir, travel);

    // Square the item to the wall: align the chosen edge's outward normal
    // with the wall's inward-facing normal.
    const wallYaw = Math.atan2(-best.normal.x, -best.normal.z);
    const edgeYaw = Math.atan2(best.worldDir.x, best.worldDir.z);
    item.object.rotation.y += wallYaw - edgeYaw;
  }
}
