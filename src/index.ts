/**
 * index.ts — DSH plugin that drives a UE 5.8 editor through the editor process's own MCP server.
 *
 * Architecture (deliberate, see README): DSH tool plugin → HTTP → in-editor MCP endpoint.
 * The engine already runs an FHttpServerModule router inside the editor
 * (ModelContextProtocolServer::StartServer), so this plugin is a client only. It never starts a
 * stdio MCP child process, never opens its own TCP listener, and never ships C++ or Python: the
 * Python that EditorToolset's toolsets use executes inside the editor, not here.
 *
 * Lifecycle contract honoured here:
 *   - `apply` is synchronous and does no network I/O; the endpoint is discovered on the first
 *     tool call, so a stopped editor never blocks plugin load.
 *   - Every registration (each tool, the optional mirror, and the request aborter) is created
 *     inside `ctx.effect`, so unload/HMR removes them and aborts anything in flight.
 */

import { connectToEditor, discoverEndpoints, type ConnectedEditor, type DiscoveryReport } from './ue-endpoint.js'
import { UeBridgeError } from './mcp-client.js'
import type { McpTool } from './mcp-client.js'
import { createToolDefinitions, DEFAULT_MAX_RESULT_CHARS, defineTool, META_TOOL_NAMES, PLUGIN_VERSION, type ToolDefinition, type UeBridge } from './tools.js'

/** Plugin name used in Loader diagnostics. */
export const name = 'ue5'

/** The one hard service dependency: the tool registry. */
export const inject = ['tools'] as const

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MIRROR_LIMIT = 32

/** Raw configuration as written in `cordis.patch.yml`. */
export interface Ue5Config {
  /** Full endpoint URL, e.g. `http://127.0.0.1:8765/mcp`. Overrides all discovery. */
  endpoint?: string
  /** Host to probe; defaults to 127.0.0.1. */
  host?: string
  /** Port to probe, before project and log discovery. */
  port?: number
  /** URL path, defaults to `/mcp` (UE's DefaultServerUrlPath). */
  path?: string
  /** Project directories or `.uproject` files to inspect. Empty = scan near the workspace. */
  projectPaths?: string[]
  /** Extra ports to probe after the discovered ones. */
  ports?: number[]
  /** Per-request timeout in milliseconds; default 15000. */
  requestTimeoutMs?: number
  /** Cap on raw editor text returned by `ue_call`; default 8000 (schemas are paginated instead). */
  maxResultChars?: number
  /** Mirror native editor tools as `ue_tool_<name>`; default true. */
  mirrorTools?: boolean
  /** Maximum number of mirrored tools; default 32. */
  mirrorLimit?: number
}

/** Validated configuration with defaults applied. */
interface ResolvedConfig {
  endpoint?: string
  host?: string
  port?: number
  path?: string
  projectPaths: string[]
  ports: number[]
  requestTimeoutMs: number
  maxResultChars: number
  mirrorTools: boolean
  mirrorLimit: number
}

