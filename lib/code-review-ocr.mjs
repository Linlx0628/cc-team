// lib/code-review-ocr.mjs —— 代码评审引擎（open-code-review CLI）适配层。
//
// 这是整个「代码评审」功能里唯一的**安全边界**：外部的仓库配置、分支名、提交号会
// 变成子进程的参数与环境变量。因此本文件独立成模块，规则集中且可被单测整体覆盖：
//
//   1. 一律 execFile(argv 数组)，**绝不拼接 shell 字符串** —— 参数不会被 shell 解释
//   2. 进程环境用 allowlist **重建**，绝不 {...process.env} —— 否则 OCR 可能从环境里
//      捡到 ANTHROPIC_API_KEY / OPENAI_API_KEY 等，绕开我们指定的 provider 直连上游，
//      导致计费与审计双失守
//   3. HOME 指向工作区内的隔离目录：provider 配置写在那里，宿主机 ~/.opencodereview
//      的全局配置分毫不动（2026-09-19 实测：隔离成立）
//   4. 输出文件三重校验：路径必须落在工作区内、不是符号链接、大小有上限
//
// 实测得到的两条硬事实（见 wiki/deploy.md「代码评审功能的系统依赖」）：
//   · 自定义 provider 的 url 是 **API base**，protocol=anthropic 时 OCR 会 POST
//     到 `<url>/messages` → 我们的 providerUrl 写 http://127.0.0.1:<port>/v1
//   · 失败时也会写出完整 JSON（status:"failed" + summary token 统计），退出码 1；
//     所以是否成功以 JSON 里的 status 为准，退出码只作参考
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const EXEC_MAX_BUFFER = 8 * 1024 * 1024;   // stderr 可能很吵;输出正文走 --output 文件,不占这个额度
const REPORT_MAX_BYTES = 32 * 1024 * 1024;
const KNOWN_STATUS = new Set(["success", "completed_with_warnings", "completed_with_errors", "skipped", "failed"]);

