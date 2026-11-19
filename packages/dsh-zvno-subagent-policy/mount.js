/**
 * Стабильная точка монтирования для dsh-zvno-subagent-policy.
 * Шим держит спецификатор стабильным и переимпортирует impl.js с уникальным
 * query при каждом монтировании: правка impl.js действует на живом harness.
 */

export const name = 'zvno-subagent-policy'
// subagentModelSelection не в inject: чужой сервис может быть не смонтирован,
// impl.js берёт его через ctx.get(), а не как свойство контекста.
export const inject = ['sessions']

export async function apply(ctx, config) {
  const url = new URL('./impl.js', import.meta.url)
  url.search = `?t=${Date.now()}`
  const impl = await import(url.href)
  return impl.apply(ctx, config)
}
