import { Router } from 'express'
import { chat } from './brain.controller'

const router = Router()

// POST /brain/chat
router.post('/chat', chat)

export default router
