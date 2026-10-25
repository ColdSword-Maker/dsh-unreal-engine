/**
 * tools.ts â€?the model-facing tools this plugin registers.
 *
 * ## Tool exposure granularity (the decision the task asks for)
 *
 * Two shapes were possible: mirror every tool the endpoint advertises, or expose a small fixed
 * surface plus an escape hatch. The engine settles it:
 *
 *   - UE 5.8 ships with `bEnableToolSearch = true` (ModelContextProtocolSettings.h). In that mode
 *     `tools/list` advertises exactly three meta-tools â€?`list_toolsets`, `describe_toolset`,
 *     `call_tool` â€?and never registers a toolset tool natively
 *     (FToolsetRegistryToolAdapterManager::RegisterTools). Mirroring would therefore produce three
 *     tools that every editor project already has, one of which is a generic dispatcher anyway.
 *   - With `bEnableToolSearch = false` the endpoint advertises *every* toolset tool, which on a
 *     full install is hundreds: registering them costs a large prompt on every turn.
 *
 * So the primary surface is fixed and curated (status, discovery, dispatch). `mirrorTools` in the
 * plugin's config additionally mirrors *native* (non-meta) tools with a `ue_tool_` prefix, capped
 * by `mirrorLimit`, for projects that turn tool search off. The mirror is a convenience layer;
 * `ue_call` always remains the escape hatch, so a mirror failure can never remove access.
 *
 * Meta-tools are deliberately NOT mirrored under a second name: `ue_list_toolsets`,
 * `ue_describe_toolset`, and `ue_call` already cover them with better defaults.
 */

import type { ConnectedEditor, DiscoveryReport, ProbeAttempt, ProjectReport, UeEndpoint } from './ue-endpoint.js'
import type { McpTool, McpToolResult } from './mcp-client.js'

/** Reported in `ue_status` so a stale module generation is distinguishable from a fresh one. */
export const PLUGIN_VERSION = '0.1.5'

/** The execution context handed to a tool body. */
export interface ToolRunContext {
  signal?: AbortSignal
  /** The calling agent, used to resolve that Session's working directory for discovery. */
  agent?: unknown
}

/** The one content block shape used by these tools. */
export interface TextBlock {
  type: 'text'
  text: string
}

/** Output contract: an enforced JSON Schema plus its renderer. */
export interface ToolOutputDefinition {
  schema: Record<string, unknown>
  render(args: Record<string, unknown>, value: unknown): TextBlock[]
  presentationMeta?(args: Record<string, unknown>, value: unknown): unknown
}

/** The definition shape `ctx.tools.register` accepts. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: ToolOutputDefinition
  execute(args: Record<string, unknown>, exec: ToolRunContext): Promise<unknown>
  presentCall?(args: Record<string, unknown>): Record<string, unknown>
  isConcurrencySafe?(args: Record<string, unknown>): boolean
}

/** Identity helper: keeps definitions explicit and lets TypeScript check the contract. */
export function defineTool<T extends ToolDefinition>(definition: T): T {
  return definition
}

/** What the tools need from the plugin's connection owner (implemented in index.ts). */
export interface UeBridge {
  /** Discover + probe + handshake, cached per editor endpoint. */
  connect(signal: AbortSignal, agent?: unknown): Promise<ConnectedEditor>
  /**
   * Run one operation against the live editor, re-discovering once when the cached endpoint has
   * gone away. The port is not a contract: the engine restarts its MCP server on the configured
   * port at any time, so a stale connection must heal instead of failing the agent's call.
   */
  call<T>(signal: AbortSignal, agent: unknown, operation: (editor: ConnectedEditor) => Promise<T>): Promise<{ editor: ConnectedEditor; value: T }>
  /** Filesystem-only discovery, usable while no editor is running. */
  discover(signal: AbortSignal, agent?: unknown): Promise<DiscoveryReport>
  /** Called after a successful `tools/list` so the plugin can refresh the optional mirror. */
  afterToolsListed(tools: McpTool[]): void
  /** Drop the cached connection so the next call re-discovers the endpoint. */
  invalidate(): void
}

/** Names the engine uses for tool-search mode; never mirrored twice. */
export const META_TOOL_NAMES = new Set(['list_toolsets', 'describe_toolset', 'call_tool'])

