Chart.defaults.color='#686863';Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei","Segoe UI",sans-serif';Chart.defaults.font.size=11;
// public/assets/dashboard.js —— 管理仪表盘页（dashboardHtml，/dashboard）的客户端逻辑。
// 页面内联引导脚本先注入 toast() 及 UI_HELPERS 提供的辅助函数再加载本文件；
// 全部数据经 /api/* 运行时拉取，文件不含任何密钥，可长期强缓存（?v= 内容版本号）。
let D=null,P="day",C={t:null,p:null,m:null,h:null,hm:null,pr:null},errPage=1,autoRefresh=true,refreshTimer=null,currentProfile="all",PROTO="";
let USR="all",MT="tokens",PIEDIM="user",MDLDIM="model";
let DS="",DE="";
// 北京时间的「今天」(YYYY-MM-DD)。原先 render / renderCharts / renderTables 各抄一份
// 这个表达式,上一轮把用户表搬进 renderTables 时漏了一份 —— 运行期直接 ReferenceError
// (侧栏显示 Error: td is not defined,后续所有渲染被跳过,六张表全空)。
// 抽成一处共用,以后无论怎么拆函数都不会再漏。
const todayBJ=()=>new Date(Date.now()+8*36e5).toISOString().slice(0,10);
let activeWorkspaceTab="overview";
// 菜单顺序,与侧栏按钮一一对应;id 由 setWorkspaceTab 按 'workspace-tab-'+s 硬拼 ——
// 增删菜单必须与 lib/pages.mjs 的按钮和面板同时改,否则切换会静默失效。
const SECTIONS=['overview','upstream','users','clients','detail','profiles','rates','errors','production','sessions','costs','review'];

// ── 按菜单懒加载 ─────────────────────────────────────────────────────────────
// 点哪个菜单才查哪个菜单的数据:别为了一张错误表去跑 dailyModels/dailyClients 那几张
// 400 天宽表的全表扫描(实测这是 dashboard 最重的一块)。
//   值 = /api/stats 的 section 名;null = 该菜单有自己的独立端点(产出/会话/成本/评审)。
const SECTION_SOURCE={
  overview:"overview", users:"users", clients:"clients", detail:"detail",
  profiles:"profiles", rates:"rates", errors:"errors",
  production:null, sessions:null, costs:null, review:null,
  upstream:null,     // 上游额度:独立端点(/api/upstream-quota),不搭 /api/stats 的车
};
const sectionLoaded={};        // 菜单 → 是否已把它的数据拉进来过

// 该菜单的数据源拉取完成后,由它自己渲染(每个渲染函数都自带「数据不在就跳过」的守卫)
function renderSection(name){
  if(name==="overview")render();
  else if(name==="users")renderUsersPanel();
  else if(name==="clients")renderClientBoard();
  else if(name==="detail")renderDetailPanel();
  else if(name==="profiles")renderProfilesPanel();
  else if(name==="rates")renderRateBoard();
  else if(name==="errors")renderErrorsPanel();
  renderMeta();
}

// 首次进入某菜单时拉它自己的那份数据;force=true 用于自动刷新/手动刷新
async function ensureSection(name,{force=false}={}){
  const src=SECTION_SOURCE[name];
  if(src===undefined)return;
  if(src===null){                       // 产出/会话/成本/评审:各自的加载器/标志
    if(name==="review"){window.crEnsureLoaded&&window.crEnsureLoaded();return}
    // 上游额度:**刻意忽略 force**。自动刷新每轮都强制打上游 = 对平台的定时骚扰,
    // 刷新节奏交给服务端(缓存秒数 + 「自动刷新」分钟数,见设置页左下角「上游额度」)。
    if(name==="upstream"){window.UQ&&window.UQ.load();return}
    if(force||!sectionLoaded[name]){
      sectionLoaded[name]=true;
      if(name==="production")loadProduction();
      else if(name==="sessions")loadSessions();
      else if(name==="costs")loadCosts();
    }
    return;
  }
  if(!force&&sectionLoaded[name]){renderSection(name);return}
  try{
    const qs=new URLSearchParams({section:src});
    if(currentProfile!=="all")qs.set("profile",currentProfile);
    else if(PROTO)qs.set("protocol",PROTO);
    qs.set("start",statsFloor());       // 宽表按当前图表窗口取数,见 statsFloor 注释
    const r=await fetch("/api/stats?"+qs);
    const payload=await r.json();
    D=Object.assign(D||{},payload);     // 合并进既有全局:渲染函数继续读 D.*
    FLOOR=qs.get("start")||FLOOR;       // 记录本次实际取到的最早起点(放宽筛选时才需重拉)
    sectionLoaded[name]=true;
    renderSection(name);
  }catch(e){document.getElementById("meta").textContent="Error: "+e.message}
}

// 自动刷新/手动刷新:只重拉当前菜单的那份数据
function refreshCurrent(){
  // 代码评审有自己的加载器(在 code-review.js 里),它单独暴露了两个钩子
  if(activeWorkspaceTab==="review"){window.crReload&&window.crReload();return}
  ensureSection(activeWorkspaceTab,{force:true});
}

