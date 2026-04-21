import { Router } from 'express'
import { chatBusiness } from './chatController'

const router = Router()

// POST /chat/business — alias legado; prefira /brain/chat
router.post('/business', chatBusiness)

export default router
