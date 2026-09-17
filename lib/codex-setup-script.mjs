// lib/codex-setup-script.mjs —— Codex 一键接入: 模型目录与 bash/PowerShell 配置脚本构建。
// 从 server.mjs 抽出(零缩进逐字搬移, 模板字面量对空白敏感)。

// Codex 模型目录完全由方案配置生成：成员可访问的 Responses 方案的
// modelAliases + peakModelAliases 别名键（配置顺序）；只有当方案完全没配别名时
// 才回退到 allowedModels。不额外添加任何真实模型名。
// context_window 与多模态按别名取方案设置（modelContextWindows/modelMultimodal，
// 未配置时默认 128000、支持图片输入）。
function codexCatalogEntryJson(slug, target, priority, contextWindow, multimodal) {
  const cw = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 128000;
  const modalities = multimodal === false ? ["text"] : ["text", "image"];
  return `    {
      "slug": ${JSON.stringify(slug)},
      "display_name": ${JSON.stringify(slug)},
      "description": "CC-Team alias -> ${target}",
      "default_reasoning_level": "high",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "Light reasoning" },
        { "effort": "medium", "description": "Balanced reasoning" },
        { "effort": "high", "description": "Enhanced reasoning" }
      ],
      "shell_type": "shell_command",
      "visibility": "list",
      "supported_in_api": true,
      "priority": ${priority},
      "base_instructions": "",
      "supports_reasoning_summaries": true,
      "default_reasoning_summary": "none",
      "support_verbosity": false,
      "apply_patch_tool_type": "freeform",
      "truncation_policy": { "mode": "bytes", "limit": 10000 },
      "context_window": ${cw},
      "max_context_window": ${cw},
      "effective_context_window_percent": 95,
      "supports_parallel_tool_calls": true,
      "experimental_supported_tools": [],
      "input_modalities": ${JSON.stringify(modalities)}
    }`;
}

// Returns { entries: [{slug,target,contextWindow,multimodal}], json, defaultModel } for one member key.
export function buildCodexModelCatalog(d, apiKey) {
  const { config, canUseProfile, runtimes } = d;
  const entries = [];
  const seen = new Set();
  const add = (slug, target, contextWindow, multimodal) => {
    slug = String(slug || "").trim();
    if (!slug || slug === "*" || seen.has(slug)) return;
    seen.add(slug);
    entries.push({ slug, target: String(target || "").trim(), contextWindow: contextWindow || 128000, multimodal: multimodal !== false });
  };
  let fallbackRuntime = null;
  for (const runtime of Object.values(runtimes)) {
    if (runtime.protocol !== "responses") continue;
    if (!canUseProfile(apiKey, runtime).allowed) continue;
    const profileCfg = config.profiles[runtime.profileName] || {};
    const aliases = { ...(runtime.modelAliases || {}), ...(runtime.peakModelAliases || {}) };
    const aliasKeys = Object.keys(aliases);
    for (const alias of aliasKeys) {
      // 准入恒开：所有别名在 Codex 里都允许上传图片（input_modalities 含
      // image）。多模态勾选只决定网关侧是「直通」还是「自动转述」，见
      // bridgeImagesInRequest，不影响目录。
      add(alias, aliases[alias],
        profileCfg.modelContextWindows?.[alias] || profileCfg.contextWindow || 128000,
        true);
    }
    if (aliasKeys.length === 0 && !fallbackRuntime) fallbackRuntime = runtime;
  }
  if (entries.length === 0 && fallbackRuntime) {
    const profile = config.profiles[fallbackRuntime.profileName] || {};
    const cw = profile.contextWindow || 128000;
    for (const m of profile.allowedModels || []) add(m, m, cw);
  }
  const json = entries.length
    ? "{\n  \"models\": [\n" + entries.map((e, i) => codexCatalogEntryJson(e.slug, e.target, i, e.contextWindow, e.multimodal)).join(",\n") + "\n  ]\n}"
    : "{\n  \"models\": []\n}";
  return { entries, json, defaultModel: entries.length ? entries[0].slug : "" };
}

