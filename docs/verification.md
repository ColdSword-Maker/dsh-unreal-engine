# Verification — real UE 5.8 round trip through DSH

This document records one real end-to-end pass: a **DeepSeek Harness agent** calling **`ue_*`
tools**, which issue **JSON-RPC over HTTP** to the **UE 5.8.4 editor process**, and the editor's own
toolset code producing the answer. Nothing below is simulated; the outputs are the tool results as
the agent received them.

- Date: 2026-10-25 (Asia/Shanghai)
- DSH: Desktop build, profile `desktop` (`C:\Users\Dojho\.dsh\profiles\desktop`)
- Plugin: `@local/dsh-unreal-engine` 0.1.x, installed with `plugin_manager install_bundle`
  (`application: applied`, tools live in the same session). The plugin directory and package were
  named `dsh-plugin-ue5` / `@local/dsh-plugin-ue5` while the runs in §1-§10 were recorded; they were
  renamed afterwards to `dsh-unreal-engine` / `@local/dsh-unreal-engine`. The row id (`ue5`), tool
  names (`ue_*`), and behaviour are unchanged by the rename.
- Engine: Unreal Engine **5.8.4** (`++UE5+Release-5.8`, CL 58902052) at `D:\Unreal Engine\UE_5.8`
- Editor process: `UnrealEditor.exe "D:\Vibe Coding\ue-fixture\UE5BridgeFixture.uproject"`
- Probe tool: DSH's own `ue_status` / `ue_list_tools` / `ue_list_toolsets` / `ue_describe_toolset` /
  `ue_call`

## 0. UE-side setup used

`ue-fixture\UE5BridgeFixture.uproject` — a Blueprint-only fixture project (no C++ module, no engine
change):

```json
"Plugins": [
  { "Name": "ModelContextProtocol", "Enabled": true },
  { "Name": "ToolsetRegistry",      "Enabled": true },
  { "Name": "MCPClientToolset",     "Enabled": true },
  { "Name": "PythonScriptPlugin",   "Enabled": true },
  { "Name": "EditorToolset",        "Enabled": true }
]
```

`ue-fixture\Saved\Config\WindowsEditor\EditorPerProjectUserSettings.ini`:

```ini
[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]
ServerUrlPath=/mcp
ServerPortNumber=8765
bAutoStartServer=True
```

The editor was started with no MCP command-line flags at all, so the server had to come up from that
ini — which is what makes the port non-default (8765, not the engine default 8000).

## 1. `ue_status` — discovery + handshake

```json
{
  "connected": true,
  "pluginVersion": "0.1.3",
  "endpoint": "http://127.0.0.1:8765/mcp",
  "port": 8765,
  "path": "/mcp",
  "source": "editor-log",
  "protocolVersion": "2025-11-25",
  "sessionId": "29def5fe48c358d3c58c6193b9150646",
  "toolCount": 3,
  "tools": ["list_toolsets", "describe_toolset", "call_tool"],
  "project": {
    "uprojectPath": "D:\\Vibe Coding\\ue-fixture\\UE5BridgeFixture.uproject",
    "projectDir": "D:\\Vibe Coding\\ue-fixture",
    "missingRequired": [],
    "missingRecommended": []
  },
  "mcpConfig": {
    "file": "D:\\Vibe Coding\\ue-fixture\\Saved\\Config\\WindowsEditor\\EditorPerProjectUserSettings.ini",
    "autoStart": true, "port": 8765, "urlPath": "/mcp"
  },
  "editorLog": {
    "file": "D:\\Vibe Coding\\ue-fixture\\Saved\\Logs\\UE5BridgeFixture.log",
    "port": 8765,
    "mcpPortLine": "Starting MCP server on port 8765",
    "pluginMounted": true
  },
  "attempts": [{ "url": "http://127.0.0.1:8765/mcp", "source": "editor-log", "ok": true }],
  "notes": [],
  "suggestions": []
}
```

`source: "editor-log"` is the important field: the endpoint was recovered from the editor's own log
line (`Starting MCP server on port 8765`), not from a hardcoded port, and the first probe returned
`ok: true`.

> Field note: this transcript is from plugin 0.1.3. `project.missingRequired` /
> `project.missingRecommended` were replaced in 0.1.4/0.1.5 by `declared` / `explicitlyDisabled` /
> `notDeclared`, and `live` was added — see §10, which is the current shape.

## 2. `ue_list_tools` — what the endpoint advertises

```
editor advertises 3 tool(s)
toolSearchMode: true
tools: list_toolsets, describe_toolset, call_tool
note: Only the tool-search meta-tools are advertised. Use ue_list_toolsets / ue_describe_toolset /
      ue_call, or set bEnableToolSearch=False in the engine project settings to advertise every
      toolset tool.
```

