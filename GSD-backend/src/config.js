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
    general: {
      endpoint: process.env.GENERAL_LLM_URL ?? 'http://localhost:8001',
      model: process.env.GENERAL_MODEL ?? 'default',
      // Qwen3 thinking models reason before responding — allow 5 minutes
      timeout: 300_000,
    },
    coder: {
      endpoint: process.env.CODER_LLM_URL ?? 'http://localhost:8000',
      model: process.env.CODER_MODEL ?? 'qwen3-coder-80b',
      // 80B coder may need up to 10 minutes for complex tasks
      timeout: 600_000,
    },
    // MailAgent uses a larger, tool-calling-reliable model. Falls back to the
    // general endpoint so the same Ollama host serves it.
    mail: {
      endpoint: process.env.MAIL_LLM_URL ?? process.env.GENERAL_LLM_URL ?? 'http://localhost:11434',
      model: process.env.MAIL_MODEL ?? 'qwen2.5:72b-instruct-q4_K_M',
      // Cold-load + multi-turn tool loops on a 72B can take a while
      timeout: 900_000,
    },
    comfyui: {
      endpoint: process.env.COMFYUI_URL ?? 'http://localhost:8188',
      timeout: 120_000,
    },
  },

  mermaid: {
    renderUrl: process.env.MERMAID_RENDER_URL ?? 'https://mermaid.ink/img/',
  },

  cors: {
    origin: process.env.CORS_ORIGIN ?? '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  },
};
