const TOP_KEYS='model_provider = "ccteam"\n'+(DEFAULT_MODEL?'model = "'+DEFAULT_MODEL+'"\n':'')+'model_catalog_json = "~/.codex/models.json"\n';
// public/assets/codex-setup.js —— Codex 接入配置页（codexSetupHtml，/setup/:key）的客户端
// 逻辑。页面内联引导脚本先注入 KEY / MODELS / DEFAULT_MODEL 再加载本文件。
function host(){return (document.getElementById('hostInput').value||'').trim().replace(/^https?:\/\//,'').replace(/\/$/,'')}
function scheme(){return location.protocol==='https:'?'https':'http'}
function providerToml(h){return '[model_providers.ccteam]\nname = "CC Team Gateway"\nbase_url = "'+scheme()+'://'+h+'/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nexperimental_bearer_token = "'+KEY+'"' }
function renderAll(){
  const h=host();if(!h)return;
  document.getElementById('schemeLabel').textContent=scheme()+'://';
  document.getElementById('curlCmd').textContent='curl -fsSL "'+scheme()+'://'+h+'/api/codex-setup/'+KEY+'" | sh';
  document.getElementById('psCmd').textContent='[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; irm "'+scheme()+'://'+h+'/api/codex-setup-win/'+KEY+'" | iex';
  document.getElementById('tomlBlock').textContent=TOP_KEYS+'\n'+providerToml(h);
  document.getElementById('tomlBlock2').textContent=providerToml(h);
  document.getElementById('modelsJson').textContent=JSON.stringify(JSON.parse(MODELS),null,2);
}
function setTab(t){document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('on',b.dataset.tab===t));document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('on',p.id==='panel-'+t))}
function copyPre(btn){const code=btn.parentElement.querySelector('code');navigator.clipboard.writeText(code.textContent).then(()=>{btn.textContent='已复制';setTimeout(()=>btn.textContent='复制',1500)})}
document.getElementById('hostInput').value=location.host;
renderAll();