// 环境 allowlist。注意这里**只列允许项**——新增变量必须显式加进来。
function buildEnv({ homeDir, tmpDir, token, sshKeyPath }) {
  const env = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: homeDir,
    TMPDIR: tmpDir,
    LANG: process.env.LANG || "en_US.UTF-8",
    NODE_ENV: "production",
    NO_COLOR: "1",
    // git:禁止任何交互式提示(凭证/主机指纹),否则子进程会挂在等输入上直到超时
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/true",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(homeDir, ".gitconfig"),
  };
  if (token) env.CR_GIT_TOKEN = token;   // 凭据只经环境变量传给 credential helper,不进 argv
  if (sshKeyPath) {
    env.GIT_SSH_COMMAND = `ssh -i ${sshKeyPath} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
  }
  return env;
}

function run(bin, args, { cwd, env, timeoutMs, onSpawn }) {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { cwd, env, timeout: timeoutMs, maxBuffer: EXEC_MAX_BUFFER, killSignal: "SIGTERM" }, (err, stdout, stderr) => {
      const timedOut = !!err && (err.killed || err.signal === "SIGTERM");
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        timedOut,
        error: err ? (timedOut ? "timeout" : err.message) : null,
      });
    });
    // 交给调用方登记(取消/超时兜底需要能 kill 这个句柄)
    if (onSpawn) { try { onSpawn(child); } catch { /* 登记失败不影响运行 */ } }
  });
}

export function createCodeReviewOcr(d) {
  const { config, ocrHomeDir, workspaceDir, repoDir, log = console.log } = d;

  function cfg() { return config.codeReview || {}; }
  function binPath() { return cfg().ocrPath || "ocr"; }

  // 探测:ocr / git 是否就绪。git 版本要求 2.41+(OCR 文档的前置条件)。
  async function probe() {
    const out = { installed: false, version: "", git: "", gitOk: false };
    const env = buildEnv({ homeDir: ocrHomeDir(), tmpDir: ocrHomeDir() });
    const v = await run(binPath(), ["version"], { env, timeoutMs: 15000 });
    if (v.code === 0 && /open-code-review/i.test(v.stdout + v.stderr)) {
      out.installed = true;
      out.version = (v.stdout + v.stderr).split("\n")[0].trim();
    }
    const g = await run("git", ["--version"], { env, timeoutMs: 10000 });
    if (g.code === 0) {
      out.git = (g.stdout || "").trim();
      const m = out.git.match(/(\d+)\.(\d+)/);
      out.gitOk = !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 41));
    }
    return out;
  }

  // 把 provider 配置写进隔离 HOME(幂等,每次运行前调用即可保持与 config 同步)。
  // 不写 url 之外的任何东西;api_key 就是评审专用虚拟 Key。
  function ensureProviderConfig() {
    const c = cfg();
    const dir = path.join(ocrHomeDir(), ".opencodereview");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "config.json");
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* 首次或损坏 → 重建 */ }
    const next = {
      ...existing,
      provider: c.providerName,
      custom_providers: {
        ...(existing.custom_providers || {}),
        [c.providerName]: {
          url: c.providerUrl,
          protocol: c.providerProtocol,
          model: c.providerModel,
          api_key: c.providerKey,
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
    return file;
  }

  // git 只认 safe.directory 里的仓库(bind mount / 容器里 owner 不匹配会报 dubious ownership)。
  // 按**精确路径**逐个写,不用通配 `*` —— 那是把安全边界放开。
  function ensureGitConfig(repoPaths) {
    const file = path.join(ocrHomeDir(), ".gitconfig");
    const lines = ["[safe]", ...repoPaths.map((p) => `\tdirectory = ${p}`)];
    fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
    return file;
  }

  // 构造 ocr review 的 argv。位置参数一律在 `--` 之后或干脆没有(全部走选项),
  // 且所有取值都已通过 code-review.mjs 的白名单校验。
  function buildReviewArgs({ dir, mode, from, to, outPath, repo }) {
    const c = cfg();
    const ov = repo.overrides || {};
    const timeoutMinutes = ov.timeoutMinutes || c.defaultTimeoutMinutes;
    const exclude = (ov.exclude || c.exclude || []).filter(Boolean);
    const background = ov.background != null ? ov.background : c.background;
    const args = [
      "review",
      "--repo", dir,
      ...(mode === "single" ? ["--commit", to] : ["--from", from, "--to", to]),
      "--format", "json",
      "--output", outPath,
      "--audience", "agent",
      "--provider", c.providerName,
      "--model", c.providerModel,
      "--timeout", String(timeoutMinutes),
      "--concurrency", String(c.defaultConcurrency),
    ];
    if (background) args.push("--background", String(background).slice(0, 2000));
    if (exclude.length) args.push("--exclude", exclude.join(","));   // 实测:逗号分隔的单值
    if (c.defaultMaxTokensBudget > 0) args.push("--max-tokens-budget", String(c.defaultMaxTokensBudget));
    return args;
  }

  // 输出文件的读取与校验。任何不对劲都抛错,由调用方记为 failed。
  function readReport(outPath) {
    const resolved = path.resolve(outPath);
    const ws = path.resolve(workspaceDir());
    if (!resolved.startsWith(ws + path.sep)) throw new Error("评审输出路径越出工作区");
    const st = fs.lstatSync(resolved);
    if (st.isSymbolicLink()) throw new Error("评审输出是符号链接,拒绝读取");
    if (st.size > REPORT_MAX_BYTES) throw new Error(`评审输出超过上限(${st.size} 字节)`);
    const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
    return {
      raw,
      status: KNOWN_STATUS.has(raw.status) ? raw.status : "completed_with_errors",
      summary: raw.summary && typeof raw.summary === "object" ? raw.summary : {},
      comments: Array.isArray(raw.comments) ? raw.comments : [],
      warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
      llm: raw.llm && typeof raw.llm === "object" ? raw.llm : {},
      sessionId: typeof raw.session_id === "string" ? raw.session_id : null,
      message: typeof raw.message === "string" ? raw.message : null,
    };
  }

  async function runReview({ dir, args, repo, token, sshKeyPath, timeoutMs, onSpawn }) {
    ensureProviderConfig();
    ensureGitConfig([dir]);
    const env = buildEnv({ homeDir: ocrHomeDir(), tmpDir: path.join(workspaceDir(), "tmp"), token, sshKeyPath });
    fs.mkdirSync(env.TMPDIR, { recursive: true, mode: 0o700 });
    const started = Date.now();
    const r = await run(binPath(), args, { cwd: dir, env, timeoutMs, onSpawn });
    if (r.timedOut) log(`[代码评审] ocr 超时被终止(${Math.round((Date.now() - started) / 1000)}s)`);
    return r;
  }

  // git 调用(clone/fetch/ls-remote 用)。argv 固定 + `--` 分隔位置参数。
  async function git(args, { cwd, timeoutMs = 120000, token, sshKeyPath } = {}) {
    const env = buildEnv({ homeDir: ocrHomeDir(), tmpDir: path.join(workspaceDir(), "tmp"), token, sshKeyPath });
    return run("git", args, { cwd, env, timeoutMs });
  }

  return { probe, ensureProviderConfig, ensureGitConfig, buildReviewArgs, readReport, runReview, git, buildEnv, binPath };
}
