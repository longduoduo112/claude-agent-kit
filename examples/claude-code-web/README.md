# Claude Agent Kit — Web Example (Express + Vite + ws)

A full-stack example that streams Claude Agent sessions over WebSockets using `@claude-agent-kit/server` and `@claude-agent-kit/websocket`, served via Express with a Vite-powered client.

## Features
- Express server with `ws` WebSocket bridge
- React client with reconnect + resume support
- Session lifecycle via `SessionManager`/`Session`
- Clean separation of server and client code

## Prerequisites
- Node.js 18+
- An Anthropic API key exported as `ANTHROPIC_API_KEY`

## Getting Started
```bash
pnpm install
export ANTHROPIC_API_KEY=your-key-here
cd examples/claude-code-web
pnpm dev
# open http://localhost:5173
```

Build for production:
```bash
pnpm build
pnpm preview
```

## Run with Docker
This example now ships with a multi-stage Dockerfile that builds the client + SSR bundle and starts the Express server in production mode.

```bash
# Build the image from the repo root
docker build -f examples/claude-code-web/Dockerfile -t claude-code-web .

# Run it (expose port 5173 and pass your Anthropic-compatible credentials)
docker run \
  -p 5173:5173 \
  -e ANTHROPIC_API_KEY=your-key \
  -e ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic \
  -e ANTHROPIC_MODEL=glm-4.6 \
  --name claude-code-web \
  claude-code-web

# visit http://localhost:5173
```

Environment variables:
- `ANTHROPIC_API_KEY` (required)
- `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_URL`, `ANTHROPIC_MODEL` (optional overrides for Claude-compatible endpoints)
- `PORT` (default `5173`)
- `WORKSPACE_DIR` (optional, defaults to `<project>/agent`; controls where skills/uploads are stored)
- `API_AUTH_TOKEN` (optional, protects `/api` with an API key; send `Authorization: Bearer <token>` or `x-api-key: <token>`)
- `API_RATE_LIMIT_WINDOW_MS`, `API_RATE_LIMIT_MAX` (optional, express-rate-limit config; defaults 15m/300)

### Docker Compose workflow
Prefer using an env file? A ready-to-go `docker-compose.yml` is included.

```bash
cd examples/claude-code-web
cp .env.example .env   # edit values as needed
docker compose up --build
# stop later with:
docker compose down
```

## FAQ / 常见问题

- **Capabilities 面板为空 / `/api/capabilities` 报错，日志显示 `Claude Code process exited with code 1` 且包含 `--dangerously-skip-permissions cannot be used with root/sudo`**

  容器以 root 运行时，如果权限模式是 `bypassPermissions`（等价于开启 skip-permissions），Claude Code 子进程会直接退出。解决办法：

  1) 默认使用 `permissionMode: 'plan'`（已在代码中设置），重新构建镜像部署即可；
  2) 如果确实需要跳过权限提示，请将容器改为非 root 用户运行（例如 `docker run -u 1000:1000 ...` 或在 Dockerfile/Compose 中设置 user），再切回 `bypassPermissions`。

- **使用代理/兼容端点 (GLM 等) 时，能力探针或 Claude Code 子进程退出**

  打开调试输出定位：在容器环境加 `DEBUG=1`（可选 `CLAUDE_CODE_DEBUG_LOGS_DIR=/app/agent/.claude/logs`），重试 `/api/capabilities` 后查看 `docker logs` 或日志目录，按报错调整；未能修复时可暂时锁定 SDK 旧版（例如 0.1.47）。

- **部署 behind 反向代理时 rate limit 报 `X-Forwarded-For` 错误**

  代码已在 server 侧 `app.set('trust proxy', 1)`；确保代理正确传递 `X-Forwarded-For`/`X-Forwarded-Proto`。如果有多层代理可将 trust proxy 配置为跳数或 `true`。

- **CORS 预检失败 (带 Authorization/x-api-key)**

  代码已允许 `Authorization`/`X-API-Key` 头；如自定义头请在服务端 CORS 配置中补充。

