/**
 * mcp-client.ts — JSON-RPC 2.0 over the UE 5.8 in-editor MCP HTTP endpoint.
 *
 * Everything in this file is derived from the engine source shipped with UE 5.8.4, not from
 * memory. Evidence:
 *   Engine/Plugins/Experimental/ModelContextProtocol/Source/ModelContextProtocol/Private/ModelContextProtocolServer.cpp
 *   Engine/Plugins/Experimental/ModelContextProtocol/Source/ModelContextProtocol/Public/ModelContextProtocol.h
 *
 * Facts the transport relies on:
 *   - The server binds POST/GET/DELETE on `ServerUrlPath` (default `/mcp`) of an FHttpServerModule
 *     router whose port comes from `[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]`
 *     `ServerPortNumber` (default 8000) or the `-ModelContextProtocolPort=` command line. It is
 *     NOT a fixed contract, which is why ue-endpoint.ts discovers it per project.
 *   - `initialize` is exempt from session validation and returns `Mcp-Session-Id`. Every later
 *     request MUST carry that header; an unknown id answers HTTP 404 with the message
 *     "Unknown session id '…'; client should reinitialize" (ProcessJsonRpcCall).
 *   - `Mcp-Protocol-Version`, when sent, must equal the negotiated version, or the request is
 *     rejected with HTTP 400 (ProcessJsonRpcCall).
 *   - A `tools/call` WITHOUT `params._meta.progressToken` replies `application/json` with a
 *     Content-Length; only a progress-token call switches to `text/event-stream`
 *     (ProcessToolCallJsonRpcCall, bUseStreaming). We never send a progress token, but the SSE
 *     parser below still handles the streaming shape because a proxy or a future engine build may
 *     stream anyway.
 *   - `tools/list` is paginated: the result may carry `nextCursor` (ApplyPagination).
 *
 * UE error text is never rewritten: JSON-RPC `error.message` and tool-result `content[].text`
 * (e.g. a Python traceback from a toolset) are carried through verbatim.
 */

/** A JSON value, as accepted by the MCP endpoint. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Stable error codes surfaced to the agent. */
export type UeErrorCode =
  | 'editor_not_running'
  | 'endpoint_unreachable'
  | 'ue_timeout'
  | 'ue_http_error'
  | 'ue_rpc_error'
  | 'ue_protocol_error'
  | 'endpoint_stale'
  | 'session_expired'
  | 'aborted'
  | 'bad_config'

/**
 * A bridge failure. `code` is the machine-readable class, `detail` keeps the untouched UE text,
 * and `hint` is the actionable next step shown to the agent.
 */
export class UeBridgeError extends Error {
  readonly code: UeErrorCode
  readonly detail?: string
  readonly hint?: string
  /** Additional explanation lines collected during discovery. */
  readonly notes?: string[]
  /** Per-candidate probe outcomes, kept so the caller can show why each endpoint failed. */
  readonly attempts?: unknown[]
  /** Raw JSON-RPC error object when the failure came from the endpoint. */
  readonly rpc?: JsonValue

  constructor(
    code: UeErrorCode,
    message: string,
    extra: { detail?: string; hint?: string; rpc?: JsonValue; notes?: string[]; attempts?: unknown[] } = {},
  ) {
    super(message)
    this.name = 'UeBridgeError'
    this.code = code
    this.detail = extra.detail
    this.hint = extra.hint
    this.notes = extra.notes
    this.attempts = extra.attempts
    this.rpc = extra.rpc
  }
}

/** One tool as advertised by `tools/list`. */
export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

/** The negotiated server identity returned by `initialize`. */
export interface McpServerInfo {
  name?: string
  title?: string
  version?: string
}

/** A connected endpoint plus the session it handed out. */
export interface McpSession {
  protocolVersion: string
  serverInfo: McpServerInfo
  sessionId: string
  instructions?: string
}

