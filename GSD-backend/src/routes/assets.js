import { Router } from 'express';
import { stmts } from '../db.js';
import { expressAuth, verifyToken } from '../auth.js';
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

// List assets (requires auth header)
router.get('/', expressAuth, (req, res) => {
  const rows = stmts.listAssets.all(req.user.id);
  res.json({ assets: rows });
});

// Serve an asset file (supports Bearer header OR ?token= query param for downloads)
router.get('/:id/file', (req, res) => {
  // Try auth header first, then query param
  let user = null;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try { const p = verifyToken(header.slice(7)); user = { id: p.sub, username: p.username }; } catch {}
  }
  if (!user && req.query.token) {
    try { const p = verifyToken(req.query.token); user = { id: p.sub, username: p.username }; } catch {}
  }
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  const asset = stmts.getAsset.get(req.params.id, user.id);
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

// Delete an asset
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
