/**
 * dsh-llm-auth-tools — model-route sign-in over the `authorization` service.
 *
 * Closed-model subscriptions (OpenAI ChatGPT Plus/Pro, Anthropic Claude
 * Pro/Max, xAI, GitHub Copilot) are OAuth accounts, not API keys: the provider
 * route reads a stored grant record and there is no key to type anywhere.
 * `@deepseek-ai/dsh-llm-pi-ai` registers one authorization flow per installed
 * provider, but nothing in the product calls it — the only consumer of
 * `authorization.begin` upstream is the DeepSeek account plugin, wired to its
 * own settings page. This plugin closes that gap with agent-callable tools:
 *
 *  - `llm_signin` with `action: list`   — every flow, its methods, in-flight state
 *  - `llm_signin` with `action: start`  — begin one attempt, return the URL/code
 *  - `llm_signin` with `action: status` — notices so far, pending question, outcome
 *  - `llm_signin` with `action: submit` — answer that question (e.g. paste the callback URL)
 *  - `llm_signin` with `action: cancel` — withdraw the attempt
 *
 * The attempt runs detached from the tool call, because a human log-in takes
 * minutes and a tool result cannot stay open that long. The grant is committed
 * by the flow itself (`ctx.authorization` owns that), so this plugin never
 * touches credential storage or its format.
 *
 * Intentional non-goals: no client-side UI (the model selector already lists a
 * route's models once the grant exists), and no provider-specific knowledge —
 * every key and method comes from the live flow registry.
 */

/** Loader identity. */
export const name = 'llm-auth-tools'

/** Both services are required: without either, the tools cannot do their job. */
export const inject = ['authorization', 'tools']

/** Attempts by credential key. One per key, mirroring the seam's own rule. */
const attempts = new Map()

const NOTICE_KEEP = 12
const PROMPT_WAIT_MIN_MS = 250

function warn(ctx, message) {
  try {
    ctx.logger?.warn(`llm-auth-tools: ${message}`)
  } catch {
    /* logging must never break a tool call */
  }
}

function sleep(ms) {
  return new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() })
}

/** `provider` → `llm-pi-ai/provider`; anything already scoped is left alone. */
function resolveKey(raw, scope) {
  const value = String(raw ?? '').trim()
  if (value === '') throw new Error('key is required: a provider id such as "openai-codex", or a scoped record key such as "llm-pi-ai/openai-codex"')
  return value.includes('/') ? value : `${scope}/${value}`
}

function noticesOf(attempt) {
  return attempt.notices.slice(-NOTICE_KEEP)
}

function stateOf(attempt) {
  /* Every member must be a defined JSON scalar: the tool result is snapped as
     lossless JSON, where an undefined member (or an Error instance) is
     unrepresentable and the whole result is rejected with
     "value is not lossless JSON". Normalize here, once, rather than trusting
     each flow's notice/prompt payload. */
  const recent = noticesOf(attempt)
  const last = recent.at(-1)
  const notices = []
  for (const entry of recent) {
    const message = entry?.message
    if (typeof message === 'string' && !notices.includes(message)) notices.push(message)
  }
  const state = {
    key: String(attempt.key ?? ''),
    status: attempt.settled ? String(attempt.outcome ?? 'error') : 'running',
    notices,
  }
  if (typeof last?.url === 'string') state.url = last.url
  if (typeof last?.code === 'string') state.code = last.code
  if (attempt.prompt !== null && attempt.prompt !== undefined) {
    const prompt = {
      kind: String(attempt.prompt.kind ?? 'input'),
      message: String(attempt.prompt.message ?? ''),
    }
    if (Array.isArray(attempt.prompt.options)) {
      prompt.options = attempt.prompt.options.map(option => `${String(option.id)}: ${String(option.label ?? option.id)}`)
    }
    state.prompt = prompt
  }
  if (attempt.error !== null && attempt.error !== undefined) state.error = String(attempt.error)
  return state
}

/**
 * Begin one attempt and return as soon as it has something to show.
 *
 * The flow reports its first notice (the authorization URL, or a device code)
 * before it waits on the human, so a bounded wait is enough to answer the
 * caller without blocking on the log-in itself.
 */