// The ccteam provider block Codex needs, with the member's key and the gateway
// address baked in. Shared by the install script and the manual/cc-switch tabs.
function codexProviderToml(host, key, proto) {
  return `[model_providers.ccteam]
name = "CC Team Gateway"
base_url = "${proto || "http"}://${host}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
experimental_bearer_token = "${key}"`;
}

function codexTopKeysToml(defaultModel, baseUrl) {
  // openai_base_url 是 Codex 内置通道的地址:remote compact(会话压缩)走私有 WS 协议且
  // 只认这条通道 —— 网关已支持该 WS 通道,所以把它一并指向网关,压缩任务的 token 也进
  // 网关的配额与统计(凭据由 auth.json 提供,安装器会同步写成虚拟 Key)。
  return `model_provider = "ccteam"
${defaultModel ? `model = "${defaultModel}"
` : ""}model_catalog_json = "~/.codex/models.json"
openai_base_url = "${baseUrl}"`;
}

// POSIX sh installer for `curl … | sh`. Idempotent: only manages the ccteam
// provider block and its top-level keys; every other section (projects, plugins,
// other providers) passes through untouched. Backs up config.toml first.
export function buildCodexSetupScript(key, host, username, catalogJson, defaultModel, proto) {
  const scheme = proto || "http";
  const provBlock = codexProviderToml(host, key, scheme);
  const topKeys = codexTopKeysToml(defaultModel, `${scheme}://${host}/v1`);
  return `#!/bin/sh
# CC-Team Codex 一键接入 — 成员: ${username}
# 幂等脚本：可重复执行；只管理 ccteam 相关配置，不影响其他 provider
set -e
CODEX_DIR="\${CODEX_HOME:-\$HOME/.codex}"
mkdir -p "\$CODEX_DIR"
CONFIG="\$CODEX_DIR/config.toml"
MODELS="\$CODEX_DIR/models.json"
TS="\$(date +%Y%m%d%H%M%S)"
CONFIG_BAK=""
MODELS_BAK=""
if [ -f "\$CONFIG" ]; then
  CONFIG_BAK="\$CONFIG.backup-ccteam-\$TS"
  cp "\$CONFIG" "\$CONFIG_BAK"
  echo "已备份原配置 → config.toml.backup-ccteam-\$TS"
fi

echo "[1/3] 写入模型目录 \$CODEX_DIR/models.json ..."
if [ -f "\$MODELS" ]; then
  MODELS_BAK="\$MODELS.backup-ccteam-\$TS"
  cp "\$MODELS" "\$MODELS_BAK"
  echo "已备份原模型目录 → models.json.backup-ccteam-\$TS"
fi
cat > "\$MODELS" <<'CC_MODELS_EOF'
${catalogJson}
CC_MODELS_EOF

echo "[2/3] 更新 \$CODEX_DIR/config.toml ..."
TOP_BLOCK='${topKeys}'
PROV_BLOCK='${provBlock}'
rollback() {
  echo "[提示] 配置更新失败，正在恢复原始文件 ..."
  if [ -n "\$CONFIG_BAK" ] && [ -f "\$CONFIG_BAK" ]; then cp "\$CONFIG_BAK" "\$CONFIG"; fi
  if [ -n "\$MODELS_BAK" ] && [ -f "\$MODELS_BAK" ]; then cp "\$MODELS_BAK" "\$MODELS"; fi
  if [ -n "\$AUTH_BAK" ] && [ -f "\$AUTH_BAK" ]; then cp "\$AUTH_BAK" "\$CODEX_DIR/auth.json"; fi
  echo "[提示] 已恢复原始内容，你的数据未受影响。请把以下输出发给管理员排查。"
  exit 1
}
if [ -f "\$CONFIG" ]; then
  # BSD awk (macOS) rejects literal newlines in -v values, so the blocks are
  # passed through the environment instead. 顶层 openai_base_url 属于本脚本管理的键:
  # 网关已支持 Codex remote compact 的私有 WS 通道,这条内置通道地址必须指向网关
  # (凭据由 auth.json 的虚拟 Key 提供,下面同步),压缩任务才会走网关记账。
  TOP_BLOCK="\$TOP_BLOCK" PROV_BLOCK="\$PROV_BLOCK" awk '
    BEGIN { top_block = ENVIRON["TOP_BLOCK"]; prov_block = ENVIRON["PROV_BLOCK"]; in_top=1; printed=0; skip=0 }
    /^\\[model_providers\\.ccteam\\]$/ { skip=1; next }
    skip && /^\\[/ { skip=0 }
    skip { next }
    !printed && /^\\[/ { print top_block; print ""; printed=1 }
    /^\\[/ { in_top=0 }
    in_top && /^(model_provider|model|model_catalog_json|openai_base_url)[[:space:]]*=/ { next }
    { print }
    END {
      if (!printed) { print top_block; print "" }
      print ""
      print prov_block
    }
  ' "\$CONFIG" > "\$CONFIG.tmp" || rollback
  # Sanity-check the rewritten file before replacing the original: non-empty
  # and carrying the new provider block. Otherwise restore from this run's backup.
  if [ -s "\$CONFIG.tmp" ] && grep -q "model_providers\\.ccteam" "\$CONFIG.tmp"; then
    mv "\$CONFIG.tmp" "\$CONFIG"
  else
    rm -f "\$CONFIG.tmp"
    rollback
  fi
else
  printf '%s\\\\n\\\\n%s\\\\n' "\$TOP_BLOCK" "\$PROV_BLOCK" > "\$CONFIG" || rollback
fi

# 内置通道(remote compact)的凭据:auth.json 的 OPENAI_API_KEY 必须是本网关虚拟 Key。
# 已是则不动(幂等);否则整文件重写为 apikey 模式 —— 原内容(含 ChatGPT 登录态)先备份,
# 备份文件复制回原名即可恢复。
AUTH="\$CODEX_DIR/auth.json"
AUTH_BAK=""
AUTH_ACTION="created"
if [ -f "\$AUTH" ]; then
  if grep -q '"${key}"' "\$AUTH" 2>/dev/null; then
    AUTH_ACTION="kept"
  else
    AUTH_BAK="\$AUTH.backup-ccteam-\$TS"
    cp "\$AUTH" "\$AUTH_BAK" || rollback
    printf '{\\n  "OPENAI_API_KEY": "${key}",\\n  "auth_mode": "apikey"\\n}\\n' > "\$AUTH" || rollback
    AUTH_ACTION="replaced"
  fi
else
  printf '{\\n  "OPENAI_API_KEY": "${key}",\\n  "auth_mode": "apikey"\\n}\\n' > "\$AUTH" || rollback
fi

echo "[3/3] 检查网关连通性 ..."
if command -v curl > /dev/null 2>&1 && curl -fsS -m 8 -H "Authorization: Bearer ${key}" "${scheme}://${host}/v1/models" > /dev/null 2>&1; then
  echo "[OK] 网关连通正常"
else
  echo "[提示] 连通检查未通过——请确认本机可以访问 ${scheme}://${host}（配置本身已完成）"
fi

echo ""
echo "========== 本次操作摘要 =========="
echo "1. 备份："
if [ -n "\$CONFIG_BAK" ]; then echo "   原配置   → \$CONFIG_BAK"; fi
if [ -n "\$MODELS_BAK" ]; then echo "   原模型目录 → \$MODELS_BAK"; fi
if [ -n "\$AUTH_BAK" ]; then echo "   原 auth.json → \$AUTH_BAK"; fi
if [ -z "\$CONFIG_BAK" ] && [ -z "\$MODELS_BAK" ] && [ -z "\$AUTH_BAK" ]; then echo "   （首次安装，无需备份）"; fi
echo "2. 写入 \$MODELS"
echo "   内容：方案配置的模型别名目录${defaultModel ? `（默认模型 ${defaultModel}）` : ""}"
echo "3. 更新 \$CONFIG"
echo "   只改了 model_provider / model / model_catalog_json / openai_base_url 四行顶层键，"
echo "   并在末尾追加 [model_providers.ccteam] 一段；你的其他配置未动。"
echo "   顶层 openai_base_url 已指向本网关 —— Codex 内置通道与 remote compact(会话压缩)"
echo "   由此走网关(网关已支持其 WS 协议),压缩的 token 也进配额与统计。"
if [ "\$AUTH_ACTION" = "replaced" ]; then
  echo "   另:auth.json 的 OPENAI_API_KEY 已写为本网关虚拟 Key(原内容备份在 \$AUTH_BAK,"
  echo "   复制回原名即可恢复 ChatGPT 登录态)。"
elif [ "\$AUTH_ACTION" = "created" ]; then
  echo "   另:创建了 auth.json(内置通道凭据=本网关虚拟 Key)。"
fi
echo "----------------------------------"
echo "下一步：完全退出 Codex（macOS: Cmd+Q）后重新打开即可使用。"
echo "如需恢复原配置：把对应 .backup-ccteam-$TS 文件复制回原名即可"
echo "（例如 cp \"\$CONFIG.backup-ccteam-$TS\" \"\$CONFIG\"）。"
${defaultModel ? `echo "默认模型 ${defaultModel}；模型选择器中可切换方案配置的其他别名。"\n` : ""}`;
}

