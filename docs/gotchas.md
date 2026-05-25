# Alice — gotchas & hard-won lessons

A grab-bag of things that broke us and the fixes that worked. Read once
before touching the relevant subsystem.

---

## Reverse proxy (NGINX Proxy Manager → Cloudflare → backend)

### Symptom: whole site goes 525 "SSL handshake failed" after editing a proxy host
You added `Connection $connection_upgrade` to a location block. `$connection_upgrade` is a `map` variable that must live in the nginx `http{}` context — NPM doesn't expose that context in its UI. When nginx can't resolve it, the config is invalid, NPM stops serving the host, and Cloudflare (in Full-strict mode) reports 525.

**Fix:** don't use the map. Hardcode `Connection "upgrade"` in every `/api/`-style location block that needs WebSocket upgrades. Remember `proxy_http_version 1.1;` on the same block — the default is HTTP/1.0 which silently strips the `Upgrade` header.

```nginx
location /api/ {
    proxy_pass http://192.168.0.82:5000/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    # ...rest of headers...
    proxy_buffering         off;
    proxy_request_buffering off;
}
```

### Symptom: Socket.IO chat works, noVNC WebSocket fails with code 1006
Socket.IO transparently falls back to HTTP long-polling when WebSockets are blocked — so it *looks* like WS is fine. Other WS clients (noVNC, raw ws) have no fallback.

**Check order:**
1. Cloudflare dashboard → Network → **WebSockets** is ON (often off on free-tier accounts).
2. NPM `/api/` block has `proxy_http_version 1.1` + `Upgrade`/`Connection` headers.
3. Backend journal shows `[preview-proxy]` log on the failed attempt — if empty, request never reached backend, so it's a proxy issue not a backend bug.

### Symptom: noVNC `ws://` path resolves to a route the proxy doesn't know
noVNC's `path=` query param is used verbatim as the WS URL path. If your backend is under `/api/`, set `path=api/preview/<id>/websockify`, not `path=preview/<id>/websockify`. Otherwise the browser's WS lands at `/preview/*` which NPM/Cloudflare won't route.

---

## Docker — LÖVE runner image (Ubuntu 24.04 arm64)

### Symptom: `apt-get install love` fails with dpkg error
Ubuntu 24.04's `love` deb has a broken postinst — `update-alternatives` references a manpage (`love-11.5.6.gz`) the package doesn't actually ship. The RUN instruction fails, image build fails, image never tagged, backend falls through to `docker pull` which 404s on a registry that doesn't have our local-only image.

**Fix** (in Dockerfile, *before* the apt-get install):
```dockerfile
RUN mkdir -p /usr/share/man/man6 \
 && touch /usr/share/man/man6/love-11.5.6.gz
```

### Symptom: container exits 1 with "Could not open device" or X BadMatch
SDL (which LÖVE uses) crashes on missing ALSA/PulseAudio, and a window manager inside the container races with LÖVE's own GL window for input focus.

**Fix** (env vars in Dockerfile):
```dockerfile
ENV SDL_AUDIODRIVER=dummy
ENV SDL_VIDEODRIVER=x11
```

Also drop `fluxbox` (or any WM) from `start.sh`. LÖVE creates its own top-level window; an extra WM just causes `X_SetInputFocus BadMatch`.

### Symptom: `[preview-proxy] error: getaddrinfo ENOTFOUND :6080`
`inspectContainer` reads the container IP from the `alice-net` network. If you create a container without attaching it to `alice-net`, the IP comes back empty.

**Fix:** set `NetworkMode: 'alice-net'` in the container HostConfig (and call the equivalent of `ensureNetwork()` first so the bridge exists).

### Symptom: `connect ECONNREFUSED <container-ip>:6080` on first load, works on refresh
Race: backend returned the preview URL before websockify inside the container had started listening. The first iframe load hits a dead port.

**Fix:** poll the container port with a HEAD request loop before returning the URL from `/love/run` (15 s ceiling). See `services/loveRunner.js`.

---

## Ollama / LLM routing

### Symptom: request hangs for 5 min then returns 500 from Ollama
Ollama's KV cache size is set at model-load time from `num_ctx`. For qwen3 models the default is the model's `n_ctx_train` (40960) — which means every prompt eval iterates over 40k positions per token whether or not you're using them. Big model + big KV cache + long tool-call history = minutes per step.

