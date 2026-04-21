import { Router } from 'express'
import {
  listConversations,
  listMessages,
  sendManualMessage,
  pauseAi,
  resumeAi,
} from './conversationController'

const router = Router()

// GET /conversations
router.get('/', listConversations)

// GET /conversations/:id/messages
router.get('/:id/messages', listMessages)

// POST /conversations/:id/messages
router.post('/:id/messages', sendManualMessage)

// POST /conversations/:id/pause-ai
router.post('/:id/pause-ai', pauseAi)

// POST /conversations/:id/resume-ai
router.post('/:id/resume-ai', resumeAi)

export default router
