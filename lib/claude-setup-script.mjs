// lib/claude-setup-script.mjs —— Claude Code 一键接入：把网关地址与虚拟 Key 合并进
// ~/.claude/settings.json 的 env 段。与 codex-setup-script.mjs 并列，安全故事完全一致：
// 备份 → 就地合并 → 校验 → 失败回滚，幂等可重跑。
//
// 差别只在于目标文件是 JSON 而不是 TOML：TOML 可以按行做外科手术，JSON 不行 —— 字符串里
// 出现 } 或转义引号时按行切就是切错，而且是**静默**切错（成员的 permissions / hooks 被
// 弄坏且没有任何提示）。所以这里必须借助一个真正的 JSON 解析器，见 detectJsonTool 的取舍。

// 网关地址与虚拟 Key 写进 settings.json 的样子。sh 脚本、PowerShell 脚本与页面「手动配置」
// 页共用这一份文本 —— 三处各写一份的话，改了一处另外两处就开始慢慢漂移。
export function claudeEnvJson(base, key) {
  return JSON.stringify({ env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: key } }, null, 2);
}

// 成员该用哪个入口地址（后缀部分；主机名只有浏览器/请求上下文才知道，不在这里拼）。
// 遍历形状照抄 buildCodexModelCatalog：只看本协议、且 canUseProfile 放行的方案，
// 别名取 modelAliases + peakModelAliases 的键（配置顺序）。
//
// 推荐入口的判定是**按成员算的**，不是常量：
// - 无后缀入口（/v1/messages）只服务「默认方案组 ∩ 该成员可访问」的方案（server.mjs 的
//   getAvailableDefaultProfiles 就是这么过滤的）。能用得上就用它 ——组内自动 failover。
// - 用不上就必须带自己方案的后缀，否则无后缀入口会直接 403。
// - 但**方案组成员不允许带后缀直连**（lib/proxy-core.mjs 的 group_member_restricted
//   守卫，防止绕开 failover 去钉一个贵方案），所以回退时只挑不属于任何组的方案；
//   一个都没有就退回无后缀并给一句 note，让成员知道要找管理员。
export function buildAnthropicSetupHints(d, apiKey) {
  const { config, canUseProfile, runtimes } = d;
  // 本协议的基础组与全部命名调度组的并集 —— 与 proxy-core 的守卫判定同一口径。
  const groupNames = new Set(Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup : []);
  for (const g of Object.values((config.scheduleGroups || {}).anthropic || {})) {
    if (!g || typeof g !== "object" || g.protocol !== "anthropic" || !Array.isArray(g.members)) continue;
    for (const m of g.members) if (typeof m === "string" && m) groupNames.add(m);
  }
  const aliases = [];
  const seenAlias = new Set();
  const profiles = [];
  // 该成员是否被「组入口」（无后缀地址）覆盖。判据是组归属而**不是**当前生效组：
  // 生效组会随「星期几 + 时段」的调度规则变，而接入指南给的是一个稳定地址。
  // 落在命名调度组里也算覆盖 —— 规则生效时它就是组入口服务的对象；不这么算的话
  // 会给他推荐一个带后缀的地址，而组内方案的后缀直连本来就被守卫拒绝。
  let coveredByGroupEntry = false;
  for (const runtime of Object.values(runtimes)) {
    if (runtime.protocol !== "anthropic") continue;
    if (!canUseProfile(apiKey, runtime).allowed) continue;
    const profileCfg = config.profiles[runtime.profileName] || {};
    const merged = { ...(runtime.modelAliases || {}), ...(runtime.peakModelAliases || {}) };
    for (const alias of Object.keys(merged)) {
      const a = String(alias || "").trim();
      if (!a || a === "*" || seenAlias.has(a)) continue;
      seenAlias.add(a);
      aliases.push(a);
    }
    const inGroup = groupNames.has(runtime.profileName);
    if (inGroup) coveredByGroupEntry = true;
    profiles.push({
      name: runtime.profileName,
      suffix: String(profileCfg.suffix || runtime.suffix || "").trim(),
      inGroup,
    });
  }
  let basePath = "";
  let note = "";
  if (profiles.length > 0 && !coveredByGroupEntry) {
    const direct = profiles.find(p => p.suffix && !p.inGroup);
    if (direct) basePath = "/" + direct.suffix;
    else note = "你的方案都在方案组里，组内方案不允许带后缀直连（防止绕开 failover）。请联系管理员把你加进默认方案组。";
  }
  return { aliases, basePath, note, profiles };
}

