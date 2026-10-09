// lib/code-review-standard.mjs —— 团队统一评审标准（加载 / 校验 / 编译）
//
// 为什么要有这个模块：评审标准过去是「引擎内置清单 + 每个仓库手写的背景说明」拼出来的，
// 同一个提交在不同时间能评出 0 条或 3 条。这里把标准收敛成**一份可版本化的文本**：
//
//   lib/review-standard/*.md  ──编译──▶  {"rules":[{path, rule, merge_system_rule:true}]}
//                                                    │
//                                           --rule <file>  传给 ocr
//
// 业务背景（全局 + 每个仓库）也由本模块落成 `--background-file`（见 writeReviewInputs）。
//
// 两条机制性事实（实测，见 wiki/code-review.md「统一评审标准」）：
//   · `--rule` **首条匹配生效**：命中哪条就注入哪条文本，段与段之间不会叠加
//     → 每段的正文必须是「通用段 + 本段」的**自包含拼接**，且 `**/*` 必须排在最后一条
//   · `merge_system_rule: true` 会把**引擎自带的分语言清单**与本段合并（我们的文本排在其后）
//     → 不必抄写内置清单（抄必漏），只需用通用段里的「禁止清单」把噪声项显式取消
//
// 校验原则：标准是评审的**唯一依据**，它坏了不能静默降级成「没有标准」—— 文件缺失、
// 内容为空、没有兜底、兜底不在最后，一律抛错，让这次运行失败并说清原因。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "review-standard");
const CATCH_ALL = "**/*";
// 单段正文上限。标准文本会进每次评审的固定 prompt，长一截就贵一截；超了说明堆了例子，该拆。
const MAX_SEGMENT_BYTES = 64 * 1024;

// 段定义与命中顺序的**唯一来源**（manifest.json）。顺序即优先级。
// 缓存按目录分开：生产只用 DIR 一份；测试用 dir 注入一份临时标准（这样「标准坏了要炸」
// 这类用例可以在临时目录里造坏数据，而不是去改仓库里真实的 manifest）。
const cache = new Map();

function fail(msg) {
  // 前缀固定：调用方（code-review.mjs）会把它当成运行失败原因展示给人
  throw new Error(`评审标准不可用：${msg}`);
}

function readIfExists(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

// —— 加载 + 全量校验 + 编译。任何一处不合法都抛错（不返回「半个标准」）。——
// dir 一般不用传（生产固定用模块自带的 review-standard/）；测试用它造「坏标准」的用例。
export function loadStandard({ reload = false, dir = DIR } = {}) {
  const key = path.resolve(dir);
  if (!reload) {
    const hit = cache.get(key);
    if (hit) return hit;
  }

  const manifestRaw = readIfExists(path.join(key, "manifest.json"));
  if (manifestRaw == null) fail(`找不到 ${path.join(key, "manifest.json")}`);
  let manifest;
  try { manifest = JSON.parse(manifestRaw); } catch (e) { fail(`manifest.json 不是合法 JSON：${e.message}`); }
  if (!manifest || typeof manifest !== "object") fail("manifest.json 内容不是对象");
  const segDefs = manifest.segments;
  const ruleDefs = manifest.rules;
  if (!segDefs || typeof segDefs !== "object") fail("manifest.json 缺少 segments");
  if (!Array.isArray(ruleDefs) || !ruleDefs.length) fail("manifest.json 缺少 rules");

  // 1) 段文件必须存在、非空，且带自己的**标识串**（防「改了 manifest 指错文件」这种静默错配）
  const segments = [];
  const segText = {};
  for (const [id, def] of Object.entries(segDefs)) {
    const file = def && typeof def.file === "string" ? def.file : "";
    if (!file || !/^[a-z0-9_-]+\.md$/.test(file)) fail(`段 ${id} 的 file 名不合法（应为小写字母数字的 .md）`);
    const text = readIfExists(path.join(key, file));
    if (text == null) fail(`段 ${id} 的文件不存在：${file}`);
    const body = text.replace(/\r\n/g, "\n").trim();
    if (!body) fail(`段 ${id} 的文件是空的：${file}（空规则会被引擎静默忽略，等于这段没生效）`);
    if (body.length > MAX_SEGMENT_BYTES) fail(`段 ${id} 超过 ${MAX_SEGMENT_BYTES} 字节（${body.length}）：标准会进每次评审的 prompt，请精简`);
    const marker = typeof def.marker === "string" ? def.marker : "";
    if (!marker || !body.includes(marker)) fail(`段 ${id} 的正文里找不到标识串「${marker}」（manifest 与 ${file} 对不上）`);
    segText[id] = body;
    segments.push({ id, title: String(def.title || id), file, marker, bytes: Buffer.byteLength(body, "utf8"), text: body });
  }

  // 2) 命中顺序：每条都得指向存在的段；**/* 必须存在且必须是最后一条
  const seenPaths = new Set();
  const rules = [];
  ruleDefs.forEach((rd, i) => {
    const p = rd && typeof rd.path === "string" ? rd.path.trim() : "";
    const seg = rd && typeof rd.segment === "string" ? rd.segment : "";
    if (!p) fail(`rules[${i}] 缺少 path`);
    if (!segText[seg]) fail(`rules[${i}]（${p}）指向不存在的段「${seg}」`);
    if (seenPaths.has(p)) fail(`rules 里 pattern 重复：${p}`);
    seenPaths.add(p);
    if (rd.pattern) fail(`rules[${i}] 写成了 pattern，字段名应为 path`);
    rules.push({ path: p, segment: seg });
  });
  const last = rules[rules.length - 1];
  if (last.path !== CATCH_ALL) fail(`最后一条 pattern 必须是 ${CATCH_ALL}（兜底），当前是「${last.path}」—— 没有兜底时未列出的文件就拿不到本标准`);
  if (rules.filter((r) => r.path === CATCH_ALL).length !== 1) fail(`${CATCH_ALL} 只能出现一次`);
  if (rules.length < 2) fail("至少需要「一条具体类型 + 一条兜底」");

  // 3) 编译：每条的正文 = 通用段 + 本段（自包含）。并硬校验「通用段出现在每一条里」——
  //    这正是「所有评审都是一个标准」的机器可验证形式。
  const commonMarker = String((segDefs.common || {}).marker || "");
  if (!commonMarker) fail("manifest.json 里必须定义 common 段（统一标准的落点）");
  const compiled = rules.map((r) => {
    const rule = `${segText.common}\n\n${segText[r.segment]}\n`;
    if (!rule.includes(commonMarker)) fail(`编译出的 ${r.path} 缺少通用段（统一性校验失败）`);
    return { path: r.path, rule, merge_system_rule: true };
  });

  // 4) 版本号：编译产物的 sha256 前 12 位。改一个字符就变 —— 运行记录靠它归因口径变化。
  const canonical = JSON.stringify({ v: manifest.version || 1, rules: compiled });
  const version = crypto.createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 12);
  const bytes = compiled.reduce((n, r) => n + Buffer.byteLength(r.rule, "utf8"), 0);

  cache.set(key, {
    version,
    versionFull: crypto.createHash("sha256").update(canonical, "utf8").digest("hex"),
    segments,
    rules,
    compiled,
    bytes,
    /** 写 --rule 文件用：与哈希同源的确定性序列化（键序固定、LF 结尾） */
    ruleFileJson: JSON.stringify({ rules: compiled }, null, 2) + "\n",
  });
  return cache.get(key);
}