// 方案/协议变了 → 每个 section 的载荷都是按它过滤的,已加载的统统作废
function clearSectionCache(){for(const k of Object.keys(sectionLoaded))delete sectionLoaded[k]}
// 图表脏标记:面板隐藏时建不出图(宽度 0)。render() 在「数据总览不可见」时跳过建图
// 并置脏;切回数据总览时若脏且有数据就重建 —— 否则自动刷新会把图画废(踩过)。
let chartsDirty=false;
function overviewVisible(){const p=document.getElementById("workspace-panel-overview");return !!p&&!p.hidden}
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
// 「Token 用量趋势」与「方案请求情况」是仅有的两张**默认吃全史**的分桶图(其余图都按
// 周期窗口或日期范围收窄)。真实数据下全史按日分桶有两百多根柱子,挤成一片谁也读不出来 ——
// 所以**没设日期范围时最多画最近 30 个桶**(按日就是最近 30 天,周/月/年同样是最多 30 个桶)。
// 设了日期范围就以范围为准:这里只裁「前端要画几个桶」,服务端那份全史数据照旧下发,
// 所以换范围不必重拉。注意不能改成「默认填上 30 天的日期范围」—— effBounds 是全图共用的,
// 一旦带上范围,要求单日的两张 24 小时图会直接变成空的。
const RECENT_BUCKETS=30;
const PERIOD_UNIT={day:"天",week:"周",month:"个月",year:"年"};
// tip 只在**确实裁掉了**才给:数据本身不足 30 个桶时不必打扰用户
function recentBuckets(keys,ranged){
  if(ranged||keys.length<=RECENT_BUCKETS)return{keys,tip:""};
  // 数字与中文之间留空格(「近 30 天」而不是「近 30天」)
  return{keys:keys.slice(-RECENT_BUCKETS),tip:"近 "+RECENT_BUCKETS+" "+PERIOD_UNIT[P]+"（设日期范围可看更早）"};
}
// 面板右上角那句小字:多个提示用「；」串起来,都没有就留空
function chartNote(...parts){return parts.filter(Boolean).join("；")}
// 当前周期窗口（北京时间）：日=今天、周=本周一、月=本月 1 日、年=本年 1 月 1 日。
function winBounds(){const t=todayBJ();return{wStart:P==="day"?t:P==="week"?wk(t):P==="month"?t.slice(0,7)+"-01":t.slice(0,4)+"-01-01",td:t}}
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
  rerenderOrReload();
}
// ── 宽表(dailyModels/dailyClients)按需取数(P3 出网优化)──
// 服务端只下发这个起点之后的宽表行;daily(趋势图)/profileDaily(方案图)恒为全史不受影响。
// 宽表消费方(模型/客户端分布图、24 小时模型图)都按 effBounds 窗口过滤,传窗口起点即可 ——
// 默认按日视图只需今天,30s 轮询的载荷大幅缩小。
let FLOOR="";
function statsFloor(){
  return effBounds().start;
}
// 筛选变化时:需要的起点比已取的更早就重拉,否则纯前端过滤就够(切 Tab 不再无条件打服务端)。
function rerenderOrReload(){
  if(statsFloor()<FLOOR)load();else render();
}
// 图表数据源：只按用户筛选过滤 daily；无筛选直接用 daily。与 grp()/totalTokens() 的字段约定兼容。
function filteredDaily(){
  if(USR==="all")return D.daily||{};
  const f={};for(const[date,ud]of Object.entries(D.daily||{})){if(ud[USR])f[date]={[USR]:ud[USR]}}return f;
}
function c(l,v,cl,k,tip){return'<div class="card"'+(tip?' title="'+tip+'"':'')+'><div class="l">'+l+'</div><div class="v" data-cu="'+v+'"'+(k?' data-cu-k':'')+'>0</div></div>'}
// 「今日用量」「总用量」两张卡都是总Token(输入+输出+缓存读写)口径 —— 与右侧图表的
// 输入+输出口径并排时数字会差出一个缓存量(个人页同名「今日用量」卡反而标的是输入+输出,
// 两页口径相反)。副标签把口径直接标在卡上(与个人页那套副标签同一视觉语言),悬浮
// title 给完整口径 + 「缓存不占额度」的提醒,防止拿含缓存数字去对配额误判超限。
const CARD_CACHE_TAG=' <span style="font-size:9px;color:var(--dim);font-weight:400">含缓存</span>';
const CARD_CACHE_TIP="总Token口径：输入+输出+缓存写入+缓存读取。缓存命中不占每日额度，配额按计权口径另算";
const fmtBytes=n=>{if(n>=1073741824)return(n/1073741824).toFixed(2)+" GB";if(n>=1048576)return(n/1048576).toFixed(1)+" MB";if(n>=1024)return(n/1024).toFixed(1)+" KB";return n+" B"};
// 模型图「按方案 / 按模型×方案」两个维度的 y 轴标签会很宽(模型 ID 后面还叠一个方案名)。
// 超出轴宽时 Chart.js 不换行,直接把多出来的部分画到画布外**裁掉** —— 最长的几根柱子会变成
// 缺头少尾的半个名字(实测 deepseek-v4-flash-ga-260731(火山引擎-cc-高阶版) 掉了开头)。
//
// 所以「按模型×方案」的轴标签排成**两行**(第一行模型名、第二行 (方案名)):轴的宽度只受较长
// 的那一行约束,和「按模型」一样宽 —— 这个维度不会比原维度更容易裁字,而且两个名字都是全的。
// 窄窗口 / 超长模型 ID 下连一行都放不下时才逐行截断(汉字算 2、其余算 1,见 dispW),
// 被截掉的部分由 tooltip 用完整名字补回(mFull)。
//
// 预算按**画布宽度**算而不是写死字符数:实测 Chart.js 给 y 轴的宽度上限就是画布的 50%
// (616/536/420/279px 画布对应 284/268/210/140px),写死字符数在窄窗口(半屏)会重新裁字。
const AXIS_UNIT_PX=6.1;                       // 11px 字号下一个宽度单位约 6.1px(汉字算 2 单位)
function axisLabelBudget(){
  const el=document.getElementById("modelChart");
  // Number() 而不是直接取:量不到宽度(DOM 桩、面板隐藏)时退回保守值,别让 NaN 把截断逻辑带跑偏
  const w=(el&&Number(el.clientWidth))||520;
  return Math.max(10,Math.floor((w*0.5-10)/AXIS_UNIT_PX));
}
const charW=ch=>/[㐀-鿿　-〿＀-￯]/.test(ch)?2:1;
const dispW=s=>{let w=0;for(const ch of s)w+=charW(ch);return w};
function keepHead(s,budget){if(budget<=0)return"";let w=0,out="";for(const ch of s){const c=charW(ch);if(w+c>budget)break;out+=ch;w+=c}return out}
function shortAxisLabel(s){const max=axisLabelBudget();return dispW(s)<=max?s:keepHead(s,max-1)+"…"}
// 轴上一格排几行:每一行都独立截断,超长的那一行(通常是模型名)才被截
function fitAxisLines(lines){const max=axisLabelBudget();return lines.map(l=>dispW(l)<=max?l:keepHead(l,max-1)+"…")}
// 模型图的画布高度按**行数**撑开。Chart.js 把多行 tick 标签以每个分类带的中线为基准上下排,
// 带高不够就相邻两行压在一起 —— 生产上十几二十个模型×方案时,固定高度(实测常见桌面窗口下
// 画布可见高只有 234px)会把每带压到十几 px,两行 11px 文字糊成一片。所以每行给足
// 「标签行数 × 行高」,总高超过面板时由 .chart-canvas 纵向滚动(样式见 dashboard.css 的 .chart-models 段)。
const MODEL_ROW_PX={1:20,2:34};   // 11px 字号:单行带 20px、两行带 34px(实测不重叠)
const MODEL_AXIS_PAD=34;          // x 轴刻度 + 画布上下留白
function sizeModelCanvas(rows,lines){
  const box=document.getElementById("modelCanvasBox"),sizer=document.getElementById("modelSizer");
  if(!box||!sizer)return;
  // 这里**只写行数算出来的高度**,不掺面板高度:「行数少时铺满面板」由 CSS 的
  // min-height:100% 实时兜底(样式就在 .chart-models .canvas-sizer)。好处是这个值
  // 与窗口尺寸无关 —— 不需要测量、也就不会留下过期的测量值,窗口缩放不必重算
  // (测出来的面板高度反之会在窗口变矮后把图撑得虚高、白白多出滚动)。
  sizer.style.height=rows*(MODEL_ROW_PX[lines]||MODEL_ROW_PX[1])+MODEL_AXIS_PAD+"px";
  box.scrollTop=0;   // 换维度/换窗口后从头看,别停在上一份数据的滚动位置
}
// y 轴 ticks 回调的两条分支(mTicks 只有「按模型×方案」才非空):
//   mTicks 非空 → 返回排好版的两行标签数组(Chart.js 的多行 tick 要求返回字符串数组)
//   否则       → **必须**走 getLabelForValue(v)
// 注意:这里不能写成 `return v`。category 轴的 ticks 回调第一个入参是**索引(数字)**,不是标签
// (实测 Chart.js 4.4.7:回调收到的是 number 0/1) —— 直接返回它,「按模型 / 按方案」两个
// 维度的轴标签会全部变成 0、1、2…… 这就是 getLabelForValue 存在的原因,它正是默认回调。
// 也正因为要 `this`,这里必须是 function 而不是箭头函数(Chart.js 以 scale 为 this 调用)。
// 今日出网卡片:↑ 发往上游的请求体字节(含重试累计)/ ↓ 回传客户端字节。数字过大不适合
// count-up 动画,直接格式化文本(不带 data-cu,runCountUps 会跳过)。两段一律单行
// (white-space:nowrap),字号降到 16px —— 与其他卡的 21px 比略小,但两个方向塞得下。
function egressCard(){const e=D.egress;if(!e)return"";return'<div class="card" title="上行 '+e.upstreamPosts+' 次上传 / '+e.requests+' 个请求,北京日界重置,重启后按今日日志回填"><div class="l">今日出网</div><div class="v" style="font-size:16px;white-space:nowrap"><span style="color:var(--orange)">↑ '+fmtBytes(e.upBytes)+'</span><span style="color:var(--blue);margin-left:12px">↓ '+fmtBytes(e.downBytes)+'</span></div></div>'}
let chartResizeFrame=0;
function doughnutLegend(){const compact=innerWidth<1280;return{position:"bottom",labels:{color:"#686863",font:{size:compact?10:11},padding:compact?6:10,boxWidth:compact?16:24}}}
function trendLegend(){const compact=innerWidth<=820;return{labels:{color:"#686863",font:{size:compact?9:11},padding:compact?6:10,boxWidth:compact?16:40}}}
function scheduleChartResize(){cancelAnimationFrame(chartResizeFrame);chartResizeFrame=requestAnimationFrame(()=>{for(const chart of[C.p,C.m]){if(chart){chart.options.plugins.legend={display:false};chart.update("none")}}for(const chart of[C.t,C.hm,C.pr]){if(chart){chart.options.plugins.legend=trendLegend();chart.update("none")}}Object.values(C).forEach(chart=>chart&&chart.resize())})}
function setWorkspaceTab(tab,focus){
  if(SECTIONS.indexOf(tab)<0)tab="overview";
  activeWorkspaceTab=tab;
  SECTIONS.forEach(function(sec){
    const btn=document.getElementById("workspace-tab-"+sec),panel=document.getElementById("workspace-panel-"+sec);
    const on=sec===tab;
    if(btn){btn.classList.toggle("active",on);btn.setAttribute("aria-selected",String(on));btn.tabIndex=on?0:-1}
    if(panel){panel.hidden=!on;panel.classList.toggle("active",on)}
  });
  if(focus){const b=document.getElementById("workspace-tab-"+tab);if(b)b.focus()}
  // 切回数据总览时,若期间 render() 因面板隐藏跳过了建图,现在补建
  if(tab==="overview"&&chartsDirty&&D){chartsDirty=false;renderCharts()}
  // 菜单的数据按需拉取 —— 在这里触发(而不是绑 click 监听),键盘上下键切菜单同样生效
  ensureSection(tab);
  scheduleChartResize();
}
function handleWorkspaceTabKeydown(event){
  const tabs=[...document.querySelectorAll("#dashNav .nav-btn")],index=tabs.indexOf(event.currentTarget);let next=index;
  if(event.key==="ArrowDown"||event.key==="ArrowRight")next=(index+1)%tabs.length;else if(event.key==="ArrowUp"||event.key==="ArrowLeft")next=(index-1+tabs.length)%tabs.length;else if(event.key==="Home")next=0;else if(event.key==="End")next=tabs.length-1;else return;
  event.preventDefault();setWorkspaceTab(tabs[next].id.replace("workspace-tab-",""),true);
}
// ── 客户端用量 board ────────────────────────────────────────────────────────
// 按 客户端 × 用户 展开,组内按合计降序,组间也按合计降序。数据来自 /api/stats 的
// dailyClients(与 dailyModels 同形),随 render() 一起刷新 —— 不走懒加载,所以 tab 上的
// 计数在这里自己写,不能放进 renderWorkspaceSummaries()(那个函数每 30 秒跑一次,
// 对懒加载 tab 会把数字擦掉;这张表虽然不受影响,但归属写在一处更好维护)。
// 客户端与协议正交,所以这里不套用 protoSeg;但窗口与 USR 筛选沿用全局那套。
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
    body.innerHTML='<tr><td colspan="7" class="empty">暂无数据</td></tr>';
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
  document.getElementById("clientContext").textContent=order.length
    ?(order.length+' 个客户端 · 合计 '+fmtT(total)+' Token')
    :"暂无数据";
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
// 该用户该时段的两个横切面:按模型请求 / 按方案请求(数据与小时明细同一次请求返回)。
// 横条按各自列表内的最大值归一 —— 看的是"哪个占大头",不是绝对刻度。
// token 口径:输入+输出(usage_daily_model 没有缓存列,两栏保持一致才好比)。
function detailBreakdownHTML(payload){
  const block=(title,list,labelOf)=>{
    if(!list||!list.length)return '<div class="detail-bd"><div class="detail-bd-title">'+title+'</div><div class="detail-bd-empty">该时段无数据</div></div>';
    const max=Math.max.apply(null,list.map(x=>x.requests||0))||1;
    const rows=list.slice(0,8).map(it=>{
      const w=Math.max(2,Math.round((it.requests||0)/max*100));
      return '<div class="detail-bd-row"><span class="detail-bd-name" title="'+escH(labelOf(it))+'">'+escH(labelOf(it))+'</span>'
        +'<span class="detail-bd-track"><i style="width:'+w+'%"></i></span>'
        +'<span class="detail-bd-val" title="请求数 · 输入+输出 token（不含缓存）">'+fmtT(it.requests||0)+' 次 · '+fmtTk((it.inputTokens||0)+(it.outputTokens||0))+'</span></div>';
    }).join("");
    const more=list.length>8?'<div class="detail-bd-more">另有 '+(list.length-8)+' 项未显示</div>':'';
    return '<div class="detail-bd"><div class="detail-bd-title">'+title+' <span>'+list.length+' 项</span></div>'+rows+more+'</div>';
  };
  const models=payload.models||[],profiles=payload.profiles||[];
  if(!models.length&&!profiles.length)return "";
  return '<div class="detail-breakdowns">'
    + block("按模型请求",models,m=>m.model)
    + block("按方案请求",profiles,p=>p.name)
    + '</div>';
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
      rows.push('<tr class="detail-member"><td class="detail-sticky"><span class="detail-user detail-user-click" title="点击展开：24 小时请求分布 + 该时段按模型/按方案请求" onclick="toggleUserHours(\''+escH(period.key)+'\',\''+escH(member.key)+'\')"><span class="detail-user-name">'+escH(member.name)+'</span><span class="detail-key">'+escH(maskDetailKey(member.key))+'</span></span></td><td class="n">'+fmtT(data.requests||0)+'</td><td class="n">'+fmtT(data.inputTokens||0)+'</td><td class="n">'+fmtT(data.outputTokens||0)+'</td><td class="n">'+fmtT(data.cacheCreationTokens||0)+'</td><td class="n">'+fmtT(data.cacheReadTokens||0)+'</td><td class="n hl">'+fmtT(totalTokens)+'<span class="detail-share">'+share+'%</span></td></tr>');
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
          const bd=detailBreakdownHTML(payload);
          if(!agg.some(x=>x>0)){
            const outOfRetention=payload.retentionStart&&detailPeriodRange(period.key).end<payload.retentionStart;
            rows.push('<tr class="detail-hours-row"><td colspan="7"><div class="detail-hours"><div class="detail-hours-note">'+(outOfRetention?'该时段超出小时明细保留期（小时数据仅保留近 7 天）':'该时段暂无小时明细')+'</div>'+bd+'</div></td></tr>');
          }else{
            const idx=hoursChartSeq++;
            rows.push('<tr class="detail-hours-row"><td colspan="7"><div class="detail-hours"><div class="detail-hours-title">'+escH(member.name)+' · '+escH(detailPeriodLabel(period.key))+' 24 小时请求分布（半小时粒度 · 柱=请求数，线=总 Token · 点击用户名收起）</div><div class="detail-hours-canvas"><canvas id="hoursCanvas-'+idx+'"></canvas></div>'+bd+'</div></td></tr>');
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
  document.getElementById("detailPages").innerHTML=periods.length?'<span>第 '+detailPage+' / '+totalPages+' 页</span><button type="button" onclick="setDetailPage('+(detailPage-1)+')" '+(detailPage<=1?'disabled':'')+'>上一页</button><button type="button" onclick="setDetailPage('+(detailPage+1)+')" '+(detailPage>=totalPages?'disabled':'')+'>下一页</button>':'';
}
function switchProfileView(v){currentProfile=v||"all";resetDetailGrouping();clearSectionCache();load()}
// Protocol segmented control: switches the "all profiles" aggregation between
// Anthropic (Claude Code) and Responses (Codex) views. Selecting a specific
// profile overrides it — the segment then mirrors that profile's protocol.
function setProtoSeg(proto){document.querySelectorAll("#protoSeg button").forEach(b=>b.classList.toggle("on",b.dataset.proto===(proto||"")))}
function switchProtocolView(proto){PROTO=proto||"";if(currentProfile!=="all"){currentProfile="all";const sel=document.getElementById("profileSel");if(sel)sel.value="all"}setProtoSeg(PROTO);resetDetailGrouping();clearSectionCache();load()}
document.querySelectorAll("#protoSeg button").forEach(b=>b.addEventListener("click",()=>switchProtocolView(b.dataset.proto)));
// 用户分布图的维度切换(按用户 / 按客户端)。只重画这一张图,不需要重新拉数 ——
// dailyClients 与 daily/dailyModels 一起来自 /api/stats,已经在 D 里了。
function setPieDim(dim){PIEDIM=dim==="client"?"client":"user";document.querySelectorAll("#pieDim button").forEach(b=>b.classList.toggle("on",b.dataset.dim===PIEDIM));if(D)render()}
document.querySelectorAll("#pieDim button").forEach(b=>b.addEventListener("click",()=>setPieDim(b.dataset.dim)));
// 模型请求分布图的维度切换(按模型 / 按方案),与用户分布图的 seg 同款。只重画不重新拉数
// —— profileDailyModels(方案×日期×模型聚合)与 dailyModels 一样已在 /api/stats 返回里。
function setModelDim(dim){
  // 三个维度共用这一张图:按模型 / 按方案 / 按模型×方案。后两者都吃 profileDailyModels
  // —— 最大表的第二次全表扫描,是全页面最贵的一项,所以它们**不进数据总览的载荷**,
  // 切到该维度时才单独拉一次(用户确认的取舍)。
  MDLDIM=(dim==="profile"||dim==="modelProfile")?dim:"model";
  document.querySelectorAll("#modelDim button").forEach(b=>b.classList.toggle("on",b.dataset.dim===MDLDIM));
  if(MDLDIM!=="model"&&D&&!D.profileDailyModels){
    const qs=new URLSearchParams({section:"profile-daily-models"});
    if(PROTO)qs.set("protocol",PROTO);
    fetch("/api/stats?"+qs).then(r=>r.json())
      .then(payload=>{if(D)Object.assign(D,payload);if(MDLDIM!=="model"&&D)render()})
      .catch(e=>{document.getElementById("meta").textContent="Error: "+e.message});
    return;
  }
  if(D)render();
}
document.querySelectorAll("#modelDim button").forEach(b=>b.addEventListener("click",()=>setModelDim(b.dataset.dim)));
const protoLabel=proto=>proto==="anthropic"?"Anthropic":proto==="responses"?"OpenAI":"";
// 侧栏那行「方案: … | 更新时间 …」。每个 section 拉完都刷新一次 —— 它不依赖具体某个面板。
function renderMeta(){
  if(!D)return;
  const curProtoProf=(D.profiles||[]).find(p=>p.suffix===currentProfile);
  const profileLabel=D.profileView||(currentProfile==="all"?"全部方案":"默认方案");
  const protoSuffix=protoLabel(currentProfile!=="all"?((curProtoProf&&curProtoProf.protocol)||""):PROTO);
  const upstreamInfo=D.upstream?(" | 上游: "+D.upstream.replace("https://","").replace("http://","")):"";
  document.getElementById("meta").innerHTML='<span style="color:var(--accent);font-weight:600">方案: '+profileLabel+(protoSuffix?' · '+protoSuffix:'')+'</span>'+upstreamInfo+' &nbsp;|&nbsp; 更新于 '+(function(){const d=new Date();const utc=d.getTime()+d.getTimezoneOffset()*60000;return new Date(utc+8*3600000).toLocaleTimeString("zh-CN")})()+" (北京时间) | 每30秒刷新";
}

// ── 方案中心(独立菜单:数据来自 /api/stats?section=profiles)──
// 只在这个菜单的数据到位后渲染;别的 section 的载荷里没有 profileSummaries,直接跳过。
function renderProfilesPanel(){
  if(!D||!Array.isArray(D.profileSummaries))return;
  const psb=document.getElementById("profileSummaryBody"),profiles=Array.isArray(D.profileSummaries)?D.profileSummaries:[];
  const fmtResume=function(iso){const d=new Date(new Date(iso).getTime()+8*3600000);const p=n=>String(n).padStart(2,'0');const now=new Date(Date.now()+8*3600000);const hm=p(d.getUTCHours())+':'+p(d.getUTCMinutes());if(d.getUTCFullYear()===now.getUTCFullYear()&&d.getUTCMonth()===now.getUTCMonth()&&d.getUTCDate()===now.getUTCDate())return hm;if(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())===86400000)return '明天 '+hm;return (d.getUTCFullYear()===now.getUTCFullYear()?'':d.getUTCFullYear()+'-')+p(d.getUTCMonth()+1)+'-'+p(d.getUTCDate())+' '+hm};
  const rowOf=p=>{const st=p.breakerState||"UNKNOWN";const rl=p.rateLimit;let col,led,stateLabel;if(rl){col='var(--red)';led='err';stateLabel='限额中 '+fmtResume(rl.resumeAt)+'恢复';}else{col=st==="CLOSED"?"var(--green)":st==="HALF_OPEN"?"var(--orange)":"var(--red)";led=st==="CLOSED"?"on":st==="HALF_OPEN"?"warn":"err";stateLabel=st==="CLOSED"?"正常":st==="HALF_OPEN"?"探测中":"熔断"+(p.breakerCooldownRemaining>0?' '+Math.ceil(p.breakerCooldownRemaining/1000)+'s后探测':'');}const current=currentProfile!=="all"&&p.suffix===currentProfile;const gBadge=p.inDefaultGroup?' <span style="color:var(--blue);font-size:10px;font-weight:600">默认组·'+(p.groupOrder+1)+'</span>':'';const rBadge=p.inResponsesGroup?' <span style="color:var(--blue);font-size:10px;font-weight:600">Resp组·'+(p.responsesGroupOrder+1)+'</span>':'';const protoBadge=p.protocol==='responses'?' <span style="color:var(--blue);font-size:10px">OpenAI</span>':'';const bLabel=p.billingType==='coding_plan'?' <span style="color:var(--dim);font-size:10px">CP</span>':p.billingType==='token_plan'?' <span style="color:var(--dim);font-size:10px">TP</span>':'';const pk=(p.peakHours&&p.peakHours.length)?(function(rs){const now=new Date(),cur=((now.getTime()+8*3600000)%86400000)/60000;const tm=function(t){if(!t)return null;const a=t.split(':');return (+a[0])*60+(+a[1])};const inPk=rs.some(function(r){const s=tm(r.start),e=tm(r.end);return s!==null&&e!==null&&s!==e&&(s<e?(cur>=s&&cur<e):(cur>=s||cur<e))});return ' <span style="color:'+(inPk?'var(--orange)':'var(--dim)')+';font-size:10px" title="高峰时段(北京时间) '+rs.map(function(r){return r.start+'-'+r.end}).join(', ')+'">'+(inPk?'高峰中':rs.map(function(r){return r.start+'-'+r.end}).join(','))+'</span>'})(p.peakHours):'';const rt2=(function(){if(p.peakQuotaRate==null&&p.offPeakQuotaRate==null)return'';const pr=p.peakQuotaRate==null?1:p.peakQuotaRate,orr=p.offPeakQuotaRate==null?1:p.offPeakQuotaRate;const nCustom=Object.keys(p.modelQuotaRates||{}).length;if(pr===1&&orr===1&&nCustom===0)return'';var now=new Date(),cur=((now.getTime()+8*3600000)%86400000)/60000;var tm=function(t){if(!t)return null;var a=t.split(':');return (+a[0])*60+(+a[1])};var ip=(p.peakHours||[]).some(function(r){var s=tm(r.start),e=tm(r.end);return s!==null&&e!==null&&s!==e&&(s<e?(cur>=s&&cur<e):(cur>=s||cur<e))});return ' <span style="color:var(--accent);font-size:10px" title="默认配额倍率：高峰 ×'+pr+' / 低谷 ×'+orr+'（当前'+(ip?'高峰':'低谷')+'）'+(nCustom?'；另有 '+nCustom+' 个模型单独定价':'')+'">×'+(ip?pr:orr)+(nCustom?'+'+nCustom:'')+'</span>'})();const restricted=(p.inDefaultGroup&&profiles.filter(x=>x.inDefaultGroup).length>=2)||(p.inResponsesGroup&&profiles.filter(x=>x.inResponsesGroup).length>=2);const entryCode=p.protocol==='responses'?'/v1/responses':'/v1';const defBadge=(p.isDefault||p.isResponsesDefault)?' <span style="color:var(--green);font-size:11px;font-weight:600;vertical-align:middle">默认</span>':'';/* 「使用状态」列:active 由后端算好(进行中请求 或 最近5分钟内完成记账)。使用中且
     有并发时带数字(failover 排查能直接看到哪个方案被压着 N 个);休眠时悬停看最后活跃。 */
const actCell='<td><span class="led '+(p.active?'on':'')+'"></span><span style="color:'+(p.active?'var(--green)':'var(--dim)')+';font-size:12px;white-space:nowrap"'+(p.active?'':' title="最后活跃：'+(p.lastActive?ago(p.lastActive):'从未')+'"')+'>'+(p.active?'使用中'+(p.inflight>0?' · '+p.inflight:''):'休眠中')+'</span></td>';const exportCell='<td class="n" style="white-space:nowrap"><button type="button" class="detail-reset pe-export-btn" data-suffix="'+escH(p.suffix)+'" data-name="'+escH(p.name)+'" title="导出该方案的月度/周度用量报告（HTML + Excel）">导出</button> <button type="button" class="detail-reset pe-analyze-btn" data-suffix="'+escH(p.suffix)+'" data-name="'+escH(p.name)+'" title="看该方案各模型的计费占比与实际倍率（哪个模型消耗高）">分析</button></td>';return'<tr'+(current?' class="profile-current" aria-current="true"':'')+'><td>'+escH(p.name)+defBadge+gBadge+rBadge+protoBadge+bLabel+pk+rt2+(current?' <span class="current-mark">当前</span>':'')+'</td><td>'+(restricted?'<code>'+entryCode+'</code> <span style="color:var(--dim);font-size:10px">仅 '+entryCode+'</span>':'<code>/'+escH(p.suffix)+'</code>'+((p.isDefault||p.isResponsesDefault)?' <span style="color:var(--dim)">/ <code>'+entryCode+'</code></span>':''))+'</td><td style="font-size:12px;color:var(--dim);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escH((p.upstream||'').replace('https://','').replace('http://',''))+'</td><td class="n">'+fmtT(p.todayRequests||0)+'</td><td class="n hl">'+fmtT(p.todayTokens||0)+'</td>'+actCell+'<td><span class="led '+led+'"></span><span style="color:'+col+';font-size:12px">'+stateLabel+'</span></td>'+exportCell+'</tr>'};
  const anthProfiles=profiles.filter(p=>p.protocol!=="responses"),respProfiles=profiles.filter(p=>p.protocol==="responses");
  const protoRow=(label,entry,count)=>'<tr class="proto-row"><td colspan="8">'+label+' · 入口 '+entry+' · '+count+' 个方案</td></tr>';
  let psbHtml="";
  if(anthProfiles.length)psbHtml+=protoRow("Anthropic","/v1",anthProfiles.length)+anthProfiles.map(rowOf).join("");
  if(respProfiles.length)psbHtml+=protoRow("OpenAI","/v1/responses",respProfiles.length)+respProfiles.map(rowOf).join("");
  psb.innerHTML=profiles.length?psbHtml:'<tr><td colspan="8" class="empty">暂无方案</td></tr>';
  const profileLabel=D.profileView||(currentProfile==="all"?"全部方案":"默认方案");
  const curProtoProf=(D.profiles||[]).find(p=>p.suffix===currentProfile);
  setProtoSeg(currentProfile!=="all"?((curProtoProf&&curProtoProf.protocol)||""):PROTO);
  const protoSuffix=protoLabel(currentProfile!=="all"?((curProtoProf&&curProtoProf.protocol)||""):PROTO);
  document.getElementById("profileContext").textContent="当前查看："+profileLabel+(protoSuffix?" · "+protoSuffix:"");
}

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
  // 方案下拉(#profileSel)不在这里重建 —— 它的选项来自 D.profiles,由上面那段代码一次性填好。
  const rebuildFilterSel=(id,entries,allLabel)=>{
    const el=document.getElementById(id);
    const keep=el.value||"all";
    const avail=new Set(entries.map(e=>e[0]));
    const next=avail.has(keep)?keep:"all";
    el.innerHTML='<option value="all">'+allLabel+'</option>'+entries.map(e=>'<option value="'+escH(e[0])+'">'+escH(e[1])+'</option>').join("");
    el.value=next;
    return next;
  };
  USR=rebuildFilterSel("userSel",Object.keys(D.users||{}).map(k=>[k,D.users[k].name]),"全部用户");
  const us=Object.values(D.users),allTokens=us.reduce((s,u)=>s+totalTokens(u),0),tr=us.reduce((s,u)=>s+u.totalRequests,0);
  const tday=todayBJ(),tdd=(D.daily||{})[tday]||{};
  const todayTokens=Object.values(tdd).reduce((s,d)=>s+totalTokens(d),0),tR=Object.values(tdd).reduce((s,d)=>s+d.requests,0);
  document.getElementById("cards").innerHTML=c("今日用量"+CARD_CACHE_TAG,todayTokens,"var(--accent)",1,CARD_CACHE_TIP)+c("今日请求",tR,"var(--blue)",1)+c("总用量"+CARD_CACHE_TAG,allTokens,"var(--green)",1,CARD_CACHE_TIP+"（各用户终身累计）")+c("总请求",tr,"var(--orange)",1)+c("今日错误",(Array.isArray(D.errors)?D.errors:[]).filter(e=>e.time&&bjDateStr(e.time)===tday).length,"var(--red)",1)+egressCard();
  runCountUps(document.getElementById("cards"));
  // overview 只画自己那一份(卡片 + 图表);其余菜单的数据由各自的 section 懒加载后渲染
  if(overviewVisible()){renderCharts()}else{chartsDirty=true}
  renderMeta();
}
function renderCharts(){
  // Charts —— 六图共用全局筛选：P 周期 / MT 指标 / 方案(#profileSel) / USR 用户 / DS+DE 日期范围。
  // 窗口规则:分布类图(用户/客户端分布、模型、两张 24 小时)用 effBounds() —— 日期范围
  // 生效时优先,否则周期窗口;趋势与方案两张全史分桶图只在日期范围生效时收窄。
  // 方案筛选：/api/stats?profile= 已把「按用户/按模型/按周期/24 小时」几路口粮收窄到该方案,
  // 只有 profileDaily / profileDailyModels 是**跨方案** feed(服务端刻意不收窄,供「全部方案」
  // 视图用),所以选了具体方案时,那两张图的方案维度要在这里自己跳过其它方案 —— 否则
  // 「方案请求情况」和「模型请求分布·按方案」会无视方案筛选,六图口径就不一致了。
  const profOnly=currentProfile!=="all"?currentProfile:null;
  const fd0=filteredDaily();
  const eb=effBounds();
  let fd=fd0;
  if(eb.ranged){const rf={};for(const[date,ud]of Object.entries(fd0)){if(date<eb.start||date>eb.end)continue;rf[date]=ud}fd=rf}
  const g=grp(fd,P),uks=Object.keys(D.users);
  const val=s=>MT==="requests"?(s.requests||0):totalTokens(s);
  const trendCut=recentBuckets(Object.keys(g).sort(),eb.ranged);
  const keys=trendCut.keys;
  // 图头 note 恒标口径:趋势图数据源固定是日汇总表,Token 口径恒为总Token(含缓存);
  // 指标切到请求数时 Token 口径无从谈起,不标。
  document.getElementById("trendNote").textContent=chartNote(trendCut.tip,MT==="requests"?"":"总Token(含缓存)");
  if(C.t)C.t.destroy();if(C.p)C.p.destroy();if(C.m)C.m.destroy();if(C.h)C.h.destroy();if(C.hm)C.hm.destroy();if(C.pr)C.pr.destroy();
  C.t=new Chart(document.getElementById("trend"),{type:"bar",data:{labels:keys.map(k=>lbl(P,k)),datasets:uks.map((u,i)=>({label:D.users[u].name,data:keys.map(k=>val(g[k][u]||{})),backgroundColor:COL[i%COL.length]+"cc",borderRadius:3,borderSkipped:false}))},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:trendLegend(),tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)}}},scales:{x:{stacked:true,ticks:{color:"#686863",font:{size:10}},grid:{color:"rgba(24,24,22,.08)"}},y:{stacked:true,ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});
  // 用户分布 / 客户端分布:共用 #pie 这张横向柱状图,顶部 seg 切维度。
  // 两张图都是「按有效窗口累加(默认按日=今天;日期范围生效时按范围)」,只是分组键不同:
  // 用户维度按 user_key 聚合 filteredDaily();客户端维度按 client 聚合 dailyClients。
  // Y 轴标签都取完整可读的名字(用户名 / 客户端友好名)。
  let pieLabels,pieVals;
  if(PIEDIM==="client"){
    // 客户端维度自带 user_key 一层,所以 USR 筛选在这里自己应用;方案筛选由 /api/stats?profile=
    // 在服务端收窄(客户端日表按方案隔离),这里不用再过滤。
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
  // 这张图的 Token 口径随维度变化,标签必须跟着实际口径走,不能一律写 "tokens":
  //   用户维度 → totalTokens(输入+输出+缓存读写,含缓存);
  //   客户端维度(usage_daily_client 没有缓存列) → 只有 输入+输出(不含缓存)。
  // 相邻的「模型请求分布」恒为不含缓存 —— 两图并排数字差出一个缓存量,不标口径必被当成对不上。
  const pieBasis=PIEDIM==="client"?"Token(输入+输出)":"总Token(含缓存)";
  C.p=new Chart(document.getElementById("pie"),{type:"bar",data:{labels:pieLabels,datasets:[{label:MT==="requests"?"请求数":pieBasis,data:pieVals,backgroundColor:pieVals.map((_,i)=>COL[i%COL.length]+"cc"),borderWidth:0,borderRadius:3,borderSkipped:false}]},options:{indexAxis:"y",responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>MT==="requests"?fmtT(ctx.raw)+" 次请求":fmtT(ctx.raw)+" "+pieBasis}}},scales:{x:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}},y:{ticks:{color:"#686863",font:{size:11},autoSkip:false},grid:{display:false}}}}});

  // 模型请求分布：按有效窗口(日期范围优先,否则周期窗口,北京时间)求和，可按指标筛选。
  // seg 切三个维度:
  //   按模型      usage_daily_model[日期][用户][模型],可响应 USR 筛选;
  //   按方案      profileDailyModels[方案][日期][模型],无 user 维度所以不响应 USR
  //               —— 与「方案请求情况」图口径一致;选了具体方案时只留那一根(profOnly);
  //   按模型×方案 同吃 profileDailyModels,把「同模型不同方案」拆成独立柱子,
  //               标签写「模型(方案)」而不是合并成一根(见下面分支内的说明)。
  // 三源都不含缓存 Token。横向柱状图便于读取名称。
  let mLabels,mVal,mBg=null,mFull=null,mTicks=null;
  if(MDLDIM==="profile"){
    const sfxName={};for(const p of (Array.isArray(D.profiles)?D.profiles:[]))sfxName[p.suffix]=p.name;
    const pAgg={};
    for(const [sfx,days] of Object.entries(D.profileDailyModels||{})){
      if(profOnly&&sfx!==profOnly)continue;
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
    // 方案名也可能很长(见 shortAxisLabel):轴上是截断版,悬停看全名
    mFull=mLabels;mLabels=mFull.map(s=>shortAxisLabel(s));
  }else if(MDLDIM==="modelProfile"){
    // 按模型×方案:同一个模型被多个方案服务时**拆成独立柱子**(标签「模型(方案)」),不合并。
    // 这么做的前提是 profileDailyModels 带日期 —— 所以窗口过滤与柱子口径完全一致,和「按方案」
    // 分支同源同算法。该表没有 user 维度,所以这一维度同样不响应 USR(与「按方案」同一取舍)。
    // 配色按**模型**取:同模型的几根柱子共用一色,一眼看出它们是一个模型的不同来源。
    const sfxName={};for(const p of (Array.isArray(D.profiles)?D.profiles:[]))sfxName[p.suffix]=p.name;
    const agg={};
    for(const [sfx,days] of Object.entries(D.profileDailyModels||{})){
      if(profOnly&&sfx!==profOnly)continue;
      for(const [date,models] of Object.entries(days)){
        if(date<eb.start||date>eb.end)continue;
        for(const [m,v] of Object.entries(models||{})){
          const k=m+"\u0000"+sfx;
          if(!agg[k])agg[k]={model:m,sfx,requests:0,tokens:0};
          agg[k].requests+=(v.requests||0);agg[k].tokens+=((v.inputTokens||0)+(v.outputTokens||0));
        }
      }
    }
    const keys=Object.keys(agg);
    const mv=keys.map(k=>MT==="requests"?agg[k].requests:agg[k].tokens);
    const rows=mv.map((_,i)=>i).sort((a,b)=>mv[b]-mv[a]).map(i=>agg[keys[i]]);
    const colOf={};let ci=0;
    // 配色按**模型**取:同模型的几根柱子共用一色
    mBg=rows.map(r=>{if(colOf[r.model]===undefined)colOf[r.model]=COL[ci++%COL.length];return colOf[r.model]+"cc"});
    // 模型名 + 方案名叠起来很长:轴上**排两行**(模型名 / (方案名)),完整名字另给 tooltip
    mFull=rows.map(r=>r.model+"("+(sfxName[r.sfx]||r.sfx)+")");
    mTicks=rows.map(r=>fitAxisLines([r.model,"("+(sfxName[r.sfx]||r.sfx)+")"]));
    mLabels=mFull;
    mVal=rows.map(r=>MT==="requests"?r.requests:r.tokens);
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
  // 画布高度按行数撑开(「按模型×方案」是两行标签,每行要更高的带)—— 必须在建图之前设好,
  // Chart.js 初始化时就按容器高度定画布尺寸,建完再改只会拉伸已算好的布局
  sizeModelCanvas(mLabels.length,MDLDIM==="modelProfile"?2:1);
  // 三个维度的数据源都不含缓存 Token(见上面 760 行附近的注释),标签如实写 ——
  // 与左边的用户分布(默认含缓存)并排时,口径不标会误读成「对不上」。
  C.m=new Chart(document.getElementById("modelChart"),{type:"bar",data:{labels:mLabels,datasets:[{label:MT==="requests"?"请求数":"Token(输入+输出)",data:mVal,backgroundColor:mBg||mVal.map((_,i)=>COL[i%COL.length]+"cc"),borderWidth:0,borderRadius:3,borderSkipped:false}]},options:{indexAxis:"y",responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{title:items=>mFull?mFull[items[0].dataIndex]:items[0].label,label:ctx=>MT==="requests"?fmtT(ctx.raw)+" 次请求":fmtT(ctx.raw)+" Token(输入+输出)"}}},scales:{x:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}},y:{ticks:{color:"#686863",font:{size:11},autoSkip:false,callback:function(v,i){return mTicks?mTicks[i]:this.getLabelForValue(v)}},grid:{display:false}}}}});

  // 两张 24 小时图只做「单日」统计:按日=今天;日期范围生效时要求开始=结束(同一天,只填
  // 今天开始那一头也算)。选了周/月/年、或范围跨多天时不统计 —— 数据留空(坐标轴照常渲染),
  // 图头 note 给出原因。跨天累加同槽位的口径(半小时是"各槽位累计分布"而非"当天真实曲线")
  // 容易误读,所以收窄到单日。服务端取数下界 hourlyChartFloor 与槽位映射 halfHourSlots 不变。
  const hDay=eb.ranged?(eb.start===eb.end?eb.start:null):(P==="day"?winBounds().td:null);
  // 两张 24 小时图的 Token 口径不同(下面 C.h 用 totalTokens 含缓存,C.hm 只有输入+输出),
  // note 各自标明:有数据时说明口径,无数据时说明为什么是空的 —— 不能再共用一句话。
  const hourEmptyNote="仅统计单日：选「按日」，或将开始/结束日期设为同一天";
  document.getElementById("hourNote").textContent=hDay?"Token 含缓存命中":hourEmptyNote;
  document.getElementById("hourModelNote").textContent=!hDay?hourEmptyNote:(MT==="requests"?"":"Token 为输入+输出（不含缓存）");
  const hrs=halfHourLabels();
  const hAgg=Array.from({length:48},()=>({requests:0,tokens:0}));
  for(const [date,hours] of Object.entries(D.hourly||{})){
    if(!hDay||date!==hDay)continue;
    for(const [i,v,w] of halfHourSlots(hours)){
      hAgg[i].requests+=(v.requests||0)*w;hAgg[i].tokens+=totalTokens(v)*w;
    }
  }
  const hReq=hAgg.map(a=>a.requests),hTokens=hAgg.map(a=>a.tokens);
  C.h=new Chart(document.getElementById("hourChart"),{type:"line",data:{labels:hrs,datasets:[{label:"请求数",data:hReq,borderColor:"#2f6e50",backgroundColor:"rgba(47,110,80,.12)",fill:true,tension:.28,pointRadius:0,pointHitRadius:10,pointBackgroundColor:"#2f6e50",pointHoverRadius:4,borderWidth:2,yAxisID:"y"},{label:"总Token(含缓存)",data:hTokens,borderColor:"#181816",backgroundColor:"rgba(24,24,22,.08)",fill:true,tension:.28,pointRadius:0,pointHitRadius:10,pointBackgroundColor:"#181816",pointHoverRadius:4,borderWidth:2,yAxisID:"y1"}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:{labels:{color:"#686863",font:{size:11},usePointStyle:true,pointStyle:"circle"}},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)}}},scales:{x:{ticks:{color:"#686863",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{type:"linear",position:"left",ticks:{color:"#2f6e50"},grid:{color:"rgba(24,24,22,.08)"},title:{display:true,text:"请求数",color:"#2f6e50",font:{size:10}}},y1:{type:"linear",position:"right",ticks:{color:"#181816",callback:v=>fmtTk(v)},grid:{drawOnChartArea:false},title:{display:true,text:"Tokens",color:"#181816",font:{size:10}}}}}});

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
  C.hm=new Chart(document.getElementById("hourModelChart"),{type:"line",data:{labels:hrs,datasets:hmSeries.map((s,i)=>({label:s.label,data:s.data,borderColor:COL[i%COL.length],backgroundColor:COL[i%COL.length]+"22",fill:i===0,tension:.28,pointRadius:0,pointHitRadius:10,pointBackgroundColor:COL[i%COL.length],pointHoverRadius:4,borderWidth:2}))},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:trendLegend(),tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)+(MT==="requests"?" 次请求":" Token(输入+输出)")}}},scales:{x:{ticks:{color:"#686863",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});

  // 方案请求情况：跨方案维度,按周期分桶的堆叠柱。
  // 统计逻辑与 Token 用量趋势完全一致:共用 recentBuckets 那条「最近 30 个桶」的默认窗口,
  // 日期范围生效时才以范围为准(提示文案在上面 pSorted 算出来之后写,那时才知道有没有裁)。
  // 数据源 profileDaily 是**跨方案** feed(服务端不收窄),所以「选了具体方案」这件事在这里
  // 自己落地:profOnly 一过滤,这张图就只剩那一根柱子,与其余五图同一个方案口径。
  const pdBase=D.profileDaily||{};
  const suffixName={};for(const p of (Array.isArray(D.profiles)?D.profiles:[]))suffixName[p.suffix]=p.name;
  const pBuckets={};
  for(const [sfx,days] of Object.entries(pdBase)){
    if(profOnly&&sfx!==profOnly)continue;
    for(const [date,entry] of Object.entries(days)){
      if(eb.ranged&&(date<eb.start||date>eb.end))continue;
      const k=P==="week"?wk(date):P==="month"?date.slice(0,7):P==="year"?date.slice(0,4):date;
      if(!pBuckets[k])pBuckets[k]={};
      if(!pBuckets[k][sfx])pBuckets[k][sfx]={requests:0,tokens:0};
      pBuckets[k][sfx].requests+=(entry.requests||0);pBuckets[k][sfx].tokens+=totalTokens(entry);
    }
  }
  const pSfx=Object.keys(pdBase).filter(s=>!profOnly||s===profOnly).sort();
  const pCut=recentBuckets(Object.keys(pBuckets).sort(),eb.ranged),pSorted=pCut.keys;
  // 注意 pSfx(图例/系列的来源)仍取自 pdBase(按 profOnly 过滤后):某个方案在窗口内没有用量时,
  // 它会是一条全 0 的系列 —— 与趋势图「所有用户都在图例里」的既有口径一致,不额外隐藏
  // (「掉下去了」本身是信息)。只有「画几个桶」被裁,系列的集合不变。
  // 同趋势图:数据源恒为 profileDaily(日汇总表),Token 口径恒为总Token(含缓存)
  document.getElementById("profileNote").textContent=chartNote(pCut.tip,MT==="requests"?"":"总Token(含缓存)");
  C.pr=new Chart(document.getElementById("profileChart"),{type:"bar",data:{labels:pSorted.map(k=>lbl(P,k)),datasets:pSfx.map((sfx,i)=>({label:suffixName[sfx]||sfx,data:pSorted.map(k=>{const s=(pBuckets[k]||{})[sfx];return s?(MT==="requests"?s.requests:s.tokens):0}),backgroundColor:COL[i%COL.length]+"cc",borderRadius:3,borderSkipped:false}))},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:trendLegend(),tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)+(MT==="requests"?" 次请求":" 总Token(含缓存)")}}},scales:{x:{stacked:true,ticks:{color:"#686863",font:{size:10}},grid:{color:"rgba(24,24,22,.08)"}},y:{stacked:true,ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});
}