/**
 * Default cap on raw editor text returned to the model. It applies to `ue_call` and to the raw
 * fallbacks only: toolset schemas are paginated (`offset`/`limit`) and readable per tool
 * (`tool_name`), so completeness never depends on this number.
 */
export const DEFAULT_MAX_RESULT_CHARS = 8000

/** Bound one raw editor payload, marking the omission instead of hiding it. */
function boundText(text: string, limit: number): { text: string; truncated: boolean; totalChars: number } {
  if (text.length <= limit) return { text, truncated: false, totalChars: text.length }
  return {
    text: `${text.slice(0, limit)}\nâ€?[truncated by the DSH ue5 bridge: ${text.length} characters total, ${text.length - limit} omitted. Narrow the request: pass a category/pattern/maxEntries filter, or call a tool whose result is smaller.]`,
    truncated: true,
    totalChars: text.length,
  }
}

/** Declare an object schema for tool arguments. */
function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length === 0 ? {} : { required }),
  }
}

/** Format a value for the model: a summary line first, then the payload as pretty JSON. */
function textOfValue(summary: string, value: unknown): TextBlock[] {
  return [{ type: 'text', text: `${summary}\n${JSON.stringify(value, null, 2)}` }]
}

/** Flatten a bridge error into the payload the tools return. */
function problemOf(error: unknown): {
  code: string
  message: string
  hint?: string
  detail?: string
} {
  const candidate = error as { code?: unknown; message?: unknown; hint?: unknown; detail?: unknown }
  return {
    code: typeof candidate?.code === 'string' ? candidate.code : 'error',
    message: typeof candidate?.message === 'string' ? candidate.message : String(error),
    ...(typeof candidate?.hint === 'string' ? { hint: candidate.hint } : {}),
    ...(typeof candidate?.detail === 'string' ? { detail: candidate.detail } : {}),
  }
}

/** What the live editor actually serves â€?observed from `list_toolsets`, never inferred. */
export interface LiveCapabilities {
  toolsetCount: number
  toolsets: Array<{ name: string; description?: string }>
  /** True when at least one toolset comes from the EditorToolset plugin. */
  hasEditorToolset: boolean
}

/** A toolset name as the engine writes it: an ASCII identifier with at least one dot. */
const TOOLSET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/

/**
 * Parse the text `list_toolsets` returns:
 *   `- Name: description` per toolset, with descriptions allowed to wrap onto indented lines.
 *
 * A description can itself contain lines that begin with `- ` at column 0 (several engine toolsets
 * document bullet lists that way), so a bullet line only starts a new entry when its leading token
 * is a dotted identifier. Anything else continues the previous description instead of inventing a
 * toolset named after a sentence fragment.
 */
export function parseToolsetCatalog(text: string): Array<{ name: string; description?: string }> {
  const entries: Array<{ name: string; description?: string }> = []
  let current: { name: string; description?: string } | undefined
  const append = (fragment: string): void => {
    if (current === undefined) return
    current.description = `${current.description ?? ''} ${fragment}`.trim()
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (line.startsWith('- ')) {
      const body = line.slice(2)
      const separator = body.indexOf(': ')
      const candidate = (separator < 0 ? body : body.slice(0, separator)).trim()
      if (TOOLSET_NAME_RE.test(candidate)) {
        current = separator < 0
          ? { name: candidate }
          : { name: candidate, description: body.slice(separator + 2).trim() }
        entries.push(current)
        continue
      }
      // A bullet inside a description, not a new toolset.
      append(body.trim())
      continue
    }
    if (current !== undefined && /^\s+\S/.test(line)) append(line.trim())
  }
  return entries.filter((entry) => entry.name.length > 0)
}

/** Summarise a toolset catalogue for `ue_status`. */
export function summarizeToolsets(text: string): LiveCapabilities {
  const toolsets = parseToolsetCatalog(text)
  return {
    toolsetCount: toolsets.length,
    toolsets,
    hasEditorToolset: toolsets.some((entry) => entry.name.startsWith('EditorToolset.')),
  }
}

/** One tool entry of a toolset JSON schema. */
export interface ParsedTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

/** A toolset schema as `describe_toolset` returns it. */
export interface ParsedToolset {
  name?: string
  version?: string
  description?: string
  tools: ParsedTool[]
}

