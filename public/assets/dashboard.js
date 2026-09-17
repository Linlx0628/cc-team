Chart.defaults.color='#686863';Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei","Segoe UI",sans-serif';Chart.defaults.font.size=11;
// public/assets/dashboard.js —— 管理仪表盘页（dashboardHtml，/dashboard）的客户端逻辑。
// 页面内联引导脚本先注入 toast() 及 UI_HELPERS 提供的辅助函数再加载本文件；
// 全部数据经 /api/* 运行时拉取，文件不含任何密钥，可长期强缓存（?v= 内容版本号）。
let D=null,P="day",C={t:null,p:null,m:null,h:null,hm:null,pr:null},errPage=1,autoRefresh=true,refreshTimer=null,currentProfile="all",PROTO="";
let MDL="all",USR="all",MT="tokens",PIEDIM="user",MDLDIM="model";
let DS="",DE="";
let activeWorkspaceTab="users";
let quotaFocus=(function(){try{return localStorage.getItem('tm_quota_focus')==='1'}catch(e){return false}})();
const ERR_PAGE_SIZE=20;
const DETAIL_PAGE_SIZE=10;
let detailPage=1,detailQuery="",detailRange="all",detailSort="time",detailInitialized=false;
const expandedDetailPeriods=new Set();
// 明细记录下钻:点击用户行展开该时段的 24 小时(半小时粒度)请求分布。数据走
// /api/user-hours 懒加载 —— 点击时才请求,绝不随 /api/stats 预取(每用户×每日期的
// 小时明细塞进大载荷会白白拖慢首屏)。expandedUserHours 键 = period+""+掩码key;
// hoursCache 按 key 缓存接口载荷;hoursCharts 持有展开行内的 Chart 实例(renderDetail
// 全量重画 tbody,重画前必须逐一 destroy)。
const expandedUserHours=new Set(),hoursCache=new Map(),hoursCharts=new Map(),hoursLoading=new Set();
let hoursChartSeq=0;
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
// ── 客户端用量 board ────────────────────────────────────────────────────────
// 按 客户端 × 用户 展开,组内按合计降序,组间也按合计降序。数据来自 /api/stats 的
// dailyClients(与 dailyModels 同形),随 render() 一起刷新 —— 不走懒加载,所以 tab 上的
// 计数在这里自己写,不能放进 renderWorkspaceSummaries()(那个函数每 30 秒跑一次,
// 对懒加载 tab 会把数字擦掉;这张表虽然不受影响,但归属写在一处更好维护)。
// 客户端与协议正交,所以这里不套用 protoSeg;但窗口与 USR/MDL 筛选沿用全局那套。
function renderClientBoard(){
  const body=document.getElementById("clientBoardBody");
  if(!D||!body)return;
  const eb=effBounds();
  // 与用户分布图同一条规则:窗口用 effBounds()(日期范围优先,否则周期窗口)。
  const agg={};
  for(const[date,users]of Object.entries(D.dailyClients||{})){
    if(date<eb.start||date>eb.end)continue;
    for(const[u,clients]of Object.entries(users)){
      if(USR!=="all"&&u!==USR)continue;
      for(const[c,v]of Object.entries(clients)){
        if(!agg[c])agg[c]={requests:0,input:0,output:0,users:{}};
        const g=agg[c];
        g.requests+=(v.requests||0);g.input+=(v.inputTokens||0);g.output+=(v.outputTokens||0);
        if(!g.users[u])g.users[u]={requests:0,input:0,output:0};
        g.users[u].requests+=(v.requests||0);g.users[u].input+=(v.inputTokens||0);g.users[u].output+=(v.outputTokens||0);
      }
    }
  }
  const total=Object.values(agg).reduce((a,g)=>a+g.input+g.output,0);
  const order=Object.keys(agg).sort((a,b)=>(agg[b].input+agg[b].output)-(agg[a].input+agg[a].output));
  const userName=k=>{const u=(D.users||{})[k];return(u&&u.name)||k};
  if(!order.length){
    body.innerHTML='<tr><td colspan="7" class="empty">'+(MDL!=="all"?"客户端维度不含模型信息，请先清除模型筛选":"暂无数据")+'</td></tr>';
  }else{
    const rows=[];
    for(const c of order){
      const g=agg[c],gTotal=g.input+g.output,unknown=c==="unknown";
      rows.push('<tr class="client-group"><td><strong'+(unknown?' style="color:var(--dim)"':'')+'>'+escH(clientLabel(c))+'</strong></td>'
        +'<td style="color:var(--dim)">'+Object.keys(g.users).length+' 位用户</td>'
        +'<td class="n">'+fmtT(g.requests)+'</td>'
        +'<td class="n">'+fmtT(g.input)+'</td>'
        +'<td class="n">'+fmtT(g.output)+'</td>'
        +'<td class="n hl">'+fmtT(gTotal)+'</td>'
        +'<td class="n">'+(total>0?(gTotal/total*100).toFixed(1):"0.0")+'%</td></tr>');
      // 组内按用户合计降序。用户身份用掩码后的 key(与 D.users 同源),名字取 D.users 的 name。
      const members=Object.entries(g.users).sort((a,b)=>(b[1].input+b[1].output)-(a[1].input+a[1].output));
      for(const[k,v]of members){
        const vt=v.input+v.output;
        rows.push('<tr><td style="padding-left:22px;color:var(--dim)">'+escH(userName(k))+'</td><td></td>'
          +'<td class="n">'+fmtT(v.requests)+'</td><td class="n">'+fmtT(v.input)+'</td><td class="n">'+fmtT(v.output)+'</td>'
          +'<td class="n">'+fmtT(vt)+'</td><td class="n">'+(total>0?(vt/total*100).toFixed(1):"0.0")+'%</td></tr>');
      }
    }
    body.innerHTML=rows.join("");
  }
  document.getElementById("workspaceCountClients").textContent=order.length;
  document.getElementById("clientContext").textContent=order.length
    ?(order.length+' 个客户端 · 合计 '+fmtT(total)+' Token')
    :"暂无数据";
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
function resetDetailGrouping(){detailPage=1;expandedDetailPeriods.clear();for(const c of hoursCharts.values())c.destroy();hoursCharts.clear();expandedUserHours.clear();hoursCache.clear();hoursLoading.clear();detailInitialized=false}
function updateDetailFilters(){const nextQuery=document.getElementById("detailQuery").value.trim().toLowerCase(),nextRange=document.getElementById("detailRange").value,nextSort=document.getElementById("detailSort").value;const groupingChanged=nextQuery!==detailQuery||nextRange!==detailRange;detailQuery=nextQuery;detailRange=nextRange;detailSort=nextSort;detailPage=1;if(groupingChanged){expandedDetailPeriods.clear();detailInitialized=false}renderDetail()}
function resetDetailFilters(){detailQuery="";detailRange="all";detailSort="time";document.getElementById("detailQuery").value="";document.getElementById("detailRange").value="all";document.getElementById("detailSort").value="time";resetDetailGrouping();renderDetail()}
function setDetailPage(page){detailPage=page;renderDetail()}
function setErrorPage(page){errPage=page;render();requestAnimationFrame(()=>{document.getElementById("errorSecBody").scrollTop=0})}
function toggleDetailPeriod(period){if(expandedDetailPeriods.has(period))expandedDetailPeriods.delete(period);else expandedDetailPeriods.add(period);detailInitialized=true;renderDetail()}
// 周期 key → 该周期覆盖的日期区间(北京时间,闭区间)。周 key 是周一,月 key 是 "YYYY-MM"。
// 月末直接取 "-31":BETWEEN 是字符串比较,"2026-09-31" 能正确兜住整个九月且不越界。
function detailPeriodRange(key){if(P==="week"){const t=new Date(key+"T00:00:00Z");t.setUTCDate(t.getUTCDate()+6);return{start:key,end:t.toISOString().slice(0,10)}}if(P==="month")return{start:key+"-01",end:key+"-31"};if(P==="year")return{start:key+"-01-01",end:key+"-12-31"};return{start:key,end:key}}
function toggleUserHours(periodKey,userKey){
  const id=periodKey+""+userKey;
  if(expandedUserHours.has(id)){expandedUserHours.delete(id);const c=hoursCharts.get(id);if(c){c.destroy();hoursCharts.delete(id)}}
  else expandedUserHours.add(id);
  renderDetail();
}
function loadUserHours(periodKey,userKey){
  const id=periodKey+""+userKey;
  if(hoursLoading.has(id))return;
  hoursLoading.add(id);
  const {start,end}=detailPeriodRange(periodKey);
  const qs=new URLSearchParams({user:userKey,start,end});
  if(currentProfile!=="all")qs.set("profile",currentProfile);else if(PROTO)qs.set("protocol",PROTO);
  fetch("/api/user-hours?"+qs).then(r=>r.json()).then(payload=>{hoursCache.set(id,payload||{start,end,hours:{}})}).catch(()=>{hoursCache.set(id,{start,end,hours:{},error:true})}).finally(()=>{hoursLoading.delete(id);if(expandedUserHours.has(id))renderDetail()});
}
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
  const rows=[];const hoursChartPending=[];
  for(const period of pagePeriods){
    const open=expandedDetailPeriods.has(period.key),total=period.total;
    rows.push('<tr class="detail-group" data-period="'+escH(period.key)+'" tabindex="0" aria-expanded="'+open+'" onclick="toggleDetailPeriod(this.dataset.period)" onkeydown="if(event.keyCode===13||event.keyCode===32){event.preventDefault();toggleDetailPeriod(this.dataset.period)}"><td class="detail-sticky"><span class="detail-period"><span class="detail-period-toggle '+(open?'open':'')+'"></span><span>'+escH(detailPeriodLabel(period.key))+'</span><span class="detail-period-meta">'+period.members.length+' 位用户</span></span></td><td class="n">'+fmtT(total.requests)+'</td><td class="n">'+fmtT(total.inputTokens)+'</td><td class="n">'+fmtT(total.outputTokens)+'</td><td class="n">'+fmtT(total.cacheCreationTokens)+'</td><td class="n">'+fmtT(total.cacheReadTokens)+'</td><td class="n hl">'+fmtT(detailTokens(total))+'</td></tr>');
    if(open){for(const member of period.members){
      const data=member.data,totalTokens=detailTokens(data),share=detailTokens(total)>0?Math.round(totalTokens/detailTokens(total)*100):0;
      const hoursId=period.key+""+member.key;
      rows.push('<tr class="detail-member"><td class="detail-sticky"><span class="detail-user detail-user-click" title="点击查看该时段 24 小时请求分布" onclick="toggleUserHours(\''+escH(period.key)+'\',\''+escH(member.key)+'\')"><span class="detail-user-name">'+escH(member.name)+'</span><span class="detail-key">'+escH(maskDetailKey(member.key))+'</span></span></td><td class="n">'+fmtT(data.requests||0)+'</td><td class="n">'+fmtT(data.inputTokens||0)+'</td><td class="n">'+fmtT(data.outputTokens||0)+'</td><td class="n">'+fmtT(data.cacheCreationTokens||0)+'</td><td class="n">'+fmtT(data.cacheReadTokens||0)+'</td><td class="n hl">'+fmtT(totalTokens)+'<span class="detail-share">'+share+'%</span></td></tr>');
      // 下钻行:点击用户名才拉取(懒加载)。缓存命中直接画;否则占位 + 异步请求,回来重画。
      if(expandedUserHours.has(hoursId)){
        const payload=hoursCache.get(hoursId);
        if(!payload){
          rows.push('<tr class="detail-hours-row"><td colspan="7"><div class="detail-hours-note">24 小时分布加载中…</div></td></tr>');
          if(!hoursLoading.has(hoursId))setTimeout(()=>loadUserHours(period.key,member.key),0);
        }else{
          const agg=Array(48).fill(0),aggTk=Array(48).fill(0);
          // 注意:此处处于成员循环内,局部 const totalTokens 遮蔽了 ui.js 的全局 totalTokens(),
          // 所以 token 合计必须内联求和,不能调用 totalTokens(v)。
          for(const[i,v,w] of halfHourSlots(payload.hours||{})){agg[i]+=(v.requests||0)*w;aggTk[i]+=(((v.inputTokens||0)+(v.outputTokens||0)+(v.cacheCreationTokens||0)+(v.cacheReadTokens||0)))*w}
          if(!agg.some(x=>x>0)){
            const outOfRetention=payload.retentionStart&&detailPeriodRange(period.key).end<payload.retentionStart;
            rows.push('<tr class="detail-hours-row"><td colspan="7"><div class="detail-hours-note">'+(outOfRetention?'该时段超出小时明细保留期（小时数据仅保留近 7 天）':'该时段暂无小时明细')+'</div></td></tr>');
          }else{
            const idx=hoursChartSeq++;
            rows.push('<tr class="detail-hours-row"><td colspan="7"><div class="detail-hours"><div class="detail-hours-title">'+escH(member.name)+' · '+escH(detailPeriodLabel(period.key))+' 24 小时请求分布（半小时粒度 · 柱=请求数，线=总 Token · 点击用户名收起）</div><div class="detail-hours-canvas"><canvas id="hoursCanvas-'+idx+'"></canvas></div></div></td></tr>');
            hoursChartPending.push({id:hoursId,idx,agg,aggTk});
          }
        }
      }
    }}
  }
  // tbody 即将被整体替换:旧展开行的 Chart 实例先销毁,再重建(数据在 hoursCache 里,不会重新请求)。
  for(const c of hoursCharts.values())c.destroy();hoursCharts.clear();
  document.querySelector("#dTable tbody").innerHTML=rows.length?rows.join(""):'<tr><td colspan="7" class="empty">'+(detailQuery?'没有匹配的用户记录':'暂无数据')+'</td></tr>';
  for(const {id,idx,agg,aggTk} of hoursChartPending){
    const canvas=document.getElementById("hoursCanvas-"+idx);
    if(!canvas)continue;
    // 双轴:柱=请求数(左),线=总 Token(输入+输出+缓存,右)——口径与面板「24 小时趋势」一致。
    const chart=new Chart(canvas,{type:"bar",data:{labels:halfHourLabels(),datasets:[
      {label:"请求数",data:agg,backgroundColor:COL[0]+"cc",borderRadius:2,borderSkipped:false,yAxisID:"y"},
      {label:"总 Token",data:aggTk,type:"line",borderColor:COL[1],backgroundColor:COL[1]+"22",fill:true,tension:.28,pointRadius:0,pointHitRadius:10,pointBackgroundColor:COL[1],pointHoverRadius:4,borderWidth:2,yAxisID:"y1"}
    ]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:{labels:{color:"#686863",font:{size:10},usePointStyle:true,pointStyle:"circle"}},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)+(ctx.datasetIndex===0?" 次请求":" tokens")}}},scales:{x:{ticks:{color:"#686863",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{beginAtZero:true,ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"},title:{display:true,text:"请求数",color:"#686863",font:{size:10}}},y1:{beginAtZero:true,position:"right",ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{drawOnChartArea:false},title:{display:true,text:"Tokens",color:"#686863",font:{size:10}}}}}});
    hoursCharts.set(id,chart);
  }
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
// 用户分布图的维度切换(按用户 / 按客户端)。只重画这一张图,不需要重新拉数 ——
// dailyClients 与 daily/dailyModels 一起来自 /api/stats,已经在 D 里了。
function setPieDim(dim){PIEDIM=dim==="client"?"client":"user";document.querySelectorAll("#pieDim button").forEach(b=>b.classList.toggle("on",b.dataset.dim===PIEDIM));if(D)render()}
document.querySelectorAll("#pieDim button").forEach(b=>b.addEventListener("click",()=>setPieDim(b.dataset.dim)));
// 模型请求分布图的维度切换(按模型 / 按方案),与用户分布图的 seg 同款。只重画不重新拉数
// —— profileDailyModels(方案×日期×模型聚合)与 dailyModels 一样已在 /api/stats 返回里。
function setModelDim(dim){MDLDIM=dim==="profile"?"profile":"model";document.querySelectorAll("#modelDim button").forEach(b=>b.classList.toggle("on",b.dataset.dim===MDLDIM));if(D)render()}
document.querySelectorAll("#modelDim button").forEach(b=>b.addEventListener("click",()=>setModelDim(b.dataset.dim)));
const protoLabel=proto=>proto==="anthropic"?"Anthropic":proto==="responses"?"OpenAI":"";
function render(){
  if(!D)return;
  // Populate profile dropdown
  const sel=document.getElementById("profileSel");
  if(sel.options.length<=1 && D.profiles){
    sel.innerHTML='<option value="all">全部方案</option>';
    for(const p of D.profiles){
      const sfx="/"+p.suffix+(p.isDefault?" · 默认入口":"")+(p.protocol==="responses"?" · OpenAI":" · Anthropic");
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
  const rowOf=p=>{const st=p.breakerState||"UNKNOWN";const rl=p.rateLimit;let col,led,stateLabel;if(rl){col='var(--red)';led='err';stateLabel='限额中 '+fmtResume(rl.resumeAt)+'恢复';}else{col=st==="CLOSED"?"var(--green)":st==="HALF_OPEN"?"var(--orange)":"var(--red)";led=st==="CLOSED"?"on":st==="HALF_OPEN"?"warn":"err";stateLabel=st==="CLOSED"?"正常":st==="HALF_OPEN"?"探测中":"熔断"+(p.breakerCooldownRemaining>0?' '+Math.ceil(p.breakerCooldownRemaining/1000)+'s后探测':'');}const current=currentProfile!=="all"&&p.suffix===currentProfile;const gBadge=p.inDefaultGroup?' <span style="color:var(--blue);font-size:10px;font-weight:600">默认组·'+(p.groupOrder+1)+'</span>':'';const rBadge=p.inResponsesGroup?' <span style="color:var(--blue);font-size:10px;font-weight:600">Resp组·'+(p.responsesGroupOrder+1)+'</span>':'';const protoBadge=p.protocol==='responses'?' <span style="color:var(--blue);font-size:10px">OpenAI</span>':'';const bLabel=p.billingType==='coding_plan'?' <span style="color:var(--dim);font-size:10px">CP</span>':p.billingType==='token_plan'?' <span style="color:var(--dim);font-size:10px">TP</span>':'';const pk=(p.peakHours&&p.peakHours.length)?(function(rs){const now=new Date(),cur=((now.getTime()+8*3600000)%86400000)/60000;const tm=function(t){if(!t)return null;const a=t.split(':');return (+a[0])*60+(+a[1])};const inPk=rs.some(function(r){const s=tm(r.start),e=tm(r.end);return s!==null&&e!==null&&s!==e&&(s<e?(cur>=s&&cur<e):(cur>=s||cur<e))});return ' <span style="color:'+(inPk?'var(--orange)':'var(--dim)')+';font-size:10px" title="高峰时段(北京时间) '+rs.map(function(r){return r.start+'-'+r.end}).join(', ')+'">'+(inPk?'高峰中':rs.map(function(r){return r.start+'-'+r.end}).join(','))+'</span>'})(p.peakHours):'';const rt2=(function(){if(p.peakQuotaRate==null&&p.offPeakQuotaRate==null)return'';const pr=p.peakQuotaRate==null?1:p.peakQuotaRate,orr=p.offPeakQuotaRate==null?1:p.offPeakQuotaRate;const nCustom=Object.keys(p.modelQuotaRates||{}).length;if(pr===1&&orr===1&&nCustom===0)return'';var now=new Date(),cur=((now.getTime()+8*3600000)%86400000)/60000;var tm=function(t){if(!t)return null;var a=t.split(':');return (+a[0])*60+(+a[1])};var ip=(p.peakHours||[]).some(function(r){var s=tm(r.start),e=tm(r.end);return s!==null&&e!==null&&s!==e&&(s<e?(cur>=s&&cur<e):(cur>=s||cur<e))});return ' <span style="color:var(--accent);font-size:10px" title="默认配额倍率：高峰 ×'+pr+' / 低谷 ×'+orr+'（当前'+(ip?'高峰':'低谷')+'）'+(nCustom?'；另有 '+nCustom+' 个模型单独定价':'')+'">×'+(ip?pr:orr)+(nCustom?'+'+nCustom:'')+'</span>'})();const restricted=(p.inDefaultGroup&&profiles.filter(x=>x.inDefaultGroup).length>=2)||(p.inResponsesGroup&&profiles.filter(x=>x.inResponsesGroup).length>=2);const entryCode=p.protocol==='responses'?'/v1/responses':'/v1';const defBadge=(p.isDefault||p.isResponsesDefault)?' <span style="color:var(--green);font-size:11px;font-weight:600;vertical-align:middle">默认</span>':'';/* 「使用状态」列:active 由后端算好(进行中请求 或 最近5分钟内完成记账)。使用中且
     有并发时带数字(failover 排查能直接看到哪个方案被压着 N 个);休眠时悬停看最后活跃。 */
const actCell='<td><span class="led '+(p.active?'on':'')+'"></span><span style="color:'+(p.active?'var(--green)':'var(--dim)')+';font-size:12px;white-space:nowrap"'+(p.active?'':' title="最后活跃：'+(p.lastActive?ago(p.lastActive):'从未')+'"')+'>'+(p.active?'使用中'+(p.inflight>0?' · '+p.inflight:''):'休眠中')+'</span></td>';return'<tr'+(current?' class="profile-current" aria-current="true"':'')+'><td>'+escH(p.name)+defBadge+gBadge+rBadge+protoBadge+bLabel+pk+rt2+(current?' <span class="current-mark">当前</span>':'')+'</td><td>'+(restricted?'<code>'+entryCode+'</code> <span style="color:var(--dim);font-size:10px">仅 '+entryCode+'</span>':'<code>/'+escH(p.suffix)+'</code>'+((p.isDefault||p.isResponsesDefault)?' <span style="color:var(--dim)">/ <code>'+entryCode+'</code></span>':''))+'</td><td style="font-size:12px;color:var(--dim);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escH((p.upstream||'').replace('https://','').replace('http://',''))+'</td><td class="n">'+fmtT(p.todayRequests||0)+'</td><td class="n hl">'+fmtT(p.todayTokens||0)+'</td>'+actCell+'<td><span class="led '+led+'"></span><span style="color:'+col+';font-size:12px">'+stateLabel+'</span></td></tr>'};
  const anthProfiles=profiles.filter(p=>p.protocol!=="responses"),respProfiles=profiles.filter(p=>p.protocol==="responses");
  const protoRow=(label,entry,count)=>'<tr class="proto-row"><td colspan="7">'+label+' · 入口 '+entry+' · '+count+' 个方案</td></tr>';
  let psbHtml="";
  if(anthProfiles.length)psbHtml+=protoRow("Anthropic","/v1",anthProfiles.length)+anthProfiles.map(rowOf).join("");
  if(respProfiles.length)psbHtml+=protoRow("OpenAI","/v1/responses",respProfiles.length)+respProfiles.map(rowOf).join("");
  psb.innerHTML=profiles.length?psbHtml:'<tr><td colspan="7" class="empty">暂无方案</td></tr>';
  const profileLabel=D.profileView||(currentProfile==="all"?"全部方案":"默认方案");
  const curProtoProf=(D.profiles||[]).find(p=>p.suffix===currentProfile);
  setProtoSeg(currentProfile!=="all"?((curProtoProf&&curProtoProf.protocol)||""):PROTO);
  const protoSuffix=protoLabel(currentProfile!=="all"?((curProtoProf&&curProtoProf.protocol)||""):PROTO);
  document.getElementById("profileContext").textContent="当前查看："+profileLabel+(protoSuffix?" · "+protoSuffix:"");
  const upstreamInfo=D.upstream?(" | 上游: "+D.upstream.replace("https://","").replace("http://","")):"";
  document.getElementById("meta").innerHTML='<span style="color:var(--accent);font-weight:600">方案: '+profileLabel+(protoSuffix?' · '+protoSuffix:'')+'</span>'+upstreamInfo+' &nbsp;|&nbsp; 更新于 '+(function(){const d=new Date();const utc=d.getTime()+d.getTimezoneOffset()*60000;return new Date(utc+8*3600000).toLocaleTimeString("zh-CN")})()+" (北京时间) | 每30秒刷新";

  // Charts —— 六图共用全局筛选：P 周期 / MT 指标 / MDL 模型 / USR 用户 / DS+DE 日期范围。
  // 窗口规则:分布类图(用户/客户端分布、模型、两张 24 小时)用 effBounds() —— 日期范围
  // 生效时优先,否则周期窗口;趋势与方案两张全史分桶图只在日期范围生效时收窄。
  const fd0=filteredDaily();
  const eb=effBounds();
  let fd=fd0;
  if(eb.ranged){const rf={};for(const[date,ud]of Object.entries(fd0)){if(date<eb.start||date>eb.end)continue;rf[date]=ud}fd=rf}
  const g=grp(fd,P),keys=Object.keys(g).sort(),uks=Object.keys(D.users);
  const val=s=>MT==="requests"?(s.requests||0):totalTokens(s);
  document.getElementById("trendNote").textContent=MDL!=="all"?"模型筛选：不含缓存 Token":"";
  if(C.t)C.t.destroy();if(C.p)C.p.destroy();if(C.m)C.m.destroy();if(C.h)C.h.destroy();if(C.hm)C.hm.destroy();if(C.pr)C.pr.destroy();
  C.t=new Chart(document.getElementById("trend"),{type:"bar",data:{labels:keys.map(k=>lbl(P,k)),datasets:uks.map((u,i)=>({label:D.users[u].name,data:keys.map(k=>val(g[k][u]||{})),backgroundColor:COL[i%COL.length]+"cc",borderRadius:3,borderSkipped:false}))},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:trendLegend(),tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)}}},scales:{x:{stacked:true,ticks:{color:"#686863",font:{size:10}},grid:{color:"rgba(24,24,22,.08)"}},y:{stacked:true,ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});
  // 用户分布 / 客户端分布:共用 #pie 这张横向柱状图,顶部 seg 切维度。
  // 两张图都是「按有效窗口累加(默认按日=今天;日期范围生效时按范围)」,只是分组键不同:
  // 用户维度按 user_key 聚合 filteredDaily();客户端维度按 client 聚合 dailyClients。
  // Y 轴标签都取完整可读的名字(用户名 / 客户端友好名)。
  let pieLabels,pieVals;
  if(PIEDIM==="client"){
    // 客户端维度自带 user_key 一层,所以 USR 筛选在这里自己应用;MDL(模型)筛选对它不适用
    // —— usage_daily_client 没有模型列,按模型筛出来的客户端分布无从计算,只能整段忽略。
    const cAgg={};
    for(const[date,users]of Object.entries(D.dailyClients||{})){
      if(date<eb.start||date>eb.end)continue;
      for(const[u,clients]of Object.entries(users)){
        if(USR!=="all"&&u!==USR)continue;
        for(const[c,v]of Object.entries(clients)){
          if(!cAgg[c])cAgg[c]={requests:0,tokens:0};
          cAgg[c].requests+=(v.requests||0);
          cAgg[c].tokens+=((v.inputTokens||0)+(v.outputTokens||0));
        }
      }
    }
    const names=Object.keys(cAgg);
    const vals=names.map(c=>MT==="requests"?cAgg[c].requests:cAgg[c].tokens);
    const idx=vals.map((_,i)=>i).sort((a,b)=>vals[b]-vals[a]);
    pieLabels=idx.map(i=>clientLabel(names[i]));pieVals=idx.map(i=>vals[i]);
    document.getElementById("pieTitle").textContent="客户端分布";
  }else{
    const tot=uks.map(u=>{let t=0;for(const[date,ud]of Object.entries(fd)){if(date<eb.start||date>eb.end)continue;const s=ud[u];if(s)t+=val(s)}return t});
    const uIdx=tot.map((_,i)=>i).sort((a,b)=>tot[b]-tot[a]);
    pieLabels=uIdx.map(i=>D.users[uks[i]].name);pieVals=uIdx.map(i=>tot[i]);
    document.getElementById("pieTitle").textContent="用户分布";
  }
  C.p=new Chart(document.getElementById("pie"),{type:"bar",data:{labels:pieLabels,datasets:[{label:MT==="requests"?"请求数":"总 Token",data:pieVals,backgroundColor:pieVals.map((_,i)=>COL[i%COL.length]+"cc"),borderWidth:0,borderRadius:3,borderSkipped:false}]},options:{indexAxis:"y",responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>MT==="requests"?fmtT(ctx.raw)+" 次请求":fmtT(ctx.raw)+" tokens"}}},scales:{x:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}},y:{ticks:{color:"#686863",font:{size:11},autoSkip:false},grid:{display:false}}}}});

  // 模型请求分布：按有效窗口(日期范围优先,否则周期窗口,北京时间)求和，可按指标筛选。
  // seg 切两个维度:按模型(usage_daily_model,可按用户筛选) / 按方案(profileDailyModels,
  // 方案×日期×模型聚合,无 user 维度所以不响应 USR —— 与「方案请求情况」图口径一致;
  // 两源都不含缓存 Token)。横向柱状图便于读取名称。
  let mLabels,mVal;
  if(MDLDIM==="profile"){
    const sfxName={};for(const p of (Array.isArray(D.profiles)?D.profiles:[]))sfxName[p.suffix]=p.name;
    const pAgg={};
    for(const [sfx,days] of Object.entries(D.profileDailyModels||{})){
      for(const [date,models] of Object.entries(days)){
        if(date<eb.start||date>eb.end)continue;
        if(!pAgg[sfx])pAgg[sfx]={requests:0,tokens:0};
        for(const v of Object.values(models||{})){
          pAgg[sfx].requests+=(v.requests||0);pAgg[sfx].tokens+=((v.inputTokens||0)+(v.outputTokens||0));
        }
      }
    }
    const pNames=Object.keys(pAgg);
    const pVal=pNames.map(s=>MT==="requests"?pAgg[s].requests:pAgg[s].tokens);
    const pIdx=pVal.map((_,i)=>i).sort((a,b)=>pVal[b]-pVal[a]);
    mLabels=pIdx.map(i=>sfxName[pNames[i]]||pNames[i]);mVal=pIdx.map(i=>pVal[i]);
  }else{
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
    const mv=mNames.map(m=>MT==="requests"?mAgg[m].requests:mAgg[m].tokens);
    const mIdx=mv.map((_,i)=>i).sort((a,b)=>mv[b]-mv[a]);
    mLabels=mIdx.map(i=>mNames[i]);mVal=mIdx.map(i=>mv[i]);
  }
  C.m=new Chart(document.getElementById("modelChart"),{type:"bar",data:{labels:mLabels,datasets:[{label:MT==="requests"?"请求数":"Token",data:mVal,backgroundColor:mVal.map((_,i)=>COL[i%COL.length]+"cc"),borderWidth:0,borderRadius:3,borderSkipped:false}]},options:{indexAxis:"y",responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>MT==="requests"?fmtT(ctx.raw)+" 次请求":fmtT(ctx.raw)+" tokens"}}},scales:{x:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}},y:{ticks:{color:"#686863",font:{size:11},autoSkip:false},grid:{display:false}}}}});

  // 两张 24 小时图只做「单日」统计:按日=今天;日期范围生效时要求开始=结束(同一天,只填
  // 今天开始那一头也算)。选了周/月/年、或范围跨多天时不统计 —— 数据留空(坐标轴照常渲染),
  // 图头 note 给出原因。跨天累加同槽位的口径(半小时是"各槽位累计分布"而非"当天真实曲线")
  // 容易误读,所以收窄到单日。服务端取数下界 hourlyChartFloor 与槽位映射 halfHourSlots 不变。
  const hDay=eb.ranged?(eb.start===eb.end?eb.start:null):(P==="day"?winBounds().td:null);
  const hourNoteText=hDay?"":"仅统计单日：选「按日」，或将开始/结束日期设为同一天";
  document.getElementById("hourNote").textContent=hourNoteText;
  document.getElementById("hourModelNote").textContent=hourNoteText;
  const hrs=halfHourLabels();
  const hAgg=Array.from({length:48},()=>({requests:0,tokens:0}));
  for(const [date,hours] of Object.entries(D.hourly||{})){
    if(!hDay||date!==hDay)continue;
    for(const [i,v,w] of halfHourSlots(hours)){
      hAgg[i].requests+=(v.requests||0)*w;hAgg[i].tokens+=totalTokens(v)*w;
    }
  }
  const hReq=hAgg.map(a=>a.requests),hTokens=hAgg.map(a=>a.tokens);
  C.h=new Chart(document.getElementById("hourChart"),{type:"line",data:{labels:hrs,datasets:[{label:"请求数",data:hReq,borderColor:"#2f6e50",backgroundColor:"rgba(47,110,80,.12)",fill:true,tension:.28,pointRadius:0,pointHitRadius:10,pointBackgroundColor:"#2f6e50",pointHoverRadius:4,borderWidth:2,yAxisID:"y"},{label:"总 Token",data:hTokens,borderColor:"#181816",backgroundColor:"rgba(24,24,22,.08)",fill:true,tension:.28,pointRadius:0,pointHitRadius:10,pointBackgroundColor:"#181816",pointHoverRadius:4,borderWidth:2,yAxisID:"y1"}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:{labels:{color:"#686863",font:{size:11},usePointStyle:true,pointStyle:"circle"}},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)}}},scales:{x:{ticks:{color:"#686863",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{type:"linear",position:"left",ticks:{color:"#2f6e50"},grid:{color:"rgba(24,24,22,.08)"},title:{display:true,text:"请求数",color:"#2f6e50",font:{size:10}}},y1:{type:"linear",position:"right",ticks:{color:"#181816",callback:v=>fmtTk(v)},grid:{drawOnChartArea:false},title:{display:true,text:"Tokens",color:"#181816",font:{size:10}}}}}});

  // 24小时模型使用趋势：与上面那张 24 小时图同一份单日口径(hDay),仅单日才统计。
  // 模型取当日总量 Top6，其余合并为「其他」，避免 legend 过长。数据自 usage_hourly_model 表启用日起累积。
  // 必须**先按槽聚合、再算总量**：兜底的旧行有 0.5 权重,先算总量会把同模型拆成两份口径。
  // 槽位数与上面那张图共用 halfHourLabels(),两图必须同步 —— 标签 48 配数据 24 只会画在轴左半边,不报错。
  const hmAgg=Array.from({length:48},()=>({}));
  for(const [date,hours] of Object.entries(D.hourlyModels||{})){
    if(!hDay||date!==hDay)continue;
    for(const [i,models,w] of halfHourSlots(hours)){
      for(const [m,v] of Object.entries(models)){
        if(!hmAgg[i][m])hmAgg[i][m]={requests:0,tokens:0};
        hmAgg[i][m].requests+=(v.requests||0)*w;hmAgg[i][m].tokens+=((v.inputTokens||0)+(v.outputTokens||0))*w;
      }
    }
  }
  const hmTot={};for(const hourAgg of hmAgg)for(const [m,v] of Object.entries(hourAgg))hmTot[m]=(hmTot[m]||0)+(MT==="requests"?v.requests:v.tokens);
  const topModels=Object.keys(hmTot).sort((a,b)=>hmTot[b]-hmTot[a]).slice(0,6);
  const hasOther=Object.keys(hmTot).length>topModels.length;
  const hmSeries=topModels.map(m=>({label:m,data:hmAgg.map(a=>MT==="requests"?((a[m]||{}).requests||0):((a[m]||{}).tokens||0))}));
  if(hasOther)hmSeries.push({label:"其他",data:hmAgg.map(a=>{let t=0;for(const [m,v] of Object.entries(a))if(!topModels.includes(m))t+=MT==="requests"?v.requests:v.tokens;return t})});
  C.hm=new Chart(document.getElementById("hourModelChart"),{type:"line",data:{labels:hrs,datasets:hmSeries.map((s,i)=>({label:s.label,data:s.data,borderColor:COL[i%COL.length],backgroundColor:COL[i%COL.length]+"22",fill:i===0,tension:.28,pointRadius:0,pointHitRadius:10,pointBackgroundColor:COL[i%COL.length],pointHoverRadius:4,borderWidth:2}))},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:trendLegend(),tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)+(MT==="requests"?" 次请求":" tokens")}}},scales:{x:{ticks:{color:"#686863",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});

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
  renderClientBoard();
  renderRateBoard();
}
async function load(){try{const profile=currentProfile==="all"?"all":currentProfile;const qs=[];if(profile!=="all")qs.push("profile="+encodeURIComponent(profile));else if(PROTO)qs.push("protocol="+PROTO);const r=await fetch("/api/stats"+(qs.length?"?"+qs.join("&"):""));D=await r.json();render()}catch(e){document.getElementById("meta").textContent="Error: "+e.message}}
function toggleSec(id){const body=document.getElementById(id+"Body");const icon=document.getElementById(id+"Icon");const open=body.classList.toggle("open");icon.classList.toggle("open",open)}
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.remove("on"));b.classList.add("on");P=b.dataset.p;resetDetailGrouping();render()}));
document.getElementById("metricSel").addEventListener("change",e=>{MT=e.target.value;render()});
document.getElementById("modelSel").addEventListener("change",e=>{MDL=e.target.value;resetDetailGrouping();render()});
document.getElementById("userSel").addEventListener("change",e=>{USR=e.target.value;render()});
function resetChartFilters(){P="day";MT="tokens";MDL="all";USR="all";DS="";DE="";PROTO="";setPieDim("user");setModelDim("model");setProtoSeg("");document.querySelectorAll("#globalTabs .tab").forEach(x=>x.classList.toggle("on",x.dataset.p==="day"));document.getElementById("metricSel").value="tokens";document.getElementById("modelSel").value="all";document.getElementById("userSel").value="all";document.getElementById("dateStart").value="";document.getElementById("dateEnd").value="";if(currentProfile!=="all"){currentProfile="all";document.getElementById("profileSel").value="all"}resetDetailGrouping();load()}
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
// ── 会话使用情况 tab(懒加载:首次切到该 tab 才拉数据)──
// 与成本/产出一致:会话视图比总览更细(时间戳、文件路径、会话标识),按需拉、不挂 30 秒轮询。
let sessionsLoaded=false,sessDrillUser='';
// 分档 → 药丸配色。档位一律服务端算好(方向不写死在前端),这里只做颜色映射。
const SESS_GRADE_CLS={good:'pill-ok',warn:'pill-warn',bad:'pill-bad'};
const SESS_THS_FALLBACK={cache_rate_good:.9,cache_rate_warn:.8,new_input_good:3000,new_input_bad:8000};
const DASH='<span style="color:var(--dim)">—</span>';
function sessGrade(s){return '<span class="'+(SESS_GRADE_CLS[s.grade]||'chip')+'">'+escH(s.gradeLabel||'—')+'</span>'}
function sessRatio(v,ths){if(v==null)return DASH;const col=v>=ths.cache_rate_good?'var(--green)':v>=ths.cache_rate_warn?'var(--orange)':'var(--red)';return '<span style="color:'+col+'">'+(v*100).toFixed(1)+'%</span>'}
function sessPerTurn(v,ths){if(v==null)return DASH;const col=v<=ths.new_input_good?'var(--green)':v<=ths.new_input_bad?'var(--orange)':'var(--red)';return '<span style="color:'+col+'">'+fmtT(Math.round(v))+'</span>'}
function sessFail(v){if(v==null)return DASH;const col=v<0.1?'var(--green)':v<0.3?'var(--orange)':'var(--red)';return '<span style="color:'+col+'">'+(v*100).toFixed(1)+'%</span>'}
// 下钻键必须用原始 key(载荷里的 key 字段),掩码后的 user_key 查不到任何东西。
function drillSess(key){sessDrillUser=sessDrillUser===key?'':key;loadSessions()}
function clearSessDrill(){sessDrillUser='';loadSessions()}
async function loadSessions(){
  const range=document.getElementById('sessRangeSel').value;
  try{
    const d=await fetch('/api/sessions?range='+range+(sessDrillUser?'&user='+encodeURIComponent(sessDrillUser):'')).then(r=>r.json());
    const ths=Object.assign({},SESS_THS_FALLBACK,d.thresholds||{});
    const s=d.summary||{};
    const drill=d.users.find(u=>u.key===sessDrillUser);
    document.getElementById('sessDrillClear').style.display=sessDrillUser?'':'none';
    document.getElementById('sessDrillHint').textContent=sessDrillUser?('当前只看 '+(drill?drill.user_name:'已选成员')):'全部成员 · 点上方某行可只看该成员';
    document.getElementById('sessSummary').textContent=s.sessions
      ?('合计 '+s.sessions+' 个会话 / '+fmtT(s.requests||0)+' 轮 · 缓存率 '+(s.cache_rate==null?'—':(s.cache_rate*100).toFixed(1)+'%')+' · 单轮新增 '+(s.new_input_per_turn==null?'—':fmtT(Math.round(s.new_input_per_turn)))+' token/轮 · 总档位：'+(s.gradeLabel||'—'))
      :'该周期没有可归属到会话的请求';
    document.querySelector('#sessUserTable tbody').innerHTML=d.users.map(u=>
      '<tr style="cursor:pointer'+(u.key===sessDrillUser?';background:rgba(47,110,80,.06)':'')+'" onclick="drillSess('+escH(JSON.stringify(String(u.key)))+')" title="点击下钻到该成员的会话流水">'
      +'<td>'+escH(u.user_name)+' <span style="color:var(--dim);font-size:10px">'+escH(u.user_key)+'</span></td>'
      +'<td class="n">'+fmtT(u.sessions)+'</td>'
      +'<td class="n">'+fmtT(u.requests)+'</td>'
      +'<td class="n hl">'+fmtTk(u.tokens)+'</td>'
      +'<td class="n">'+sessRatio(u.cache_rate,ths)+'</td>'
      +'<td class="n">'+sessPerTurn(u.new_input_per_turn,ths)+'</td>'
      +'<td class="n">'+sessFail(u.fail_rate)+'</td>'
      +'<td class="n">'+(u.fragments||0)+'</td>'
      +'<td>'+sessGrade(u)+'</td></tr>').join('')
      ||'<tr><td colspan="9" class="empty">该周期没有可归属到会话的请求</td></tr>';
    // 「会话」列:有会话名(后端从本机 Claude Code 的会话文件现读)就顶掉那串标识 ——
    // 列宽有限,两者同显会把表挤变形;完整标识挪进悬浮提示,别处对账仍以它为准。
    document.querySelector('#sessTable tbody').innerHTML=d.sessions.map(x=>
      '<tr>'
      +'<td>'+escH(x.user_name)+'</td>'
      +'<td>'+(x.client?escH(clientLabel(x.client)):'<span style="color:var(--dim)">—</span>')+'</td>'
      +'<td>'+(x.project?escH(x.project)+(x.cross_projects>0?' <span class="chip chip-warn" title="该会话横跨多个项目，token 整段算在主项目名下">跨'+x.cross_projects+'</span>':''):'<span style="color:var(--dim)">纯问答</span>')+'</td>'
      +'<td style="font-size:10px;color:var(--dim)" title="'+escH(x.session)+'">'+escH(x.title||String(x.session).slice(0,18))+'</td>'
      +'<td style="font-size:11px;color:var(--dim);white-space:nowrap">'+bjClock(x.first_seen)+(x.last_seen!==x.first_seen?' → '+bjClock(x.last_seen).slice(6):'')+'</td>'
      +'<td class="n">'+(x.requests?fmtT(x.requests):'<span style="color:var(--dim)" title="只有工具数据，轮数未知">—</span>')+'</td>'
      +'<td class="n hl">'+(x.token_data?fmtTk(x.tokens):DASH)+'</td>'
      +'<td class="n">'+sessRatio(x.cache_rate,ths)+'</td>'
      +'<td class="n">'+sessPerTurn(x.new_input_per_turn,ths)+'</td>'
      +'<td class="n">'+(x.tool_calls||0)+(x.errors?' <span style="color:var(--red);font-size:10px" title="其中 '+x.errors+' 次失败">/'+x.errors+'</span>':'')+'</td>'
      +'<td class="n">'+(x.files||0)+'</td>'
      +'<td class="n">'+(x.net_lines==null?DASH:((x.net_lines>0?'+':'')+fmtT(x.net_lines)))+'</td>'
      +'<td class="n">'+sessFail(x.fail_rate)+'</td>'
      +'<td>'+sessGrade(x)+(x.fragment?' <span class="chip chip-warn" title="轮数 ≤ '+(ths.fragment_max_requests||2)+'，会话偏碎">碎片</span>':'')+'</td></tr>').join('')
      ||'<tr><td colspan="14" class="empty">该周期没有可归属到会话的请求</td></tr>';
    // 无会话标识的部分必须如实披露 —— 否则「总量」和「会话表加起来」对不上时没人知道为什么
    const un=d.unattributed||{},tot=d.totals||{},at=d.attributed||{};
    const notes=['统计范围 '+escH(d.from)+' ~ '+escH(d.to)+' · 总量 '+fmtTk(tot.tokens||0)+' token / '+fmtT(tot.requests||0)+' 次请求'];
    if(un.requests>0)notes.push('另有 '+fmtT(un.requests)+' 次请求没有会话标识('+fmtTk(un.tokens)+' token)，无法归属到任何会话 —— 会话表只覆盖了其中 '+fmtT(at.requests||0)+' 次');
    if(d.truncated)notes.push('会话流水只显示最近 '+fmtT((d.sessions||[]).length)+' 条，缩小时间范围可看到更早的会话');
    document.getElementById('sessNote').innerHTML=notes.join('<br>');
  }catch(e){
    document.getElementById('sessSummary').textContent='加载失败: '+e.message;
  }
}
document.getElementById('workspace-tab-sessions').addEventListener('click',()=>{if(!sessionsLoaded){sessionsLoaded=true;loadSessions()}});
function startAutoRefresh(){if(refreshTimer)clearInterval(refreshTimer);refreshTimer=setInterval(()=>{if(autoRefresh)load()},30000)}
document.getElementById("autoRefreshBtn").addEventListener("click",()=>{autoRefresh=!autoRefresh;const btn=document.getElementById("autoRefreshBtn");btn.textContent="自动刷新: "+(autoRefresh?"开":"关");btn.className=autoRefresh?"ar-on":"ar-off"});
window.addEventListener("resize",scheduleChartResize);
load();startAutoRefresh();
