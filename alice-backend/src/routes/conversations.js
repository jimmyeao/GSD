import { Router } from 'express';
import { stmts } from '../db.js';
import { expressAuth } from '../auth.js';

const router = Router();
router.use(expressAuth);

// List conversations for the logged-in user
router.get('/', (req, res) => {
  const rows = stmts.listConversations.all(req.user.id);
  res.json({ conversations: rows });
});

// Create a new conversation
router.post('/', (req, res) => {
  const title = (req.body?.title || 'New Chat').slice(0, 120);
  const agentId = req.body?.agent_id || null;
  const result = stmts.insertConversation.run(req.user.id, title, agentId);
  const conv = stmts.getConversation.get(result.lastInsertRowid, req.user.id);
  res.status(201).json({ conversation: conv });
});

// Get messages for a conversation
router.get('/:id/messages', (req, res) => {
  const conv = stmts.getConversation.get(req.params.id, req.user.id);
  if (!conv) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  const messages = stmts.listMessages.all(conv.id);
  res.json({ messages });
});

// Rename a conversation
router.patch('/:id', (req, res) => {
  const title = req.body?.title;
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'Title is required' });
  }
  const changes = stmts.updateConversationTitle.run(title.slice(0, 120), req.params.id, req.user.id);
  if (changes.changes === 0) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  const conv = stmts.getConversation.get(req.params.id, req.user.id);
  res.json({ conversation: conv });
});

// Delete a conversation
router.delete('/:id', (req, res) => {
  const changes = stmts.deleteConversation.run(req.params.id, req.user.id);
  if (changes.changes === 0) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  res.json({ deleted: true });
});

export default router;
