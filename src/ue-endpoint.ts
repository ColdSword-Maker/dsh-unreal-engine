/**
 * ue-endpoint.ts — discover the HTTP base address of a running UE 5.8 editor's MCP server.
 *
 * Why discovery is required (evidence, not assumption):
 *   - `GetServerPortNumber()` (ModelContextProtocolSettings.cpp) reads
 *     `-ModelContextProtocolPort=` first, then `UModelContextProtocolSettings::ServerPortNumber`
 *     (default 8000) from `EditorPerProjectUserSettings`. The port therefore moves per project
 *     and per command line, so no single hardcoded port is correct.
 *   - `ShouldAutoStartServer()` returns false unless `-ModelContextProtocolStartServer` is on the
 *     command line or `bAutoStartServer` is set, so "endpoint reachable" and "MCP enabled" are
 *     two separate facts that must be reported separately.
 *
 * Discovery order (first reachable candidate wins):
 *   1. explicit config (`endpoint`, or `host`/`port`/`path`)
 *   2. `DSH_UE5_ENDPOINT` / `UE5_MCP_ENDPOINT` environment override
 *   3. the project's own `Saved/Logs/*.log`, which contains
 *      "Starting MCP server on port N" — the only source that proves what the *running* editor
 *      actually bound, including a command-line override
 *   4. the project's `Saved/Config/<Platform>Editor/EditorPerProjectUserSettings.ini`
 *   5. the per-user engine config (`%LOCALAPPDATA%\UnrealEngine\<Major.Minor>\Saved\Config\...`)
 *   6. the engine default port 8000
 *
 * There is no beacon file in UE 5.8's MCP stack (the only file it writes is
 * `Saved/ModelContextProtocol/ToolHashMapping.json`, from a commandlet, and client config files
 * such as `.mcp.json` written on demand). The editor log is the reliable local evidence, and the
 * INI plus config override cover the case where the log has been rotated.
 */

import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { UeBridgeError, UeMcpClient, type McpSession } from './mcp-client.js'

/** Plugins UE 5.8 needs before the MCP endpoint can serve anything useful. */
export const REQUIRED_PLUGINS = ['ModelContextProtocol', 'ToolsetRegistry', 'MCPClientToolset', 'PythonScriptPlugin'] as const

/**
 * Toolset plugins that turn the generic endpoint into an editor-driving agent.
 * They are reported separately because the endpoint still answers without them; it just exposes
 * no editor tools (`tools/list` returns only the three tool-search meta-tools).
 */
export const RECOMMENDED_PLUGINS = ['EditorToolset'] as const

/** Engine-side default, used only as the last-resort candidate. */
export const ENGINE_DEFAULT_PORT = 8000
/** Engine-side default URL path (`DefaultServerUrlPath`). */
export const ENGINE_DEFAULT_PATH = '/mcp'

/** One HTTP base address to probe. */
export interface UeEndpoint {
  /** Full URL, e.g. `http://127.0.0.1:8765/mcp`. */
  url: string
  host: string
  port: number
  path: string
  /** Which discovery source produced this candidate. */
  source: string
  /** Human-readable evidence (file and line, environment variable, config row…). */
  evidence?: string
}

/** What one project directory says about its MCP configuration. */
export interface ProjectReport {
  uprojectPath?: string
  projectDir?: string
  /** Every plugin entry written in the .uproject, verbatim. */
  plugins: Record<string, boolean>
  /**
   * Plugins of interest written with `"Enabled": true`.
   * Proven on by the project file; they may also be on for another reason, which is irrelevant.
   */
  declared: string[]
  /**
   * Plugins of interest written with `"Enabled": false` — the ONLY state the project file proves
   * to be off, and therefore the only one worth reporting as a problem.
   */
  explicitlyDisabled: string[]
  /**
   * Plugins of interest missing from the .uproject. This is NOT "disabled":
   * FProjectManager (`ProjectManager.cpp`, "Check whether the setting for any default plugin has
   * been changed") starts from `Plugin->IsEnabledByDefault(...)` and only overrides it when the
   * project writes an entry. `EditorToolset.uplugin` has no `EnabledByDefault` field
   * (`EPluginEnabledByDefault::Unspecified`), and `ToolsetRegistry` is force-enabled by
   * `ModelContextProtocol.uplugin`'s own dependency list, so both load without being listed.
   */
  notDeclared: string[]
  /** Parsed `[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]` values. */
  config: {
    file?: string
    autoStart?: boolean
    port?: number
    urlPath?: string
  }
  /** Newest `Saved/Logs/*.log` and the MCP port line found in it. */
  log: {
    file?: string
    mcpPortLine?: string
    port?: number
    /** The editor logged that the MCP plugin mounted at all. */
    pluginMounted?: boolean
  }
}

