import { prisma } from '../../lib/db'
import { getBoss } from '../../lib/queue'
import { renderCampaignTemplate, type PlaceholderContext } from './campaignPlaceholders'

/**
 * Campanha outbound Meta WhatsApp Business.
 *
 * CUSTO: cada mensagem outbound é cobrada pela Meta (~R$ 0,20 em pt_BR para
 * "marketing"). Antes de disparar, valide o universo com cuidado — 5k leads
 * = R$ 1.000. LGPD: só manda pra leads com opt_in_marketing=true.
 *
 * Pipeline:
 *   1. sendCampaign → SELECT leads matching target_criteria (JSONB)
 *   2. Pra cada lead → INSERT em crm.campanha_envios status='pendente'
 *   3. Enqueue pg-boss job 'campaign:dispatch' com o envio_id
 *   4. Worker separado (Team D1/whatsapp) processa o job, chama cloudApi.sendMessage,
 *      atualiza status='enviada'/'falhou'.
 *
 * Este controller SÓ faz o orquestrador (1–3). Worker em src/modules/whatsapp.
 */

export const CAMPAIGN_DISPATCH_QUEUE = 'auzap:campaign_dispatch'

export interface TargetCriteria {
  segmento_rfm?: string[] // ['leal', 'em_risco']
  bairro?: string[]
  dias_sem_compra_min?: number
  dias_sem_compra_max?: number
  ticket_minimo?: number
  top_categoria?: string // filtra se 'CARNES' está em top_categorias[]
  only_opt_in?: boolean // default TRUE
}

interface CampanhaRow {
  id: bigint
  nome: string
  status: string
  tipo: string
  template_mensagem: string
  segmento_rfm: string[] | null
  dias_sem_compra_min: number | null
  dias_sem_compra_max: number | null
  ticket_minimo: string | null
  top_categoria: string | null
  produto_destaque_sku: string | null
  total_publico: number
  total_enviados: number
  created_at: Date
  updated_at: Date
}

export async function listCampaigns(): Promise<CampanhaRow[]> {
  return prisma.$queryRaw<CampanhaRow[]>`
    SELECT
      id, nome, status, tipo, template_mensagem,
      segmento_rfm, dias_sem_compra_min, dias_sem_compra_max,
      ticket_minimo::text AS ticket_minimo, top_categoria, produto_destaque_sku,
      total_publico, total_enviados, created_at, updated_at
    FROM crm.campanhas
    ORDER BY created_at DESC
    LIMIT 200
  `
}

export async function getCampaign(id: bigint): Promise<CampanhaRow | null> {
  const rows = await prisma.$queryRaw<CampanhaRow[]>`
    SELECT
      id, nome, status, tipo, template_mensagem,
      segmento_rfm, dias_sem_compra_min, dias_sem_compra_max,
      ticket_minimo::text AS ticket_minimo, top_categoria, produto_destaque_sku,
      total_publico, total_enviados, created_at, updated_at
    FROM crm.campanhas
    WHERE id = ${id}
    LIMIT 1
  `
  return rows[0] ?? null
}

export interface CreateCampaignInput {
  nome: string
  tipo?: 'marketing' | 'reengajamento' | 'recompra' | 'boas_vindas'
  template_mensagem: string
  target_criteria?: TargetCriteria
  produto_destaque_sku?: string | null
  agendada_at?: Date | null
}

