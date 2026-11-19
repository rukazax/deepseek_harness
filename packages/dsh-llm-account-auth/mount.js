/**
 * Mount point for the account sign-in tools.
 *
 * The harness loader imports a plugin module once per process (a plain ESM
 * `import()`, no cache-busting query), so editing a mounted file only takes
 * effect after a restart. This shim keeps the mounted specifier stable and
 * re-imports the implementation with a unique query on every mount, which
 * makes `impl.js` editable against a live harness: touch the profile's
 * cordis.patch.yml and the next mount loads the current file.
 */

export const name = 'llm-account-auth'
export const inject = ['authorization', 'tools']

export async function apply(ctx, config) {
  const url = new URL('./impl.js', import.meta.url)
  url.search = `?t=${Date.now()}`
  const impl = await import(url.href)
  return impl.apply(ctx, config)
}