/** Everything discovery learned, whether or not a connection succeeded. */
export interface DiscoveryReport {
  candidates: UeEndpoint[]
  projects: ProjectReport[]
  notes: string[]
}

/** One probe attempt, for diagnostics. */
export interface ProbeAttempt {
  url: string
  source: string
  ok: boolean
  errorCode?: string
  message?: string
}

/** Inputs that steer discovery. */
export interface DiscoveryOptions {
  /** Explicit full URL, highest priority. */
  endpoint?: string
  /** Explicit host (default 127.0.0.1). */
  host?: string
  /** Explicit port, highest priority after `endpoint`. */
  port?: number
  /** Explicit URL path (default `/mcp`). */
  path?: string
  /** Project directories or `.uproject` files to inspect. */
  projectPaths: string[]
  /** Extra ports to probe, after the discovered ones. */
  extraPorts: number[]
  /**
   * Directories scanned for `*.uproject` when `projectPaths` is empty.
   * The caller supplies the Session's live working directory first, so discovery follows the
   * project the user actually opened instead of guessing from `process.cwd()`.
   */
  searchRoots?: string[]
  /** Environment overrides, normally `process.env`. */
  env: Record<string, string | undefined>
}

/** Read a file as UTF-8, returning undefined when it is missing or unreadable. */
async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Read at most the last `maxBytes` of a file — log files can be hundreds of megabytes. */
async function readFileTail(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const info = await stat(path)
    const length = Math.min(info.size, maxBytes)
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, info.size - length)
      return buffer.toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/** Parse one `[Section]` of an Unreal `.ini` file into a case-insensitive key map. */
export function parseIniSection(text: string, section: string): Map<string, string> {
  const wanted = section.toLowerCase()
  const values = new Map<string, string>()
  let current: string | undefined
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith(';') || line.startsWith('#')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      current = line.slice(1, -1).trim().toLowerCase()
      continue
    }
    if (current !== wanted) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim().replace(/^[+.!]/, '').toLowerCase()
    values.set(key, line.slice(eq + 1).trim())
  }
  return values
}

/** Resolve a configured project path (directory or `.uproject`) into its project directory. */
async function resolveProjectDir(projectPath: string): Promise<string | undefined> {
  const absolute = isAbsolute(projectPath) ? projectPath : resolve(projectPath)
  if (absolute.toLowerCase().endsWith('.uproject')) {
    const exists = await stat(absolute).then(() => true, () => false)
    return exists ? dirname(absolute) : undefined
  }
  try {
    const info = await stat(absolute)
    return info.isDirectory() ? absolute : undefined
  } catch {
    return undefined
  }
}

/** Find the `.uproject` file inside a project directory. */
async function findUproject(projectDir: string): Promise<string | undefined> {
  const entries = await readdir(projectDir).catch(() => [] as string[])
  const uprojects = entries.filter((entry) => entry.toLowerCase().endsWith('.uproject'))
  if (uprojects.length === 0) return undefined
  const preferred = uprojects.find((entry) => basename(entry, '.uproject') === basename(projectDir)) ?? uprojects[0]
  return join(projectDir, preferred)
}

/**
 * Bound the default project search so a bridge call never walks a whole drive.
 * Caller-supplied roots (the Session's working directory) come first, then the process directory,
 * its parent, and the usual Unreal project locations.
 */
async function defaultProjectRoots(workspaceRoot: string, searchRoots: string[] | undefined): Promise<string[]> {
  const roots = new Set<string>()
  for (const root of searchRoots ?? []) {
    if (typeof root === 'string' && root.length > 0) roots.add(root)
  }
  roots.add(workspaceRoot)
  const parent = dirname(workspaceRoot)
  if (parent !== workspaceRoot) roots.add(parent)
  roots.add(join(homedir(), 'Documents', 'Unreal Projects'))
  roots.add(join(homedir(), 'Documents'))
  return [...roots]
}

