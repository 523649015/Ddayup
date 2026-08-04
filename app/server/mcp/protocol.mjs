// MCP JSON-RPC 协议辅助（单一职责：消息构造与错误码）。
// 参考 Model Context Protocol 的 JSON-RPC 2.0 规范。

export const JSON_RPC_VERSION = '2.0';

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
};

export function makeResponse(id, result) {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

export function makeError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSON_RPC_VERSION, id, error };
}

export function makeNotification(method, params) {
  return { jsonrpc: JSON_RPC_VERSION, method, params: params || {} };
}