// ── 用户用量(独立菜单 /api/stats?section=users)──
function renderUsersPanel(){
  if(!D||!D.users)return;
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
  const tday=todayBJ();   // 用户表「今日」列用(曾因这行缺失而整页渲染中断)
  if(!ul.length){ut.innerHTML='<tr><td colspan="'+colSpan+'" class="empty">暂无数据</td></tr>'}else{ut.innerHTML=ul.map(([uk,u],idx)=>{const on=u.lastActive&&Date.now()-new Date(u.lastActive).getTime()<36e5;const effQ=(D.userQuotaEff||{})[uk];const uq=effQ?effQ.limit:((D.userQuotas||{})[uk]||D.profileQuota||0);const td2=(D.daily||{})[tday]||{};const tdu=td2[uk]||{};const used=effQ?effQ.used:ioTokens(tdu);const qPct=uq>0?Math.min(100,Math.round(used/uq*100)):0;const rank='<span class="rank">'+(idx+1)+'.</span>';const qTag=effQ&&effQ.bonus>0?' <span style="font-size:10px;color:var(--green);border:1px solid var(--green);border-radius:3px;padding:0 3px;white-space:nowrap" title="今日临时加量，明日自动失效">+'+fmtTk(effQ.bonus)+'</span>':(effQ&&effQ.resetApplied?' <span style="font-size:10px;color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:0 3px;white-space:nowrap" title="今日用量已重置（统计保留）">已重置</span>':'');const rTag=(effQ&&effQ.rate!=null&&effQ.rate!==1)?' <span style="font-size:10px;color:var(--dim);border:1px solid var(--border);border-radius:3px;padding:0 3px;white-space:nowrap" title="配额倍率 ×'+effQ.rate+'（当前时段）· 实际 '+fmtT(effQ.rawUsed||0)+'，计入配额 '+fmtT(effQ.used||0)+'">×'+effQ.rate+'</span>':'';const qCell=uq>0?'<span style="color:var(--accent);font-size:12px">'+qPct+'%</span> '+quotaBar(qPct)+qTag+rTag:'<span style="color:var(--dim)">-</span>';const quotaCells=multiQuota?qPools.map(p=>quotaMatrixCell(((qm.matrix||{})[uk]||{})[p.key],u.name,p)).join(""):'<td class="n" style="white-space:nowrap">'+qCell+'</td>';return'<tr><td>'+rank+escH(u.name)+'</td><td><span class="led '+(on?'on':'')+'"></span><span style="color:'+(on?'var(--green)':'var(--dim)')+';font-size:12px">'+(on?'在线':'离线')+'</span></td><td class="n stat-col">'+fmtT(u.totalRequests)+'</td><td class="n stat-col">'+fmtT(u.totalInputTokens)+'</td><td class="n stat-col">'+fmtT(u.totalOutputTokens)+'</td><td class="n stat-col">'+fmtT(u.cacheCreationTokens || 0)+'</td><td class="n stat-col">'+fmtT(u.cacheReadTokens || 0)+'</td><td class="n hl stat-col">'+fmtT(ioTokens(u))+'</td><td class="n">'+fmtT(ioTokens(tdu))+'</td>'+quotaCells+'<td style="font-size:12px;color:var(--dim)">'+ago(u.lastActive)+'</td></tr>'}).join("")}

}

