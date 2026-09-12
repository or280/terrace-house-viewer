/**
 * Collision helpers shared by walk mode and furniture snapping.
 *
 * There is no navmesh and no Octree: the house is a handful of meshes, so
 * plain THREE.Raycaster against the actual wall geometry is cheap enough to
 * run every frame, and it means collision is always exactly the fabric the
 * CAD stage built — including every door and window void, because those are
 * already cut out of the "stone"/"brick" meshes before they ever reach the
 * viewer (see cad/joinery.py's Opening.void()).
 *
 * Deliberately storey-agnostic: a wall mesh only exists in the Y band its
 * own storey occupies, so a ray cast at chest height hits the ground-floor
 * wall while standing downstairs and the first-floor wall while standing
 * up it, with no need to track "which storey am I on".
 */

import * as THREE from 'three';

// "plaster" is a wall material and not a finish you can walk through: the
// first-floor stud partitions are the whole of that group's solid
// content besides the linings, and they were "stone" until the linings
// existed (cad/shell.interior_finishes).
const WALL_MATERIALS = new Set(['stone', 'brick', 'plaster']);
// A storey's own floor structure is the ceiling of whatever is underneath
// it, so the floor groups count as headroom surfaces as well as walking
// ones.
const CEILING_MATERIALS = new Set([
  'stone', 'brick', 'plaster', 'slate', 'stone_slate', 'ceiling', 'floor', 'paving',
]);
// Decks only, never ceilings — the CAD keeps those in separate material
// groups precisely so that this question has one answer
// (cad/shell.floors, cad/shell.paving). "paving" is the alley's flags and
// the annex slab: a second group so the passage and the outhouse are not
// carpeted, and it has to be in here or you fall through both.
const FLOOR_MATERIALS = new Set(['floor', 'paving']);
// What you can stand on. The stair is "timber_light" and its treads are
// the only way between the storeys; without them walk mode is stuck on
// whichever floor it started on. Its handrail, newel and spindles are in
// the same mesh, and it is the step-up limit in groundBelow — not this
// list — that stops you climbing onto them.
const STAIR_MATERIAL = 'timber_light';

function materialOf(node) {
  return node.name.split('__')[0];
}

/** Walk the loaded scene once and bucket meshes for collision use. */
export function collectColliders(root) {
  const walls = [];
  const ceilings = [];
  const floors = [];
  const walkable = [];
  root.traverse((node) => {
    if (!node.isMesh) return;
    const material = materialOf(node);
    if (WALL_MATERIALS.has(material)) walls.push(node);
    if (CEILING_MATERIALS.has(material)) ceilings.push(node);
    if (FLOOR_MATERIALS.has(material)) {
      floors.push(node);
      walkable.push(node);
    }
    if (material === STAIR_MATERIAL) walkable.push(node);
  });
  return { walls, ceilings, floors, walkable };
}

const _raycaster = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

/**
 * The height of the surface you would be standing on at (x, z), given
 * feet currently at `feetY`. Returns `fallback` when there is nothing
 * within reach.
 *
 * The ray starts `stepUp` above the feet rather than far overhead, and
 * that is the whole design: it makes this a step rather than a teleport.
 * A stair tread within reach is found and climbed; a handrail 0.8 m up is
 * never seen at all; and because intersections come back sorted, the
 * first hit going down is always the highest surface you could actually
 * have stepped onto. `drop` is how far below the feet to keep looking,
 * which is what lets you walk off the landing rather than hover.
 */
export function groundBelow(x, z, feetY, surfaces, stepUp, drop, fallback = 0) {
  _origin.set(x, feetY + stepUp, z);
  _raycaster.set(_origin, DOWN);
  _raycaster.far = stepUp + drop;
  const hits = _raycaster.intersectObjects(surfaces, false);
  return hits.length ? hits[0].point.y : fallback;
}

