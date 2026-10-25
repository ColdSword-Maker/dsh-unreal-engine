# dsh-unreal-engine

让 DeepSeek Harness 直接驱动一个**正在运行的 Unreal Engine 5.8 编辑器**：列出编辑器暴露的工具，并调用它们去读取日志、检查 Actor 与资产、操作蓝图等。

本插件是纯客户端。它不修改、不重编译引擎，也不包含 C++ 插件或 Python 代码——UE 5.8 自带的 MCP 服务器本来就跑在编辑器进程里、对外提供 HTTP 端点，插件只负责把 DSH 的工具调用翻译成对该端点的请求。

> **依赖实验性功能。** 本插件依赖 UE 5.8 的 `ModelContextProtocol`（实验性插件）栈。不同引擎小版本之间，工具集名称、工具 schema 乃至可用工具列表都可能变化，**不保证跨版本兼容**。
>
> 验证环境：Unreal Engine 5.8.4，DeepSeek Harness 0.2.1-rc.3（Cordis 4.0.5）。适配的插件契约与协议版本见 [§2](#2-适配的-deepseek-harness-版本与插件契约)。

---

## 1. 工作原理

```
DSH Agent ──► ue_* 工具 ──► HTTP（JSON-RPC 2.0）──► UE 编辑器进程内的 MCP 服务器
                          单跳直连，不引入 stdio 子进程或额外的转发层
```

所有 Python 逻辑（`EditorToolset` 的工具集）都在编辑器进程内执行，DSH 侧只负责 HTTP 往返。

---

## 2. 适配的 DeepSeek Harness 版本与插件契约

本插件按 **DeepSeek Harness 0.2.1-rc.3**（Desktop 宿主 `@deepseek-ai/dsh-desktop`，同版本）的插件契约编写，运行在 **Cordis 4.0.5** 插件运行时之上。宿主走 nightly 通道、升级较快，所以下面把实际依赖的每一项契约列清楚；这些契约若变动，插件需要跟进。

| 契约 | 本插件使用的形态 |
| --- | --- |
| 模块入口 | `export function apply(ctx, config)`，可另带 `export const name` / `export const inject` |
| 服务依赖 | `inject = ['tools']`（必需）；`ctx.get('workingDirectory')`（可选，用于取会话工作目录作为发现起点） |
| 工具注册 | `ctx.tools.register(ToolDefinition)`，返回该工具的卸载函数 |
| 工具定义字段 | `name` / `description` / `parameters` / `output.schema` / `output.render` / `execute`，可选 `isConcurrencySafe`、`presentCall`、`output.presentationMeta` |
| 生命周期 | `ctx.effect(() => disposer)`；工具注册与 `AbortController` 都放在 effect 内，卸载时清理注册并中止在途请求 |
| 参数与输出 schema | DSH 只接受受支持的 JSON Schema 子集：单个 `type`、`oneOf`、`properties`、`required`、布尔 `additionalProperties`、`items`、`enum`、`const`，外加 `description` / `title` / `default` / `examples` 注解；输出必须是 object 根 |
| Bundle 契约 | `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，后者以 `- insert:` 声明一行 `id` / `name` / `config` |

两点需要知道：

- 插件**没有声明宿主包的 `dependencies` / `peerDependencies`**。profile 安装是链接本地目录，声明依赖会让 pnpm 去包仓库解析宿主包，反而多出一个失败面；代价是宿主契约若变动，包管理器不会提示，只能靠上面的版本对照。
- 构建需要 **Node ≥ 22.13**（用内建类型擦除，不需要 `node_modules`）；运行期只需要 ESM 与全局 `fetch`，由 DSH 自带的 Node 提供。

UE 侧使用的协议是 **MCP `2025-11-25`**（JSON-RPC 2.0 over Streamable HTTP）：握手时与编辑器协商版本，之后每个请求携带 `Mcp-Session-Id` 与 `Mcp-Protocol-Version`。

## 3. 前置条件（UE 侧）

| 要求 | 说明 |
| --- | --- |
| Unreal Engine **5.8.x** 编辑器 | MCP 服务器、`ToolsetRegistry`、`EditorToolset` 自 5.8 起提供 |
| `ModelContextProtocol` 插件 | 提供编辑器内的 MCP 服务器与 HTTP 路由（`/mcp`） |
| `ToolsetRegistry` 插件 | 所有工具集背后的注册表，`ModelContextProtocol` 依赖它 |
| `MCPClientToolset` 插件 | 编辑器作为 MCP 客户端的工具集，属于受支持的启用集合 |
| `PythonScriptPlugin` 插件 | `EditorToolset` 的工具集是 Python 模块 |
| `EditorToolset` 插件 | 真正操作编辑器的工具集（日志、Actor、资产、蓝图、材质……） |

以上插件**默认都是关闭的**，需要在项目的 `.uproject` 中启用：

```json
{
  "Plugins": [
    { "Name": "ModelContextProtocol", "Enabled": true },
    { "Name": "ToolsetRegistry", "Enabled": true },
    { "Name": "MCPClientToolset", "Enabled": true },
    { "Name": "PythonScriptPlugin", "Enabled": true },
    { "Name": "EditorToolset", "Enabled": true }
  ]
}
```

### 启动 MCP 服务器

**只启用插件还不够**：`bAutoStartServer` 默认为 `false`，服务器不会自己起来。三种任选其一：

**A. 命令行（不改工程文件）**

```
UnrealEditor.exe "<你的工程>.uproject" -ModelContextProtocolStartServer
# 可选：-ModelContextProtocolPort=8765
```

**B. 工程 ini**（`Saved/Config/WindowsEditor/EditorPerProjectUserSettings.ini`，重启后仍生效）

```ini
[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]
bAutoStartServer=True
ServerPortNumber=8765
ServerUrlPath=/mcp
```

**C. 编辑器内**：*Project Settings → Plugins → Model Context Protocol*，勾选 **Auto Start Server**。

端口与路径无需在本插件里硬编码：引擎默认是 `http://127.0.0.1:8000/mcp`，配置或命令行会覆盖它，插件会自动发现（见下文）。

---

## 4. 安装

1) 克隆仓库到任意目录（下文记作 `<插件目录>`）：