/** Parse `describe_toolset` output; undefined when the engine answered with something else. */
export function parseToolsetSchema(text: string): ParsedToolset | undefined {
  try {
    const parsed = JSON.parse(text) as { name?: string; version?: string; description?: string; tools?: ParsedTool[] }
    if (!Array.isArray(parsed?.tools)) return undefined
    return {
      name: parsed.name,
      version: parsed.version,
      description: parsed.description,
      tools: parsed.tools.filter((tool) => typeof tool?.name === 'string'),
    }
  } catch {
    return undefined
  }
}

/** The bare name of a toolset tool (`EditorToolset.LogsToolset.GetLogEntries` â†?`GetLogEntries`). */
export function bareToolName(qualified: string): string {
  const parts = qualified.split('.')
  return parts[parts.length - 1] ?? qualified
}

/**
 * The `project` slice of `ue_status`: what the .uproject *says*, never what it implies.
 * `explicitlyDisabled` is the only actionable field; `notDeclared` is informational because UE
 * enables such a plugin by descriptor default or dependency (ProjectManager.cpp).
 */
function projectPayload(project: ProjectReport): Record<string, unknown> {
  return {
    ...(project.uprojectPath === undefined ? {} : { uprojectPath: project.uprojectPath }),
    ...(project.projectDir === undefined ? {} : { projectDir: project.projectDir }),
    declared: project.declared,
    explicitlyDisabled: project.explicitlyDisabled,
    notDeclared: project.notDeclared,
  }
}

/** The `mcpConfig` slice of `ue_status`. */
function configPayload(project: ProjectReport): Record<string, unknown> {
  return {
    ...(project.config.file === undefined ? {} : { file: project.config.file }),
    ...(project.config.autoStart === undefined ? {} : { autoStart: project.config.autoStart }),
    ...(project.config.port === undefined ? {} : { port: project.config.port }),
    ...(project.config.urlPath === undefined ? {} : { urlPath: project.config.urlPath }),
  }
}

/** The `editorLog` slice of `ue_status`. */
function logPayload(project: ProjectReport): Record<string, unknown> {
  return {
    ...(project.log.file === undefined ? {} : { file: project.log.file }),
    ...(project.log.port === undefined ? {} : { port: project.log.port }),
    ...(project.log.mcpPortLine === undefined ? {} : { mcpPortLine: project.log.mcpPortLine }),
    ...(project.log.pluginMounted === undefined ? {} : { pluginMounted: project.log.pluginMounted }),
  }
}

/**
 * Actionable repair steps derived from the facts discovery collected.
 *
 * Deliberately silent about a plugin the .uproject does not mention: that is not evidence of a
 * missing plugin (see ProjectReport.notDeclared). The one plugin claim worth making is the
 * live one â€?an endpoint that answers but serves no EditorToolset toolset.
 */
function suggestionsFor(report: DiscoveryReport, connected: boolean, live?: LiveCapabilities): string[] {
  const suggestions: string[] = []
  if (!connected) {
    suggestions.push('Start the UE 5.8 editor with the project that has the MCP plugins enabled.')
  }
  for (const project of report.projects) {
    const label = project.uprojectPath ?? project.projectDir ?? 'project'
    if (project.explicitlyDisabled.length > 0) {
      suggestions.push(
        `${label}: ${project.explicitlyDisabled.join(', ')} is written with "Enabled": false in the .uproject. Set it to true and restart the editor.`,
      )
    }
    if (project.config.autoStart !== true) {
      suggestions.push(
        `${label}: the MCP server does not start by itself. Launch the editor with -ModelContextProtocolStartServer, or set bAutoStartServer=True under [/Script/ModelContextProtocolEngine.ModelContextProtocolSettings] in Saved/Config/WindowsEditor/EditorPerProjectUserSettings.ini.`,
      )
    }
    if (project.log.pluginMounted === false) {
      suggestions.push(`${label}: the newest editor log does not show the ModelContextProtocol module mounting â€?check that the plugin is enabled and the editor finished starting.`)
    }
  }
  if (connected && live !== undefined && live.toolsetCount === 0) {
    suggestions.push(
      'The endpoint answers but reports no toolsets at all: the toolset registry is empty. Check that ToolsetRegistry and EditorToolset loaded in this editor session (Editor log, category LogToolsetRegistry).',
    )
  } else if (connected && live !== undefined && live.hasEditorToolset === false) {
    suggestions.push(
      `The endpoint answers but serves no EditorToolset toolset (${live.toolsetCount} toolset(s): ${live.toolsets.slice(0, 6).map((entry) => entry.name).join(', ')}). Enable EditorToolset for this project and restart the editor; without it tools/list only offers the tool-search meta-tools.`,
    )
  }
  if (report.candidates.length > 0 && !connected) {
    suggestions.push(`Probed ${report.candidates.length} endpoint candidate(s); see attempts for the per-endpoint failure class.`)
  }
  return suggestions
}

