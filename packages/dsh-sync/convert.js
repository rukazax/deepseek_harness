#!/usr/bin/env node
/**
 * Convert one DeepSeek Harness session log between Windows and POSIX cwd spellings.
 *
 * Purpose: DSH validates that a session header's cwd is an absolute path for the
 * host platform. A Windows cwd ("C:\Users\...") is not absolute on Linux, so the
 * Debian instance treats such logs as malformed and hides them. This tool rewrites
 * only the header line's cwd through a path mapping and re-frames the log the way
 * the JSONL backend expects: the first Zstandard frame contains exactly the header
 * line, later frames carry the remaining events.
 *
 * Usage:
 *   node convert.js --in <session log> --root <sessions root> --direction win2posix|posix2win
 *                   [--out-file <explicit target>] [--print-target]
 */
'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const ZSTD_MAGIC = 0xfd2fb528

/**
 * Prefix mappings; separator-aware longest-prefix replacement.
 * The Windows home directory comes from USERPROFILE so the tool is not tied to one user.
 */
const WIN_HOME = (process.env.USERPROFILE || 'C:\\Users\\<user>').replace(/[\\/]+$/, '')
const WIN_WORKSPACE = WIN_HOME + '\\Documents\\deepseek-harness\\'

const MAP_WIN2POSIX = [
  [WIN_WORKSPACE, '/root/dsh-ws/'],
  [WIN_HOME + '\\', '/root/win-home/'],
  ['C:\\', '/root/win-c/'],
]
const MAP_POSIX2WIN = [
  ['/root/dsh-ws/', WIN_WORKSPACE],
  ['/root/win-home/', WIN_HOME + '\\'],
  ['/root/win-c/', 'C:\\'],
  ['/root', WIN_HOME],
]

function mapPath(value, direction) {
  if (typeof value !== 'string' || value.length === 0) return value
  const table = direction === 'win2posix' ? MAP_WIN2POSIX : MAP_POSIX2WIN
  const normalized = direction === 'win2posix' ? value.replace(/\//g, '\\') : value
  for (const [from, to] of table) {
    if (normalized === from.replace(/[\\/]$/, '')) return to.replace(/[\\/]$/, '')
    if (normalized.startsWith(from)) {
      const rest = normalized.slice(from.length)
      if (direction === 'win2posix') return to + rest.replace(/\\/g, '/')
      return to + rest.replace(/\//g, '\\')
    }
  }
  // Unmapped fallback keeps the value absolute for the target platform.
  if (direction === 'win2posix' && /^[A-Za-z]:/.test(normalized)) {
    return '/root/win-c/' + normalized.slice(3).replace(/\\/g, '/')
  }
  if (direction === 'posix2win' && normalized.startsWith('/')) {
    return 'C:\\' + normalized.slice(1).replace(/\//g, '\\')
  }
  return value
}

/** Locate complete frames in a concatenated Zstandard stream (no decompression). */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new Error('torn frame header at ' + offset)
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid frame magic at ' + offset)
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error('reserved frame-header bit at ' + (offset - 1))
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) throw new Error('torn frame header at ' + start)
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error('torn block header at ' + offset)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('reserved block type at ' + (offset - 3))
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) throw new Error('torn block at ' + offset)
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error('torn checksum at ' + offset)
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

function compressFrame(input) {
  return zlib.zstdCompressSync(input, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
}

function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

function parseLogName(name) {
  const match = /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(name)
  if (match === null) return undefined
  return { version: Number(match[1]), compression: match[2] === '.zstd' ? 'zstd' : 'none' }
}

function decodeLog(buffer, compression) {
  if (compression === 'none') return buffer.toString('utf8')
  const frames = scanFrames(buffer)
  let text = ''
  for (const frame of frames) text += zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
  return text
}

function encodeLog(lines, compression) {
  const parts = [compressFrame(lines[0] + '\n')]
  if (lines.length > 1) parts.push(compressFrame(lines.slice(1).join('\n') + '\n'))
  return Buffer.concat(parts)
}

function main(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) { args[name] = true; continue }
    args[name] = value
    i++
  }
  const input = args.in
  const root = args.root
  const direction = args.direction ?? 'win2posix'
  if (input === undefined || root === undefined) {
    console.error('usage: convert.js --in <log> --root <sessions root> --direction win2posix|posix2win [--print-target]')
    process.exit(2)
  }
  const sourceName = path.basename(input)
  const meta = parseLogName(sourceName)
  if (meta === undefined) throw new Error('unsupported session log name: ' + sourceName)
  const raw = fs.readFileSync(input)
  const text = decodeLog(raw, meta.compression)
  const lines = text.split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) throw new Error('empty session log')
  const header = JSON.parse(lines[0])
  if (header.type !== 'session') throw new Error('first record is not a session header')
  const originalCwd = header.cwd
  header.cwd = mapPath(originalCwd, direction)
  lines[0] = JSON.stringify(header)
  const targetDir = path.join(root, projectKey(header.cwd), encodeSegment(header.id))
  const targetName = `session.v${meta.version}.jsonl` + (meta.compression === 'zstd' ? '.zstd' : '')
  const target = args['out-file'] !== undefined ? args['out-file'] : path.join(targetDir, targetName)
  const encoded = encodeLog(lines, meta.compression)
  const sha256 = require('crypto').createHash('sha256').update(encoded).digest('hex')
  const record = {
    id: header.id,
    from: originalCwd,
    to: header.cwd,
    target,
    rel: path.relative(root, target),
    events: lines.length - 1,
    bytes: encoded.length,
    sha256,
    changed: header.cwd !== originalCwd,
  }
  if (args.meta !== undefined) fs.writeFileSync(args.meta, JSON.stringify(record))
  console.log(JSON.stringify(record))
  if (args['print-target'] === true || args.dry === true) return
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (args['mkdir-cwd'] === true && header.cwd.startsWith('/')) {
    fs.mkdirSync(header.cwd, { recursive: true })
  }
  const tmp = target + '.tmp-' + process.pid
  fs.writeFileSync(tmp, encoded, { mode: 0o600 })
  fs.renameSync(tmp, target)
}

main(process.argv.slice(2))