// ── 明细记录(独立菜单 /api/stats?section=detail)──
function renderDetailPanel(){
  if(!D||!D.daily)return;
  renderDetail();
}

// ── 错误记录(独立菜单 /api/stats?section=errors)──
// 点击行展开该条错误的完整信息(存储层单条上限 2000 字符);列表单元格保持单行省略,
// 悬浮 title 仍可快速预览。展开状态按错误 id 记忆,翻页/刷新不丢。
const expandedErrors=new Set();
function toggleErrorRow(id){expandedErrors.has(id)?expandedErrors.delete(id):expandedErrors.add(id);renderErrorsPanel()}
function copyErrorText(id){
  const e=(D&&Array.isArray(D.errors)?D.errors:[]).find(x=>x.id===id);if(!e)return;
  const text=(e.error||"")+"\n—— "+(e.user||"-")+" · "+(e.statusCode||"-")+" · "+(e.model||"-")+" · "+(e.path||"-")+" · "+(e.time?fmtBJ(e.time):"-");
  (navigator.clipboard?navigator.clipboard.writeText(text):Promise.reject()).then(()=>toast("已复制完整错误信息")).catch(()=>toast("复制失败"));
}
function renderErrorsPanel(){
  if(!D||!Array.isArray(D.errors))return;

  // Error table with pagination
  const allErrs=Array.isArray(D.errors)?D.errors:[];
  const totalErrPages=Math.max(1,Math.ceil(allErrs.length/ERR_PAGE_SIZE));
  if(errPage>totalErrPages)errPage=totalErrPages;
  const errs=allErrs.slice((errPage-1)*ERR_PAGE_SIZE,errPage*ERR_PAGE_SIZE);
  const et=document.querySelector("#eTable tbody");
  if(!errs.length){et.innerHTML='<tr><td colspan="6" class="empty">暂无错误记录</td></tr>'}else{et.innerHTML=errs.map(e=>{const sc=e.statusCode||"-";const col=sc>=500?"var(--red)":sc>=400?"var(--orange)":"var(--dim)";const eid=e.id!=null?e.id:null;const open=eid!=null&&expandedErrors.has(eid);const rowAttrs=eid!=null?(' data-eid="'+eid+'" onclick="toggleErrorRow('+eid+')" style="cursor:pointer"'):'';
    let html='<tr'+rowAttrs+'><td style="font-size:12px;white-space:nowrap">'+(open?"▾ ":"")+(e.time?fmtBJ(e.time):"-")+'</td><td>'+(e.user||"-")+'</td><td class="n" style="color:'+col+';font-weight:600">'+sc+'</td><td style="font-size:12px;color:var(--blue)">'+(e.model||"-")+'</td><td style="font-size:12px;color:var(--dim);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escH(e.path||"-")+'</td><td style="font-size:12px;color:var(--red);max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+escH(e.error||"")+'">'+escH(e.error||"-")+'</td></tr>';
    if(open){html+='<tr class="err-detail-row"><td colspan="6" style="background:var(--surface-subtle);padding:10px 14px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-size:11px;color:var(--dim)">完整错误信息（'+(e.error||"").length+' 字符 · 上限 2000，超出部分在入库前截断）</span><button onclick="event.stopPropagation();copyErrorText('+eid+')" style="font-size:11px;background:var(--card);color:var(--text);border:1px solid var(--border);padding:2px 10px;border-radius:4px;cursor:pointer">复制</button></div><pre style="margin:0;white-space:pre-wrap;word-break:break-all;font-size:12px;line-height:1.6;color:var(--red);max-height:260px;overflow:auto">'+escH(e.error||"-")+'</pre></td></tr>'}
    return html}).join("")}
  const pg=document.getElementById("errPages");
  pg.innerHTML='<span style="font-size:12px;color:var(--dim)">第 '+errPage+"/"+totalErrPages+' 页 (共 '+allErrs.length+' 条) · 点行展开完整错误 </span> '+(errPage>1?'<button onclick="setErrorPage('+(errPage-1)+')" style="font-size:11px;background:var(--card);color:var(--text);border:1px solid var(--border);padding:2px 10px;border-radius:4px;cursor:pointer">上一页</button> ':'')+(errPage<totalErrPages?'<button onclick="setErrorPage('+(errPage+1)+')" style="font-size:11px;background:var(--card);color:var(--text);border:1px solid var(--border);padding:2px 10px;border-radius:4px;cursor:pointer">下一页</button>':'');
  document.getElementById("errorCount").textContent=allErrs.length>0?'('+allErrs.length+')':'';
  document.getElementById("errorHint").textContent=allErrs.length>0?(allErrs.length+'条错误'):'暂无错误';
}