/** Collect `.uproject` files under a root, depth-limited. */
async function scanForUprojects(root: string, maxDepth: number): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || found.length >= 20) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (found.length >= 20) return
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.uproject')) {
        found.push(join(dir, entry.name))
        continue
      }
      if (!entry.isDirectory()) continue
      // Skip engine trees and generated folders: they only contain templates and build caches.
      if (['saved', 'intermediate', 'deriveddatacache', 'binaries', 'node_modules', 'engine'].includes(entry.name.toLowerCase())) continue
      await walk(join(dir, entry.name), depth + 1)
    }
  }
  await walk(root, 0)
  return found
}

/** Inspect one project: declared plugins, MCP ini settings, and editor-log evidence. */
async function inspectProject(projectDir: string): Promise<ProjectReport> {
  const report: ProjectReport = {
    projectDir,
    plugins: {},
    declared: [],
    explicitlyDisabled: [],
    notDeclared: [],
    config: {},
    log: {},
  }

  const uprojectPath = await findUproject(projectDir)
  if (uprojectPath !== undefined) {
    report.uprojectPath = uprojectPath
    const text = await readTextFile(uprojectPath)
    if (text !== undefined) {
      try {
        const parsed = JSON.parse(text) as { Plugins?: Array<{ Name?: string; Enabled?: boolean }> }
        for (const plugin of parsed.Plugins ?? []) {
          if (typeof plugin?.Name === 'string') report.plugins[plugin.Name] = plugin.Enabled === true
        }
      } catch {
        // A malformed .uproject is reported through `notes` by the caller; do not invent a
        // plugin state from it.
      }
    }
  }

  // Classify only the plugins this bridge cares about, and only by what the project file says.
  const interesting = [...REQUIRED_PLUGINS, ...RECOMMENDED_PLUGINS]
  report.declared = interesting.filter((plugin) => report.plugins[plugin] === true)
  report.explicitlyDisabled = interesting.filter((plugin) => report.plugins[plugin] === false)
  report.notDeclared = interesting.filter((plugin) => report.plugins[plugin] === undefined)

  for (const platformDir of ['WindowsEditor', 'Windows', 'WindowsClient']) {
    const iniPath = join(projectDir, 'Saved', 'Config', platformDir, 'EditorPerProjectUserSettings.ini')
    const text = await readTextFile(iniPath)
    if (text === undefined) continue
    const section = parseIniSection(text, '/Script/ModelContextProtocolEngine.ModelContextProtocolSettings')
    if (section.size === 0) continue
    report.config.file = iniPath
    const autoStart = section.get('bautostartserver')
    if (autoStart !== undefined) report.config.autoStart = /^true$/i.test(autoStart)
    const port = section.get('serverportnumber')
    if (port !== undefined && /^\d+$/.test(port)) report.config.port = Number(port)
    const urlPath = section.get('serverurlpath')
    if (urlPath !== undefined && urlPath.length > 0) report.config.urlPath = urlPath
    break
  }

  const logsDir = join(projectDir, 'Saved', 'Logs')
  const logEntries = await readdir(logsDir, { withFileTypes: true }).catch(() => [])
  const logFiles: Array<{ path: string; mtime: number }> = []
  for (const entry of logEntries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.log')) continue
    const path = join(logsDir, entry.name)
    const info = await stat(path).catch(() => undefined)
    if (info !== undefined) logFiles.push({ path, mtime: info.mtimeMs })
  }
  logFiles.sort((a, b) => b.mtime - a.mtime)
  if (logFiles.length > 0) {
    report.log.file = logFiles[0].path
    const tail = await readFileTail(logFiles[0].path, 512 * 1024)
    if (tail !== undefined) {
      // ModelContextProtocolServer.cpp logs this sentence from StartServer() every time the server
      // (re)starts, so the LAST occurrence is the port currently bound — an earlier one is a
      // previous run or a restart on a different port.
      const starts = [...tail.matchAll(/Starting MCP server on port (\d+)/gi)]
      const last = starts[starts.length - 1]
      if (last !== undefined) {
        report.log.port = Number(last[1])
        report.log.mcpPortLine = last[0]
      }
      report.log.pluginMounted = /Mounting Engine plugin ModelContextProtocol/i.test(tail)
    }
  }

  return report
}