/**
 * The project that produced a connected endpoint, or undefined when nothing in the discovered
 * projects explains it. Only a project whose own log or ini named this port can own it: an endpoint
 * found through the engine default port may belong to any project, and attributing a different
 * project's `.uproject` to it would misreport plugin state.
 */
export function projectForEndpoint(report: DiscoveryReport, endpoint: UeEndpoint): ProjectReport | undefined {
  return report.projects.find((project) => project.log.port === endpoint.port || project.config.port === endpoint.port)
}

/** Shape of the `ue_status` payload; kept next to the schema so they cannot drift. */
function statusPayload(input: {
  connected: boolean
  editor?: ConnectedEditor
  report: DiscoveryReport
  attempts: ProbeAttempt[]
  live?: LiveCapabilities
  problem?: ReturnType<typeof problemOf>
}): Record<string, unknown> {
  const { connected, editor, report, attempts, live, problem } = input
  // Not connected: the inspected project is the context for the repair suggestion.
  // Connected: only the project that actually owns the endpoint may describe it.
  const primaryProject = editor === undefined ? report.projects[0] : projectForEndpoint(report, editor.endpoint)
  const toolNames = editor === undefined ? undefined : (editor as ConnectedEditor & { tools?: McpTool[] }).tools?.map((tool) => tool.name)
  const attributionNote = connected && editor !== undefined && primaryProject === undefined
    ? `No discovered project produced ${editor.endpoint.url} (source: ${editor.endpoint.source}), so no project-level configuration is attributed to this connection. Set projectPaths (or endpoint) to target one project.`
    : undefined
  return {
    connected,
    pluginVersion: PLUGIN_VERSION,
    ...(editor === undefined
      ? {}
      : {
          endpoint: editor.endpoint.url,
          port: editor.endpoint.port,
          path: editor.endpoint.path,
          source: editor.endpoint.source,
          protocolVersion: editor.session.protocolVersion,
          ...(editor.session.serverInfo.name === undefined ? {} : { serverName: editor.session.serverInfo.name }),
          ...(editor.session.serverInfo.version === undefined ? {} : { serverVersion: editor.session.serverInfo.version }),
          sessionId: editor.session.sessionId,
        }),
    ...(toolNames === undefined ? {} : { toolCount: toolNames.length, tools: toolNames }),
    ...(live === undefined
      ? {}
      : {
          live: {
            toolsetCount: live.toolsetCount,
            hasEditorToolset: live.hasEditorToolset,
            toolsetsSample: live.toolsets.slice(0, 12).map((entry) => entry.name),
          },
        }),
    ...(primaryProject === undefined
      ? {}
      : { project: projectPayload(primaryProject), mcpConfig: configPayload(primaryProject), editorLog: logPayload(primaryProject) }),
    attempts: attempts.map((attempt) => ({ ...attempt })),
    notes: attributionNote === undefined ? report.notes : [...report.notes, attributionNote],
    suggestions: suggestionsFor(report, connected, live),
    ...(problem === undefined ? {} : { problem }),
  }
}

/** Read `arguments` from a tool call, accepting an object only. */
function readArguments(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('`arguments` must be a JSON object of the tool\'s own parameters')
  }
  return value as Record<string, unknown>
}

