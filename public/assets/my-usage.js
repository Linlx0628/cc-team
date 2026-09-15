Chart.defaults.color='#686863';Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei","Segoe UI",sans-serif';Chart.defaults.font.size=11;
// public/assets/my-usage.js —— 个人用量页（personalUsageHtml，/my-usage?key= 与 /usage/:key
// 共用）的客户端逻辑。页面内联引导脚本先注入以下全局再加载本文件：
//   VK（虚拟 key）/ toast() 及 UI_HELPERS 提供的辅助函数
// 其余数据均由本文件运行时经 /api/my-usage 拉取，文件可长期强缓存（?v= 内容版本号）。
let D=null,C={h:null,t:null},currentProfile='all',PROTO='',SECTION='overview';
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
    window.Mascot&&Mascot.say('签到成功，今天领到 '+fmtTk(j.amount)+' token！',{mood:'delighted'});
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
// ── Mascot speech bubble ──
// 未签到时让吉祥物口头提醒；已签到(或签到功能不可用)则改为时段问候 + 一句话今日
// 用量简报。每次进页/刷新都说一次:用内存标记做「单次」守卫挡住 30s 轮询反复进
// load() 的重弹;切换侧栏菜单不刷新页面,天然不会重新触发。
var mascotSaid = false;
function mascotHello(){
  if(mascotSaid)return;
  const c=D&&D.checkin;
  if(c&&c.available&&c.enabled===false)return;
  mascotSaid=true;
  if(c&&c.available&&!c.checkedInToday){
    setTimeout(()=>{window.Mascot&&Mascot.say('记得签到哦～，点上面的「签到领 token」领今日加量')},1500);
    return;
  }
  setTimeout(()=>{window.Mascot&&Mascot.say(mascotHelloLine())},1500);
}
function mascotHelloLine(){
  const h=Number(new Date(Date.now()+8*3600000).getUTCHours());
  const greet=h<5?'夜深了':h<11?'早上好':h<13?'中午好':h<18?'下午好':'晚上好';
  const c=D&&D.checkin,t=D&&D.today;
  let line=greet+'，'+(D&&D.username?D.username:'')+'！';
  if(t)line+='今日已用 '+fmtTk(ioTokens(t))+' tokens · '+(t.requests||0)+' 次请求';
  if(c&&c.checkedInToday&&c.todayAmount)line+=(t?'，':'')+'签到的 '+fmtTk(c.todayAmount)+' token 已到账';
  return line;
}
async function load(){
  try{
    const qs=['profile='+encodeURIComponent(currentProfile)];
    if(currentProfile==='all'&&PROTO)qs.push('protocol='+PROTO);
    // 用量分析的日期窗口(ANA):默认档「今日」也照常传 start/end,口径由服务端回显。
    qs.push('start='+encodeURIComponent(ANA.start||''));
    qs.push('end='+encodeURIComponent(ANA.end||''));
    const r=await fetch('/api/my-usage?'+qs.join('&'),{headers:{'Authorization':'Bearer '+VK}});
    if(!r.ok){document.getElementById('meta').textContent='认证失败';return}
    D=await r.json();
    // 纯 innerHTML 的部分(头部、KPI 卡、各方案配额、价目表)不依赖面板宽度,隐藏时也照刷。
    renderChrome();
    renderProfileQuotas();
    renderRateCard();
    // 图表与使用日历按容器宽度绘制:面板隐藏时宽度为 0,建图会得到一张空白图、
    // 日历会落到 9px 下限。所以各自只在所属面板可见时画,切过去时由 paintSection() 补画。
    if(SECTION==='overview')renderCalendar();
    if(SECTION==='analysis')renderAnalysisPane();
    mascotHello();
  }catch(e){document.getElementById('meta').textContent='Error: '+e.message}
}
function switchProfile(v){currentProfile=v||'all';load()}
function renderProtoSeg(){document.querySelectorAll('#protoSeg button').forEach(b=>b.classList.toggle('on',b.dataset.proto===(currentProfile==='all'?PROTO:'')))}
function rebuildProfileOptions(){
  const sel=document.getElementById('profileSel');
  sel.innerHTML='<option value="all">'+(PROTO==='anthropic'?'全部 Anthropic 方案':PROTO==='responses'?'全部 OpenAI 方案':'全部可用方案')+'</option>'
    +(D&&(D.availableProfiles||[]).filter(p=>!PROTO||p.protocol===PROTO)||[]).map(p=>'<option value="'+p.suffix+'">'+p.name+' /'+p.suffix+(p.isDefault?' · 默认入口':'')+(p.protocol==='responses'?' · OpenAI':' · Anthropic')+'</option>').join('');
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
    else tags.push('<span class="tag" style="background:rgba(0,0,0,.04);color:var(--dim)">'+(r.protocol==='responses'?'OpenAI':'Anthropic')+'</span>');
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
// ── 渲染分片 ──
// 常驻部分:工具条(协议/方案/申请加量)、meta、通知条、KPI 卡、签到条。都不依赖面板宽度,
// 面板隐藏时也能安全渲染 —— 30 秒轮询每次都刷新它们。
function renderChrome(){
  if(!D)return;
  const sel=document.getElementById('profileSel');
  // Always rebuild from the freshest D.availableProfiles (the backend narrows
  // the list when a protocol filter is active); keep the current selection.
  rebuildProfileOptions();
  sel.value=currentProfile;
  const curProto=(D.availableProfiles||[]).find(p=>p.suffix===currentProfile)?.protocol;
  const linkTag=currentProfile==='all'?(PROTO?' · 协议: '+(PROTO==='responses'?'OpenAI':'Anthropic'):''):' · 协议: '+(curProto==='responses'?'OpenAI':'Anthropic');
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
  renderCheckin();
  renderQuotaRequest();
}
// 配额相关两片都是纯 innerHTML,没有几何依赖,面板隐藏时渲染也不会画错 ——
// 所以它们跟着 30 秒轮询刷新,不走「切过去才画」那套(两个渲染函数各自见名)。
function renderModelTable(){
  // Model table. Two token columns side by side is the whole point: "实际" is what
  // the user spent, "计入配额" is what it cost them. The per-row multiplier is the
  // realised ratio (weighted/raw) — for a row that straddled a peak boundary or a
  // rate change that lands between the two configured values, which is correct.
  const mt=document.querySelector("#modelTable tbody");
  const models=Object.entries(D.models||{}).sort((a,b)=>b[1].requests-a[1].requests);
  // 倍率列展示的是「实际计权比例」(weighted/原始),weighted 是落表时算好的历史值,
  // 区间求和依然精确 —— 只有措辞跟窗口变(今日 / 区间)。
  const scopeW=D.usageRange?'区间实际计权比例':'今日实际计权比例';
  const anyWeighted=models.some(([,d])=>d.weighted!=null&&d.weighted!==d.total);
  if(!models.length){mt.innerHTML='<tr><td colspan="5" style="text-align:center;color:var(--dim)">暂无数据</td></tr>'}else{
    mt.innerHTML=models.map(([m,d])=>{
      const raw=d.total||0,w=d.weighted!=null?d.weighted:raw;
      const realised=raw>0?Math.round(w/raw*100)/100:null;
      const now=d.rate;
      // Show the realised ratio, and flag when the live rate differs from it (rate
      // changed today, or the day spanned a peak boundary).
      const rateCell=realised==null?'<span style="color:var(--dim)">-</span>'
        :'<span'+(realised!==1?' style="color:var(--accent)"':'')+' title="'+scopeW+(now!=null&&now!==realised?'；当前时段该模型为 ×'+now:'')+'">×'+realised+(now!=null&&now!==realised?' <span style="color:var(--dim);font-size:10px">(现 ×'+now+')</span>':'')+'</span>';
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
    ?'「实际 Token」是真实消耗，「计入配额」是按配额口径（各模型倍率；Responses/Codex 链路再剔除缓存命中）折算后从每日额度里扣掉的数额。倍率列为'+scopeW+'，跨高峰边界或期间调整过倍率时会落在两档之间。'
    :'当前没有倍率或缓存规则造成差异，实际消耗与计入配额相同。')
    +cacheClause;
}
// 客户端表:今天这些请求分别来自哪个 AI 客户端(Claude Code / Codex / ...)。
// 客户端与协议是两回事 —— Claude Code 和 zcode 都走 Anthropic 协议,zcode 还能走 OpenAI 协议,
// 所以这张表既不按方案分也不按协议分,只是把今天的量按调用方归一次。
// 没有倍率列:倍率是「模型 × 时段」的函数,与客户端无关;一个客户端下的请求可能横跨多个模型,
// 给它们合成一个倍率就是编造。额度口径仍看上面的模型表。
function renderClientTable(){
  const tb=document.querySelector("#clientTable tbody"),box=document.getElementById("clientBox");
  const clients=Object.entries(D.clients||{}).filter(([,d])=>(d.requests||0)>0).sort((a,b)=>b[1].total-a[1].total);
  if(!clients.length){box.style.display='none';return}
  box.style.display='';
  const sum=clients.reduce((a,[,d])=>a+(d.total||0),0);
  tb.innerHTML=clients.map(([c,d])=>{
    const pct=sum>0?d.total/sum*100:0;
    const isUnknown=c==='unknown';
    return '<tr><td'+(isUnknown?' style="color:var(--dim)"':' style="color:var(--blue)"')+'>'+clientLabel(c)+'</td>'
      +'<td class="n">'+fmtT(d.requests||0)+'</td>'
      +'<td class="n hl" title="输入 '+fmtT(d.inputTokens||0)+' / 输出 '+fmtT(d.outputTokens||0)+'">'+fmtTk(d.total||0)+'</td>'
      +'<td class="n">'+pct.toFixed(1)+'%</td></tr>';
  }).join("");
  const unknown=clients.find(([c])=>c==='unknown');
  document.getElementById('clientTableNote').innerHTML=
    '客户端依据请求头（User-Agent / X-App / Originator）判定，可被伪造，仅供参考。'
    +(unknown?' <span style="white-space:nowrap">其中 '+fmtT(unknown[1].requests||0)+' 次请求未能识别调用方。</span>':'');
}
// 用量分析面板:两张 Chart.js 图按容器宽度绘制,面板隐藏时容器宽度是 0,建图会得到一张
// 空白图。所以这一片只在面板可见时渲染,切过去时由 paintSection() 补画。
// (使用日历已搬到概览,同理由 paintSection() 的 overview 分支补画。)
function renderAnalysisPane(){
  if(!D)return;
  const hc=document.getElementById("hourChart"),tc=document.getElementById("trendChart");
  // 口径标题:趋势图与模型表跟 ANA 日期筛选走(以服务端回显的 usageRange 为准);
  // 24 小时图恒为今天 —— D.hourly 没有日期维度,不参与筛选。
  const rangeEcho=D.usageRange||null;
  const rangeText=rangeEcho?('范围 '+rangeEcho.start+' ~ '+rangeEcho.end):'';
  const tt=document.getElementById('trendTitle');
  if(tt)tt.textContent=rangeEcho?rangeText:'近 7 天';
  const mtl=document.getElementById('modelTitle');
  if(mtl)mtl.textContent=rangeEcho?rangeText:'今日';
  // Hourly chart
  // 半小时槽位("HH:MM")同图上的 x 轴标签是同一个字符串,旧整点行的阶梯兜底在 ui.js 的 halfHourSlots 里。
  // D.hourly 是**只有今天**的一层 {hour: value} map(lib/personal-usage.mjs),没有日期维度,不做窗口过滤。
  // 口径沿用 ioTokens(输入+输出,不含缓存),与本页 KPI 卡、模型表一致;改折线后它移到右轴,
  // dataset 的 "Token(输入+输出)" 是唯一的口径提示,不能换成含义含缓存的 "总 Token"。
  const hrs=halfHourLabels();
  const hData=Array.from({length:48},()=>({req:0,tokens:0}));
  for(const [i,h,w] of halfHourSlots(D.hourly)){
    hData[i].req+=(h.requests||0)*w;hData[i].tokens+=ioTokens(h)*w;
  }
  if(C.h){C.h.destroy();C.h=null}
  // 双 Y 轴:请求数是几十、Token 是几百万,同轴会把请求数压成贴地一条线,所以必须分开。
  // 两个轴的 title 块刻意不加 —— .chart-row .box canvas 限高 190px,轴标题会吃掉约 15% 的绘图区,
  // 而图例已经写明两个单位,信息没有损失。图例同样沿用本页的内联写法,不引 dashboard 的 trendLegend()。
  if(hc)C.h=new Chart(hc,{type:"line",data:{labels:hrs,datasets:[{label:"请求数",data:hData.map(d=>d.req),borderColor:"#2f6e50",backgroundColor:"rgba(47,110,80,.12)",fill:true,tension:.28,pointRadius:0,pointHitRadius:10,pointBackgroundColor:"#2f6e50",pointHoverRadius:4,borderWidth:2,yAxisID:"y"},{label:"Token(输入+输出)",data:hData.map(d=>d.tokens),borderColor:"#181816",backgroundColor:"rgba(24,24,22,.08)",fill:true,tension:.28,pointRadius:0,pointHitRadius:10,pointBackgroundColor:"#181816",pointHoverRadius:4,borderWidth:2,yAxisID:"y1"}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:{labels:{color:"#686863",font:{size:10}}},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)}}},scales:{x:{ticks:{color:"#686863",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{type:"linear",position:"left",ticks:{color:"#2f6e50"},grid:{color:"rgba(24,24,22,.08)"}},y1:{type:"linear",position:"right",ticks:{color:"#181816",callback:v=>fmtTk(v)},grid:{drawOnChartArea:false}}}}});
  // Trend chart —— 服务端恒给逐日序列;窗口跨度超过 92 天时按月合并再画,
  // 逐日点会密到没有可读性(月份标签保留 YYYY-MM 全串,与日的 MM-DD 区分开)。
  const trows=D.trend||[];
  let tlabels=trows.map(d=>d.date.slice(5)),tdata=trows.map(d=>d.total);
  if(trows.length>1&&(Date.parse(trows[trows.length-1].date+'T00:00:00Z')-Date.parse(trows[0].date+'T00:00:00Z'))/DAY>92){
    const byMonth={};
    for(const r of trows){
      const k=r.date.slice(0,7);
      if(!byMonth[k])byMonth[k]={total:0};
      byMonth[k].total+=r.total;
    }
    const months=Object.keys(byMonth).sort();
    tlabels=months;tdata=months.map(k=>byMonth[k].total);
  }
  if(C.t){C.t.destroy();C.t=null}
  if(tc)C.t=new Chart(tc,{type:"line",data:{labels:tlabels,datasets:[{label:"总Token(含缓存)",data:tdata,borderColor:COL[0],backgroundColor:"rgba(47,110,80,.12)",fill:true,tension:.28,pointRadius:2,borderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:"#686863",font:{size:10}}}},scales:{x:{ticks:{color:"#686863"},grid:{display:false}},y:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});
  renderModelTable();
  renderClientTable();
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
let calRz;window.addEventListener('resize',function(){clearTimeout(calRz);calRz=setTimeout(function(){if(D&&SECTION==='overview')renderCalendar()},150)});
// ── 产出画像(仅本人;拉 /api/production/me,接口不可用时整块隐藏)──
// 注意:本文件是独立的外部资源(/assets/my-usage.js),不再是服务端模板字符串的一部分,
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
// ── 日期范围筛选(用量分析 / 会话使用情况,两个面板各自独立)──────────────
// preset 为空 = 服务端默认窗口(两块都是近 7 天),请求不带日期参数;
// 选了预设或手填日期则带 start/end(北京日期串),由服务端 parseDateRange 校验归一
// (非法 400、起止倒换对调、跨度上限 400 天)。预设窗口与 dashboard 周期 tabs 同语义:
// 今日 / 本周(周一起)/ 本月(1 日起)/ 今年(1 月 1 日起),均北京时间。
const DAY=86400000;
const RANGE_PRESETS=[['today','今日'],['week','本周'],['month','本月'],['year','今年']];
// 两个面板各带默认选中档:用量分析默认「今日」,会话使用情况默认「本周」。
// 边界在脚本载入时算一次;跨天挂着不刷新的话窗口会停在昨天,重选一次预设即恢复。
function initState(def){
  const b=presetBounds(def);
  return{def:def,preset:def,start:b.start,end:b.end};
}
const ANA=initState('today');   // 用量分析:/api/my-usage 的趋势 + 模型/客户端表
const SESS=initState('week');   // 会话使用情况:/api/my-activity(项目分布随之)
function presetBounds(p){
  const shifted=new Date(Date.now()+8*3600000);
  const td=shifted.toISOString().slice(0,10);
  if(p==='today')return{start:td,end:td};
  if(p==='week'){
    const dow=(shifted.getUTCDay()+6)%7;  // 周一=0
    return{start:new Date(Date.UTC(shifted.getUTCFullYear(),shifted.getUTCMonth(),shifted.getUTCDate()-dow)).toISOString().slice(0,10),end:td};
  }
  if(p==='month')return{start:shifted.toISOString().slice(0,7)+'-01',end:td};
  if(p==='year')return{start:shifted.toISOString().slice(0,4)+'-01-01',end:td};
  return null;
}
// 两个面板共用同一个控件构建:pill-seg 预设 + 起止 date input + 重置。state 直接读写
// 传入对象(ANA/SESS),控件重画只是回填与高亮,不持有自己的状态。
function renderRangeCtl(boxId,state,onChange){
  const box=document.getElementById(boxId);
  if(!box)return;
  const dateCss='font-size:11px;padding:2px 4px;border:1px solid var(--border-strong);border-radius:6px;background:transparent;color:var(--text)';
  box.innerHTML='<div class="pill-seg" role="tablist" aria-label="快捷周期">'
    +RANGE_PRESETS.map(function(p){
      return '<button type="button" role="tab" aria-selected="'+(p[0]===state.preset)+'" data-preset="'+p[0]+'"'+(p[0]===state.preset?' class="on"':'')+'>'+p[1]+'</button>';
    }).join('')+'</div>'
    +'<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dim)">'
    +'<input type="date" aria-label="开始日期" data-edge="start" value="'+esc(state.start)+'" style="'+dateCss+'">'
    +'<span>~</span>'
    +'<input type="date" aria-label="结束日期" data-edge="end" value="'+esc(state.end)+'" style="'+dateCss+'">'
    +'<button type="button" data-reset="1" style="font-size:11px;color:var(--dim);background:none;border:1px solid var(--border-strong);border-radius:6px;padding:2px 8px;cursor:pointer">重置</button>'
    +'</div>';
  box.onchange=function(e){
    const inp=e.target.closest('input[data-edge]');
    if(!inp)return;
    if(inp.dataset.edge==='start')state.start=inp.value||'';else state.end=inp.value||'';
    if(state.start&&state.end&&state.start>state.end){const t=state.start;state.start=state.end;state.end=t}
    state.preset=(state.start||state.end)?'custom':'';
    renderRangeCtl(boxId,state,onChange);  // 重画:回填对调后的值、同步预设高亮
    onChange();
  };
  box.onclick=function(e){
    const p=e.target.closest('button[data-preset]');
    if(p&&!p.classList.contains('on')){
      state.preset=p.dataset.preset;
      const b=presetBounds(state.preset);state.start=b.start;state.end=b.end;
      renderRangeCtl(boxId,state,onChange);onChange();return;
    }
    if(e.target.closest('button[data-reset]')){
      // 重置回到本面板的默认档(用量分析=今日,会话=本周),不是清空筛选。
      const b=presetBounds(state.def);state.preset=state.def;state.start=b.start;state.end=b.end;
      renderRangeCtl(boxId,state,onChange);onChange();
    }
  };
}
function analysisRangeChanged(){load()}
function sessRangeChanged(){ACT.data=null;fetchActivity()}
load();setInterval(load,30000);


// ── 面板切换 ──
// 菜单按功能划分,六块:概览(含使用日历、各方案配额、产出画像)/ 配额价目表 /
// 用量分析(图表、模型表、客户端用量、项目分布)/ 会话使用情况 / 团队排行榜 /
// 配置 Codex(/setup 页搬进来的内嵌分区)。
// 顺序即导航顺序,id 由 setSection() 按 'mu-tab-'+s / 'mu-panel-'+s 硬拼 ——
// 增删菜单必须与 lib/pages.mjs 的按钮和面板同时改,否则切换会静默失效。
const SECTIONS=['overview','rates','analysis','sessions','leaderboard','codex'];
function setSection(name,focus){
  if(SECTIONS.indexOf(name)<0)name='overview';
  SECTION=name;
  SECTIONS.forEach(function(s){
    const btn=document.getElementById('mu-tab-'+s),panel=document.getElementById('mu-panel-'+s);
    const on=s===name;
    if(btn){btn.classList.toggle('active',on);btn.setAttribute('aria-selected',String(on));btn.tabIndex=on?0:-1}
    if(panel){panel.hidden=!on;panel.classList.toggle('active',on)}
  });
  if(focus){const b=document.getElementById('mu-tab-'+name);if(b)b.focus()}
  paintSection();
}
// 切到「用量分析」/「概览」才补画:隐藏期间容器宽度为 0,提前建图/排日历都会画错。
// 日历现在挂在概览里,所以两个分支都要有 —— 少了 overview 这一支,切回概览会看到一张
// 按 0 宽排出来、被压到 9px 下限的日历。
// 「会话使用情况」不在补画之列:活动那两块全靠 CSS 排版,从容器读宽度的只有 renderCalendar,
// 所以在面板还隐藏时就把 innerHTML 写好是安全的,这里只需保证数据到位。
// 排行榜首次进入才请求,且不参与 30 秒轮询 —— 它和 D 是两份数据,不必跟着刷新。
function paintSection(){
  if(SECTION==='analysis'){
    if(D)renderAnalysisPane();
    if(C.h)C.h.resize();
    if(C.t)C.t.resize();
    ensureActivity();   // 项目分布与会话使用情况共用一份载荷,从哪个入口进来都拉它
  }else if(SECTION==='overview'){
    if(D)renderCalendar();
  }else if(SECTION==='sessions'){
    ensureActivity();   // 已拉过是空操作;正在拉时 fetchActivity() 自己会早退
  }else if(SECTION==='leaderboard'){
    ensureLeaderboard();
  }
}
(function bindMyUsageNav(){
  const nav=document.getElementById('myUsageNav');
  if(!nav)return;
  nav.addEventListener('click',function(e){
    const b=e.target.closest('.nav-btn');
    if(b)setSection(b.dataset.section,false);
  });
  nav.addEventListener('keydown',function(e){
    if(['ArrowDown','ArrowRight','ArrowUp','ArrowLeft','Home','End'].indexOf(e.key)<0)return;
    const btns=[].slice.call(nav.querySelectorAll('.nav-btn'));
    const i=btns.indexOf(document.activeElement);
    if(i<0)return;
    let n=i;
    if(e.key==='ArrowDown'||e.key==='ArrowRight')n=(i+1)%btns.length;
    else if(e.key==='ArrowUp'||e.key==='ArrowLeft')n=(i-1+btns.length)%btns.length;
    else if(e.key==='Home')n=0;
    else n=btns.length-1;
    e.preventDefault();
    setSection(btns[n].dataset.section,true);
  });
})();

// ── 排行榜 ──
// 维度清单、单位、以及「好的方向」全部由服务端随响应下发,前端不硬编码 ——
// 加维度只改 lib/leaderboard.mjs 一处,不会出现前后端各写一份而慢慢漂移。
// 默认维度/窗口同理:首次请求不带参数,服务端回落后再把结果同步回 LB,默认值只写一遍。
const LB={dim:'',win:'',data:null,error:'',loading:false};
const LB_WINDOWS=[['today','今日'],['week','本周'],['month','本月']];
// 皇冠只给领奖台最高的那张。SVG 的初始 fill 是黑、初始 stroke 是 none,所以下面这串
// 属性一个都不能省:少了 fill="none" 闭合路径会糊成一团实心黑块,少了 stroke 开放路径
// 什么都画不出来,而且两者都是静默的 —— 不报错,只是画错。stroke-width 取 2.5:viewBox 24
// 缩到 18px 是 0.75 倍,写 2 只有 1.5px,细得不像图标(与侧栏 navIco 同规格)。
const LB_CROWN='<svg class="lb-crown" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 15 4 7.5l4.2 3L12 5l3.8 5.5L20 7.5 18.5 15z"/><path d="M4 17.5h16"/></svg>';
// 升起动效只播一次。置位点必须写在真的渲染出领奖台的那个分支里 —— 写在函数开头会被
// 上面「加载中」那次占位渲染白白消耗掉(首次进入走的就是那条路),动画就永远不会播。
let lbPodiumDone=false;
function fmtLbVal(v){
  if(v==null)return'';
  if(Math.abs(v)>=10000)return fmtTk(v);
  return Number.isInteger(v)?fmtT(v):v.toFixed(1);
}
// 列表行与奖牌卡共用一套取值渲染。抽出来不只是去重:fmtLbVal(null) 返回的是**空串**,
// 少了 has 判断就会渲染出「一个孤零零的单位挂在空值后面」;而 unit 是服务端原样下发的,
// fmtLbVal 返回的字符串里**已经把 k/M 后缀烤进去了**,所以单位只能整个 esc 出去,
// 千万别按「数字 + 单位」的样子把后缀再拆一份进来。
function lbValueHtml(cls,v,unit){
  const has=v!=null;
  return '<div class="'+cls+(has?'':' none')+'">'
    +(has?'<b>'+fmtLbVal(v)+'</b><span>'+esc(unit||'')+'</span>':'<b>无数据</b>')
    +'</div>';
}
function renderLbSegs(){
  const dimBox=document.getElementById('lbDim');
  if(dimBox){
    dimBox.innerHTML=((LB.data&&LB.data.dimensions)||[]).map(function(x){
      return '<button type="button" role="tab" aria-selected="'+(x.key===LB.dim)+'" data-dim="'+esc(x.key)+'" class="'+(x.key===LB.dim?'on':'')+'">'+esc(x.label)+'</button>';
    }).join('');
  }
  const winBox=document.getElementById('lbWin');
  if(winBox){
    winBox.innerHTML=LB_WINDOWS.map(function(w){
      return '<button type="button" role="tab" aria-selected="'+(w[0]===LB.win)+'" data-win="'+w[0]+'" class="'+(w[0]===LB.win?'on':'')+'">'+w[1]+'</button>';
    }).join('');
  }
}
function renderLeaderboard(){
  const board=document.getElementById('lbBoard'),sub=document.getElementById('lbSub'),note=document.getElementById('lbNote');
  if(!board)return;
  renderLbSegs();
  if(LB.error){board.innerHTML='<div class="lb-msg">加载失败：'+esc(LB.error)+'</div>';if(sub)sub.textContent='';if(note)note.innerHTML='';return}
  if(!LB.data){board.innerHTML='<div class="lb-msg">加载中…</div>';if(sub)sub.textContent='';return}
  const d=LB.data;
  // 服务端回落的维度/窗口同步回来,保证按钮高亮与真实的排序口径一致
  if(d.dimension)LB.dim=d.dimension;
  if(d.window)LB.win=d.window;
  renderLbSegs();
  if(sub)sub.textContent=(d.from||'')+' ~ '+(d.to||'');
  if(note)note.innerHTML=(d.hint?'<span class="lb-hint">'+esc(d.hint)+'</span>':'')+(d.note?'<span class="lb-flag">'+esc(d.note)+'</span>':'');
  const rows=d.rows||[],c=d.cohort||{};
  if(!rows.length){board.innerHTML='<div class="lb-msg">本期还没有人产生用量</div>';return}
  // 领奖台只在「够格」时才出现:排满三个人,而且三个人都有真实数字。
  // 榜单常常只有一两行(lib/leaderboard.mjs 那边写着「那不是故障而是实情」),一行时立起
  // 一座戴皇冠的金卡,是把微不足道的「赢」渲染成一场比赛;两行时第 2 名会站到第 1 名左边、
  // 第 3 个位置空着,像布局坏了。null 恒排末尾,所以前三名里出现 null 恰恰说明有数字的人
  // 不足三个 —— 那也不该有领奖台。这两种情形整张榜退回原来的列表行,名次圆牌照旧上色。
  const top=rows.slice(0,3);
  const podium=rows.length>=3&&top.every(function(r){return r.value!=null});
  const listed=podium?rows.slice(3):rows;
  let body='';
  if(podium){
    body+='<div class="lb-podium'+(lbPodiumDone?'':' anim')+'">'+top.map(function(r,i){
      // 台阶用**位置**取类名、用 r.rank 取数字:位置永远只该有三档,而名次是服务端给的
      // 标签。今天两者必然一致(r.rank = i+1),但台阶的形态不该被上游的排名口径牵着走。
      return '<div class="lb-pod lb-pod-'+(i+1)+(r.isMe?' me':'')+'">'
        +(r.rank===1?LB_CROWN:'')
        +'<div class="lb-pod-rank">'+r.rank+'</div>'
        +'<div class="lb-pod-name"><span class="lb-pod-nm">'+esc(r.user_name)+'</span>'+(r.isMe?'<span class="tag">我</span>':'')+'</div>'
        +'<div class="lb-pod-det">活跃 '+r.detail.active_days+' 天 · '+fmtT(r.detail.requests)+' 次请求'+(r.detail.has_edit?'':' · 无代码产出')+'</div>'
        +lbValueHtml('lb-pod-value',r.value,d.unit)
        +'</div>';
    }).join('')+'</div>';
    lbPodiumDone=true;
  }
  if(listed.length){
    body+='<div class="lb-list">'+listed.map(function(r){
      return '<div class="lb-row'+(r.isMe?' me':'')+(r.rank<=3?' r'+r.rank:'')+'">'
        +'<span class="lb-rank">'+r.rank+'</span>'
        +'<div class="lb-who"><div class="lb-name">'+esc(r.user_name)+(r.isMe?' <span class="tag">我</span>':'')+'</div>'
        +'<div class="lb-det">'+esc(r.user_key)+' · 活跃 '+r.detail.active_days+' 天 · '+fmtT(r.detail.requests)+' 次请求'+(r.detail.has_edit?'':' · 无代码产出')+'</div></div>'
        +lbValueHtml('lb-val',r.value,d.unit)
        +'</div>';
    }).join('')+'</div>';
  }
  // 榜单常常只有一行(窗口内只有一个人在跑),那不是故障而是实情。cohort 那行把
  // 「本期 N 人活跃 · 共 M 人」摆出来,界面才说得出榜单为什么这么短。
  // 一次写进去:拆成两次 += 会重新解析整个 innerHTML,把刚建好的领奖台节点连同
  // 已经挂上的动效一起重建一遍。
  board.innerHTML='<div class="lb-cohort">本期 <b>'+(c.active||0)+'</b> 人活跃 · 共 '+(c.total||0)+' 人 · 按「'+esc(d.dimensionLabel||'')+'」'+(d.direction==='asc'?'由低到高':'由高到低')+'排序'+(d.me?'':' · 你本期无数据')+'</div>'+body;
}
async function fetchLeaderboard(){
  if(LB.loading)return;
  LB.loading=true;
  renderLbSegs();                     // 立刻高亮刚点的那个,不等请求回来
  if(!LB.data)renderLeaderboard();    // 只有首次进入才需要「加载中」占位
  try{
    const r=await fetch('/api/leaderboard?dimension='+encodeURIComponent(LB.dim)+'&window='+encodeURIComponent(LB.win),{headers:{'Authorization':'Bearer '+VK}});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||('HTTP '+r.status));
    LB.data=j;LB.error='';
  }catch(e){LB.error=e.message||'加载失败';LB.data=null}
  LB.loading=false;
  renderLeaderboard();
}
function ensureLeaderboard(){if(!LB.data&&!LB.loading)fetchLeaderboard()}
(function bindLeaderboardControls(){
  const dimBox=document.getElementById('lbDim');
  if(dimBox)dimBox.addEventListener('click',function(e){
    const b=e.target.closest('button[data-dim]');
    if(!b||(b.dataset.dim===LB.dim&&LB.data))return;
    LB.dim=b.dataset.dim;fetchLeaderboard();
  });
  const winBox=document.getElementById('lbWin');
  if(winBox)winBox.addEventListener('click',function(e){
    const b=e.target.closest('button[data-win]');
    if(!b||(b.dataset.win===LB.win&&LB.data))return;
    LB.win=b.dataset.win;fetchLeaderboard();
  });
})();

// ── 项目分布 / 会话使用情况(成员侧) ─────────────────────────────────────────
// 数据来自 /api/my-activity,与 /api/my-usage 是两份:那份是「今日 + 各方案配额」的
// 实时快照,这份是「近 7 天 · 按会话聚合」的项目与习惯视图。所以两块各自独立拉取、
// 各自独立渲染,谁也不去动对方的 DOM,也不跟着 30 秒轮询刷新。
//
// 三个如实披露点,全部由服务端下发的字段驱动,前端不自己算:
//   · token_data=false → token 与缓存率显示「—」而不是 0。采集上线前的历史会话没有
//     token 记录,那是「没测到」,写成 0 会被读成「真的花了 0 token、命中 0%」。
//   · unattributed → 无会话标识、归属不到任何会话的那部分请求,必须写出来,
//     否则读者会把上表的合计当成全量。
//   · crossSessions → 横跨多个项目的会话,其 token 只能整段记在主项目名下,
//     次项目的 token 因此偏低。不写出来,那个数字会被当成错的。
const ACT={data:null,error:'',loading:false,queued:false};
const DASH='<span style="color:var(--dim)">—</span>';
const GRADE_CLS={good:'good',warn:'warn',bad:'bad'};
const THS_FALLBACK={cache_rate_good:.9,cache_rate_warn:.8,new_input_good:3000,new_input_bad:8000,fragment_max_requests:2};
// 首末时刻是 UTC ISO,展示一律北京(全站口径)。跨天是常态(会话能挂很久),
// 所以详情行带月日,而同一会话内部用纯时分更省地方。
function cnStamp(iso){
  const t=Date.parse(iso||'');
  if(!Number.isFinite(t))return '';
  const s=new Date(t+8*3600000).toISOString();
  return s.slice(5,10).replace('-','/')+' '+s.slice(11,16);
}
function fmtDur(ms){
  if(ms==null)return '';
  const m=Math.round(ms/60000);
  if(m<1)return '不足 1 分钟';
  if(m<60)return m+' 分钟';
  return Math.floor(m/60)+' 小时 '+(m%60)+' 分';
}
// 会话标识的前缀(hdr:/pck:/dig:)说明这个标识是怎么来的,留着比一串 uuid 好认
function sessShort(id){
  const raw=String(id||'');
  const i=raw.indexOf(':');
  return i>0?raw.slice(0,i+1)+raw.slice(i+1,i+9):raw.slice(0,9);
}
function ratioCell(rate,ths){
  if(rate==null)return DASH;
  const col=rate>=ths.cache_rate_good?'var(--green)':rate>=ths.cache_rate_warn?'var(--orange)':'var(--red)';
  return '<span style="color:'+col+'">'+(rate*100).toFixed(1)+'%</span>';
}
function perTurnCell(v,ths){
  if(v==null)return DASH;
  const col=v<=ths.new_input_good?'var(--green)':v<=ths.new_input_bad?'var(--orange)':'var(--red)';
  return '<span style="color:'+col+'">'+fmtT(Math.round(v))+'</span> <span style="color:var(--dim)">token/轮</span>';
}
// 两张表共用的一段脚注:归属不到会话的那部分 + 统计范围。范围必须写清楚,因为
// 上方的方案筛选(全部 / 单个方案)不影响这两块 —— 它们是全方案的近 7 天视图。
function actScopeNote(d,unit){
  const ths=Object.assign({},THS_FALLBACK,d.thresholds||{});
  const out=['统计范围 '+esc(d.from)+' ~ '+esc(d.to)+' · 全部方案'
    +(currentProfile==='all'?'':' · <b>上方的方案筛选不影响这两块</b>')];
  const un=d.unattributed||{};
  if(un.requests>0){
    out.push('另有 '+fmtT(un.requests)+' 次请求没有会话标识('+fmtTk(un.tokens)+' token),无法归属到任何'
      +(unit||'会话')+',未计入上表');
  }
  return {notes:out,ths:ths};
}
// 脚注块。第 1 条永远是 actScopeNote() 放在首位的「统计范围 …」—— 它是这一块的题头,和后面的
// 披露事项不是一类东西,所以单独给个类名让它重一档。两个面板共用一份渲染,免得两处各写一份 map
// 再慢慢长歪(它们的长句文案已经有好几条了)。
function notesHtml(notes){
  return '<div class="sess-note-list">'+notes.map(function(t,i){
    return '<div'+(i===0?' class="sess-note-scope"':'')+'>'+t+'</div>';
  }).join('')+'</div>';
}
// 指标格只放数字,单位与口径集中在表格下方说一次。5 张卡的说明文字删掉之后,「单轮新增」是什么、
// 量纲是什么,只剩这里能说 —— 不说,那两个数字就没有解释了。
const UNIT_NOTE='指标口径:单轮新增 = 每轮平均新增 token · 净产出 = 增行减删行(单位:行)';
function renderProjDist(){
  const box=document.getElementById('projDist'),tb=document.querySelector('#projDistTable tbody'),note=document.getElementById('projDistNote');
  if(!box||!tb)return;
  const d=ACT.data,rows=d.projects||[];
  if(!rows.length){box.style.display='none';return}
  box.style.display='';
  // 项目分布的数据来自 /api/my-activity,日期随「会话使用情况」面板的筛选走 ——
  // 在这里写明,免得被读成「分析面板的日期筛选对它失效了」。
  const ps=document.getElementById('projScope');
  if(ps)ps.textContent=' · 日期随「会话使用情况」面板的筛选';
  const sc=actScopeNote(d,'项目');
  tb.innerHTML=rows.map(function(p){
    return '<tr>'
      +'<td style="color:var(--blue)">'+esc(p.project)+'</td>'
      +'<td class="n">'+(p.files==null?DASH:fmtT(p.files))+'</td>'
      +'<td class="n">'+(p.net_lines==null?DASH:((p.net_lines>0?'+':'')+fmtT(p.net_lines)))+'</td>'
      +'<td class="n">'+(p.token_data?fmtTk(p.tokens):DASH)+'</td>'
      +'<td class="n">'+ratioCell(p.cache_rate,sc.ths)+'</td>'
      +'</tr>';
  }).join('');
  if(d.crossSessions>0){
    sc.notes.push('有 '+fmtT(d.crossSessions)+' 个会话横跨多个项目:token 是按会话记的,整段算在了它的主项目名下,次项目的 token 会因此偏低');
  }
  note.innerHTML=notesHtml(sc.notes);
}
function renderSessSummary(){
  const el=document.getElementById('sessSummary');
  if(!el)return;
  const d=ACT.data,s=d.sessionSummary||{},sc=actScopeNote(d,'会话');
  const share=s.fragment_share==null?null:s.fragment_share;
  // 每张卡只留三件东西:标签、数字、以及**属于这张卡的数据**(碎片数、平均轮数、工具调用总数
  // 都是别处拿不到的)。「越高说明上下文复用得越好」「越低越省:每轮重发的量」是纯谓语、一个
  // 数字都没有 —— 每张卡挂一句解释,5 处重复比 1 处集中说明更难扫。单轮新增与净产出的口径
  // 改由表下那一行 UNIT_NOTE 承担。
  const card=(l,v,sub)=>'<div class="card"><div class="l">'+l+'</div><div class="v">'+v+'</div>'
    +(sub?'<div style="margin-top:6px;font-size:10px;color:var(--dim)">'+sub+'</div>':'')+'</div>';
  el.innerHTML=
    card('会话数',fmtT(s.sessions||0),'碎片 '+(s.fragments||0)+' 个'+(share==null?'':' · '+Math.round(share*100)+'%'))
    +card('总轮数',fmtT(s.requests||0),'平均每会话 '+(s.sessions?Math.round(s.requests/s.sessions*10)/10:0)+' 轮')
    +card('缓存率',ratioCell(s.cache_rate,sc.ths))
    +card('平均单轮新增上下文',perTurnCell(s.new_input_per_turn,sc.ths))
    +card('工具失败率',s.fail_rate==null?DASH:'<span style="color:'+(s.fail_rate<.1?'var(--green)':s.fail_rate<.3?'var(--orange)':'var(--red)')+'">'+(s.fail_rate*100).toFixed(1)+'%</span>',fmtT(s.tool_calls||0)+' 次工具调用');
}
// 会话卡片。三层:身份行 / 指标格 / 建议列表,靠两条分隔线分层(表格顶部实线、建议顶部虚线)。
// title 属性覆盖每一格的完整口径与未缩写原值 —— fmtTk 会把 1,234,567 缩成 1.2M,原数只在这儿拿得回。
function renderSessBoard(){
  const board=document.getElementById('sessBoard');
  if(!board)return;
  const d=ACT.data,rows=d.sessions||[];
  if(!rows.length){board.innerHTML='<div class="lb-msg">'+esc(d.from)+' ~ '+esc(d.to)+' 还没有可归属到会话的请求</div>';return}
  const ths=Object.assign({},THS_FALLBACK,d.thresholds||{});
  // 一格。标签恒在、数值恒在:缺值写「—」而不是把这一格省掉,否则列会塌、行与行就对不齐。
  // dim=true 表示「—」或「测到了就是 0」,压成一档灰退后,但仍然占满一整格宽。
  const cell=function(label,val,dim,title){
    return '<div class="sess-m'+(dim?' na':'')+'" title="'+title+'"><i>'+label+'</i><b>'+val+'</b></div>';
  };
  // 卡片之间要有间隙:#sessBoard 原来是裸 div、没有任何规则命中,行与行的边框直接相贴连成一整片
  // (排行榜那边是靠 .lb-list{gap:6px} 拉开的)。间隙补在这一层,不用去动 pages.mjs。
  board.innerHTML='<div class="sess-list">'+rows.map(function(s){
    const g=GRADE_CLS[s.grade]||'none';
    // 会话名(本机 Claude Code 的 ai-title,后端现读)优先当主标题;没有才退回项目标签,
    // 再没有才是「纯问答」占位。项目与标识都是辅助信息,降到下面那行小字。标识串任何时候都
    // 保留:它是唯一能对上盘上文件的键。
    const name=s.title?esc(s.title):(s.project?esc(s.project):'<span style="color:var(--dim)">纯问答 · 无代码产出</span>');
    const idLine=(s.title&&s.project?esc(s.project)+' · ':'')+esc(sessShort(s.session))
      // 客户端与管理端流水同一套用词(clientLabel);迁移前旧行没采集过,省略比一个灰「—」干净。
      +(s.client?' · '+esc(clientLabel(s.client)):'');
    const when=s.first_seen===s.last_seen?cnStamp(s.first_seen):(cnStamp(s.first_seen)+' → '+cnStamp(s.last_seen));
    // 时长是八格里最宽的一格(fmtDur 的空格是给「一句话里读」加的,进了定宽格会白占宽度,
    // 去掉后实测 70.6px;次宽的 Token 只有 56.8)。列宽分档就是按 70.6 定的,见 my-usage.css
    // 里 .sess-grid 上方那段。完整写法带空格,留在 title 里。
    const dur=s.duration_ms!=null?fmtDur(s.duration_ms).replace(/\s+/g,''):null;
    const nit=s.new_input_per_turn==null?null:Math.round(s.new_input_per_turn);
    const nx=s.net_lines==null?null:(s.net_lines>0?'+':'')+fmtT(s.net_lines);
    // 跨项目:后端给的是 `p ? p.cross : 0`(lib/sessions.mjs),**没有项目归属时也是 0**,不是
    // 「测到了 0」。必须先看 project 在不在,否则纯问答会话会被标成「跨 0 个项目」—— 假数据。
    const cross=s.project==null?null:(s.cross_projects||0);
    const cells=
      (s.requests?cell('轮数',fmtT(s.requests),false,'轮数 '+fmtT(s.requests)+' 轮')
                 :cell('轮数','未知',true,'轮数未知(这个会话只有工具记录,没有请求计数)'))
      +(dur!=null?cell('时长',dur,false,'会话跨度 '+fmtDur(s.duration_ms))
                 :cell('时长','—',true,'时长无数据(首末时刻缺失)'))
      +(s.token_data?cell('Token',fmtTk(s.tokens),false,'Token '+fmtT(s.tokens))
                    :cell('Token','—',true,'该会话早于 token 按会话采集上线,没有 token 记录'))
      +(nit!=null?cell('单轮新增',fmtT(nit),false,'单轮新增 '+fmtT(nit)+' token/轮')
                 :cell('单轮新增','—',true,'单轮新增无数据(轮数为 0,或没有输入记录)'))
      +(s.tool_calls!=null?cell('工具',fmtT(s.tool_calls),s.tool_calls===0,'工具调用 '+fmtT(s.tool_calls)+' 次')
                          :cell('工具','—',true,'没有这个会话的工具记录'))
      +(s.files!=null?cell('文件',fmtT(s.files),s.files===0,'涉及文件 '+fmtT(s.files)+' 个')
                     :cell('文件','—',true,'没有这个会话的文件记录'))
      +(nx!=null?cell('净产出',nx,s.net_lines===0,'净产出 '+fmtT(s.net_lines)+' 行(增行减删行)')
                :cell('净产出','—',true,'没有这个会话的代码行记录'))
      +(cross!=null?cell('跨项目',fmtT(cross),cross===0,'跨 '+fmtT(cross)+' 个项目')
                   :cell('跨项目','—',true,'这个会话没有项目归属,跨项目数未知'));
    // 缓存率留在右上原位,不并进指标格:它是这一行唯一带阈值配色的结论性数字,并进去就跟 466、
    // 377 一样大,权重被打平;而且窄屏退成两行时它会被甩到第三行,偏偏它是最该先看到的数字。
    const cache=s.cache_rate==null
      ?'<div class="sess-cache none"><b>缓存率 —</b></div>'
      :'<div class="sess-cache"><b style="color:'+(s.cache_rate>=ths.cache_rate_good?'var(--green)':s.cache_rate>=ths.cache_rate_warn?'var(--orange)':'var(--red)')+'">'+(s.cache_rate*100).toFixed(0)+'%</b><span>缓存率</span></div>';
    // 建议逐条一行。原来 .join('；') 挤成一段散文 —— 一条一行之后不需要分隔符,那个 join 整个消失。
    const adv=s.advice||[];
    return '<div class="sess-row '+g+'">'
      +'<div class="sess-hd">'
        +'<span class="sess-grade">'+(s.gradeLabel?esc(s.gradeLabel):'—')+'</span>'
        +'<div class="sess-id"><div class="sess-title">'+name+'</div>'
          +'<div class="sess-meta">'+idLine+'</div>'
          +(when?'<div class="sess-meta">'+esc(when)+'</div>':'')
        +'</div>'
        +cache
      +'</div>'
      +'<div class="sess-grid">'+cells+'</div>'
      +(adv.length?'<ul class="sess-adv">'+adv.map(function(a){return '<li>'+esc(a)+'</li>'}).join('')+'</ul>':'')
      +'</div>';
  }).join('')+'</div>';
}
function renderActivity(){
  const pd=document.getElementById('projDist');
  if(ACT.error){
    // 项目分布与会话使用情况是同一份载荷,拉不到就两边都没数据。错误要往**两个面板各写一份**:
    // 它们现在分属不同菜单,只写会话那边的话,用量分析里的项目分布会无声消失、一个字都没有,
    // 看着像功能坏了。所以项目分布不再整体隐藏,而是保留盒子、清空表格、把错误写进脚注。
    const msg='<div class="lb-msg">加载失败：'+esc(ACT.error)+'</div>';
    if(pd){
      pd.style.display='';
      const ptb=document.querySelector('#projDistTable tbody');if(ptb)ptb.innerHTML='';
      const pn=document.getElementById('projDistNote');if(pn)pn.innerHTML=msg;
    }
    const b=document.getElementById('sessBoard');if(b)b.innerHTML=msg;
    const sm=document.getElementById('sessSummary');if(sm)sm.innerHTML='';
    const sn=document.getElementById('sessNote');if(sn)sn.innerHTML='';
    return;
  }
  if(!ACT.data)return;
  // #sessBox 的显隐已经交给所在面板了(它自己那个 pane 管 hidden),这里不再插手 ——
  // 原先这里有一句把 #sessBox 显式打开的代码,那是因为骨架里那个盒子内联了 display:none。
  renderProjDist();
  renderSessSummary();
  renderSessBoard();
  const d=ACT.data,sc=actScopeNote(d,'会话');
  const nt=document.getElementById('sessNote');
  if(nt){
    const tless=(d.sessions||[]).filter(function(s){return !s.token_data}).length;
    if(tless>0)sc.notes.push('有 '+fmtT(tless)+' 个会话早于 token 按会话采集上线,只有工具数据,token 与缓存率显示「—」');
    if(d.fragments_note)sc.notes.push(esc(d.fragments_note));
    if(d.truncated)sc.notes.push('会话流水只显示最近 '+fmtT((d.sessions||[]).length)+' 条');
    sc.notes.splice(1,0,UNIT_NOTE);   // 口径说明紧跟范围行,排在披露事项之前
    nt.innerHTML=notesHtml(sc.notes);
  }
}
async function fetchActivity(){
  if(ACT.loading){ACT.queued=true;return}
  ACT.loading=true;
  if(!ACT.data){const b=document.getElementById('sessBoard');if(b)b.innerHTML='<div class="lb-msg">加载中…</div>'}
  try{
    // 会话面板的日期窗口(SESS):默认档「本周」也照常传 start/end。
    const qp='start='+encodeURIComponent(SESS.start||'')+'&end='+encodeURIComponent(SESS.end||'');
    const r=await fetch('/api/my-activity?'+qp,{headers:{'Authorization':'Bearer '+VK}});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||('HTTP '+r.status));
    ACT.data=j;ACT.error='';
  }catch(e){ACT.error=e.message||'加载失败';ACT.data=null}
  ACT.loading=false;
  renderActivity();
  // 拉取期间筛选又被改过(queued):按最新参数再拉一次,别让旧窗口的产物留在页面上。
  if(ACT.queued){ACT.queued=false;fetchActivity()}
}
// 首次进入「用量分析」或「会话使用情况」才拉,不挂 30 秒轮询 —— 与排行榜同一处理
function ensureActivity(){if(!ACT.data&&!ACT.loading)fetchActivity()}

setSection('overview',false);
// 日期筛选控件放在最后初始化:两个面板此刻都还隐藏,只写 innerHTML 不读宽度,安全。
renderRangeCtl('anaRangeCtl',ANA,analysisRangeChanged);
renderRangeCtl('sessRangeCtl',SESS,sessRangeChanged);