// POSIX sh installer for `curl … | sh`. Idempotent: only the two ANTHROPIC_* keys inside
// settings.json's env block are managed; every other key (permissions / hooks / statusLine /
// model / 其他 env 键) passes through untouched. Backs the file up first.
export function buildClaudeSetupScript(key, host, username, proto, basePath) {
  const scheme = proto || "http";
  const base = `${scheme}://${host}${basePath || ""}`;
  const envJson = claudeEnvJson(base, key);
  return `#!/bin/sh
# CC-Team Claude Code 一键接入 — 成员: ${username}
# 幂等脚本：可重复执行；只管理 env 里的 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 两个键
set -e
CLAUDE_DIR="\${CLAUDE_CONFIG_DIR:-\$HOME/.claude}"
SETTINGS="\$CLAUDE_DIR/settings.json"
TS="\$(date +%Y%m%d%H%M%S)"
URL_VALUE="${base}"
KEY_VALUE="${key}"

# settings.json 是 JSON，不是行结构：用 sed/awk 硬切，遇到字符串里含 } 或转义引号就会切错，
# 而且是**静默**切错 —— 成员的 permissions/hooks 被弄坏且没有任何提示。所以必须有一个真解析器。
# 探测顺序按「Claude Code 用户机器上的实际装机率」：node（npm 装法自带运行时）→ python3
# （macOS 12.3 起只剩 CLT 桩，没装 Xcode 命令行工具时不可用）→ jq（默认谁都不装，但装了它的
# 机器通常也没有 node）。刻意**不列裸 python**：python2 的 open(...,encoding=) 直接报错，
# 把它算作「有解析器」等于制造一次静默失败。
JSON_TOOL=""
for t in node python3 jq; do
  if command -v "\$t" > /dev/null 2>&1; then JSON_TOOL="\$t"; break; fi
done

# 合并：读原文件 → 只改 env 里的两个键 → 写出新文件，同时把原值记进报告文件供稍后提示。
json_merge() {   # json_merge <原文件> <输出文件> <报告文件>；读环境变量 CCDEV_URL / CCDEV_KEY
  case "\$JSON_TOOL" in
    node)
      CCDEV_URL="\$URL_VALUE" CCDEV_KEY="\$KEY_VALUE" node -e '
        var fs=require("fs"),src=process.argv[1],dst=process.argv[2],rep=process.argv[3];
        var txt="";try{txt=fs.readFileSync(src,"utf8")}catch(e){}
        var d=txt.trim()?JSON.parse(txt):{};
        if(typeof d!=="object"||d===null||Array.isArray(d))throw new Error("settings.json 顶层不是对象");
        var env=(d.env&&typeof d.env==="object"&&!Array.isArray(d.env))?d.env:{};
        fs.writeFileSync(rep,"PREV_BASE_URL="+(env.ANTHROPIC_BASE_URL||"")+"\\nPREV_KEY="+(env.ANTHROPIC_AUTH_TOKEN||env.ANTHROPIC_API_KEY||""));
        env.ANTHROPIC_BASE_URL=process.env.CCDEV_URL;
        env.ANTHROPIC_AUTH_TOKEN=process.env.CCDEV_KEY;
        d.env=env;
        fs.writeFileSync(dst,JSON.stringify(d,null,2)+"\\n");
      ' "\$1" "\$2" "\$3" ;;
    python3)
      CCDEV_URL="\$URL_VALUE" CCDEV_KEY="\$KEY_VALUE" python3 -c '
import json,os,sys
src,dst,rep=sys.argv[1],sys.argv[2],sys.argv[3]
txt=""
if os.path.exists(src):
    f=open(src,encoding="utf-8"); txt=f.read(); f.close()
d=json.loads(txt) if txt.strip() else {}
if not isinstance(d,dict): raise SystemExit("settings.json 顶层不是对象")
env=d.get("env") if isinstance(d.get("env"),dict) else {}
g=open(rep,"w",encoding="utf-8")
g.write("PREV_BASE_URL="+(env.get("ANTHROPIC_BASE_URL") or "")+"\\nPREV_KEY="+(env.get("ANTHROPIC_AUTH_TOKEN") or env.get("ANTHROPIC_API_KEY") or ""))
g.close()
env["ANTHROPIC_BASE_URL"]=os.environ["CCDEV_URL"]
env["ANTHROPIC_AUTH_TOKEN"]=os.environ["CCDEV_KEY"]
d["env"]=env
g=open(dst,"w",encoding="utf-8"); g.write(json.dumps(d,indent=2,ensure_ascii=False)+"\\n"); g.close()
' "\$1" "\$2" "\$3" ;;
    jq)
      # jq 分支不做类型纠正：.env 存在但不是对象时这里的 + 会直接报错，落到 rollback
      # （文件未动）。宁可失败也不猜成员的结构。
      jq -r '"PREV_BASE_URL=" + (.env.ANTHROPIC_BASE_URL // "") + "\\nPREV_KEY=" + (.env.ANTHROPIC_AUTH_TOKEN // .env.ANTHROPIC_API_KEY // "")' "\$1" > "\$3"
      jq --arg u "\$URL_VALUE" --arg t "\$KEY_VALUE" '.env = ((.env // {}) + {ANTHROPIC_BASE_URL:\$u, ANTHROPIC_AUTH_TOKEN:\$t})' "\$1" > "\$2" ;;
  esac
}
# 校验必须真解析一次；grep 通过不代表是合法 JSON（"ANTHROPIC_AUTH_TOKEN" 这个字符串
# 完全可能出现在一个被截断的文件里）。
json_ok() {
  case "\$JSON_TOOL" in
    node) node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "\$1" ;;
    python3) python3 -c 'import json,sys;json.load(open(sys.argv[1],encoding="utf-8"))' "\$1" ;;
    jq) jq -e . "\$1" > /dev/null ;;
    *) return 1 ;;
  esac
}

mkdir -p "\$CLAUDE_DIR"
NEED_MERGE=0
if [ -s "\$SETTINGS" ]; then NEED_MERGE=1; fi

# 能力检查放在备份之前：做不到就一个字节都别动。留一个「其实没改过」的备份只会让人困惑，
# 而写出半截 JSON 是不可逆的。
if [ "\$NEED_MERGE" = 1 ] && [ -z "\$JSON_TOOL" ]; then
  echo "[!] 本机没有 node / python3 / jq，无法安全地合并 JSON，已放弃改动。"
  echo "    settings.json 保持原样。请按页面「手动配置」把下面这段合并进它的 env 段："
  sed 's/^/    /' <<'CC_ENV_EOF'
${envJson}
CC_ENV_EOF
  exit 1
fi

SETTINGS_BAK=""
if [ "\$NEED_MERGE" = 1 ]; then
  SETTINGS_BAK="\$SETTINGS.backup-ccteam-\$TS"
  cp "\$SETTINGS" "\$SETTINGS_BAK"
  echo "已备份原配置 → settings.json.backup-ccteam-\$TS"
fi

echo "[1/3] 合并 \$SETTINGS 的 env 段 ..."
TMP="\$SETTINGS.tmp-ccteam-\$TS"
REPORT="\$SETTINGS.report-ccteam-\$TS"
rollback() {
  echo "[提示] 配置更新失败，正在恢复原始文件 ..."
  rm -f "\$TMP" "\$REPORT"
  if [ -n "\$SETTINGS_BAK" ] && [ -f "\$SETTINGS_BAK" ]; then cp "\$SETTINGS_BAK" "\$SETTINGS"; fi
  echo "[提示] 已恢复原始内容，你的数据未受影响。请把以下输出发给管理员排查。"
  exit 1
}
if [ "\$NEED_MERGE" = 1 ]; then
  json_merge "\$SETTINGS" "\$TMP" "\$REPORT" || rollback
else
  # 首次安装（文件不存在或为空）：不必解析任何东西，纯 shell 写一份即可
  cat > "\$TMP" <<'CC_ENV_EOF'
${envJson}
CC_ENV_EOF
fi
PREV_BASE_URL="\$(sed -n 's/^PREV_BASE_URL=//p' "\$REPORT" 2>/dev/null || true)"
PREV_KEY="\$(sed -n 's/^PREV_KEY=//p' "\$REPORT" 2>/dev/null || true)"

echo "[2/3] 校验结果 ..."
if [ -s "\$TMP" ] && json_ok "\$TMP" && grep -q '"ANTHROPIC_AUTH_TOKEN"' "\$TMP"; then
  mv "\$TMP" "\$SETTINGS"
  rm -f "\$REPORT"
else
  rollback
fi

# 冲突提醒：只提示，绝不擅自删成员的键 —— 那才是真正的越权。
if [ -f "\$SETTINGS" ] && grep -q '"ANTHROPIC_API_KEY"' "\$SETTINGS"; then
  echo "[提示] 你的 settings.json 里已有 ANTHROPIC_API_KEY。网关两种认证头都收"
  echo "       (Authorization: Bearer 与 x-api-key)，但两个键同时存在时 Claude Code 用哪个"
  echo "       取决于版本。建议只保留本次写入的 ANTHROPIC_AUTH_TOKEN，手动删掉 ANTHROPIC_API_KEY。"
fi
if [ -n "\$PREV_BASE_URL" ] && [ "\$PREV_BASE_URL" != "\$URL_VALUE" ]; then
  echo "[提示] 原有 ANTHROPIC_BASE_URL=\$PREV_BASE_URL 已被替换为 \$URL_VALUE（原文件已备份）"
fi
if [ -n "\$PREV_KEY" ]; then
  echo "[提示] 原有凭据 \$(printf '%s' "\$PREV_KEY" | cut -c1-6)… 已被替换（原文件已备份）"
fi
if [ -n "\$ANTHROPIC_BASE_URL" ] || [ -n "\$ANTHROPIC_AUTH_TOKEN" ] || [ -n "\$ANTHROPIC_API_KEY" ]; then
  echo "[提示] 当前 shell 里已 export 过 ANTHROPIC_* 变量。settings.json 的 env 段**优先于**"
  echo "       shell 变量，所以本次写入会生效；若你希望只用 shell 变量，请手动清空 env 段。"
fi

# 连通检查用 /api/my-usage 而不是 /v1/models：后者是 Responses 池的探测口，纯 Anthropic 成员
# 的 Key 在那里必然拿不到验证。这个接口 Bearer 鉴权、只读、不转上游、不写请求日志，
# 200 = 可达且 Key 有效。别顺手改回 /v1/models。
echo "[3/3] 检查网关连通性 ..."
if command -v curl > /dev/null 2>&1 && curl -fsS -m 8 -H "Authorization: Bearer ${key}" "${scheme}://${host}/api/my-usage" > /dev/null 2>&1; then
  echo "[OK] 网关连通正常，虚拟 Key 校验通过"
else
  echo "[提示] 连通检查未通过——请确认本机可以访问 ${scheme}://${host}，且该 Key 未被管理员禁用（配置本身已完成）"
fi

echo ""
echo "========== 本次操作摘要 =========="
echo "1. 备份："
if [ -n "\$SETTINGS_BAK" ]; then echo "   原配置 → \$SETTINGS_BAK"; else echo "   （首次安装，无需备份）"; fi
echo "2. 更新 \$SETTINGS"
echo "   只改了 env 段里的 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 两个键，"
echo "   permissions / hooks / statusLine / model 等其他内容原样保留。"
echo "   网关地址：${base}"
echo "3. 生效方式：重开一个终端（或重启 Claude Code）——已运行的会话不会重读 settings.json。"
echo "----------------------------------"
echo "如需恢复原配置：把对应的 settings.json.backup-ccteam-$TS 复制回原名即可。"
echo "（例如 cp \\"\$SETTINGS.backup-ccteam-$TS\\" \\"\$SETTINGS\\"）"`;
}

