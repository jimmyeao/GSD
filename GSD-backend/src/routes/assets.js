import { Router } from 'express';
import { stmts } from '../db.js';
import { expressAuth, verifyToken, COOKIES } from '../auth.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_ROOT = join(__dirname, '..', '..', 'data', 'assets');

const MIME_TYPES = {
  video: 'video/mp4',
  image: 'image/png',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const router = Router();

// List assets (requires auth cookie)
router.get('/', expressAuth, (req, res) => {
  const rows = stmts.listAssets.all(req.user.id);
  res.json({ assets: rows });
});

// Serve an asset file. Accepts either the session cookie (preferred)
// or a ?token= query param (legacy, for direct-download anchor tags).
router.get('/:id/file', (req, res) => {
  let userId = null;

  // Preferred: session cookie
  const cookieToken = req.cookies?.[COOKIES.session];
  if (cookieToken) {
    try { const p = verifyToken(cookieToken); userId = p.sub; } catch { /* fallthrough */ }
  }
  // Legacy: query-param token (same JWT, used for <a href> downloads)
  if (!userId && req.query.token) {
    try { const p = verifyToken(req.query.token); userId = p.sub; } catch { /* ignore */ }
  }
  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  const asset = stmts.getAsset.get(req.params.id, userId);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  const filepath = join(ASSETS_ROOT, String(asset.user_id), asset.filename);
  if (!existsSync(filepath)) return res.status(404).json({ error: 'File not found on disk' });

  res.setHeader('Content-Type', MIME_TYPES[asset.type] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  if (asset.type === 'slide') {
    res.setHeader('Content-Disposition', `attachment; filename="${asset.filename}"`);
  }
  res.sendFile(filepath);
});

// Delete an asset (mutating → CSRF protected globally)
router.delete('/:id', expressAuth, (req, res) => {
  const asset = stmts.getAsset.get(req.params.id, req.user.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  // Delete file from disk
  const filepath = join(ASSETS_ROOT, String(asset.user_id), asset.filename);
  try { unlinkSync(filepath); } catch { /* file may already be gone */ }

  // Delete DB row
  stmts.deleteAsset.run(req.params.id, req.user.id);
  res.json({ deleted: true });
});

export default router;