async function startAttempt(ctx, key, method, waitMs) {
  const running = attempts.get(key)
  if (running !== undefined && !running.settled) {
    throw new Error(`a sign-in for ${key} is already running; check it with action "status" or drop it with action "cancel"`)
  }
  const entry = ctx.authorization.list().find(item => String(item.key) === key)
  if (entry === undefined) {
    const known = ctx.authorization.list().map(item => `${item.key} (${item.methods.map(m => m.id).join('/')})`)
    throw new Error(`no authorization flow claims ${key}; registered flows: ${known.join(', ') || 'none'}`)
  }
  const chosen = method ?? entry.methods[0]?.id
  if (chosen === undefined || !entry.methods.some(item => item.id === chosen)) {
    throw new Error(`${key} offers ${entry.methods.map(item => item.id).join('/')}, not ${JSON.stringify(chosen)}`)
  }

  const attempt = {
    key,
    notices: [],
    prompt: null,
    settled: false,
    outcome: null,
    error: null,
  }
  attempts.set(key, attempt)

  const interaction = {
    notify(notice) {
      attempt.notices.push({ ...notice, at: Date.now() })
    },
    prompt(question) {
      return new Promise((resolve, reject) => {
        attempt.prompt = {
          kind: question.kind,
          message: question.message,
          options: question.options,
          answer: (text) => {
            attempt.prompt = null
            resolve(text)
          },
        }
        /* A flow racing a browser callback against a typed answer withdraws the
           losing question; that must reject here, or the attempt would hang. */
        question.signal?.addEventListener('abort', () => {
          if (attempt.prompt === null) return
          attempt.prompt = null
          reject(new Error('prompt withdrawn by the flow'))
        }, { once: true })
      })
    },
  }

  attempt.done = ctx.authorization.begin({ key, method: chosen, interaction })
    .then(outcome => { attempt.outcome = outcome.status })
    .catch(error => {
      attempt.outcome = 'error'
      attempt.error = error instanceof Error ? error.message : String(error)
    })
    .finally(() => { attempt.settled = true })

  await waitForDisplay(attempt, waitMs)
  return { attempt, method: chosen }
}

async function waitForDisplay(attempt, waitMs) {
  const deadline = Date.now() + Math.max(PROMPT_WAIT_MIN_MS, waitMs)
  while (Date.now() < deadline) {
    if (attempt.settled || attempt.notices.length > 0 || attempt.prompt !== null) return
    await sleep(60)
  }
}

async function waitForSettle(attempt, waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs)
  while (Date.now() < deadline && !attempt.settled) await sleep(150)
}