// 保留这个名字作为「刷新当前菜单」的入口:它以前是「拉全量 /api/stats」,现在
// 一次只拉当前菜单的 section —— 所有既有调用点(清除错误、重置筛选)语义不变。
function load(){refreshCurrent()}
function toggleSec(id){const body=document.getElementById(id+"Body");const icon=document.getElementById(id+"Icon");const open=body.classList.toggle("open");icon.classList.toggle("open",open)}
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.remove("on"));b.classList.add("on");P=b.dataset.p;resetDetailGrouping();rerenderOrReload()}));
document.getElementById("metricSel").addEventListener("change",e=>{MT=e.target.value;render()});
// 方案下拉(#profileSel)走 HTML 上的 onchange="switchProfileView(this.value)" —— 它的切换要
// 换数据源(clearSectionCache + load),不是纯前端重画,所以不在这里再挂一个监听。
document.getElementById("userSel").addEventListener("change",e=>{USR=e.target.value;render()});
function resetChartFilters(){P="day";MT="tokens";USR="all";DS="";DE="";PROTO="";setPieDim("user");setModelDim("model");setProtoSeg("");document.querySelectorAll("#globalTabs .tab").forEach(x=>x.classList.toggle("on",x.dataset.p==="day"));document.getElementById("metricSel").value="tokens";document.getElementById("userSel").value="all";document.getElementById("dateStart").value="";document.getElementById("dateEnd").value="";if(currentProfile!=="all"){currentProfile="all";document.getElementById("profileSel").value="all"}resetDetailGrouping();load()}
(function bindDashNav(){
  const nav=document.getElementById("dashNav");
  if(!nav)return;
  nav.addEventListener("click",e=>{const b=e.target.closest(".nav-btn");if(b&&b.id&&b.id.startsWith("workspace-tab-"))setWorkspaceTab(b.id.replace("workspace-tab-",""),false)});
  nav.addEventListener("keydown",handleWorkspaceTabKeydown);
})();
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
// ── 方案用量报告导出(方案中心「导出」)+ 文件管理 ─────────────────────────────
// 弹窗选 月度/周度 二选一 → 拉 /api/plan-export/periods 填可选周期 → POST 入队后台
// 任务;「文件管理」弹窗轮询 /api/plan-export/jobs 展示任务进度与下载入口,
// 进行中任务在工具栏按钮上点亮小圆点,完成/失败时 toast 提醒一次。
const peState={period:"month",suffix:"",name:"",periods:null,pollTimer:null,trackedJobs:new Set(),page:1,pages:1,total:0,filters:{suffix:"",status:"",period:""},plans:[]};
const PE_STATUS={queued:["排队中","pill-warn"],running:["生成中","pill-warn"],done:["完成","pill-ok"],failed:["失败","pill-bad"]};
function peCsrf(){return(document.cookie.match(/tm_csrf=([^;]+)/)||[])[1]||''}
function peFmtTime(ts){if(!ts)return"-";const d=new Date(ts),p=n=>String(n).padStart(2,"0");return (d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes())}
function pePeriodLabel(j){return j.period==="month"?("月度 · "+j.from.slice(0,7)+"（"+j.from+" ~ "+j.to+"）"):("周度 · "+j.from+" ~ "+j.to)}
// 分页 + 筛选拉任务列表;响应里除当前页 jobs 外还有全量 statuses/plans(见服务端 listJobs)
async function peFetchJobs(){
  const f=peState.filters,q=new URLSearchParams();
  if(f.suffix)q.set("suffix",f.suffix);
  if(f.status)q.set("status",f.status);
  if(f.period)q.set("period",f.period);
  q.set("page",String(peState.page));q.set("pageSize","10");
  const r=await fetch("/api/plan-export/jobs?"+q.toString());
  const d=await r.json();
  return d&&d.jobs?d:{jobs:[],total:0,page:1,pageSize:10,pages:1,statuses:{},plans:[]};
}
function peUpdateDot(statuses){const el=document.getElementById("planExportFilesDot");if(el)el.hidden=!Object.values(statuses||{}).some(s=>s&&(s.status==="queued"||s.status==="running"))}
function peHasFilter(){const f=peState.filters;return !!(f.suffix||f.status||f.period)}
// 方案筛选下拉:每次渲染后重建选项(新方案出现时自动可筛),尽量保留当前选中值
function peFillPlanFilter(plans){
  peState.plans=plans||[];
  const sel=document.getElementById("planFilesFilterPlan");if(!sel)return;
  const cur=sel.value;
  sel.innerHTML='<option value="">全部方案</option>'+peState.plans.map(p=>'<option value="'+escH(p.suffix)+'">'+escH(p.name)+'</option>').join("");
  if(cur&&peState.plans.some(p=>p.suffix===cur))sel.value=cur;
}

