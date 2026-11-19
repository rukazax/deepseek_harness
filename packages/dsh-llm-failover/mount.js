/**
 * Стабильная точка монтирования для llm-failover.
 *
 * Лоадер импортирует модуль плагина один раз на процесс (обычный ESM import,
 * без сброса кэша), поэтому правка смонтированного файла действует только
 * после рестарта. Этот шим держит спецификатор стабильным и переимпортирует
 * реализацию с уникальным query при каждом монтировании: impl.js редактируется
 * на живом harness — коснулся cordis.patch.yml, следующий mount загрузит текущий.
 */

export const name = 'llm-failover'

export async function apply(ctx, config) {
  const url = new URL('./impl.js', import.meta.url)
  url.search = `?t=${Date.now()}`
  const impl = await import(url.href)
  return impl.apply(ctx, config)
}
