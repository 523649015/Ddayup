// MCP 服务器（单一职责：编排传输层、工具注册与 JSON-RPC 分发）。
// 支持 initialize / tools/list / tools/call / ping；可直接调用 handleMessage 进行单元/集成测试。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioTransport } from './transport/stdio.mjs';
import { ToolRegistry } from './tools/registry.mjs';
import { BackendClient } from './client/backend-client.mjs';
import { createHealthTools } from './tools/health-tools.mjs';
import { createAssetTools } from './tools/asset-tools.mjs';
import { createMemoryTools } from './tools/memory-tools.mjs';
import { defaultMemory } from '../memory/index.mjs';
import { makeResponse, makeError, ErrorCode } from './protocol.mjs';

const SERVER_INFO = { name: 'hmdao-mcp', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';

export class McpServer {
  constructor({ client, memory, transport } = {}) {
    this.client = client || new BackendClient();
    this.memory = memory || defaultMemory;
    this.registry = new ToolRegistry();
    this._registerTools();
    this.transport = transport || null;
    // 串行处理队列：保证请求按到达顺序、前一条完成后再处理下一条，
    // 避免并发工具（如带文件 I/O 的 remember）被后续快速工具抢先导致结果不一致。
    this._chain = Promise.resolve();
  }

  _registerTools() {
    this.registry
      .registerMany(createHealthTools({ client: this.client }))
      .registerMany(createAssetTools({ client: this.client }))
      .registerMany(createMemoryTools({ memory: this.memory }));
  }

  // 处理单条 JSON-RPC 消息，返回响应对象（或不返回通知）。
  async handleMessage(message) {
    if (!message || typeof message !== 'object') {
      return makeError(null, ErrorCode.InvalidRequest, 'invalid-request');
    }
    const { id, method, params } = message;
    try {
      switch (method) {
        case 'initialize':
          return makeResponse(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          });
        case 'tools/list':
          return makeResponse(id, { tools: this.registry.list() });
        case 'tools/call': {
          const toolName = params && params.name;
          const args = (params && params.arguments) || {};
          const result = await this.registry.dispatch(toolName, args);
          return makeResponse(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: false,
          });
        }
        case 'ping':
          return makeResponse(id, {});
        default:
          return makeError(id, ErrorCode.MethodNotFound, `method-not-found:${method}`);
      }
    } catch (err) {
      const code = err && err.code === 'ToolNotFound' ? ErrorCode.MethodNotFound : ErrorCode.InternalError;
      return makeError(id, code, err && err.message ? err.message : 'internal-error');
    }
  }

  // 绑定传输层（默认 stdio）。
  attach(transport) {
    this.transport =
      transport ||
      new StdioTransport({ onMessage: (msg) => this._onTransportMessage(msg) });
    return this.transport;
  }

  async _onTransportMessage(message) {
    // 串行入队，确保响应顺序与请求顺序一致且语义正确。
    this._chain = this._chain.then(async () => {
      const response = await this.handleMessage(message);
      if (response && this.transport) this.transport.send(response);
    });
    return this._chain;
  }

  start() {
    const transport = this.attach(this.transport);
    transport.start();
    return this;
  }
}

// 作为独立进程运行时（如被 AI 客户端的 MCP 配置启动）启动 stdio 服务器。
// 使用与 import.meta.url 一致的绝对路径比较，避免 Windows 反斜杠导致 endsWith 误判。
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  const server = new McpServer();
  server.start();
  if (process.env.HMDAO_MCP_DEBUG) {
    process.stderr.write(`[hmdao-mcp] started, backend=${server.client.baseUrl}\n`);
  }
}

export default McpServer;