function peFillPeriodOptions(){
  const sel=document.getElementById("planExportPeriodSel"),d=peState.periods||{};
  if(peState.period==="month"){
    document.getElementById("planExportPeriodLabel").textContent="选择月份";
    const months=d.months||[];
    sel.innerHTML=months.length?months.map(m=>'<option value="'+escH(m)+'">'+escH(m)+'</option>').join(""):'<option value="">暂无可导出的月份</option>';
    if(d.current&&d.current.month&&months.includes(d.current.month))sel.value=d.current.month;
  }else{
    document.getElementById("planExportPeriodLabel").textContent="选择周（周一 ~ 周日）";
    const weeks=d.weeks||[];
    sel.innerHTML=weeks.length?weeks.map(w=>'<option value="'+escH(w.start)+'">'+escH(w.label)+'</option>').join(""):'<option value="">暂无可导出的周</option>';
    if(d.current&&d.current.week)sel.value=d.current.week;
  }
}
function openPlanExportModal(suffix,name){
  peState.suffix=suffix;peState.name=name;peState.period="month";peState.periods=null;
  document.getElementById("planExportProfile").textContent=name;
  const errEl=document.getElementById("planExportError");
  errEl.hidden=true;errEl.textContent="";
  document.querySelectorAll("#planExportPeriodSeg button").forEach(b=>b.classList.toggle("on",b.dataset.period==="month"));
  document.getElementById("planExportPeriodLabel").textContent="选择月份";
  document.getElementById("planExportPeriodSel").innerHTML='<option value="">加载中…</option>';
  dlgOpen("planExportDlg");
  fetch("/api/plan-export/periods?profile="+encodeURIComponent(suffix)).then(r=>r.json()).then(d=>{
    if(d.error)throw new Error(d.error);
    peState.periods=d;peFillPeriodOptions();
  }).catch(e=>{document.getElementById("planExportPeriodSel").innerHTML='<option value="">加载失败:'+escH(e.message)+'</option>'});
}
document.getElementById("profileSummaryBody").addEventListener("click",e=>{
  const btn=e.target.closest(".pe-export-btn");
  if(btn)openPlanExportModal(btn.dataset.suffix,btn.dataset.name);
  const ana=e.target.closest(".pe-analyze-btn");
  if(ana)openPlanModelModal(ana.dataset.suffix,ana.dataset.name);
});
document.querySelectorAll("#planExportPeriodSeg button").forEach(b=>b.addEventListener("click",()=>{
  peState.period=b.dataset.period;
  document.querySelectorAll("#planExportPeriodSeg button").forEach(x=>x.classList.toggle("on",x===b));
  peFillPeriodOptions();
}));
document.getElementById("planExportSubmit").addEventListener("click",async()=>{
  const sel=document.getElementById("planExportPeriodSel"),errEl=document.getElementById("planExportError"),btn=document.getElementById("planExportSubmit");
  if(!sel.value){errEl.textContent="请先选择"+(peState.period==="month"?"月份":"要导出的周");errEl.hidden=false;return}
  btn.disabled=true;errEl.hidden=true;
  try{
    const r=await fetch("/api/plan-export",{method:"POST",headers:{"Content-Type":"application/json","x-csrf-token":peCsrf()},body:JSON.stringify({profile:peState.suffix,period:peState.period,value:sel.value})});
    const d=await r.json();
    if(!r.ok||d.error)throw new Error(d.error||("HTTP "+r.status));
    dlgClose("planExportDlg");
    toast("已开始导出「"+peState.name+"」报告，完成后可在「文件管理」下载");
    peState.trackedJobs.add(d.job.id);
    peState.page=1;peRefreshJobs(); // 新任务排在最前,若文件管理开着立即能看到
    peStartPolling();
  }catch(e){
    errEl.textContent="导出失败："+e.message;errEl.hidden=false;
  }finally{btn.disabled=false}
});

