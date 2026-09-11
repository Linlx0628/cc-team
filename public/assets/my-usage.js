Chart.defaults.color='#686863';Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei","Segoe UI",sans-serif';Chart.defaults.font.size=11;
// public/assets/my-usage.js —— 个人用量页（personalUsageHtml，/my-usage?key= 与 /usage/:key
// 共用）的客户端逻辑。页面内联引导脚本先注入以下全局再加载本文件：
//   VK（虚拟 key）/ toast() 及 UI_HELPERS 提供的辅助函数
// 其余数据均由本文件运行时经 /api/my-usage 拉取，文件可长期强缓存（?v= 内容版本号）。
let D=null,C={h:null,t:null},currentProfile='all',PROTO='';
const fmtT=n=>n.toLocaleString("zh-CN");
// Profile names come from admin-authored config; this page renders them into
// markup, so escape here rather than trusting them.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtTk=n=>{if(n>=1e6)return(n/1e6).toFixed(1)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"k";return n.toString()};
const COL=["#2f6e50","#4a6fa5","#c2604f","#c4a23a","#7a6bb0","#d4824a","#4a9ba8","#c47a99","#6ba368","#5a6bc4","#8a6db5","#5a9b8e"];
// ── Daily check-in ──
function fmtWan(n){if(n>=1e8)return(Math.round(n/1e8*10)/10)+'亿';if(n>=1e4)return(Math.round(n/1e4*10)/10)+'万';return String(n)}
// Bonus attribution: when today's check-in reward is part of the bonus, the
// copy must not credit it all to the admin.
function bonusTip(){const c=D&&D.checkin;return (c&&c.checkedInToday)?'今日临时加量（含签到奖励），明日自动失效':'管理员今日临时加量，明日自动失效'}
function renderCheckin(){
  const bar=document.getElementById('checkinBar'),c=D.checkin;
  if(!bar)return;
  if(!c||!c.available||c.enabled===false){bar.classList.remove('show');return}
  bar.classList.add('show');
  const stats='<div class="ci-stats"><div><b>'+c.streak+'</b><span>连续签到</span></div><div><b>'+c.totalCheckIns+'</b><span>累计签到</span></div><div><b>'+fmtTk(c.totalTokens)+'</b><span>累计获得</span></div></div>';
  if(c.checkedInToday){
    const pools=(c.todayPools||[]).length;
    bar.innerHTML='<div><div class="ci-title"><span class="ci-check">✓</span>今日已签到</div><div class="ci-sub">获得 <b>+'+fmtT(c.todayAmount)+'</b> token'+(pools>1?' · 已加入 '+pools+' 个额度池':' · 已加入额度池')+'（今日有效，明日自动失效）</div></div>'+stats+'<button type="button" class="btn-checkin" disabled>已签到</button>';
  }else{
    bar.innerHTML='<div><div class="ci-title">每日签到</div><div class="ci-sub">今日随机 <b>+'+fmtWan(c.minTokens)+' ~ '+fmtWan(c.maxTokens)+'</b> token，加到你可用的每个额度池（今日有效）</div></div>'+stats+'<button type="button" class="btn-checkin" id="ciBtn" onclick="doCheckIn()">签到领 token</button>';
  }
}
async function doCheckIn(){
  const btn=document.getElementById('ciBtn');
  if(!btn||btn.disabled)return;
  btn.disabled=true;btn.textContent='签到中…';
  try{
    const r=await fetch('/api/checkin',{method:'POST',headers:{'Authorization':'Bearer '+VK}});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||'签到失败');
    toast('签到成功！获得 '+fmtTk(j.amount)+' token，已加入 '+j.pools.length+' 个额度池');
    await load();
  }catch(e){
    toast(e.message||'签到失败');
    btn.disabled=false;btn.textContent='签到领 token';
  }
}
// ── Quota request ──
function qrBadge(s){
  if(s==='pending')return '<span class="qr-badge pending">待处理</span>';
  if(s==='handled')return '<span class="qr-badge handled">已加量</span>';
  if(s==='rejected')return '<span class="qr-badge rejected">已驳回</span>';
  return '';
}
function fmtQrTime(iso){const d=new Date(new Date(iso).getTime()+8*3600000);const p=n=>String(n).padStart(2,'0');return (d.getUTCMonth()+1)+'-'+p(d.getUTCDate())+' '+p(d.getUTCHours())+':'+p(d.getUTCMinutes())}
function renderQuotaRequest(){
  const btn=document.getElementById('qrBtn'),qr=D.quotaRequest;
  if(!btn)return;
  if(!qr||!qr.available||qr.enabled===false){btn.style.display='none';return}
  btn.style.display='';
  btn.textContent=qr.todaySubmitted?'今日已申请':(qr.remaining>0?'申请加量':'申请 · 本周已满');
  if(document.getElementById('qrModal').classList.contains('open'))renderQrBody();
}
function renderQrBody(){
  const qr=D.quotaRequest;
  if(!qr)return;
  document.getElementById('qrQuotaInfo').innerHTML='提交后管理员会收到通知，处理结果会显示在这里。提交不占用次数，管理员<b>处理后</b>才计入每周 '+qr.weeklyLimit+' 次上限（本周已处理 '+qr.handledThisWeek+' 次，周一刷新）；每天限提交 1 次。';
  const rows=qr.myRecent||[];
  document.getElementById('qrHistory').innerHTML='<div class="qr-hd">我的近期申请</div>'
    +(rows.length?rows.map(r=>'<div class="qr-row">'+qrBadge(r.status)+'<span class="qr-reason" title="'+esc(r.reason)+'">'+esc(r.reason)+'</span>'+(r.poolLabel?'<span class="qr-amt">'+esc(r.poolLabel)+'</span>':'')+'<span class="qr-time">'+fmtQrTime(r.createdAt)+'</span>'+(r.adminNote?'<span class="qr-note">管理员备注：'+esc(r.adminNote)+'</span>':'')+'</div>').join(''):'<div class="qr-empty">还没有申请记录</div>');
  const sel=document.getElementById('qrPool');
  sel.innerHTML=(qr.pools||[]).map(p=>'<option value="'+esc(p.name)+'"'+(p.limited?'':' disabled')+'>'+esc(p.label)+(p.limited?'':'（不限量，无需申请）')+'</option>').join('');
  const blocked=qr.todaySubmitted||qr.remaining<=0;
  document.getElementById('qrSubmit').disabled=blocked;
  document.getElementById('qrSubmit').textContent=qr.todaySubmitted?'今天已申请过':(qr.remaining<=0?'本周处理次数已用完':'提交申请');
}
function openQrModal(){renderQrBody();document.getElementById('qrReason').value='';document.getElementById('qrModal').classList.add('open')}
function closeQrModal(){document.getElementById('qrModal').classList.remove('open')}
async function submitQuotaRequest(){
  const pool=document.getElementById('qrPool').value;
  const reason=document.getElementById('qrReason').value.trim();
  const btn=document.getElementById('qrSubmit');
  if(!pool){toast('请选择申请的额度池');return}
  if(!reason){toast('请填写申请理由');return}
  btn.disabled=true;btn.textContent='提交中…';
  try{
    const r=await fetch('/api/quota-request',{method:'POST',headers:{'Authorization':'Bearer '+VK,'Content-Type':'application/json'},body:JSON.stringify({reason:reason,pool:pool})});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||'提交失败');
    toast('申请已提交，等待管理员处理');
    closeQrModal();
    await load();
  }catch(e){
    toast(e.message||'提交失败');
    btn.disabled=false;btn.textContent='提交申请';
  }
}
// ── Usage calendar (GitHub-style heatmap) ──
const CAL_COLORS=['#e9e9e3','#cfe3d7','#9dc4ab','#5f9a7a','#2f6e50'];
function calWeekday(dateStr){return (new Date(dateStr+'T12:00:00Z').getUTCDay()+6)%7}
function calMonthDay(dateStr){return parseInt(dateStr.slice(5,7),10)+'月'+parseInt(dateStr.slice(8,10),10)+'日'}
function renderCalendar(){
  const box=document.getElementById('calendarBox'),hm=D.heatmap;
  if(!box||!hm||!Array.isArray(hm.days)){box.style.display='none';return}
  box.style.display='';
  const s=hm.summary;
  document.getElementById('calSummary').innerHTML=(s&&s.activeDays>0)
    ?'过去一年共 <b>'+fmtTk(s.totalTokens)+'</b> token（输入+输出） · 活跃 <b>'+s.activeDays+'</b> 天 · 最长连续使用 <b>'+s.longestStreak+'</b> 天'+(s.maxDay?' · 最高单日 <b>'+calMonthDay(s.maxDay.date)+' · '+fmtTk(s.maxDay.total)+'</b>':'')
    :'过去一年暂无使用记录——开始使用后，这里会像 GitHub 一样点亮你的每一天';
  const byDate={};hm.days.forEach(d=>{byDate[d.date]=d});
  const cells=[];
  for(let i=0;i<calWeekday(hm.startDate);i++)cells.push(null);
  const start=new Date(hm.startDate+'T12:00:00Z'),end=new Date(hm.endDate+'T12:00:00Z');
  const todayStr=hm.endDate;
  for(let cur=new Date(start);cur<=end;cur=new Date(cur.getTime()+86400000)){
    const ds=cur.toISOString().slice(0,10),v=byDate[ds];
    cells.push({date:ds,total:v?v.total:0,weighted:v?v.weighted:0,requests:v?v.requests:0});
  }
  // Colour thresholds are relative quartiles of ACTIVE days — GitHub-style: the
  // scale adapts to the user's own range instead of a fixed absolute cutoff.
  const active=cells.filter(c=>c&&c.total>0).map(c=>c.total).sort((a,b)=>a-b);
  const q=p=>active.length?active[Math.min(active.length-1,Math.floor(active.length*p))]:Infinity;
  const t1=q(.25),t2=q(.5),t3=q(.75);
  const lvOf=v=>v<=0?0:v<=t1?1:v<=t2?2:v<=t3?3:4;
  const grid=document.getElementById('calGrid'),days=document.querySelector('#calendarBox .cal-daylabels');
  // Size cells from the card width so the 53-week grid spans the full row:
  // fixed-size cells would float small inside a wide box. Square cells keep a
  // GitHub-like pitch ratio; below 9px the card scrolls instead of shrinking.
  // The grid spans ceil(cells/7) columns — 54 when the 371-day window starts
  // mid-week, 53 when it doesn't. Sizing against a hardcoded 53 left the grid
  // one column wider than the card, clipping "today" on every load.
  const cols=Math.ceil(cells.length/7)||53;
  const avail=Math.max(300,(box.clientWidth||1200)-34-35-6);
  let gap=3,cell=Math.floor((avail-(cols-1)*gap)/cols);
  if(cell>22){cell=22;gap=Math.min(6,Math.max(3,Math.floor((avail-cols*cell)/(cols-1))))}
  if(cell<9)cell=9;
  grid.style.gridTemplateRows='repeat(7,'+cell+'px)';
  grid.style.gridAutoColumns=cell+'px';
  grid.style.gap=gap+'px';
  grid.style.setProperty('--cal-r',Math.max(2,Math.round(cell*0.2))+'px');
  if(days){days.style.gridTemplateRows='repeat(7,'+cell+'px)';days.style.gap=gap+'px'}
  grid.innerHTML=cells.map(c=>{
    if(!c)return '<span class="cal-cell ghost"></span>';
    const lv=lvOf(c.total);
    return '<span class="cal-cell'+(c.date===todayStr?' today':'')+'" style="background:'+CAL_COLORS[lv]+'" data-date="'+c.date+'" data-total="'+c.total+'" data-weighted="'+c.weighted+'" data-req="'+c.requests+'"></span>';
  }).join('');
  const STEP=cell+gap,labs=[];let lastLeft=-999;const seen={};
  cells.forEach((c,i)=>{
    if(!c)return;
    const ym=c.date.slice(0,7);
    if(seen[ym])return;
    seen[ym]=true;
    const left=Math.floor(i/7)*STEP;
    if(lastLeft<0||left-lastLeft>=STEP+18){labs.push('<span style="left:'+left+'px">'+parseInt(c.date.slice(5,7),10)+'月</span>');lastLeft=left}
  });
  document.getElementById('calMonths').innerHTML=labs.join('');
  // Newest weeks live at the right edge — start there so the current month is
  // visible first. Only act when the last (today) cell is actually cut off:
  // the grid box always fits (fixed tracks overflow it) and month labels may
  // overhang a few px, so pixel arithmetic is unreliable — let the browser
  // bring the today cell into view instead.
  const scroller=box.querySelector('.cal-scroll');
  if(scroller&&grid.lastElementChild){
    const lastR=grid.lastElementChild.getBoundingClientRect().right;
    if(lastR>scroller.getBoundingClientRect().right){
      try{grid.lastElementChild.scrollIntoView({inline:'end',block:'nearest'});}
      catch(e){scroller.scrollLeft=scroller.scrollWidth;}
    }else{
      scroller.scrollLeft=0;
    }
  }
  const tip=document.getElementById('calTip');
  grid.onmousemove=e=>{
    const el=e.target.closest('.cal-cell');
    if(!el||!el.dataset.date){tip.style.display='none';return}
    const used=+el.dataset.total>0;
    tip.innerHTML='<b>'+calMonthDay(el.dataset.date)+'</b> · '+(used?fmtTk(+el.dataset.total)+' token'+(+el.dataset.weighted&&+el.dataset.weighted!==+el.dataset.total?' · 计权 '+fmtTk(+el.dataset.weighted):'')+' · '+(+el.dataset.req||0)+' 次请求':'无使用');
    tip.style.display='block';
    const x=Math.min(e.clientX+14,window.innerWidth-tip.offsetWidth-10);
    tip.style.left=Math.max(8,x)+'px';tip.style.top=Math.max(8,e.clientY-36)+'px';
  };
  grid.onmouseleave=()=>{tip.style.display='none'};
}
async function load(){
  try{
    const qs=['profile='+encodeURIComponent(currentProfile)];
    if(currentProfile==='all'&&PROTO)qs.push('protocol='+PROTO);
    const r=await fetch('/api/my-usage?'+qs.join('&'),{headers:{'Authorization':'Bearer '+VK}});
    if(!r.ok){document.getElementById('meta').textContent='认证失败';return}
    D=await r.json();render();
  }catch(e){document.getElementById('meta').textContent='Error: '+e.message}
}
function switchProfile(v){currentProfile=v||'all';load()}
function renderProtoSeg(){document.querySelectorAll('#protoSeg button').forEach(b=>b.classList.toggle('on',b.dataset.proto===(currentProfile==='all'?PROTO:'')))}
function rebuildProfileOptions(){
  const sel=document.getElementById('profileSel');
  sel.innerHTML='<option value="all">'+(PROTO==='anthropic'?'全部 Anthropic 方案':PROTO==='responses'?'全部 OpenAI 方案':'全部可用方案')+'</option>'
    +(D&&(D.availableProfiles||[]).filter(p=>!PROTO||p.protocol===PROTO)||[]).map(p=>'<option value="'+p.suffix+'">'+p.name+' /'+p.suffix+(p.isDefault?' · 默认入口':'')+(p.protocol==='responses'?' · Codex':' · Claude Code')+'</option>').join('');
}
function switchProtocolView(proto){
  PROTO=proto||'';
  if(currentProfile!=='all'){currentProfile='all'}
  rebuildProfileOptions();
  const sel=document.getElementById('profileSel');sel.value='all';
  renderProtoSeg();
  if(D)load();
}
document.querySelectorAll('#protoSeg button').forEach(b=>b.addEventListener('click',()=>switchProtocolView(b.dataset.proto)));
// Quota-rate helpers. rate===null means the aggregate view (rates differ per
// profile), so only the combined discount is shown, never a single multiplier.
// The profile-level rate is explicitly labelled 默认 because per-model overrides
// mean a mixed day has no single "the" rate — the model table carries the detail.
function rateTag(q){
  if(q.rate===null||q.rate===undefined||q.rate===1)return'';
  const col=q.inPeak?'var(--orange)':'var(--green)';
  const t=(q.inPeak?'高峰':'低谷')+'时段默认倍率 ×'+q.rate+'；单独定价的模型见下方价目表';
  return ' <span class="tag" style="background:rgba(0,0,0,.04);color:'+col+'" title="'+t+'">'+(q.inPeak?'高峰':'低谷')+'默认 ×'+q.rate+'</span>';
}
function rateFootnote(q){
  if(q.rawUsed==null||q.rawUsed===q.used)return'';
  const delta=q.rawUsed-q.used;
  let cacheBit='';
  if(q.cacheInInput&&(q.cacheRead||0)>0&&(q.cacheReadQuotaRate??0)<1){
    cacheBit=(q.cacheReadQuotaRate>0)
      ?' · 缓存命中 '+fmtTk(q.cacheRead)+' 仅按 ×'+q.cacheReadQuotaRate+' 计入'
      :' · 缓存命中 '+fmtTk(q.cacheRead)+' 不计入配额';
  }
  return '<div style="margin-top:6px;font-size:10px;color:var(--dim)">实际 '+fmtTk(q.rawUsed)+' · '+(delta>0?'已抵扣 '+fmtTk(delta):'已加收 '+fmtTk(-delta))+cacheBit+'</div>';
}
function renderQNotice(q){
  const el=document.getElementById('qNotice');
  let html='';
  if(q.limit>0&&q.bonus>0){
    const base=q.limit-q.bonus;
    {const c=D.checkin,ciPart=(c&&c.checkedInToday&&q.bonus>=c.todayAmount)?'（含今日签到 <span class="hl">+'+fmtTk(c.todayAmount)+'</span>）':'';html+='<div class="qnotice bonus show"><span class="qi">加</span><div><b>今日临时加量已生效</b> — 为你追加 <span class="hl">+'+fmtTk(q.bonus)+'</span> 临时额度'+ciPart+'（'+fmtT(q.bonus)+' tokens）。今日总额度 <b>'+fmtT(q.limit)+'</b>（基础 '+fmtT(base)+' + 临时 '+fmtTk(q.bonus)+'），将于<b>明日零点自动恢复</b>为基础额度，无需任何操作。</div></div>';}
  }
  if(q.rawUsed!=null&&q.rawUsed!==q.used){
    const slot=q.rate===null?'':(q.inPeak?'高峰':'低谷');
    const delta=q.rawUsed-q.used;
    const nx=q.nextRateChange;
    const k=q.cacheReadQuotaRate??0;
    const cacheFree=q.cacheInInput&&(q.cacheRead||0)>0&&k<1;
    const cachePhrase=cacheFree
      ?'其中缓存命中 <span class="hl">'+fmtTk(q.cacheRead)+'</span> '+(k>0?'按 ×'+k+' 计入配额':'不计入配额')
      :'';
    const ratePhrase=(q.rate!==null&&q.rate!==undefined&&q.rate!==1)
      ?'未命中输入与输出按当前'+slot+'时段默认 ×'+q.rate+' 计权，各模型倍率见下方价目表。'
      :'';
    // Lead with the realised effect, not the nominal rate: with per-model rates
    // the day is a blend and the single default rate would not reconcile with the
    // numbers below it. Cache-hit exclusion (Responses/Codex) is stated as its own
    // clause so it is never misread as a multiplier.
    const explain=[];
    if(cachePhrase)explain.push(cachePhrase);
    if(ratePhrase)explain.push(ratePhrase);
    html+='<div class="qnotice bonus show"><span class="qi">折</span><div><b>计权折算生效</b> — '
      +'今日实际使用 <b>'+fmtT(q.rawUsed)+'</b> tokens（输入+输出）'
      +(q.cacheInInput&&(q.cacheRead||0)>0?'，含缓存命中 <b>'+fmtT(q.cacheRead)+'</b>':'')
      +'，计入配额 <b>'+fmtT(q.used)+'</b>'
      +(delta>0?'，已为你减免 <span class="hl">'+fmtTk(delta)+'</span> 额度':'，额外加收 <span class="hl">'+fmtTk(-delta)+'</span> 额度')
      +(explain.length?'。'+explain.join('；'):'')
      +(nx?'<b>'+nx.at+'</b> 后转入'+(nx.toPeak?'高峰':'低谷')+'。':'')
      +'</div></div>';
  }
  if(q.resetApplied){
    html+='<div class="qnotice reset show"><span class="qi">重</span><div><b>今日用量已被管理员重置</b> — 配额已恢复满额，可立即继续使用。下方「今日用量」等统计数字仍为今日实际消耗（统计报表保留），配额判定已从重置时刻重新计算。</div></div>';
  }
  el.innerHTML=html;
}
// Per-profile quota cards, shown only in the aggregate view. The aggregate bar
// above cannot answer "how much do I have left" — it reads 无配额限制 as soon as
// any one profile is unlimited, and even a summed limit cannot say WHICH profile
// is nearly exhausted. These cards can.
function renderProfileQuotas(){
  const box=document.getElementById('pqSection'),grid=document.getElementById('pqGrid'),hint=document.getElementById('pqHint');
  if(!box||!grid)return;
  const rows=Array.isArray(D.profileQuotas)?D.profileQuotas:[];
  if(!rows.length){box.style.display='none';return}
  box.style.display='';
  const limited=rows.filter(r=>r.limit>0);
  const tight=limited.filter(r=>r.pct>=80);
  if(hint){
    hint.innerHTML='共 '+rows.length+' 个额度池'
      +(limited.length?'，'+limited.length+' 个有配额':'，均无配额限制')
      +(tight.length?' · <b style="color:'+(tight.some(r=>r.pct>=100)?'var(--red)':'var(--orange)')+'">'+tight.length+' 个已超 80%</b>':'');
  }
  grid.innerHTML=rows.map(r=>{
    const free=!(r.limit>0);
    const cls=free?'free':r.pct>=90?'crit':r.pct>=80?'warn':'ok';
    const col=free?'var(--dim)':r.pct>=90?'var(--red)':r.pct>=80?'var(--orange)':'var(--green)';
    const tags=[];
    if(r.isDefault)tags.push('<span class="tag" style="background:rgba(47,110,80,.1);color:var(--green)">默认入口</span>');
    if(r.isPool&&r.poolProfiles&&r.poolProfiles.length>1)tags.push('<span class="tag" style="background:rgba(0,0,0,.04);color:var(--dim)" title="此额度池包含：'+esc((r.poolProfiles||[]).join('、'))+'">'+r.poolProfiles.length+' 个方案</span>');
    else tags.push('<span class="tag" style="background:rgba(0,0,0,.04);color:var(--dim)">'+(r.protocol==='responses'?'Codex':'Claude Code')+'</span>');
    if(r.rate!=null&&r.rate!==1)tags.push('<span class="tag" style="background:rgba(0,0,0,.04);color:'+(r.inPeak?'var(--orange)':'var(--green)')+'" title="'+(r.inPeak?'高峰':'低谷')+'时段默认倍率 ×'+r.rate+'">'+(r.inPeak?'高峰':'低谷')+' ×'+r.rate+'</span>');
    if(r.bonus>0)tags.push('<span class="tag" style="background:rgba(46,164,79,.12);color:var(--green)" title="'+bonusTip()+'">临时+'+fmtTk(r.bonus)+'</span>');
    if(r.resetApplied)tags.push('<span class="tag" title="管理员已重置今日用量，统计数据保留">已重置</span>');
    const nums=free
      ? '<div class="pq-nums"><span>今日已用 <b>'+fmtT(r.used)+'</b> tokens</span> · <span>该方案无每日上限</span></div>'
      : '<div class="pq-nums"><span>已用 <b>'+fmtT(r.used)+'</b> / '+fmtT(r.limit)+'</span> <span>（'+r.type+'）</span><br><span>剩余 <b>'+fmtT(r.remaining)+'</b></span>'
        +((r.rawUsed!=null&&r.rawUsed!==r.used)?' · <span>实际 '+fmtTk(r.rawUsed)+'</span> <span>'+(r.rawUsed>r.used?'已抵扣 '+fmtTk(r.rawUsed-r.used):'已加收 '+fmtTk(r.used-r.rawUsed))+'</span>':'')
        +(r.nextRateChange?'<br><span>'+r.nextRateChange.at+' 后转入'+(r.nextRateChange.toPeak?'高峰':'低谷')+' ×'+r.nextRateChange.rate+'</span>':'')
        +'</div>';
    const cacheTxt=(r.cacheInInput&&(r.cacheRead||0)>0&&((r.cacheReadQuotaRate??0)<1))
      ?'<div style="margin-top:4px;font-size:10px;color:var(--dim)">缓存命中 '+fmtTk(r.cacheRead)+((r.cacheReadQuotaRate>0)?' 按 ×'+r.cacheReadQuotaRate+' 计入':' 不计入配额')+'</div>'
      :'';
    return '<div class="pq '+cls+'">'
      +'<div class="pq-hd"><div style="min-width:0"><div class="pq-name">'+esc(r.profile)+'</div><div class="pq-sfx">/'+esc(r.suffix)+'</div></div>'
      +'<div class="pq-pct" style="color:'+col+'">'+(free?'不限':r.pct+'%')+'</div></div>'
      +(free?'':hpBar(r.pct,16))
      +nums
      +cacheTxt
      +'<div class="pq-tags">'+tags.join('')+'</div>'
      +'</div>';
  }).join('');
}
function render(){
  if(!D)return;
  const sel=document.getElementById('profileSel');
  // Always rebuild from the freshest D.availableProfiles (the backend narrows
  // the list when a protocol filter is active); keep the current selection.
  rebuildProfileOptions();
  sel.value=currentProfile;
  const curProto=(D.availableProfiles||[]).find(p=>p.suffix===currentProfile)?.protocol;
  const linkTag=currentProfile==='all'?(PROTO?' · 链路: '+(PROTO==='responses'?'OpenAI (Codex)':'Anthropic (Claude Code)'):''):' · 链路: '+(curProto==='responses'?'Codex (Responses)':'Claude Code (Anthropic)');
  const q=D.quota,t=D.today;
  const pct=q.limit>0?Math.min(100,Math.round(q.used/q.limit*100)):0;
  const color=pct>90?'var(--red)':pct>70?'var(--orange)':'var(--green)';
  document.getElementById('meta').innerHTML=D.username+' · 方案: '+D.profile+linkTag+(q.limit>0?' · <span style="color:'+color+'">'+pct+'% 已用</span> '+hpBar(pct,16)+rateTag(q)+(q.autoAdjusted?' <span class="tag">AUTO</span>':'')+(q.bonus>0?' <span class="tag" style="background:rgba(46,164,79,.12);color:var(--green)" title="'+bonusTip()+'">临时+'+fmtTk(q.bonus)+'</span>':'')+(q.resetApplied?' <span class="tag" title="管理员已重置今日用量，统计数据保留">已重置</span>':''):' · 无配额限制'+rateTag(q));
  renderQNotice(q);
  document.getElementById('cards').innerHTML=
    '<div class="card"><div class="l">今日用量 <span style="font-size:9px;color:var(--dim);font-weight:400">输入+输出</span></div><div class="v" data-cu="'+ioTokens(t)+'" data-cu-k style="color:var(--accent)">0</div></div>'+
    '<div class="card"><div class="l">今日请求</div><div class="v" data-cu="'+t.requests+'" data-cu-k style="color:var(--blue)">0</div></div>'+
    // Weighted card only appears when weighting is live — otherwise it would just
    // duplicate 今日用量 and add noise.
    (((q.rawUsed!=null&&q.rawUsed!==q.used)||(q.rate!==null&&q.rate!==undefined&&q.rate!==1))?'<div class="card" style="border-top:2px solid var(--accent)"><div class="l">计权用量 <span style="font-size:9px;color:var(--dim);font-weight:400">计入配额</span></div><div class="v" data-cu="'+q.used+'" data-cu-k style="color:var(--accent)">0</div>'+rateFootnote(q)+'</div>':'')+
    (q.limit>0?'<div class="card"'+(q.bonus>0?' style="border-top:2px solid var(--green)"':'')+'><div class="l">剩余额度'+(q.bonus>0?' <span class="tag" style="background:rgba(47,110,80,.1);color:var(--green)">含临时加量</span>':'')+'</div><div class="v" data-cu="'+q.remaining+'" data-cu-k style="color:'+color+'">0</div><div style="margin-top:8px">'+hpBar(pct,16)+'</div>'+rateFootnote(q)+'</div>'+
    '<div class="card"><div class="l">每日限额'+((q.rate!==null&&q.rate!==undefined&&q.rate!==1)?' <span style="font-size:9px;color:var(--dim);font-weight:400">计权口径</span>':'')+'</div><div class="v" data-cu="'+q.limit+'" data-cu-k style="color:var(--dim)">0</div>'+(q.bonus>0?'<div style="margin-top:6px;font-size:10px;color:var(--green);font-weight:550">基础 '+fmtTk(q.limit-q.bonus)+' + 临时 '+fmtTk(q.bonus)+'</div>':'')+'</div>':'')+
    // 输入/输出 merged into one card so all nine stats stay on a single row.
    '<div class="card"><div class="l">今日输入 / 输出</div><div class="v" style="font-size:19px"><span style="color:var(--green)">'+fmtTk(t.input)+'</span><span style="color:var(--dim2);font-weight:400"> / </span><span style="color:var(--orange)">'+fmtTk(t.output)+'</span></div><div style="margin-top:6px;font-size:10px;color:var(--dim);font-variant-numeric:tabular-nums">'+fmtT(t.input)+' / '+fmtT(t.output)+'</div></div>'+
    '<div class="card"><div class="l">今日缓存写入</div><div class="v" data-cu="'+t.cacheWrite+'" data-cu-k>0</div></div>'+
    '<div class="card"><div class="l">今日缓存命中</div><div class="v" data-cu="'+t.cacheRead+'" data-cu-k>0</div></div>';
  runCountUps(document.getElementById('cards'));
  renderProfileQuotas();
  // Hourly chart
  const hrs=[];for(let i=0;i<24;i++)hrs.push(i.toString().padStart(2,"0")+":00");
  const hData=hrs.map((_,i)=>{const h=D.hourly[i.toString().padStart(2,"0")]||{};return{req:h.requests||0,tokens:ioTokens(h)}});
  if(C.h)C.h.destroy();
  C.h=new Chart(document.getElementById("hourChart"),{type:"bar",data:{labels:hrs,datasets:[{label:"Token(输入+输出)",data:hData.map(d=>d.tokens),backgroundColor:COL[0]+"cc",borderRadius:3},{label:"请求数",data:hData.map(d=>d.req),backgroundColor:COL[1]+"cc",borderRadius:3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:"#686863",font:{size:10}}}},scales:{x:{ticks:{color:"#686863",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});
  // Trend chart
  if(C.t)C.t.destroy();
  C.t=new Chart(document.getElementById("trendChart"),{type:"line",data:{labels:D.trend.map(d=>d.date.slice(5)),datasets:[{label:"总Token(含缓存)",data:D.trend.map(d=>d.total),borderColor:COL[0],backgroundColor:"rgba(47,110,80,.12)",fill:true,tension:.28,pointRadius:2,borderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:"#686863",font:{size:10}}}},scales:{x:{ticks:{color:"#686863"},grid:{display:false}},y:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});
  // Model table. Two token columns side by side is the whole point: "实际" is what
  // the user spent, "计入配额" is what it cost them. The per-row multiplier is the
  // realised ratio (weighted/raw) — for a row that straddled a peak boundary or a
  // rate change that lands between the two configured values, which is correct.
  const mt=document.querySelector("#modelTable tbody");
  const models=Object.entries(D.models||{}).sort((a,b)=>b[1].requests-a[1].requests);
  const anyWeighted=models.some(([,d])=>d.weighted!=null&&d.weighted!==d.total);
  if(!models.length){mt.innerHTML='<tr><td colspan="5" style="text-align:center;color:var(--dim)">暂无数据</td></tr>'}else{
    mt.innerHTML=models.map(([m,d])=>{
      const raw=d.total||0,w=d.weighted!=null?d.weighted:raw;
      const realised=raw>0?Math.round(w/raw*100)/100:null;
      const now=d.rate;
      // Show the realised ratio, and flag when the live rate differs from it (rate
      // changed today, or the day spanned a peak boundary).
      const rateCell=realised==null?'<span style="color:var(--dim)">-</span>'
        :'<span'+(realised!==1?' style="color:var(--accent)"':'')+' title="今日实际计权比例'+(now!=null&&now!==realised?'；当前时段该模型为 ×'+now:'')+'">×'+realised+(now!=null&&now!==realised?' <span style="color:var(--dim);font-size:10px">(现 ×'+now+')</span>':'')+'</span>';
      return '<tr><td style="color:var(--blue)">'+m+(d.rateIsDefault===false?' <span class="tag" style="font-size:9px">单独定价</span>':'')+'</td>'
        +'<td class="n">'+fmtT(d.requests)+'</td>'
        +'<td class="n" title="输入 '+fmtT(d.inputTokens||0)+' / 输出 '+fmtT(d.outputTokens||0)+'">'+fmtTk(raw)+'</td>'
        +'<td class="n">'+rateCell+'</td>'
        +'<td class="n hl">'+fmtTk(w)+'</td></tr>';
    }).join("");
  }
  const note=document.getElementById('modelTableNote');
  const qq=D.quota||{};
  const cacheClause=(qq.cacheInInput&&(qq.cacheRead||0)>0&&((qq.cacheReadQuotaRate??0)<1))
    ?' <span style="white-space:nowrap">Responses 链路缓存命中 '+fmtTk(qq.cacheRead)+' 已剔除、不计入配额。</span>'
    :'';
  note.innerHTML=(anyWeighted
    ?'「实际 Token」是真实消耗，「计入配额」是按配额口径（各模型倍率；Responses/Codex 链路再剔除缓存命中）折算后从每日额度里扣掉的数额。倍率列为今日实际计权比例，跨高峰边界或期间调整过倍率时会落在两档之间。'
    :'当前没有倍率或缓存规则造成差异，实际消耗与计入配额相同。')
    +cacheClause;
  renderRateCard();
  renderCheckin();
  renderQuotaRequest();
  renderCalendar();
}
// Price list: what each alias costs right now. Answers "为什么额度掉这么快" before
// the user spends, not after. Cheapest first — the cheap option should be the one
// that catches the eye.
function renderRateCard(){
  const box=document.getElementById('rateCardBox'),body=document.getElementById('rateCardBody');
  if(!box||!body)return;
  const cards=D.rateCard?[D.rateCard]:(D.rateCards||[]);
  const meaningful=cards.filter(c=>c&&c.rows.length&&(c.rows.some(r=>r.custom)||c.defaultPeak!==1||c.defaultOffPeak!==1));
  if(!meaningful.length){box.style.display='none';return}
  box.style.display='';
  body.innerHTML=meaningful.map(c=>{
    const rows=c.rows.map(r=>'<tr><td style="color:var(--blue)">'+r.alias+'</td>'
      +'<td style="color:var(--dim);font-size:11px;overflow:hidden;text-overflow:ellipsis">'+r.model+'</td>'
      +'<td class="n"'+(r.rate<1?' style="color:var(--green);font-weight:600"':r.rate>1?' style="color:var(--orange);font-weight:600"':'')+'>×'+r.rate+'</td>'
      +'<td class="n" style="color:var(--dim);font-size:11px">'+(r.custom?'峰 ×'+r.peak+' / 谷 ×'+r.offPeak:'跟随默认')+'</td></tr>').join('');
    return '<div style="margin-bottom:14px">'
      +'<div style="font-size:12px;font-weight:600;margin-bottom:6px">'+c.profile
      +' <span class="tag" style="background:rgba(0,0,0,.04);color:'+(c.inPeak?'var(--orange)':'var(--green)')+'">'+(c.inPeak?'高峰时段':'低谷时段')+'</span>'
      +' <span style="font-size:10px;color:var(--dim);font-weight:400">默认 ×'+(c.inPeak?c.defaultPeak:c.defaultOffPeak)+'</span></div>'
      +'<table style="min-width:auto;table-layout:fixed;width:100%"><thead><tr><th style="width:20%">别名</th><th style="width:42%">实际模型</th><th class="n" style="width:16%">当前倍率</th><th class="n" style="width:22%">峰/谷</th></tr></thead><tbody>'+rows+'</tbody></table>'
      +'</div>';
  }).join('')
    +'<div class="note" style="font-size:11px;color:var(--dim)">倍率越低越省额度：×0.5 表示消耗 1000 token 只扣 500 额度。倍率随时段自动切换，调整只影响之后的请求。</div>';
}
let calRz;window.addEventListener('resize',function(){clearTimeout(calRz);calRz=setTimeout(function(){if(D)renderCalendar()},150)});
// ── 产出画像(仅本人;拉 /api/production/me,接口不可用时整块隐藏)──
// 注意:本页面由服务端模板字符串生成,这里只能用字符串拼接,不能出现反引号或插值序列。
(function loadProdMe(){
  const ph=esc;
  fetch('/api/production/me?range=7d',{headers:{'Authorization':'Bearer '+VK}})
    .then(r=>r.ok?r.json():Promise.reject(new Error('未开放')))
    .then(d=>{
      const net=d.days.reduce((x,y)=>x+(y.la-y.ld),0);
      const edits=d.days.reduce((x,y)=>x+y.edits,0);
      const errs=d.days.reduce((x,y)=>x+y.errs,0);
      const failPct=edits?Math.round(errs*100/edits):0;
      // 阈值着色:失败率 <10% 绿 / 10-30% 默认 / ≥30% 橙;缓存命中率 ≥90% 绿 / 80-90% 黄 / <80% 红。
      // .card .v 的 color 带 !important,着色要落在内层 span 上才会生效。
      const failColor=failPct>=30?'color:var(--orange)':(failPct<10?'color:var(--green)':'');
      const hitPct=d.health?Math.round(d.health.ratio*100):0;
      const hitColor=hitPct>=90?'color:var(--green)':(hitPct>=80?'color:var(--yellow)':'color:var(--red)');
      const val=(v,c)=>'<div class="v">'+(c?'<span style="'+c+'">'+v+'</span>':v)+'</div>';
      document.getElementById('prodMeMetrics').innerHTML=
        '<div class="card"><div class="l">净产出(行)</div>'+val(net.toLocaleString('zh-CN'))+'</div>'+
        '<div class="card"><div class="l">编辑次数</div>'+val(edits)+'</div>'+
        '<div class="card"><div class="l">失败率</div>'+val(failPct+'%',failColor)+'</div>'+
        (d.health?'<div class="card"><div class="l">缓存命中率 <span style="font-size:9px;color:var(--dim);font-weight:400">近7天</span></div>'+val(hitPct+'%',hitColor)+(d.health.advice?'<div style="font-size:10px;color:var(--dim);margin-top:6px;line-height:1.5">'+ph(d.health.advice)+'</div>':'')+'</div>':'');
      document.getElementById('prodMeTrend').textContent='日趋势:'+(d.days.map(x=>x.date.slice(5)+':'+(x.la-x.ld)+'行').join(' · ')||'暂无');
      document.getElementById('prodMeLangs').innerHTML='语言分布:'+(d.languages.length?d.languages.map(l=>'<span style="display:inline-block;font-size:10px;color:var(--dim);border:1px solid var(--border-strong);border-radius:9px;padding:1px 8px;margin:0 4px 4px 0">'+ph(l.ext||'其他')+' +'+l.la+'</span>').join(''):'暂无');
    })
    .catch(()=>{const el=document.getElementById('prodProfile');if(el)el.style.display='none'});
})();
load();setInterval(load,30000);
