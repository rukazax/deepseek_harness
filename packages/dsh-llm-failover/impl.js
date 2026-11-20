/**
 * llm-failover — автопереключение модели при лимитах провайдера.
 *
 * Сидит на "agent/request-error" с prepend (раньше dsh-llm-retry, который
 * иначе не зовёт next() для retryable-кодов и глушил бы нас). Срабатывает на:
 *   • кодах RATE_LIMIT/QUOTA/ACCOUNT_QUOTA;
 *   • ЛЮБОМ коде (включая PI_AI_ERROR и прочие provider-ошибки), если текст
 *     отказа содержит лимитную сигнатуру: "usage limit", "rate limit",
 *     "limit reached", "quota" (Z.AI 429 «Usage limit reached for N hour»
 *     приходит именно как PI_AI_ERROR — код не матчился, агент умирал).
 * Выбирает следующий маршрут цепочки (провайдер, на котором упало,
 * пропускается — лимит обычно общий на аккаунт), гасит шаг fail-fast без
 * сжигания ретраев на мёртвом маршруте и ставит rescue-followup, чтобы агент
 * продолжил прерванную работу новым ходом.
 *
 * followup принимает UserMessage-объект, а не строку: сырая строка уходит в лог
 * как `inserted:["..."]` и ломает загрузку сессии (SessionFormatError).
 *
 * Известный потолок (ponytail): decision.selection агентского шага заморожен,
 * поэтому переключение действует со следующего шага/хода — текущий шаг
 * обрывается с ошибкой. Транзиентный 429 с providerRetryAfterMs < 10с
 * отдаётся dsh-llm-retry в обычном порядке.
 */

const DEFAULT_CODES = ['RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA']
const LIMIT_TEXT = /usage limit|rate[- ]?limit|limit reached|quota/i
const DEFAULT_CHAIN = [
  { provider: 'zai', model: 'glm-5.3-flash' },
  { provider: 'openai-codex', model: 'gpt-6-luna' },
  { provider: 'deepseek-account', model: 'deepseek-flash' },
]

export async function apply(ctx, config = {}) {
  const chain = Array.isArray(config.chain) && config.chain.length > 0
    ? config.chain.filter((e) => e && e.provider && e.model)
    : DEFAULT_CHAIN
  if (chain.length === 0) {
    ctx.logger.warn('llm-failover: пустая цепочка, плагин выключен')
    return
  }
  const codes = new Set(config.codes ?? DEFAULT_CODES)
  const maxSwitches = Number.isFinite(config.maxSwitches) && config.maxSwitches > 0 ? config.maxSwitches : 10
  const rescue = config.rescue !== false
  const switches = new Map() // id сессии агента -> число переключений

  function nextEntry(failedProvider, attempt) {
    const n = chain.length
    for (let i = 0; i < n; i++) {
      const entry = chain[(attempt + i) % n]
      if (entry.provider !== failedProvider) return entry
    }
    return null
  }

  ctx.on('agent/request-error', async (payload, next) => {
    const { agent, provider, failure } = payload
    if (!failure) return next()
    const msg = String(failure.message ?? failure.error?.message ?? '')
    if (!codes.has(failure.code) && !LIMIT_TEXT.test(msg)) return next()
    // Транзиентный лимит с коротким retry-after: пусть штатный retry сам разберётся.
    if (Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0 && failure.providerRetryAfterMs < 10000) return next()

    const sid = agent.session?.id ?? agent.id
    const count = switches.get(sid) ?? 0
    if (count >= maxSwitches) return next()
    const entry = nextEntry(provider, count)
    if (!entry) return next()

    try {
      await Promise.resolve(agent.model.select({ provider: entry.provider, model: entry.model }))
    } catch (error) {
      ctx.logger.warn(`llm-failover: select(${entry.provider}/${entry.model}) не удался: %o`, error)
      return next()
    }
    switches.set(sid, count + 1)
    ctx.logger.warn(`llm-failover: ${provider} -> ${entry.provider}/${entry.model} (${failure.code}, переключение ${count + 1}/${maxSwitches})`)
    if (rescue) {
      try {
        agent.followup({
          role: 'user',
          content: [{ type: 'text', text: `[llm-failover] Сбой модели: ${failure.code} на ${provider}. Модель переключена на ${entry.provider}/${entry.model}. Продолжи выполнение последней задачи с места прерывания: повтори невыполненный шаг и доведи работу до конца.` }],
          source: { kind: 'user' },
        })
      } catch (error) {
        ctx.logger.warn('llm-failover: rescue-followup не удался: %o', error)
      }
    }
    // Fail-fast: не звать next(), чтобы dsh-llm-retry не жёг ретраи на мёртвом маршруте.
    return undefined
  }, { prepend: true })

  ctx.logger.warn(`llm-failover: mounted, chain=${chain.map((e) => `${e.provider}/${e.model}`).join(' -> ')}`)
}
