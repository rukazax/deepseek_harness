/**
 * dsh-zvno-subagent-policy — дозапись политики выбора моделей в ЖИВУЮ сессию оркестратора.
 *
 * Пул моделей НЕ дублируется здесь: единственный источник правды —
 * allowedModels в subagent-model-selection-settings (~/.dsh/cordis.patch.yml).
 * Хост пишет subagent/model-selection-policy только в НОВЫЕ сессии
 * (agent/created + firstLiveSeq === 0), поэтому сессия, стартовавшая раньше
 * включения allowlist, отказывала субагентам: «child LLM route … is not allowed».
 *
 * Плагин дописывает событие политики в историю живой сессии через штатный
 * session.append(). Проекция subagentModelSelectionPolicy применяет ПЕРВОЕ
 * событие, поэтому плагин сначала ищет политику в логе и ничего не пишет,
 * если она уже есть: ни дублей, ни роста лога при каждом ремаунте.
 *
 * Данные сессии правятся только через API: ручная перезапись .zstd ломает
 * пофреймовый формат DSH (заголовок обязан быть отдельным кадром), после чего
 * сессия молча исчезает из списка. См. scripts/check-session-frames.mjs.
 */

const DEFAULT_TARGETS = ['session-e7b0c88e-c650-45a1-8aea-e2198ba1ca60']
const EVENT = 'subagent/model-selection-policy'

function normalizeConfig(raw, live) {
  const ids = Array.isArray(raw?.sessionIds) && raw.sessionIds.length > 0
    ? raw.sessionIds.filter(id => typeof id === 'string' && id.startsWith('session-'))
    : DEFAULT_TARGETS
  // Один источник правды: конфиг плагина, иначе живой allowlist. Своего
  // списка нет намеренно — раньше здесь жил DEFAULT_POOL, который разъехался
  // с конфигом и вписывал в политику несуществующий id модели.
  const configured = Array.isArray(raw?.allowedModels) && raw.allowedModels.length > 0
    ? raw.allowedModels
    : Array.isArray(live) ? live : []
  const pool = configured.filter(route => typeof route?.provider === 'string' && typeof route?.model === 'string')
  return { sessionIds: ids, allowedModels: pool }
}

export async function apply(ctx, config) {
  const live = ctx.get?.('subagentModelSelection')?.config?.allowedModels
  const { sessionIds, allowedModels } = normalizeConfig(config, live)
  const targets = new Set(sessionIds)
  if (allowedModels.length === 0) {
    ctx.logger.warn('zvno-subagent-policy: пула нет (ни config.allowedModels, ни subagent-model-selection-settings) — политику не пишу')
    return
  }

  // Идемпотентность: политика применяется из первого события, значит второе не нужно.
  function hasPolicy(session) {
    return session.snapshotEvents().some(event => event.type === EVENT)
  }

  function ensure(session, reason) {
    try {
      if (!session || !targets.has(session.header.id)) return
      if (hasPolicy(session)) return
      session.append(EVENT, { allowedModels })
      ctx.logger.info(`zvno-subagent-policy: политика записана (${reason}) для ${session.header.id}`)
    } catch (error) {
      ctx.logger.warn('zvno-subagent-policy: ' + (error?.message ?? error))
    }
  }

  const sessions = ctx.sessions ?? ctx.get?.('sessions')
  // Уже загруженные сессии (рестарт harness при живом агенте).
  for (const id of targets) {
    try { ensure(sessions?.get?.(id), 'ready') } catch (error) {
      ctx.logger.warn('zvno-subagent-policy: ' + (error?.message ?? error))
    }
  }

  // Сессию переоткрыли/создали позже: покрывает рестарт и ленивое восстановление.
  ctx.on('agent/created', ({ agent }) => ensure(agent?.session, 'agent/created'))
  ctx.on('session/created', session => ensure(session, 'session/created'))
}
