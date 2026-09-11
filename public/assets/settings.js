// public/assets/settings.js —— 设置页（settingsHtml）的客户端逻辑，由页面内联的
// 数据引导脚本先注入以下全局后再加载本文件（经典脚本共享全局词法环境）：
//   SETTINGS / QUOTA_OPS_BY_POOL / NOTIFIER_CFG / PAGE_CSRF / QUOTA_RATE_MAX /
//   editingProfileName / INITIAL_PROD / toast()
// 文件不含任何密钥或按请求变化的数据；带 ?v= 内容版本号强缓存。
function qoKey(suffix,key){const p=(SETTINGS.quotaPools||[]).find(x=>x.profiles.some(m=>m.suffix===suffix));return p?p.name:suffix}
function getCsrf(){return PAGE_CSRF||(document.cookie.match(/tm_csrf=([^;]+)/)||[])[1]||''}
function csrfHeaders(h){h=h||{};h['x-csrf-token']=getCsrf();return h}
async function clearStickyBindings(){
  if(!confirm('确定清除所有粘性会话绑定？\n清除后，所有会话的下一轮请求将从各自协议组头（默认方案）重新开始。'))return;
  const r=await fetch('/api/sticky/clear',{method:'POST',headers:csrfHeaders({})});
  if(r.ok){toast('粘性绑定已清除，请求将从各组默认方案重新开始')}
  else{alert('清除失败')}
}
async function clearRateLimitState(){
  if(!confirm('确定清除所有方案的限流状态？\n清除后，所有方案立即恢复参与 failover，组头（如 Coding Plan）将在下一请求重新接管。'))return;
  const r=await fetch('/api/rate-limit/clear',{method:'POST',headers:csrfHeaders({})});
  if(r.ok){toast('限流状态已清除，各方案恢复参与 failover')}
  else{alert('清除失败')}
}
async function clearImageBridgeCache(){
  if(!confirm('确定清空图片转述缓存？\n缓存按图片本身共享给所有方案，清空后这些图片在下一轮对话会重新调用辅助模型识别（会产生额外 token）。'))return;
  const r=await fetch('/api/image-bridge/cache/clear',{method:'POST',headers:csrfHeaders({})});
  if(r.ok){const j=await r.json().catch(()=>({}));const el=document.getElementById('ibCacheCount');if(el)el.textContent='已缓存 0 张图片转述（全局共享，清空后这些图下一轮会重新识别）';toast('已清空 '+(j.cleared||0)+' 条图片转述缓存')}
  else{alert('清空失败')}
}
function h(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function openDateTimePicker(input){if(typeof input.showPicker==='function'){try{input.showPicker()}catch{}}}
let pendingImportData=null;
let pendingImportPreview=null;
function setImportStatus(message,type){const el=document.getElementById('dataImportStatus');el.textContent=message||'';el.className='inline-status '+(type||'')}
async function previewDataImport(){
  const file=document.getElementById('dataImportFile').files[0];
  if(!file){setImportStatus('请选择 data.json 文件','error');return}
  setImportStatus('正在解析文件','');
  try{
    pendingImportData=JSON.parse(await file.text());
    const r=await fetch('/api/data-import/preview',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({data:pendingImportData})});
    const result=await r.json();
    if(!r.ok)throw new Error(result.error||'预览失败');
    pendingImportPreview=result;
    const summary=result.summary||{};
    document.getElementById('dataImportSummary').innerHTML=[['用户',summary.users||0],['请求',summary.requests||0],['记录',summary.records||0],['日期',summary.minDate&&summary.maxDate?summary.minDate+' 至 '+summary.maxDate:'无日期']].map(function(item){return '<div class="import-stat"><b>'+h(item[1])+'</b><span>'+h(item[0])+'</span></div>'}).join('');
    document.getElementById('dataImportMappings').innerHTML=(result.sourceProfiles||[]).map(function(source){
      const options=['<option value="">请选择目标方案</option>'].concat(SETTINGS.profiles.map(function(profile){return '<option value="'+h(profile.suffix)+'" '+(source.matchedTarget===profile.suffix?'selected':'')+'>'+h(profile.name)+' /'+h(profile.suffix)+'</option>'})).concat(['<option value="skip">跳过此来源</option>']);
      return '<div class="mapping-row"><code>'+h(source.suffix)+'</code><span class="mapping-arrow">到</span><select class="data-import-map" data-source="'+h(source.suffix)+'">'+options.join('')+'</select></div>';
    }).join('');
    document.getElementById('dataImportPreview').classList.add('open');
    setImportStatus((result.warnings||[]).join('；')||'预览完成，请确认方案映射','ok');
  }catch(error){pendingImportData=null;pendingImportPreview=null;document.getElementById('dataImportPreview').classList.remove('open');setImportStatus(error.message||'文件格式无效','error')}
}
function toggleImportPassword(){document.getElementById('dataImportPasswordWrap').style.display=document.getElementById('dataImportMode').value==='replace'?'block':'none'}
async function applyDataImport(){
  if(!pendingImportData||!pendingImportPreview){setImportStatus('请先预览文件','error');return}
  const profileMap={};
  document.querySelectorAll('.data-import-map').forEach(function(select){profileMap[select.dataset.source]=select.value});
  if(Object.values(profileMap).some(function(value){return !value})){setImportStatus('请完成所有方案映射，或明确选择跳过','error');return}
  const mode=document.getElementById('dataImportMode').value;
  const password=document.getElementById('dataImportPassword').value;
  if(mode==='replace'&&!password){setImportStatus('替换模式需要输入后台密码','error');return}
  setImportStatus('正在导入，请勿关闭页面','');
  try{
    const r=await fetch('/api/data-import/apply',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({data:pendingImportData,sourceHash:pendingImportPreview.sourceHash,mode:mode,profileMap:profileMap,password:password})});
    const result=await r.json();
    if(!r.ok)throw new Error(result.error||'导入失败');
    setImportStatus('导入完成','ok');
    toast('数据导入完成');
  }catch(error){setImportStatus(error.message||'导入失败','error')}
}
function openDataClearModal(){const modal=document.getElementById('dataClearModal');modal.classList.add('open');document.getElementById('dataClearPassword').value='';document.getElementById('dataClearStatus').textContent='';document.getElementById('dataClearPassword').focus()}
function closeDataClearModal(){document.getElementById('dataClearModal').classList.remove('open')}
document.getElementById('dataClearModal').addEventListener('click',function(event){if(event.target===this)closeDataClearModal()});
async function clearAllData(){
  const password=document.getElementById('dataClearPassword').value;
  const status=document.getElementById('dataClearStatus');
  if(!password){status.textContent='请输入后台密码';status.className='inline-status error';return}
  status.textContent='正在创建备份并清空数据';status.className='inline-status';
  try{
    const r=await fetch('/api/data-clear',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({password:password})});
    const result=await r.json();
    if(!r.ok)throw new Error(result.error||'清空失败');
    toastThen('数据已清空，已自动备份',()=>location.reload());
  }catch(error){status.textContent=error.message||'清空失败';status.className='inline-status error'}
}
function openUserModal(){const sfx=document.getElementById('profileSuffixInput').value||SETTINGS.selectedProfileSuffix;document.getElementById('userProfileSel').value=sfx;renderProfileUsers(sfx);document.getElementById('userModal').classList.add('open')}
function closeUserModal(){document.getElementById('userModal').classList.remove('open')}
document.getElementById('userModal').addEventListener('click',function(e){if(e.target===this)closeUserModal()});
function openProfileModal(protocol){document.getElementById('profileModal').classList.add('open');if(protocol){var sel=document.getElementById('newProfileProtocol');sel.value=protocol;updateNewProfileProtocolHint()}document.getElementById('newProfileName').focus()}
// 限制直连 is ONE shared setting rendered in both protocol panes — keep the
// two checkboxes in sync whichever one is toggled, and persist the choice
// right away: the checkboxes live outside both forms, so an unsaved toggle
// used to be lost (or silently flipped by the next form save). On failure
// roll both checkboxes back to the previous state and surface the error.
function setRestrictGroupSuffix(checked){
  var a=document.getElementById('restrictGroupSuffixCb'),b=document.getElementById('restrictGroupSuffixCb2');
  var prev=!checked; // checkboxes are kept in sync, so the prior state is the inverse
  if(a)a.checked=checked;if(b)b.checked=checked;
  fetch('/api/restrict-group-suffix',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({on:checked})})
    .then(function(r){return r.text().then(function(t){
      var j=null;try{j=JSON.parse(t)}catch(e){}
      if(!r.ok){throw new Error((j&&j.error)||('HTTP '+r.status))}
    })})
    .then(function(){toast(checked?'限制直连已开启':'限制直连已关闭')})
    .catch(function(err){
      if(a)a.checked=prev;if(b)b.checked=prev;
      toast('保存失败:'+(err&&err.message?err.message:'未知错误'));
    });
}
// Protocol tabs: each pane owns its protocol's profiles; the failover group
// editors live in the bottom dock and swap with the same toggle. Switching tabs
// auto-selects the first profile of that protocol so the edit form and the
// highlighted card always match the visible tab. Persists across reloads.
function switchProtoTab(tab){
  document.querySelectorAll('#protoTabs .proto-tab').forEach(function(b){b.classList.toggle('on',b.dataset.tab===tab)});
  document.querySelectorAll('[data-proto]').forEach(function(p){p.style.display=(p.dataset.proto===tab)?'':'none'});
  try{localStorage.setItem('tm_settings_proto_tab',tab)}catch(e){}
  var first=(SETTINGS.profiles||[]).find(function(p){return (p.protocol==='responses')===(tab==='responses')});
  if(first&&first.name)editProfile(first.name);
}
function closeProfileModal(){document.getElementById('profileModal').classList.remove('open')}
document.getElementById('profileModal').addEventListener('click',function(e){if(e.target===this)closeProfileModal()});
async function switchToProfile(n){
  // No longer exclusive switch — just reload the profile into the form
  editProfile(n);
}
function updateAccessUrl(){
  const sfx=document.getElementById('suffixInput').value.trim();
  const p=SETTINGS.profiles.find(x=>x.name===editingProfileName);
  const isResponses=p&&p.protocol==='responses';
  const entry=isResponses?'/v1/responses':'/v1/messages';
  const defaultNote=p&&p.isDefault?' <span style="color:var(--green)">默认入口也可用 http://&lt;host&gt;:6789'+entry+'</span>':'';
  document.getElementById('accessUrlPreview').innerHTML='接入地址: http://&lt;host&gt;:6789/'+h(sfx)+entry+defaultNote;
}
updateAccessUrl();
// ─── Peak hours editor (recurring daily ranges driving peak model aliases) ───
// Uses native <select> dropdowns (hours 00-23, minutes 00-59): fixed lists, no
// wheel-wrap like <input type="time">. Hidden peakStart/peakEnd inputs stay the
// form contract consumed by applySettings.
function addPeakHoursRow(start,end){
  const list=document.getElementById('peakHoursList');
  const row=document.createElement('div');
  row.style.cssText='display:flex;align-items:center;gap:6px;margin-bottom:6px';
  const sVal=/^\d{2}:\d{2}$/.test(start||'')?start:'09:00';
  const eVal=/^\d{2}:\d{2}$/.test(end||'')?end:'12:00';
  const selStyle='width:auto;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:3px 6px;border-radius:4px;font-size:12px';
  const opts=function(n,sel){var out='';for(var i=0;i<n;i++){var v=String(i).padStart(2,'0');out+='<option value="'+v+'"'+(v===sel?' selected':'')+'>'+v+'</option>'}return out};
  const [sh,sm]=sVal.split(':'),[eh,em]=eVal.split(':');
  row.innerHTML='<input type="hidden" name="peakStart" value="'+sVal+'"><input type="hidden" name="peakEnd" value="'+eVal+'">'
    +'<select data-peak="sh" style="'+selStyle+'">'+opts(24,sh)+'</select>:<select data-peak="sm" style="'+selStyle+'">'+opts(60,sm)+'</select>'
    +' <span style="color:var(--dim)">至</span> '
    +'<select data-peak="eh" style="'+selStyle+'">'+opts(24,eh)+'</select>:<select data-peak="em" style="'+selStyle+'">'+opts(60,em)+'</select>'
    +' <button type="button" class="btn btn-outline btn-sm" onclick="this.parentElement.remove();updatePeakHoursStatus()">删除</button>';
  row.querySelectorAll('select[data-peak]').forEach(function(sel){
    sel.addEventListener('change',syncPeakRow);
  });
  list.appendChild(row);
  updatePeakHoursStatus();
}
function syncPeakRow(e){
  const row=e.target.closest('div');
  if(!row)return;
  const q=k=>{const s=row.querySelector('select[data-peak="'+k+'"]');return s?s.value:'00'};
  const sh=row.querySelector('input[name="peakStart"]'),eh2=row.querySelector('input[name="peakEnd"]');
  if(sh)sh.value=q('sh')+':'+q('sm');
  if(eh2)eh2.value=q('eh')+':'+q('em');
  updatePeakHoursStatus();
}
function renderPeakHoursRows(ranges){
  const list=document.getElementById('peakHoursList');
  if(!list)return;
  list.innerHTML='';
  (ranges||[]).forEach(r=>addPeakHoursRow(r.start,r.end));
  updatePeakHoursStatus();
}
function collectPeakHours(){
  const rows=document.querySelectorAll('#peakHoursList > div');
  return Array.prototype.map.call(rows,function(row){
    const s=row.querySelector('input[name="peakStart"]'),e=row.querySelector('input[name="peakEnd"]');
    return {start:s?s.value:'',end:e?e.value:''};
  }).filter(r=>r.start&&r.end);
}
function nowInPeakHours(ranges){
  // Beijing time (UTC+8), so the hint matches the server-side peak judgment
  // regardless of the viewer's local timezone.
  const now=new Date(),cur=((now.getTime()+8*3600000)%86400000)/60000;
  const toMin=function(t){if(!t||!/^\d{2}:\d{2}$/.test(t))return null;const p=t.split(':');return parseInt(p[0],10)*60+parseInt(p[1],10)};
  return (ranges||[]).some(function(r){
    const s=toMin(r.start),e=toMin(r.end);
    if(s===null||e===null||s===e)return false;
    return s<e?(cur>=s&&cur<e):(cur>=s||cur<e);
  });
}
function updatePeakHoursStatus(){
  const el=document.getElementById('peakHoursStatus');
  if(!el)return;
  const ranges=collectPeakHours();
  if(!ranges.length){el.textContent='未设置时段';el.style.color='var(--dim)';}
  else if(nowInPeakHours(ranges)){el.textContent='当前处于高峰';el.style.color='var(--orange)'}
  else{el.textContent='当前不在高峰';el.style.color='var(--green)'}
  updateQuotaRateHint();
  // Peak/off-peak flip changes which column of every model rate is "current".
  try{updateRateRowsHint()}catch(e){}
}
// Quota-rate hint: the traps here matter more than the inputs themselves —
// an off-peak rate with no peak hours defined discounts the whole day, and
// every-slot-below-1.0 quietly inflates the nominal limit for everyone.
function updateQuotaRateHint(){
  const el=document.getElementById('quotaRateHint');
  if(!el)return;
  const peakEl=document.getElementById('peakQuotaRateInput'),offEl=document.getElementById('offPeakQuotaRateInput');
  if(!peakEl||!offEl){el.textContent='';return}
  const peak=Number(peakEl.value),off=Number(offEl.value);
  const ranges=collectPeakHours();
  const warn=function(t){el.innerHTML='<b style="color:var(--orange)">注意：'+t+'</b>';el.style.color='var(--orange)'};
  if(!Number.isFinite(peak)||!Number.isFinite(off)){warn('倍率必须是数字，非法值保存时会归一为 1.0');return}
  if(!ranges.length&&off!==1){warn('未设置高峰时段 — 低谷倍率 ×'+off+' 将全天生效');return}
  if(peak===0||off===0){warn('倍率为 0 的时段消耗完全不计入配额');return}
  if(peak<1&&off<1){warn('所有时段倍率均小于 1，名义限额将失去参照意义，建议保留一档为 1.0');return}
  const inPeak=ranges.length?nowInPeakHours(ranges):false;
  const cur=inPeak?peak:off;
  const limit=Number((document.forms.settingsForm&&document.forms.settingsForm.profileQuota||{}).value)||0;
  const equiv=(cur>0&&limit>0)?' · '+fmtRateTk(limit)+' 额度 ≈ '+fmtRateTk(Math.round(limit/cur))+' 实际 token':'';
  el.innerHTML='当前处于'+(inPeak?'高峰':'低谷')+' <b>×'+cur+'</b>（高峰 ×'+peak+' / 低谷 ×'+off+'）'+equiv;
  el.style.color='var(--dim)';
}
function fmtRateTk(n){n=Number(n)||0;if(n>=1e6)return(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'k';return String(n)}
['peakQuotaRateInput','offPeakQuotaRateInput'].forEach(function(id){
  var el=document.getElementById(id);
  if(el)el.addEventListener('input',function(){updateQuotaRateHint();try{updateRateRowsHint()}catch(e){}});
});
(function(){var q=document.forms.settingsForm&&document.forms.settingsForm.profileQuota;if(q)q.addEventListener('input',updateQuotaRateHint)})();
setInterval(updatePeakHoursStatus,30000);
// Initial render: fill rows for the profile the page was opened with.
(function(){
  var sfx=document.getElementById('profileSuffixInput')?document.getElementById('profileSuffixInput').value:'';
  var ps=SETTINGS.profiles||[];
  var p=ps.find(function(x){return x.suffix===sfx})||ps[0];
  renderPeakHoursRows((p&&p.peakHours)||[]);
})();
function openDataManagementView(){
  const form=document.getElementById('settingsForm');
  hideAllSecondaryViews();
  const view=document.getElementById('dataManagementView');
  form.hidden=true;
  view.hidden=false;
  view.setAttribute('aria-hidden','false');
  document.getElementById('dataManagementNav').classList.add('active');
}
function showProfileSettings(){
  const form=document.getElementById('settingsForm');
  const view=document.getElementById('dataManagementView');
  const audit=document.getElementById('auditLogView');
  const pool=document.getElementById('quotaPoolView');
  form.hidden=false;
  view.hidden=true;
  view.setAttribute('aria-hidden','true');
  audit.hidden=true;
  audit.setAttribute('aria-hidden','true');
  if(pool){pool.hidden=true;pool.setAttribute('aria-hidden','true')}
  document.getElementById('dataManagementNav').classList.remove('active');
  document.getElementById('auditLogNav').classList.remove('active');
  const pn=document.getElementById('quotaPoolNav');if(pn)pn.classList.remove('active');
}
function hideAllSecondaryViews(){
  const dm=document.getElementById('dataManagementView'),audit=document.getElementById('auditLogView'),pool=document.getElementById('quotaPoolView'),qr=document.getElementById('quotaRequestView');
  dm.hidden=true;dm.setAttribute('aria-hidden','true');
  audit.hidden=true;audit.setAttribute('aria-hidden','true');
  if(pool){pool.hidden=true;pool.setAttribute('aria-hidden','true')}
  if(qr){qr.hidden=true;qr.setAttribute('aria-hidden','true')}
  document.querySelectorAll('.pl-item').forEach(function(el){el.classList.remove('active')});
  // Nav buttons live outside .pl-item now, so clear their highlight explicitly.
  ['quotaPoolNav','dataManagementNav','auditLogNav','quotaRequestNav'].forEach(function(id){
    const el=document.getElementById(id);
    if(el)el.classList.remove('active');
  });
}
function openQuotaPoolView(){
  const form=document.getElementById('settingsForm');
  hideAllSecondaryViews();
  form.hidden=true;
  const view=document.getElementById('quotaPoolView');
  view.hidden=false;view.setAttribute('aria-hidden','false');
  document.getElementById('quotaPoolNav').classList.add('active');
}
// Reload should land back HERE, not on the profile form — admins adjusting
// several pools in a row shouldn't be kicked out of the view each save.
function rememberPoolViewForReload(){
  try{sessionStorage.setItem('tm_return_pool_view','1')}catch(e){}
}
// Collect a pool card's pool-level limit + per-user limits and POST to the single
// write path. The temporary-quota modal (bonus/reset) is separate and reaches the
// same pool via its representative profile suffix.
async function savePoolQuota(poolName){
  const card=document.querySelector('[data-poolcard="'+poolName+'"]');
  if(!card)return;
  const limitInput=card.querySelector('[data-poollimit="'+poolName+'"]');
  const users={};
  card.querySelectorAll('input[data-user]').forEach(inp=>{
    users[inp.dataset.user]=inp.value.trim()?parseInt(inp.value,10):null;
  });
  let r,data;
  try{
    r=await fetch('/api/quota-pool/save',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({pool:poolName,dailyTokenLimit:limitInput?limitInput.value.trim()||null:null,users})});
    data=await r.json();
  }catch(err){alert('保存失败: '+err.message);return}
  if(!r.ok){alert('保存失败: '+(data&&data.error?data.error:r.status));return}
  rememberPoolViewForReload();
  toastThen('额度池「'+(data.pool?data.pool.label:poolName)+'」已保存',()=>location.reload());
}
// Rename a pool's display label only — the pool key (name) never changes, so
// member profile bindings and per-user limits are untouched (body omits them).
async function renamePoolLabel(poolName,currentLabel){
  const nn=prompt('新的额度池显示名（池 key '+poolName+' 不变，方案绑定与配额不受影响）',currentLabel);
  if(!nn)return;
  const label=nn.trim();
  if(!label||label===currentLabel)return;
  let r,data;
  try{
    r=await fetch('/api/quota-pool/save',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({pool:poolName,label})});
    data=await r.json();
  }catch(err){alert('重命名失败: '+err.message);return}
  if(!r.ok){alert('重命名失败: '+(data&&data.error?data.error:r.status));return}
  rememberPoolViewForReload();
  toastThen('额度池已重命名为「'+(data.pool?data.pool.label:label)+'」',()=>location.reload());
}
// Open the temporary-quota modal for a user from the pool view, using the pool's
// representative profile suffix so /api/quota/daily-op resolves the same pool.
function openQuotaOpFromPool(suffix,key){
  const sel=document.getElementById('userProfileSel');
  if(sel)sel.value=suffix;
  openQuotaOp(key);
}
function togglePoolCreate(){
  const row=document.getElementById('poolCreateRow');
  if(!row)return;
  row.style.display=row.style.display==='none'?'inline-flex':'none';
  if(row.style.display!=='none'){const inp=document.getElementById('newPoolName');if(inp)inp.focus()}
}
async function createPool(){
  const inp=document.getElementById('newPoolName');
  const name=inp?inp.value.trim():'';
  if(!name){alert('请填写额度池名称');return}
  let r,data;
  try{
    r=await fetch('/api/quota-pool/create',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({label:name})});
    data=await r.json().catch(()=>({}));
  }catch(err){alert('创建失败: '+err.message);return}
  if(!r.ok){alert('创建失败: '+(data.error||r.status));return}
  rememberPoolViewForReload();
  toastThen('额度池「'+name+'」已创建',()=>location.reload());
}
async function deletePool(name){
  if(!confirm('确定删除额度池「'+name+'」？该池当前没有成员方案，其池级限额与每人配额配置将一并删除。'))return;
  let r,data;
  try{
    r=await fetch('/api/quota-pool/delete',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({pool:name})});
    data=await r.json().catch(()=>({}));
  }catch(err){alert('删除失败: '+err.message);return}
  if(!r.ok){alert('删除失败: '+(data.error||r.status));return}
  rememberPoolViewForReload();
  toastThen('额度池已删除',()=>location.reload());
}
// ─── 操作日志（audit_log）───
let auditRows=[],auditOffset=0,auditCategory='',auditLoaded=false,auditTotal=0;
const AUDIT_PAGE=100;
function openAuditLogView(){
  const form=document.getElementById('settingsForm');
  hideAllSecondaryViews();
  form.hidden=true;
  const view=document.getElementById('auditLogView');
  view.hidden=false;view.setAttribute('aria-hidden','false');
  document.getElementById('auditLogNav').classList.add('active');
  if(!auditLoaded)loadAuditLog(true);
}
function auditActorBadge(a){
  if(a==='admin')return '<span style="color:var(--accent);font-weight:600">管理员</span>';
  if(a==='system')return '<span style="color:var(--blue);font-weight:600">系统</span>';
  if(a==='user')return '<span style="color:var(--green);font-weight:600">成员</span>';
  return '<span style="color:var(--orange);font-weight:600">'+h(a||'?')+'</span>';
}
// Coloured type tag next to the action code — makes check-in / request entries
// visually distinct even inside the "全部记录" view.
function auditCatTag(c){
  if(c==='checkin')return ' <span style="font-size:10px;background:var(--accent-soft);color:var(--green);padding:1px 6px;border-radius:4px;white-space:nowrap">签到</span>';
  if(c==='request')return ' <span style="font-size:10px;background:rgba(74,111,165,.14);color:#456b8a;padding:1px 6px;border-radius:4px;white-space:nowrap">申请</span>';
  return '';
}
function auditTime(iso){
  // 存储是 UTC ISO;展示一律北京时间(+8h 后取 UTC 字段,不依赖浏览器时区)。
  const d=new Date(new Date(iso).getTime()+8*3600000);function p(n){return String(n).padStart(2,'0')}
  return d.getUTCFullYear()+'-'+p(d.getUTCMonth()+1)+'-'+p(d.getUTCDate())+' '+p(d.getUTCHours())+':'+p(d.getUTCMinutes())+':'+p(d.getUTCSeconds());
}
async function loadAuditLog(reset){
  const status=document.getElementById('auditStatus');
  if(reset){auditOffset=0;auditRows=[]}
  status.textContent='加载中...';status.className='inline-status';
  try{
    const qs=['limit='+AUDIT_PAGE,'offset='+auditOffset];
    if(auditCategory)qs.push('category='+auditCategory);
    const r=await fetch('/api/audit-log?'+qs.join('&'));
    if(!r.ok)throw new Error('加载失败');
    const data=await r.json();
    auditRows=auditRows.concat(data.rows||[]);auditTotal=data.total||0;auditLoaded=true;
    renderAuditLog();
    status.textContent='共 '+auditTotal+' 条';status.className='inline-status';
  }catch(e){status.textContent=e.message||'加载失败';status.className='inline-status error'}
}
function loadMoreAudit(){auditOffset+=AUDIT_PAGE;loadAuditLog(false)}
// ─── 加量申请（quota_requests）───
let qrRows=[],qrFilterVal='pending';
function qrSwitchFilter(v){
  qrFilterVal=['pending','handled','rejected'].indexOf(v)>=0?v:'';
  document.querySelectorAll('#qrFilter button').forEach(function(b){b.classList.toggle('on',b.dataset.st===qrFilterVal)});
  loadQuotaRequests(true);
}
function updateQrPendingBadge(pending){
  const b=document.getElementById('qrPendingBadge');
  if(!b)return;
  if(pending>0){b.style.display='';b.textContent=pending}else{b.style.display='none'}
}
async function loadQrPendingBadge(){
  try{
    const r=await fetch('/api/quota-requests?limit=1');
    if(!r.ok)return;
    const j=await r.json();
    updateQrPendingBadge(j.pending||0);
  }catch(e){}
}
loadQrPendingBadge();
async function loadQuotaRequests(reset){
  const status=document.getElementById('qrStatus');
  status.textContent='加载中...';status.className='inline-status';
  try{
    const f=qrFilterVal;
    const r=await fetch('/api/quota-requests?limit=200'+(f?'&status='+f:''));
    if(!r.ok)throw new Error('加载失败');
    const data=await r.json();
    qrRows=data.rows||[];
    renderQuotaRequests(data.pending);
    status.textContent=qrRows.length+' 条'+(data.pending!=null?' · 待处理 '+data.pending+' 条':'');
    status.className='inline-status';
  }catch(e){status.textContent=e.message||'加载失败';status.className='inline-status error'}
}
function openQuotaRequestView(){
  const form=document.getElementById('settingsForm');
  hideAllSecondaryViews();
  form.hidden=true;
  const view=document.getElementById('quotaRequestView');
  view.hidden=false;view.setAttribute('aria-hidden','false');
  document.getElementById('quotaRequestNav').classList.add('active');
  loadQuotaRequests(true);
}
function qrRowBadge(s){
  if(s==='pending')return '<span style="color:var(--orange);font-weight:600">待处理</span>';
  if(s==='handled')return '<span style="color:var(--green);font-weight:600">已加量</span>';
  if(s==='rejected')return '<span style="color:var(--red);font-weight:600">已驳回</span>';
  return h(s||'?');
}
function renderQuotaRequests(pending){
  updateQrPendingBadge(pending);
  const tb=document.getElementById('qrBody');
  if(!qrRows.length){tb.innerHTML='<tr><td colspan="6" style="color:var(--dim);text-align:center;padding:18px">暂无申请</td></tr>';return}
  tb.innerHTML=qrRows.map(function(r){
    const ops=r.status==='pending'
      ?'<button type="button" class="btn btn-primary btn-sm" onclick="openQrGrant('+r.id+')">发放加量</button> <button type="button" class="btn btn-outline btn-sm" onclick="rejectQuotaRequest('+r.id+')">驳回</button>'
      :'<span style="font-size:11px;color:var(--dim)">'+h(r.admin_note||'-')+'</span>';
    return '<tr><td style="font-size:11px;color:var(--dim);white-space:nowrap">'+auditTime(r.created_at)+'</td>'
      +'<td style="font-weight:600">'+h(r.username||'-')+'</td>'
      +'<td style="font-weight:600">'+(r.poolLabel?h(r.poolLabel):'<span style="color:var(--dim)">-</span>')+'</td>'
      +'<td style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+h(r.reason||'')+'">'+h(r.reason||'-')+'</td>'
      +'<td>'+qrRowBadge(r.status)+'</td>'
      +'<td style="white-space:nowrap">'+ops+'</td></tr>';
  }).join('');
}
function openQrGrant(id){
  const r=qrRows.find(function(x){return x.id===id});
  if(!r||r.status!=='pending')return;
  document.getElementById('qrGrantUser').textContent=r.username||'-';
  document.getElementById('qrGrantReason').textContent='申请理由「'+(r.reason||'')+'」'+(r.poolLabel?' · 申请额度池：'+r.poolLabel:'');
  document.getElementById('qrGrantId').value=id;
  const sel=document.getElementById('qrGrantPool');
  sel.innerHTML=(r.pools&&r.pools.length?r.pools:[]).map(function(p){return '<option value="'+h(p.name)+'">'+h(p.label)+'</option>'}).join('');
  if(r.pool)sel.value=r.pool;
  document.getElementById('qrGrantAmount').value='';
  document.getElementById('qrGrantModal').classList.add('open');
}
function closeQrGrant(){document.getElementById('qrGrantModal').classList.remove('open')}
async function submitQrGrant(){
  const btn=document.getElementById('qrGrantSubmit');
  btn.disabled=true;
  try{
    const body={id:Number(document.getElementById('qrGrantId').value),pool:document.getElementById('qrGrantPool').value,amount:Number(document.getElementById('qrGrantAmount').value)};
    const r=await fetch('/api/quota-request/grant',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},csrfHeaders()),body:JSON.stringify(body)});
    const j=await r.json().catch(function(){return{}});
    if(!r.ok)throw new Error(j.error||'发放失败');
    toast('已发放加量并标记该申请为已处理');
    closeQrGrant();
    loadQuotaRequests(true);
  }catch(e){alert(e.message||'发放失败')}
  btn.disabled=false;
}
async function rejectQuotaRequest(id){
  const note=prompt('驳回备注（成员在其页面可见，可留空）：','');
  if(note===null)return;
  try{
    const r=await fetch('/api/quota-request/update',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},csrfHeaders()),body:JSON.stringify({id:id,status:'rejected',note:note})});
    const j=await r.json().catch(function(){return{}});
    if(!r.ok)throw new Error(j.error||'操作失败');
    toast('已驳回该申请');
    loadQuotaRequests(true);
  }catch(e){alert(e.message||'操作失败')}
}
function switchAuditFilter(v){
  auditCategory=['admin','system','auth','checkin','request'].indexOf(v)>=0?v:'';
  document.querySelectorAll('#auditFilter button').forEach(function(b){b.classList.toggle('on',b.dataset.cat===auditCategory)});
  loadAuditLog(true);
}
function renderAuditLog(){
  const tb=document.getElementById('auditBody');
  if(!auditRows.length){tb.innerHTML='<tr><td colspan="6" style="color:var(--dim);text-align:center;padding:18px">暂无记录</td></tr>'}
  else{
    tb.innerHTML=auditRows.map(function(r){
      return '<tr><td style="font-size:11px;color:var(--dim);white-space:nowrap">'+auditTime(r.time)+'</td>'
        +'<td>'+auditActorBadge(r.actor)+'</td>'
        +'<td><code style="font-size:11px;color:var(--accent)">'+h(r.action)+'</code>'+auditCatTag(r.category)+'</td>'
        +'<td style="font-size:11px">'+h(r.target||'-')+'</td>'
        +'<td style="font-size:12px;min-width:260px">'+h(r.detail||'')+'</td>'
        +'<td style="font-size:11px;color:var(--dim)">'+h(r.ip||'-')+'</td></tr>';
    }).join('');
  }
  document.getElementById('auditMoreBtn').hidden=auditRows.length>=auditTotal;
}
// ─── 通知设置（notifier）───
function initNotifierForm(){
  const n=NOTIFIER_CFG||{};
  document.getElementById('notifEnabled').checked=!!n.enabled;
  document.getElementById('notifRecovery').checked=n.notifyRecovery!==false;
  document.getElementById('notifFeishu').value=n.feishuWebhook||'';
  document.getElementById('notifDingtalk').value=n.dingtalkWebhook||'';
  document.getElementById('notifWecom').value=n.wecomWebhook||'';
  document.getElementById('notifServerchan').value=n.serverchanSendKey||'';
  document.getElementById('notifBarkKey').value=n.barkDeviceKey||'';
  document.getElementById('notifBarkServer').value=n.barkServer||'';
  document.getElementById('notifInterval').value=(n.minIntervalSeconds!==undefined?n.minIntervalSeconds:300);
}
function collectNotifier(){
  return {
    enabled:document.getElementById('notifEnabled').checked,
    notifyRecovery:document.getElementById('notifRecovery').checked,
    feishuWebhook:document.getElementById('notifFeishu').value.trim(),
    dingtalkWebhook:document.getElementById('notifDingtalk').value.trim(),
    wecomWebhook:document.getElementById('notifWecom').value.trim(),
    serverchanSendKey:document.getElementById('notifServerchan').value.trim(),
    barkDeviceKey:document.getElementById('notifBarkKey').value.trim(),
    barkServer:document.getElementById('notifBarkServer').value.trim(),
    minIntervalSeconds:parseInt(document.getElementById('notifInterval').value,10)||0
  };
}
function setNotifierStatus(text,cls){const el=document.getElementById('notifStatus');el.textContent=text||'';el.className='inline-status '+(cls||'')}
async function saveNotifier(){
  setNotifierStatus('保存中...');
  try{
    const r=await fetch('/api/notifier/save',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(collectNotifier())});
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||'保存失败');
    setNotifierStatus('已保存','ok');
    toast('通知设置已保存');
  }catch(e){setNotifierStatus(e.message||'保存失败','error')}
}
async function testNotifier(){
  setNotifierStatus('测试消息发送中，最长约 5 秒...');
  try{
    const r=await fetch('/api/notifier/test',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(collectNotifier())});
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||'测试失败');
    const parts=(data.results||[]).map(function(x){return x.channel+(x.ok?' ✓':' ✗ '+(x.error||'失败'))});
    const allOk=(data.results||[]).length>0&&(data.results||[]).every(function(x){return x.ok});
    setNotifierStatus(parts.join('；'),allOk?'ok':'error');
  }catch(e){setNotifierStatus(e.message||'测试失败','error')}
}
initNotifierForm();
// ─── Stats cleanup (residual user/model stats) ───
let cleanupData={users:[],models:[]},cleanupTab='users',cleanupLoaded=false;
function fmtCleanupNum(n){return Number(n||0).toLocaleString('zh-CN')}
function fmtCleanupTk(n){n=Number(n||0);if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'k';return String(n)}
function cleanupAgo(iso){if(!iso)return'-';const d=Date.now()-new Date(iso).getTime();const m=Math.floor(d/6e4);if(m<1)return'刚刚';if(m<60)return m+'分钟前';const hr=Math.floor(m/60);if(hr<24)return hr+'小时前';return Math.floor(hr/24)+'天前'}
function maskCleanupKey(k){const v=String(k||'');return v.length<=12?v:v.slice(0,8)+'****'+v.slice(-4)}
async function loadCleanupList(){
  const status=document.getElementById('cleanupStatus');
  status.textContent='正在加载...';status.className='inline-status';
  try{
    const r=await fetch('/api/stats-cleanup/list');if(!r.ok)throw new Error('加载失败');
    cleanupData=await r.json();cleanupLoaded=true;renderCleanup();
    status.textContent='';status.className='inline-status';
  }catch(e){status.textContent=e.message||'加载失败';status.className='inline-status error'}
}
function switchCleanupTab(t){
  cleanupTab=t;
  document.querySelectorAll('.cleanup-tab').forEach(b=>b.classList.toggle('on',b.dataset.t===t));
  document.getElementById('cleanupUsersView').hidden=(t!=='users');
  document.getElementById('cleanupModelsView').hidden=(t!=='models');
  if(!cleanupLoaded)loadCleanupList();else renderCleanup();
}
function renderCleanup(){
  document.getElementById('cleanupUserCount').textContent=cleanupData.users.length;
  document.getElementById('cleanupModelCount').textContent=cleanupData.models.length;
  const ub=document.getElementById('cleanupUsersBody');
  if(!cleanupData.users.length){ub.innerHTML='<tr><td colspan="6" style="color:var(--dim);text-align:center;padding:18px">暂无用户统计数据</td></tr>'}
  else{ub.innerHTML=cleanupData.users.map(u=>{
    const orphan=!u.existsInConfig;const bg='style="background:'+(orphan?'#fff5f3':'transparent')+'"';
    const nameCell=orphan?'<span style="color:var(--red)">'+h(u.name)+'</span> <span style="color:var(--red);font-size:10px">(未配置)</span>':h(u.name);
    const cfgCell=orphan?'<span style="color:var(--red);font-size:11px">无</span>':'<span style="color:var(--green);font-size:11px">有</span>';
    return '<tr '+bg+'><td><code style="font-size:11px">'+h(maskCleanupKey(u.key))+'</code></td><td>'+nameCell+'</td><td class="n">'+fmtCleanupNum(u.requests)+'</td><td style="font-size:11px;color:var(--dim)">'+cleanupAgo(u.lastActive)+'</td><td>'+cfgCell+'</td><td><button type="button" class="btn btn-outline btn-sm cleanup-del-user" data-key="'+h(u.key)+'">删除</button></td></tr>';
  }).join('')}
  const mb=document.getElementById('cleanupModelsBody');
  if(!cleanupData.models.length){mb.innerHTML='<tr><td colspan="4" style="color:var(--dim);text-align:center;padding:18px">暂无模型统计数据</td></tr>'}
  else{mb.innerHTML=cleanupData.models.map(m=>{
    return '<tr><td><code style="font-size:11px">'+h(m.model)+'</code></td><td class="n">'+fmtCleanupNum(m.requests)+'</td><td class="n">'+fmtCleanupTk(m.tokens)+'</td><td><button type="button" class="btn btn-outline btn-sm cleanup-del-model" data-model="'+h(m.model)+'">删除</button></td></tr>';
  }).join('')}
  ub.querySelectorAll('.cleanup-del-user').forEach(b=>b.addEventListener('click',()=>deleteCleanupUser(b.dataset.key)));
  mb.querySelectorAll('.cleanup-del-model').forEach(b=>b.addEventListener('click',()=>deleteCleanupModel(b.dataset.model)));
}
async function deleteCleanupUser(key){
  if(!confirm('确定删除该用户的所有统计数据？\nKey: '+maskCleanupKey(key)+'\n此操作只清理统计数据，不影响 config.json 配置，执行前自动备份。'))return;
  const status=document.getElementById('cleanupStatus');
  status.textContent='正在删除并备份...';status.className='inline-status';
  try{
    const r=await fetch('/api/stats-user/delete',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({key:key})});
    const result=await r.json();if(!r.ok)throw new Error(result.error||'删除失败');
    status.textContent='已删除用户残留统计';status.className='inline-status ok';
    toast('已删除用户残留统计');
    cleanupData.users=cleanupData.users.filter(u=>u.key!==key);renderCleanup();
  }catch(e){status.textContent=e.message||'删除失败';status.className='inline-status error'}
}
async function deleteCleanupModel(model){
  if(!confirm('确定删除该模型的所有统计数据？\n模型: '+model+'\n此操作只清理统计数据，不影响 config.json 配置，执行前自动备份。'))return;
  const status=document.getElementById('cleanupStatus');
  status.textContent='正在删除并备份...';status.className='inline-status';
  try{
    const r=await fetch('/api/stats-model/delete',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({model:model})});
    const result=await r.json();if(!r.ok)throw new Error(result.error||'删除失败');
    status.textContent='已删除模型残留统计';status.className='inline-status ok';
    toast('已删除模型残留统计');
    cleanupData.models=cleanupData.models.filter(m=>m.model!==model);renderCleanup();
  }catch(e){status.textContent=e.message||'删除失败';status.className='inline-status error'}
}
async function editProfile(n){
  const p=SETTINGS.profiles.find(x=>x.name===n);
  if(!p)return;
  showProfileSettings();
  editingProfileName=n;
  // Pool summary follows the select; declared before use inside the fn body.
  ;
  window.updatePoolSummary=function(){
    const sel=document.getElementById('quotaPoolSelect'),el=document.getElementById('poolSummary');
    if(!sel||!el)return;
    const name=sel.value;
    if(name==='__new__'){el.innerHTML='将在保存时新建一个与方案同名的额度池';return}
    const pool=(SETTINGS.quotaPools||[]).find(x=>x.name===name);
    if(!pool){el.innerHTML='未关联额度池';return}
    const memberNames=pool.profiles.map(m=>m.name).join('、');
    const limit=pool.dailyTokenLimit?('池级上限 '+pool.dailyTokenLimit.toLocaleString('zh-CN')):'池级不限制';
    const nUsers=Object.keys(pool.userLimits||{}).length;
    el.innerHTML='本池成员：'+h(memberNames)+' · '+h(limit)+' · '+nUsers+' 人有个人配额'
      +(pool.profiles.length>1?'<br><b style="color:var(--orange)">注意：此方案保存后，其用量与额度立即与上述方案合并计算</b>':'');
  };
  const fm=document.forms.settingsForm;
  fm.upstream.value=p.upstream||'';
  document.getElementById('suffixInput').value=p.suffix||'';
  document.getElementById('profileNameInput').value=p.name||'';
  renderAliasRows(p);
  const poolSel=document.getElementById('quotaPoolSelect');if(poolSel)poolSel.value=p.quotaPool||'__new__';
  updatePoolSummary();
  const pqr=document.getElementById('peakQuotaRateInput');if(pqr)pqr.value=(p.peakQuotaRate??1);
  const oqr=document.getElementById('offPeakQuotaRateInput');if(oqr)oqr.value=(p.offPeakQuotaRate??1);
  const cqr=document.getElementById('cacheReadQuotaRateInput');if(cqr)cqr.value=(p.cacheReadQuotaRate??0);
  // cacheReadQuotaRate only means something on Responses/Codex profiles (OpenAI
  // upstreams fold cache hits into input_tokens) — hide it on Anthropic profiles.
  const cqF=document.getElementById('cacheReadQuotaField');if(cqF)cqF.style.display=(p.protocol==='responses')?'':'none';
  const cqN=document.getElementById('cacheReadQuotaNote');if(cqN)cqN.style.display=(p.protocol==='responses')?'':'none';
  // Responses outbound endpoint is Responses-profile-only (hidden on Anthropic).
  const rpF=document.getElementById('responsesPathRow');if(rpF)rpF.style.display=(p.protocol==='responses')?'':'none';
  const rpI=document.getElementById('responsesPathInput');if(rpI)rpI.value=p.responsesPath||'/v1/responses';
  const bt=fm.querySelector('select[name="billingType"]');if(bt)bt.value=p.billingType||'on_demand';
  renderPeakHoursRows(p.peakHours||[]);
  refreshBridgeSelect(p);
  document.querySelectorAll('.pl-item').forEach(el=>el.classList.remove('active'));
  const el=document.getElementById('pl-'+n);
  if(el)el.classList.add('active');
  document.getElementById('profileSuffixInput').value=p.suffix||'';
  const userSel=document.getElementById('userProfileSel');
  if(userSel){userSel.value=p.suffix||'';renderProfileUsers(p.suffix||'')}
  updateAccessUrl();
}
function updateNewProfileProtocolHint(){
  var isResp=document.getElementById('newProfileProtocol').value==='responses';
  document.getElementById('newProfileUpstream').placeholder=isResp?'https://open.bigmodel.cn/api/v1':'https://open.bigmodel.cn/api/anthropic';
  document.getElementById('newProfileProtocolNote').textContent=isResp?'Codex 走 /v1/responses，上游必须是原生 Responses 端点（如智谱 /api/v1）。':'Claude Code 走 /v1/messages；Codex 走 /v1/responses。两种协议的方案完全隔离。';
  document.getElementById('newProfileResponsesPathBlock').style.display=isResp?'':'none';
}
async function createProfile(){
  const name=document.getElementById('newProfileName').value.trim();
  const suffix=document.getElementById('newProfileSuffix').value.trim();
  const upstream=document.getElementById('newProfileUpstream').value.trim();
  const protocol=document.getElementById('newProfileProtocol').value;
  if(!name||!suffix||!upstream){alert('方案名称、URL 后缀和上游 API 地址必填');return}
  const r=await fetch('/api/profile/save',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({
    profile:name,suffix:suffix,upstream:upstream,
    protocol:protocol,quotaPool:document.getElementById('newProfilePool')?.value||'',
    responsesPath:protocol==='responses'?(document.getElementById('newProfileResponsesPath').value||'').trim():''
  })});
  if(r.ok)toastThen('方案已创建 — 点击左侧方案配置模型别名',()=>location.reload());else{const e=await r.json();alert('创建失败: '+e.error)}
}
async function setDefaultProfile(n,protocol){
  const r=await fetch('/api/profile/default',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({profile:n,protocol:protocol||'anthropic'})});
  if(r.ok)toastThen('已设为默认方案',()=>location.reload());else{const e=await r.json();alert('设置失败: '+e.error)}
}
async function deleteProfile(n){
  if(!confirm('确定删除方案 "'+n+'"？'))return;
  const r=await fetch('/api/profile/delete',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({profile:n})});
  if(r.ok)toastThen('方案已删除',()=>location.reload());else{const e=await r.json();alert('删除失败: '+e.error)}
}
async function renameProfile(n){
  const nn=prompt('新的方案名称（后缀 /xxx 与用量统计不受影响）',n);
  if(!nn)return;
  const name=nn.trim();
  if(!name||name===n)return;
  const r=await fetch('/api/profile/rename',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({profile:n,name:name})});
  if(r.ok)toastThen('方案已重命名',()=>location.reload());else{const e=await r.json().catch(()=>({}));alert('重命名失败: '+(e.error||''))}
}
async function cloneProfile(n){
  const r=await fetch('/api/profile/clone',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({profile:n})});
  if(r.ok)toastThen('方案已复制（用户与真实Key不复制）',()=>location.reload());else{const e=await r.json().catch(()=>({}));alert('复制失败: '+(e.error||''))}
}
async function saveDefaultGroup(group){
  const r=await fetch('/api/profile/default-group',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({group:group,protocol:'anthropic'})});
  if(r.ok)toastThen('默认方案组已保存',()=>location.reload());else{const e=await r.json().catch(()=>({}));alert('保存失败: '+(e.error||''))}
}
function currentDefaultGroupFromDom(){return Array.prototype.map.call(document.querySelectorAll('#defaultGroupList .group-item'),function(el){return el.dataset.name})}
async function addToDefaultGroup(n){const g=currentDefaultGroupFromDom();if(!g.includes(n))g.push(n);saveDefaultGroup(g)}
async function removeFromDefaultGroup(n){saveDefaultGroup(currentDefaultGroupFromDom().filter(function(x){return x!==n}))}
async function moveDefaultGroup(n,d){const g=currentDefaultGroupFromDom();const i=g.indexOf(n);if(i<0)return;const j=i+d;if(j<0||j>=g.length)return;g.splice(i,1);g.splice(j,0,n);saveDefaultGroup(g)}
async function saveResponsesGroup(group){
  const r=await fetch('/api/profile/default-group',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({group:group,protocol:'responses'})});
  if(r.ok)toastThen('OpenAI 方案组已保存',()=>location.reload());else{const e=await r.json().catch(()=>({}));alert('保存失败: '+(e.error||''))}
}
function currentResponsesGroupFromDom(){return Array.prototype.map.call(document.querySelectorAll('#responsesGroupList .group-item'),function(el){return el.dataset.name})}
async function addToResponsesGroup(n){const g=currentResponsesGroupFromDom();if(!g.includes(n))g.push(n);saveResponsesGroup(g)}
async function removeFromResponsesGroup(n){saveResponsesGroup(currentResponsesGroupFromDom().filter(function(x){return x!==n}))}
async function moveResponsesGroup(n,d){const g=currentResponsesGroupFromDom();const i=g.indexOf(n);if(i<0)return;const j=i+d;if(j<0||j>=g.length)return;g.splice(i,1);g.splice(j,0,n);saveResponsesGroup(g)}
// ── 方案组「加入」弹卡：贴组区右侧，点选即加（reload 后自然关闭）──
let _groupPopId=null;
function toggleGroupAddPop(id,btn){
  const pop=document.getElementById(id);
  if(!pop)return;
  if(_groupPopId===id){closeGroupAddPop();return}
  closeGroupAddPop();
  pop.style.display='flex';
  const r=btn.getBoundingClientRect(),w=pop.offsetWidth;
  let left=r.right+8;
  if(left+w>innerWidth-8)left=Math.max(8,r.right-w);
  pop.style.left=left+'px';
  pop.style.top=Math.min(r.top,innerHeight-pop.offsetHeight-8)+'px';
  _groupPopId=id;
}
function closeGroupAddPop(){document.querySelectorAll('.group-add-pop').forEach(function(p){p.style.display='none'});_groupPopId=null}
document.addEventListener('click',function(e){
  if(!_groupPopId)return;
  if(e.target.closest('.group-add-pop')||e.target.closest('[data-grouppop-btn]'))return;
  closeGroupAddPop();
},true);
async function deleteGlobalUser(k){
  if(!confirm('确定删除用户？该用户将从所有方案中移除。'))return;
  const r=await fetch('/api/global-user/delete',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({key:k})});
  if(r.ok)toastThen('用户已删除',()=>location.reload());else{const e=await r.json();alert('删除失败: '+e.error)}
}
function renderProfileUsers(suffix){
  const assignments=SETTINGS.profileAssignments[suffix]||{};
  const tbody=document.querySelector("#profileUsersTable tbody");
  tbody.innerHTML=Object.entries(SETTINGS.globalUsers).map(([k,v])=>{
    const username=v.username||'';
    const globalDisabled=!!v.disabled;
    const pu=assignments[k]||null;
    const realKey=(pu&&pu.key)||'';
    const profileDisabled=!!(pu&&pu.disabled);
    const rowStyle=globalDisabled?'opacity:0.4':'';
    return '<tr style="'+rowStyle+'">'
      +'<td><code style="font-size:11px;color:var(--accent)">'+h(k)+'</code></td>'
      +'<td>'+h(username)+'</td>'
      +'<td><input type="text" name="pu_rk_'+h(k)+'" value="'+h(realKey)+'" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px;font-family:monospace" placeholder="真实Key (留空=不可用此方案)"></td>'
      +'<td><label style="display:inline-flex;align-items:center;gap:4px;margin:0;cursor:pointer;white-space:nowrap"><input type="checkbox" name="pu_dis_'+h(k)+'" '+(profileDisabled?'checked':'')+' style="width:auto;accent-color:var(--orange)"><span style="font-size:11px;color:'+(profileDisabled?'var(--orange)':'var(--dim)')+'">'+(profileDisabled?'已禁用':'正常')+'</span></label></td></tr>';
  }).join('');
}
function switchUserProfile(suffix){renderProfileUsers(suffix)}
async function saveUsers(){
  const tbody=document.querySelector("#globalUsersTable tbody");
  const rows=tbody.querySelectorAll("tr");
  const users=[];
  rows.forEach(tr=>{
    const hidden=tr.querySelector('input[type=hidden]');
    const vk=hidden?hidden.value:tr.querySelector('code')?.textContent?.trim()||'';
    const unInput=tr.querySelector('input[name^="gu_un_"]');
    const exInput=tr.querySelector('input[name^="gu_ex_"]');
    const disInput=tr.querySelector('input[name^="gu_dis_"]');
    const adInput=tr.querySelector('input[name^="gu_su_"]');
    if(!vk||!unInput)return;
    users.push({key:vk,username:unInput.value||vk.slice(0,8),expiresAt:exInput?exInput.value:'',disabled:disInput?disInput.checked:false,superUser:adInput?adInput.checked:false});
  });
  const ptbody=document.querySelector("#profileUsersTable tbody");
  const prows=ptbody.querySelectorAll("tr");
  const profileUsers=[];
  prows.forEach(tr=>{
    const vk=tr.querySelector('code')?.textContent?.trim()||'';
    const rkInput=tr.querySelector('input[name^="pu_rk_"]');
    const disInput=tr.querySelector('input[name^="pu_dis_"]');
    if(!vk)return;
    profileUsers.push({key:vk,realKey:rkInput?rkInput.value.trim():'',disabled:disInput?disInput.checked:false});
  });
  const profileSuffix=document.getElementById('userProfileSel').value;
  const r=await fetch('/api/global-user/save',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({users,profileUsers,profileSuffix})});
  if(r.ok){toastThen('用户配置已保存',()=>location.reload())}else{const e=await r.json();alert('保存失败: '+e.error)}
}
// ── 今日临时额度（bonus / reset）弹窗 ──────────────────────────────────────
function qFmt(n){n=Number(n)||0;if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'k';return String(n)}
const QUOTA_OP_CTX={suffix:'',key:''};
function qoOp(){const pool=QUOTA_OPS_BY_POOL[qoKey(QUOTA_OP_CTX.suffix,'')];return pool?pool[QUOTA_OP_CTX.key]:undefined}
function openQuotaOp(key){
  const suffix=document.getElementById('userProfileSel').value;
  QUOTA_OP_CTX.suffix=suffix;QUOTA_OP_CTX.key=key;
  const username=((SETTINGS.globalUsers||{})[key]||{}).username||key.slice(0,8);
  const profile=(SETTINGS.profiles||[]).find(p=>p.suffix===suffix)||{};
  const pool=(SETTINGS.quotaPools||[]).find(p=>p.profiles.some(m=>m.suffix===suffix));
  const userLimit=pool?((pool.userLimits||{})[key]||0):0;
  const poolLimit=pool?(pool.dailyTokenLimit||0):0;
  const base=userLimit>0?userLimit:poolLimit;
  // Note the unit when weighting is on: bonus/reset amounts are weighted tokens,
  // not raw ones, so an admin typing "1,000,000" is granting 1M of quota currency.
  const weighted=(profile.peakQuotaRate!==undefined&&(profile.peakQuotaRate!==1||profile.offPeakQuotaRate!==1));
  const poolNote=pool&&pool.profiles.length>1?' · 额度池「'+h(pool.label)+'」'+pool.profiles.length+' 个方案共用':'';
  document.getElementById('qoTitle').textContent='临时额度 · '+username;
  document.getElementById('qoInfo').innerHTML='额度池：'+h(pool?pool.label:'')+' · 基础每日配额：'+(base>0?(base.toLocaleString('zh-CN')+(userLimit>0?'（个人）':'（池级）')+(poolNote)+(weighted?' <span style="color:var(--accent)">· 计权口径（峰 ×'+profile.peakQuotaRate+' / 谷 ×'+profile.offPeakQuotaRate+'）</span>':'')):'<span style="color:var(--orange)">未设置（当前无限制）</span>');
  document.getElementById('qoBonusInput').value='';
  const noBase=!(base>0);
  document.getElementById('qoSetBtn').disabled=noBase;
  document.getElementById('qoResetBtn').disabled=noBase;
  document.getElementById('qoResetBtn').title=noBase?'该用户与额度池均未设置每日配额，无限制状态下无需重置':'';
  qoRenderStatus();
  document.getElementById('quotaOpModal').classList.add('open');
}
function closeQuotaOpModal(){document.getElementById('quotaOpModal').classList.remove('open')}
document.getElementById('quotaOpModal').addEventListener('click',function(e){if(e.target===this)closeQuotaOpModal()});
function qoRenderStatus(q){
  const op=qoOp();
  const parts=[];
  if(op&&op.bonus>0)parts.push('<span style="font-size:11px;color:var(--green);border:1px solid var(--green);border-radius:3px;padding:1px 5px">今日临时 +'+qFmt(op.bonus)+'</span>');
  if(op&&op.reset_baseline>0)parts.push('<span style="font-size:11px;color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:1px 5px">今日已重置</span>');
  if(q&&q.limit>0)parts.push('<span style="font-size:11px;color:var(--dim)">生效额度 '+q.limit.toLocaleString('zh-CN')+' · 已用 '+q.used.toLocaleString('zh-CN')+' · 剩余 '+q.remaining.toLocaleString('zh-CN')+'</span>');
  if(q&&q.rawUsed!=null&&q.rawUsed!==q.used){const d=q.rawUsed-q.used;parts.push('<span style="font-size:11px;color:var(--accent)">实际 '+q.rawUsed.toLocaleString('zh-CN')+'（'+(q.inPeak?'高峰':'低谷')+' ×'+q.rate+(d>0?' 已抵扣 '+qFmt(d):' 已加收 '+qFmt(-d))+'）</span>')}
  if(!op&&!q)parts.push('<span style="font-size:12px;color:var(--dim)">今日暂无手工操作</span>');
  document.getElementById('qoStatus').innerHTML=parts.join(' ');
  document.getElementById('qoClearBtn').style.display=op?'':'none';
}
function qoQuickAdd(n){const el=document.getElementById('qoBonusInput');el.value=((parseInt(el.value,10)||0)+n)}
async function qoPost(action,amount){
  let r,data;
  try{
    r=await fetch('/api/quota/daily-op',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({profileSuffix:QUOTA_OP_CTX.suffix,key:QUOTA_OP_CTX.key,action:action,amount:amount})});
    data=await r.json();
  }catch(err){alert('操作失败: '+err.message);return null}
  if(!r.ok){alert('操作失败: '+(data&&data.error?data.error:r.status));return null}
  const poolName=qoKey(QUOTA_OP_CTX.suffix,'');
  if(data.quota&&(data.quota.bonus>0||data.quota.resetApplied)){
    (QUOTA_OPS_BY_POOL[poolName]=QUOTA_OPS_BY_POOL[poolName]||{})[QUOTA_OP_CTX.key]={bonus:data.quota.bonus||0,reset_baseline:data.quota.resetApplied?1:0};
  } else if(QUOTA_OPS_BY_POOL[poolName]) {
    delete QUOTA_OPS_BY_POOL[poolName][QUOTA_OP_CTX.key];
  }
  renderProfileUsers(QUOTA_OP_CTX.suffix);
  return data.quota;
}
async function qoSetBonus(){
  const raw=document.getElementById('qoBonusInput').value.trim();
  const n=parseInt(raw===''?'0':raw,10);
  if(isNaN(n)||n<0){alert('请输入 ≥0 的整数 token 数');return}
  const q=await qoPost('bonus',n);
  if(q){toast(n>0?('已设置今日临时加量 +'+qFmt(n)+'，明日自动失效'):'已清除今日临时加量');qoRenderStatus(q)}
}
async function qoReset(){
  if(!confirm('确定重置该用户今日用量？\n配额将立即恢复满额，可继续使用；用量统计与报表数据保留不动。'))return;
  const q=await qoPost('reset');
  if(q){toast('今日用量已重置');qoRenderStatus(q)}
}
async function qoClear(){
  if(!confirm('确定撤销该用户今日全部手工额度操作（临时加量与重置）？'))return;
  const q=await qoPost('clear');
  if(q){toast('已撤销今日手工额度操作');qoRenderStatus(q)}
}
function genVK(){const c="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";const a=new Uint8Array(24);crypto.getRandomValues(a);let k="jx-";for(let i=0;i<24;i++)k+=c[a[i]%c.length];return k}
function addGlobalUser(){
  const tbody=document.querySelector("#globalUsersTable tbody");
  const tr=document.createElement("tr");
  const vk=genVK();
  tr.innerHTML='<td><code style="font-size:11px;color:var(--accent);user-select:all">'+vk+'</code><input type="hidden" name="gu_new_'+vk+'" value="'+vk+'"></td>'
    +'<td><input type="text" name="gu_un_new_'+vk+'" placeholder="用户名" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px"></td>'
    +'<td><input type="datetime-local" name="gu_ex_new_'+vk+'" onclick="openDateTimePicker(this)" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:3px 6px;border-radius:4px;font-size:11px"></td>'
    +'<td><label style="display:inline-flex;align-items:center;gap:4px;margin:0;cursor:pointer;white-space:nowrap"><input type="checkbox" name="gu_dis_new_'+vk+'" style="width:auto;accent-color:var(--red)"><span style="font-size:11px;color:var(--dim)">正常</span></label></td>'
    +'<td><label style="display:inline-flex;align-items:center;gap:4px;margin:0;cursor:pointer;white-space:nowrap" title="超级用户：可直连任意方案并借用其真实Key，不受限制策略约束"><input type="checkbox" name="gu_su_new_'+vk+'" style="width:auto;accent-color:var(--accent)"><span style="font-size:11px;color:var(--dim)">常规</span></label></td>'
    +'<td><button type="button" onclick="this.closest(\'tr\').remove()" style="background:#fff2f0;color:var(--red);border:1px solid #f1c8c2;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;white-space:nowrap">删除</button></td>';
  tbody.appendChild(tr);
  SETTINGS.globalUsers[vk]={username:'',expiresAt:'',disabled:false,superUser:false};
  for(const p of SETTINGS.profiles){if(!SETTINGS.profileAssignments[p.suffix])SETTINGS.profileAssignments[p.suffix]={}}
  renderProfileUsers(document.getElementById('userProfileSel').value);
}
function fillUpstream(url){
  document.querySelector('[name=upstream]').value=url;
}
// ── 模型别名的结构化行编辑器 ─────────────────────────────────────────────
// 通用别名行 ma_alias_N/ma_model_N/ma_ctx_N；高峰覆盖行 pa_alias_N/pa_model_N。
// 行增删后统一重排索引；允许模型标签实时汇总所有实际模型。
const CW_OPTIONS=[[32768,'32K（32,768）'],[65536,'64K（65,536）'],[128000,'128K（128,000）'],[200000,'200K（200,000）'],[262144,'256K（262,144）'],[400000,'400K（400,000）'],[1048576,'1M（1,048,576）']];
function cwSelectHtml(name,val){return '<select name="'+name+'">'+CW_OPTIONS.map(o=>'<option value="'+o[0]+'"'+(String(o[0])===String(val||128000)?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>'}
function renumberRows(prefix){
  const wrap=prefix==='ma'?document.getElementById('aliasRows'):prefix==='mr'?document.getElementById('rateRows'):document.getElementById('peakRows');
  const rows=[...wrap.querySelectorAll('.alias-row')];
  rows.forEach((row,i)=>{row.querySelectorAll('[name^="'+prefix+'_"]').forEach(el=>{
    const parts=el.name.split('_');el.name=prefix+'_'+parts[1]+'_'+i;});});
}
function collectAliasRows(){
  return [...document.querySelectorAll('#aliasRows .alias-row')].map(row=>({
    alias:row.querySelector('[name^="ma_alias_"]').value.trim(),
    model:row.querySelector('[name^="ma_model_"]').value.trim(),
  }));
}
function refreshPeakSelects(){
  const names=collectAliasRows().filter(r=>r.alias).map(r=>r.alias);
  document.querySelectorAll('#peakRows .alias-row select[name^="pa_alias_"]').forEach(sel=>{
    const keep=sel.value;sel.innerHTML='<option value="">选择别名…</option>'+names.map(n=>'<option value="'+n+'"'+(n===keep?' selected':'')+'>'+n+'</option>').join('');
    if(keep&&!names.includes(keep))sel.value='';
  });
}
function updateAllowedTags(){
  const models=[...new Set([...document.querySelectorAll('#aliasRows [name^="ma_model_"], #peakRows [name^="pa_model_"]')].map(el=>el.value.trim()).filter(Boolean))];
  const box=document.getElementById('allowedTags');
  box.innerHTML=models.length?models.map(m=>'<span class="m-tag">'+m.replace(/</g,'&lt;')+'</span>').join(''):'<span class="m-empty">暂无——填入别名实际模型后自动生成</span>';
}
function aliasRowEl(alias,model,cw,mm){
  const div=document.createElement('div');div.className='alias-row';
  div.innerHTML='<input type="text" name="ma_alias_0" value="'+String(alias||'').replace(/"/g,'&quot;')+'" placeholder="别名，如 jx-opus" list="stdAliasList">'
    +'<input type="text" name="ma_model_0" value="'+String(model||'').replace(/"/g,'&quot;')+'" placeholder="实际模型，如 glm-5.3">'
    +cwSelectHtml('ma_ctx_0',cw||128000)
    +'<label class="mm-cell" title="勾选=该别名原生支持视觉（图片直通，且可作为图片识别辅助模型）；不勾选=该别名贴图时由网关自动转述">'
    +'<input type="checkbox" name="ma_mm_0"'+(mm!==false?' checked':'')+'>图</label>'
    +'<button type="button" class="row-del" title="删除该行">×</button>';
  div.querySelector('.row-del').onclick=()=>{div.remove();renumberRows('ma');refreshPeakSelects();updateAllowedTags()};
  return div;
}
function peakRowEl(alias,model){
  const div=document.createElement('div');div.className='alias-row peak';
  div.innerHTML='<select name="pa_alias_0"></select>'
    +'<input type="text" name="pa_model_0" value="'+String(model||'').replace(/"/g,'&quot;')+'" placeholder="高峰期实际模型">'
    +'<button type="button" class="row-del" title="删除该行">×</button>';
  div.querySelector('.row-del').onclick=()=>{div.remove();renumberRows('pa');updateAllowedTags()};
  return div;
}
function addAliasRow(presetName){
  const row=aliasRowEl(presetName||'','',128000,true);
  document.getElementById('aliasRows').appendChild(row);
  renumberRows('ma');refreshPeakSelects();updateAllowedTags();
  (presetName?row.querySelector('[name^="ma_model_"]'):row.querySelector('[name^="ma_alias_"]')).focus();
}
function addPeakRow(){document.getElementById('peakRows').appendChild(peakRowEl('',''));renumberRows('pa');refreshPeakSelects();updateAllowedTags()}
// ── Per-model quota rates ────────────────────────────────────────────────────
// Keyed on the REAL model name (what the upstream echoes and what the usage
// tables store), picked from a dropdown of the profile's alias targets so a typo
// cannot silently fall back to the default rate.
function allRateModels(){
  return [...new Set([...document.querySelectorAll('#aliasRows [name^="ma_model_"], #peakRows [name^="pa_model_"]')]
    .map(el=>el.value.trim()).filter(Boolean))].sort();
}
function rateRowEl(model,peak,off){
  const div=document.createElement('div');div.className='alias-row rate';
  div.innerHTML='<select name="mr_model_0"></select>'
    +'<input type="number" name="mr_peak_0" min="0" max="+QUOTA_RATE_MAX+" step="0.05" value="'+(peak==null?'':peak)+'" placeholder="高峰">'
    +'<input type="number" name="mr_off_0" min="0" max="+QUOTA_RATE_MAX+" step="0.05" value="'+(off==null?'':off)+'" placeholder="低谷">'
    +'<span class="rate-eff"></span>'
    +'<button type="button" class="row-del" title="删除该行">×</button>';
  div.querySelector('.row-del').onclick=()=>{div.remove();renumberRows('mr');updateRateRowsHint()};
  div.addEventListener('input',updateRateRowsHint);
  refreshRateSelect(div.querySelector('select[name^="mr_model_"]'),model);
  return div;
}
function refreshRateSelect(sel,want){
  if(!sel)return;
  const keep=want!==undefined?want:sel.value;
  const models=allRateModels();
  sel.innerHTML='<option value="">选择模型…</option>'+models.map(m=>'<option value="'+m.replace(/"/g,'&quot;')+'"'+(m===keep?' selected':'')+'>'+m.replace(/</g,'&lt;')+'</option>').join('');
  // A rate configured for a model no longer referenced by any alias would vanish
  // silently on save; keep it visible and explicitly flagged instead.
  if(keep&&!models.includes(keep)){
    sel.insertAdjacentHTML('beforeend','<option value="'+keep.replace(/"/g,'&quot;')+'">'+keep.replace(/</g,'&lt;')+'（未在别名中引用）</option>');
  }
  sel.value=keep||'';
}
function refreshAllRateSelects(){
  document.querySelectorAll('#rateRows select[name^="mr_model_"]').forEach(sel=>refreshRateSelect(sel));
  updateRateRowsHint();
}
function addRateRow(model,peak,off){
  document.getElementById('rateRows').appendChild(rateRowEl(model||'',peak,off));
  renumberRows('mr');updateRateRowsHint();
}
// Convenience: one row per model still lacking an explicit rate, prefilled with
// the profile default so the admin edits numbers instead of hunting model names.
function fillAllRateRows(){
  const have=new Set([...document.querySelectorAll('#rateRows select[name^="mr_model_"]')].map(s=>s.value).filter(Boolean));
  const dp=Number(document.getElementById('peakQuotaRateInput').value),
        dof=Number(document.getElementById('offPeakQuotaRateInput').value);
  allRateModels().filter(m=>!have.has(m)).forEach(m=>addRateRow(m,Number.isFinite(dp)?dp:1,Number.isFinite(dof)?dof:1));
}
function renderRateRows(profile){
  const wrap=document.getElementById('rateRows');
  if(!wrap)return;
  wrap.innerHTML='';
  Object.entries(profile.modelQuotaRates||{}).forEach(([m,r])=>wrap.appendChild(rateRowEl(m,r.peak,r.offPeak)));
  renumberRows('mr');updateRateRowsHint();
}
function updateRateRowsHint(){
  const el=document.getElementById('rateRowsHint');
  if(!el)return;
  const rows=[...document.querySelectorAll('#rateRows .alias-row')];
  const peakEl=document.getElementById('peakQuotaRateInput'),offEl=document.getElementById('offPeakQuotaRateInput');
  const dp=peakEl?Number(peakEl.value):1,dof=offEl?Number(offEl.value):1;
  const inPeak=nowInPeakHours(collectPeakHours());
  // Per-row "current" cell: what a request for that model would cost right now.
  const priced=new Set();
  rows.forEach(row=>{
    const m=row.querySelector('select[name^="mr_model_"]').value;
    const p=Number(row.querySelector('[name^="mr_peak_"]').value),o=Number(row.querySelector('[name^="mr_off_"]').value);
    const cell=row.querySelector('.rate-eff');
    if(m)priced.add(m);
    if(!m){cell.textContent='未选择模型';cell.style.color='var(--orange)';return}
    const eff=inPeak?p:o;
    if(!Number.isFinite(eff)){cell.textContent='倍率无效 → 归一为 1.0';cell.style.color='var(--orange)';return}
    cell.textContent='×'+eff+(inPeak?'（高峰）':'（低谷）');
    cell.style.color='var(--dim)';
  });
  const dupes=rows.map(r=>r.querySelector('select[name^="mr_model_"]').value).filter(Boolean)
    .filter((m,i,arr)=>arr.indexOf(m)!==i);
  if(dupes.length){el.innerHTML='<b style="color:var(--orange)">注意：模型 "'+h(dupes[0])+'" 配置了多行，保存时以最后一行为准</b>';el.style.color='var(--orange)';return}
  const uncovered=allRateModels().filter(m=>!priced.has(m));
  el.innerHTML=(rows.length?'已单独定价 '+priced.size+' 个模型。':'')
    +(uncovered.length?'其余 '+uncovered.length+' 个模型走默认倍率（'+(inPeak?'高峰 ×'+dp:'低谷 ×'+dof)+'）：'+uncovered.map(m=>h(m)).join('、'):'全部模型均已单独定价。');
  el.style.color='var(--dim)';
}
function renderAliasRows(profile){
  const wrap=document.getElementById('aliasRows');wrap.innerHTML='';
  const aliases=profile.modelAliases||{},ctxs=profile.modelContextWindows||{},mms=profile.modelMultimodal||{};
  const names=Object.keys(aliases);
  if(names.length){names.forEach(n=>wrap.appendChild(aliasRowEl(n,aliases[n],ctxs[n]||profile.contextWindow||128000,mms[n]!==false)))}
  else{['jx-fable','jx-opus','jx-haiku','jx-sonnet'].forEach(n=>wrap.appendChild(aliasRowEl(n,'',ctxs[n]||128000,true)))}
  renumberRows('ma');
  const pwrap=document.getElementById('peakRows');pwrap.innerHTML='';
  const peakEntries=Object.entries(profile.peakModelAliases||{});
  peakEntries.forEach(([n,m])=>pwrap.appendChild(peakRowEl(n,m)));
  renumberRows('pa');refreshPeakSelects();
  // refreshPeakSelects rebuilds each select's options; now restore the saved
  // alias choice per row (row order matches peakEntries order). A stale name
  // not among the defined aliases gets an explicitly marked option so it is
  // visible rather than silently dropped.
  pwrap.querySelectorAll('.alias-row').forEach((row,i)=>{
    const sel=row.querySelector('select[name^="pa_alias_"]');
    if(sel&&peakEntries[i]){
      const want=peakEntries[i][0];
      if(want&&![...sel.options].some(o=>o.value===want)){
        sel.insertAdjacentHTML('beforeend','<option value="'+want.replace(/"/g,'&quot;')+'">'+want.replace(/</g,'&lt;')+'（未在通用别名中定义）</option>');
      }
      sel.value=want;
    }
  });
  refreshBridgeSelect(profile);
  renderRateRows(profile);
  updateAllowedTags();
}
// Rebuild the image-bridge helper-model dropdown from the profile's multimodal
// aliases, keeping the current selection when still valid.
function refreshBridgeSelect(profile){
  const sel=document.getElementById('imgBridgeModel');
  if(!sel)return;
  const aliases=profile.modelAliases||{},mms=profile.modelMultimodal||{};
  // Seed from THIS profile's saved helper, not the DOM's current value. The page
  // renders the select for the default profile, then repopulates it per-profile on
  // switch; reading sel.value here would carry the previous/default profile's model
  // over (blank or stale) instead of the one the edited profile actually stores.
  const keep=(profile.imageBridge&&profile.imageBridge.model)||'';
  const options=Object.keys(aliases).filter(a=>mms[a]!==false).map(a=>'<option value="'+String(aliases[a]).replace(/"/g,'&quot;')+'"'+(String(aliases[a])===keep?' selected':'')+'>'+a+' → '+String(aliases[a]).replace(/</g,'&lt;')+'</option>').join('');
  sel.innerHTML='<option value="">未选择</option>'+options;
  if(keep&&![...sel.options].some(o=>o.value===keep))sel.value='';
  else sel.value=keep;
}
// Editing an alias's target model changes the set of models the rate rows can
// point at, so keep those dropdowns in sync with every keystroke.
document.getElementById('aliasRows').addEventListener('input',()=>{refreshPeakSelects();updateAllowedTags();refreshAllRateSelects()});
document.getElementById('peakRows').addEventListener('input',()=>{updateAllowedTags();refreshAllRateSelects()});
// Init LAST: editProfile/switchProtoTab assign let-declared module state
// (editingProfileName), so running this any earlier throws a TDZ ReferenceError
// and leaves the alias rows unrendered.
(function(){var saved=null;try{saved=localStorage.getItem('tm_settings_proto_tab')}catch(e){}
if(saved==='responses'){try{switchProtoTab('responses')}catch(e){}}
else{renderAliasRows(SETTINGS.profiles.find(p=>p.suffix===SETTINGS.selectedProfileSuffix)||SETTINGS.profiles[0]||{})}
// Pool ops (save/create/delete) set a one-shot flag so the reload lands back on
// the 额度池 view instead of the profile form. sessionStorage = once only, this
// session; a fresh open of the settings page starts on profiles as usual.
try{if(sessionStorage.getItem('tm_return_pool_view')==='1'){sessionStorage.removeItem('tm_return_pool_view');openQuotaPoolView()}}catch(e){}
})();
document.addEventListener("keydown",e=>{if(e.key==="Enter"&&e.target.tagName!=="TEXTAREA"&&e.target.tagName!=="INPUT")e.preventDefault()});
// ─── 产出与成本设置(参考牌价表 + 产出解析开关;走 /api/production/settings,独立于 settings-save 表单)───
// 峰时段复用各方案设置里的「高峰时段」,此处不再单独配置;项目名归并功能已移除。
function costRateRow(m,r,i){
  return '<div data-i="'+i+'" style="display:flex;gap:6px;margin:4px 0;align-items:center">'
    +'<input class="cr-model" value="'+h(m)+'" placeholder="模型名(支持前缀)" style="flex:2;min-width:0">'
    +'<input class="cr-in" type="number" step="0.01" min="0" value="'+Number(r.input||0)+'" placeholder="输入" style="flex:1;min-width:0">'
    +'<input class="cr-out" type="number" step="0.01" min="0" value="'+Number(r.output||0)+'" placeholder="输出" style="flex:1;min-width:0">'
    +'<input class="cr-cw" type="number" step="0.01" min="0" value="'+Number(r.cacheWrite||0)+'" placeholder="缓存写" style="flex:1;min-width:0">'
    +'<input class="cr-cr" type="number" step="0.01" min="0" value="'+Number(r.cacheRead||0)+'" placeholder="缓存读" style="flex:1;min-width:0">'
    +'<input class="cr-pin" type="number" step="0.01" min="0" value="'+(r.peakInput==null?'':r.peakInput)+'" placeholder="峰In" style="flex:1;min-width:0">'
    +'<input class="cr-pout" type="number" step="0.01" min="0" value="'+(r.peakOutput==null?'':r.peakOutput)+'" placeholder="峰Out" style="flex:1;min-width:0">'
    +'<input class="cr-pcw" type="number" step="0.01" min="0" value="'+(r.peakCacheWrite==null?'':r.peakCacheWrite)+'" placeholder="峰缓存写" style="flex:1;min-width:0">'
    +'<input class="cr-pcr" type="number" step="0.01" min="0" value="'+(r.peakCacheRead==null?'':r.peakCacheRead)+'" placeholder="峰缓存读" style="flex:1;min-width:0">'
    +'<button type="button" class="btn btn-outline btn-sm" onclick="this.parentElement.remove()">删</button></div>';
}
function addCostRateRow(m,r){document.getElementById('costRateRows').insertAdjacentHTML('beforeend',costRateRow(m,r,document.querySelectorAll('#costRateRows > div').length))}
function saveProdSettings(){
  const costRates={};
  document.querySelectorAll('#costRateRows > div').forEach(row=>{
    const m=row.querySelector('.cr-model').value.trim();if(!m)return;
    costRates[m]={input:+row.querySelector('.cr-in').value||0,output:+row.querySelector('.cr-out').value||0,
      cacheWrite:+row.querySelector('.cr-cw').value||0,cacheRead:+row.querySelector('.cr-cr').value||0,
      peakInput:row.querySelector('.cr-pin').value.trim(),peakOutput:row.querySelector('.cr-pout').value.trim(),
      peakCacheWrite:row.querySelector('.cr-pcw').value.trim(),peakCacheRead:row.querySelector('.cr-pcr').value.trim()};
  });
  const msg=document.getElementById('prodSettingsMsg');
  msg.textContent='保存中...';
  fetch('/api/production/settings',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),
    body:JSON.stringify({productionTracking:{enabled:document.getElementById('prodTrackingToggle').checked,storeFilePaths:document.getElementById('prodPathToggle').checked},costRates:costRates})})
    .then(r=>r.json()).then(()=>{msg.textContent='已保存';setTimeout(()=>location.reload(),600)})
    .catch(e=>{msg.textContent='保存失败: '+e.message});
}
(function(){
  document.getElementById('prodTrackingToggle').checked=INITIAL_PROD.productionTracking.enabled!==false;
  document.getElementById('prodPathToggle').checked=INITIAL_PROD.productionTracking.storeFilePaths!==false;
  const rates=INITIAL_PROD.costRates||{};
  const names=Object.keys(rates);
  if(names.length){names.forEach(m=>addCostRateRow(m,rates[m]))}
  else{addCostRateRow('',{input:0,output:0,cacheWrite:0,cacheRead:0})}
})();
