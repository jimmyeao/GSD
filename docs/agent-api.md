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
| `imageModel` | `"auto"` \| `"flux2"` \| `"krea2"` | `"auto"` | `flux2` = Flux.2 Dev, `krea2` = Krea 2 Turbo (~1MP native: 1024², 1368×768, 768×1368) |
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
| `imageModel` | `"auto"` \| `"flux2"` \| `"krea2"` | `"auto"` | only used with `prompt` |
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

## Music — `POST /agent/music` (2026-10-05)

Generates a music track with **ACE-Step 1.5 XL Turbo** — instrumental, or
with sung vocals if you pass `lyrics`. Same model/graph the in-app
MusicAgent uses. Source: `src/agents/musicClient.js` (`generateMusic`).

```json
{
  "prompt": "ambient, calm piano, soft pads, 80 BPM",
  "lyrics": "",
  "durationSeconds": 30
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `prompt` | string | **required** | style/genre/instrument tags |
| `lyrics` | string | `""` | empty = instrumental |
| `durationSeconds` | number | `30` | 1–240 |

## Sound effects — `POST /agent/sfx` (2026-10-05)

Generates a sound effect, ambience bed, or one-shot with **Stable Audio 3
Medium** (stereo, 44.1kHz). Source: `src/agents/musicClient.js`
(`generateSfx`). Describe the source, material, space, and how it evolves
over time for best results — e.g. *"heavy wooden door creaking open slowly
in a stone castle hallway, reverberant"*.

```json
{ "prompt": "glass bottle shattering on concrete, close-up, dry", "durationSeconds": 3 }
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `prompt` | string | **required** | sound description |
| `durationSeconds` | number | `5` | 1–120 — impacts 1–3s, actions 3–6s, ambience 6–15s+ |

### Response (both)

`POST` → `202 { "job_id": "...", "status_url": "/agent/music/<id>" }` (or
`/agent/sfx/<id>`). Poll the status URL: `{"status":"processing"}` until
done, then `200`, `Content-Type: audio/flac`, body = the raw FLAC bytes.

```bash
id=$(curl -s -X POST $HOST/agent/sfx \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"prompt": "thunder rumbling in the distance, heavy rain on a tin roof", "durationSeconds": 10}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["job_id"])')

while curl -s $HOST/agent/sfx/$id -H "Authorization: Bearer $KEY" | grep -q '"processing"'; do sleep 5; done
curl -s $HOST/agent/sfx/$id -H "Authorization: Bearer $KEY" -o sfx.flac
```

### Errors

`400` for a missing `prompt`, non-string `lyrics`, or out-of-range
`durationSeconds`. `502` for a generation failure. `503` if ComfyUI/the GPU
host was offline. `404` for an unknown/expired `job_id`.

---

## Talking head — `POST /agent/talking-head` (2026-10-05)

