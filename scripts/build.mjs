#!/usr/bin/env node
/**
 * build.mjs — compile `src/*.ts` to `dist/*.js` with Node's built-in TypeScript type stripping.
 *
 * Why not tsc: the DSH packages this plugin targets ship no `.d.ts` in the installed Desktop build,
 * so a real type check of `@deepseek-ai/*` imports is impossible here, and this plugin deliberately
 * has zero runtime dependencies. Node 22.13+ (and 24.x, which DSH ships) exposes
 * `module.stripTypeScriptTypes`, so the build needs no package manager and no network.
 *
 * The build also enforces the zero-dependency rule: any bare import specifier that is not a
 * `node:` builtin fails the build, because a profile-installed bundle cannot resolve extra
 * packages at runtime.
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const srcDir = join(root, 'src')
const distDir = join(root, 'dist')

/** Import specifiers must be relative or a Node builtin. */
const IMPORT_RE = /(?:^|[\s;{(])import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|(?:^|[\s;])export\s+[^'"]*?\sfrom\s+['"]([^'"]+)['"]/g

/** Fail on a bare specifier: `dist` must run with no node_modules at all. */
function assertNoBareImports(file, code) {
  const offenders = []
  for (const match of code.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2]
    if (specifier === undefined) continue
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
    offenders.push(specifier)
  }
  if (offenders.length > 0) {
    throw new Error(`${file}: emitted bare import(s) ${offenders.join(', ')}; this plugin must stay dependency-free`)
  }
}

async function main() {
  await rm(distDir, { recursive: true, force: true })
  await mkdir(distDir, { recursive: true })

  const entries = (await readdir(srcDir)).filter((entry) => entry.endsWith('.ts')).sort()
  if (entries.length === 0) throw new Error('src/ has no .ts sources')

  let totalBytes = 0
  for (const entry of entries) {
    const sourcePath = join(srcDir, entry)
    const source = await readFile(sourcePath, 'utf8')
    // `strip` keeps the original line structure, so stack traces still point at src/*.ts lines.
    const code = stripTypeScriptTypes(source, { mode: 'strip' })
    // A `.ts` source imports its siblings as `./x.js`; that specifier is already correct for dist.
    assertNoBareImports(entry, code)
    const outputPath = join(distDir, entry.replace(/\.ts$/, '.js'))
    await writeFile(outputPath, code, 'utf8')
    totalBytes += Buffer.byteLength(code)
    console.log(`  dist/${entry.replace(/\.ts$/, '.js')}  ${String(Buffer.byteLength(code)).padStart(7)} bytes  (from src/${entry})`)
  }

  // The bundle patch and manifest must exist for the loader to see a bundle at all.
  for (const required of ['cordis.patch.yml', 'package.json']) {
    const path = join(root, required)
    await readFile(path, 'utf8').catch(() => {
      throw new Error(`missing ${required}; it is required for DSH bundle installation`)
    })
  }

  console.log(`\nbuild ok: ${entries.length} module(s), ${totalBytes} bytes, zero runtime dependencies`)
}

main().catch((error) => {
  console.error(`build failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