/** Fail plugin load with an actionable message instead of a TypeError deep inside a tool call. */
function resolveConfig(config: unknown): ResolvedConfig {
  // YAML `key:` with no value arrives as null; treat it as "not configured" rather than invalid.
  const raw: Ue5Config = {}
  for (const [key, value] of Object.entries((config ?? {}) as Record<string, unknown>)) {
    if (value !== null) (raw as Record<string, unknown>)[key] = value
  }
  const fail = (field: string, expected: string): never => {
    throw new Error(`ue5: config.${field} must be ${expected} (got ${JSON.stringify((raw as Record<string, unknown>)[field])})`)
  }
  if (raw.endpoint !== undefined && typeof raw.endpoint !== 'string') fail('endpoint', 'a string URL')
  if (raw.host !== undefined && typeof raw.host !== 'string') fail('host', 'a string')
  if (raw.port !== undefined && (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535)) fail('port', 'an integer 1-65535')
  if (raw.path !== undefined && (typeof raw.path !== 'string' || !raw.path.startsWith('/'))) fail('path', 'a string starting with "/"')
  if (raw.projectPaths !== undefined && (!Array.isArray(raw.projectPaths) || raw.projectPaths.some((entry) => typeof entry !== 'string'))) {
    fail('projectPaths', 'an array of strings')
  }
  if (raw.ports !== undefined && (!Array.isArray(raw.ports) || raw.ports.some((entry) => !Number.isInteger(entry)))) {
    fail('ports', 'an array of integers')
  }
  if (raw.requestTimeoutMs !== undefined && (!Number.isInteger(raw.requestTimeoutMs) || raw.requestTimeoutMs < 1000 || raw.requestTimeoutMs > 120_000)) {
    fail('requestTimeoutMs', 'an integer 1000-120000')
  }
  if (raw.maxResultChars !== undefined && (!Number.isInteger(raw.maxResultChars) || raw.maxResultChars < 1000 || raw.maxResultChars > 200_000)) {
    fail('maxResultChars', 'an integer 1000-200000')
  }
  if (raw.mirrorLimit !== undefined && (!Number.isInteger(raw.mirrorLimit) || raw.mirrorLimit < 0 || raw.mirrorLimit > 256)) {
    fail('mirrorLimit', 'an integer 0-256')
  }
  return {
    endpoint: raw.endpoint,
    host: raw.host,
    port: raw.port,
    path: raw.path,
    projectPaths: [...(raw.projectPaths ?? [])],
    ports: [...(raw.ports ?? [])],
    requestTimeoutMs: raw.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResultChars: raw.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
    mirrorTools: raw.mirrorTools ?? true,
    mirrorLimit: raw.mirrorLimit ?? DEFAULT_MIRROR_LIMIT,
  }
}

/** Compose the plugin-lifetime abort signal with a per-call one. */
function fuse(caller: AbortSignal | undefined, plugin: AbortSignal): AbortSignal {
  return caller === undefined ? plugin : AbortSignal.any([caller, plugin])
}

/** Minimal logger surface; tolerates a host without `logger` service. */
interface Logger {
  info?(message: string): void
  warn?(message: string): void
}

/**
 * Owns endpoint discovery, the cached session, and the plugin-lifetime aborter.
 * One instance per plugin activation.
 */
class EditorBridge implements UeBridge {
  private readonly config: ResolvedConfig
  private readonly logger: Logger
  private readonly rootsFor: (agent?: unknown) => string[]
  private readonly aborter = new AbortController()
  private cached?: ConnectedEditor
  private pending?: Promise<ConnectedEditor>
  /** Set by `apply` so a `tools/list` response can refresh the optional mirror. */
  onToolsListed?: (tools: McpTool[]) => void

  constructor(config: ResolvedConfig, logger: Logger, rootsFor: (agent?: unknown) => string[]) {
    this.config = config
    this.logger = logger
    this.rootsFor = rootsFor
  }

  /** Forget the connection so the next call re-discovers (used by `ue_status refresh`). */
  invalidate(): void {
    this.cached = undefined
    this.pending = undefined
  }

  /** Abort every in-flight request; called from the plugin's effect disposer. */
  dispose(): void {
    this.cached = undefined
    this.pending = undefined
    this.aborter.abort(new Error('ue5 plugin unloaded'))
  }

  /** Filesystem-only discovery, safe to call with no editor running. */
  async discover(_signal: AbortSignal, agent?: unknown): Promise<DiscoveryReport> {
    return discoverEndpoints({
      endpoint: this.config.endpoint,
      host: this.config.host,
      port: this.config.port,
      path: this.config.path,
      projectPaths: this.config.projectPaths,
      extraPorts: this.config.ports,
      searchRoots: this.rootsFor(agent),
      env: process.env,
    })
  }

