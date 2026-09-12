/**
 * Daylight through the windows.
 *
 * The interior of this house is lit by one hemisphere light, and a
 * hemisphere light shades a surface from its normal's *up* component and
 * nothing else. So every vertical face in the model — all four walls of
 * every room, inside and out — comes back the same value, and every
 * ceiling comes back the ground colour, which is the darkest thing in
 * it. The result is a flat grey-brown box with no gradient anywhere and
 * no cue as to which way you are facing. Materials cannot fix that: the
 * web build's colours are already as separated as they can usefully be,
 * and adding surface texture to a scene with no light variation only
 * adds noise.
 *
 * What is missing is light that varies with *position*, and the obvious
 * source of it is the windows. So: one inward-facing spot light per
 * window opening, giving a pool of light that falls off into the room.
 *
 * The openings are found in the geometry rather than listed here. The
 * viewer holds no dimension of this house — it is handed a glTF and works
 * out the rest — and a table of window positions would be the first
 * exception, out of date the moment anyone moved a casement in
 * `cad/house.openings`. Instead the glazing is already its own material
 * group, so the panes are already in one mesh per storey; clustering them
 * by proximity gives one cluster per opening, and the cluster's
 * area-weighted normal gives the way it faces.
 *
 * None of these cast shadows. A shadow map each would buy shafts of light
 * across the floor at maybe ten times the cost, on a device that is
 * assumed to be an iPad, and the gradient is what was actually missing.
 * They do therefore leak through walls, which is what REACH is for.
 */

import * as THREE from 'three';

// Panes of one casement sit a few centimetres apart; the nearest two
// openings in this house are the better part of a metre apart. Anything
// between the two works.
const CELL = 0.35;
// Below this, a cluster of glass is not an opening. It is the pair of
// opal shades on a wall light — those are glazing too, and they are in
// the same material group.
const MIN_SPAN = 0.45;
// A light each is affordable; a light each for a terrace of them is not.
const MAX_LIGHTS = 12;

// Daylight from a north European sky, slightly cool.
const COLOUR = 0xdfe9f7;
// Candela. Lights have been physically weighted since three r155, so this
// is not a 0-1 dial: it is the value at one metre, falling off by DECAY.
const INTENSITY = 13.0;
// How far the light carries. It is also how far it leaks through the wall
// behind it, so it is deliberately short of the depth of the house.
const REACH = 6.5;
const ANGLE = 1.15; // radians from the axis: a wide wash, not a spot
const DECAY = 1.5;

/** Every triangle of a mesh, in world space, as {centre, normal, area}. */
function facets(mesh) {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = index ? index.count : position.count;
  mesh.updateWorldMatrix(true, false);
  const matrix = mesh.matrixWorld;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const out = [];
  for (let t = 0; t + 2 < count; t += 3) {
    const i0 = index ? index.getX(t) : t;
    const i1 = index ? index.getX(t + 1) : t + 1;
    const i2 = index ? index.getX(t + 2) : t + 2;
    a.fromBufferAttribute(position, i0).applyMatrix4(matrix);
    b.fromBufferAttribute(position, i1).applyMatrix4(matrix);
    c.fromBufferAttribute(position, i2).applyMatrix4(matrix);
    const e1 = b.clone().sub(a);
    const e2 = c.clone().sub(a);
    const cross = e1.cross(e2);
    const area = cross.length() / 2;
    if (area < 1e-9) continue;
    out.push({
      centre: a.clone().add(b).add(c).multiplyScalar(1 / 3),
      normal: cross.normalize(),
      area,
    });
  }
  return out;
}

/**
 * Group a mesh's triangles into openings.
 *
 * A grid hash rather than a proper clustering: every triangle lands in a
 * CELL-sized cell, and cells touching on a face, edge or corner are one
 * opening. That is enough because the gaps this has to tell apart differ
 * by an order of magnitude — centimetres within a casement against
 * metres between one window and the next.
 */
