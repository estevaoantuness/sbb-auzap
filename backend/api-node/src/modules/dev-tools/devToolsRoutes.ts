import { Router } from 'express'
import { verifyDevToolsKey } from './devToolsMiddleware'
import {
  getDbInfo,
  sendMessageDirect,
  createLead,
  deleteLead,
  runReadonlyQuery,
} from './devToolsController'

const router = Router()

// Todas as rotas exigem header x-dev-tools-key (e DEV_TOOLS_KEY configurada)
router.use(verifyDevToolsKey)

router.get('/db-info', getDbInfo)
router.post('/send-message', sendMessageDirect)
router.post('/lead', createLead)
router.delete('/lead/:telefone', deleteLead)
router.post('/run-readonly-query', runReadonlyQuery)

export default router
