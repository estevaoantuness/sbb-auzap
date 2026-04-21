import { Request, Response } from 'express'
import { prisma } from '../../lib/db'

/**
 * Settings Super Bem Barato — store config via `public.config_sistema (chave, valor)`.
 *
 * Conjuntos expostos:
 *   /settings/empresa   — razão social, CNPJ, endereço, telefone, email, WABA phone
 *   /settings/horario   — horário de funcionamento por dia da semana (JSON)
 */

const EMPRESA_KEYS = [
  'empresa_nome',
  'empresa_razao_social',
  'empresa_cnpj',
  'empresa_endereco',
  'empresa_bairro',
  'empresa_cidade',
  'empresa_estado',
  'empresa_telefone',
  'empresa_email',
  'empresa_waba_phone',
] as const
type EmpresaKey = (typeof EMPRESA_KEYS)[number]

const HORARIO_KEY = 'horario_funcionamento' // JSON stringificado

async function fetchConfigMap(keys: readonly string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {}
  const rows = await prisma.$queryRaw<Array<{ chave: string; valor: string | null }>>`
    SELECT chave, valor
    FROM public.config_sistema
    WHERE chave = ANY(${[...keys]}::text[])
  `
  const map: Record<string, string> = {}
  for (const r of rows) {
    map[r.chave] = r.valor ?? ''
  }
  return map
}

async function upsertConfig(key: string, value: string | null): Promise<void> {
  const v = value ?? ''
  await prisma.$executeRaw`
    INSERT INTO public.config_sistema (chave, valor, updated_at)
    VALUES (${key}::text, ${v}::text, NOW())
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()
  `
}

// ─── Empresa ─────────────────────────────────────────────────────────────────

/** GET /settings/empresa */
export async function getEmpresa(_req: Request, res: Response) {
  try {
    const map = await fetchConfigMap(EMPRESA_KEYS)
    res.json({
      nome: map.empresa_nome ?? '',
      razao_social: map.empresa_razao_social ?? '',
      cnpj: map.empresa_cnpj ?? '',
      endereco: map.empresa_endereco ?? '',
      bairro: map.empresa_bairro ?? '',
      cidade: map.empresa_cidade ?? '',
      estado: map.empresa_estado ?? '',
      telefone: map.empresa_telefone ?? '',
      email: map.empresa_email ?? '',
      waba_phone: map.empresa_waba_phone ?? '',
    })
  } catch (err) {
    console.error('[settings] getEmpresa:', err)
    res.status(500).json({ error: 'Failed to load empresa settings' })
  }
}

/** PATCH /settings/empresa — aceita qualquer subset dos campos */
export async function updateEmpresa(req: Request, res: Response) {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const fieldToKey: Record<string, EmpresaKey> = {
      nome: 'empresa_nome',
      razao_social: 'empresa_razao_social',
      cnpj: 'empresa_cnpj',
      endereco: 'empresa_endereco',
      bairro: 'empresa_bairro',
      cidade: 'empresa_cidade',
      estado: 'empresa_estado',
      telefone: 'empresa_telefone',
      email: 'empresa_email',
      waba_phone: 'empresa_waba_phone',
    }

    let updated = 0
    for (const [field, key] of Object.entries(fieldToKey)) {
      if (field in body) {
        const raw = body[field]
        const val = raw == null ? '' : String(raw).trim()
        await upsertConfig(key, val)
        updated++
      }
    }

    if (updated === 0) {
      return res.status(400).json({ error: 'no valid fields to update' })
    }

    const map = await fetchConfigMap(EMPRESA_KEYS)
    res.json({
      success: true,
      updated,
      empresa: {
        nome: map.empresa_nome ?? '',
        razao_social: map.empresa_razao_social ?? '',
        cnpj: map.empresa_cnpj ?? '',
        endereco: map.empresa_endereco ?? '',
        bairro: map.empresa_bairro ?? '',
        cidade: map.empresa_cidade ?? '',
        estado: map.empresa_estado ?? '',
        telefone: map.empresa_telefone ?? '',
        email: map.empresa_email ?? '',
        waba_phone: map.empresa_waba_phone ?? '',
      },
    })
  } catch (err) {
    console.error('[settings] updateEmpresa:', err)
    res.status(500).json({ error: 'Failed to update empresa settings' })
  }
}