export async function createCampaign(input: CreateCampaignInput): Promise<CampanhaRow> {
  const tipo = input.tipo ?? 'marketing'
  const segmentoRfm = input.target_criteria?.segmento_rfm ?? null
  const diasMin = input.target_criteria?.dias_sem_compra_min ?? null
  const diasMax = input.target_criteria?.dias_sem_compra_max ?? null
  const ticketMin = input.target_criteria?.ticket_minimo ?? null
  const topCat = input.target_criteria?.top_categoria ?? null
  const agendadaAt = input.agendada_at ?? null
  const produtoSku = input.produto_destaque_sku ?? null

  const rows = await prisma.$queryRaw<CampanhaRow[]>`
    INSERT INTO crm.campanhas (
      nome, status, tipo, template_mensagem,
      segmento_rfm, dias_sem_compra_min, dias_sem_compra_max,
      ticket_minimo, top_categoria, produto_destaque_sku,
      agendada_at
    )
    VALUES (
      ${input.nome}::text,
      'rascunho',
      ${tipo}::text,
      ${input.template_mensagem}::text,
      ${segmentoRfm}::text[],
      ${diasMin}::integer,
      ${diasMax}::integer,
      ${ticketMin}::numeric,
      ${topCat}::text,
      ${produtoSku}::text,
      ${agendadaAt}::timestamptz
    )
    RETURNING
      id, nome, status, tipo, template_mensagem,
      segmento_rfm, dias_sem_compra_min, dias_sem_compra_max,
      ticket_minimo::text AS ticket_minimo, top_categoria, produto_destaque_sku,
      total_publico, total_enviados, created_at, updated_at
  `
  return rows[0]!
}

export interface UpdateCampaignInput {
  nome?: string
  template_mensagem?: string
  target_criteria?: TargetCriteria
  produto_destaque_sku?: string | null
  agendada_at?: Date | null
}

export async function updateCampaign(id: bigint, input: UpdateCampaignInput): Promise<CampanhaRow | null> {
  const current = await getCampaign(id)
  if (!current) return null
  if (current.status !== 'rascunho') {
    throw new Error('Campanha só pode ser editada enquanto status=rascunho')
  }

  const nome = input.nome ?? current.nome
  const template = input.template_mensagem ?? current.template_mensagem
  const segmentoRfm = input.target_criteria?.segmento_rfm ?? current.segmento_rfm
  const diasMin = input.target_criteria?.dias_sem_compra_min ?? current.dias_sem_compra_min
  const diasMax = input.target_criteria?.dias_sem_compra_max ?? current.dias_sem_compra_max
  const ticketMin =
    input.target_criteria?.ticket_minimo != null
      ? input.target_criteria.ticket_minimo
      : current.ticket_minimo
      ? Number(current.ticket_minimo)
      : null
  const topCat = input.target_criteria?.top_categoria ?? current.top_categoria
  const produtoSku =
    input.produto_destaque_sku !== undefined ? input.produto_destaque_sku : current.produto_destaque_sku

  const rows = await prisma.$queryRaw<CampanhaRow[]>`
    UPDATE crm.campanhas
    SET
      nome = ${nome}::text,
      template_mensagem = ${template}::text,
      segmento_rfm = ${segmentoRfm}::text[],
      dias_sem_compra_min = ${diasMin}::integer,
      dias_sem_compra_max = ${diasMax}::integer,
      ticket_minimo = ${ticketMin}::numeric,
      top_categoria = ${topCat}::text,
      produto_destaque_sku = ${produtoSku}::text,
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING
      id, nome, status, tipo, template_mensagem,
      segmento_rfm, dias_sem_compra_min, dias_sem_compra_max,
      ticket_minimo::text AS ticket_minimo, top_categoria, produto_destaque_sku,
      total_publico, total_enviados, created_at, updated_at
  `
  return rows[0] ?? null
}

interface LeadForCampaign {
  id: bigint
  telefone: string
  nome_real: string | null
  nome_whatsapp: string | null
  bairro: string | null
  ultimo_produto_consultado: string | null
}

/**
 * Query de leads alvo da campanha — respeita opt_in_marketing=true (LGPD)
 * e qualquer filtro preenchido em target_criteria.
 */