  /** Return the live editor connection, discovering it on first use. */
  async connect(signal: AbortSignal, agent?: unknown): Promise<ConnectedEditor> {
    if (this.cached !== undefined) return this.cached
    if (this.pending !== undefined) return this.pending
    const merged = fuse(signal, this.aborter.signal)
    const attempt = connectToEditor({
      endpoint: this.config.endpoint,
      host: this.config.host,
      port: this.config.port,
      path: this.config.path,
      projectPaths: this.config.projectPaths,
      extraPorts: this.config.ports,
      searchRoots: this.rootsFor(agent),
      env: process.env,
      timeoutMs: this.config.requestTimeoutMs,
      signal: merged,
      clientName: 'dsh-unreal-engine',
      clientVersion: PLUGIN_VERSION,
    })
      .then((connected) => {
        this.cached = connected
        this.logger.info?.(`ue5: connected to ${connected.endpoint.url} (${connected.endpoint.source})`)
        return connected
      })
      .catch((error: unknown) => {
        this.pending = undefined
        throw error
      })
      .finally(() => {
        this.pending = undefined
      })
    this.pending = attempt
    return attempt
  }

  /** Hand the advertised tools to the mirror owner, if any. */
  afterToolsListed(tools: McpTool[]): void {
    this.onToolsListed?.(tools)
  }

  /**
   * Run an operation against the current editor, healing a stale endpoint once.
   * Those three codes all mean "the address I cached is no longer the editor's MCP server":
   * the process exited, the listener moved, or the routes were rebound on another port.
   */
  async call<T>(
    signal: AbortSignal,
    agent: unknown,
    operation: (editor: ConnectedEditor) => Promise<T>,
  ): Promise<{ editor: ConnectedEditor; value: T }> {
    const first = await this.connect(signal, agent)
    try {
      return { editor: first, value: await operation(first) }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'editor_not_running' && code !== 'endpoint_unreachable' && code !== 'endpoint_stale') throw error
      this.logger.warn?.(`ue5: ${code} at ${first.endpoint.url}; re-discovering the editor endpoint`)
      this.invalidate()
      const second = await this.connect(signal, agent)
      return { editor: second, value: await operation(second) }
    }
  }
}

/**
 * Build a definition that forwards one advertised editor tool to the endpoint.
 * The engine's own `inputSchema` is used when it stays inside the DSH schema subset; otherwise the
 * mirror accepts a free-form object, so a schema this plugin cannot express never breaks the call.
 */
function mirrorDefinition(source: McpTool, bridge: UeBridge): ToolDefinition {
  const sanitized = sanitizeSchema(source.inputSchema)
  return defineTool({
    name: `ue_tool_${source.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`,
    description: `Mirror of the UE editor tool \`${source.name}\`${source.description === undefined ? '' : `: ${source.description}`} Call the editor directly; use ue_call when this mirror is missing or out of date.`,
    parameters: sanitized,
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const signal = exec.signal ?? new AbortController().signal
      try {
        const editor = await bridge.connect(signal)
        const result = await editor.client.callTool(source.name, args as Record<string, never>)
        return {
          ok: true,
          isError: result.isError,
          text: result.text,
          ...(result.structured === undefined ? {} : { structured: result.structured }),
        }
      } catch (error) {
        const failure = error as { code?: string; message?: string; hint?: string }
        return {
          ok: false,
          problem: {
            code: typeof failure.code === 'string' ? failure.code : 'error',
            message: typeof failure.message === 'string' ? failure.message : String(error),
            ...(typeof failure.hint === 'string' ? { hint: failure.hint } : {}),
          },
        }
      }
    },
  })
}

/** Keywords the DSH tool-schema subset enforces; anything else is dropped, never guessed. */
const SUPPORTED_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
])

/** Keep only supported keywords, recursively; fall back to an open object when the root is unusable. */
export function sanitizeSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const fallback = { type: 'object', additionalProperties: true }
  if (schema === undefined) return fallback
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return node
    const source = node as Record<string, unknown>
    const output: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source)) {
      if (!SUPPORTED_KEYWORDS.has(key)) continue
      if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const properties: Record<string, unknown> = {}
        for (const [propertyName, propertySchema] of Object.entries(value as Record<string, unknown>)) {
          properties[propertyName] = walk(propertySchema)
        }
        output.properties = properties
        continue
      }
      if (key === 'oneOf' && Array.isArray(value)) {
        output.oneOf = value.map(walk)
        continue
      }
      if (key === 'items') {
        output.items = walk(value)
        continue
      }
      if (key === 'type' && Array.isArray(value)) continue
      output[key] = value
    }
    return output
  }
  const root = walk(schema) as Record<string, unknown>
  if (root.type !== 'object' || root.properties === undefined) return fallback
  return root
}