/** 供日志/展示用：标准版本号（12 位 hex）。 */
export function standardVersion() {
  return loadStandard().version;
}

function contentHash(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

// 原子写：先写同目录临时文件再 rename —— 并发读到的永远是完整文件（不会读到写了一半的 JSON）。
function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

// 陈旧输入文件只在**超过 1 小时**后才清理：部署那一刻标准版本号会变，而当时正在跑的
// 评审还持有旧版本文件的路径，立刻删会让那次运行以「找不到规则文件」失败。
const PRUNE_MIN_AGE_MS = 60 * 60 * 1000;

function pruneInputs(dir, keep) {
  const cutoff = Date.now() - PRUNE_MIN_AGE_MS;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (keep.has(name)) continue;
      if (!/^(standard-v[0-9a-f]{12}\.json|background-[0-9a-f]{12}\.md)(\.\d+\.tmp)?$/.test(name)) continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).mtimeMs > cutoff) continue;   // 可能仍被正在运行的任务使用
      fs.unlinkSync(p);
    }
  } catch { /* 清理是尽力而为，失败不影响本次运行 */ }
}

/**
 * 落盘本次评审要交给引擎的两个输入文件，返回绝对路径（路径由我们生成，用户输入不进 argv）：
 *   · `--rule`：编译好的统一标准，文件名带标准版本 hash（内容寻址，同名即同内容）
 *   · `--background-file`：业务背景（全局 + 本仓库两段拼接），文件名带内容 hash
 * dir 由调用方给出，必须是工作区内的目录（<workspace>/inputs）：
 *   · 不能放仓库 clone 里 —— 会污染 git 工作树，甚至被下一次评审当成新增文件
 *   · 不能放 ocr-home —— ocrConfigMode:"host" 时那是运维真实的 ~
 * 返回 standardVersion：调用方把它写进运行记录，用于「这次用的是哪版标准」。
 */
export function writeReviewInputs(dir, { background = "" } = {}) {
  const std = loadStandard();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ruleName = `standard-v${std.version}.json`;   // std.version 本身就是编译产物的 hash
  const rulePath = atomicWrite(path.join(dir, ruleName), std.ruleFileJson);

  let backgroundPath = null;
  const bg = String(background || "").trim();
  if (bg) {
    const text = bg.endsWith("\n") ? bg : `${bg}\n`;
    backgroundPath = atomicWrite(path.join(dir, `background-${contentHash(text)}.md`), text);
  }
  const keep = new Set([ruleName]);
  if (backgroundPath) keep.add(path.basename(backgroundPath));
  pruneInputs(dir, keep);
  return { rulePath, backgroundPath, standardVersion: std.version };
}

/** 设置页只读展示用：不吐内部字段，只给元信息 + 每段正文。 */
export function standardView() {
  const std = loadStandard();
  return {
    version: std.version,
    versionFull: std.versionFull,
    bytes: std.bytes,
    segments: std.segments.map((s) => ({ id: s.id, title: s.title, file: s.file, bytes: s.bytes, text: s.text })),
    rules: std.rules.map((r) => ({ path: r.path, segment: r.segment, mergeSystemRule: true })),
  };
}