/**
 * Enumerate endpoints worth probing for the given options.
 * Pure filesystem work: no network, no editor interaction.
 */
export async function discoverEndpoints(options: DiscoveryOptions): Promise<DiscoveryReport> {
  const notes: string[] = []
  const candidates: UeEndpoint[] = []
  const seen = new Set<string>()
  const pathDefault = options.path !== undefined && options.path.startsWith('/') ? options.path : ENGINE_DEFAULT_PATH

  const add = (port: number, path: string, source: string, evidence?: string, host?: string): void => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return
    const hostValue = host !== undefined && host.length > 0 ? host : (options.host ?? '127.0.0.1')
    const urlPath = path.startsWith('/') ? path : `/${path}`
    const url = `http://${hostValue}:${port}${urlPath}`
    if (seen.has(url)) return
    seen.add(url)
    candidates.push({ url, host: hostValue, port, path: urlPath, source, evidence })
  }

  if (options.endpoint !== undefined && options.endpoint.length > 0) {
    try {
      const parsed = new URL(options.endpoint)
      add(Number(parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : parsed.port), parsed.pathname, 'config.endpoint', 'plugin config `endpoint`')
    } catch {
      throw new UeBridgeError('bad_config', `config.endpoint is not a valid URL: ${options.endpoint}`, {
        hint: 'Use the full URL, for example http://127.0.0.1:8765/mcp.',
      })
    }
  }
  for (const envName of ['DSH_UE5_ENDPOINT', 'UE5_MCP_ENDPOINT']) {
    const value = options.env[envName]
    if (value === undefined || value.length === 0) continue
    try {
      const parsed = new URL(value)
      add(Number(parsed.port === '' ? 80 : parsed.port), parsed.pathname, `env.${envName}`, envName)
    } catch {
      notes.push(`${envName} is set but is not a valid URL; ignored.`)
    }
  }
  if (options.port !== undefined) add(options.port, pathDefault, 'config.port', 'plugin config `port`')

  let projectPaths: string[]
  if (options.projectPaths.length > 0) {
    projectPaths = options.projectPaths
  } else {
    // Scan every root (Session working directory first) and merge, so a project anywhere on the
    // caller's path is found without an explicit `projectPaths` entry.
    const roots = await defaultProjectRoots(process.cwd(), options.searchRoots)
    const scanned = await Promise.all(roots.map(async (root) => scanForUprojects(root, 3)))
    projectPaths = [...new Set(scanned.flat())]
  }

  if (options.projectPaths.length === 0 && projectPaths.length === 0) {
    const roots = await defaultProjectRoots(process.cwd(), options.searchRoots)
    notes.push(`No .uproject found under ${roots.slice(0, 4).join(', ')}; set projectPaths in the plugin config (or endpoint) to target a project elsewhere.`)
  }

  const projects: ProjectReport[] = []
  const projectDirs = new Set<string>()
  for (const projectPath of projectPaths) {
    const dir = await resolveProjectDir(projectPath)
    if (dir === undefined) {
      notes.push(`Project path not found or not a directory: ${projectPath}`)
      continue
    }
    if (projectDirs.has(dir)) continue
    projectDirs.add(dir)
    const report = await inspectProject(dir)
    projects.push(report)
    if (report.log.port !== undefined) {
      add(report.log.port, report.config.urlPath ?? pathDefault, 'editor-log', `${report.log.file}: "${report.log.mcpPortLine}"`)
    }
    if (report.config.port !== undefined) {
      add(report.config.port, report.config.urlPath ?? pathDefault, 'project-ini', `${report.config.file}`)
    }
    if (report.config.autoStart === false) {
      notes.push(`${report.uprojectPath ?? dir}: bAutoStartServer is false (or unset) — the MCP server does not start by itself; the editor needs -ModelContextProtocolStartServer or bAutoStartServer=True.`)
    }
  }

  // Per-user engine config: the settings class is project-scoped, but a user may have edited the
  // global copy; read it only for a port hint, never to override a project value.
  const localAppData = options.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
  const engineRoot = join(localAppData, 'UnrealEngine')
  const engineVersions = await readdir(engineRoot).catch(() => [] as string[])
  for (const version of engineVersions) {
    for (const platformDir of ['WindowsEditor', 'Windows']) {
      const iniPath = join(engineRoot, version, 'Saved', 'Config', platformDir, 'EditorPerProjectUserSettings.ini')
      const text = await readTextFile(iniPath)
      if (text === undefined) continue
      const section = parseIniSection(text, '/Script/ModelContextProtocolEngine.ModelContextProtocolSettings')
      const port = section.get('serverportnumber')
      if (port !== undefined && /^\d+$/.test(port)) {
        add(Number(port), section.get('serverurlpath') ?? pathDefault, 'user-ini', iniPath)
      }
    }
  }

  for (const port of options.extraPorts) add(port, pathDefault, 'config.ports', 'plugin config `ports`')
  add(ENGINE_DEFAULT_PORT, pathDefault, 'engine-default', 'UE 5.8 DefaultServerPort')

  return { candidates, projects, notes }
}

