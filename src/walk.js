/**
 * Walk mode: an eye-height perspective camera moved by touch, with mouse
 * falling out of the same code rather than the other way round.
 *
 * There is no pointer lock on iOS, so looking is a drag rather than a
 * captured mouse, and moving is a virtual joystick rather than WASD. Both
 * are plain Pointer Events, which is why the same code drives a mouse too:
 * a mouse-drag on the joystick zone moves you, a mouse-drag on the look
 * zone turns you, arrow keys work as an extra for a keyboard if one is
 * attached, but nothing here requires one.
 */

import * as THREE from 'three';
import { groundBelow, headroomAbove, slideAgainstWalls } from './collision.js';

const EYE_HEIGHT = 1.6;
const WALKER_RADIUS = 0.28;
const MOVE_SPEED = 1.6; // m/s at full joystick deflection
const LOOK_SENSITIVITY = 0.006; // radians per CSS pixel of drag
const HEADROOM_WARN = 0.35; // metres of clearance left before it reads as a bump

// A riser on this stair is under 200 mm. 0.30 climbs it, and the step
// down into the lobby, without also climbing the handrail beside it.
const STEP_UP = 0.30;
// Far enough to find the ground floor from the landing, so walking off
// the edge of the stairwell falls rather than hovering.
const FALL_REACH = 5.0;
// How fast the feet settle onto the ground height, per second. Fast
// enough that a stair tread reads as a step, slow enough that a storey's
// worth of drop reads as a fall rather than a cut.
const GROUND_FOLLOW = 11;
// Wall feelers are cast this far above the feet. Not at the eye: halfway
// up the stair the eye is already above the first-floor structure while
// the feet are still below it, and a feeler up there tests the partitions
// upstairs instead of the walls you are walking between.
const FEELER_HEIGHT = 1.0;

export class WalkMode {
  constructor({ colliders, camera, domElement, hud }) {
    this.colliders = colliders; // { walls, ceilings, floors }, shared with furniture snapping
    this.camera = camera;
    this.dom = domElement;
    this.hud = hud; // { root, joystick, joystickKnob, headroom }
    this.active = false;

    this.yaw = 0;
    this.pitch = 0;
    this.position = new THREE.Vector3();
    this.groundY = 0; // what is actually under the feet
    this.feetY = 0;   // the eased value the eye rides on

    this.moveVec = { x: 0, y: 0 }; // joystick, both axes in [-1, 1]
    this.keys = new Set();

    this._pointers = new Map(); // pointerId -> { kind: 'move'|'look', startX, startY, x, y }

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onKeyDown = (e) => this.keys.add(e.code);
    this._onKeyUp = (e) => this.keys.delete(e.code);
  }

  enter(spawn) {
    // Search down a long way from the spawn point rather than a step:
    // the caller knows a sensible place to stand, not what height the
    // floor there is.
    this.groundY = groundBelow(
      spawn.x, spawn.z, spawn.y, this.colliders.walkable, 0.5, FALL_REACH * 4, spawn.y,
    );
    this.feetY = this.groundY;
    this.position.set(spawn.x, this.feetY + EYE_HEIGHT, spawn.z);

    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    this.yaw = Math.atan2(forward.x, forward.z);
    this.pitch = 0;

    this.active = true;
    this.dom.addEventListener('pointerdown', this._onPointerDown);
    this.dom.addEventListener('pointermove', this._onPointerMove);
    this.dom.addEventListener('pointerup', this._onPointerUp);
    this.dom.addEventListener('pointercancel', this._onPointerUp);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    this.hud.root.hidden = false;
    this._applyCamera();
  }

  exit() {
    this.active = false;
    this.dom.removeEventListener('pointerdown', this._onPointerDown);
    this.dom.removeEventListener('pointermove', this._onPointerMove);
    this.dom.removeEventListener('pointerup', this._onPointerUp);
    this.dom.removeEventListener('pointercancel', this._onPointerUp);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this._pointers.clear();
    this.moveVec.x = 0;
    this.moveVec.y = 0;
    this.hud.root.hidden = true;
    this.hud.joystick.hidden = true;
  }