```bash
git clone https://github.com/ColdSword-Maker/dsh-unreal-engine.git
```

2) 装进 DSH profile。在 DSH 会话里：

```
plugin_manager action=install_bundle target="<插件目录的绝对路径>"
```

或在本机终端（`dsh` 已在 PATH 上）：

```
dsh plugin --profile <profile> add "<插件目录的绝对路径>"
```

注意：

- `target` 必须是**绝对路径**。
- DSH 的 profile 安装依赖 pnpm，缺失时会直接报错——这是 DSH 的要求，不是本插件的要求。
- 本插件**没有任何运行时依赖**，安装过程不需要访问包仓库。
- 安装会把 profile 链接到 `<插件目录>`，**之后不要移动或删除该目录**，否则插件会失效。
- 首次安装通常当前会话即可生效；若没看到 `ue_*` 工具，重启 DSH。更新本插件后同样需要重启才能加载新的代码。

---

## 5. 配置

全部配置项都是可选的，写在 profile 的 `cordis.patch.yml` 里，定位到 `ue5` 这一行：

```yaml
- id: ue5
  name: "@local/dsh-unreal-engine"
  config:
    endpoint: http://127.0.0.1:8765/mcp
```

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `endpoint` | — | 完整 URL，例如 `http://127.0.0.1:8765/mcp`。设置后不再自动发现 |
| `host` | `127.0.0.1` | 自动发现时使用的主机名 |
| `port` | — | 显式端口，优先于自动发现的端口 |
| `path` | `/mcp` | URL 路径 |
| `projectPaths` | `[]` | 要检查的工程目录或 `.uproject` 文件；为空时扫描工作目录、其父目录与「文档」目录（深度 3） |
| `ports` | `[]` | 额外探测的端口 |
| `requestTimeoutMs` | `15000` | 单次请求超时 |
| `maxResultChars` | `8000` | `ue_call` 等原始文本的返回上限（schema 走分页，不受此限） |
| `mirrorTools` | `true` | `ue_list_tools` 之后把非元工具镜像为 `ue_tool_<名称>` |
| `mirrorLimit` | `32` | 镜像数量上限 |

