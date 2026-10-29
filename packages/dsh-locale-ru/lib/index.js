/**
 * Host half of the Russian language pack.
 *
 * The package exists so the Loader has a row to activate; everything the user
 * sees is registered by the browser half (`lib/client.js`) through
 * `ctx.locale`. Keeping an explicit, empty `apply` documents that: the host
 * side owns no services, injects nothing, and must stay side-effect free so it
 * is safe to enable and disable from Settings → Plugins.
 */
export const name = 'dsh-locale-ru'

export function apply() {}