This matches the engine source: `bEnableToolSearch` defaults to `true`, and
`FToolsetRegistryToolAdapterManager::RegisterTools` then registers exactly three meta-tools.

## 3. `ue_list_toolsets` — 19 toolsets from EditorToolset

```
UE toolsets (19):
- ToolsetRegistry.AgentSkillToolset
- EditorToolset.EditorAppToolset: 用于查询和修改虚幻编辑器状态的工具：控制台变量、资产成像、Actor和资产选择、视口摄像机、内容浏览器导航和PIE会话控制。
- EditorToolset.LogsToolset: 提供用于读取虚幻引擎输出日志和控制日志类别详细程度的工具。
- editor_toolset.toolsets.actor.ActorTools
- editor_toolset.toolsets.asset.AssetTools
- editor_toolset.toolsets.blueprint.BlueprintTools
- editor_toolset.toolsets.scene.SceneTools
- editor_toolset.toolsets.programmatic.ProgrammaticToolset
… (19 total, all from EditorToolset except AgentSkillToolset)
```

## 4. `ue_describe_toolset` — the schema `ue_call` needs

`EditorToolset.LogsToolset` (abridged from the returned JSON):

```json
{
  "name": "EditorToolset.LogsToolset",
  "version": "1.0",
  "tools": [
    { "name": "EditorToolset.LogsToolset.GetLogEntries",
      "inputSchema": { "type": "object", "properties": {
        "category":   { "type": "string", "description": "…", "default": "LogsToolset" },
        "pattern":    { "type": "string" },
        "maxEntries": { "type": "integer", "default": 1000 } },
        "required": ["pattern"] } },
    { "name": "EditorToolset.LogsToolset.GetLogCategories", … },
    { "name": "EditorToolset.LogsToolset.GetVerbosity", … },
    { "name": "EditorToolset.LogsToolset.SetVerbosity", … }
  ]
}
```

Two engine quirks worth knowing (both handled, see §7):

- tool names are **fully qualified**; `call_tool` wants the bare trailing name;
- the generated `category` schema carries the bogus default `"LogsToolset"`, so omitting it makes
  the call fail with `Log category 'LogsToolset' not found.` — pass `category: ""` for all categories.

## 5. `ue_call` — a real, read-only editor operation

Request:

```json
{ "toolset_name": "EditorToolset.LogsToolset", "tool_name": "GetLogEntries",
  "arguments": { "category": "LogModelContextProtocol", "pattern": "MCP server", "maxEntries": 3 } }
```