// Windows (PowerShell 5.1+) twin of the sh installer: same backup / rewrite /
// validate-rollback / summary behavior. Differences: %USERPROFILE%\.codex home,
// model_catalog_json written as an absolute forward-slash path (tilde is not
// reliably expanded by Codex on Windows), and BOM-less UTF-8 writes via .NET so
// models.json stays parseable.
export function buildCodexSetupScriptWin(key, host, username, catalogJson, defaultModel, proto) {
  const scheme = proto || "http";
  const provBlock = codexProviderToml(host, key, scheme);
  return `$ErrorActionPreference = "Stop"
# CC-Team Codex 一键接入 (Windows) — 成员: ${username}
# 幂等脚本：可重复执行；只管理 ccteam 相关配置，不影响其他 provider
$codex = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
New-Item -ItemType Directory -Force -Path $codex | Out-Null
$configPath = Join-Path $codex "config.toml"
$modelsPath = Join-Path $codex "models.json"
$ts = Get-Date -Format "yyyyMMddHHmmss"
$configBak = $null
$modelsBak = $null
if (Test-Path $configPath) {
  $configBak = "$configPath.backup-ccteam-$ts"
  Copy-Item $configPath $configBak
  Write-Host "已备份原配置 → config.toml.backup-ccteam-$ts"
}

Write-Host "[1/3] 写入模型目录 $modelsPath ..."
if (Test-Path $modelsPath) {
  $modelsBak = "$modelsPath.backup-ccteam-$ts"
  Copy-Item $modelsPath $modelsBak
  Write-Host "已备份原模型目录 → models.json.backup-ccteam-$ts"
}
$catalog = @'
${catalogJson}
'@
[System.IO.File]::WriteAllText($modelsPath, $catalog)

Write-Host "[2/3] 更新 $configPath ..."
$topBlock = @'
${codexTopKeysToml(defaultModel, `${scheme}://${host}/v1`)}
'@
$provBlock = @'
${provBlock}
'@
$modelsRef = $modelsPath -replace '\\\\', '/'
$topBlock = $topBlock -replace '~/.codex/models.json', $modelsRef
function Rollback {
  Write-Host "[提示] 配置更新失败，正在恢复原始文件 ..."
  if ($configBak -and (Test-Path $configBak)) { Copy-Item $configBak $configPath -Force }
  if ($modelsBak -and (Test-Path $modelsBak)) { Copy-Item $modelsBak $modelsPath -Force }
  if ($authBak -and (Test-Path $authBak)) { Copy-Item $authBak $authPath -Force }
  Write-Host "[提示] 已恢复原始内容，你的数据未受影响。请把以上输出发给管理员排查。"
  exit 1
}
if (Test-Path $configPath) {
  $lines = [System.IO.File]::ReadAllLines($configPath)
  $out = New-Object System.Collections.Generic.List[string]
  $inTop = $true; $printed = $false; $skip = $false
  foreach ($line in $lines) {
    if ($line -match '^\\[model_providers\\.ccteam\\]\\s*$') { $skip = $true; continue }
    if ($skip -and $line -match '^\\[') { $skip = $false }
    if ($skip) { continue }
    if (-not $printed -and $line -match '^\\[') { $out.Add($topBlock); $out.Add(""); $printed = $true }
    if ($line -match '^\\[') { $inTop = $false }
    # openai_base_url 与 sh 版同属本脚本管理的顶层键:网关已支持 remote compact 的
    # WS 通道,内置通道地址统一指向网关(压缩 token 也进配额统计)。
    if ($inTop -and $line -match '^(model_provider|model|model_catalog_json|openai_base_url)\\s*=') { continue }
    $out.Add($line)
  }
  if (-not $printed) { $out.Add($topBlock); $out.Add("") }
  $out.Add(""); $out.Add($provBlock)
  $nl = [string][char]13 + [char]10
  $new = ($out -join $nl) + $nl
  if ($new.Length -gt 0 -and $new.Contains("[model_providers.ccteam]")) {
    [System.IO.File]::WriteAllText($configPath, $new)
  } else { Rollback }
} else {
  $nl = [string][char]13 + [char]10
  [System.IO.File]::WriteAllText($configPath, $topBlock + $nl + $nl + $provBlock + $nl)
}

# 内置通道(remote compact)的凭据:auth.json 的 OPENAI_API_KEY 必须是本网关虚拟 Key。
# 已是则不动(幂等);否则整文件重写为 apikey 模式 —— 原内容(含 ChatGPT 登录态)先备份。
$authPath = Join-Path $codex "auth.json"
$authBak = $null
$authAction = "created"
$authJson = '{' + [string][char]13 + [char]10 + '  "OPENAI_API_KEY": "${key}",' + [string][char]13 + [char]10 + '  "auth_mode": "apikey"' + [string][char]13 + [char]10 + '}'
if (Test-Path $authPath) {
  if ((Get-Content $authPath -Raw).Contains('"${key}"')) {
    $authAction = "kept"
  } else {
    $authBak = "$authPath.backup-ccteam-$ts"
    Copy-Item $authPath $authBak
    [System.IO.File]::WriteAllText($authPath, $authJson)
    $authAction = "replaced"
  }
} else {
  [System.IO.File]::WriteAllText($authPath, $authJson)
}

Write-Host "[3/3] 检查网关连通性 ..."
try {
  $null = Invoke-WebRequest -UseBasicParsing -Uri "${scheme}://${host}/v1/models" -Headers @{ Authorization = "Bearer ${key}" } -TimeoutSec 8
  Write-Host "[OK] 网关连通正常"
} catch {
  Write-Host "[提示] 连通检查未通过——请确认本机可以访问 ${scheme}://${host}（配置本身已完成）"
}

Write-Host ""
Write-Host "========== 本次操作摘要 =========="
Write-Host "1. 备份："
if ($configBak) { Write-Host "   原配置   → $configBak" }
if ($modelsBak) { Write-Host "   原模型目录 → $modelsBak" }
if ($authBak) { Write-Host "   原 auth.json → $authBak" }
if (-not $configBak -and -not $modelsBak -and -not $authBak) { Write-Host "   （首次安装，无需备份）" }
Write-Host "2. 写入 $modelsPath"
Write-Host "   内容：方案配置的模型别名目录${defaultModel ? `（默认模型 ${defaultModel}）` : ""}"
Write-Host "3. 更新 $configPath"
Write-Host "   只改了 model_provider / model / model_catalog_json / openai_base_url 四行顶层键，"
Write-Host "   并在末尾追加 [model_providers.ccteam] 一段；你的其他配置未动。"
Write-Host "   顶层 openai_base_url 已指向本网关 —— Codex 内置通道与 remote compact(会话压缩)"
Write-Host "   由此走网关(网关已支持其 WS 协议),压缩的 token 也进配额与统计。"
if ($authAction -eq "replaced") {
  Write-Host "   另:auth.json 的 OPENAI_API_KEY 已写为本网关虚拟 Key(原内容备份在 $authBak,"
  Write-Host "   复制回原名即可恢复 ChatGPT 登录态)。"
} elseif ($authAction -eq "created") {
  Write-Host "   另:创建了 auth.json(内置通道凭据=本网关虚拟 Key)。"
}
Write-Host "----------------------------------"
Write-Host "下一步：完全退出 Codex 后重新打开即可使用。"
Write-Host "如需恢复原配置：把对应 .backup-ccteam-$ts 文件复制回原名即可。"
${defaultModel ? `Write-Host "默认模型 ${defaultModel}；模型选择器中可切换方案配置的其他别名。"\n` : ""}`;
}
