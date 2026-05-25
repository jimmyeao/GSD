 ---
  IDE + Docker Deployment — Architecture Report

  Recommended: Monaco Editor + dockerode

  Not code-server (too heavy, separate auth, one process per user). Instead, embed Monaco Editor directly as a JS library in the existing Alice frontend — no new
  ports, no iframes, inherits your JWT auth automatically.

  What you'd get

  - Code view in Alice — tab between Chat and Code modes
  - Monaco editor with syntax highlighting, IntelliSense, multi-cursor, minimap
  - File tree panel + terminal panel for container output
  - "Open in Editor" buttons on code blocks from CoderAgent
  - Docker containers per project — isolated, resource-limited, auto-cleaned
  - Live preview of web apps through a reverse proxy

  Tech stack (minimal additions)

  ┌────────────┬────────────────────────────┬─────────────────────────────────┐
  │ Component  │          Solution          │               Why               │
  ├────────────┼────────────────────────────┼─────────────────────────────────┤
  │ Editor     │ Monaco Editor (CDN, 3-5MB) │ JS library, no new process, MIT │
  ├────────────┼────────────────────────────┼─────────────────────────────────┤
  │ Containers │ dockerode (npm)            │ Mature Docker API client        │
  ├────────────┼────────────────────────────┼─────────────────────────────────┤
  │ Files      │ Express REST routes        │ Extends existing backend        │
  ├────────────┼────────────────────────────┼─────────────────────────────────┤
  │ Terminal   │ Socket.IO (existing)       │ Container logs streamed to chat │
  └────────────┴────────────────────────────┴─────────────────────────────────┘

  Key architecture decisions

  - Monaco over code-server: 50MB browser RAM vs 500MB server RAM per user. No auth proxy needed. No iframes.
  - Per-user workspaces: /data/workspaces/{userId}/{projectId}/ bind-mounted into containers
  - Pre-built Docker images: alice-node:20, alice-python:3.12 — fast startup
  - Container limits: 512MB RAM, 1 CPU, 30-minute timeout, max 3 per user
  - Chat-to-editor bridge: CoderAgent code blocks get "Open in Editor" button that saves to workspace

  New backend pieces

  - src/routes/workspace.js — file CRUD API with path sanitization
  - src/routes/sandbox.js — container create/start/stop/status
  - src/services/containerService.js — dockerode orchestration, log streaming
  - 2 new DB tables: projects, containers

  New frontend pieces

  - editor.js — Monaco wrapper with tab management
  - fileTree.js — collapsible file tree
  - terminal.js — container output with ANSI color
  - codeView.js — layout orchestrator

  Estimated effort: 8-12 days

  Risks

  - Docker socket = root-equivalent (mitigate: dedicated user in docker group)
  - No VS Code extensions in Monaco (but built-in support is solid for TS/JS/Python)
  - No full terminal (stdout/stderr only, not interactive PTY — can add xterm.js later)
  - GPU access needs NVIDIA Container Toolkit