function peRenderJobs(d){
  peState.page=d.page||1;peState.pages=d.pages||1;peState.total=d.total||0;
  if(d.plans)peFillPlanFilter(d.plans);
  const body=document.getElementById("planFilesBody"),pager=document.getElementById("planFilesPager");
  if(!d.jobs.length){
    body.innerHTML='<div class="lb-msg" style="padding:16px">'+(peHasFilter()?"没有符合条件的导出记录":"还没有导出记录 —— 到「方案中心」每行右侧的「导出」按钮创建")+'</div>';
    pager.hidden=true;return;
  }
  body.innerHTML='<div class="pe-jobs">'+d.jobs.map(j=>{
    const st=PE_STATUS[j.status]||[j.status,""];
    const files=(j.files||[]).map(f=>{
      const url="/api/plan-export/file?job="+encodeURIComponent(j.id)+"&kind="+encodeURIComponent(f.kind);
      const view=f.kind==="html"?'<a class="pager-btn" href="'+url+'&disposition=inline" target="_blank" rel="noopener">查看</a>':"";
      return '<a class="pager-btn" href="'+url+'" download>下载 '+f.kind.toUpperCase()+'</a>'+view;
    }).join("");
    const err=j.status==="failed"?'<div class="pe-job-err">'+escH(j.error||"未知错误")+'</div>':"";
    const size=(j.files&&j.files.length)?j.files.map(f=>escH(f.name)+"（"+fmtT(f.size)+" 字节）").join(" · "):"";
    return '<div class="pe-job"><div class="pe-job-main"><span class="pill '+st[1]+'">'+st[0]+'</span><strong>'+escH(j.profileName)+'</strong><span class="pe-job-period">'+escH(pePeriodLabel(j))+'</span></div>'
      +'<div class="pe-job-meta">创建于 '+peFmtTime(j.createdAt)+(j.finishedAt?' · 完成 '+peFmtTime(j.finishedAt):"")+(size?" · "+size:"")+'</div>'
      +(files?'<div class="pe-job-files">'+files+'</div>':"")+err+'</div>';
  }).join("")+'</div>';
  // 分页:信息常显;只有一页时隐藏翻页按钮(整条 pager 留着,免得列表高度跳动)
  pager.hidden=false;
  document.getElementById("planFilesPageInfo").textContent="第 "+peState.page+" / "+peState.pages+" 页 · 共 "+fmtT(peState.total)+" 条";
  document.getElementById("planFilesPrev").disabled=peState.page<=1;
  document.getElementById("planFilesNext").disabled=peState.page>=peState.pages;
}
function peRefreshJobs(){
  peFetchJobs().then(d=>{peUpdateDot(d.statuses);peRenderJobs(d)}).catch(()=>{document.getElementById("planFilesBody").innerHTML='<div class="lb-msg" style="padding:16px">加载失败，请稍后重试</div>'});
}
function peStartPolling(){
  if(peState.pollTimer)return;
  peState.pollTimer=setInterval(()=>{
    if(document.hidden)return;
    const filesOpen=document.getElementById("planFilesDlg").classList.contains("open");
    peFetchJobs().then(d=>{
      peUpdateDot(d.statuses);
      if(filesOpen)peRenderJobs(d);
      // toast 跟踪走全量 statuses(与筛选/分页无关,别的页完成的任务也能提醒到)
      for(const id of [...peState.trackedJobs]){
        const s=(d.statuses||{})[id];
        if(s&&(s.status==="done"||s.status==="failed")){
          peState.trackedJobs.delete(id);
          toast(s.status==="done"?("「"+s.name+"」报告导出完成，可在「文件管理」下载"):("「"+s.name+"」报告导出失败："+(s.err||"未知错误")));
        }
      }
      if(!peState.trackedJobs.size&&!filesOpen)peStopPolling();
    }).catch(()=>{});
  },2500);
}
function peStopPolling(){if(peState.pollTimer){clearInterval(peState.pollTimer);peState.pollTimer=null}}
document.getElementById("planExportFilesBtn").addEventListener("click",()=>{dlgOpen("planFilesDlg");peRefreshJobs();peStartPolling()});
// 筛选:任一条件变化都回到第 1 页再拉
for(const [fid,key] of [["planFilesFilterPlan","suffix"],["planFilesFilterStatus","status"],["planFilesFilterPeriod","period"]]){
  document.getElementById(fid).addEventListener("change",()=>{
    peState.filters[key]=document.getElementById(fid).value;
    peState.page=1;peRefreshJobs();
  });
}
document.getElementById("planFilesPrev").addEventListener("click",()=>{if(peState.page>1){peState.page--;peRefreshJobs()}});
document.getElementById("planFilesNext").addEventListener("click",()=>{if(peState.page<peState.pages){peState.page++;peRefreshJobs()}});
// 页面加载时同步一次历史任务:有进行中的就接管跟踪(页面刷新不丢完成提醒),顺带点亮小圆点
peFetchJobs().then(d=>{
  peUpdateDot(d.statuses);
  peFillPlanFilter(d.plans);
  const st=d.statuses||{};
  const act=Object.values(st).filter(s=>s.status==="queued"||s.status==="running");
  if(act.length){Object.keys(st).forEach(id=>{if(st[id].status==="queued"||st[id].status==="running")peState.trackedJobs.add(id)});peStartPolling()}
}).catch(()=>{});