/** Clearance from `head` straight up to the nearest ceiling/roof surface. */
export function headroomAbove(head, ceilings, max = 3) {
  _raycaster.set(head, UP);
  _raycaster.far = max;
  const hits = _raycaster.intersectObjects(ceilings, false);
  return hits.length ? hits[0].distance : max;
}

/**
 * Move `position` (XZ, a fixed Y) by `delta` (XZ), stopping at walls and
 * sliding along them rather than stopping dead — the two-pass
 * cast-then-slide that makes a raycast collider feel like a wall instead
 * of a tripwire.
 *
 * `feelerY` is the height the rays are cast at, which the caller sets
 * from the walker's feet rather than the eye: on the stair the eye is
 * often already above the first-floor structure while the feet are still
 * below it, and a feeler up there tests the partitions upstairs instead
 * of the walls you are walking between.
 *
 * `radius` is the walker's (or a furniture edge's) clearance from wall
 * centre-surfaces; three feeler rays (centre, and offset ±radius
 * perpendicular to travel) stop the walker cutting through a doorpost when
 * approaching a corner at an angle.
 */
export function slideAgainstWalls(position, delta, walls, radius, feelerY = position.y) {
  const moveLen = Math.hypot(delta.x, delta.z);
  if (moveLen < 1e-6) return position.clone();

  const dir = new THREE.Vector3(delta.x, 0, delta.z).normalize();
  const perp = new THREE.Vector3(-dir.z, 0, dir.x);
  const from = position.clone().setY(feelerY);

  const hit = castAhead(from, dir, perp, walls, radius, moveLen);
  const step = Math.min(hit.distance, moveLen);
  const next = position.clone().addScaledVector(dir, step);

  const remaining = moveLen - step;
  if (remaining > 1e-4 && hit.normal) {
    // Slide: drop the part of what is left that runs *into* the wall and
    // keep the part that runs along it. Re-casting the original direction
    // is not a slide — it is the same ray again, and it leaves you pinned
    // against a wall rather than sidling along it to the doorway a foot
    // away, which is what used to happen at every internal door.
    const n = hit.normal.clone().setY(0);
    if (n.lengthSq() > 1e-8) {
      n.normalize();
      const along = dir.clone().addScaledVector(n, -dir.dot(n));
      if (along.lengthSq() > 1e-8) {
        along.normalize();
        const alongPerp = new THREE.Vector3(-along.z, 0, along.x);
        const slid = castAhead(next.clone().setY(feelerY), along, alongPerp, walls, radius, remaining);
        next.addScaledVector(along, Math.min(slid.distance, remaining));
      }
    }
  }
  return next;
}

/**
 * How far the walker may travel along `dir` before a wall stops it, and
 * the face normal of whatever stopped it (null if nothing did).
 */
function castAhead(from, dir, perp, walls, radius, maxDist) {
  const feelers = [0, radius, -radius];
  let best = maxDist + radius;
  let normal = null;
  for (const offset of feelers) {
    _origin.copy(from).addScaledVector(perp, offset);
    _raycaster.set(_origin, dir);
    _raycaster.far = maxDist + radius + 0.05;
    const hits = _raycaster.intersectObjects(walls, false);
    if (!hits.length || hits[0].distance >= best) continue;
    best = hits[0].distance;
    normal = hits[0].face
      ? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld)
      : null;
  }
  return { distance: Math.max(0, best - radius), normal };
}

/**
 * Nearest wall surface to `point` within `range`, for furniture snapping —
 * returns the hit point and its outward face normal, or null.
 */
export function nearestWall(point, direction, walls, range) {
  _raycaster.set(point, direction);
  _raycaster.far = range;
  const hits = _raycaster.intersectObjects(walls, false);
  if (!hits.length) return null;
  const hit = hits[0];
  const normal = hit.face
    ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
    : direction.clone().negate();
  return { point: hit.point.clone(), normal, distance: hit.distance };
}
