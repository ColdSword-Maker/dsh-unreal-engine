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

import { connectToEditor, discoverEndpoints,                                            } from './ue-endpoint.js'
import { UeBridgeError } from './mcp-client.js'
                                              
import { createToolDefinitions, DEFAULT_MAX_RESULT_CHARS, defineTool, META_TOOL_NAMES, PLUGIN_VERSION,                                    } from './tools.js'

/** Plugin name used in Loader diagnostics. */
export const name = 'ue5'

/** The one hard service dependency: the tool registry. */
export const inject = ['tools']         

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MIRROR_LIMIT = 32

/** Raw configuration as written in `cordis.patch.yml`. */
                            
                                                                                      
                   
                                              
               
                                                         
               
                                                                  
               
                                                                                              
                         
                                                        
                  
                                                            
                           
                                                                                                    
                         
                                                                      
                       
                                                      
                      
 

/** Validated configuration with defaults applied. */
                          
                   
               
               
               
                        
                 
                          
                        
                      
                     
 

/** Fail plugin load with an actionable message instead of a TypeError deep inside a tool call. */
function resolveConfig(config         )                 {
  // YAML `key:` with no value arrives as null; treat it as "not configured" rather than invalid.
  const raw            = {}
  for (const [key, value] of Object.entries((config ?? {})                           )) {
    if (value !== null) (raw                           )[key] = value
  }
  const fail = (field        , expected        )        => {
    throw new Error(`ue5: config.${field} must be ${expected} (got ${JSON.stringify((raw                           )[field])})`)
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
function fuse(caller                         , plugin             )              {
  return caller === undefined ? plugin : AbortSignal.any([caller, plugin])
}

/** Minimal logger surface; tolerates a host without `logger` service. */
                  
                              
                              
 

/**
 * Owns endpoint discovery, the cached session, and the plugin-lifetime aborter.
 * One instance per plugin activation.
 */
class EditorBridge                     {
                   config                
                   logger        
                   rootsFor                               
                   aborter = new AbortController()
          cached                  
          pending                           
  /** Set by `apply` so a `tools/list` response can refresh the optional mirror. */
  onToolsListed                             

  constructor(config                , logger        , rootsFor                               ) {
    this.config = config
    this.logger = logger
    this.rootsFor = rootsFor
  }

  /** Forget the connection so the next call re-discovers (used by `ue_status refresh`). */
  invalidate()       {
    this.cached = undefined
    this.pending = undefined
  }

  /** Abort every in-flight request; called from the plugin's effect disposer. */
  dispose()       {
    this.cached = undefined
    this.pending = undefined
    this.aborter.abort(new Error('ue5 plugin unloaded'))
  }

  /** Filesystem-only discovery, safe to call with no editor running. */
  async discover(_signal             , agent          )                           {
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
  async connect(signal             , agent          )                           {
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
      .catch((error         ) => {
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
  afterToolsListed(tools           )       {
    this.onToolsListed?.(tools)
  }

  /**
   * Run an operation against the current editor, healing a stale endpoint once.
   * Those three codes all mean "the address I cached is no longer the editor's MCP server":
   * the process exited, the listener moved, or the routes were rebound on another port.
   */
  async call   (
    signal             ,
    agent         ,
    operation                                         ,
  )                                                 {
    const first = await this.connect(signal, agent)
    try {
      return { editor: first, value: await operation(first) }
    } catch (error) {
      const code = (error                     ).code
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
function mirrorDefinition(source         , bridge          )                 {
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
        const result = await editor.client.callTool(source.name, args                         )
        return {
          ok: true,
          isError: result.isError,
          text: result.text,
          ...(result.structured === undefined ? {} : { structured: result.structured }),
        }
      } catch (error) {
        const failure = error                                                      
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
export function sanitizeSchema(schema                                     )                          {
  const fallback = { type: 'object', additionalProperties: true }
  if (schema === undefined) return fallback
  const walk = (node         )          => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return node
    const source = node                           
    const output                          = {}
    for (const [key, value] of Object.entries(source)) {
      if (!SUPPORTED_KEYWORDS.has(key)) continue
      if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const properties                          = {}
        for (const [propertyName, propertySchema] of Object.entries(value                           )) {
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
  const root = walk(schema)                           
  if (root.type !== 'object' || root.properties === undefined) return fallback
  return root
}

/**
 * Register every tool and the plugin-lifetime aborter.
 * `apply` stays synchronous: no `await` here, no network on load.
 */
export function apply(ctx               , config          )       {
  const resolved = resolveConfig(config)
  const logger = (ctx                       ).logger ?? {}
  /**
   * Discovery roots, most specific first: the calling Session's committed working directory (the
   * project the user opened), then `process.cwd()`. The working-directory service is optional so
   * the plugin still loads in a profile without it.
   */
  const workingDirectory = ctx.get?.('workingDirectory')   
                                                                  
               
  const rootsFor = (agent          )           => {
    const roots           = []
    const session = (agent                                     )?.session
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
  const mirrorDisposers = new Map                    ()
  const registerMirror = (tool         )       => {
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
                                
                                                             
                                                
                                                                                          
                             
                 
 

export { UeBridgeError }