## Server Wiring (simplified)
```ts
// src/server/server.ts
import { createServer as createHttpServer } from 'node:http'
import express from 'express'
import { WebSocketServer } from 'ws'
import { SimpleClaudeAgentSDKClient } from '@claude-agent-kit/server'
import { WebSocketHandler } from '@claude-agent-kit/websocket'

export async function createServer() {
  const app = express()
  const httpServer = createHttpServer(app)
  const wss = new WebSocketServer({ server: httpServer })
  const sdkClient = new SimpleClaudeAgentSDKClient()
  const wsHandler = new WebSocketHandler(sdkClient, { thinkingLevel: 'default_on' })

  wss.on('connection', (ws) => {
    void wsHandler.onOpen(ws)
    ws.on('message', (data) => wsHandler.onMessage(ws, String(data)))
    ws.on('close', () => wsHandler.onClose(ws))
  })

  return { app, httpServer, wss }
}
```

## Client Usage (hook)
A robust browser hook with auto-reconnect and session resume is provided:
`src/client/hooks/use-web-socket.ts`.

Minimal usage:
```ts
import { useWebSocket } from './hooks/use-web-socket'

const { isConnected, sendMessage, setSDKOptions } = useWebSocket({
  url: 'ws://localhost:5173',
  onMessage: (payload) => console.log(payload),
})

// send a chat message
sendMessage({ type: 'chat', content: 'Hello Claude!' })

// update SDK options
setSDKOptions({ thinkingLevel: 'default_on' })
```

## WebSocket Payloads
Inbound messages:
- chat: `{ type: 'chat', content: string, attachments?: AttachmentPayload[] }`
- setSDKOptions: `{ type: 'setSDKOptions', options: Partial<SessionSDKOptions> }`
- resume: `{ type: 'resume', sessionId: string }`

Outbound messages:
- message_added: `{ type: 'message_added', sessionId, message }`
- messages_updated: `{ type: 'messages_updated', sessionId, messages }`
- session_state_changed: `{ type: 'session_state_changed', sessionId, sessionState }`

Errors are serialized as: `{ type: 'error', code?: string, error: string }`.

## Skill upload API
You can upload packaged skills at runtime by POSTing a `.zip` file to `/api/skills/upload`.

```
curl -F "file=@my-skill.zip" -F "name=my-skill" http://localhost:5173/api/skills/upload
```

The archive is extracted into `${WORKSPACE_DIR:-agent}/.claude/skills/<name>` inside the container (or developer machine). The directory becomes available to Claude Agent SDK on the next session.

## Customize
- Default SDK options: adjust when constructing `WebSocketHandler`.
- Client resume: include `{ type: 'resume', sessionId }` after reconnect to reload history.
- Message rendering: see `src/client/components` for mapping content blocks to UI.

## MCP Servers
Claude Code Web can load [Model Context Protocol](https://modelcontextprotocol.io/) servers by reading an `.mcp.json` file at the project root.

- Configure servers under the `mcpServers` key. A stdio server entry needs a command plus any args, and SSE/HTTP entries just need their URLs.
- String values support `${ENV}` or `${ENV:-fallback}` templating. `WORKSPACE_DIR` and `PROJECT_ROOT` are automatically supplied.
- Set `allowedTools` to the fully qualified tool names (`mcp__<server>__<tool>`) that Claude is allowed to use. These are merged with the default tool list during startup.

The default `.mcp.json` wires up two servers:

1. `workspace-filesystem`: `npx @modelcontextprotocol/server-filesystem ${WORKSPACE_DIR}` gives Claude a sandboxed filesystem MCP server scoped to the agent workspace.
2. `jina-mcp-server`: connects to [Jina AI's hosted MCP endpoint](https://mcp.jina.ai) for web search, screenshotting, dedupe, etc. To use it, set `JINA_API_KEY` in your `.env` (Compose passes it through automatically).

Feel free to add more entries (SSE, HTTP, or stdio) following the SDK docs and redeploy.
