// lib/assets.mjs —— 页面静态资源（浏览器 JS/CSS）加载器。零外部依赖。
// 启动时把 public/assets/ 下的文件读入内存并按内容计算版本号（sha256 前 10 位），
// 页面模板用 assetUrl() 生成带 ?v= 的引用实现强缓存；文件改动随进程重启生效
// （与 server.mjs 自身代码一致）。目录缺失（精简的测试环境等）时按空资源集处理，
// /assets/* 一律 404，不影响进程启动。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function loadAssets(dir) {
  const assets = new Map();
  try {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (!fs.statSync(full).isFile()) continue;
      const body = fs.readFileSync(full);
      assets.set(name, {
        body,
        version: crypto.createHash("sha256").update(body).digest("hex").slice(0, 10),
        contentType: MIME[path.extname(name)] || "application/octet-stream",
      });
    }
  } catch {
    console.warn(`[Assets] 目录不存在或不可读: ${dir}，/assets/* 将返回 404`);
  }

  return {
    // 单段文件名白名单：Map 键匹配天然免疫路径穿越（../、绝对路径、编码变体都查不到键）
    get(name) {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(String(name || ""))) return null;
      return assets.get(String(name)) || null;
    },
    url(name) {
      const a = assets.get(name);
      return a ? `/assets/${name}?v=${a.version}` : `/assets/${name}`;
    },
  };
}