**Fix:** explicitly set `num_ctx` in the request `options` block to something realistic (e.g., 16384 or 32768). Don't rely on the model's default. Also, `num_ctx` changes require the model to be **unloaded** before the next request — send `POST /api/generate` with `keep_alive: 0` to force a reload with new options.

### Symptom: Qwen3.6 or other "thinking" model produces blank output in the chat
The `/v1/chat/completions` OpenAI-compat endpoint doesn't reliably honor `think: false` for hybrid thinking models. The model spends its entire token budget on internal reasoning, then terminates with zero *content* tokens. Frontend sees no tokens → no bubble renders.

**Fix:** route the request through Ollama's native `/api/chat` (our `streamCompletion` with `noThink: true`). That endpoint does strip reasoning as expected.

### Symptom: model emits only ONE tool call when prompted to emit many
Some Ollama tool-calling variants (particularly Qwen3 32B) emit a single tool call per response no matter how hard you prompt, especially for mutation-style tools.

**Fix:** use a **dispatcher** tool that accepts an array. Model emits ONE tool call containing N items; the server fans out to N approval cards (or writes, or whatever). This is what MailAgent's `plan_mutations` does. Much more reliable than telling the model to emit parallel tool calls.

---

## CoderAgent file-write path

### Symptom: empty files appear where the agent "wrote" code
The model emitted an empty filename-tagged fence (e.g. ` ```js:foo.js ` with nothing between fences) while claiming to "read" or "check" the file. The original parser would overwrite the target file with empty content.

**Fix (in place now):** the parser skips writes where the body is empty/whitespace, contains placeholder markers ("...rest of file", "<placeholder>"), or would shrink a >200 B file to <20 B. Emits `code:writes-skipped` so the UI can surface it.

### Symptom: agent says "let me read the file" but nothing happens
The CoderAgent has no `read_file` tool. It gets file contents via **inlined contents in its system prompt** — the backend walks the workspace each turn and concatenates file bodies (size-capped).

**Watch for:**
- Files over `PER_FILE_BYTES` (currently 28 KB) are truncated with a `…[truncated]` marker. If you see the agent refusing to emit edits for specific files, they're probably being truncated — either raise the cap or tell the user to split the file.
- `.env*` and anything under `node_modules/`/`.git/`/`dist/` is deliberately excluded from inlining (secrets + noise).

### Symptom: SEARCH/REPLACE edit fails to match
Whitespace and indentation must be **character-for-character exact**. The model will frequently produce a SEARCH block with subtly different indentation than the real file. The server rejects with "SEARCH text not found" and the edit doesn't apply.

**Convention:** empty SEARCH means "create new file". The line-based parser in `server.js` (`parseEditBlocks`) handles this as a create intent: if the target file doesn't exist (or is <=20 B) it gets created with the REPLACE content.

---

## Docker / Ollama / infra tips

- **Ollama's `OLLAMA_KEEP_ALIVE`** keeps models warm between requests — but holding many models wastes VRAM. If something feels slow, `curl localhost:11434/api/ps` shows what's resident.
- **GB10 is arm64** and uses unified memory (121 GiB shared between CPU and GPU) — classic "VRAM exhaustion" doesn't apply, but scheduling contention when many models are loaded still hurts. Keep only the models you need.
- **Unload after config changes:** changes to `num_ctx`, KV cache type, etc. only take effect after the model is unloaded. `POST /api/generate {model: "...", keep_alive: 0}`.

---

## Where each fix lives
| Subsystem | File |
|---|---|
| LÖVE Dockerfile | `alice-backend/docker/love-runner/Dockerfile` |
| LÖVE startup | `alice-backend/docker/love-runner/start.sh` |
| Container orchestration | `alice-backend/src/services/loveRunner.js` |
| Preview HTTP + WS proxy | `alice-backend/src/routes/preview.js` |
| WS upgrade router | `alice-backend/src/server.js` (`httpServer.on('upgrade')`) |
| CoderAgent file-write guards + SEARCH/REPLACE parser | `alice-backend/src/server.js` (`parseEditBlocks`, `code:message` handler) |
| Ollama client (think/noThink, num_ctx) | `alice-backend/src/agents/llmClient.js` |
| MailAgent batch dispatcher | `alice-backend/src/agents/mailAgent.js` (`plan_mutations`) |
| NPM reverse-proxy template | reverse-proxy UI — not in repo |