Generates one presenter clip — a person speaking to camera — with
**LTX-2.3 + ID-LoRA**. Source: `src/agents/talkingHeadClient.js` (mirrors
ComfyUI's official "LTX-2.3: ID LoRA" template).

Important: this is **not** lip-sync to a supplied audio track. LTX generates
the speech itself (jointly with the video, so the lips match by
construction), saying the `speech` text. `voiceRef` only clones the
*voice* — a ~5s clean speech sample works best. The portrait is pinned as
the literal first frame, so the face stays consistent; reuse the same
portrait + voice sample + `seed` across clips for a consistent presenter.

```json
{
  "portrait": { "name": "presenter.png", "dataUrl": "data:image/png;base64,..." },
  "voiceRef": { "name": "voice.wav", "dataUrl": "data:audio/wav;base64,..." },
  "visual": "A static medium close-up of a woman with auburn hair in a navy blazer, in a softly lit studio. She looks at the camera and speaks warmly, mouth moving naturally. The camera stays still.",
  "speech": "Hi, I'm Alice. Let me show you how it works.",
  "sounds": "Clear, warm British female voice, close to the microphone. Quiet room tone.",
  "durationSeconds": 8
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `portrait` | `{name, dataUrl}` | **required** | presenter image, pinned as the first frame |
| `voiceRef` | `{name, dataUrl}` | **required** | ~5s speech sample whose voice is cloned |
| `visual` | string | **required** | shot, appearance, setting, action |
| `speech` | string | **required** | exact words — keep to ~25 words / ~10s (LTX drifts past that) |
| `sounds` | string | `""` | vocal style + ambience |
| `durationSeconds` | number | `8` | 2–15 |
| `width` / `height` | number | `1280` / `720` | LTX rounds to multiples of 32 (720 → 704) |
| `seed` | integer | random | reuse for consistency across clips |

`POST` → `202 { job_id, status_url: "/agent/talking-head/<id>" }`; poll until
`200`, `Content-Type: video/mp4` (25 fps, with audio). Speed on this box:
~6 min per ~9s clip, plus a one-off ~8 min model load if LTX-2.3 isn't
already loaded.

### Errors

`400` for missing/invalid `portrait`/`voiceRef`/`visual`/`speech` or
out-of-range `durationSeconds`. `502` generation failure, `503` ComfyUI
offline, `404` unknown/expired `job_id`.

---

## Explainer / promo video — `POST /agent/explainer` (2026-10-05)

Turns a brief into a finished explainer or product-promo MP4, end to end on
local models. Source: `src/agents/explainer/`.

This endpoint is **one-shot** (brief in, video out). The web UI's 🎞️
Explainer agent runs the same pipeline **conversationally**
(`session.js`): it reads the brief's links, looks at attached images, asks
a few questions, then shows a storyboard table plus a ~1 min draft
**animatic** (real voiceover/layouts/attachments; presenter and AI
backgrounds as placeholders) and only renders the full video once you reply
**approve**. Further feedback revises the storyboard; unchanged media is
reused.

Any `http(s)` links in the brief are fetched (plus up to 3 same-site
product pages — features/about/pricing…) and given to the planner as source
material; private/loopback addresses are refused.

| Step | What runs |
|---|---|
| plan | Laguna (local LLM) → scenes: spoken lines, headlines, a layout per scene, background-image ideas, palette/font, music prompt. Validated + repaired in code (scene/presenter caps, ~10s line limit, stats must use numbers that appear in the brief). |
| voice | Kokoro reads every line — real durations drive the whole timeline |
| media | one ComfyUI session: Krea 2 presenter portrait + backgrounds, LTX-2.3 ID-LoRA presenter clips, ACE-Step music bed, Stable Audio 3 transition sfx |
| captions | whisper word timings from the audio that actually plays |
| compose | HyperFrames composition: timeline, media, captions and audio mix built in code; each scene's graphics from a layout library (`bullets`, `stat`, `steps`, `compare`, `statement`, `showcase`, `title`, `cta`). Captions use the script's exact words (so product names are spelled right), timed by whisper |
| render | `hyperframes check` + `hyperframes render` → 1920×1080 MP4 |

Every media step is best-effort: a failed presenter clip turns that scene
into a narrated one (its Kokoro read already exists), a failed background
falls back to a gradient, missing music/sfx are skipped — reported in
`warnings`.

```json
{
  "brief": "Explainer for PulseBoard, an analytics dashboard for small e-commerce teams. Connects to Shopify and Stripe in two clicks, replaces weekly spreadsheet reporting, sends a Monday summary to Slack. Beta teams cut reporting time by 87 percent. Free 14-day trial at pulseboard.example.",
  "format": "explainer",
  "presenter": true,
  "maxPresenterScenes": 2,
  "targetSeconds": 45
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `brief` | string | **required** | 10–4000 chars. Include product name, audience, benefits, any real numbers, and the call to action — the planner is told not to invent facts, and stats not found in the brief are dropped |
| `format` | `"explainer"` \| `"promo"` | `"explainer"` | |
| `presenter` | boolean | `true` | `false` = voiceover-only |
| `maxPresenterScenes` | integer | `2` | 0–3; each adds ~6 min |
| `targetSeconds` | number | `45` | 15–120 (approximate — real length comes from the voiceover) |
| `creative` | boolean | `false` | let the LLM write each scene's graphics as free-form HyperFrames HTML, gated by `hyperframes check`; any scene that fails falls back to its layout. Slower and less predictable |
| `voice` | string | auto | Kokoro voice id (e.g. `bf_alice`, `bm_george`); default is picked from the presenter description |
| `images` | `[{name, dataUrl}]` | `[]` | up to 8 png/jpeg/webp/gif (≤10MB each). The vision model classifies each as logo / screenshot / photo: the logo goes on the title + CTA cards, screenshots/photos are shown in "showcase" scenes (browser-frame, beside the headline) instead of AI backgrounds |

`POST` → `202 { job_id, status_url: "/agent/explainer/<id>" }`. While
running, `GET` returns `{ "status": "processing", "progress": "<latest step>", "log": [...] }`.
When done: `200`, `Content-Type: video/mp4`, with an `X-Explainer-Meta`
header (URL-encoded JSON: `title`, per-scene `source` (`layout`/`llm`),
`warnings`).

Typical time: ~4 min with no presenter, ~16 min with two presenter scenes.

```bash
id=$(curl -s -X POST $HOST/agent/explainer \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"brief": "Promo for BrewBuddy, a smart coffee scale that times your pour-over and logs every brew. Launch price 59 pounds at brewbuddy.example.", "format": "promo", "presenter": false, "targetSeconds": 25}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["job_id"])')

while curl -s $HOST/agent/explainer/$id -H "Authorization: Bearer $KEY" | grep -q '"processing"'; do sleep 20; done
curl -s $HOST/agent/explainer/$id -H "Authorization: Bearer $KEY" -o promo.mp4
```

Each job's HyperFrames project is kept on the server under
`alice-backend/data/explainers/<job_id>/` (`plan.json`, `assets.json`,
`index.html`, `compositions/`, `assets/`, `out.mp4`) — it can be opened in
HyperFrames Studio, or re-rendered after editing `plan.json` without
regenerating any media via `recomposeExplainer(<job_id>)` in
`src/agents/explainer/pipeline.js` (~25s).

### Remote GPU workers

`COMFY_REMOTE_WORKERS=name=url[,name2=url2]` (in `alice-backend/.env`) adds
always-on ComfyUI machines, e.g. `laptop=http://192.168.0.144:8188`.
Presenter clips (`/agent/talking-head` and explainer presenter scenes) go
to the first one that is reachable, idle, and has the required model files
(read from its `/object_info`; BF16 or fp8 LTX-2.3 checkpoint), otherwise
they run on the local GPU. Jobs on a remote worker don't pause the local
LLM, and in explainers they run in parallel with the local GPU's images/
music/sfx. Source: `src/comfyWorkers.js`.

### HyperFrames Studio (web editor)

Finished videos in the web UI's Explainer conversations include an **Open
in HyperFrames Studio** link: the full HyperFrames editor (timeline, text,
timing, animation, block catalog) on the video's own project. Reply
**render my edits** in the conversation to render it exactly as edited;
storyboard revisions warn before overwriting Studio edits.

Studio runs at its own origin because it uses root-absolute `/api/…` paths:
`STUDIO_PUBLIC_URL` (default `https://studio.alice.deviousweb.com`), which
the edge proxy routes to `STUDIO_PORT` (default `5010`) on `STUDIO_HOST`
(default `HOST`). The backend's proxy there admits only a signed,
single-use, 10-minute link minted for the conversation's owner, then a
project-scoped HttpOnly cookie (8h); each project's Studio is started on
demand on `127.0.0.1:3470-3475` and stopped after 30 min idle. Studio uses
Server-Sent Events (no WebSockets). `STUDIO_DISABLED=1` turns it off.
Source: `src/agents/explainer/studio.js`.

### Server setup (one-off, already done on the GPU box)

HyperFrames needs Node 22+ while Alice runs on Node 20, so it's a separate
pinned install, resolved by `src/agents/explainer/hyperframesCli.js`:

```bash
fnm install 22
mkdir -p ~/.local/share/alice-hyperframes && cd ~/.local/share/alice-hyperframes
echo '{"private":true}' > package.json
fnm exec --using=22 npm i hyperframes@0.8.134 gsap@3.14.2
```

Plus static aarch64 `ffmpeg`/`ffprobe` in `~/.local/bin`, and the snap
Chromium as the render browser (`HYPERFRAMES_BROWSER_PATH`, default
`/snap/bin/chromium` — the puppeteer-cached Chrome builds on this box are
x86-64 and won't run). Overrides: `HYPERFRAMES_HOME`, `HYPERFRAMES_NODE`,
`FFPROBE_BIN`.

### Errors

`400` for an invalid `brief`/`format`/`maxPresenterScenes`/`targetSeconds`/`voice`.
`502` pipeline failure (`error` + `log`), `503` ComfyUI offline, `404`
unknown/expired `job_id`.

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
