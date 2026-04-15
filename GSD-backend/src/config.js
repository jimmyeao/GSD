import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT ?? '5000', 10),
  demoMode: process.env.DEMO_MODE === 'true',
  jwtSecret: process.env.JWT_SECRET || null,

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
    methods: ['GET', 'POST'],
  },
};