/** Build every tool definition against one bridge instance. */
export function createToolDefinitions(bridge: UeBridge, options: { maxResultChars: number }): ToolDefinition[] {
  // Only `ue_call` and the raw fallbacks use this cap; schema reads are paginated instead.
  const bound = (text: string) => boundText(text, options.maxResultChars)
  const status = defineTool({
    name: 'ue_status',
    description:
      'Report whether a Unreal Engine 5.8 editor MCP endpoint is reachable, which endpoint it is, and what a broken setup is missing. Use it first in a UE session, and again after starting or restarting the editor.',
    parameters: objectSchema(
      {
        refresh: {
          type: 'boolean',
          description: 'Re-discover the endpoint instead of reusing the cached connection. Set it after restarting the editor; the port can change.',
        },
      },
    ),
    output: {
      schema: objectSchema(
        {
          connected: { type: 'boolean' },
          endpoint: { type: 'string' },
          port: { type: 'integer' },
          path: { type: 'string' },
          source: { type: 'string' },
          protocolVersion: { type: 'string' },
          serverName: { type: 'string' },
          serverVersion: { type: 'string' },
          sessionId: { type: 'string' },
          toolCount: { type: 'integer' },
          tools: { type: 'array', items: { type: 'string' } },
          project: { type: 'object', additionalProperties: true },
          live: { type: 'object', additionalProperties: true },
          mcpConfig: { type: 'object', additionalProperties: true },
          editorLog: { type: 'object', additionalProperties: true },
          attempts: { type: 'array', items: { type: 'object', additionalProperties: true } },
          suggestions: { type: 'array', items: { type: 'string' } },
          notes: { type: 'array', items: { type: 'string' } },
          pluginVersion: { type: 'string' },
          problem: { type: 'object', additionalProperties: true },
        },
        ['connected', 'suggestions', 'attempts'],
      ),
      render: (_args, value) => {
        const payload = value as { connected?: boolean; endpoint?: string; toolCount?: number; suggestions?: string[] }
        const head = payload.connected === true
          ? `UE editor connected at ${payload.endpoint} (${payload.toolCount ?? 0} tools advertised)`
          : 'UE editor not reachable'
        return textOfValue(head, value)
      },
      presentationMeta: (_args, value) => ({ connected: (value as { connected?: boolean }).connected === true }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const signal = exec.signal ?? new AbortController().signal
      const refresh = args.refresh === true
      if (refresh) bridge.invalidate()
      try {
        const { editor, value: tools } = await bridge.call(signal, exec.agent, (live) => live.client.listTools())
        bridge.afterToolsListed(tools)
        const enriched = { ...editor, tools } as ConnectedEditor & { tools: McpTool[] }
        // Ask the editor what it actually serves. This is the fact that replaces guessing plugin
        // state from the .uproject: an endpoint can answer perfectly while exposing no editor
        // tools at all. A failure here must not fail ue_status, so it is advisory only.
        let live: LiveCapabilities | undefined
        try {
          const listed = await bridge.call(signal, exec.agent, (session) => session.client.callTool('list_toolsets', {}))
          if (!listed.value.isError) live = summarizeToolsets(listed.value.text)
        } catch {
          live = undefined
        }
        return statusPayload({
          connected: true,
          editor: enriched,
          report: editor.report,
          attempts: editor.attempts,
          ...(live === undefined ? {} : { live }),
        })
      } catch (error) {
        const report = await bridge.discover(signal, exec.agent).catch(() => ({ candidates: [], projects: [], notes: [] }))
        return statusPayload({
          connected: false,
          report,
          attempts: ((error as { attempts?: ProbeAttempt[] }).attempts) ?? [],
          problem: problemOf(error),
        })
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Unreal Engine status', kind: 'other' }),
  })

  const listTools = defineTool({
    name: 'ue_list_tools',
    description:
      'List the tools the running UE 5.8 editor currently advertises. With tool search enabled (the engine default) this is the three meta-tools, and `ue_list_toolsets` is the useful next step; with tool search disabled it lists every toolset tool.',
    parameters: objectSchema({}),
    output: {
      schema: objectSchema(
        {
          ok: { type: 'boolean' },
          toolCount: { type: 'integer' },
          toolSearchMode: { type: 'boolean' },
          tools: { type: 'array', items: { type: 'object', additionalProperties: true } },
          mirrored: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
          problem: { type: 'object', additionalProperties: true },
        },
        ['ok'],
      ),
      render: (_args, value) => {
        const payload = value as { ok?: boolean; toolCount?: number }
        return textOfValue(payload.ok === true ? `editor advertises ${payload.toolCount ?? 0} tool(s)` : 'editor not reachable', value)
      },
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const signal = exec.signal ?? new AbortController().signal
      try {
        const { value: tools } = await bridge.call(signal, exec.agent, (live) => live.client.listTools())
        bridge.afterToolsListed(tools)
        const nativeTools = tools.filter((tool) => !META_TOOL_NAMES.has(tool.name))
        return {
          ok: true,
          toolCount: tools.length,
          toolSearchMode: nativeTools.length === 0,
          tools: tools.map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            hasInputSchema: tool.inputSchema !== undefined,
            ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
          })),
          mirrored: nativeTools.map((tool) => tool.name),
          note: nativeTools.length === 0
            ? 'Only the tool-search meta-tools are advertised. Use ue_list_toolsets / ue_describe_toolset / ue_call, or set bEnableToolSearch=False in the engine project settings to advertise every toolset tool.'
            : `${nativeTools.length} native tool(s) advertised; they are also available through ue_call.`,
        }
      } catch (error) {
        return { ok: false, problem: problemOf(error) }
      }
    },
  })

  const listToolsets = defineTool({
    name: 'ue_list_toolsets',
    description:
      'List the editor toolsets UE 5.8 offers (EditorToolset, LogsToolset, and any other enabled toolset plugin). Start here to find the toolset and tool names that `ue_call` needs.',
    parameters: objectSchema({}),
    output: {
      schema: objectSchema(
        {
          ok: { type: 'boolean' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
          toolsetCount: { type: 'integer' },
          toolsets: { type: 'array', items: { type: 'object', additionalProperties: true } },
          problem: { type: 'object', additionalProperties: true },
        },
        ['ok'],
      ),
      render: (_args, value) => {
        const payload = value as { ok?: boolean; toolsetCount?: number; toolsets?: Array<{ name?: string; description?: string }>; problem?: unknown }
        if (payload.ok !== true) return textOfValue('toolset listing failed', value)
        const lines = (payload.toolsets ?? []).map((entry) => `- ${entry.name ?? ''}${entry.description === undefined ? '' : `: ${entry.description}`}`)
        return [{ type: 'text', text: `UE toolsets (${payload.toolsetCount ?? 0}):\n${lines.join('\n')}` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const signal = exec.signal ?? new AbortController().signal
      try {
        const { value: result } = await bridge.call(signal, exec.agent, (live) => live.client.callTool('list_toolsets', {}))
        if (result.isError) return { ok: false, text: result.text, problem: { code: 'ue_tool_error', message: result.text } }
        // Structured on purpose: the model gets every toolset name even when the raw text is
        // longer than the bridge's cap, and the text stays available for the engine's own wording.
        const toolsets = parseToolsetCatalog(result.text)
        const bounded = bound(result.text)
        return {
          ok: true,
          toolsetCount: toolsets.length,
          toolsets,
          text: bounded.text,
          truncated: bounded.truncated,
        }
      } catch (error) {
        return { ok: false, problem: problemOf(error) }
      }
    },
  })

  const describeToolset = defineTool({
    name: 'ue_describe_toolset',
    description:
      'List the tools of one UE toolset. By default it returns every tool name and description in one bounded page; add `tool_name` to get that tool\'s complete input and output schema. Large toolsets stay fully reachable through `offset`/`limit` and `tool_name` instead of being cut off.',
    parameters: objectSchema(
      {
        toolset_name: {
          type: 'string',
          description: 'Exact toolset name, for example EditorToolset.LogsToolset, as reported by ue_list_toolsets.',
        },
        tool_name: {
          type: 'string',
          description: 'Return only this tool\'s complete input and output schema. Accepts the bare name (GetLogEntries) or the qualified name (EditorToolset.LogsToolset.GetLogEntries).',
        },
        offset: {
          type: 'integer',
          description: 'Zero-based index of the first tool to list. Defaults to 0; use `nextOffset` from the previous page.',
        },
        limit: {
          type: 'integer',
          description: 'Page size, 1-100. Defaults to 20.',
        },
      },
      ['toolset_name'],
    ),
    output: {
      schema: objectSchema(
        {
          ok: { type: 'boolean' },
          toolset: { type: 'string' },
          version: { type: 'string' },
          description: { type: 'string' },
          toolCount: { type: 'integer' },
          tools: { type: 'array', items: { type: 'object', additionalProperties: true } },
          tool: { type: 'object', additionalProperties: true },
          offset: { type: 'integer' },
          limit: { type: 'integer' },
          nextOffset: { type: 'integer' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
          note: { type: 'string' },
          problem: { type: 'object', additionalProperties: true },
        },
        ['ok'],
      ),
      render: (_args, value) => {
        const payload = value as {
          ok?: boolean
          toolset?: string
          toolCount?: number
          tool?: { name?: string }
          tools?: Array<{ name?: string; description?: string }>
          offset?: number
          nextOffset?: number
          note?: string
          problem?: { message?: string }
        }
        if (payload.ok !== true) {
          return [{ type: 'text', text: `describe_toolset failed: ${payload.problem?.message ?? 'unknown error'}` }]
        }
        if (payload.tool !== undefined) {
          return textOfValue(`schema of ${payload.tool.name}`, payload.tool)
        }
        const head = `${payload.toolset} â€?${payload.toolCount ?? 0} tool(s)${payload.nextOffset === undefined ? '' : `, showing ${payload.offset ?? 0}-${payload.nextOffset - 1}`}`
        const lines = (payload.tools ?? []).map((entry) => `- ${entry.name}${entry.description === undefined ? '' : `: ${entry.description}`}`)
        return [{ type: 'text', text: `${head}\n${lines.join('\n')}${payload.note === undefined ? '' : `\n${payload.note}`}` }]
      },
    },
    async execute(args, exec) {
      const signal = exec.signal ?? new AbortController().signal
      const toolsetName = typeof args.toolset_name === 'string' ? args.toolset_name.trim() : ''
      if (toolsetName.length === 0) throw new Error('toolset_name must be a non-empty string')
      const wantedTool = typeof args.tool_name === 'string' && args.tool_name.trim().length > 0 ? args.tool_name.trim() : undefined
      try {
        const { value: result } = await bridge.call(signal, exec.agent, (live) => live.client.callTool('describe_toolset', { toolset_name: toolsetName }))
        if (result.isError) {
          return { ok: false, toolset: toolsetName, text: result.text, problem: { code: 'ue_tool_error', message: result.text } }
        }

        const parsed = parseToolsetSchema(result.text)
        if (parsed === undefined) {
          // The engine answered with something that is not a toolset schema; hand it back bounded
          // and say so, rather than pretending the toolset has no tools.
          const bounded = bound(result.text)
          return {
            ok: true,
            toolset: toolsetName,
            text: bounded.text,
            truncated: bounded.truncated,
            note: 'The editor did not return parsable toolset JSON; the raw text is shown instead.',
          }
        }

        const header = {
          toolset: parsed.name ?? toolsetName,
          ...(parsed.version === undefined ? {} : { version: parsed.version }),
          ...(parsed.description === undefined ? {} : { description: parsed.description }),
          toolCount: parsed.tools.length,
        }

        if (wantedTool !== undefined) {
          const bare = bareToolName(wantedTool).toLowerCase()
          const match = parsed.tools.find((tool) => tool.name === wantedTool)
            ?? parsed.tools.find((tool) => bareToolName(tool.name).toLowerCase() === bare)
          if (match === undefined) {
            return {
              ok: false,
              ...header,
              problem: {
                code: 'tool_not_in_toolset',
                message: `No tool named ${wantedTool} in ${parsed.name ?? toolsetName}`,
                hint: `Available: ${parsed.tools.map((tool) => bareToolName(tool.name)).join(', ')}`,
              },
            }
          }
          // A single tool's schema is returned in full: that is the point of asking by name.
          return {
            ok: true,
            ...header,
            tool: {
              name: match.name,
              ...(match.description === undefined ? {} : { description: match.description }),
              ...(match.inputSchema === undefined ? {} : { inputSchema: match.inputSchema }),
              ...(match.outputSchema === undefined ? {} : { outputSchema: match.outputSchema }),
            },
          }
        }

        const total = parsed.tools.length
        const offset = Math.min(Math.max(Number.isInteger(args.offset) ? Number(args.offset) : 0, 0), Math.max(total - 1, 0))
        const limit = Math.min(Math.max(Number.isInteger(args.limit) ? Number(args.limit) : 20, 1), 100)
        const page = parsed.tools.slice(offset, offset + limit)
        const nextOffset = offset + page.length < total ? offset + page.length : undefined
        return {
          ok: true,
          ...header,
          offset,
          limit,
          ...(nextOffset === undefined ? {} : { nextOffset }),
          tools: page.map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            hasInputSchema: tool.inputSchema !== undefined,
            hasOutputSchema: tool.outputSchema !== undefined,
          })),
          note: 'Names only. Call again with tool_name to read one tool\'s complete input and output schema.'
            + (nextOffset === undefined ? '' : ` Next page: offset=${nextOffset}.`),
        }
      } catch (error) {
        return { ok: false, toolset: toolsetName, problem: problemOf(error) }
      }
    },
  })

  const call = defineTool({
    name: 'ue_call',
    description:
      'Call one tool exposed by the UE 5.8 editor. Give `tool_name` alone to call an advertised tool, or add `toolset_name` to dispatch a toolset tool through the engine\'s call_tool. The editor\'s own failure text (including Python tracebacks) is returned unchanged.',
    parameters: objectSchema(
      {
        tool_name: {
          type: 'string',
          description: 'Tool name to invoke. For a toolset tool this is the bare name (for example get_log_entries); for a top-level tool it is the advertised name (for example list_toolsets).',
        },
        toolset_name: {
          type: 'string',
          description: 'Optional toolset that owns the tool, for example LogsToolset. Omit it for a tool advertised by ue_list_tools.',
        },
        arguments: {
          type: 'object',
          additionalProperties: true,
          description: 'The tool\'s own parameters. Omit or use {} when the tool takes none; call ue_describe_toolset to read the exact schema first.',
        },
      },
      ['tool_name'],
    ),
    output: {
      schema: objectSchema(
        {
          ok: { type: 'boolean' },
          tool: { type: 'string' },
          toolset: { type: 'string' },
          isError: { type: 'boolean' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
          totalChars: { type: 'integer' },
          structured: {},
          problem: { type: 'object', additionalProperties: true },
        },
        ['ok', 'tool'],
      ),
      render: (_args, value) => {
        const payload = value as { ok?: boolean; tool?: string; isError?: boolean; text?: string; truncated?: boolean }
        const head = payload.ok === true
          ? `${payload.tool}${payload.isError === true ? ' returned an editor error' : ' succeeded'}${payload.truncated === true ? ' (output truncated)' : ''}`
          : `${payload.tool} did not run`
        return [{ type: 'text', text: `${head}\n${payload.text ?? ''}` }]
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `UE call ${typeof args.tool_name === 'string' ? args.tool_name : ''}`.trim(),
      kind: 'execute',
      rawInput: args,
    }),
    async execute(args, exec) {
      const signal = exec.signal ?? new AbortController().signal
      const toolName = typeof args.tool_name === 'string' ? args.tool_name.trim() : ''
      if (toolName.length === 0) throw new Error('tool_name must be a non-empty string')
      const toolsetName = typeof args.toolset_name === 'string' && args.toolset_name.trim().length > 0
        ? args.toolset_name.trim()
        : undefined
      const toolArguments = readArguments(args.arguments) as Record<string, never> | undefined
      try {
        const { value: result } = await bridge.call(signal, exec.agent, async (live) => {
          if (toolsetName === undefined) return live.client.callTool(toolName, toolArguments)
          return live.client.callTool('call_tool', {
            toolset_name: toolsetName,
            tool_name: toolName,
            ...(toolArguments === undefined ? {} : { arguments: toolArguments }),
          })
        })
        const bounded = bound(result.text)
        return {
          ok: true,
          tool: toolName,
          ...(toolsetName === undefined ? {} : { toolset: toolsetName }),
          isError: result.isError,
          text: bounded.text,
          truncated: bounded.truncated,
          totalChars: bounded.totalChars,
          ...(result.structured === undefined ? {} : { structured: result.structured }),
        }
      } catch (error) {
        return {
          ok: false,
          tool: toolName,
          ...(toolsetName === undefined ? {} : { toolset: toolsetName }),
          problem: problemOf(error),
        }
      }
    },
  })

  return [status, listTools, listToolsets, describeToolset, call]
}

/** Describe an endpoint for a diagnostic line. */
export function describeEndpoint(endpoint: UeEndpoint): string {
  return `${endpoint.url} (${endpoint.source})`
}
