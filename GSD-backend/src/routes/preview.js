import { Router } from 'express';
import { stmts } from '../db.js';
import { expressAuth } from '../auth.js';
import { inspectContainer } from '../services/containerService.js';
import { request as httpRequest } from 'node:http';

const router = Router();
router.use(expressAuth);

// ── Proxy to container — with path ───────────────────────────────

router.all('/:containerId/*', async (req, res) => {
  try {
    const container = stmts.getContainer.get(req.params.containerId, req.user.id);
    if (!container) return res.status(404).json({ error: 'Container not found' });

    const info = await inspectContainer(container.docker_id);
    if (!info.running) return res.status(503).json({ error: 'Container is not running' });

    const port = parseInt(req.query.port) || 3000;
    const targetPath = req.params[0] || '/';

    const proxyReq = httpRequest({
      hostname: info.ip,
      port,
      path: targetPath + (req._parsedUrl.search || ''),
      method: req.method,
      headers: { ...req.headers, host: `${info.ip}:${port}` },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).json({ error: `Preview proxy error: ${err.message}` });
      }
    });

    req.pipe(proxyReq);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── Root path redirect ───────────────────────────────────────────

router.all('/:containerId', (req, res) => {
  res.redirect(`${req.originalUrl}/`);
});

export default router;
