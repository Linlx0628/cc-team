// public/assets/setup-guide.js —— 「配置 Claude Code」「配置 Codex」两个接入指南共用的客户端。
// 我的用量页内分区与 /setup 独立页都加载它；页面内联脚本先注入 SETUP_GUIDES 再加载本文件。
//
// 三条硬规矩，违反任何一条都是**静默**失灵（不报错，只是控件点了没反应）：
// 1. 引导块内部不出现任何 id=，一律 data-role="…"。同一页会同时存在两个引导块，
//    重复 id 会让 getElementById 拿到另一个面板的元素 —— 这正是本文件取代
//    codex-setup.js 的原因：旧实现靠「记得给 id 加前缀」这种约定维持不变量，
//    第三个面板出现时谁忘了加就中招，而按块内解析的 data-role 让这个 bug
//    在结构上不可能发生。
// 2. 一切查询从 root 出发。旧实现的 document.querySelectorAll('.panel') 会把两个
//    面板一起切掉。
// 3. 函数名不落全局（host()/renderAll()/setTab() 全在 createSetupGuide 的闭包里），
//    内联 onclick= 全部改成事件委托 —— 两个实例互不可见。
//
// 依赖 ui.js 的全局 copyText(text, btn)：明文 http 下 navigator.clipboard 是 undefined，
// 复制必须走它那套三级兜底（clipboard API → execCommand → 交给调用方），
// 本文件不再写第二份。两个宿主页面都必须先加载 ui.js。

