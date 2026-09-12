# Terrace house viewer

A browser viewer for a parametric model of a two-bedroom mid-terrace stone
cottage — masonry with real wall thicknesses, a pitched roof with dormer and
rooflights, chimney breast and stacks, and the fixed interior: partitions,
a winder staircase, an inglenook, fitted kitchen units, beam and post. Every
window and door is a real assembly with frame, sashes, glazing bars, cill and
lintel, rather than a hole with a plane in it.

**[Open the viewer →](https://or280.github.io/terrace-house-viewer/)**

Toggles for each storey, the roof and the neighbouring terrace stubs; a plan
view; and a walk-through.

The plan view switches to an orthographic camera looking straight down, cuts
the model 1.10 m above the floor, and has its own level control for moving
between floors. The cut is drawn as well as made — a clipping plane on its
own shows nothing from above, since the plane is not geometry and what is
left of a wall is vertical, so the cut face is filled in from the stencil
buffer as poché.

Walk mode puts your feet on whatever is under them every frame, so the stair
is a stair, the step down into the lobby is a step, and the first floor is
somewhere you can actually get to.

`house_viewer.html` is the same thing as a single self-contained file — three
.js, the app and the model all inlined as `data:` URLs — so it works offline,
from disk, with no server. Worth knowing why that is necessary: a page opened
from `file://` is an opaque origin and may not fetch its own siblings, so the
ordinary multi-file build opens from a Files app as a blank screen.

## Contents

| | |
|---|---|
| `index.html`, `src/`, `vendor/` | the viewer, and its source |
| `house.glb` | the model itself, ~500 KB of glTF |
| `house_viewer.html` | everything above in one offline file |

Every file in this repository is generated, and the whole of it is replaced
by each build — so nothing here is worth editing, and an edit made here is
gone by the next publish. Changes are made in the private source repository
this is built from, and reach this one only by being published.

Everything here is generated. The CAD model that produces `house.glb` is built
with [build123d](https://github.com/gumyr/build123d) and lives in a separate
repository; the geometry arrives here as glTF with one node per material, per
storey, per side of the plot boundary, named
`<material>__<storey>[__context]`, which is what the storey and neighbour
toggles read. The terrace's roof, lintel band and gutters are each one solid
run across the whole row and the neighbours' windows are ordinary joinery, so
that last part of the name is the only thing that makes "the neighbours" a
single switch.

## Licence

The model and the viewer code are MIT — see `LICENSE`. three.js in `vendor/`
is MIT and carries its own licence text in `vendor/LICENSE`.

The building is a real one and the model was measured from an estate agent's
floorplan and photographs. Those source images are **not** included here and
are not mine to give; the dimensions derived from them are facts about a
building, and those are.