/**
 * Register every tool and the plugin-lifetime aborter.
 * `apply` stays synchronous: no `await` here, no network on load.
 */
export function apply(ctx: PluginContext, config?: unknown): void {
  const resolved = resolveConfig(config)
  const logger = (ctx as { logger?: Logger }).logger ?? {}
  /**
   * Discovery roots, most specific first: the calling Session's committed working directory (the
   * project the user opened), then `process.cwd()`. The working-directory service is optional so
   * the plugin still loads in a profile without it.
   */
  const workingDirectory = ctx.get?.('workingDirectory') as
    | { get(session: unknown): string; defaultDirectory?: string }
    | undefined
  const rootsFor = (agent?: unknown): string[] => {
    const roots: string[] = []
    const session = (agent as { session?: unknown } | undefined)?.session
    if (workingDirectory !== undefined && session !== undefined) {
      try {
        const directory = workingDirectory.get(session)
        if (typeof directory === 'string' && directory.length > 0) roots.push(directory)
      } catch {
        // A session without a recorded directory falls through to the process directory.
      }
    }
    if (workingDirectory?.defaultDirectory !== undefined) roots.push(workingDirectory.defaultDirectory)
    try {
      roots.push(process.cwd())
    } catch {
      // A host without a readable cwd simply contributes no extra root.
    }
    return roots
  }
  const bridge = new EditorBridge(resolved, logger, rootsFor)

  // Mirror bookkeeping. Registrations happen inside the effect chain below so unload removes them.
  const mirrorDisposers = new Map<string, () => void>()
  const registerMirror = (tool: McpTool): void => {
    const definition = mirrorDefinition(tool, bridge)
    if (mirrorDisposers.has(definition.name)) return
    try {
      mirrorDisposers.set(definition.name, ctx.tools.register(definition))
    } catch (error) {
      logger.warn?.(`ue5: could not mirror editor tool ${tool.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  bridge.onToolsListed = (tools) => {
    if (!resolved.mirrorTools || resolved.mirrorLimit === 0) return
    const native = tools.filter((tool) => !META_TOOL_NAMES.has(tool.name)).slice(0, resolved.mirrorLimit)
    const wanted = new Set(native.map((tool) => `ue_tool_${tool.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`))
    for (const [mirroredName, dispose] of [...mirrorDisposers]) {
      if (wanted.has(mirroredName)) continue
      try {
        dispose()
      } catch {
        // A mirror that already vanished is not an error.
      }
      mirrorDisposers.delete(mirroredName)
    }
    for (const tool of native) registerMirror(tool)
  }

  // 1. Plugin-lifetime resources: abort in-flight requests and drop mirrors on unload.
  ctx.effect(() => () => {
    bridge.dispose()
    for (const dispose of mirrorDisposers.values()) {
      try {
        dispose()
      } catch {
        // Ignored: the registry is going away anyway.
      }
    }
    mirrorDisposers.clear()
  })

  // 2. The fixed tool surface. One effect per tool so a partial failure removes only that tool.
  const definitions = createToolDefinitions(bridge, { maxResultChars: resolved.maxResultChars })
  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition))
  }

  logger.info?.(`ue5: registered ${definitions.length} tools; endpoint discovery runs on first call`)
}

/** The subset of the Cordis plugin context this plugin uses. */
export interface PluginContext {
  tools: { register(definition: ToolDefinition): () => void }
  effect(callback: () => () => void): () => void
  /** Optional service lookup; `workingDirectory` is used when the profile provides it. */
  get?(name: string): unknown
  logger?: Logger
}

export { UeBridgeError }
