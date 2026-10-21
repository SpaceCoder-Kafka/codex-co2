// Probes the public HTTPS route without changing its hostname or authorizations.
// A failed probe describes reachability from A, never permanent URL expiry.
export class PublicHealth {
  constructor({ origin, checkHealth, signal, onStatus = () => {}, onCheck = () => {}, intervalMs = 30000, failureLimit = 3 }) {
    Object.assign(this, { origin, checkHealth, signal, onStatus, onCheck, intervalMs, failureLimit });
    this.abort = new AbortController(); this.failures = 0; this.stopped = false;
  }
  start() {
    this.timer = setInterval(() => { void this.check(); }, this.intervalMs);
    this.timer.unref?.();
    return this;
  }
  check() {
    if (this.stopped || this.signal?.aborted) return Promise.resolve();
    return this.checking ??= this.probe().finally(() => { this.checking = null; });
  }
  async probe() {
    this.onCheck();
    const signal = AbortSignal.any([this.abort.signal, ...(this.signal ? [this.signal] : []), AbortSignal.timeout(5000)]);
    let result;
    try { result = await this.checkHealth(this.origin, { signal }); }
    catch { result = { ok: false }; }
    if (this.stopped || this.abort.signal.aborted || this.signal?.aborted) return;
    this.failures = result?.ok ? 0 : this.failures + 1;
    this.onStatus({ state: result?.ok ? 'online' : this.failures >= this.failureLimit ? 'unavailable' : 'recovering',
      checkedAt: Date.now(), failures: this.failures });
  }
  async close() {
    this.stopped = true; clearInterval(this.timer); this.abort.abort();
    await this.checking;
  }
}
