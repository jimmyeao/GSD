import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT ?? '5000', 10),
  demoMode: process.env.DEMO_MODE === 'true',
  jwtSecret: process.env.JWT_SECRET || null,

  // Public-facing URL (behind NGINX) — used to build OAuth redirect_uri values
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:5000',
  // Session cookie signing secret (HS256). Keep this stable across restarts.
  sessionSecret: process.env.SESSION_SECRET || null,
  // Cookie Domain attribute (leave unset for host-only cookies in dev)
  cookieDomain: process.env.COOKIE_DOMAIN || null,
  // Email added to allowed_emails as admin on first boot if the table is empty
  bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL || null,

  // 32-byte base64 key for AES-256-GCM encryption of mail tokens at rest.
  // If missing AND any mail provider is configured, the server refuses to start.
  mailTokenKey: process.env.MAIL_TOKEN_KEY || null,

  // Bearer token for the LiteLLM gateway in front of vLLM. Unset = no auth
  // header sent (fine for a direct-to-vLLM endpoint during local dev).
  llmGatewayKey: process.env.LLM_GATEWAY_KEY || null,

  // Shared secret for the machine-to-machine agent API (/api/agent/*) —
  // lets an external tool (e.g. OpenHands) call agent capabilities like
  // image generation directly over HTTP, bypassing the cookie-session +
  // CSRF contract the browser-facing REST routes use (an external caller
  // has no session/cookie to present). Unset = the route responds 503
  // rather than silently running unauthenticated.
  agentApiKey: process.env.ALICE_AGENT_API_KEY || null,

  oauth: {
    microsoft: {
      clientId: process.env.MS_CLIENT_ID || '',
      clientSecret: process.env.MS_CLIENT_SECRET || '',
      tenant: process.env.MS_TENANT || 'common',
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    },
  },

  models: {
    // general/coder/mail all point at the LiteLLM gateway (vLLM behind it)
    // by default — model names are the LiteLLM aliases defined in
    // /home/jimmy/litellm/config.yaml, not raw HuggingFace model IDs.
    general: {
      endpoint: process.env.GENERAL_LLM_URL ?? 'http://localhost:4000',
      model: process.env.GENERAL_MODEL ?? 'alice-general',
      timeout: 300_000,
    },
    coder: {
      endpoint: process.env.CODER_LLM_URL ?? 'http://localhost:4000',
      model: process.env.CODER_MODEL ?? 'alice-coder',
      timeout: 300_000,
    },
    // MailAgent uses a tool-calling-reliable model.
    mail: {
      endpoint: process.env.MAIL_LLM_URL ?? process.env.GENERAL_LLM_URL ?? 'http://localhost:4000',
      model: process.env.MAIL_MODEL ?? 'alice-mail',
      timeout: 300_000,
    },
    // Vision-capable model (Ollama qwen2.5vl:7b, behind the same gateway) —
    // used for the generic chat path when a user attaches an image, since
    // none of general/coder/mail above are multimodal.
    vision: {
      endpoint: process.env.VISION_LLM_URL ?? 'http://localhost:4000',
      model: process.env.VISION_MODEL ?? 'alice-vision',
      timeout: 300_000,
    },
    comfyui: {
      endpoint: process.env.COMFYUI_URL ?? 'http://localhost:8188',
      timeout: 120_000,
    },
  },

  mermaid: {
    renderUrl: process.env.MERMAID_RENDER_URL ?? 'https://mermaid.ink/img/',
  },

  memory: {
    // Off by default until the extract→store→retrieve loop is verified manually.
    extractionEnabled: process.env.MEMORY_EXTRACTION_ENABLED === 'true',
  },
  // Mail contact/thread cache-aside — on by default, flip off if staleness complaints outweigh the saved live calls.
  mailCacheEnabled: process.env.MAIL_CACHE_ENABLED !== 'false',

  cors: {
    origin: process.env.CORS_ORIGIN ?? '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  },
};
