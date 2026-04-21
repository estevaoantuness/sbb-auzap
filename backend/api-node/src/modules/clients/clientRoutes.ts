import { Router } from 'express'
import {
  listClients,
  getClientDetails,
  updateClient,
  upsertPreference,
} from './clientController'

const router = Router()

// GET /clients?search=...&limit=50
router.get('/', listClients)

// GET /clients/:id
router.get('/:id', getClientDetails)

// PATCH /clients/:id
router.patch('/:id', updateClient)

// POST /clients/:id/preferences
router.post('/:id/preferences', upsertPreference)

export default router