/** Options for a full connect (discovery + probe). */
export interface ConnectOptions extends DiscoveryOptions {
  timeoutMs: number
  signal?: AbortSignal
  clientName: string
  clientVersion: string
}

/** A connected endpoint and everything discovery learned on the way. */
export interface ConnectedEditor {
  client: UeMcpClient
  endpoint: UeEndpoint
  session: McpSession
  report: DiscoveryReport
  attempts: ProbeAttempt[]
}

/**
 * Probe candidates with a real `initialize` and return the first editor that answers.
 * A failed probe leaves no session behind beyond the engine's own bookkeeping.
 */
export async function connectToEditor(options: ConnectOptions): Promise<ConnectedEditor> {
  const report = await discoverEndpoints(options)
  const attempts: ProbeAttempt[] = []

  for (const candidate of report.candidates) {
    const client = new UeMcpClient(candidate.url, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      clientName: options.clientName,
      clientVersion: options.clientVersion,
    })
    try {
      const session = await client.connect()
      attempts.push({ url: candidate.url, source: candidate.source, ok: true })
      return { client, endpoint: candidate, session, report, attempts }
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      const code = error instanceof UeBridgeError ? error.code : 'unknown'
      attempts.push({
        url: candidate.url,
        source: candidate.source,
        ok: false,
        errorCode: code,
        message: error instanceof Error ? error.message : String(error),
      })
      // A timeout means something *is* listening but the editor is busy: keep that as the
      // reported cause if nothing else answers, instead of overwriting it with "not running".
      if (code === 'aborted') throw error
    }
  }

  const timeoutAttempt = attempts.find((attempt) => attempt.errorCode === 'ue_timeout')
  const details = attempts.length === 0
    ? 'no candidate endpoints were produced'
    : attempts.map((attempt) => `${attempt.url} [${attempt.source}] ${attempt.errorCode ?? 'error'}: ${attempt.message ?? ''}`).join('; ')

  if (timeoutAttempt !== undefined) {
    throw new UeBridgeError(
      'ue_timeout',
      `An endpoint accepted the connection but did not complete the MCP handshake: ${timeoutAttempt.message}`,
      {
        detail: details,
        attempts,
        hint: 'The editor is running but busy or blocked by a modal dialog. Retry, or raise requestTimeoutMs.',
      },
    )
  }

  const mounted = report.projects.some((project) => project.log.pluginMounted === true)
  const autoStartOff = report.projects.some((project) => project.config.autoStart !== true)
  const hint = mounted
    ? 'The editor log shows the MCP plugin mounted but no port answered: the server was never started. Restart the editor with -ModelContextProtocolStartServer, or set bAutoStartServer=True in Saved/Config/WindowsEditor/EditorPerProjectUserSettings.ini under [/Script/ModelContextProtocolEngine.ModelContextProtocolSettings].'
    : autoStartOff
      ? 'Start the UE 5.8 editor, then enable the MCP server: -ModelContextProtocolStartServer on the command line, or bAutoStartServer=True in the project ini.'
      : 'Start the UE 5.8 project that has the MCP plugins enabled, then retry.'

  throw new UeBridgeError('editor_not_running', 'No running UE editor MCP endpoint answered the initialize handshake', {
    detail: details,
    hint,
    attempts,
    ...(report.notes.length === 0 ? {} : { notes: report.notes }),
  })
}
