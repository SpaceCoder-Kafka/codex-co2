import { EventEmitter } from 'node:events';

// Private parent/child protocol. It never accepts guest text, RPC names or approval decisions.
export class AppControl extends EventEmitter {
  constructor({ input, output, start, command, close }) {
    super(); Object.assign(this, { input, output, startService: start, command, closeService: close });
    this.buffer = ''; this.queue = Promise.resolve(); this.closed = false;
  }
  send(message) { if (!this.output.destroyed) this.output.write(JSON.stringify(message) + '\n'); }
  run() {
    this.input.setEncoding('utf8');
    this.input.on('data', chunk => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 16384) return void this.close();
      let index;
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        this.queue = this.queue.then(() => this.receive(line)).catch(() => this.send({ type: 'error', message: '管理操作失败，请重试。' }));
      }
    });
    this.input.once('end', () => void this.close()); this.input.once('error', () => void this.close());
    this.output.once('error', () => void this.close());
    this.starting = this.startService().then(info => { if (!this.closed) this.send({ type: 'ready', ownerUrl: info.ownerUrl }); })
      .catch(() => { this.send({ type: 'error', message: '本地服务无法启动。请确认日常 Codex 正在运行、版本支持接入，且运行目录未由其他助手占用。' }); return this.close(); });
    return this;
  }
  async receive(line) {
    let request;
    try { request = JSON.parse(line); } catch { return this.send({ type: 'error', message: '无效的管理指令。' }); }
    if (this.closed) return;
    if (!request || Object.keys(request).some(k => !['type', 'id'].includes(k)) ||
        !['open-desktop', 'connect-current', 'check-network', 'login', 'account', 'revoke-all', 'shutdown'].includes(request.type) ||
        (request.id !== undefined && (!Number.isSafeInteger(request.id) || request.id < 0))) return this.send({ type: 'error', message: '不支持的管理操作。' });
    if (request.type === 'shutdown') return this.close();
    await this.starting;
    if (this.closed) return;
    try { this.send({ type: 'result', id: request.id, command: request.type, ...await this.command(request.type) }); }
    catch (error) { this.send({ type: 'error', id: request.id, message: error.safeMessage ?? '操作未完成，请检查测试窗口和网络后重试。' }); }
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.resolve().then(() => this.closeService()).then(() => {
      this.send({ type: 'stopped' }); this.input.pause(); this.emit('closed');
    });
    return this.closing;
  }
}