/** Build the `llm_signin` tool definition over one live `authorization` service. */
function toolFor(ctx, scope) {
  return {
    name: 'llm_signin',
    description: 'Sign in to a subscription model route (OpenAI ChatGPT Plus/Pro, Claude Pro/Max, Copilot, …) whose grant is an account, not an API key. The attempt runs in the background: "start" returns the authorization URL right away, the human finishes it in a browser, and "status" reports when the grant is committed. A question the flow asks can be answered with "submit".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'start', 'status', 'submit', 'cancel'],
          description: 'list = flows and their methods; start = begin one attempt; status = notices, pending question and outcome; submit = answer the pending question; cancel = withdraw the attempt',
        },
        key: {
          type: 'string',
          description: 'Provider id such as "openai-codex", or a scoped record key such as "llm-pi-ai/openai-codex". Required for every action but "list".',
        },
        method: {
          type: 'string',
          description: '"start" only: which method to use, e.g. "oauth" or "api-key". Defaults to the flow\'s first (most preferred) method.',
        },
        text: {
          type: 'string',
          description: '"submit" only: the answer to the pending question — the callback URL the browser landed on, a verification code, or a select option id.',
        },
        wait: {
          type: 'number',
          description: '"start" and "status" only: seconds to wait for the first notice or for the attempt to settle before answering. Default 3.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string' },
          flows: { type: 'array', items: { type: 'string' } },
          key: { type: 'string' },
          status: { type: 'string' },
          url: { type: 'string' },
          code: { type: 'string' },
          notices: { type: 'array', items: { type: 'string' } },
          prompt: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string' },
              message: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
            },
          },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        const lines = []
        if (value.flows !== undefined) {
          lines.push(value.flows.length === 0 ? 'No authorization flow is mounted.' : value.flows.join('\n'))
        }
        if (value.key !== undefined) {
          lines.push(`${value.key}: ${value.status}`)
          if (value.url !== undefined) lines.push(`URL: ${value.url}`)
          if (value.code !== undefined) lines.push(`code: ${value.code}`)
          if (value.prompt !== undefined) {
            lines.push(`question (${value.prompt.kind}): ${value.prompt.message}`)
            if (value.prompt.options !== undefined) lines.push(`options: ${value.prompt.options.join(', ')}`)
          }
          if (value.notices !== undefined && value.notices.length > 0) lines.push(...value.notices.map(line => `· ${line}`))
          if (value.error !== undefined) lines.push(`error: ${value.error}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const action = String(args.action)
      if (action === 'list') {
        const flows = ctx.authorization.list().map(entry => {
          const methods = entry.methods.map(item => `${item.id} (${item.label})`).join(', ')
          const state = attempts.get(String(entry.key))
          const tail = state === undefined ? '' : state.settled ? ' — finished' : ' — in flight'
          return `${entry.key}: ${entry.label} — ${methods}${tail}`
        })
        return { action, flows }
      }

      const key = resolveKey(args.key, scope)

      if (action === 'start') {
        const waitMs = Math.max(0, Number(args.wait ?? 3)) * 1000
        const { attempt } = await startAttempt(ctx, key, args.method, waitMs)
        return { action, ...stateOf(attempt) }
      }

      const attempt = attempts.get(key)
      if (attempt === undefined) {
        /* No local record: the attempt either never started here or predates a
           plugin reload. The seam still knows it, so cancel works and anything
           else needs a fresh start. */
        if (action === 'cancel') {
          ctx.authorization.cancel(key)
          await sleep(500)
          return { action, key, status: ctx.authorization.describe(key)?.inFlight === true ? 'cancelling' : 'cancelled', notices: [] }
        }
        throw new Error(`no attempt recorded for ${key}; start one with action "start"`)
      }

      if (action === 'status') {
        await waitForSettle(attempt, Math.max(0, Number(args.wait ?? 0)) * 1000)
        return { action, ...stateOf(attempt) }
      }

      if (action === 'submit') {
        if (attempt.prompt === null) throw new Error(`${key} is not waiting for an answer`)
        if (typeof args.text !== 'string' || args.text.trim() === '') throw new Error('submit needs "text": the answer the flow is waiting for')
        attempt.prompt.answer(args.text.trim())
        await waitForSettle(attempt, 1500)
        return { action, ...stateOf(attempt) }
      }

      if (action === 'cancel') {
        ctx.authorization.cancel(key)
        await waitForSettle(attempt, 2000)
        return { action, ...stateOf(attempt) }
      }

      throw new Error(`unknown action ${JSON.stringify(action)}`)
    },
  }
}

export function apply(ctx, config) {
  const scope = typeof config?.scope === 'string' && config.scope !== '' ? config.scope : 'llm-pi-ai'

  /* Registration is fiber-scoped, so unmounting the plugin withdraws the tool
     on its own; only the in-memory attempts are ours to drop. */
  try {
    ctx.on('dispose', () => { attempts.clear() })
  } catch { /* older context without a dispose event */ }

  ctx.inject(['authorization', 'tools'], (authorized) => {
    const tools = authorized.get('tools')
    if (tools?.register === undefined) {
      warn(ctx, 'tools service is not available; sign-in tools are not mounted')
      return
    }
    try {
      tools.register(toolFor(authorized, scope))
      ctx.logger?.info?.('llm-auth-tools: llm_signin is available (%d authorization flows)', authorized.authorization.list().length)
    } catch (error) {
      warn(ctx, `tool registration failed: String(error)`.replace('String(error)', String(error)))
    }
  })

  return undefined
}
