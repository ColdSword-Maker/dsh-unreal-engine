#!/usr/bin/env node
/**
 * verify-ue.mjs — repeatable acceptance check for the UE 5.8 bridge.
 *
 * It exercises exactly the code path the DSH tools use (`dist/ue-endpoint.js` +
 * `dist/mcp-client.js`), so a green run means the plugin's transport, discovery, and error
 * classification work against the editor that is running right now. The DSH-side round trip
 * (agent → tool → editor) is recorded separately in docs/verification.md.
 *
 * Usage:
 *   node scripts/verify-ue.mjs                       # discover, then run every check
 *   node scripts/verify-ue.mjs --endpoint http://127.0.0.1:8765/mcp
 *   node scripts/verify-ue.mjs --project "D:\Vibe Coding\ue-fixture" --json
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 the editor was not reachable.
 */

import { connectToEditor, discoverEndpoints } from '../dist/ue-endpoint.js'
// Reuse the plugin's own parser: a second copy here diverged once already (it counted bullet
// lines inside descriptions as toolsets) and made this script report a number the bridge did not.
import { parseToolsetCatalog } from '../dist/tools.js'

/** Parse `--flag value` and `--flag` arguments. */
function parseArgs(argv) {
  const args = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--json') { args.json = true; continue }
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) continue
    args[key] = value
    index += 1
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const checks = []
let failed = 0

