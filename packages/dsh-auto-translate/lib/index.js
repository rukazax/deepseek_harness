/**
 * Host half of the auto-translate plugin.
 *
 * All visible behaviour lives in the browser half (`lib/client.js`): a floating
 * toggle, a MutationObserver over every DSH page and adapter calls to third
 * party translate services. The host side owns no services and injects
 * nothing, so the plugin is safe to enable and disable from Settings → Plugins.
 */
export const name = 'dsh-auto-translate'

export function apply() {}
