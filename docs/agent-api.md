# Alice external agent API

Lets a tool/agent *outside* the Alice Node process (a script, OpenHands, another
Claude instance, etc.) call Alice's image and video generation directly over
HTTP, without going through the chat UI/socket.

> Need chat or want to point an OpenAI-compatible client (LiteLLM, Open
> WebUI, the `openai` SDK, etc.) straight at Alice? See
> [`openai-api.md`](openai-api.md) instead — that's a synchronous,
> OpenAI-shaped surface; this doc covers the async job-polling media API.

Source: `alice-backend/src/routes/agent.js`, mounted at `/agent` (behind
NGINX/Cloudflare this is `https://<your-alice-host>/api/agent/*` — NGINX
strips the `/api` prefix before proxying to the backend).

## Auth

Every route requires a shared secret, either header works:

```
Authorization: Bearer <ALICE_AGENT_API_KEY>
X-API-Key: <ALICE_AGENT_API_KEY>
```

The key is set server-side via the `ALICE_AGENT_API_KEY` env var
(`alice-backend/.env`). No key configured → `503`. Missing/wrong key → `401`.

## Async job-polling contract

**Every `POST` returns immediately with `202` and a `job_id` — it does not
wait for generation to finish.** Cloudflare's edge kills any proxied response
past ~100–125s, and real generations (especially video, especially `chain`
mode) run far longer than that. Poll the returned `status_url` until it stops
saying `"processing"`:

```
POST /agent/image  →  { "job_id": "...", "status_url": "/agent/image/<id>" }
GET  /agent/image/<id>
  processing:  { "status": "processing" }
  done:        200 + JSON body (see below)
  error:       502/503 + { "status": "error", "error": "<message>" }
```

Jobs are **not deleted when fetched** — `GET` is idempotent and safe to
retry (e.g. after a transient 502 between you and the server). A job and its
result are only ever removed by a fixed 30-minute sweep from creation time,
regardless of how many times (or how unsuccessfully) it's been polled.
Poll on a reasonable interval (e.g. every 3–5s for images, 10–15s for video).

There is no persistence beyond that 30 minutes and no association with an
Alice user/conversation — the job store is a plain in-memory `Map`. Save the
bytes yourself once you have them.

---

## Images — `POST /agent/image`

```json
{
  "prompt": "a red panda wearing a tiny wizard hat, studio lighting",
  "negativePrompt": "blurry, low quality",
  "imageModel": "auto",
  "imageAspect": "landscape",
  "upscale4k": true,
  "width": 1920,
  "height": 1080
}
```

| field | type | default | notes |
|---|---|---|---|
| `prompt` | string | required | |
| `negativePrompt` | string | `""` | |
| `imageModel` | `"auto"` \| `"flux2"` | `"auto"` | `flux2` = Flux.2 Dev |
| `imageAspect` | `"square"` \| `"landscape"` \| `"portrait"` | `"square"` | ignored if `width`+`height` given |
| `upscale4k` | boolean | `false` | RealESRGAN upscale pass |
| `width`, `height` | number | — | must be given **together**; overrides `imageAspect` |

`GET /agent/image/<id>` on success:

```json
{ "filename": "alice_flux2_00013_.png", "mime_type": "image/png", "image_base64": "..." }
```

**Example (curl):**

```bash
KEY=<ALICE_AGENT_API_KEY>
HOST=https://alice.deviousweb.com/api

id=$(curl -s -X POST $HOST/agent/image \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"prompt":"a red panda wizard","imageAspect":"landscape","upscale4k":true}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["job_id"])')

while true; do
  out=$(curl -s $HOST/agent/image/$id -H "Authorization: Bearer $KEY")
  echo "$out" | grep -q '"processing"' || break
  sleep 3
done
echo "$out" | python3 -c 'import sys,json,base64;d=json.load(sys.stdin);open(d["filename"],"wb").write(base64.b64decode(d["image_base64"]))'
```

---

## 3D mesh — `POST /agent/mesh` (2026-10-03)

Generates **one** textured 3D asset of **any subject** — a prop, vehicle,
animal, piece of furniture, whatever — not just crowd characters (see
`/agent/crowd` below for the batch-of-people case). Pipeline: a reference
photo (either generated via Flux.2/ComfyUI, same stack as `/agent/image`,
or supplied directly by the caller) → background removal → Hunyuan3D-2.1
shape generation → PBR texture painting → GLB export. Source:
`src/agents/mesh3dClient.js` (orchestration), `src/agents/referenceImage.js`
+ `src/agents/hunyuan3dWorker.js` (shared building blocks also used by
`/agent/crowd`).