// 深链里的 config 是 base64。不能直接 btoa(字符串)：非 ASCII（供应商名可能含中文）
// 会抛 InvalidCharacterError；也不用 unescape(encodeURIComponent())，那个在孤立代理项上
// 会静默产出错误字节。先按 UTF-8 取字节再逐字节转，是唯一稳的写法。
function setupB64(str){
  var bytes=new TextEncoder().encode(str),bin='';
  for(var i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);
  return btoa(bin);
}
// Codex 的两段文本必须与 lib/codex-setup-script.mjs 的 codexTopKeysToml / codexProviderToml
// 逐字同形（那边给一键脚本用，这边给页面与深链用）。测试里交叉断言，改一处必须改两处。
// topKeys 的第四行 openai_base_url:网关已支持 remote compact 的 WS 通道,内置通道统一
// 指向网关(凭据由 auth.json 的虚拟 Key 提供,一键脚本会同步写入)。
function setupCodexTopKeys(g,baseUrl){
  return 'model_provider = "ccteam"\n'+(g.defaultModel?'model = "'+g.defaultModel+'"\n':'')+'model_catalog_json = "~/.codex/models.json"\nopenai_base_url = "'+baseUrl+'"';
}
function setupCodexProviderToml(h,sch,key){
  return '[model_providers.ccteam]\nname = "CC Team Gateway"\nbase_url = "'+sch+'://'+h+'/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nexperimental_bearer_token = "'+key+'"';
}
function setupCodexConfigText(g,h,sch){
  return setupCodexTopKeys(g,sch+'://'+h+'/v1')+'\n'+setupCodexProviderToml(h,sch,g.key);
}
// Claude Code 的 settings.json 内容。与 lib/claude-setup-script.mjs 的 claudeEnvJson 同形。
function setupClaudeEnvJson(base,key){
  return JSON.stringify({env:{ANTHROPIC_BASE_URL:base,ANTHROPIC_AUTH_TOKEN:key}},null,2);
}
// cc-switch 深链。七个参数，刻意**不带** usageEnabled / usageScript / usageApiKey /
// usageBaseUrl / usageAutoInterval：那是 cc-switch 的额度查询脚本，本网关没有对应脚本可给，
// 带上只会让它去调一个不存在的东西。
// config 是 base64，而 base64 里会出现 + / = —— 必须 encodeURIComponent：若 cc-switch 按
// form-urlencoded 解析查询串，裸 + 会被读成空格，导进去的 token 就是坏的（而且看不出来）。
function setupCcSwitchUrl(g,sch,h){
  var origin=sch+'://'+h,endpoint,payload;
  if(g.guide==='codex'){
    endpoint=origin+'/v1';
    payload=JSON.stringify({auth:{OPENAI_API_KEY:g.key},config:setupCodexConfigText(g,h,sch)});
  }else{
    endpoint=origin+(g.basePath||'');
    payload=JSON.stringify({env:{ANTHROPIC_BASE_URL:endpoint,ANTHROPIC_AUTH_TOKEN:g.key}});
  }
  return 'ccswitch://v1/import?resource=provider'
    +'&app='+(g.guide==='codex'?'codex':'claude')
    +'&name='+encodeURIComponent(g.ccName||'CC Team')
    +'&configFormat=json'
    +'&endpoint='+encodeURIComponent(endpoint)
    +'&apiKey='+encodeURIComponent(g.key)
    +'&config='+encodeURIComponent(setupB64(payload));
}
function createSetupGuide(g){
  var root=document.querySelector('.setup-guide[data-guide="'+g.guide+'"]');
  if(!root)return null;
  var hostInput=root.querySelector('[data-role="hostInput"]');
  if(!hostInput)return null;
  // 缺元素是空操作：两个引导的内容集不同，不需要对方补齐全部 role。
  function set(role,text){var el=root.querySelector('[data-role="'+role+'"]');if(el)el.textContent=text}
  function href(role,url){var el=root.querySelector('[data-role="'+role+'"]');if(el)el.setAttribute('href',url)}
  function scheme(){return location.protocol==='https:'?'https':'http'}
  function host(){return (hostInput.value||'').trim().replace(/^https?:\/\//,'').replace(/\/$/,'')}
  function renderAll(){
    var h=host();if(!h)return;
    var sch=scheme(),origin=sch+'://'+h;
    set('schemeLabel',sch+'://');
    set('curlCmd','curl -fsSL "'+origin+g.install+g.key+'" | sh');
    set('psCmd','[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; irm "'+origin+g.win+g.key+'" | iex');
    if(g.guide==='mcp'){
      // MCP 分区:Claude Code 一条命令;Codex 一段 config.toml。Key 即身份,命令由页面现算。
      set('mcpClaudeCmd','claude mcp add cc-team --transport http '+origin+'/mcp --header "Authorization: Bearer '+g.key+'"');
      set('mcpCodexToml','[mcp_servers.ccteam]\nurl = "'+origin+'/mcp"\nhttp_headers = { "Authorization" = "Bearer '+g.key+'" }');
      return;
    }
    if(g.guide==='codex'){
      set('tomlBlock',setupCodexConfigText(g,h,sch));
      set('tomlBlock2',setupCodexProviderToml(h,sch,g.key));
      try{set('modelsJson',JSON.stringify(JSON.parse(g.catalog||'{"models":[]}'),null,2))}catch(e){set('modelsJson','')}
    }else{
      var base=origin+(g.basePath||'');
      set('baseUrl',base);
      set('settingsJson',setupClaudeEnvJson(base,g.key));
      set('shellExport','export ANTHROPIC_BASE_URL="'+base+'"\nexport ANTHROPIC_AUTH_TOKEN="'+g.key+'"');
      set('modelHint',g.modelLine||'');
    }
    set('ccEndpoint',g.guide==='codex'?origin+'/v1':origin+(g.basePath||''));
    var link=setupCcSwitchUrl(g,sch,h);
    href('ccLink',link);
    set('ccLinkText',link);
  }
  // 只看 root 内部 —— 文档级选择器会把另一个引导的面板一起切掉。
  function setTab(t){
    var i,bs=root.querySelectorAll('[data-tab]');
    for(i=0;i<bs.length;i++)bs[i].classList.toggle('on',bs[i].getAttribute('data-tab')===t);
    var ps=root.querySelectorAll('[data-panel]');
    for(i=0;i<ps.length;i++)ps[i].classList.toggle('on',ps[i].getAttribute('data-panel')===t);
  }
  function copyPre(btn){
    var code=btn.parentElement&&btn.parentElement.querySelector('code');
    if(!code)return;
    var old=btn.textContent;
    copyText(code.textContent,btn).then(function(ok){
      if(ok)return;
      // copyText 两级都失败时返回 false（不弹任何东西）：把正文选给用户，让他手动复制。
      try{var r=document.createRange();r.selectNodeContents(code);var s=window.getSelection();s.removeAllRanges();s.addRange(r)}catch(e){}
      btn.textContent='请按 Ctrl/Cmd+C';
      setTimeout(function(){btn.textContent=old},2500);
    });
  }
  root.addEventListener('click',function(e){
    var el=e.target&&e.target.closest?e.target.closest('button'):null;
    if(!el||!root.contains(el))return;
    var tab=el.getAttribute('data-tab');
    if(tab){setTab(tab);return}
    if(el.hasAttribute('data-copy'))copyPre(el);
  });
  hostInput.addEventListener('input',renderAll);
  // 「在 cc-switch 中打开」是 <a href="ccswitch://…">：部分浏览器不允许从页面唤起本机应用，
  // 所以旁边永远摆着那条链接的全文，用户可以自己复制。
  hostInput.value=location.host;
  renderAll();
  return {renderAll:renderAll};
}
(function(){
  var list=(typeof window!=='undefined'&&window.SETUP_GUIDES)||[];
  for(var i=0;i<list.length;i++)createSetupGuide(list[i]);
})();