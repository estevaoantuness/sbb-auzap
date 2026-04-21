/**
 * Modelo OpenAI do brain do dashboard (operator chat).
 * Override: OPENAI_BRAIN_MODEL. Default barato (gpt-4o-mini).
 */
export function getBrainOpenAiModel(): string {
  return process.env.OPENAI_BRAIN_MODEL?.trim() || 'gpt-4o-mini'
}
