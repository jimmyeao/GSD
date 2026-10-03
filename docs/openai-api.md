# Alice OpenAI-compatible API

Lets any tool that already speaks the OpenAI Chat/Images API — LiteLLM, Open
WebUI, the `openai` SDK, Continue, etc. — call Alice directly with zero
custom integration code. Point the client's base URL at Alice and use it
exactly like you'd use `https://api.openai.com`.

Source: `alice-backend/src/routes/openai.js`, mounted at `/v1` (behind
NGINX/Cloudflare this is `https://<your-alice-host>/api/v1/*` — same prefix
stripping as [`/agent/*`](agent-api.md)).

## Auth

Same shared secret as the [agent API](agent-api.md):

```
Authorization: Bearer <ALICE_AGENT_API_KEY>
X-API-Key: <ALICE_AGENT_API_KEY>
```

Most OpenAI client libraries only know how to send `Authorization: Bearer
<key>` — set the client's "API key" to `ALICE_AGENT_API_KEY` and its base URL
to `https://<your-alice-host>/api/v1`.

## `GET /v1/models`

```json
{
  "object": "list",
  "data": [
    { "id": "alice-general", "object": "model", "owned_by": "alice" },
    { "id": "alice-coder", "object": "model", "owned_by": "alice" },
    { "id": "alice-mail", "object": "model", "owned_by": "alice" },
    { "id": "alice-vision", "object": "model", "owned_by": "alice" },
    { "id": "alice-image-auto", "object": "model", "owned_by": "alice" },
    { "id": "alice-image-flux2", "object": "model", "owned_by": "alice" }
  ]
}
```

## `POST /v1/chat/completions`

A thin auth-swapping proxy onto the same LiteLLM gateway
`config.models.*.endpoint` already points at — the gateway already speaks
real OpenAI-compat, so requests/responses pass through essentially
unmodified. This means it supports whatever the gateway supports: tool
calls, `reasoning_effort`, etc.

Supports both `stream: false` (single JSON response) and `stream: true`
(Server-Sent Events, forwarded byte-for-byte from upstream).

```bash
KEY=<ALICE_AGENT_API_KEY>
HOST=https://alice.deviousweb.com/api

curl $HOST/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{
    "model": "alice-general",
    "messages": [{"role": "user", "content": "Say hi in five words."}]
  }'
```

`model` selects the LiteLLM alias — use one of the ids from `GET /v1/models`
(`alice-general`, `alice-coder`, `alice-mail`, `alice-vision`).

## `POST /v1/images/generations`

Wraps the same ComfyUI pipeline [`POST /agent/image`](agent-api.md) uses, but
responds **synchronously** (blocks until the image is ready) to match the
real OpenAI contract, instead of `/agent/image`'s async job-polling.

```json
{
  "prompt": "a red panda wearing a tiny wizard hat, studio lighting",
  "model": "alice-image-auto",
  "size": "1024x1024",
  "n": 1
}
```

| field | type | default | notes |
|---|---|---|---|
| `prompt` | string | required | |
| `model` | `"alice-image-auto"` \| `"alice-image-flux2"` | `"alice-image-auto"` | `flux2` = Flux.2 Dev (slower, higher quality) |
| `size` | `"WxH"` string | `1024x1024` (i.e. ComfyUI's default) if omitted | any width/height ComfyUI accepts |
| `n` | number | `1` | capped at 4; images are generated **sequentially**, not in parallel |
| `response_format` | `"b64_json"` | `"b64_json"` | **only `b64_json` is supported** — Alice doesn't persist generated media (see [agent-api.md](agent-api.md)), so there's no stable URL to hand back like real OpenAI's default `"url"` format |

Response (standard OpenAI images shape):

```json
{ "created": 1234567890, "data": [{ "b64_json": "..." }] }
```

### ⚠️ Cloudflare timeout risk

`/agent/image` and `/agent/video` moved to async job-polling specifically
because Cloudflare's edge kills proxied HTTP responses past ~100–125s (see
[agent-api.md](agent-api.md)), and Flux.2 Dev generation can take several
minutes. `/v1/images/generations` is intentionally synchronous instead — that
matches what OpenAI clients expect — but a request routed through the same
Cloudflare-fronted domain **will still get killed** if generation runs long,
same as any other proxied request. This is a known, deliberate tradeoff for
compatibility, not a bug:

- The default `auto` model is fast enough in practice to usually stay under
  that window (verified: ~30–45s end to end including a ComfyUI cold start).
- `flux2` (up to 10 minutes) is at real risk of hitting the Cloudflare
  ceiling — prefer calling it over a direct (non-Cloudflare) network path
  such as Tailscale, or use `/agent/image` with `imageModel: "flux2"` and
  poll instead.

### Side effect: pauses the shared LLM backend

Like `/agent/image`, this calls `ensureComfyRunning()` — which pauses
`vllm-laguna` (and therefore chat across every app on this box — AliceBuilder,
this Alice app, TheiaCast) for the duration of the generation, then resumes it
automatically afterward. See `ARCHITECTURE.md`'s "ComfyUI mode switching"
section in the AliceBuilder repo for the full mechanism. Don't call this
endpoint in a tight loop expecting concurrent chat availability.

## Not implemented

- `/v1/completions` (legacy non-chat completions)
- `/v1/embeddings`
- `/v1/audio/*` (Alice has its own `/tts` route, not OpenAI-shaped)
- Video generation has no OpenAI standard endpoint to mirror — use
  [`/agent/video`](agent-api.md) directly.

## Errors

Same status-code conventions as the rest of Alice's API: `400` for bad input,
`401`/`503` for missing/invalid auth or an unconfigured key, `502` for a
generation/upstream failure, `503` if the LLM backend or ComfyUI/GPU host was
offline. Error bodies follow OpenAI's `{ "error": { "message", "type" } }`
shape rather than Alice's plain `{ "error": "..." }` shape used elsewhere, so
existing OpenAI client error-handling code works unmodified.