/** Record one named assertion. */
function check(label, ok, detail) {
  checks.push({ label, ok, ...(detail === undefined ? {} : { detail }) })
  if (!ok) failed += 1
  if (args.json !== true) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** The bare name of a toolset tool (`EditorToolset.LogsToolset.GetLogEntries` → `GetLogEntries`). */
function bareName(qualified) {
  const parts = String(qualified).split('.')
  return parts[parts.length - 1]
}

/**
 * Pick one read-only log tool the toolset advertises, plus the minimum arguments its schema
 * requires. `call_tool` wants the bare tool name, without the toolset prefix.
 */
function pickReadOnlyTool(schemaText) {
  let parsed
  try {
    parsed = JSON.parse(schemaText)
  } catch {
    return undefined
  }
  const tools = Array.isArray(parsed?.tools) ? parsed.tools : []
  const requiredOf = (tool) => (Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : [])
  // A read-only tool whose required arguments we can fill with neutral values. A required
  // `category` cannot be guessed (the editor rejects unknown category names), so skip those.
  const callable = tools.filter((tool) => {
    if (typeof tool?.name !== 'string' || !/^(get|list|read|find|describe)/i.test(bareName(tool.name))) return false
    return !requiredOf(tool).includes('category')
  })
  // Prefer the aggregate readers over single-value getters.
  const chosen = callable.find((tool) => /(entries|categories)/i.test(bareName(tool.name))) ?? callable[0]
  if (chosen === undefined) return undefined

  // Fill only what the engine marks required, with neutral values: an empty filter reads
  // everything, so the call stays side-effect free.
  const properties = chosen.inputSchema?.properties ?? {}
  const args = {}
  for (const key of requiredOf(chosen)) {
    const type = properties[key]?.type
    if (type === 'string') args[key] = ''
    else if (type === 'integer' || type === 'number') args[key] = 1
    else if (type === 'boolean') args[key] = false
  }
  // UE 5.8's generated schema gives the log tools a `category` default equal to the toolset name
  // ("LogsToolset"), which is not a real log category, so omitting the argument fails. An empty
  // category means "all categories" (GetLogEntries.h), so set it explicitly.
  if (properties.category !== undefined) args.category = ''
  return { name: bareName(chosen.name), qualified: chosen.name, args }
}

async function main() {
  const options = {
    endpoint: args.endpoint,
    port: args.port === undefined ? undefined : Number(args.port),
    projectPaths: args.project === undefined ? [] : [args.project],
    extraPorts: [],
    env: process.env,
  }

  if (args.json !== true) {
    console.log('== discovery ==')
    const report = await discoverEndpoints(options)
    for (const candidate of report.candidates) {
      console.log(`  candidate ${candidate.url}  [${candidate.source}]${candidate.evidence === undefined ? '' : ` ${candidate.evidence}`}`)
    }
    for (const project of report.projects) {
      console.log(`  project   ${project.uprojectPath ?? project.projectDir}`)
      console.log(`            declared in .uproject: ${project.declared.join(', ') || 'none'}`)
      console.log(`            explicitly disabled: ${project.explicitlyDisabled.join(', ') || 'none'}`)
      console.log(`            not written in .uproject: ${project.notDeclared.join(', ') || 'none'} (absence is not "disabled")`)
      console.log(`            mcp ini: ${project.config.file ?? 'none'}  autoStart=${project.config.autoStart ?? 'unset'} port=${project.config.port ?? 'unset'}`)
      console.log(`            log: ${project.log.file ?? 'none'}  mcpPort=${project.log.port ?? 'unset'}`)
    }
    for (const note of report.notes) console.log(`  note      ${note}`)
    console.log('')
  }

  let connected
  try {
    connected = await connectToEditor({
      ...options,
      timeoutMs: 15000,
      clientName: 'dsh-unreal-engine-verify',
      clientVersion: '0.1.0',
    })
  } catch (error) {
    console.error(`\nNO EDITOR: ${error?.code ?? 'error'}: ${error?.message ?? String(error)}`)
    if (error?.hint !== undefined) console.error(`hint: ${error.hint}`)
    if (error?.detail !== undefined) console.error(`detail: ${error.detail}`)
    process.exitCode = 2
    return
  }

  console.log(`== connected ==\n  ${connected.endpoint.url} [${connected.endpoint.source}] protocol=${connected.session.protocolVersion} server=${connected.session.serverInfo.name ?? '?'} session=${connected.session.sessionId}`)

  // 1. The handshake itself is the "connected" assertion.
  check('initialize handshake returned a session id', connected.session.sessionId.length > 0, connected.session.sessionId)

  // 2. Tool listing.
  const tools = await connected.client.listTools()
  check('tools/list is non-empty', tools.length > 0, `${tools.length} tool(s): ${tools.map((tool) => tool.name).join(', ')}`)

  // 3. Toolset discovery (the editor-side capability this bridge exists for).
  let toolsetText = ''
  let describeText = ''
  let chosenTool
  let chosenToolset
  let chosenArgs = {}
  if (tools.some((tool) => tool.name === 'list_toolsets')) {
    const listed = await connected.client.callTool('list_toolsets', {})
    toolsetText = listed.text
    const catalog = parseToolsetCatalog(toolsetText)
    check('list_toolsets reports at least one toolset', !listed.isError && catalog.length > 0, `${catalog.length} toolset(s)`)

    const names = catalog.map((entry) => entry.name)
    const preferred = names.find((name) => /(^|\.)LogsToolset$/.test(name))
      ?? names.find((name) => /log/i.test(name))
      ?? names[0]

    if (preferred !== undefined) {
      const described = await connected.client.callTool('describe_toolset', { toolset_name: preferred })
      describeText = described.text
      check(`describe_toolset(${preferred}) returned a tool schema`, !described.isError && describeText.includes('tools'), preferred)
      const picked = pickReadOnlyTool(describeText)
      chosenTool = picked?.name
      chosenToolset = preferred
      chosenArgs = picked?.args ?? {}
    }
  } else {
    const native = tools.find((tool) => !['list_toolsets', 'describe_toolset', 'call_tool'].includes(tool.name))
    chosenTool = native?.name
    check('endpoint advertises native tools (tool search disabled)', native !== undefined, native?.name)
  }

  // 4. One real, side-effect-free editor call, with the editor's own result text.
  if (chosenTool !== undefined) {
    const usesDispatcher = tools.some((tool) => tool.name === 'call_tool')
    const final = usesDispatcher
      ? await connected.client.callTool('call_tool', {
        toolset_name: chosenToolset,
        tool_name: chosenTool,
        arguments: chosenArgs,
      })
      : await connected.client.callTool(chosenTool, chosenArgs)
    check(`editor tool ${chosenTool} returned a result`, final.text.length > 0 || final.structured !== undefined, final.text.slice(0, 300).replace(/\s+/g, ' '))
    check(`editor tool ${chosenTool} did not fail`, final.isError === false, final.isError ? final.text.slice(0, 300) : 'ok')
  } else {
    check('a no-side-effect editor tool was found to call', false, 'no read-only tool advertised')
  }

  if (args.json === true) {
    console.log(JSON.stringify({ endpoint: connected.endpoint, session: connected.session, tools: tools.map((tool) => tool.name), checks, failed }, null, 2))
  } else {
    console.log(`\n== summary ==\n  ${checks.length - failed}/${checks.length} checks passed`)
    if (failed > 0) console.log('  see FAIL lines above; the editor\'s own text is printed verbatim')
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`verify failed: ${error?.stack ?? String(error)}`)
  process.exitCode = 1
})