/** Outcome of one `tools/call`, preserving the engine's own payload. */
export interface McpToolResult {
  /** True when the engine reported a tool-level failure (`isError`). */
  isError: boolean
  /** Concatenated `content[].text`, byte-for-byte as sent by the editor. */
  text: string
  /** Any non-text content blocks, untouched. */
  otherContent: JsonValue[]
  /** `structuredContent`, when the tool declared an output schema. */
  structured?: JsonValue
  /** The full `result` object, for callers that need everything. */
  raw: JsonValue
}

/** Options shared by every request. */
export interface McpClientOptions {
  /** Per-request timeout in milliseconds (the task asks for 10–15s). */
  timeoutMs: number
  /** Cancellation from the plugin lifecycle and/or the calling tool. */
  signal?: AbortSignal
  /** Client identity reported in `initialize`. */
  clientName: string
  clientVersion: string
}

const PROTOCOL_VERSION = '2025-11-25'

/** Read the error `code` out of a fetch failure's cause chain (ECONNREFUSED, ETIMEDOUT, …). */
function networkCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown }
    if (typeof candidate.code === 'string') return candidate.code
    current = candidate.cause
  }
  return undefined
}

/** Join text content blocks exactly as the engine sent them. */
function textOf(content: JsonValue[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && !Array.isArray(block)) {
      const record = block as Record<string, JsonValue>
      if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    }
  }
  return parts.join('\n')
}

/** Split an `text/event-stream` body into the JSON payloads of its `data:` lines. */
export function parseSsePayloads(body: string): JsonValue[] {
  const payloads: JsonValue[] = []
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data: string[] = []
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5))
    }
    if (data.length === 0) continue
    const joined = data.join('\n').trim()
    if (joined.length === 0) continue
    try {
      payloads.push(JSON.parse(joined) as JsonValue)
    } catch {
      // A non-JSON SSE frame (keep-alive comment) is not a protocol failure.
    }
  }
  return payloads
}

/**
 * One MCP session against one UE editor endpoint.
 *
 * The client owns the `Mcp-Session-Id`; `connect()` performs `initialize` plus the
 * `notifications/initialized` handshake, and `request()` re-initializes once when the editor
 * reports the session as expired (404), which is the recovery path the engine documents.
 */
export class UeMcpClient {
  private readonly endpoint: string
  private readonly options: McpClientOptions
  private nextId = 1
  private session?: McpSession

  constructor(endpoint: string, options: McpClientOptions) {
    this.endpoint = endpoint
    this.options = options
  }

  /** The endpoint this client talks to. */
  get url(): string {
    return this.endpoint
  }

  /** The live session, once `connect()` has succeeded. */
  get currentSession(): McpSession | undefined {
    return this.session
  }