// ── 方案模型计费归因分析(「分析」弹窗) ────────────────────────────────────────
// 数据端点 /api/plan-model-analysis 只读同步;展示口径与导出报告的归因段一致:
// 计费占比 = 模型计权 ÷ 方案总计权(落表时已折算倍率,改价不影响历史);
// 实际倍率 = 计权 ÷ 原始 Token,跨高峰边界或期间调价会落在两档之间。
const pmState={suffix:"",name:"",window:"30d"};
const pmWindowLabel={ "7d":"近 7 天","30d":"近 30 天","month":"本月" };
function pmFmtTk(n){
  n=Number(n)||0;
  if(Math.abs(n)>=1e9)return (n/1e9).toFixed(2)+" B";
  if(Math.abs(n)>=1e6)return (n/1e6).toFixed(2)+" M";
  if(Math.abs(n)>=1e4)return (n/1e3).toFixed(1)+" K";
  return n.toLocaleString("zh-CN");
}
function pmPct(v){return (v*100).toFixed(1)+"%"}
function pmRate(v){return v==null?"-":"×"+(Math.round(v*100)/100).toFixed(2)}
function pmMaxShare(rows){return Math.max(0.0001,...rows.map(r=>r.billShare))}
function pmRender(d){
  const ma=d.modelAnalysis||{rows:[]};
  const s=d.summary||{};
  const rows=ma.rows||[];
  const maxShare=pmMaxShare(rows);
  let html="";
  if(!rows.length){
    html='<div class="lb-msg" style="padding:16px">'+escH(d.windowLabel||"")+"该方案没有模型明细可归因"+(s.weighted>0?"（有计权用量但明细已超出 400 天保留期）":"（该时段无用量）")+'</div>';
  }else{
    const top=ma.topModel||rows[0];
    html='<div class="pm-summary">计费占比最高的是 <b>'+escH(top.model)+'</b>，占'+escH(d.windowLabel||"该时段")+'配额消耗的 <b>'+escH(pmPct(top.billShare))+'</b>'
      +(top.effRate!=null?"（实际倍率 "+escH(pmRate(top.effRate))+"）":"")
      +(rows.length>=2?" · 前两名合计 "+escH(pmPct(ma.top2Share)):"")
      +(ma.attribution<0.999?' <span style="color:var(--orange)">注意：模型明细仅覆盖 '+escH(pmPct(ma.attribution))+' 的计权消耗（超出 400 天保留期部分无法归因）</span>':"")
      +'</div>';
    html+='<div class="pm-cards">'
      +'<div class="pm-card"><div class="l">计权用量（配额口径）</div><div class="v" style="color:var(--accent)">'+pmFmtTk(s.weighted||0)+'</div></div>'
      +'<div class="pm-card"><div class="l">实际 Token</div><div class="v">'+pmFmtTk(s.total||0)+'</div></div>'
      +'<div class="pm-card"><div class="l">请求次数</div><div class="v">'+fmtT(s.requests||0)+'</div></div>'
      +'<div class="pm-card"><div class="l">活跃用户</div><div class="v">'+fmtT(s.activeUsers||0)+'</div></div>'
      +'</div>';
    html+='<div class="tbl-scroll"><table class="pm-table"><thead><tr><th>模型</th><th class="n">计权Token</th><th class="n">计费占比</th><th style="min-width:110px">占比</th><th class="n">累计占比</th><th class="n">实际倍率</th><th class="n">请求</th><th class="n">实际Token</th></tr></thead><tbody>';
    for(const r of rows){
      const w=pmFmtTk(r.weighted);
      html+='<tr><td style="color:var(--blue)">'+escH(r.model)+'</td>'
        +'<td class="n" title="'+fmtT(r.weighted)+'">'+w+'</td>'
        +'<td class="n hl">'+pmPct(r.billShare)+'</td>'
        +'<td class="bar-cell"><div class="bar"><i style="width:'+Math.max(r.billShare>0?1.5:0,(r.billShare/maxShare)*100).toFixed(1)+'%"></i></div></td>'
        +'<td class="n">'+pmPct(r.cumShare)+'</td>'
        +'<td class="n">'+pmRate(r.effRate)+'</td>'
        +'<td class="n">'+fmtT(r.requests)+'</td>'
        +'<td class="n" title="'+fmtT(r.raw)+'">'+pmFmtTk(r.raw)+'</td>'
        +'</tr>';
    }
    html+='</tbody></table></div>';
    html+='<div class="pm-note">「计费占比」按计权 Token（配额口径）计算——落表时已按当时的时段与该模型倍率折算，之后调整倍率不影响历史归因；「实际倍率」= 计权 ÷ 原始 Token，跨高峰边界或期间调整过倍率时会落在两档之间。想看每天的明细或发给同事，用该方案行的「导出」按钮，报告里有同口径的归因表。</div>';
  }
  document.getElementById("planModelBody").innerHTML=html;
}
function pmLoad(){
  const errEl=document.getElementById("planModelError");
  errEl.hidden=true;
  document.getElementById("planModelBody").innerHTML='<div class="lb-msg" style="padding:16px">加载中…</div>';
  fetch("/api/plan-model-analysis?profile="+encodeURIComponent(pmState.suffix)+"&window="+encodeURIComponent(pmState.window))
    .then(r=>r.json()).then(d=>{
      if(d.error)throw new Error(d.error);
      pmRender(d);
    })
    .catch(e=>{errEl.textContent="加载失败："+e.message;errEl.hidden=false;document.getElementById("planModelBody").innerHTML=""});
}
function openPlanModelModal(suffix,name){
  pmState.suffix=suffix;pmState.name=name;pmState.window="30d";
  document.getElementById("planModelProfile").textContent=name+(suffix?"（/"+suffix+"）":"");
  document.querySelectorAll("#planModelWindowSeg button").forEach(x=>x.classList.toggle("on",x.dataset.window==="30d"));
  document.getElementById("planModelError").hidden=true;
  dlgOpen("planModelDlg");
  pmLoad();
}
document.querySelectorAll("#planModelWindowSeg button").forEach(b=>b.addEventListener("click",()=>{
  pmState.window=b.dataset.window;
  document.querySelectorAll("#planModelWindowSeg button").forEach(x=>x.classList.toggle("on",x===b));
  pmLoad();
}));

// 轮询治理:页面隐藏/最小化时暂停 30s 自动刷新(后台标签挂一天不再持续打满出网),
// 切回可见时立即刷一次。
function startAutoRefresh(){
  if(refreshTimer)clearInterval(refreshTimer);
  refreshTimer=setInterval(()=>{if(autoRefresh&&!document.hidden)refreshCurrent()},30000);
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&autoRefresh)refreshCurrent()});
document.getElementById("autoRefreshBtn").addEventListener("click",()=>{autoRefresh=!autoRefresh;const btn=document.getElementById("autoRefreshBtn");btn.textContent="自动刷新: "+(autoRefresh?"开":"关");btn.className=autoRefresh?"ar-on":"ar-off"});
window.addEventListener("resize",scheduleChartResize);
setWorkspaceTab('overview',false);ensureSection('overview');startAutoRefresh();
