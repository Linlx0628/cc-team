Chart.defaults.color='#686863';Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei","Segoe UI",sans-serif';Chart.defaults.font.size=11;
// public/assets/dashboard.js —— 管理仪表盘页（dashboardHtml，/dashboard）的客户端逻辑。
// 页面内联引导脚本先注入 toast() 及 UI_HELPERS 提供的辅助函数再加载本文件；
// 全部数据经 /api/* 运行时拉取，文件不含任何密钥，可长期强缓存（?v= 内容版本号）。
let D=null,P="day",C={t:null,p:null,m:null,h:null,hm:null,pr:null},errPage=1,autoRefresh=true,refreshTimer=null,currentProfile="all",PROTO="";
let MDL="all",USR="all",MT="tokens";
let DS="",DE="";
let activeWorkspaceTab="users";
let quotaFocus=(function(){try{return localStorage.getItem('tm_quota_focus')==='1'}catch(e){return false}})();
const ERR_PAGE_SIZE=20;
const DETAIL_PAGE_SIZE=10;
let detailPage=1,detailQuery="",detailRange="all",detailSort="time",detailInitialized=false;
const expandedDetailPeriods=new Set();
const COL=["#2f6e50","#4a6fa5","#c2604f","#c4a23a","#7a6bb0","#d4824a","#4a9ba8","#c47a99","#6ba368","#5a6bc4","#8a6db5","#5a9b8e"];
const escH=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtT=n=>n.toLocaleString("zh-CN");
const fmtTk=n=>{if(n>=1e6)return(n/1e6).toFixed(1)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"k";return n.toString()};
function fmtBJ(iso){if(!iso)return"-";const d=new Date(iso);const utc=d.getTime()+d.getTimezoneOffset()*60000;return new Date(utc+8*3600000).toLocaleString("zh-CN")};
// Beijing wall-clock from a UTC/ISO instant: bjClock = MM-DD HH:mm (short,
// used by the alert table); bjDateStr = YYYY-MM-DD Beijing day (for comparing
// instants stored as UTC against a Beijing-date key).
function bjClock(iso){if(!iso)return"-";const d=new Date(new Date(iso).getTime()+8*3600000);const p=n=>String(n).padStart(2,'0');return p(d.getUTCMonth()+1)+'-'+p(d.getUTCDate())+' '+p(d.getUTCHours())+':'+p(d.getUTCMinutes())}
function bjDateStr(iso){if(!iso)return"";return new Date(new Date(iso).getTime()+8*3600000).toISOString().slice(0,10)}
function ago(iso){if(!iso)return"-";const d=Date.now()-new Date(iso).getTime();const m=Math.floor(d/6e4);if(m<1)return"刚刚";if(m<60)return m+"分钟前";const h=Math.floor(m/60);if(h<24)return h+"小时前";return Math.floor(h/24)+"天前"}
function wk(s){const d=new Date(s),day=d.getDay()||7,mon=new Date(d);mon.setDate(d.getDate()-day+1);return mon.toISOString().slice(0,10)}
function grp(daily,p){const g={};for(const[day,ud]of Object.entries(daily)){const k=p==="week"?wk(day):p==="month"?day.slice(0,7):p==="year"?day.slice(0,4):day;if(!g[k])g[k]={};for(const[u,s]of Object.entries(ud)){if(!g[k][u])g[k][u]={inputTokens:0,outputTokens:0,requests:0,cacheCreationTokens:0,cacheReadTokens:0};g[k][u].inputTokens+=s.inputTokens;g[k][u].outputTokens+=s.outputTokens;g[k][u].requests+=s.requests;g[k][u].cacheCreationTokens+=(s.cacheCreationTokens||0);g[k][u].cacheReadTokens+=(s.cacheReadTokens||0)}}return g}
function lbl(p,k){if(p==="day")return k.slice(5);if(p==="week")return k.slice(5)+" 周";if(p==="month")return k;return k+"年"}
// 当前周期窗口（北京时间）：日=今天、周=本周一、月=本月 1 日、年=本年 1 月 1 日。
function winBounds(){const t=new Date(Date.now()+8*36e5).toISOString().slice(0,10);return{wStart:P==="day"?t:P==="week"?wk(t):P==="month"?t.slice(0,7)+"-01":t.slice(0,4)+"-01-01",td:t}}
// 四张非 24h 图的有效窗口:日期范围(开始/结束)生效时用它,否则退回周期窗口。
// 日期范围只做窗口过滤,分桶粒度仍由周期 tabs 控制(两者正交)。
function effBounds(){
  if(DS||DE){const t=winBounds().td;return{start:DS||"0000-01-01",end:DE||t,ranged:true}}
  const{wStart,td}=winBounds();return{start:wStart,end:td,ranged:false};
}
function onDateRangeChange(){
  DS=document.getElementById("dateStart").value||"";
  DE=document.getElementById("dateEnd").value||"";
  if(DS&&DE&&DS>DE){[DS,DE]=[DE,DS];document.getElementById("dateStart").value=DS;document.getElementById("dateEnd").value=DE}
  render();
}
// 图表数据源：模型筛选生效时由 dailyModels（已按掩码 key 对齐）重建不含缓存的日粒度数据；
// 仅用户筛选时过滤 daily；无筛选直接用 daily。与 grp()/totalTokens() 的字段约定兼容。
function filteredDaily(){
  if(MDL!=="all"){
    const out={};
    for(const[date,users]of Object.entries(D.dailyModels||{})){
      for(const[u,models]of Object.entries(users)){
        const v=models[MDL];if(!v)continue;
        if(!out[date])out[date]={};
        out[date][u]={inputTokens:v.inputTokens||0,outputTokens:v.outputTokens||0,requests:v.requests||0,cacheCreationTokens:0,cacheReadTokens:0};
      }
    }
    if(USR==="all")return out;
    const f={};for(const[date,ud]of Object.entries(out)){if(ud[USR])f[date]={[USR]:ud[USR]}}return f;
  }
  if(USR==="all")return D.daily||{};
  const f={};for(const[date,ud]of Object.entries(D.daily||{})){if(ud[USR])f[date]={[USR]:ud[USR]}}return f;
}
function c(l,v,cl,k){return'<div class="card"><div class="l">'+l+'</div><div class="v" data-cu="'+v+'"'+(k?' data-cu-k':'')+'>0</div></div>'}
let chartResizeFrame=0;
function doughnutLegend(){const compact=innerWidth<1280;return{position:"bottom",labels:{color:"#686863",font:{size:compact?10:11},padding:compact?6:10,boxWidth:compact?16:24}}}
function trendLegend(){const compact=innerWidth<=820;return{labels:{color:"#686863",font:{size:compact?9:11},padding:compact?6:10,boxWidth:compact?16:40}}}
function scheduleChartResize(){cancelAnimationFrame(chartResizeFrame);chartResizeFrame=requestAnimationFrame(()=>{for(const chart of[C.p,C.m]){if(chart){chart.options.plugins.legend={display:false};chart.update("none")}}for(const chart of[C.t,C.hm,C.pr]){if(chart){chart.options.plugins.legend=trendLegend();chart.update("none")}}Object.values(C).forEach(chart=>chart&&chart.resize())})}
function setWorkspaceTab(tab,focus){
  const next=document.getElementById("workspace-tab-"+tab),panel=document.getElementById("workspace-panel-"+tab);
  if(!next||!panel)return;
  activeWorkspaceTab=tab;
  document.querySelectorAll(".workspace-tab").forEach(button=>{const selected=button===next;button.setAttribute("aria-selected",String(selected));button.tabIndex=selected?0:-1});
  document.querySelectorAll(".workspace-content>[role=tabpanel]").forEach(item=>{const selected=item===panel;item.hidden=!selected;item.classList.toggle("active",selected)});
  if(focus)next.focus();
  scheduleChartResize();
}
function handleWorkspaceTabKeydown(event){
  const tabs=[...document.querySelectorAll(".workspace-tab")],index=tabs.indexOf(event.currentTarget);let next=index;
  if(event.key==="ArrowRight")next=(index+1)%tabs.length;else if(event.key==="ArrowLeft")next=(index-1+tabs.length)%tabs.length;else if(event.key==="Home")next=0;else if(event.key==="End")next=tabs.length-1;else return;
  event.preventDefault();setWorkspaceTab(tabs[next].id.replace("workspace-tab-",""),true);
}
function renderWorkspaceSummaries(){
  if(!D)return;
  document.getElementById("workspaceCountUsers").textContent=Object.keys(D.users||{}).length;
  document.getElementById("workspaceCountProfiles").textContent=Array.isArray(D.profileSummaries)?D.profileSummaries.length:0;
  document.getElementById("workspaceCountErrors").textContent=Array.isArray(D.errors)?D.errors.length:0;
  // Tab count = models priced individually, not total rows: that is the number an
  // admin is checking ("did my overrides take effect?").
  const board=Array.isArray(D.modelRateBoard)?D.modelRateBoard:[];
  document.getElementById("workspaceCountRates").textContent=board.filter(r=>r.custom).length;
}
// Fold a model's aliases + peak-aliases (across all its profiles) into compact
// chips; the tail collapses to "+N". Peak-only aliases carry a 峰 marker.
function rateAliasChips(entries){
  const seen=new Set(),list=[];
  for(const r of entries){
    for(const a of r.aliases){const k='A'+a;if(seen.has(k))continue;seen.add(k);list.push({t:a,pk:false});}
    for(const a of r.peakAliases){const k='P'+a;if(seen.has(k))continue;seen.add(k);list.push({t:a,pk:true});}
  }
  if(!list.length)return '<span class="rate-noalias">未被别名引用</span>';
  const shown=list.slice(0,3);
  const dots=shown.map(x=>'<span class="chip" title="'+escH(x.t)+(x.pk?'（高峰别名）':'')+'">'+escH(x.t)+(x.pk?'<i class="pk">峰</i>':'')+'</span>').join(' ');
  const rest=list.length-shown.length;
  return dots+(rest>0?' <span class="chip chip-more" title="'+escH(list.slice(3).map(x=>x.t+(x.pk?'(峰)':'')).join(', '))+'">+'+rest+'</span>':'');
}
// Model rate board. The chart above can only plot one number per model, so the
// answer to "which model is draining quota" lives here. Primary view is a ranked
// bar list of today's weighted quota by model (the number an admin is checking);
// a collapsed detail table keeps the precise per (profile × model) peak/off-peak
// rates for verifying overrides.
function renderRateBoard(){
  const body=document.getElementById("rateBoardBody"),
        cards=document.getElementById("rateBoardCards"),
        ctx=document.getElementById("rateBoardContext");
  if(!cards||!body)return;
  const rows=Array.isArray(D.modelRateBoard)?D.modelRateBoard:[];
  const emptyMsg='暂无模型 — 先在设置页配置模型别名';
  if(!rows.length){
    body.innerHTML='<tr><td colspan="7" class="empty">'+emptyMsg+'</td></tr>';
    cards.innerHTML='<div class="rate-empty">'+emptyMsg+'</div>';
    if(ctx)ctx.textContent="";
    return;
  }
  const customCount=rows.filter(r=>r.custom).length;
  const totalRaw=rows.reduce((s,r)=>s+r.todayRaw,0),totalW=rows.reduce((s,r)=>s+r.todayWeighted,0);
  // 顶部摘要（pill 行）：时段 + 单独定价数 + 今日综合倍率 + 实际→计入
  if(ctx){
    const inPeak=rows[0].inPeak;
    const segColor=inPeak?'var(--orange)':'var(--green)';
    const blended=totalRaw>0?Math.round(totalW/totalRaw*100)/100:null;
    ctx.innerHTML='<span class="rate-pill"><i class="dot" style="background:'+segColor+'"></i><b style="color:'+segColor+'">'+(inPeak?'高峰时段':'低谷时段')+'</b></span>'
      +'<span class="rate-pill">'+customCount+'/'+rows.length+' 单独定价</span>'
      +(blended!=null?'<span class="rate-pill">今日综合 ×'+blended+'</span>':'')
      +(blended!=null?'<span class="rate-pill">实际 '+fmtTk(totalRaw)+' → 计入 '+fmtTk(totalW)+'</span>':'');
  }
  // ① 主视图：按 model 聚合（同模型跨方案合并），按今日计入降序
  const byModel=new Map();
  for(const r of rows){
    let m=byModel.get(r.model);
    if(!m){m={model:r.model,todayWeighted:0,todayRaw:0,todayRequests:0,entries:[],custom:false};byModel.set(r.model,m);}
    m.todayWeighted+=r.todayWeighted;m.todayRaw+=r.todayRaw;m.todayRequests+=r.todayRequests;
    m.entries.push(r);if(r.custom)m.custom=true;
  }
  const models=[...byModel.values()].sort((a,b)=>b.todayWeighted-a.todayWeighted||b.todayRaw-a.todayRaw||a.model.localeCompare(b.model));
  const maxW=Math.max(0,...models.map(m=>m.todayWeighted));
  cards.innerHTML=models.map(m=>{
    const hasTraffic=m.todayWeighted>0;
    // Dominant profile today → its current effective rate drives the chip.
    const dom=m.entries.sort((a,b)=>b.todayWeighted-a.todayWeighted)[0];
    const rate=dom.rate;
    const pct=maxW>0?Math.max(2,Math.round(m.todayWeighted/maxW*100)):0;
    const profileTip=m.entries.map(r=>escH(r.profile)+'：峰×'+r.peak+' / 谷×'+r.offPeak+(r.custom?'（单独定价）':'')).join('　');
    // Realised ratio can differ from the configured rate: the day may straddle a
    // peak boundary, or a rate may have been changed mid-day. Flag it rather than
    // hiding it — a mismatch is information, not an error.
    const realised=m.todayRaw>0?Math.round(m.todayWeighted/m.todayRaw*100)/100:null;
    const drift=realised!=null&&Math.abs(realised-rate)>0.001;
    const rateCol=rate>1?'var(--orange)':rate<1?'var(--green)':'var(--text)';
    const chip='<span class="rate-chip" style="color:'+rateCol+';border-color:'+rateCol+'" title="'+profileTip+'">'
      +(rate===1?'×1':'×'+rate+'<i class="pk">'+(dom.inPeak||rows[0].inPeak?'峰':'谷')+'</i>')+'</span>';
    const customTag=m.custom?' <span class="rate-tag">单独定价</span>':'';
    const profTag=m.entries.length>1?' <span class="rate-profn">'+m.entries.length+' 方案</span>':'';
    const driftNote=drift?'<span class="rate-drift" title="今日实际计权比例与当前倍率不同：跨了高峰边界或期间调整过倍率">实收 ×'+realised+'</span>':'';
    return '<div class="rate-card'+(m.custom?' rate-custom':'')+(hasTraffic?'':' rate-zero')+'" title="'+profileTip+'">'
      +'<div class="rate-bar"><i style="width:'+pct+'%"></i></div>'
      +'<div class="rate-main">'
        +'<div class="rate-topline"><b class="rate-name">'+escH(m.model)+'</b>'+customTag+profTag+driftNote+'</div>'
        +'<div class="rate-alias">'+rateAliasChips(m.entries)+'</div>'
      +'</div>'
      +'<div class="rate-side">'
        +'<div class="rate-nums"><span class="rate-today hl">'+(hasTraffic?fmtTk(m.todayWeighted):'–')+'</span><span class="rate-req">'+(hasTraffic?m.todayRequests+' 请求':'无今日用量')+'</span></div>'
        +chip
      +'</div>'
      +'</div>';
  }).join("");
  // ② 配置明细表（可折叠，每 方案×模型 精确峰/谷）
  body.innerHTML=rows.map(r=>{
    const realised=r.todayRaw>0?Math.round(r.todayWeighted/r.todayRaw*100)/100:null;
    const drift=realised!=null&&Math.abs(realised-r.rate)>0.001;
    const rateCol=r.rate>1?'var(--orange)':r.rate<1?'var(--green)':'var(--text)';
    const aliasText=[...r.aliases,...r.peakAliases.map(a=>a+'(峰)')].join(', ')||'<span style="color:var(--dim)">未被别名引用</span>';
    const peakCell='<span'+(r.inPeak?' style="font-weight:650"':' style="color:var(--dim)"')+'>峰×'+r.peak+'</span>';
    const offCell='<span'+(!r.inPeak?' style="font-weight:650"':' style="color:var(--dim)"')+'>谷×'+r.offPeak+'</span>';
    return '<tr'+(r.custom?' style="background:rgba(47,110,80,.035)"':'')+'>'
      +'<td><b>'+escH(r.model)+'</b>'+(r.custom?' <span class="rate-tag">单独定价</span>':'')+'</td>'
      +'<td style="font-size:11px;color:var(--dim)">'+escH(r.profile)+'</td>'
      +'<td style="font-size:11px;color:var(--blue);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+escH(aliasText.replace(/<[^>]*>/g,''))+'">'+aliasText+'</td>'
      +'<td class="n"><b style="color:'+rateCol+'">×'+r.rate+'</b>'
        +(drift?' <span style="font-size:9px;color:var(--dim)" title="今日实际计权比例与当前倍率不同：跨了高峰边界或期间调整过倍率">实收 ×'+realised+'</span>':'')
        +'<div style="font-size:9px;color:var(--dim);margin-top:1px">'+peakCell+' / '+offCell+'</div>'
      +'</td>'
      +'<td class="n" style="color:var(--dim)">'+(r.todayRaw?fmtTk(r.todayRaw):'-')+'</td>'
      +'<td class="n hl">'+(r.todayWeighted?fmtTk(r.todayWeighted):'-')+'</td>'
      +'<td class="n">'+(r.todayRequests||'-')+'</td>'
      +'</tr>';
  }).join("");
}
function maskDetailKey(key){const value=String(key||"");return value.length<=12?value:value.slice(0,8)+"****"+value.slice(-4)}
// ── All-profiles quota columns ───────────────────────────────────────────────
// Swap the single 配额 header for one column per quota-bearing profile (or back).
// Rebuilt on every render because the profile set changes with the protocol
// filter and with config edits.
function renderUserTableHead(profiles){
  const head=document.getElementById("uTableHead");
  if(!head)return;
  const base='<th>用户</th><th>状态</th><th class="n stat-col">请求数</th><th class="n stat-col">输入</th><th class="n stat-col">输出</th><th class="n stat-col">缓存写入</th><th class="n stat-col">缓存命中</th><th class="n stat-col">合计</th><th class="n">今日</th>';
  const tail='<th>最后活跃</th>';
  if(!profiles){head.innerHTML=base+'<th class="n">配额</th>'+tail;return}
  const cols=profiles.map(p=>{
    const badge=p.billingType==='coding_plan'?'套餐':p.billingType==='token_plan'?'包月':'按量';
    const sub=p.memberCount>1?p.memberCount+' 个方案 · '+badge:badge;
    return '<th class="n q-col" title="'+escH(p.label)+'：'+escH(p.memberNames.join('、'))+'">'+escH(p.label)
      +'<span class="q-head-sub">'+escH(sub)+'</span></th>';
  }).join("");
  head.innerHTML=base+cols+tail;
}
// Many profiles + 6 token columns overflows horizontally; this collapses the
// statistics so the quota columns alone fill the width. Preference is remembered
// because an admin watching quotas wants it to stay on across refreshes.
function toggleQuotaFocus(){
  quotaFocus=!quotaFocus;
  try{localStorage.setItem('tm_quota_focus',quotaFocus?'1':'0')}catch(e){}
  applyQuotaFocus();
}
function applyQuotaFocus(){
  const table=document.getElementById("uTable"),btn=document.getElementById("qFocusBtn");
  if(table)table.classList.toggle("q-focus",quotaFocus);
  if(btn)btn.classList.toggle("on",quotaFocus);
}
// Header summary: how many members are near their limit, and where. This is the
// line that makes the table actionable without reading every row.
function renderUserQuotaContext(qm,userList){
  const head=document.getElementById("userQuotaHead"),ctx=document.getElementById("userQuotaContext");
  if(!head||!ctx)return;
  if(!qm){head.hidden=true;return}
  head.hidden=false;
  const matrix=qm.matrix||{};
  let full=0,warn=0,total=0;
  const hot=[];
  for(const [uk,byProfile] of Object.entries(matrix)){
    for(const [sfx,q] of Object.entries(byProfile)){
      total++;
      if(q.pct>=100){full++;hot.push({uk,sfx,pct:q.pct})}
      else if(q.pct>=80){warn++;hot.push({uk,sfx,pct:q.pct})}
    }
  }
  const nameOf=uk=>{const hit=(userList||[]).find(([k])=>k===uk);return hit?hit[1].name:uk};
  const nameFor=key=>{const p=(qm.pools||[]).find(x=>x.key===key);return p?p.label:key};
  hot.sort((a,b)=>b.pct-a.pct);
  const parts=['共 '+total+' 项配额'];
  if(full)parts.push('<b style="color:var(--red)">'+full+' 项已用尽</b>');
  if(warn)parts.push('<b style="color:var(--orange)">'+warn+' 项超过 80%</b>');
  if(!full&&!warn)parts.push('<span style="color:var(--green)">全部低于 80%</span>');
  const top=hot.slice(0,3).map(h=>escH(nameOf(h.uk))+' @ '+escH(nameFor(h.sfx))+' '+h.pct+'%').join('、');
  ctx.innerHTML=parts.join(' · ')+(top?' — '+top:'');
}
// One quota cell: percentage + bar, or a dash when this member has no quota on
// this profile (not authorized, or the profile is unlimited). The tooltip carries
// the exact numbers so the cell itself can stay narrow.
function quotaMatrixCell(q,userName,pool){
  const NL='&#10;';   // tooltip line break (title attribute) — must be declared
                      // before first use: it's referenced in memberNote below,
                      // and a const used before its declaration is a TDZ crash
                      // that only fires for shared pools (memberCount > 1).
  const poolLabel=pool?(pool.label||pool.name):'';
  const memberNote=pool&&pool.memberCount>1?NL+'含 '+pool.memberCount+' 个方案（'+pool.memberNames.join('、')+'）':'';
  if(!q)return '<td class="n"><span class="q-none" title="'+escH(userName)+' 在额度池 '+escH(poolLabel)+' 无配额限制或无访问权限">-</span></td>';
  const col=q.pct>=100?'var(--red)':q.pct>90?'var(--red)':q.pct>70?'var(--orange)':'var(--green)';
  const tags=(q.bonus>0?' +'+fmtTk(q.bonus):'')+(q.resetApplied?' 已重置':'');
  const rateNote=(q.rate!=null&&q.rate!==1)?NL+'倍率 ×'+q.rate+'（实际 '+fmtT(q.rawUsed||0)+'）':'';
  const title=escH(userName)+' @ '+escH(poolLabel)+NL+'已用 '+fmtT(q.used)+' / '+fmtT(q.limit)
    +'（'+q.source+'）'+NL+'剩余 '+fmtT(q.remaining)+rateNote+memberNote
    +(q.bonus>0?NL+'含今日临时加量 '+fmtT(q.bonus):'')+(q.resetApplied?NL+'今日已重置':'');
  return '<td class="n q-col"><div class="q-cell" title="'+title+'">'
    +'<span class="q-pct" style="color:'+col+'">'+q.pct+'%'+(tags?'<span style="color:var(--dim);font-weight:400;font-size:9px">'+tags+'</span>':'')+'</span>'
    +quotaBar(q.pct)+'</div></td>';
}
function detailTokens(row){return ioTokens(row)}
function detailPeriodLabel(key){if(P==="day")return key;if(P==="week")return key+" 周";if(P==="month")return key;return key+" 年"}
function detailRangeDaily(daily){if(detailRange==="all")return daily;const days=Number(detailRange)||0;const cutoff=new Date(Date.now()+8*3600000-Math.max(0,days-1)*86400000).toISOString().slice(0,10);return Object.fromEntries(Object.entries(daily).filter(([date])=>date>=cutoff))}
function detailTotals(members){const total={requests:0,inputTokens:0,outputTokens:0,cacheCreationTokens:0,cacheReadTokens:0};for(const member of members){const row=member.data;total.requests+=row.requests||0;total.inputTokens+=row.inputTokens||0;total.outputTokens+=row.outputTokens||0;total.cacheCreationTokens+=row.cacheCreationTokens||0;total.cacheReadTokens+=row.cacheReadTokens||0}return total}
function resetDetailGrouping(){detailPage=1;expandedDetailPeriods.clear();detailInitialized=false}
function updateDetailFilters(){const nextQuery=document.getElementById("detailQuery").value.trim().toLowerCase(),nextRange=document.getElementById("detailRange").value,nextSort=document.getElementById("detailSort").value;const groupingChanged=nextQuery!==detailQuery||nextRange!==detailRange;detailQuery=nextQuery;detailRange=nextRange;detailSort=nextSort;detailPage=1;if(groupingChanged){expandedDetailPeriods.clear();detailInitialized=false}renderDetail()}
function resetDetailFilters(){detailQuery="";detailRange="all";detailSort="time";document.getElementById("detailQuery").value="";document.getElementById("detailRange").value="all";document.getElementById("detailSort").value="time";resetDetailGrouping();renderDetail()}
function setDetailPage(page){detailPage=page;renderDetail()}
function setErrorPage(page){errPage=page;render();requestAnimationFrame(()=>{document.getElementById("errorSecBody").scrollTop=0})}
function toggleDetailPeriod(period){if(expandedDetailPeriods.has(period))expandedDetailPeriods.delete(period);else expandedDetailPeriods.add(period);detailInitialized=true;renderDetail()}
function renderDetail(){
  if(!D)return;
  const grouped=grp(detailRangeDaily(D.daily||{}),P);
  let periods=Object.entries(grouped).map(([key,userRows])=>{
    const members=Object.entries(userRows).map(([userKey,data])=>{const info=D.users[userKey]||{};return{key:userKey,name:info.name||userKey.slice(0,8),data}}).filter(member=>!detailQuery||member.name.toLowerCase().includes(detailQuery)||member.key.toLowerCase().includes(detailQuery));
    if(!members.length)return null;
    members.sort((a,b)=>detailTokens(b.data)-detailTokens(a.data)||b.data.requests-a.data.requests||a.name.localeCompare(b.name,"zh-CN"));
    return{key,members,total:detailTotals(members)};
  }).filter(Boolean);
  const latestKey=periods.reduce((latest,period)=>!latest||period.key>latest?period.key:latest,"");
  if(!detailInitialized&&latestKey){expandedDetailPeriods.add(latestKey);detailInitialized=true}
  periods.sort((a,b)=>detailSort==="tokens"?detailTokens(b.total)-detailTokens(a.total)||b.key.localeCompare(a.key):detailSort==="requests"?b.total.requests-a.total.requests||b.key.localeCompare(a.key):b.key.localeCompare(a.key));
  const memberCount=periods.reduce((sum,period)=>sum+period.members.length,0);
  const totalPages=Math.max(1,Math.ceil(periods.length/DETAIL_PAGE_SIZE));
  detailPage=Math.max(1,Math.min(detailPage,totalPages));
  const pagePeriods=periods.slice((detailPage-1)*DETAIL_PAGE_SIZE,detailPage*DETAIL_PAGE_SIZE);
  const rows=[];
  for(const period of pagePeriods){
    const open=expandedDetailPeriods.has(period.key),total=period.total;
    rows.push('<tr class="detail-group" data-period="'+escH(period.key)+'" tabindex="0" aria-expanded="'+open+'" onclick="toggleDetailPeriod(this.dataset.period)" onkeydown="if(event.keyCode===13||event.keyCode===32){event.preventDefault();toggleDetailPeriod(this.dataset.period)}"><td class="detail-sticky"><span class="detail-period"><span class="detail-period-toggle '+(open?'open':'')+'"></span><span>'+escH(detailPeriodLabel(period.key))+'</span><span class="detail-period-meta">'+period.members.length+' 位用户</span></span></td><td class="n">'+fmtT(total.requests)+'</td><td class="n">'+fmtT(total.inputTokens)+'</td><td class="n">'+fmtT(total.outputTokens)+'</td><td class="n">'+fmtT(total.cacheCreationTokens)+'</td><td class="n">'+fmtT(total.cacheReadTokens)+'</td><td class="n hl">'+fmtT(detailTokens(total))+'</td></tr>');
    if(open){for(const member of period.members){const data=member.data,totalTokens=detailTokens(data),share=detailTokens(total)>0?Math.round(totalTokens/detailTokens(total)*100):0;rows.push('<tr class="detail-member"><td class="detail-sticky"><span class="detail-user"><span class="detail-user-name">'+escH(member.name)+'</span><span class="detail-key">'+escH(maskDetailKey(member.key))+'</span></span></td><td class="n">'+fmtT(data.requests||0)+'</td><td class="n">'+fmtT(data.inputTokens||0)+'</td><td class="n">'+fmtT(data.outputTokens||0)+'</td><td class="n">'+fmtT(data.cacheCreationTokens||0)+'</td><td class="n">'+fmtT(data.cacheReadTokens||0)+'</td><td class="n hl">'+fmtT(totalTokens)+'<span class="detail-share">'+share+'%</span></td></tr>')}}
  }
  document.querySelector("#dTable tbody").innerHTML=rows.length?rows.join(""):'<tr><td colspan="7" class="empty">'+(detailQuery?'没有匹配的用户记录':'暂无数据')+'</td></tr>';
  document.getElementById("detailHint").textContent=periods.length+' 个周期 · '+memberCount+' 条用户记录';
  document.getElementById("workspaceCountDetail").textContent=periods.length;
  document.getElementById("detailPages").innerHTML=periods.length?'<span>第 '+detailPage+' / '+totalPages+' 页</span><button type="button" onclick="setDetailPage('+(detailPage-1)+')" '+(detailPage<=1?'disabled':'')+'>上一页</button><button type="button" onclick="setDetailPage('+(detailPage+1)+')" '+(detailPage>=totalPages?'disabled':'')+'>下一页</button>':'';
}
function switchProfileView(v){currentProfile=v||"all";resetDetailGrouping();load()}
// Protocol segmented control: switches the "all profiles" aggregation between
// Anthropic (Claude Code) and Responses (Codex) views. Selecting a specific
// profile overrides it — the segment then mirrors that profile's protocol.
function setProtoSeg(proto){document.querySelectorAll("#protoSeg button").forEach(b=>b.classList.toggle("on",b.dataset.proto===(proto||"")))}
function switchProtocolView(proto){PROTO=proto||"";if(currentProfile!=="all"){currentProfile="all";const sel=document.getElementById("profileSel");if(sel)sel.value="all"}setProtoSeg(PROTO);resetDetailGrouping();load()}
document.querySelectorAll("#protoSeg button").forEach(b=>b.addEventListener("click",()=>switchProtocolView(b.dataset.proto)));
const protoLabel=proto=>proto==="anthropic"?"Anthropic":proto==="responses"?"OpenAI":"";
function render(){
  if(!D)return;
  // Populate profile dropdown
  const sel=document.getElementById("profileSel");
  if(sel.options.length<=1 && D.profiles){
    sel.innerHTML='<option value="all">全部方案</option>';
    for(const p of D.profiles){
      const sfx="/"+p.suffix+(p.isDefault?" · 默认入口":"")+(p.protocol==="responses"?" · Codex":" · Claude Code");
      sel.innerHTML+='<option value="'+escH(p.suffix)+'">'+escH(p.name)+' '+escH(sfx)+'</option>';
    }
    sel.value=currentProfile==="all"?"all":currentProfile;
  }
  // Rebuild chart filter dropdowns on every render (30s refresh), keeping the
  // current selection; fall back to "all" if the value disappeared from the data.
  const rebuildFilterSel=(id,entries,allLabel)=>{
    const el=document.getElementById(id);
    const keep=el.value||"all";
    const avail=new Set(entries.map(e=>e[0]));
    const next=avail.has(keep)?keep:"all";
    el.innerHTML='<option value="all">'+allLabel+'</option>'+entries.map(e=>'<option value="'+escH(e[0])+'">'+escH(e[1])+'</option>').join("");
    el.value=next;
    return next;
  };
  const modelEntries=Object.entries(D.models||{}).map(([m,v])=>[m,m+" ("+fmtTk(v.requests||0)+"次)"]).sort((a,b)=>(D.models[b[0]].requests||0)-(D.models[a[0]].requests||0));
  for(const dh of Object.values(D.hourlyModels||{}))for(const hm of Object.values(dh))for(const m of Object.keys(hm))if(!D.models||!D.models[m])modelEntries.push([m,m]);
  MDL=rebuildFilterSel("modelSel",modelEntries,"全部模型");
  USR=rebuildFilterSel("userSel",Object.keys(D.users||{}).map(k=>[k,D.users[k].name]),"全部用户");
  const us=Object.values(D.users),allTokens=us.reduce((s,u)=>s+totalTokens(u),0),tr=us.reduce((s,u)=>s+u.totalRequests,0);
  const td=new Date(Date.now()+8*36e5).toISOString().slice(0,10),tdd=(D.daily||{})[td]||{};
  const todayTokens=Object.values(tdd).reduce((s,d)=>s+totalTokens(d),0),tR=Object.values(tdd).reduce((s,d)=>s+d.requests,0);
  document.getElementById("cards").innerHTML=c("今日用量",todayTokens,"var(--accent)",1)+c("今日请求",tR,"var(--blue)",1)+c("总用量",allTokens,"var(--green)",1)+c("总请求",tr,"var(--orange)",1)+c("今日错误",(Array.isArray(D.errors)?D.errors:[]).filter(e=>e.time&&bjDateStr(e.time)===td).length,"var(--red)",1);
  runCountUps(document.getElementById("cards"));
  const psb=document.getElementById("profileSummaryBody"),profiles=Array.isArray(D.profileSummaries)?D.profileSummaries:[];
  const fmtResume=function(iso){const d=new Date(new Date(iso).getTime()+8*3600000);const p=n=>String(n).padStart(2,'0');const now=new Date(Date.now()+8*3600000);const hm=p(d.getUTCHours())+':'+p(d.getUTCMinutes());if(d.getUTCFullYear()===now.getUTCFullYear()&&d.getUTCMonth()===now.getUTCMonth()&&d.getUTCDate()===now.getUTCDate())return hm;if(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())===86400000)return '明天 '+hm;return (d.getUTCFullYear()===now.getUTCFullYear()?'':d.getUTCFullYear()+'-')+p(d.getUTCMonth()+1)+'-'+p(d.getUTCDate())+' '+hm};
  const rowOf=p=>{const st=p.breakerState||"UNKNOWN";const rl=p.rateLimit;let col,led,stateLabel;if(rl){col='var(--red)';led='err';stateLabel='限额中 '+fmtResume(rl.resumeAt)+'恢复';}else{col=st==="CLOSED"?"var(--green)":st==="HALF_OPEN"?"var(--orange)":"var(--red)";led=st==="CLOSED"?"on":st==="HALF_OPEN"?"warn":"err";stateLabel=st==="CLOSED"?"正常":st==="HALF_OPEN"?"探测中":"熔断"+(p.breakerCooldownRemaining>0?' '+Math.ceil(p.breakerCooldownRemaining/1000)+'s后探测':'');}const current=currentProfile!=="all"&&p.suffix===currentProfile;const gBadge=p.inDefaultGroup?' <span style="color:var(--blue);font-size:10px;font-weight:600">默认组·'+(p.groupOrder+1)+'</span>':'';const rBadge=p.inResponsesGroup?' <span style="color:var(--blue);font-size:10px;font-weight:600">Resp组·'+(p.responsesGroupOrder+1)+'</span>':'';const protoBadge=p.protocol==='responses'?' <span style="color:var(--blue);font-size:10px">Codex</span>':'';const bLabel=p.billingType==='coding_plan'?' <span style="color:var(--dim);font-size:10px">CP</span>':p.billingType==='token_plan'?' <span style="color:var(--dim);font-size:10px">TP</span>':'';const pk=(p.peakHours&&p.peakHours.length)?(function(rs){const now=new Date(),cur=((now.getTime()+8*3600000)%86400000)/60000;const tm=function(t){if(!t)return null;const a=t.split(':');return (+a[0])*60+(+a[1])};const inPk=rs.some(function(r){const s=tm(r.start),e=tm(r.end);return s!==null&&e!==null&&s!==e&&(s<e?(cur>=s&&cur<e):(cur>=s||cur<e))});return ' <span style="color:'+(inPk?'var(--orange)':'var(--dim)')+';font-size:10px" title="高峰时段(北京时间) '+rs.map(function(r){return r.start+'-'+r.end}).join(', ')+'">'+(inPk?'高峰中':rs.map(function(r){return r.start+'-'+r.end}).join(','))+'</span>'})(p.peakHours):'';const rt2=(function(){if(p.peakQuotaRate==null&&p.offPeakQuotaRate==null)return'';const pr=p.peakQuotaRate==null?1:p.peakQuotaRate,orr=p.offPeakQuotaRate==null?1:p.offPeakQuotaRate;const nCustom=Object.keys(p.modelQuotaRates||{}).length;if(pr===1&&orr===1&&nCustom===0)return'';var now=new Date(),cur=((now.getTime()+8*3600000)%86400000)/60000;var tm=function(t){if(!t)return null;var a=t.split(':');return (+a[0])*60+(+a[1])};var ip=(p.peakHours||[]).some(function(r){var s=tm(r.start),e=tm(r.end);return s!==null&&e!==null&&s!==e&&(s<e?(cur>=s&&cur<e):(cur>=s||cur<e))});return ' <span style="color:var(--accent);font-size:10px" title="默认配额倍率：高峰 ×'+pr+' / 低谷 ×'+orr+'（当前'+(ip?'高峰':'低谷')+'）'+(nCustom?'；另有 '+nCustom+' 个模型单独定价':'')+'">×'+(ip?pr:orr)+(nCustom?'+'+nCustom:'')+'</span>'})();const restricted=(p.inDefaultGroup&&profiles.filter(x=>x.inDefaultGroup).length>=2)||(p.inResponsesGroup&&profiles.filter(x=>x.inResponsesGroup).length>=2);const entryCode=p.protocol==='responses'?'/v1/responses':'/v1';const defBadge=(p.isDefault||p.isResponsesDefault)?' <span style="color:var(--green);font-size:11px;font-weight:600;vertical-align:middle">默认</span>':'';return'<tr'+(current?' class="profile-current" aria-current="true"':'')+'><td>'+escH(p.name)+defBadge+gBadge+rBadge+protoBadge+bLabel+pk+rt2+(current?' <span class="current-mark">当前</span>':'')+'</td><td>'+(restricted?'<code>'+entryCode+'</code> <span style="color:var(--dim);font-size:10px">仅 '+entryCode+'</span>':'<code>/'+escH(p.suffix)+'</code>'+((p.isDefault||p.isResponsesDefault)?' <span style="color:var(--dim)">/ <code>'+entryCode+'</code></span>':''))+'</td><td style="font-size:12px;color:var(--dim);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escH((p.upstream||'').replace('https://','').replace('http://',''))+'</td><td class="n">'+fmtT(p.todayRequests||0)+'</td><td class="n hl">'+fmtT(p.todayTokens||0)+'</td><td><span class="led '+led+'"></span><span style="color:'+col+';font-size:12px">'+stateLabel+'</span></td></tr>'};
  const anthProfiles=profiles.filter(p=>p.protocol!=="responses"),respProfiles=profiles.filter(p=>p.protocol==="responses");
  const protoRow=(label,entry,count)=>'<tr class="proto-row"><td colspan="6">'+label+' · 入口 '+entry+' · '+count+' 个方案</td></tr>';
  let psbHtml="";
  if(anthProfiles.length)psbHtml+=protoRow("Anthropic","/v1",anthProfiles.length)+anthProfiles.map(rowOf).join("");
  if(respProfiles.length)psbHtml+=protoRow("OpenAI","/v1/responses",respProfiles.length)+respProfiles.map(rowOf).join("");
  psb.innerHTML=profiles.length?psbHtml:'<tr><td colspan="6" class="empty">暂无方案</td></tr>';
  const profileLabel=D.profileView||(currentProfile==="all"?"全部方案":"默认方案");
  const curProtoProf=(D.profiles||[]).find(p=>p.suffix===currentProfile);
  setProtoSeg(currentProfile!=="all"?((curProtoProf&&curProtoProf.protocol)||""):PROTO);
  const protoSuffix=protoLabel(currentProfile!=="all"?((curProtoProf&&curProtoProf.protocol)||""):PROTO);
  document.getElementById("profileContext").textContent="当前查看："+profileLabel+(protoSuffix?" · "+protoSuffix:"");
  const upstreamInfo=D.upstream?(" | 上游: "+D.upstream.replace("https://","").replace("http://","")):"";
  document.getElementById("meta").innerHTML='<span style="color:var(--accent);font-weight:600">方案: '+profileLabel+(protoSuffix?' · '+protoSuffix:'')+'</span>'+upstreamInfo+' &nbsp;|&nbsp; 更新于 '+(function(){const d=new Date();const utc=d.getTime()+d.getTimezoneOffset()*60000;return new Date(utc+8*3600000).toLocaleTimeString("zh-CN")})()+" (北京时间) | 每30秒刷新";

  // Charts —— 六图共用全局筛选：P 周期 / MT 指标 / MDL 模型 / USR 用户 / DS+DE 日期范围。
  // 四张非 24h 图的窗口用 effBounds()(日期范围生效时优先,否则周期窗口);两张 24h 图恒用 winBounds()。
  const wb=winBounds();
  const fd0=filteredDaily();
  const eb=effBounds();
  let fd=fd0;
  if(eb.ranged){const rf={};for(const[date,ud]of Object.entries(fd0)){if(date<eb.start||date>eb.end)continue;rf[date]=ud}fd=rf}
  const g=grp(fd,P),keys=Object.keys(g).sort(),uks=Object.keys(D.users);
  const val=s=>MT==="requests"?(s.requests||0):totalTokens(s);
  document.getElementById("trendNote").textContent=MDL!=="all"?"模型筛选：不含缓存 Token":"";
  if(C.t)C.t.destroy();if(C.p)C.p.destroy();if(C.m)C.m.destroy();if(C.h)C.h.destroy();if(C.hm)C.hm.destroy();if(C.pr)C.pr.destroy();
  C.t=new Chart(document.getElementById("trend"),{type:"bar",data:{labels:keys.map(k=>lbl(P,k)),datasets:uks.map((u,i)=>({label:D.users[u].name,data:keys.map(k=>val(g[k][u]||{})),backgroundColor:COL[i%COL.length]+"cc",borderRadius:3,borderSkipped:false}))},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:trendLegend(),tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)}}},scales:{x:{stacked:true,ticks:{color:"#686863",font:{size:10}},grid:{color:"rgba(24,24,22,.08)"}},y:{stacked:true,ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});
  // 用户分布：按有效窗口累加(默认按日=今天;日期范围生效时按范围),横向柱状图,Y 轴显示用户名完整可读。
  const tot=uks.map(u=>{let t=0;for(const[date,ud]of Object.entries(fd)){const s=ud[u];if(s)t+=val(s)}return t});
  // 用户分布：横向柱状图，Y 轴显示用户名完整可读。
  const uIdx=tot.map((_,i)=>i).sort((a,b)=>tot[b]-tot[a]);
  C.p=new Chart(document.getElementById("pie"),{type:"bar",data:{labels:uIdx.map(i=>D.users[uks[i]].name),datasets:[{label:MT==="requests"?"请求数":"总 Token",data:uIdx.map(i=>tot[i]),backgroundColor:uIdx.map((_,i)=>COL[i%COL.length]+"cc"),borderWidth:0,borderRadius:3,borderSkipped:false}]},options:{indexAxis:"y",responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>MT==="requests"?fmtT(ctx.raw)+" 次请求":fmtT(ctx.raw)+" tokens"}}},scales:{x:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}},y:{ticks:{color:"#686863",font:{size:11},autoSkip:false},grid:{display:false}}}}});

  // 模型请求分布：按有效窗口(日期范围优先,否则周期窗口,北京时间)基于 usage_daily_model
  // 保留约 400 天的按日模型数据求和，可按用户与指标筛选。横向柱状图便于读取模型名。
  const dm=D.dailyModels||{};
  const mAgg={};
  for(const [date,users] of Object.entries(dm)){
    if(date<eb.start||date>eb.end)continue;
    for(const [u,models] of Object.entries(users)){
      if(USR!=="all"&&u!==USR)continue;
      for(const [m,v] of Object.entries(models)){
        if(!mAgg[m])mAgg[m]={requests:0,tokens:0};
        mAgg[m].requests+=(v.requests||0);mAgg[m].tokens+=((v.inputTokens||0)+(v.outputTokens||0));
      }
    }
  }
  const mNames=Object.keys(mAgg);
  const mVal=mNames.map(m=>MT==="requests"?mAgg[m].requests:mAgg[m].tokens);
  const mIdx=mVal.map((_,i)=>i).sort((a,b)=>mVal[b]-mVal[a]);
  C.m=new Chart(document.getElementById("modelChart"),{type:"bar",data:{labels:mIdx.map(i=>mNames[i]),datasets:[{label:MT==="requests"?"请求数":"Token",data:mIdx.map(i=>mVal[i]),backgroundColor:mIdx.map((_,i)=>COL[i%COL.length]+"cc"),borderWidth:0,borderRadius:3,borderSkipped:false}]},options:{indexAxis:"y",responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>MT==="requests"?fmtT(ctx.raw)+" 次请求":fmtT(ctx.raw)+" tokens"}}},scales:{x:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}},y:{ticks:{color:"#686863",font:{size:11},autoSkip:false},grid:{display:false}}}}});

  // 24小时趋势图：周期窗口内逐日同小时累加（按日=当天真实曲线；周/月/年=各小时累计分布）。
  // 不受日期范围筛选影响（date input 只作用于其余四图）。
  const hrs=[];for(let i=0;i<24;i++)hrs.push(i.toString().padStart(2,"0")+":00");
  const hAgg=Array.from({length:24},()=>({requests:0,tokens:0}));
  for(const [date,hours] of Object.entries(D.hourly||{})){
    if(date<wb.wStart||date>wb.td)continue;
    for(const [h,v] of Object.entries(hours)){
      const i=Number(h);if(!(i>=0&&i<24)||typeof v!=="object")continue;
      hAgg[i].requests+=(v.requests||0);hAgg[i].tokens+=totalTokens(v);
    }
  }
  const hReq=hAgg.map(a=>a.requests),hTokens=hAgg.map(a=>a.tokens);
  C.h=new Chart(document.getElementById("hourChart"),{type:"line",data:{labels:hrs,datasets:[{label:"请求数",data:hReq,borderColor:"#2f6e50",backgroundColor:"rgba(47,110,80,.12)",fill:true,tension:.28,pointRadius:2,pointBackgroundColor:"#2f6e50",pointHoverRadius:4,borderWidth:2,yAxisID:"y"},{label:"总 Token",data:hTokens,borderColor:"#181816",backgroundColor:"rgba(24,24,22,.08)",fill:true,tension:.28,pointRadius:2,pointBackgroundColor:"#181816",pointHoverRadius:4,borderWidth:2,yAxisID:"y1"}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:{labels:{color:"#686863",font:{size:11},usePointStyle:true,pointStyle:"circle"}},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)}}},scales:{x:{ticks:{color:"#686863",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{type:"linear",position:"left",ticks:{color:"#2f6e50"},grid:{color:"rgba(24,24,22,.08)"},title:{display:true,text:"请求数",color:"#2f6e50",font:{size:10}}},y1:{type:"linear",position:"right",ticks:{color:"#181816",callback:v=>fmtTk(v)},grid:{drawOnChartArea:false},title:{display:true,text:"Tokens",color:"#181816",font:{size:10}}}}}});

  // 24小时模型使用趋势：窗口内同小时累加，按模型分 series 的折线，Y 轴跟随指标筛选。
  // 模型取窗口总量 Top6，其余合并为「其他」，避免 legend 过长。数据自 usage_hourly_model 表启用日起累积。
  const hmAgg=Array.from({length:24},()=>({}));
  for(const [date,hours] of Object.entries(D.hourlyModels||{})){
    if(date<wb.wStart||date>wb.td)continue;
    for(const [h,models] of Object.entries(hours)){
      const i=Number(h);if(!(i>=0&&i<24)||typeof models!=="object")continue;
      for(const [m,v] of Object.entries(models)){
        if(!hmAgg[i][m])hmAgg[i][m]={requests:0,tokens:0};
        hmAgg[i][m].requests+=(v.requests||0);hmAgg[i][m].tokens+=((v.inputTokens||0)+(v.outputTokens||0));
      }
    }
  }
  const hmTot={};for(const hourAgg of hmAgg)for(const [m,v] of Object.entries(hourAgg))hmTot[m]=(hmTot[m]||0)+(MT==="requests"?v.requests:v.tokens);
  const topModels=Object.keys(hmTot).sort((a,b)=>hmTot[b]-hmTot[a]).slice(0,6);
  const hasOther=Object.keys(hmTot).length>topModels.length;
  const hmSeries=topModels.map(m=>({label:m,data:hmAgg.map(a=>MT==="requests"?((a[m]||{}).requests||0):((a[m]||{}).tokens||0))}));
  if(hasOther)hmSeries.push({label:"其他",data:hmAgg.map(a=>{let t=0;for(const [m,v] of Object.entries(a))if(!topModels.includes(m))t+=MT==="requests"?v.requests:v.tokens;return t})});
  C.hm=new Chart(document.getElementById("hourModelChart"),{type:"line",data:{labels:hrs,datasets:hmSeries.map((s,i)=>({label:s.label,data:s.data,borderColor:COL[i%COL.length],backgroundColor:COL[i%COL.length]+"22",fill:i===0,tension:.28,pointRadius:2,pointBackgroundColor:COL[i%COL.length],pointHoverRadius:4,borderWidth:2}))},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:trendLegend(),tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)+(MT==="requests"?" 次请求":" tokens")}}},scales:{x:{ticks:{color:"#686863",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});

  // 方案请求情况：跨方案维度（恒为全部方案，不随方案下拉收窄），按周期分桶的堆叠柱。
  // 统计逻辑与 Token 用量趋势一致:默认全史按周期分桶,日期范围生效时才收窄窗口。
  // 模型筛选生效时切换到 profileDailyModels 数据源（不含缓存 Token）。
  document.getElementById("profileNote").textContent=MDL!=="all"?"模型筛选：不含缓存 Token":"";
  const pdBase=MDL==="all"?(D.profileDaily||{}):(D.profileDailyModels||{});
  const suffixName={};for(const p of (Array.isArray(D.profiles)?D.profiles:[]))suffixName[p.suffix]=p.name;
  const pBuckets={};
  for(const [sfx,days] of Object.entries(pdBase)){
    for(const [date,entry] of Object.entries(days)){
      if(eb.ranged&&(date<eb.start||date>eb.end))continue;
      const k=P==="week"?wk(date):P==="month"?date.slice(0,7):P==="year"?date.slice(0,4):date;
      if(!pBuckets[k])pBuckets[k]={};
      if(!pBuckets[k][sfx])pBuckets[k][sfx]={requests:0,tokens:0};
      if(MDL==="all"){
        pBuckets[k][sfx].requests+=(entry.requests||0);pBuckets[k][sfx].tokens+=totalTokens(entry);
      }else{
        const v=entry[MDL]||{};
        pBuckets[k][sfx].requests+=(v.requests||0);pBuckets[k][sfx].tokens+=((v.inputTokens||0)+(v.outputTokens||0));
      }
    }
  }
  const pSorted=Object.keys(pBuckets).sort();
  const pSfx=Object.keys(pdBase).sort();
  C.pr=new Chart(document.getElementById("profileChart"),{type:"bar",data:{labels:pSorted.map(k=>lbl(P,k)),datasets:pSfx.map((sfx,i)=>({label:suffixName[sfx]||sfx,data:pSorted.map(k=>{const s=(pBuckets[k]||{})[sfx];return s?(MT==="requests"?s.requests:s.tokens):0}),backgroundColor:COL[i%COL.length]+"cc",borderRadius:3,borderSkipped:false}))},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:trendLegend(),tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)+(MT==="requests"?" 次请求":" tokens")}}},scales:{x:{stacked:true,ticks:{color:"#686863",font:{size:10}},grid:{color:"rgba(24,24,22,.08)"}},y:{stacked:true,ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});

  // User table. In the all-profiles view the single 配额 column cannot say
  // anything useful (a user has one quota PER profile), so it is replaced by one
  // column per quota-bearing profile — the profile name is written once in the
  // header instead of repeated under every user, which keeps N profiles readable.
  const ut=document.querySelector("#uTable tbody");
  const ul=Object.entries(D.users).sort((a,b)=>totalTokens(b[1])-totalTokens(a[1]));
  const qm=D.userQuotaMatrix||null;
  const qPools=qm&&Array.isArray(qm.pools)?qm.pools:[];
  const multiQuota=!!qm&&qPools.length>0;
  renderUserTableHead(multiQuota?qPools:null);
  renderUserQuotaContext(multiQuota?qm:null,ul);
  applyQuotaFocus();
  const colSpan=multiQuota?10+qPools.length:11;
  if(!ul.length){ut.innerHTML='<tr><td colspan="'+colSpan+'" class="empty">暂无数据</td></tr>'}else{ut.innerHTML=ul.map(([uk,u],idx)=>{const on=u.lastActive&&Date.now()-new Date(u.lastActive).getTime()<36e5;const effQ=(D.userQuotaEff||{})[uk];const uq=effQ?effQ.limit:((D.userQuotas||{})[uk]||D.profileQuota||0);const td2=(D.daily||{})[td]||{};const tdu=td2[uk]||{};const used=effQ?effQ.used:ioTokens(tdu);const qPct=uq>0?Math.min(100,Math.round(used/uq*100)):0;const rank='<span class="rank">'+(idx+1)+'.</span>';const qTag=effQ&&effQ.bonus>0?' <span style="font-size:10px;color:var(--green);border:1px solid var(--green);border-radius:3px;padding:0 3px;white-space:nowrap" title="今日临时加量，明日自动失效">+'+fmtTk(effQ.bonus)+'</span>':(effQ&&effQ.resetApplied?' <span style="font-size:10px;color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:0 3px;white-space:nowrap" title="今日用量已重置（统计保留）">已重置</span>':'');const rTag=(effQ&&effQ.rate!=null&&effQ.rate!==1)?' <span style="font-size:10px;color:var(--dim);border:1px solid var(--border);border-radius:3px;padding:0 3px;white-space:nowrap" title="配额倍率 ×'+effQ.rate+'（当前时段）· 实际 '+fmtT(effQ.rawUsed||0)+'，计入配额 '+fmtT(effQ.used||0)+'">×'+effQ.rate+'</span>':'';const qCell=uq>0?'<span style="color:var(--accent);font-size:12px">'+qPct+'%</span> '+quotaBar(qPct)+qTag+rTag:'<span style="color:var(--dim)">-</span>';const quotaCells=multiQuota?qPools.map(p=>quotaMatrixCell(((qm.matrix||{})[uk]||{})[p.key],u.name,p)).join(""):'<td class="n" style="white-space:nowrap">'+qCell+'</td>';return'<tr><td>'+rank+escH(u.name)+'</td><td><span class="led '+(on?'on':'')+'"></span><span style="color:'+(on?'var(--green)':'var(--dim)')+';font-size:12px">'+(on?'在线':'离线')+'</span></td><td class="n stat-col">'+fmtT(u.totalRequests)+'</td><td class="n stat-col">'+fmtT(u.totalInputTokens)+'</td><td class="n stat-col">'+fmtT(u.totalOutputTokens)+'</td><td class="n stat-col">'+fmtT(u.cacheCreationTokens || 0)+'</td><td class="n stat-col">'+fmtT(u.cacheReadTokens || 0)+'</td><td class="n hl stat-col">'+fmtT(ioTokens(u))+'</td><td class="n">'+fmtT(ioTokens(tdu))+'</td>'+quotaCells+'<td style="font-size:12px;color:var(--dim)">'+ago(u.lastActive)+'</td></tr>'}).join("")}

  renderDetail();

  // Error table with pagination
  const allErrs=Array.isArray(D.errors)?D.errors:[];
  const totalErrPages=Math.max(1,Math.ceil(allErrs.length/ERR_PAGE_SIZE));
  if(errPage>totalErrPages)errPage=totalErrPages;
  const errs=allErrs.slice((errPage-1)*ERR_PAGE_SIZE,errPage*ERR_PAGE_SIZE);
  const et=document.querySelector("#eTable tbody");
  if(!errs.length){et.innerHTML='<tr><td colspan="6" class="empty">暂无错误记录</td></tr>'}else{et.innerHTML=errs.map(e=>{const sc=e.statusCode||"-";const col=sc>=500?"var(--red)":sc>=400?"var(--orange)":"var(--dim)";return'<tr><td style="font-size:12px;white-space:nowrap">'+(e.time?fmtBJ(e.time):"-")+'</td><td>'+(e.user||"-")+'</td><td class="n" style="color:'+col+';font-weight:600">'+sc+'</td><td style="font-size:12px;color:var(--blue)">'+(e.model||"-")+'</td><td style="font-size:12px;color:var(--dim);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+(e.path||"-")+'</td><td style="font-size:12px;color:var(--red);max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+(e.error||"").replace(/"/g,'&quot;')+'">'+(e.error||"-")+'</td></tr>'}).join("")}
  const pg=document.getElementById("errPages");
  pg.innerHTML='<span style="font-size:12px;color:var(--dim)">第 '+errPage+"/"+totalErrPages+' 页 (共 '+allErrs.length+' 条)</span> '+(errPage>1?'<button onclick="setErrorPage('+(errPage-1)+')" style="font-size:11px;background:var(--card);color:var(--text);border:1px solid var(--border);padding:2px 10px;border-radius:4px;cursor:pointer">上一页</button> ':'')+(errPage<totalErrPages?'<button onclick="setErrorPage('+(errPage+1)+')" style="font-size:11px;background:var(--card);color:var(--text);border:1px solid var(--border);padding:2px 10px;border-radius:4px;cursor:pointer">下一页</button>':'');
  document.getElementById("errorCount").textContent=allErrs.length>0?'('+allErrs.length+')':'';
  document.getElementById("errorHint").textContent=allErrs.length>0?(allErrs.length+'条错误'):'暂无错误';
  renderWorkspaceSummaries();
  renderRateBoard();
}
async function load(){try{const profile=currentProfile==="all"?"all":currentProfile;const qs=[];if(profile!=="all")qs.push("profile="+encodeURIComponent(profile));else if(PROTO)qs.push("protocol="+PROTO);const r=await fetch("/api/stats"+(qs.length?"?"+qs.join("&"):""));D=await r.json();render()}catch(e){document.getElementById("meta").textContent="Error: "+e.message}}
function toggleSec(id){const body=document.getElementById(id+"Body");const icon=document.getElementById(id+"Icon");const open=body.classList.toggle("open");icon.classList.toggle("open",open)}
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.remove("on"));b.classList.add("on");P=b.dataset.p;resetDetailGrouping();render()}));
document.getElementById("metricSel").addEventListener("change",e=>{MT=e.target.value;render()});
document.getElementById("modelSel").addEventListener("change",e=>{MDL=e.target.value;resetDetailGrouping();render()});
document.getElementById("userSel").addEventListener("change",e=>{USR=e.target.value;render()});
function resetChartFilters(){P="day";MT="tokens";MDL="all";USR="all";DS="";DE="";PROTO="";setProtoSeg("");document.querySelectorAll("#globalTabs .tab").forEach(x=>x.classList.toggle("on",x.dataset.p==="day"));document.getElementById("metricSel").value="tokens";document.getElementById("modelSel").value="all";document.getElementById("userSel").value="all";document.getElementById("dateStart").value="";document.getElementById("dateEnd").value="";if(currentProfile!=="all"){currentProfile="all";document.getElementById("profileSel").value="all"}resetDetailGrouping();load()}
document.querySelectorAll(".workspace-tab").forEach(button=>{button.addEventListener("click",()=>setWorkspaceTab(button.id.replace("workspace-tab-","")));button.addEventListener("keydown",handleWorkspaceTabKeydown)});
document.getElementById("clearErrors").addEventListener("click",async()=>{if(confirm("确定清除所有错误记录？")){const csrf=(document.cookie.match(/tm_csrf=([^;]+)/)||[])[1]||'';await fetch("/api/clear-errors",{method:"POST",headers:{"x-csrf-token":csrf}});toast('错误记录已清除');errPage=1;load()}});
// ── 产出质量 tab(懒加载:首次切到该 tab 才拉数据)──
const ph=escH;
let prodData=null,prodLoaded=false,prodDetailChart=null;
async function loadProduction(){
  const range=document.getElementById('prodRangeSel').value;
  document.getElementById('prodReportLink').href='/api/production/report?range='+range;
  try{
    const [s,p,a]=await Promise.all([
      fetch('/api/production/summary?range='+range).then(r=>r.json()),
      fetch('/api/production/projects?range='+range).then(r=>r.json()),
      fetch('/api/production/alerts?range='+range).then(r=>r.json()),
    ]);
    prodData=s;
    document.getElementById('workspaceCountProd').textContent=s.rows.length;
    document.getElementById('prodSummary').textContent='净产出 '+s.rows.reduce((x,r)=>x+r.net_lines,0).toLocaleString('zh-CN')+' 行 · '+s.rows.length+' 人有产出';
    const tb=document.querySelector('#prodTable tbody');
    // 阈值着色(参考区间,与成员个人页同口径):失败率 <10 绿/≥30 橙;重写率 <30 绿/≥80 橙;验证密度 =0 橙/0.1-0.8 绿;token/行与净产出不参与着色。
    tb.innerHTML=s.rows.map(r=>{
      const fr=r.fail_rate*100,rr=r.rewrite_rate*100,vd=r.verify_density;
      const failC=fr>=30?' style="color:var(--orange)"':(fr<10?' style="color:var(--green)"':'');
      const rwC=rr>=80?' style="color:var(--orange)"':(rr<30?' style="color:var(--green)"':'');
      const vdC=vd===0?' style="color:var(--orange)"':((vd>=0.1&&vd<=0.8)?' style="color:var(--green)"':'');
      return '<tr data-key="'+ph(r.user_key)+'" style="cursor:pointer">'
      +'<td>'+ph(r.user_name)+'</td><td class="n">'+fmtT(r.net_lines)+'</td><td class="n">'+(r.files||0)+'</td>'
      +'<td class="n"'+failC+'>'+fr.toFixed(0)+'%</td><td class="n"'+rwC+'>'+rr.toFixed(0)+'%</td>'
      +'<td class="n"'+vdC+'>'+vd.toFixed(1)+'</td><td class="n">'+(r.token_per_line==null?'—':fmtT(Math.round(r.token_per_line)))+'</td>'
      +'<td class="n">'+((s.alertCounts&&s.alertCounts[r.user_key]>0)?'<span class="pill-warn">'+s.alertCounts[r.user_key]+'</span>':'')+'</td></tr>';
    }).join('')
      ||'<tr><td colspan="8" class="empty">该周期无产出数据</td></tr>';
    tb.querySelectorAll('tr[data-key]').forEach(tr=>tr.addEventListener('click',()=>loadProdDetail(tr.dataset.key,range)));
    document.getElementById('prodZero').innerHTML=s.zeroOutput.length
      ?'<span style="font-size:11px;color:var(--orange)">有用量但零文件产出:</span> '+s.zeroOutput.map(u=>'<span class="chip chip-warn">'+ph(u.user_name)+'</span>').join(''):'';
    const projRows=(p.rows||[]),projMax=Math.max(1,...projRows.map(r=>(r.lines_add||0)-(r.lines_del||0)));
    document.querySelector('#projTable tbody').innerHTML=projRows.map(r=>
      '<tr><td><div>'+ph(r.project)+'</div><span class="prod-bar" style="width:'+Math.max(2,Math.round(((r.lines_add||0)-(r.lines_del||0))/projMax*100))+'%" title="净产出占比 '+Math.round(((r.lines_add||0)-(r.lines_del||0))/projMax*100)+'%"></span></td><td class="n">'+r.users+'</td><td class="n">'+r.files+'</td><td class="n">'+fmtT((r.lines_add||0)-(r.lines_del||0))+'</td></tr>').join('')
      ||'<tr><td colspan="4" class="empty">该周期无数据</td></tr>';
    document.querySelector('#prodAlertTable tbody').innerHTML=(a.rows||[]).map(r=>
      '<tr'+(r.seen?' style="color:var(--dim)"':'')+'><td>'+ph(bjClock(r.time))+'</td><td>'+ph(r.user_name)+'</td><td>'+ph(r.kindLabel||r.kind)+'</td><td style="white-space:normal">'+ph(r.detailText||r.detail)+'</td></tr>').join('')
      ||'<tr><td colspan="4" class="empty">无告警</td></tr>';
  }catch(e){document.getElementById('prodSummary').textContent='加载失败: '+e.message}
}
async function loadProdDetail(key,range){
  const d=await fetch('/api/production/user/'+encodeURIComponent(key)+'?range='+range).then(r=>r.json());
  const el=document.getElementById('prodDetail');
  el.style.display='block';
  const fileRows=d.files.map(f=>{const segs=String(f.file_path||'').split('/').filter(Boolean);const short=segs.slice(-2).join('/')||String(f.file_path||'-');return '<tr><td style="max-width:340px;overflow:hidden;text-overflow:ellipsis" title="'+ph(f.file_path)+'">'+ph(short)+'</td><td class="n">+'+fmtT(f.la||0)+'</td><td class="n">-'+fmtT(f.ld||0)+'</td></tr>'}).join('')
    ||'<tr><td colspan="3" class="empty">无文件记录</td></tr>';
  const langChips=d.languages.map(l=>'<span class="chip">'+ph(l.ext||'其他')+'</span>').join('')
    ||'<span style="font-size:11px;color:var(--dim)">无</span>';
  el.innerHTML='<div style="font-weight:650;margin-bottom:4px">成员明细</div>'
    +'<div style="height:120px;margin-bottom:10px"><canvas id="prodDetailTrend"></canvas></div>'
    +'<div style="font-size:11px;color:var(--dim);font-weight:600;margin-bottom:2px">文件 Top</div>'
    +'<table style="min-width:0"><thead><tr><th>文件</th><th class="n">新增</th><th class="n">删除</th></tr></thead><tbody>'+fileRows+'</tbody></table>'
    +'<div style="font-size:11px;color:var(--dim);font-weight:600;margin:8px 0 3px">语言</div><div>'+langChips+'</div>';
  if(prodDetailChart)prodDetailChart.destroy();
  prodDetailChart=new Chart(document.getElementById('prodDetailTrend'),{type:'line',
    data:{labels:d.days.map(x=>x.date.slice(5)),datasets:[{label:'日净产出',data:d.days.map(x=>(x.la||0)-(x.ld||0)),
      borderColor:'#2f6e50',backgroundColor:'rgba(47,110,80,.12)',fill:true,tension:.28,pointRadius:2,pointBackgroundColor:'#2f6e50',pointHoverRadius:4,borderWidth:2}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+': '+fmtT(ctx.raw)}}},
      scales:{x:{ticks:{color:'#686863',font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},
        y:{ticks:{color:'#686863',callback:v=>fmtTk(v)},grid:{color:'rgba(24,24,22,.08)'}}}}});
}
async function markProdAlerts(){
  const csrf=(document.cookie.match(/tm_csrf=([^;]+)/)||[])[1]||'';
  await fetch('/api/production/alerts/seen',{method:'POST',headers:{'Content-Type':'application/json','x-csrf-token':csrf},body:JSON.stringify({id:0})});
  loadProduction();
}
document.getElementById('workspace-tab-production').addEventListener('click',()=>{if(!prodLoaded){prodLoaded=true;loadProduction()}});
// 指标口径速览:点击「指标口径」展开/收起一行小字
document.getElementById('prodMetricHelp').addEventListener('click',()=>{const b=document.getElementById('prodMetricHelpBody');b.style.display=(b.style.display==='none'?'':'none')});
// ── 等值成本 tab(懒加载:首次切到该 tab 才拉数据)──
let costsLoaded=false;
async function loadCosts(){
  const range=document.getElementById('costRangeSel').value;
  try{
    const c=await fetch('/api/production/costs?range='+range).then(r=>r.json());
    document.getElementById('costSummary').textContent='合计 $'+c.rows.reduce((x,r)=>x+r.total_cost,0).toFixed(2);
    document.querySelector('#costTable tbody').innerHTML=c.rows.map(r=>
      '<tr><td>'+ph(r.user_name)+'</td><td>'+ph(r.profile)+'</td><td class="n">$'+r.model_cost.toFixed(2)+'</td><td class="n">$'+r.cache_cost.toFixed(2)+'</td><td class="n hl">$'+r.total_cost.toFixed(2)+'</td></tr>').join('')
      ||'<tr><td colspan="5" class="empty">该周期无用量</td></tr>';
    const pk=c.peak||{},badge=document.getElementById('costPeakBadge');
    badge.className='';badge.textContent='';
    // 峰时段按方案展示:任一配置了峰时段的方案正处于高峰 → 高亮;否则显示低谷
    const pps=pk.profiles||[];
    if(pps.length){
      const inPeak=pps.filter(p=>p.inPeakNow);
      if(inPeak.length){badge.className='pill-warn';badge.textContent='高峰生效中: '+inPeak.map(p=>ph(p.name)).join('、');}
      else{badge.className='pill-ok';badge.textContent='低谷时段';}
    }
    document.getElementById('unpricedNote').innerHTML=c.unpriced.length?'未配置价格:'+c.unpriced.map(u=>'<span class="chip chip-warn">'+ph(u)+'</span>').join('')+'(在设置页补充)':'';
  }catch(e){document.getElementById('costSummary').textContent='加载失败: '+e.message}
}
document.getElementById('workspace-tab-costs').addEventListener('click',()=>{if(!costsLoaded){costsLoaded=true;loadCosts()}});
function startAutoRefresh(){if(refreshTimer)clearInterval(refreshTimer);refreshTimer=setInterval(()=>{if(autoRefresh)load()},30000)}
document.getElementById("autoRefreshBtn").addEventListener("click",()=>{autoRefresh=!autoRefresh;const btn=document.getElementById("autoRefreshBtn");btn.textContent="自动刷新: "+(autoRefresh?"开":"关");btn.className=autoRefresh?"ar-on":"ar-off"});
window.addEventListener("resize",scheduleChartResize);
load();startAutoRefresh();