  _onPointerDown(e) {
    // The left half moves and the right half looks, which is two thumbs
    // on an iPad and is what this is for. A mouse has one pointer and a
    // keyboard beside it, so a mouse drag anywhere looks: splitting the
    // screen for it only means half the window cannot turn you round.
    const leftHalf = e.clientX < this.dom.clientWidth / 2;
    const kind = leftHalf && e.pointerType !== 'mouse' ? 'move' : 'look';
    this._pointers.set(e.pointerId, { kind, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY });
    this.dom.setPointerCapture(e.pointerId);
    if (kind === 'move') {
      this.hud.joystick.hidden = false;
      this.hud.joystick.style.left = `${e.clientX}px`;
      this.hud.joystick.style.top = `${e.clientY}px`;
      this.hud.joystickKnob.style.transform = 'translate(-50%, -50%)';
    }
  }

  _onPointerMove(e) {
    const p = this._pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;

    if (p.kind === 'look') {
      this.yaw -= dx * LOOK_SENSITIVITY;
      this.pitch -= dy * LOOK_SENSITIVITY;
      const limit = Math.PI * 0.48;
      this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
    } else {
      const maxRadius = 45;
      let ox = e.clientX - p.startX;
      let oy = e.clientY - p.startY;
      const len = Math.hypot(ox, oy);
      if (len > maxRadius) {
        ox = (ox / len) * maxRadius;
        oy = (oy / len) * maxRadius;
      }
      this.moveVec.x = ox / maxRadius;
      this.moveVec.y = oy / maxRadius;
      this.hud.joystickKnob.style.transform = `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px))`;
    }
  }

  _onPointerUp(e) {
    const p = this._pointers.get(e.pointerId);
    if (!p) return;
    this._pointers.delete(e.pointerId);
    if (p.kind === 'move') {
      this.moveVec.x = 0;
      this.moveVec.y = 0;
      this.hud.joystick.hidden = true;
    }
  }

  _keyboardVec() {
    let x = 0, y = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    return { x, y };
  }

  update(dt) {
    if (!this.active) return;

    const kb = this._keyboardVec();
    const inX = this.moveVec.x || kb.x;
    const inY = this.moveVec.y || kb.y;

    if (inX || inY) {
      const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      // Screen-right, which is forward × up, not up × forward. With the
      // eye looking along +z the camera's own x axis points at -x — the
      // opposite of what the obvious (forward.z, -forward.x) gives — so
      // pushing the joystick right used to strafe left, and D used to be
      // A. Worth deriving rather than guessing: the sign is only visible
      // in motion, and reads as the house being mirrored.
      const right = new THREE.Vector3(-forward.z, 0, forward.x);
      const delta = new THREE.Vector3()
        .addScaledVector(forward, -inY * MOVE_SPEED * dt)
        .addScaledVector(right, inX * MOVE_SPEED * dt);
      const moved = slideAgainstWalls(
        this.position, delta, this.colliders.walls, WALKER_RADIUS, this.groundY + FEELER_HEIGHT,
      );
      this.position.copy(moved);
    }

    this._followGround(dt);
    this._applyCamera();
    this._updateHeadroom();
  }

  /**
   * Put the feet on whatever is under them. This is what makes the stair
   * a stair: without it the eye stays at the height it entered at, the
   * treads are something you walk through, and the first floor cannot be
   * reached at all.
   *
   * The settle is eased rather than snapped so that a 200 mm riser reads
   * as a step and a storey's drop reads as a fall. Nothing here knows
   * which floor you are on; the geometry is asked, every frame.
   */
  _followGround(dt) {
    // Measured from the ground actually underfoot, never from the eased
    // value below. Ease the search origin too and it lags behind the
    // climb: each riser is 196 mm against a 300 mm reach, the eye is
    // still catching up with the tread you are on when the next one comes
    // round, and the margin goes. You then walk *under* the whole flight
    // instead of up it, which is exactly what happened.
    this.groundY = groundBelow(
      this.position.x, this.position.z, this.groundY,
      this.colliders.walkable, STEP_UP, FALL_REACH, this.groundY,
    );
    const ease = Math.min(1, dt * GROUND_FOLLOW);
    this.feetY += (this.groundY - this.feetY) * ease;
    if (Math.abs(this.groundY - this.feetY) < 0.002) this.feetY = this.groundY;
    this.position.y = this.feetY + EYE_HEIGHT;
  }

  _applyCamera() {
    this.camera.position.copy(this.position);
    const dir = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    this.camera.lookAt(this.position.clone().add(dir));
  }

  _updateHeadroom() {
    const clearance = headroomAbove(this.position, this.colliders.ceilings);
    const el = this.hud.headroom;
    el.textContent = `headroom ${clearance.toFixed(2)} m`;
    el.classList.toggle('warn', clearance < HEADROOM_WARN);
  }
}