```json
{
  "prompt": "an ornate wooden treasure chest with brass hinges, lid slightly open showing gold coins, plain seamless white studio background, soft even studio lighting, photorealistic, centered in frame",
  "imageModel": "auto",
  "width": 1024,
  "height": 1024
}
```

| field | type | default | notes |
|---|---|---|---|
| `prompt` | string | — | generates the reference photo; mutually exclusive with `image` |
| `image` | `{name, dataUrl}` | — | supply your own reference photo instead of generating one (same shape as video's `firstFrame`); mutually exclusive with `prompt` |
| `imageModel` | `"auto"` \| `"flux2"` | `"auto"` | only used with `prompt` |
| `imageAspect` | `"square"` \| `"landscape"` \| `"portrait"` | `"square"` | only used with `prompt`; ignored if `width`+`height` given |
| `upscale4k` | boolean | `false` | only used with `prompt` |
| `width`, `height` | number | — | only used with `prompt`; must be given together |

**Always frame the reference photo the same way regardless of subject** —
plain seamless background, subject fully visible, centered — that's what
Hunyuan3D needs for a clean reconstruction, the same requirement the crowd
pipeline's fixed framing satisfies automatically.

`POST` response:

```json
{ "job_id": "...", "status_url": "/agent/mesh/<id>", "preview_url": "/agent/mesh/<id>/preview" }
```

`GET /agent/mesh/<id>` on success: `200`, `Content-Type: model/gltf-binary`,
body = the raw GLB bytes — import directly into Unity/Unreal/Blender.

`GET /agent/mesh/<id>/preview`: a quick offscreen render (PNG) for a sanity
check without opening a 3D viewer. `404` if the render step failed (rare,
best-effort — the GLB itself is still valid).

**Example (curl):**

```bash
KEY=<ALICE_AGENT_API_KEY>
HOST=https://alice.deviousweb.com/api

id=$(curl -s -X POST $HOST/agent/mesh \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"prompt": "a weathered leather messenger bag with brass buckles, plain white background, centered"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["job_id"])')

while true; do
  out=$(curl -s $HOST/agent/mesh/$id -H "Authorization: Bearer $KEY")
  echo "$out" | grep -q '"processing"' || break
  sleep 15
done
curl -s $HOST/agent/mesh/$id -H "Authorization: Bearer $KEY" -o asset.glb
```

### Known quality limits

Same single-image-to-3D caveats as the crowd pipeline below — good for a
background/mid-distance asset, not for anything the camera gets close to.
Props with simple, convex geometry (chests, bags, furniture) tend to hold
up better than organic subjects with fine detail (faces especially).

### Errors

`400` for bad input (neither/both of `prompt`/`image` given, bad
`imageModel`/`imageAspect`, mismatched `width`/`height`). `502` for a
generation failure. `503` if ComfyUI/the GPU host was offline. `404` for an
unknown/expired `job_id`, or for `/preview` if no render was produced.

---

## Video — `POST /agent/video`

LTX-2.5 only. Three single-clip modes plus a multi-clip `chain` mode.

### `mode: "t2v"` — text to video

```json
{ "mode": "t2v", "prompt": "a red rubber duck floating on calm water", "durationSeconds": 6, "width": 1280, "height": 720 }
```

### `mode: "i2v"` — image to video

```json
{
  "mode": "i2v",
  "prompt": "the duck drifts slowly to the right, gentle ripples spreading",
  "firstFrame": { "name": "duck.png", "dataUrl": "data:image/png;base64,..." },
  "durationSeconds": 6
}
```

### `mode: "fl2v"` — first+last frame interpolation

```json
{
  "mode": "fl2v",
  "prompt": "camera pushes in as the drone assembles into the logo",
  "firstFrame": { "name": "drone_swarm.png", "dataUrl": "data:image/png;base64,..." },
  "lastFrame":  { "name": "logo.png",        "dataUrl": "data:image/png;base64,..." },
  "durationSeconds": 6
}
```

| field | type | default | applies to |
|---|---|---|---|
| `prompt` | string | required | all |
| `durationSeconds` | number | `12` | all |
| `width`, `height` | number | `1280`, `720` | all |
| `firstFrame` | `{name, dataUrl}` | — | required for `i2v`/`fl2v` |
| `lastFrame` | `{name, dataUrl}` | — | required for `fl2v` |
| `extractLastFrame` | boolean | `false` | `t2v`/`i2v`/`fl2v` — see chaining below |

`GET /agent/video/<id>` on success streams the raw file:
`Content-Type: video/mp4`, body = MP4 bytes (not JSON/base64 — read the
response body directly).

### Chaining single clips by hand

Set `extractLastFrame: true` on a request and the completed job also exposes:

```json
{ "job_id": "...", "status_url": "/agent/video/<id>", "last_frame_url": "/agent/video/<id>/last-frame" }
```

`GET /agent/video/<id>/last-frame` streams a PNG of the clip's final frame
once done (404 with an explanatory message if `extractLastFrame` wasn't set,
or if there's no frame yet). Feed that PNG back as the next call's
`firstFrame` (mode `i2v`) to continue the shot. This is exactly what `chain`
mode below does for you automatically, across as many clips as you want, plus
a server-side merge — reach for `chain` unless you specifically want to
inspect/branch between clips yourself.

### `mode: "chain"` — multi-clip, auto-continuity, merged server-side

```json
{
  "mode": "chain",
  "clips": [
    { "mode": "t2v", "prompt": "a red rubber duck floating on calm water, static camera", "durationSeconds": 4, "width": 768, "height": 512 },
    { "prompt": "the duck drifts slowly to the right, gentle ripples spreading" },
    { "prompt": "the duck spins once and drifts back to center as the water stills" }
  ]
}
```

- `clips` is a non-empty array. Each entry has the same shape as a
  single-clip video request (`prompt`, `mode`, `durationSeconds`, `width`,
  `height`, `firstFrame`, `lastFrame`).
- **`clips[0].mode` defaults to `"t2v"`; every later clip defaults to
  `"i2v"`.** You only supply `firstFrame` explicitly for `clips[0]` (if it
  isn't `t2v`) — every later clip automatically inherits the *previous*
  clip's extracted last frame as its `firstFrame` unless you override it.
- A clip can still be `"fl2v"` (e.g. to pin a specific clip's ending to a
  reference image) — give it its own `lastFrame`; its `firstFrame` still
  auto-chains from the previous clip unless you override that too.
- All clips must share the same `width`/`height` (checked up front, before
  any GPU time is spent) — the merge step re-encodes into one stream sized
  from the first clip.
- Clips run **sequentially** (each needs the previous clip's last frame),
  so wall-clock time is roughly the sum of each clip's generation time.
- While processing, `GET /agent/video/<id>` returns
  `{ "status": "processing", "progress": { "completed": 1, "total": 3 } }`
  so you can show progress across the whole chain.
- On success, `GET /agent/video/<id>` streams **one merged MP4** — clips are
  crossfaded together (0.3s video+audio blend at each join, same
  `scripts/concat_videos.py` the in-app chained-video chat agent uses), not
  hard-cut.
- `extractLastFrame` isn't needed per-clip in chain mode (every clip's last
  frame is always extracted internally, to feed the next one) — but the
  *final* clip's last frame is still exposed afterward via
  `GET /agent/video/<id>/last-frame`, in case you want to keep chaining
  further with a later separate call.

**Example:** the request/response pair above, end to end:

```bash
KEY=<ALICE_AGENT_API_KEY>
HOST=https://alice.deviousweb.com/api

id=$(curl -s -X POST $HOST/agent/video \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{
    "mode": "chain",
    "clips": [
      { "mode": "t2v", "prompt": "a red rubber duck floating on calm water, static camera", "durationSeconds": 4, "width": 768, "height": 512 },
      { "prompt": "the duck drifts slowly to the right, gentle ripples spreading" },
      { "prompt": "the duck spins once and drifts back to center as the water stills" }
    ]
  }' | python3 -c 'import sys,json;print(json.load(sys.stdin)["job_id"])')

while true; do
  code=$(curl -s -o /tmp/resp -w '%{http_code}' $HOST/agent/video/$id -H "Authorization: Bearer $KEY")
  [ "$code" = "200" ] && break
  cat /tmp/resp; echo
  sleep 10
done
cp /tmp/resp chain_output.mp4
```

### Errors

`400` for bad input (missing prompt, wrong mode, mismatched chain clip
sizes, missing frame for `i2v`/`fl2v`/`fl2v`-in-chain). `502` for a
generation failure (ComfyUI/model error — message in `error`). `503` if
ComfyUI/the GPU host was offline when the job ran. `404` for an unknown or
expired `job_id`.

---

## Crowd — `POST /agent/crowd` (2026-10-02)

Generates `count` distinct, textured 3D **character** meshes (game-ready
GLB, e.g. for a Unity crowd) in one batch — for a single asset of any
other subject (props, vehicles, etc.), use [`/agent/mesh`](#3d-mesh---post-agentmesh-2026-10-03)
above instead; both share the same underlying image-gen and 3D-worker code.
Each member is a full pipeline run: a varied full-body photo (Flux.2/ComfyUI,
same image stack as `/agent/image`) → background removal → Hunyuan3D-2.1
shape generation → PBR texture painting → GLB export. Source:
`src/agents/crowdClient.js` (crowd-specific orchestration + prompt variety),
`src/agents/referenceImage.js` + `src/agents/hunyuan3dWorker.js` (shared
with `/agent/mesh`) — the 3D step itself runs `generate_3d_asset.py` in an
isolated `hunyuan3d` conda env (see the AliceBuilder repo's session notes
for the install).

```json
{ "count": 5 }
```

| field | type | default | notes |
|---|---|---|---|
| `count` | integer, 1–20 | required | each member takes roughly 3–5 minutes; count=20 can take well over an hour |

Only `count` varies per request — gender presentation, outfit, and pose are
randomly sampled per member from a fixed internal pool (see `WHO`/`OUTFITS`/
`POSES` in `crowdClient.js`) to keep a crowd visually distinct. Framing is
always fixed (full body, plain white background, centered) since that's
what Hunyuan3D needs for clean reconstruction.

Same async job-polling contract as image/video above, but note: a large
batch can run for well over 30 minutes, so still-`processing` crowd jobs
get a 3-hour sweep ceiling instead of the usual 30-minute one (see
`PROCESSING_JOB_MAX_AGE_MS` in `agent.js`) — only jobs that have actually
finished (`done`/`error`) age out at 30 minutes.

`GET /agent/crowd/<id>` while running:

```json
{ "status": "processing", "progress": { "completed": 2, "total": 5, "current": "member_03" } }
```

On success: `200`, `Content-Type: application/zip`, body = a zip containing,
per member, `<name>.glb` (final textured mesh — this is the one to import
into Unity), `<name>.obj`/`.mtl`/`.jpg` (+ `_metallic.jpg`/`_roughness.jpg`,
the same PBR maps baked into the GLB, left loose in case you want to
re-texture), `<name>_source.png` (the generated reference photo), and
`<name>_preview.png` (a quick offscreen render — open this first to sanity-
check a member without a 3D viewer). A top-level `manifest.json` lists every
member's prompt and whether it succeeded — **a per-member failure doesn't
fail the whole batch**, check `manifest.json` (or the quick `X-Crowd-Summary`
response header, e.g. `"4/5 succeeded"`) if the zip has fewer members than
requested.

**Example (curl):**

```bash
KEY=<ALICE_AGENT_API_KEY>
HOST=https://alice.deviousweb.com/api

id=$(curl -s -X POST $HOST/agent/crowd \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"count": 10}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["job_id"])')

while true; do
  out=$(curl -s $HOST/agent/crowd/$id -H "Authorization: Bearer $KEY")
  echo "$out" | grep -q '"processing"' || break
  echo "$out"
  sleep 20
done
curl -s $HOST/agent/crowd/$id -H "Authorization: Bearer $KEY" -o crowd.zip
unzip crowd.zip -d crowd_members/
```

### Known quality limits

Single-image-to-3D is good enough for a **background** crowd viewed at any
real distance — body/pose/outfit/silhouette all come through clearly. It is
**not** good enough for a close-up/hero character: faces are frequently
distorted (no real depth info from one photo), and texture seams can bleed
slightly on limbs. Don't use this for anything the camera gets close to.

### Errors

Same conventions as image/video — `400` bad input, `502`/`503` generation
or GPU-host failure, `404` unknown/expired job. Unlike image/video, a
per-member failure inside a batch does **not** surface as a job-level
error — the job still reports `done` with however many members succeeded;
check `manifest.json`.