async function queryTargetLeads(c: CampanhaRow): Promise<LeadForCampaign[]> {
  return prisma.$queryRaw<LeadForCampaign[]>`
    SELECT
      l.id,
      l.telefone,
      l.nome_real,
      l.nome_whatsapp,
      l.bairro,
      (
        SELECT pc.nome_produto
        FROM crm.produtos_consultados pc
        WHERE pc.lead_id = l.id
        ORDER BY pc.consultado_at DESC
        LIMIT 1
      ) AS ultimo_produto_consultado
    FROM crm.leads l
    WHERE l.opt_in_marketing = TRUE
      AND (${c.segmento_rfm}::text[] IS NULL OR l.segmento_rfm = ANY(${c.segmento_rfm}::text[]))
      AND (${c.dias_sem_compra_min}::integer IS NULL OR l.dias_sem_compra >= ${c.dias_sem_compra_min}::integer)
      AND (${c.dias_sem_compra_max}::integer IS NULL OR l.dias_sem_compra <= ${c.dias_sem_compra_max}::integer)
      AND (${c.ticket_minimo}::numeric IS NULL OR l.ticket_medio >= ${c.ticket_minimo}::numeric)
      AND (${c.top_categoria}::text IS NULL OR ${c.top_categoria}::text = ANY(l.top_categorias))
  `
}

/**
 * Dispara campanha: cria crm.campanha_envios e enfileira jobs pg-boss.
 * Retorna { total_publico, total_enfileirados }.
 */
export async function dispatchCampaign(id: bigint): Promise<{
  total_publico: number
  total_enfileirados: number
  status: string
}> {
  const campaign = await getCampaign(id)
  if (!campaign) {
    throw new Error('Campanha não encontrada')
  }
  if (campaign.status !== 'rascunho' && campaign.status !== 'agendada') {
    throw new Error(`Campanha com status "${campaign.status}" não pode ser disparada`)
  }

  const leads = await queryTargetLeads(campaign)

  if (leads.length === 0) {
    await prisma.$executeRaw`
      UPDATE crm.campanhas
      SET status = 'concluida', total_publico = 0, updated_at = NOW()
      WHERE id = ${id}
    `
    return { total_publico: 0, total_enfileirados: 0, status: 'concluida' }
  }

  const boss = await getBoss()

  // Transação: insere todos os envios + marca campanha como 'em_envio'
  await prisma.$transaction(async (tx) => {
    for (const lead of leads) {
      const ctx: PlaceholderContext = {
        nome: lead.nome_real ?? lead.nome_whatsapp ?? 'cliente',
        bairro: lead.bairro,
        ultimo_produto_consultado: lead.ultimo_produto_consultado,
      }
      const mensagemFinal = renderCampaignTemplate(campaign.template_mensagem, ctx)

      await tx.$executeRaw`
        INSERT INTO crm.campanha_envios (
          campanha_id, lead_id, telefone, mensagem_final, status
        )
        VALUES (
          ${id},
          ${lead.id},
          ${lead.telefone}::text,
          ${mensagemFinal}::text,
          'pendente'
        )
        ON CONFLICT (campanha_id, lead_id) DO NOTHING
      `
    }

    await tx.$executeRaw`
      UPDATE crm.campanhas
      SET status = 'em_envio', total_publico = ${leads.length}, updated_at = NOW()
      WHERE id = ${id}
    `
  })

  // Enfileira jobs por envio — worker separado cuida do throttle Cloud API (Team D1).
  const envios = await prisma.$queryRaw<Array<{ id: bigint; telefone: string; mensagem_final: string }>>`
    SELECT id, telefone, mensagem_final
    FROM crm.campanha_envios
    WHERE campanha_id = ${id} AND status = 'pendente'
  `

  let enqueued = 0
  for (const e of envios) {
    try {
      await boss.send(
        CAMPAIGN_DISPATCH_QUEUE,
        {
          envio_id: e.id.toString(),
          campanha_id: id.toString(),
          telefone: e.telefone,
          mensagem: e.mensagem_final,
        },
        {
          singletonKey: `campaign-envio:${e.id}`,
          expireInSeconds: 3600,
          retryLimit: 2,
          retryBackoff: true,
        }
      )
      enqueued++
    } catch (err) {
      console.error('[campaigns] enqueue envio falhou', { envio_id: e.id.toString(), error: err })
    }
  }

  return {
    total_publico: leads.length,
    total_enfileirados: enqueued,
    status: 'em_envio',
  }
}
