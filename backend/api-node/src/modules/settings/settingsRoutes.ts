import { Router } from 'express'
import { getEmpresa, updateEmpresa, getHorario, updateHorario } from './settingsController'

const router = Router()

// Empresa
router.get('/empresa', getEmpresa)
router.patch('/empresa', updateEmpresa)

// Horário
router.get('/horario', getHorario)
router.patch('/horario', updateHorario)

export default router