// ─── Horário ─────────────────────────────────────────────────────────────────

interface HorarioDia {
  dia: number // 0=Dom … 6=Sab
  aberto: boolean
  abre: string | null // 'HH:MM'
  fecha: string | null
}

const DEFAULT_HORARIO: HorarioDia[] = [
  { dia: 0, aberto: false, abre: null, fecha: null },
  { dia: 1, aberto: true, abre: '08:00', fecha: '20:00' },
  { dia: 2, aberto: true, abre: '08:00', fecha: '20:00' },
  { dia: 3, aberto: true, abre: '08:00', fecha: '20:00' },
  { dia: 4, aberto: true, abre: '08:00', fecha: '20:00' },
  { dia: 5, aberto: true, abre: '08:00', fecha: '20:00' },
  { dia: 6, aberto: true, abre: '08:00', fecha: '18:00' },
]

function parseHorarioJson(raw: string | null | undefined): HorarioDia[] {
  if (!raw) return DEFAULT_HORARIO
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_HORARIO
    const byDay = new Map<number, HorarioDia>()
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const dia = Number((item as any).dia)
      if (!Number.isInteger(dia) || dia < 0 || dia > 6) continue
      byDay.set(dia, {
        dia,
        aberto: Boolean((item as any).aberto),
        abre: typeof (item as any).abre === 'string' ? (item as any).abre : null,
        fecha: typeof (item as any).fecha === 'string' ? (item as any).fecha : null,
      })
    }
    return Array.from({ length: 7 }, (_v, i) => byDay.get(i) ?? DEFAULT_HORARIO[i]!)
  } catch {
    return DEFAULT_HORARIO
  }
}

function validateHorarioArray(raw: unknown): HorarioDia[] {
  if (!Array.isArray(raw)) throw new Error('horario deve ser array de objetos { dia, aberto, abre, fecha }')
  const byDay = new Map<number, HorarioDia>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const dia = Number((item as any).dia)
    if (!Number.isInteger(dia) || dia < 0 || dia > 6) {
      throw new Error(`dia inválido: ${(item as any).dia}`)
    }
    const aberto = Boolean((item as any).aberto)
    const abre = aberto ? String((item as any).abre ?? '').slice(0, 5) : null
    const fecha = aberto ? String((item as any).fecha ?? '').slice(0, 5) : null
    if (aberto) {
      if (!/^\d{2}:\d{2}$/.test(abre ?? '') || !/^\d{2}:\d{2}$/.test(fecha ?? '')) {
        throw new Error(`horário HH:MM inválido no dia ${dia}`)
      }
    }
    byDay.set(dia, { dia, aberto, abre, fecha })
  }
  return Array.from({ length: 7 }, (_v, i) => byDay.get(i) ?? DEFAULT_HORARIO[i]!)
}

/** GET /settings/horario */
export async function getHorario(_req: Request, res: Response) {
  try {
    const map = await fetchConfigMap([HORARIO_KEY])
    const horario = parseHorarioJson(map[HORARIO_KEY])
    res.json({ horario })
  } catch (err) {
    console.error('[settings] getHorario:', err)
    res.status(500).json({ error: 'Failed to load horario' })
  }
}

/** PATCH /settings/horario */
export async function updateHorario(req: Request, res: Response) {
  try {
    const raw = (req.body ?? {}) as { horario?: unknown }
    const horario = validateHorarioArray(raw.horario)
    await upsertConfig(HORARIO_KEY, JSON.stringify(horario))
    res.json({ success: true, horario })
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    if (msg.includes('inválido') || msg.startsWith('dia ') || msg.includes('horário')) {
      return res.status(400).json({ error: msg })
    }
    console.error('[settings] updateHorario:', err)
    res.status(500).json({ error: 'Failed to update horario' })
  }
}
