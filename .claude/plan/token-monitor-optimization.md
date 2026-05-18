# Token Monitor 优化规划

## 问题分析

经过代码审查，确认三个核心问题：

---

### 问题 1：错误记录时间与实际时间不符

**根因**：`cnNow()` 创建了一个手动偏移到北京时间的 Date 对象，但 `.toISOString()` 总是以 UTC 格式输出（带 "Z" 后缀）。当浏览器用 `new Date(e.time).toLocaleString("zh-CN")` 显示时，会再次加上 8 小时时区偏移，导致时间多出 8 小时。

**示例**：实际北京时间 10:34 → `cnNow()` 返回 Date(10:34 UTC) → `toISOString()` = `"T10:34:00.000Z"` → 浏览器 UTC+8 显示 18:34

**影响范围**：
- `recordError` (line 137): `cnNow().toISOString()` — 错误记录时间
- `recordUsage` (line 111): `cnNow().toISOString()` — lastActive 时间
- 前端显示：`new Date(e.time).toLocaleString("zh-CN")` — 所有时间展示

---

### 问题 2：请求效率与并发能力

**现状**：
- 每个上游请求都创建新的 TCP 连接（无连接池/keep-alive）
- `saveStore()` 使用 `writeFileSync` 每 30 秒阻塞事件循环
- 无上游请求超时设置，请求可无限挂起
- 无并发控制，高并发时可能压垮上游或触发限流
- `store` 对象的 mutation 虽然在单线程中安全，但 `writeFileSync` 阻塞期间无法处理新请求

---

### 问题 3：504 Gateway Time-out 及请求失败

**根因分析**：
- 代理服务未设置上游请求超时 → 长时间无响应时连接挂起
- 无重试机制 → 429 限流错误直接返回给客户端
- 无请求排队 → 高并发时大量请求同时打到上游，触发限流
- 从 data.json 可以看到大量 429 错误（"该模型当前访问量过大"、"您的账户已达到速率限制"）

---

## 修复方案

### Phase 1：修复时间戳 Bug（高优先级）

**修改 `server.mjs`**：
1. `recordError` (line 137)：`cnNow().toISOString()` → `new Date().toISOString()`
2. `recordUsage` (line 111)：`cnNow().toISOString()` → `new Date().toISOString()`
3. 前端所有时间显示：添加北京时间转换函数

**前端修复**：
```javascript
// 添加北京时间格式化函数
function fmtBJTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  // 转换为 UTC+8 显示
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const bj = new Date(utc + 8 * 3600000);
  return bj.toLocaleString("zh-CN");
}
```
替换所有 `new Date(e.time).toLocaleString("zh-CN")` 和 `ago()` 函数中的时间计算。

---

### Phase 2：提升请求效率与并发能力（中优先级）

**2.1 连接池与 keep-alive**
```javascript
// 创建持久化 HTTP Agent
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000,
});
```
在 `proxyRequest` 中使用此 agent。

**2.2 异步文件写入**
```javascript
// saveStore 改为异步
function saveStore() {
  fs.writeFile(dataPath, JSON.stringify(store, null, 2), (err) => {
    if (err) console.error("[STORE] Save failed:", err.message);
  });
}
```

**2.3 添加请求超时**
```javascript
const upReq = transport.request(opts, ...);
// 普通请求 120s，流式请求 300s
const timeout = streaming ? 300000 : 120000;
upReq.setTimeout(timeout, () => {
  upReq.destroy(new Error("Upstream request timeout"));
});
```

**2.4 并发控制（每用户请求队列）**
```javascript
// 每用户并发限制
const userConcurrency = {};
const MAX_CONCURRENT_PER_USER = 5;

function checkConcurrency(apiKey) {
  const key = resolveUserKey(apiKey);
  if (!userConcurrency[key]) userConcurrency[key] = 0;
  return userConcurrency[key] < MAX_CONCURRENT_PER_USER;
}
```

---

### Phase 3：减少请求失败（高优先级）

**3.1 自动重试机制（429/504/502）**
```javascript
async function proxyWithRetry(req, res, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // ... 执行请求
    if (statusCode === 429 || statusCode === 504 || statusCode === 502) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
      await sleep(delay);
      continue;
    }
    break;
  }
}
```

**3.2 每用户速率限制**
```javascript
const rateLimiter = {
  window: 60000,  // 1 分钟窗口
  maxRequests: 60, // 每分钟最多 60 请求
  // ... sliding window 实现
};
```

**3.3 改善错误信息**
- 区分代理错误 vs 上游错误
- 504 时明确告知用户是上游超时还是代理超时
- 添加 `X-Proxy-Error` header 标识代理层错误

**3.4 健康检查端点**
```javascript
// GET /health
{
  status: "ok",
  upstream: "reachable",
  activeConnections: N,
  uptime: seconds
}
```

---

## 修改文件清单

| 文件 | 修改内容 |
|------|---------|
| `server.mjs` | 所有三个 Phase 的后端改动 |
| `config.json` | 新增可选配置项（timeout、retry、rateLimit） |

## 实施顺序

1. **Phase 1** → 时间戳修复（立即见效，零风险）
2. **Phase 3** → 重试与超时（大幅减少失败率）
3. **Phase 2** → 连接池与并发优化（提升吞吐量）

## 预期效果

- 时间显示：完全准确显示北京时间
- 请求成功率：从当前水平提升 30-50%（通过重试和限流）
- 并发能力：支持 50+ 并发连接（当前受限于无连接池）
- 504 错误：明确区分来源，自动重试可恢复的临时错误
