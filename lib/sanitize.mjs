// lib/sanitize.mjs —— 深拷贝去原型污染。纯函数，零外部依赖。

export const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function sanitizeJson(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeJson);
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    clean[k] = typeof v === "object" && v !== null ? sanitizeJson(v) : v;
  }
  return clean;
}