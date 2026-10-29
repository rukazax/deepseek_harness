// Install / remove the Russian language pack for DeepSeek Harness.
//
// Copies the plugin into the DSH profile and inserts one Loader row into the
// profile patch file (with a backup). No pnpm install, no network, no rebuild.
//
// usage:
//   node tools/install.mjs --dry-run
//   node tools/install.mjs
//   node tools/install.mjs --remove
//   node tools/install.mjs --profile desktop --home "C:\Users\me\.dsh"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sourceDir = resolve(here, '..')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const remove = argv.includes('--remove')
const argValue = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const profile = argValue('--profile', process.env.DSH_PROFILE ?? 'desktop')
const home = resolve(argValue('--home', process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')))
const profileDir = join(home, 'profiles', profile)
const patchFile = join(profileDir, 'cordis.patch.yml')
const targetDir = join(profileDir, 'plugins', 'dsh-locale-ru')

const ENTRY_ID = 'locale-ru'
const ENTRY_NAME = './plugins/dsh-locale-ru/lib/index.js'
const INSERT_BLOCK = `- insert:\n    - id: ${ENTRY_ID}\n      name: '${ENTRY_NAME}'\n`
const PATCH_COMMENT = '# Russian interface language (dsh-locale-ru plugin):'

const step = (message) => console.log((dryRun ? '[dry-run] ' : '[apply]   ') + message)

if (!existsSync(join(profileDir, 'package.json'))) {
  console.error('error: profile ' + JSON.stringify(profile) + ' is not initialized at ' + profileDir)
  console.error('       open DeepSeek Harness once so it creates the profile, then re-run.')
  process.exit(1)
}

if (remove) {
  step('remove ' + targetDir)
  if (!dryRun && existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true })
  if (existsSync(patchFile)) {
    const original = readFileSync(patchFile, 'utf8')
    const lines = original.split(/\r?\n/)
    const kept = []
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startsWith(PATCH_COMMENT)) continue
      if (lines[i].trim() === 'insert:' && lines[i + 1]?.includes(ENTRY_ID)) {
        i += 2
        continue
      }
      kept.push(lines[i])
    }
    const next = kept.join('\n').replace(/\n{3,}/g, '\n\n')
    step('rewrite ' + patchFile + ' (dropping the ' + ENTRY_ID + ' insert block)')
    if (!dryRun) writeFileSync(patchFile, next)
  }
  console.log('done: Russian language pack removed from profile ' + profile)
  process.exit(0)
}

if (!existsSync(join(sourceDir, 'lib', 'client.js'))) {
  console.error('error: lib/client.js is missing - rebuild it with tools/build-client.mjs first')
  process.exit(1)
}

step('copy ' + sourceDir + ' -> ' + targetDir)
if (!dryRun) {
  mkdirSync(dirname(targetDir), { recursive: true })
  cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: (source) => !/[\\/](\.git|node_modules)[\\/]?$/.test(source),
  })
}

const patch = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
if (patch.includes(ENTRY_ID)) {
  step('patch already contains the ' + ENTRY_ID + ' row - leaving it untouched')
} else {
  const backup = patchFile + '.before-locale-ru'
  step('backup ' + patchFile + ' -> ' + backup)
  if (!dryRun && existsSync(patchFile)) writeFileSync(backup, patch)
  const base = patch.length === 0 ? '' : patch.endsWith('\n') ? patch + '\n' : patch + '\n\n'
  step('append to ' + patchFile + ':\n' + (PATCH_COMMENT + '\n' + INSERT_BLOCK).replace(/^/gm, '          '))
  if (!dryRun) writeFileSync(patchFile, base + PATCH_COMMENT + '\n' + INSERT_BLOCK)
}

console.log('')
console.log(dryRun ? 'dry run finished - nothing was changed' : 'installed into profile ' + profile)
console.log('next: restart DeepSeek Harness, then pick Settings -> General -> Language -> Русский')