// Windows (PowerShell 5.1+) twin of the sh installer: same backup / merge / validate /
// rollback / summary behavior. Differences: %USERPROFILE%\.claude home, BOM-less UTF-8
// writes via .NET, and ConvertTo-Json -Depth 100 (see the comment at the call site).
export function buildClaudeSetupScriptWin(key, host, username, proto, basePath) {
  const scheme = proto || "http";
  const base = `${scheme}://${host}${basePath || ""}`;
  return `$ErrorActionPreference = "Stop"
# CC-Team Claude Code 一键接入 (Windows) — 成员: ${username}
# 幂等脚本：可重复执行；只管理 env 里的 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 两个键
$claude = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".claude" }
New-Item -ItemType Directory -Force -Path $claude | Out-Null
$settingsPath = Join-Path $claude "settings.json"
$ts = Get-Date -Format "yyyyMMddHHmmss"
$url = "${base}"
$key = "${key}"
$bak = $null
function Rollback {
  Write-Host "[提示] 配置更新失败，正在恢复原始文件 ..."
  if ($bak -and (Test-Path $bak)) { Copy-Item $bak $settingsPath -Force }
  Write-Host "[提示] 已恢复原始内容，你的数据未受影响。请把以上输出发给管理员排查。"
  exit 1
}
if (Test-Path $settingsPath) {
  $bak = "$settingsPath.backup-ccteam-$ts"
  Copy-Item $settingsPath $bak
  Write-Host "已备份原配置 → settings.json.backup-ccteam-$ts"
}

Write-Host "[1/3] 合并 $settingsPath 的 env 段 ..."
$tmp = "$settingsPath.tmp-ccteam-$ts"
$cfg = $null
$prevBase = ""
$prevKey = ""
try {
  if (Test-Path $settingsPath) {
    $raw = [System.IO.File]::ReadAllText($settingsPath)
    if ($raw.Trim()) { $cfg = $raw | ConvertFrom-Json }
  }
  if ($null -eq $cfg) { $cfg = [pscustomobject]@{} }
  if ($cfg -isnot [pscustomobject]) { throw "settings.json 顶层不是对象" }
  if ($cfg.PSObject.Properties.Name -contains "env") {
    $envObj = $cfg.env
    if ($envObj -isnot [pscustomobject]) { throw "settings.json 的 env 不是对象" }
    if ($envObj.PSObject.Properties.Name -contains "ANTHROPIC_BASE_URL") { $prevBase = [string]$envObj.ANTHROPIC_BASE_URL }
    if ($envObj.PSObject.Properties.Name -contains "ANTHROPIC_AUTH_TOKEN") { $prevKey = [string]$envObj.ANTHROPIC_AUTH_TOKEN }
    elseif ($envObj.PSObject.Properties.Name -contains "ANTHROPIC_API_KEY") { $prevKey = [string]$envObj.ANTHROPIC_API_KEY }
    if ($envObj.PSObject.Properties.Name -contains "ANTHROPIC_BASE_URL") { $envObj.ANTHROPIC_BASE_URL = $url }
    else { $envObj | Add-Member -NotePropertyName ANTHROPIC_BASE_URL -NotePropertyValue $url }
    if ($envObj.PSObject.Properties.Name -contains "ANTHROPIC_AUTH_TOKEN") { $envObj.ANTHROPIC_AUTH_TOKEN = $key }
    else { $envObj | Add-Member -NotePropertyName ANTHROPIC_AUTH_TOKEN -NotePropertyValue $key }
  } else {
    $envObj = [pscustomobject]@{ ANTHROPIC_BASE_URL = $url; ANTHROPIC_AUTH_TOKEN = $key }
    $cfg | Add-Member -NotePropertyName env -NotePropertyValue $envObj
  }
  # -Depth 必须显式给：PS 5.1 的 ConvertTo-Json 默认只走 2 层，成员文件里的 permissions/hooks
  # 这种嵌套结构会直接被截断成字符串，写出去等于把人家配置改坏。
  $json = $cfg | ConvertTo-Json -Depth 100
  [System.IO.File]::WriteAllText($tmp, $json + [Environment]::NewLine)
}
catch { Rollback }

Write-Host "[2/3] 校验结果 ..."
try {
  $check = [System.IO.File]::ReadAllText($tmp) | ConvertFrom-Json
  $ok = $false
  if ($check.PSObject.Properties.Name -contains "env") {
    $ce = $check.env
    if ($ce.PSObject.Properties.Name -contains "ANTHROPIC_AUTH_TOKEN" -and $ce.ANTHROPIC_AUTH_TOKEN -eq $key -and $ce.ANTHROPIC_BASE_URL -eq $url) { $ok = $true }
  }
  if (-not $ok) { throw "写入后校验失败" }
  Move-Item -Force $tmp $settingsPath
}
catch { Rollback }

# 冲突提醒：只提示，绝不擅自删成员的键。
if ([System.IO.File]::ReadAllText($settingsPath) -match '"ANTHROPIC_API_KEY"') {
  Write-Host "[提示] 你的 settings.json 里已有 ANTHROPIC_API_KEY。网关两种认证头都收"
  Write-Host "       (Authorization: Bearer 与 x-api-key)，但两个键同时存在时 Claude Code 用哪个"
  Write-Host "       取决于版本。建议只保留本次写入的 ANTHROPIC_AUTH_TOKEN，手动删掉 ANTHROPIC_API_KEY。"
}
if ($prevBase -and $prevBase -ne $url) {
  Write-Host "[提示] 原有 ANTHROPIC_BASE_URL=$prevBase 已被替换为 $url（原文件已备份）"
}
if ($prevKey) {
  Write-Host "[提示] 原有凭据已被替换（原文件已备份）"
}

Write-Host "[3/3] 检查网关连通性 ..."
try {
  $null = Invoke-WebRequest -UseBasicParsing -Uri "${scheme}://${host}/api/my-usage" -Headers @{ Authorization = "Bearer ${key}" } -TimeoutSec 8
  Write-Host "[OK] 网关连通正常，虚拟 Key 校验通过"
} catch {
  Write-Host "[提示] 连通检查未通过——请确认本机可以访问 ${scheme}://${host}，且该 Key 未被管理员禁用（配置本身已完成）"
}

Write-Host ""
Write-Host "========== 本次操作摘要 =========="
Write-Host "1. 备份："
if ($bak) { Write-Host "   原配置 → $bak" } else { Write-Host "   （首次安装，无需备份）" }
Write-Host "2. 更新 $settingsPath"
Write-Host "   只改了 env 段里的 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 两个键，"
Write-Host "   permissions / hooks / statusLine / model 等其他内容原样保留。"
Write-Host "   网关地址：${base}"
Write-Host "3. 生效方式：重开一个终端（或重启 Claude Code）——已运行的会话不会重读 settings.json。"
Write-Host "----------------------------------"
Write-Host "如需恢复原配置：把对应的 settings.json.backup-ccteam-$ts 复制回原名即可。"`;
}