# Asset credits

| File | Source | Author | License |
|---|---|---|---|
| `textures/waternormals.jpg` | three.js examples (`examples/textures/waternormals.jpg`), https://github.com/mrdoob/three.js | three.js authors | MIT |

## PBR texture sets (Poly Haven, CC0)

Each folder holds `albedo.jpg` (sRGB), `normal.jpg` (OpenGL convention) and `arm.jpg` (R = ambient occlusion,
G = roughness, B = metalness), recompressed from the Poly Haven 1k/2k JPG downloads. All are CC0 (public domain),
https://polyhaven.com/license.

| Folder | Poly Haven asset | Author(s) | Res | Used for |
|---|---|---|---|---|
| `textures/concrete/` | [Concrete Floor Worn 001](https://polyhaven.com/a/concrete_floor_worn_001) | Dimitrios Savva, Rico Cilliers | 2k | quay / island slab |
| `textures/concrete_wall/` | [Concrete Wall 008](https://polyhaven.com/a/concrete_wall_008) | Charlotte Baglioni, Dario Barresi | 2k | bunkers, seawalls |
| `textures/sand/` | [Coast Sand 01](https://polyhaven.com/a/coast_sand_01) | Rob Tuytel | 1k | sand beds |
| `textures/grass/` | [Grass Ground](https://polyhaven.com/a/grass_ground) | Charlotte Baglioni | 1k | grass beds, hills |
| `textures/rock/` | [Coast Land Rocks 01](https://polyhaven.com/a/coast_land_rocks_01) | Rob Tuytel, Rico Cilliers | 1k | riprap boulders |
| `textures/corrugated/` | [Corrugated Iron](https://polyhaven.com/a/corrugated_iron) | Dimitrios Savva, Jenelle van Heerden | 1k | containers, warehouses, sheet metal |
| `textures/painted_metal/` | [Rusty Painted Metal](https://polyhaven.com/a/rusty_painted_metal) | Amal Kumar | 1k | crane, painted steel |
| `textures/planks/` | [Raw Plank Wall](https://polyhaven.com/a/raw_plank_wall) | Dimitrios Savva | 1k | wood barricades, scaffold, pallets |
| `textures/linen/` | [Rough Linen](https://polyhaven.com/a/rough_linen) | colormass, Rico Cilliers | 1k | sandbag burlap (re-tinted) |
| `textures/asphalt/` | [Asphalt 02](https://polyhaven.com/a/asphalt_02) | Rob Tuytel | 1k | harbor yard paving |
| `textures/gravel/` | [Gravel Floor 02](https://polyhaven.com/a/gravel_floor_02) | Dimitrios Savva, Jenelle van Heerden | 1k | gravel patches / paths |
| `textures/steel_plate/` | [Metal Plate 02](https://polyhaven.com/a/metal_plate_02) | Rob Tuytel | 1k | steel plate, vault |

Everything else (signage, palm fronds, bark, crack masks, ground markings/decals, grass blades, pebbles, gulls, boats) is
generated procedurally at runtime in `src/client/world/`.