function openings(mesh) {
  const cells = new Map();
  for (const f of facets(mesh)) {
    const key = [
      Math.floor(f.centre.x / CELL),
      Math.floor(f.centre.y / CELL),
      Math.floor(f.centre.z / CELL),
    ].join(',');
    const bucket = cells.get(key);
    if (bucket) bucket.push(f);
    else cells.set(key, [f]);
  }

  const seen = new Set();
  const found = [];
  for (const start of cells.keys()) {
    if (seen.has(start)) continue;
    // Flood fill outward from this cell through its 26 neighbours.
    const queue = [start];
    seen.add(start);
    const group = [];
    while (queue.length) {
      const key = queue.pop();
      for (const f of cells.get(key)) group.push(f);
      const [i, j, k] = key.split(',').map(Number);
      for (let di = -1; di <= 1; di += 1) {
        for (let dj = -1; dj <= 1; dj += 1) {
          for (let dk = -1; dk <= 1; dk += 1) {
            const next = [i + di, j + dj, k + dk].join(',');
            if (cells.has(next) && !seen.has(next)) {
              seen.add(next);
              queue.push(next);
            }
          }
        }
      }
    }

    // Which way the opening faces is the normal of its largest facet,
    // *not* the area-weighted mean of all of them. A pane of glass here
    // is a closed solid 6 mm thick, and the area-weighted normals of any
    // closed solid sum to exactly zero — front face against back face,
    // edge against opposite edge. Summing them rejected every window in
    // the house as having no direction at all, silently, because a zero
    // vector is indistinguishable from a degenerate cluster.
    //
    // The sign that comes back is arbitrary, since it depends on which
    // face of the pane happens to be biggest. `inward` settles it.
    let widest = null;
    const centre = new THREE.Vector3();
    const box = new THREE.Box3();
    let area = 0;
    for (const f of group) {
      centre.addScaledVector(f.centre, f.area);
      box.expandByPoint(f.centre);
      area += f.area;
      if (!widest || f.area > widest.area) widest = f;
    }
    if (area < 1e-9 || !widest) continue;
    centre.multiplyScalar(1 / area);
    const normal = widest.normal.clone();
    // How much glass this actually is: one face of it, so the facets
    // facing the same way as the widest. The cluster's total area counts
    // both faces and every edge, and would make a window twice the
    // opening it is.
    let glazed = 0;
    for (const f of group) if (Math.abs(f.normal.dot(normal)) > 0.95) glazed += f.area / 2;
    found.push({
      centre, normal, area: glazed, span: box.getSize(new THREE.Vector3()).length(),
    });
  }
  return found;
}

// How far above a point to look for a roof or a ceiling, and how far to
// stand off the opening while looking.
const COVER_REACH = 4.0;
const STAND_OFF = 0.6;

const _ray = new THREE.Raycaster();
const _up = new THREE.Vector3(0, 1, 0);
const _at = new THREE.Vector3();

/** Is there a roof or a ceiling over this point? */
function covered(point, obstacles) {
  _ray.set(point, _up);
  _ray.far = COVER_REACH;
  return _ray.intersectObjects(obstacles, false).length > 0;
}

/**
 * Which side of an opening is the room.
 *
 * A pane's normal is perpendicular to the wall it is in; nothing in the
 * geometry says which side of that wall you would be standing on. So:
 * step off the opening both ways and look up. Indoors there is something
 * over your head and outdoors there is not, which settles every opening
 * in this house but one.
 *
 * The exception is the front door, because the alley it opens off is
 * covered too — both sides pass. There `interior` decides: a point the
 * inside of the building lies toward, which the centre of its bounding
 * box is. That test on its own is not enough for all of them, which is
 * why it is the fallback and not the rule: the lobby's garden door faces
 * *away* from the middle of the building, and lighting the yard through
 * it leaves the lobby dark.
 */
function inward(opening, interior, obstacles) {
  const normal = opening.normal.clone();
  const ahead = covered(_at.copy(opening.centre).addScaledVector(normal, STAND_OFF), obstacles);
  const behind = covered(
    _at.copy(opening.centre).addScaledVector(normal, -STAND_OFF), obstacles,
  );
  if (ahead !== behind) return ahead ? normal : normal.negate();
  return normal.dot(_at.copy(interior).sub(opening.centre)) < 0 ? normal.negate() : normal;
}

/**
 * Put a light in every window.
 *
 * `obstacles` is anything that counts as a roof overhead — the viewer's
 * ceiling colliders do.
 *
 * Returns `[{ light, storey }]` so the caller can hide a storey's
 * daylight along with the storey.
 */
export function daylight(scene, root, interior, obstacles) {
  const candidates = [];
  root.traverse((node) => {
    if (!node.isMesh) return;
    const [material, rest] = node.name.split('__');
    // The neighbours' windows light the neighbours' rooms, which are
    // solid stone. Theirs are also the ones that come and go with the
    // context toggle, and a light left burning in a house that is no
    // longer there is worse than no light at all.
    if (material !== 'glass' || /__context/.test(node.name)) return;
    const storey = ['ground', 'first', 'roof'].find((s) => rest && rest.startsWith(s));
    for (const opening of openings(node)) {
      if (opening.span < MIN_SPAN) continue;
      candidates.push({ ...opening, storey });
    }
  });

  const lights = [];
  for (const opening of candidates.sort((p, q) => q.area - p.area).slice(0, MAX_LIGHTS)) {
    const normal = inward(opening, interior, obstacles);

    // Weighted by the opening's area, so the three-light casement at the
    // front does more than the rooflight over the bathroom, and a large
    // room is not lit to the same level as a small one by accident.
    const light = new THREE.SpotLight(
      COLOUR, INTENSITY * Math.min(opening.area, 1.2), REACH, ANGLE, 1.0, DECAY,
    );
    // Just inside the glass: on it, and the reveal it sits in is lit from
    // within its own thickness and blows out.
    light.position.copy(opening.centre).addScaledVector(normal, 0.26);
    light.target.position.copy(opening.centre).addScaledVector(normal, 2.5);
    scene.add(light);
    scene.add(light.target);
    lights.push({ light, storey: opening.storey });
  }
  return lights;
}
