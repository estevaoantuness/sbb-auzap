import { Router } from 'express'
import { list, get, create, update, dispatch } from './campaigns.controller'

const router = Router()

// GET /campaigns
router.get('/', list)

// GET /campaigns/:id
router.get('/:id', get)

// POST /campaigns
router.post('/', create)

// PATCH /campaigns/:id
router.patch('/:id', update)

// POST /campaigns/:id/dispatch
router.post('/:id/dispatch', dispatch)

export default router
