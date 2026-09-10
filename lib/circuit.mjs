// lib/circuit.mjs —— 熔断器核心。唯一外部依赖是通过构造函数注入的 recordAudit
// （落库审计，server.mjs 提供）；其余方法均为纯状态机转换，可独立测试。

export const CB_MAX_BACKOFF_FACTOR = 8;
export const CB_MAX_COOLDOWN_MS = 5 * 60 * 1000;

export class CircuitBreaker {
  constructor(opts = {}) {
    this.profileName = opts.profileName || "";
    this.failureThreshold = opts.failureThreshold || 5;
    this.cooldownMs = opts.cooldownMs || 30000;
    this.halfOpenMaxRequests = opts.halfOpenMaxRequests || 2;
    this.recordAudit = opts.recordAudit;
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.state = "CLOSED"; // CLOSED | OPEN | HALF_OPEN
    this.halfOpenRequests = 0;
    this.consecutiveProbeFailures = 0;
    this.totalFailures = 0;
    this.totalSuccesses = 0;
  }

  currentCooldownMs() {
    const factor = Math.min(2 ** this.consecutiveProbeFailures, CB_MAX_BACKOFF_FACTOR);
    return Math.min(this.cooldownMs * factor, CB_MAX_COOLDOWN_MS);
  }

  // Non-mutating "is this profile worth routing to right now?". The candidate
  // filter needs this WITHOUT performing the OPEN → HALF_OPEN transition, which
  // stays the exclusive job of allowRequest(). Reading state directly here is
  // what used to strand a recovered group head OPEN forever: the filter excluded
  // it, so allowRequest() never ran and the transition never happened — traffic
  // stayed on the fallback and the head's plan quota went unused.
  isAvailable() {
    if (this.state === "CLOSED") return true;
    if (this.state === "HALF_OPEN") return this.halfOpenRequests < this.halfOpenMaxRequests;
    return Date.now() - this.lastFailureTime >= this.currentCooldownMs();
  }

  allowRequest() {
    switch (this.state) {
      case "CLOSED":
        return true;
      case "OPEN": {
        const elapsed = Date.now() - this.lastFailureTime;
        if (elapsed >= this.currentCooldownMs()) {
          this.state = "HALF_OPEN";
          this.halfOpenRequests = 0;
          console.log("[CB] Circuit OPEN → HALF_OPEN, probing upstream");
          this.recordAudit?.("system", "breaker.halfopen", this.profileName, `方案 "${this.profileName}" 熔断冷却结束，进入半开探测状态`);
          return true;
        }
        return false;
      }
      case "HALF_OPEN":
        return this.halfOpenRequests < this.halfOpenMaxRequests;
      default:
        return true;
    }
  }

  recordSuccess() {
    this.totalSuccesses++;
    if (this.state === "HALF_OPEN") {
      this.consecutiveProbeFailures = 0;   // upstream answered — drop the backoff
      this.halfOpenRequests++;
      if (this.halfOpenRequests >= this.halfOpenMaxRequests) {
        this.state = "CLOSED";
        this.failureCount = 0;
        console.log("[CB] Circuit HALF_OPEN → CLOSED, upstream recovered");
        this.recordAudit?.("system", "breaker.closed", this.profileName, `方案 "${this.profileName}" 半开探测成功，熔断关闭，上游已恢复`);
      }
    } else if (this.state === "CLOSED") {
      this.failureCount = 0;
    }
  }

  recordFailure() {
    this.totalFailures++;
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.state === "HALF_OPEN") {
      this.state = "OPEN";
      this.consecutiveProbeFailures++;
      const wait = Math.round(this.currentCooldownMs() / 1000);
      console.log(`[CB] Circuit HALF_OPEN → OPEN, probe failed (next probe in ${wait}s)`);
      this.recordAudit?.("system", "breaker.open", this.profileName, `方案 "${this.profileName}" 半开探测失败，重新熔断 ${wait}s（连续探测失败 ${this.consecutiveProbeFailures} 次，冷却已退避延长）`);
    } else if (this.state === "CLOSED" && this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
      console.log(`[CB] Circuit CLOSED → OPEN, ${this.failureCount} consecutive failures`);
      this.recordAudit?.("system", "breaker.open", this.profileName, `方案 "${this.profileName}" 连续 ${this.failureCount} 次失败，熔断开启 ${Math.round(this.currentCooldownMs() / 1000)}s，期间请求自动切换到备选方案`);
    }
  }

  reset() {
    this.state = "CLOSED";
    this.failureCount = 0;
    this.halfOpenRequests = 0;
    this.consecutiveProbeFailures = 0;
  }

  status() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      probeFailures: this.consecutiveProbeFailures,
      cooldownMs: this.currentCooldownMs(),
      cooldownRemaining: this.state === "OPEN"
        ? Math.max(0, this.currentCooldownMs() - (Date.now() - this.lastFailureTime))
        : 0,
    };
  }
}