Result (the editor's own text, unchanged):

```
GetLogEntries succeeded
{"returnValue":["[2026.10.25-02.52.30:676][  0]LogModelContextProtocol: Starting MCP server on port 8765 (override with -ModelContextProtocolPort=N)."]}
```

That single JSON line proves the whole chain: DSH tool → HTTP → in-editor MCP router →
`ToolsetRegistry` → `ULogsToolset::GetLogEntries` → back through the bridge with no rewriting.

## 6. Error passthrough — the editor's failure text is preserved

Request: `ue_call` with `toolset_name: EditorToolset.LogsToolset`, `tool_name: NoSuchTool`.

```
NoSuchTool returned an editor error
Unknown tool NoSuchTool
```

`Unknown tool NoSuchTool` is the engine's own message (`MakeErrorResult`), returned with
`isError: true` and not wrapped in bridge-specific wording. A Python traceback from a Python toolset
travels the same way.

## 7. Repeatable acceptance script

```
> pnpm verify:ue -- --project "D:\Vibe Coding\ue-fixture"

== discovery ==
  candidate http://127.0.0.1:8765/mcp  [editor-log] …UE5BridgeFixture.log: "Starting MCP server on port 8765"
  candidate http://127.0.0.1:8000/mcp  [engine-default] UE 5.8 DefaultServerPort
  project   D:\Vibe Coding\ue-fixture\UE5BridgeFixture.uproject
            required missing: none
            recommended missing: none
            mcp ini: …\EditorPerProjectUserSettings.ini  autoStart=true port=8765
            log: …\UE5BridgeFixture.log  mcpPort=8765

== connected ==
  http://127.0.0.1:8765/mcp [editor-log] protocol=2025-11-25 session=e175183a46378937b0f55b8716abea28
  PASS  initialize handshake returned a session id
  PASS  tools/list is non-empty — 3 tool(s)
  PASS  list_toolsets reports at least one toolset — 19 toolset(s)
  PASS  describe_toolset(EditorToolset.LogsToolset) returned a tool schema
  PASS  editor tool GetLogEntries returned a result
  PASS  editor tool GetLogEntries did not fail

== summary ==
  6/6 checks passed        (exit code 0)
```

## 8. What broke during verification, and what changed because of it

Recorded because these are the failures a user will hit, not incidental noise.

1. **`Start-Process -ArgumentList` does not quote paths.** The first three editor launches received
   `D:\Vibe` as the project argument; UE logged `LogInit: Display: Running engine without a game`,
   ignored the `.uproject` plugin list, and never loaded `ModelContextProtocol`. Fix: quote the
   project path in the argument list. (A launcher-side mistake, not a plugin bug — but it produced
   exactly the "plugins enabled yet no endpoint" symptom `ue_status` is meant to diagnose.)
2. **Default project scan was empty.** `discoverEndpoints` passed the list of search roots to a
   function expecting one root, so the scan always returned nothing and only port 8000 was probed.
   Fixed, plus discovery now takes the calling Session's working directory
   (`ctx.get('workingDirectory')`) as its first search root.
3. **Stale log line picked the wrong port.** The regex took the *first* `Starting MCP server on
   port N` in the log; after the editor restarted its server the first line was obsolete. Now the
   **last** occurrence wins.
4. **Endpoint moved while connected.** Someone ran `ModelContextProtocol.StartServer` in the editor,
   which unbound the routes and rebound them on another port. Requests then hit
   `{"errorCode":"errors.com.epicgames.httpserver.route_handler_not_found"}` (HTTP 404 with the
   socket still open). The client now classifies that as `endpoint_stale`, and every tool retries
   once through a fresh discovery (`EditorBridge.call`).
5. **Unbounded tool output.** `GetLogCategories` returned ~26 KB (≈1500 categories) and flooded the
   turn. Results are now capped at 8000 characters with an explicit truncation marker, and
   `ue_call`’s renderer no longer prints the payload twice.
6. **Two editors at once.** A second editor (started outside the session) was listening on the
   engine default 8000 and served **only** `ToolsetRegistry.AgentSkillToolset` — a project with
   `ModelContextProtocol` enabled but no `EditorToolset`. The bridge happily connected to it and
   reported the truth: `toolCount 3`, one toolset, no editor tools. That is the documented
   "MCP enabled, EditorToolset missing" case, observed live rather than hypothesised. Pin
   `endpoint` when two editors run.

## 9. Verification limits

- **No Git repository and no GitHub release.** `git` and `gh` are not installed in this environment
  (searched `Program Files`, `Program Files (x86)`, `D:\`, scoop and choco), and the user chose to
  skip publishing for this run. README §9 lists the exact `git init` / `gh release create` commands,
  including the `<plugin>-v<X.Y.Z>` tag format.
- Only **one** editor binary was exercised (`UnrealEditor.exe`). `UnrealEditor-Cmd.exe` was tried
  first for sandbox friendliness and must **not** be used: with a project argument it enters
  "running engine without a game" and never loads the project's plugins.
- The GUI editor ran under the session sandbox with DDC redirected into the project
  (`UE-LocalDataCachePath`), so a few editor-internal writes outside the workspace were denied by
  policy rather than by the plugin.
- `tools/list` in tool-search mode returns only meta-tools; the 19-toolset inventory above is
  reached through `list_toolsets`, not through enumeration of native MCP tools.
- Live reload: replacing `dist/` requires `plugin_manager remove_bundle` + `install_bundle` (or a
  DSH restart) to load a new JavaScript generation; `ue_status.pluginVersion` is the marker used to
  confirm which generation is running.

## 10. Revision round — two read-layer defects (plugin 0.1.4 / 0.1.5)

Both defects the user reported live in the layer that *interprets a result*, not in discovery,
transport, session handling, or dispatch. The connection, write-path, and self-healing evidence in
§1-§8 is therefore unaffected by this round.

### 10.1 `ue_status` reported plugins as missing when they were not

**What it did.** `missingRequired` was computed as "not written in the `.uproject`", so any project
that relies on a plugin's default or on a dependency was told it was broken.

**Why that is wrong (engine source, not opinion).** `ProjectManager.cpp`, in *"Check whether the
setting for any default plugin has been changed"*:

```cpp
const bool bEnabledByDefault = Plugin->IsEnabledByDefault(bAllowEnginePluginsEnabledByDefault);
bool bEnabled = bEnabledByDefault;                       // absent from .uproject ⇒ descriptor default
bool* EnabledPtr = ConfiguredPlugins.Find(Plugin->GetName());
if (EnabledPtr != nullptr) { bEnabled = *EnabledPtr; }    // only a written entry overrides it
```

and `PluginDescriptor.h` defines `EPluginEnabledByDefault { Unspecified, Enabled, Disabled }`, which
`PluginDescriptor.cpp` only overwrites when the `.uplugin` actually contains the field. On top of
that, `ModelContextProtocol.uplugin` lists `ToolsetRegistry` in its own `Plugins` array, so that
plugin loads whether or not the project mentions it.

**What it does now.** The report only states what the file proves:

| field | meaning | actionable |
| --- | --- | --- |
| `declared` | written `"Enabled": true` | no |
| `explicitlyDisabled` | written `"Enabled": false` — the only provable "off" | yes |
| `notDeclared` | absent; enabled by descriptor default or dependency | no |

Plugin *behaviour* is now observed instead of inferred: `ue_status` asks the live endpoint for
`list_toolsets` and reports `live.toolsetCount` / `live.hasEditorToolset`. The "MCP on but no editor
tools" suggestion now fires only from that observation.

### 10.2 `ue_describe_toolset` cut schemas at 8 KB

**What it did.** It returned the raw `describe_toolset` text and truncated it at the global cap, so a
large toolset's later tools simply did not exist for the agent.

**What it does now.** The toolset JSON is parsed, and completeness no longer depends on a byte cap:

- default: every tool **name + description**, paged with `offset`/`limit` (default 20) and a
  `nextOffset` hint;
- `tool_name`: that one tool's **complete** `inputSchema`/`outputSchema`, never truncated;
- the raw-text path remains only as a fallback for an unparsable answer, and it says so.

Measured on the live editor:

```
> ue_describe_toolset { toolset_name: "EditorToolset.EditorAppToolset", limit: 8 }
EditorToolset.EditorAppToolset — 21 tool(s), showing 0-7
- …WorldPosToScreenCoords / StopPIE / StartPIE / SetContentBrowserPath / SetCameraTransform /
  SelectAssets / SelectActors / SearchCVars
Names only. Call again with tool_name to read one tool's complete input and output schema.
Next page: offset=8.

> ue_describe_toolset { toolset_name: "EditorToolset.EditorAppToolset", tool_name: "StartPIE" }
# full schema returned: 21-line description, nested PIESessionOptions with enums, required lists,
# ToolsetTransform {location, rotation, scale}, outputSchema — no truncation marker
```

### 10.3 Two further defects found while re-verifying (same layer)

1. **Wrong project attributed to a connected endpoint.** With the fixture editor stopped, discovery
   connected to a *second* editor on the engine default port 8000, and `ue_status` still printed the
   fixture's `.uproject` as `project` — one project's configuration describing another editor.
   Fixed: `project`, `mcpConfig`, and `editorLog` are only emitted when the connected endpoint came
   from that project's own log or ini. Otherwise they are omitted and `notes` explains why.
   Observed after the fix, against the 8000 editor:

   ```json
   "live": { "toolsetCount": 52, "hasEditorToolset": true, "toolsetsSample": ["ToolsetRegistry.AgentSkillToolset", "…"] },
   "notes": ["No discovered project produced http://127.0.0.1:8000/mcp (source: engine-default), so no
              project-level configuration is attributed to this connection. Set projectPaths (or
              endpoint) to target one project."],
   "suggestions": []
   ```

   (No `project` key at all — correct, and no false plugin claims.)

2. **Bullets inside a description were parsed as toolsets.** That editor's `list_toolsets` text
   contains descriptions with `- ` bullet lines at column 0, so the naive parser invented toolsets
   named `枚举值查找` and `Actor上的Niagara组件` and inflated the count from 52 to 67. A bullet now
   starts a new toolset only when its leading token is a dotted identifier
   (`^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$`); anything else continues the previous description.

### 10.4 Regression status after the round

- `ue_status` on the fixture editor (0.1.4): `live.toolsetCount 19`, `hasEditorToolset true`,
  `declared` = the five plugins, `explicitlyDisabled []`, `notDeclared []`, `suggestions []`.
- `ue_status` on the foreign 8000 editor (0.1.5): `live.toolsetCount 52`, `hasEditorToolset true`,
  no `project`, the attribution note, `suggestions []`.
- `ue_list_toolsets` on the same editor: 52 structured entries, zero non-identifier names, Niagara
  bullet lists folded into their descriptions.
- `ue_describe_toolset`: paging and `tool_name` as shown in §10.2.
- Unchanged by this round: endpoint discovery, JSON-RPC session handling, timeout/error
  classification, `endpoint_stale` self-healing, and `ue_call` passthrough (§1-§8 still hold).