也可以用环境变量覆盖端点：`DSH_UE5_ENDPOINT` 或 `UE5_MCP_ENDPOINT`。

### 端口是怎么找到的

端口不是固定契约，插件按以下顺序依次探测，第一个能完成 MCP 握手的即为目标：

1. 配置里的 `endpoint` / `port`
2. 环境变量
3. 工程日志 `Saved/Logs/*.log` 中的 `Starting MCP server on port N`（唯一能反映**当前运行**编辑器实际端口的来源）
4. 工程 ini `Saved/Config/<平台>Editor/EditorPerProjectUserSettings.ini`
5. 引擎用户目录下的 ini
6. 引擎默认端口 8000

---

## 6. 工具

| 工具 | 用途 |
| --- | --- |
| `ue_status` | 有没有连上、连的是哪个端点、编辑器实际提供了什么。同时报告实时工具集数量与 `EditorToolset` 是否存在；`refresh: true` 用于编辑器重启后重新发现 |
| `ue_list_tools` | 端点的 `tools/list`。开启工具搜索时（引擎默认）只有三个元工具 |
| `ue_list_toolsets` | 工具集清单，返回结构化的 `{name, description}` 与引擎原文 |
| `ue_describe_toolset` | 某个工具集的工具列表，可用 `offset`/`limit` 分页；加 `tool_name` 则返回该工具**完整**的输入输出 schema |
| `ue_call` | 兜底调用。只给 `tool_name` 调用已通告的工具；再加 `toolset_name` 则经 `call_tool` 分发到工具集。编辑器自己的错误文本原样返回 |

典型顺序：`ue_status` → `ue_list_toolsets` → `ue_describe_toolset` → `ue_call`。

### 为什么要分这五个

UE 5.8 默认 `bEnableToolSearch = true`，此时引擎只注册 `list_toolsets`、`describe_toolset`、`call_tool` 三个元工具，不会把任何工具集工具注册成原生 MCP 工具；关闭工具搜索后又会一次性暴露全部工具集工具（完整安装可能有数百个），逐轮消耗大量上下文。所以主界面固定为上面五个，`ue_call` 始终保证可达；只有确实返回了非元工具时，才会额外镜像（受 `mirrorTools` / `mirrorLimit` 控制）。

### 读懂 `ue_status`

`project` 下的三个字段只是**对 `.uproject` 的陈述**，不是对插件状态的推断：

| 字段 | 含义 | 是否需要处理 |
| --- | --- | --- |
| `declared` | 文件里写了 `"Enabled": true` | — |
| `explicitlyDisabled` | 文件里写了 `"Enabled": false`，**唯一能证明被关掉的状态** | 是：改为 true 并重启编辑器 |
| `notDeclared` | 文件里没写。**不等于被禁用** | 否 |

`notDeclared` 之所以不代表禁用：UE 的 `FProjectManager` 会先取插件描述符的默认值，只有 `.uproject` 显式写了条目才覆盖；`ToolsetRegistry` 更是被 `ModelContextProtocol.uplugin` 的依赖列表直接拉起。

判断“编辑器工具到底能不能用”，看 `live.hasEditorToolset`（实测值），不要看 `.uproject`。

当连上的端点并非由某个被发现的工程产生时（例如端口 8000 上其实是另一个工程），`ue_status` 会**省略** `project`、`mcpConfig`、`editorLog` 并在 `notes` 里说明，避免把 A 工程配置安到 B 编辑器上。此时可用 `endpoint` 或 `projectPaths` 指定目标。

---

## 7. 错误处理

失败会被分类，而不是笼统地报“调用失败”：

