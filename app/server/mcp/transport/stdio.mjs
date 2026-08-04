// 标准输入/输出传输层（单一职责：按行分隔的 JSON-RPC 消息收发）。
// 输入/输出流均可注入，便于在测试中用内存流替换 process.stdin/stdout。

export class StdioTransport {
  constructor({ incoming, outgoing, onMessage, onError } = {}) {
    this.incoming = incoming || process.stdin;
    this.outgoing = outgoing || process.stdout;
    this.onMessage = onMessage || (() => {});
    this.onError = onError || (() => {});
    this._buffer = '';
    this._closed = false;
    this._boundOnData = this._handleData.bind(this);
    this._boundOnEnd = this._handleEnd.bind(this);
  }

  start() {
    this.incoming.on('data', this._boundOnData);
    this.incoming.on('end', this._boundOnEnd);
    return this;
  }

  stop() {
    this._closed = true;
    if (this.incoming && typeof this.incoming.removeListener === 'function') {
      this.incoming.removeListener('data', this._boundOnData);
      this.incoming.removeListener('end', this._boundOnEnd);
    }
  }

  _handleData(chunk) {
    this._buffer += chunk.toString();
    let nlIndex;
    while ((nlIndex = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, nlIndex).trim();
      this._buffer = this._buffer.slice(nlIndex + 1);
      if (!line) continue;
      this._emitLine(line);
    }
  }

  _handleEnd() {
    this._closed = true;
    const rest = this._buffer.trim();
    if (rest) {
      this._emitLine(rest);
      this._buffer = '';
    }
  }

  _emitLine(line) {
    try {
      this.onMessage(JSON.parse(line));
    } catch (err) {
      this.onError(err);
    }
  }

  send(message) {
    if (this._closed) return;
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    this.outgoing.write(payload.endsWith('\n') ? payload : `${payload}\n`);
  }
}