  /** Run `initialize` + `notifications/initialized` and remember the session id. */
  async connect(): Promise<McpSession> {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.options.clientName, version: this.options.clientVersion },
    })
    if (result.sessionId === undefined || result.sessionId.length === 0) {
      throw new UeBridgeError(
        'ue_protocol_error',
        'UE MCP endpoint answered initialize without an Mcp-Session-Id header',
        { detail: JSON.stringify(result.value).slice(0, 2000) },
      )
    }
    const value = result.value as Record<string, JsonValue> | null
    const serverInfo = (value !== null && typeof value === 'object' && value.serverInfo !== undefined
      ? (value.serverInfo as McpServerInfo)
      : {}) as McpServerInfo
    this.session = {
      protocolVersion: typeof value?.protocolVersion === 'string' ? value.protocolVersion : PROTOCOL_VERSION,
      serverInfo,
      sessionId: result.sessionId,
      instructions: typeof value?.instructions === 'string' ? value.instructions : undefined,
    }
    // The spec's initialized notification completes the handshake; the engine flips the session
    // to `Initialized` here (ProcessInitializedNotificationJsonRpcCall) and answers HTTP 202.
    await this.notify('notifications/initialized')
    return this.session
  }

  /** `tools/list`, following `nextCursor` until the engine stops paginating. */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page += 1) {
      const result = await this.request('tools/list', cursor === undefined ? {} : { cursor })
      const value = result.value as { tools?: McpTool[]; nextCursor?: string } | null
      for (const tool of value?.tools ?? []) {
        if (typeof tool?.name === 'string') tools.push(tool)
      }
      if (typeof value?.nextCursor !== 'string' || value.nextCursor.length === 0) return tools
      cursor = value.nextCursor
    }
    return tools
  }

  /** `tools/call`. Tool-level failures are returned (not thrown) so callers keep the UE text. */
  async callTool(name: string, args: Record<string, JsonValue> | undefined): Promise<McpToolResult> {
    const result = await this.request('tools/call', {
      name,
      ...(args === undefined ? {} : { arguments: args }),
    })
    const value = result.value
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { isError: false, text: typeof value === 'string' ? value : JSON.stringify(value), otherContent: [], raw: value }
    }
    const record = value as Record<string, JsonValue>
    const content = Array.isArray(record.content) ? (record.content as JsonValue[]) : []
    const otherContent = content.filter((block) => {
      const type = block !== null && typeof block === 'object' && !Array.isArray(block)
        ? (block as Record<string, JsonValue>).type
        : undefined
      return type !== 'text'
    })
    return {
      isError: record.isError === true,
      text: textOf(content),
      otherContent,
      structured: record.structuredContent,
      raw: value,
    }
  }

  /** Send a JSON-RPC notification (no id, no response body expected). */
  private async notify(method: string, params?: JsonValue): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }, undefined)
  }

  /**
   * Send a JSON-RPC request and return `result`, plus the session id the response carried.
   * Re-initializes once when the session is reported stale.
   */
  private async request(
    method: string,
    params: JsonValue | undefined,
    retried = false,
  ): Promise<{ value: JsonValue; sessionId?: string }> {
    const id = this.nextId
    this.nextId += 1
    const body: Record<string, JsonValue> = { jsonrpc: '2.0', id, method }
    if (params !== undefined) body.params = params
    try {
      const response = await this.post(body, id)
      const sessionId = response.sessionId ?? this.session?.sessionId
      return { value: response.result, sessionId }
    } catch (error) {
      const stale = error instanceof UeBridgeError
        && (error.code === 'session_expired'
          || (error.code === 'ue_http_error' && error.message.includes('Unknown session id')))
      if (stale && !retried && method !== 'initialize') {
        this.session = undefined
        await this.connect()
        return this.request(method, params, true)
      }
      throw error
    }
  }

  /** Perform the HTTP round trip, classify transport failures, and unwrap JSON-RPC. */
  private async post(
    body: Record<string, JsonValue>,
    id: number | undefined,
  ): Promise<{ result: JsonValue; sessionId?: string }> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const signals: AbortSignal[] = [timeout]
    if (this.options.signal !== undefined) signals.push(this.options.signal)
    const signal = signals.length === 1 ? timeout : AbortSignal.any(signals)

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }
    if (this.session !== undefined) {
      headers['mcp-session-id'] = this.session.sessionId
      headers['mcp-protocol-version'] = this.session.protocolVersion
    }

    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (timeout.aborted) {
        throw new UeBridgeError(
          'ue_timeout',
          `UE MCP endpoint ${this.endpoint} did not answer ${body.method} within ${this.options.timeoutMs}ms`,
          { hint: 'The editor may be busy (asset load, shader compile) or blocked on a modal dialog. Retry, then raise requestTimeoutMs in this plugin\'s config.' },
        )
      }
      if (this.options.signal?.aborted === true) {
        throw new UeBridgeError('aborted', 'UE MCP request aborted because the plugin was unloaded or the call was cancelled')
      }
      const code = networkCode(error)
      const refused = code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH'
      throw new UeBridgeError(
        refused ? 'editor_not_running' : 'endpoint_unreachable',
        `${this.endpoint} is not accepting MCP requests (${code ?? 'network error'})`,
        {
          detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          hint: refused
            ? 'No editor is listening on that port. Start the UE 5.8 project, or point this plugin at the right port via its config.'
            : 'The endpoint is reachable but the request failed before a response; check the editor log.',
        },
      )
    }

    const bodyText = await response.text()

    if (response.status === 404 && bodyText.includes('Unknown session id')) {
      throw new UeBridgeError('session_expired', 'UE MCP session expired', { rpc: safeJson(bodyText) })
    }
    // The engine's HTTP server answers this when the port is still listening but the MCP routes
    // were unbound — i.e. `ModelContextProtocol.StartServer` ran again and rebound elsewhere.
    // Treat it as "this endpoint moved", so the caller re-discovers instead of failing the call.
    if (response.status === 404 && bodyText.includes('route_handler_not_found')) {
      throw new UeBridgeError(
        'endpoint_stale',
        `${this.endpoint} is listening but has no MCP route bound any more`,
        {
          detail: bodyText.slice(0, 500),
          hint: 'The editor restarted its MCP server, possibly on another port. Re-discovery will find the new one.',
        },
      )
    }
    if (response.status === 202 || (bodyText.length === 0 && response.ok)) {
      if (id === undefined) return { result: null, sessionId: response.headers.get('mcp-session-id') ?? undefined }
      throw new UeBridgeError('ue_protocol_error', `UE MCP endpoint accepted ${body.method} (HTTP ${response.status}) but returned no JSON-RPC response`)
    }

    const payloads = parseSsePayloads(bodyText)
    const frames = payloads.length > 0 ? payloads : [safeJson(bodyText)]
    const matched = id === undefined
      ? frames.find((frame) => isJsonRpcResponse(frame))
      : frames.find((frame) => isJsonRpcResponse(frame) && (frame as { id?: JsonValue }).id === id)

    if (matched === undefined || !isJsonRpcResponse(matched)) {
      const rpcError = frames.map((frame) => asRpcError(frame)).find((error) => error !== undefined)
      if (rpcError !== undefined) {
        throw new UeBridgeError('ue_rpc_error', rpcError.message, {
          detail: JSON.stringify(rpcError.raw),
          rpc: rpcError.raw,
          hint: 'This text comes from the UE editor unchanged.',
        })
      }
      throw new UeBridgeError(
        'ue_http_error',
        `UE MCP endpoint answered HTTP ${response.status} for ${body.method} without a JSON-RPC response`,
        {
          detail: bodyText.slice(0, 2000),
          hint: response.status === 403
            ? 'The engine rejected the request Origin. Send the request from a non-browser client (this plugin does).'
            : 'Inspect the detail: the engine returns its own message for protocol violations.',
        },
      )
    }

    const frame = matched as { id: JsonValue; result?: JsonValue; error?: { code?: number; message?: string; data?: JsonValue } }
    if (frame.error !== undefined) {
      const message = typeof frame.error.message === 'string' ? frame.error.message : JSON.stringify(frame.error)
      throw new UeBridgeError('ue_rpc_error', message, {
        detail: JSON.stringify(frame.error),
        rpc: frame.error as JsonValue,
        hint: 'This text comes from the UE editor unchanged.',
      })
    }
    return {
      result: frame.result === undefined ? null : frame.result,
      sessionId: response.headers.get('mcp-session-id') ?? undefined,
    }
  }
}

/** Whether a parsed frame is a JSON-RPC 2.0 response (has `id` and `result`/`error`). */
function isJsonRpcResponse(frame: JsonValue): boolean {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return false
  const record = frame as Record<string, JsonValue>
  return record.jsonrpc === '2.0' && 'id' in record && ('result' in record || 'error' in record)
}

/** Extract a JSON-RPC error frame, if this frame is one. */
function asRpcError(frame: JsonValue): { message: string; raw: JsonValue } | undefined {
  if (!isJsonRpcResponse(frame)) return undefined
  const record = frame as Record<string, JsonValue>
  if (record.error === undefined || record.error === null || typeof record.error !== 'object') return undefined
  const error = record.error as Record<string, JsonValue>
  return {
    message: typeof error.message === 'string' ? error.message : JSON.stringify(record.error),
    raw: record.error,
  }
}

/** Parse JSON without throwing; keep the raw text when it is not JSON. */
function safeJson(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue
  } catch {
    return text
  }
}