| 错误码 | 含义 | 处理方式 |
| --- | --- | --- |
| `editor_not_running` | 所有候选端点都没完成握手 | 启动工程编辑器；查看 `ue_status.suggestions` |
| `ue_timeout` | 端口有人监听，但握手超时 | 编辑器忙或卡在模态框，重试或增大 `requestTimeoutMs` |
| `ue_rpc_error` | 编辑器返回 JSON-RPC 错误（如 `Unknown tool: foo`） | 消息即编辑器原文 |
| `session_expired` | 编辑器不认识当前会话 | 自动重新握手一次，无需干预 |
| `ue_http_error` | 非 2xx 且无 JSON-RPC 响应（如 Origin 被拒） | 看 `problem.detail`，内含引擎原文 |
| `endpoint_stale` | 端口还在监听但 MCP 路由已被解绑（编辑器重启了服务器） | 自动重新发现并重试一次 |
| `bad_config` | `endpoint` 不是合法 URL | 修正配置 |

工具级失败（`isError: true`）不算插件错误：`ue_call` 会返回 `ok: true, isError: true, text: <编辑器原文>`，例如 `EditorToolset` 的 Python 报错栈会原样透出。

---

## 8. 自检

克隆后可用仓库自带的脚本，对着**当前正在运行**的编辑器跑一遍：

```bash
node scripts/verify-ue.mjs --project "<你的工程目录>"
```

它会依次检查：端点发现、`initialize` 握手拿到会话、`tools/list` 非空、`list_toolsets` 至少一个工具集、`describe_toolset` 能取到 schema、以及一次**只读**的编辑器调用是否成功。

退出码：`0` 全通过、`1` 有检查失败、`2` 连不上编辑器。失败时会打印编辑器自己的原文，不会被包装。

一次真实的端到端往返记录（含工具输出与踩到的坑）见 [docs/verification.md](docs/verification.md)。

---

## 9. 已知限制

- **仅支持 UE 5.8 的实验性 MCP 栈**。引擎小版本变化会改动工具集与 schema，可能“连得上但工具不同”，不做跨版本兼容承诺。
- **工具搜索模式会隐藏工具**。`tools/list` 只返回三个元工具是 5.8 的正常行为，不是装坏了；请用 `ue_list_toolsets` + `ue_call`。
- **同一时刻只对接一个编辑器**。第一个可达的候选胜出；同时开两个编辑器时请用 `endpoint` 指定。
- **只支持本机**。引擎会拒绝非本机 `Origin`，本插件也只面向 `127.0.0.1` / `localhost`，不支持远程编辑。
- **发现依赖文件**。5.8 的 MCP 栈没有 beacon 文件，插件读的是工程 ini 与编辑器日志；工程不在默认搜索范围内、又没监听默认端口时，需要配 `projectPaths` 或 `endpoint`。
- **不会自动启动编辑器**。是否启动、何时启动由你决定。
- **`category` 的默认值有坑**。UE 5.8 给 `LogsToolset` 工具生成的 schema 把 `category` 默认值写成了 `"LogsToolset"`，而它并不是真实日志类别；省略该参数会得到 `Log category 'LogsToolset' not found.`。需要“全部类别”时显式传 `"category": ""`。
- **镜像只是便利功能**。镜像工具要等一次成功的 `ue_list_tools` 后才出现；`ue_call` 始终是权威入口。

---

## 10. 仓库结构

```
package.json        # dsh.bundle 声明、构建与自检脚本，零运行时依赖
cordis.patch.yml    # 插入 ue5 这一行并给出带注释的配置
src/                # TypeScript 源码（index / ue-endpoint / mcp-client / tools）
dist/               # 已构建的 ESM 产物，随仓库提交，clone 后无需构建即可安装
scripts/build.mjs   # src → dist（Node 内建类型擦除），并强制零裸依赖
scripts/verify-ue.mjs
docs/verification.md
locale/             # 插件在 DSH 界面中的中英文名称与描述
icon.svg
```

`dist/` 是提交进仓库的：包入口就是 `dist/index.js`，这样克隆下来可以直接安装。若你改动了 `src/`，需要重新构建并让产物跟进：

```bash
pnpm build
```

---

## 许可

MIT。
