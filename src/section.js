/**
 * The horizontal cut behind the plan view.
 *
 * A clipping plane on its own does not give you a plan. Cut a wall with
 * one, look straight down, and you see nothing at all: the plane is not
 * geometry, the wall's remaining faces are vertical and present no area
 * from above, and the flat top the storey split gave it has just been
 * clipped away. So the cut has to be drawn as well as made.
 *
 * That is the stencil trick. For each mesh, its back faces increment the
 * stencil buffer and its front faces decrement it, both with colour and
 * depth writes off. Where a camera ray entered the solid and did not
 * leave it again — which is exactly where the clipping plane passes
 * through material — the stencil is left set. A quad at the cut height,
 * drawn only where the stencil is set, fills that in: the poché of a
 * hand-drawn plan, from the same solids the walk-through uses.
 *
 * Only meshes the cut actually passes through are capped, so a plan of
 * one storey costs a handful of extra draws rather than one per mesh in
 * the house.
 */

import * as THREE from 'three';

// How much darker the cut face is than the material's own colour. Cut
// masonry reads as solid rather than as another elevation of the wall.
const POCHE = 0.72;

export class SectionPlane {
  constructor({ renderer, scene }) {
    this.renderer = renderer;
    this.plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    this.enabled = false;
    this.height = 0;

    this.group = new THREE.Group();
    this.group.name = 'section';
    this.group.visible = false;
    scene.add(this.group);

    this.caps = []; // { mesh, cap, stencil: [Mesh, Mesh] }
    this._capGeometry = null;
  }

  /**
   * Build the stencil machinery for a set of house meshes. `extent` is
   * how wide the cap quads need to be to cover the model from above.
   */
  build(meshes, extent, centre) {
    this._dispose();
    this._capGeometry = new THREE.PlaneGeometry(extent, extent);
    this._centre = centre.clone();

    meshes.forEach((mesh, i) => {
      const stencil = [
        this._stencilMesh(mesh, THREE.BackSide, THREE.IncrementWrapStencilOp),
        this._stencilMesh(mesh, THREE.FrontSide, THREE.DecrementWrapStencilOp),
      ];
      // Draw order matters: both stencil passes, then the cap that reads
      // the result and resets the buffer for the next mesh.
      stencil[0].renderOrder = i * 3 + 1;
      stencil[1].renderOrder = i * 3 + 2;

      const base = mesh.material.color ? mesh.material.color.clone() : new THREE.Color(0x999999);
      const cap = new THREE.Mesh(
        this._capGeometry,
        new THREE.MeshStandardMaterial({
          color: base.multiplyScalar(POCHE),
          roughness: 0.95,
          metalness: 0,
          stencilWrite: true,
          stencilRef: 0,
          stencilFunc: THREE.NotEqualStencilFunc,
          stencilFail: THREE.ReplaceStencilOp,
          stencilZFail: THREE.ReplaceStencilOp,
          stencilZPass: THREE.ReplaceStencilOp,
          // Every cap is the same quad at the same height, so wherever two
          // solids overlap in plan — a window frame inside its wall, the
          // render on the stone behind it — two caps write the identical
          // depth and the pixel goes to whichever was drawn last. Draw
          // order is sorted by distance, so it changes as the view moves
          // and the overlap flickers between the two poché colours. One
          // offset per cap settles it the same way every frame. The unit
          // is a depth-buffer step, not a metre: this moves nothing.
          polygonOffset: true,
          polygonOffsetFactor: 0,
          polygonOffsetUnits: -(i + 1),
        }),
      );
      cap.rotation.x = -Math.PI / 2;
      cap.renderOrder = i * 3 + 3;
      // Leave the buffer clean, or the next mesh's cap inherits this
      // one's footprint.
      cap.onAfterRender = (renderer) => renderer.clearStencil();

      this.group.add(stencil[0], stencil[1], cap);
      this.caps.push({ mesh, cap, stencil });
    });

    this.setHeight(this.height);
  }

  _stencilMesh(source, side, op) {
    const material = new THREE.MeshBasicMaterial({
      depthWrite: false,
      depthTest: false,
      colorWrite: false,
      side,
      stencilWrite: true,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilFail: op,
      stencilZFail: op,
      stencilZPass: op,
      clippingPlanes: [this.plane],
    });
    const mesh = new THREE.Mesh(source.geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(source.matrixWorld);
    return mesh;
  }

  setHeight(y) {
    this.height = y;
    this.plane.constant = y;
    for (const { cap } of this.caps) cap.position.set(this._centre.x, y, this._centre.z);
    this._refresh();
  }

  setEnabled(on, materials) {
    this.enabled = on;
    this.group.visible = on;
    this.renderer.localClippingEnabled = true;
    // Clip per material rather than through renderer.clippingPlanes, so
    // the cap quads — which sit exactly on the plane, where a global test
    // is a coin toss — are left out of it.
    for (const material of materials) {
      material.clippingPlanes = on ? [this.plane] : null;
      material.needsUpdate = true;
    }
    this._refresh();
  }

  /** Cap only what the cut passes through, and only what is on screen. */
  _refresh() {
    const box = new THREE.Box3();
    for (const entry of this.caps) {
      const { mesh, cap, stencil } = entry;
      box.setFromObject(mesh);
      const cut = this.enabled
        && mesh.visible
        && box.min.y < this.height
        && box.max.y > this.height;
      cap.visible = cut;
      stencil[0].visible = cut;
      stencil[1].visible = cut;
    }
  }

  /** Call after changing which storeys are shown. */
  update() {
    this._refresh();
  }

  _dispose() {
    for (const { cap, stencil } of this.caps) {
      cap.material.dispose();
      for (const s of stencil) s.material.dispose();
      this.group.remove(cap, stencil[0], stencil[1]);
    }
    this.caps = [];
    if (this._capGeometry) this._capGeometry.dispose();
  }
}
