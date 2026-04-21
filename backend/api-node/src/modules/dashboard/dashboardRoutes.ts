import { Router } from 'express'
import {
  getFaturamentoDiario,
  getTopProdutos,
  getProjecaoDia,
  getProjecaoSemana,
  getFluxoEstoque,
  getFaturamentoCategoria,
  getFaturamentoHora,
  getAgentKpis,
  getKpisSummary,
} from './dashboardController'

const router = Router()

// Summary (home)
router.get('/kpis', getKpisSummary)

// Views de negócio (public.*)
router.get('/faturamento/diario', getFaturamentoDiario)
router.get('/faturamento/hora', getFaturamentoHora)
router.get('/faturamento/categoria', getFaturamentoCategoria)
router.get('/produtos/top', getTopProdutos)
router.get('/projecao/dia', getProjecaoDia)
router.get('/projecao/semana', getProjecaoSemana)
router.get('/estoque/fluxo', getFluxoEstoque)

// Agente IA (agent.*)
router.get('/agent', getAgentKpis)

export default router
