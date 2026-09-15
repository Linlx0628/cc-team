// public/assets/ui.js —— 全部页面共享的客户端基础：UI_HELPERS(紧凑数字/配额条/计数上色) + TOAST_JS
// (toast 通知与 saved=1 回显)。在页面自身脚本之前加载，无任何按请求数据，可长期强缓存。
function formatCompact(n){if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'k';return Number(n).toLocaleString('zh-CN')}
function totalTokens(row){row=row||{};return(row.inputTokens??row.totalInputTokens??row.input??0)+(row.outputTokens??row.totalOutputTokens??row.output??0)+(row.cacheCreationTokens??row.cacheWrite??0)+(row.cacheReadTokens??row.cacheRead??0)}
function ioTokens(row){row=row||{};return(row.inputTokens??row.totalInputTokens??row.input??0)+(row.outputTokens??row.totalOutputTokens??row.output??0)}
function quotaBar(pct){var value=Math.max(0,Math.min(100,Number(pct)||0));var cls=value>90?'crit':value>70?'warn':'';return '<span class="quota-progress '+cls+'" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+value+'"><i style="width:'+value+'%"></i></span>'}
function runCountUps(root){(root||document).querySelectorAll('[data-cu]').forEach(function(el){var raw=Number(el.dataset.cu)||0;el.textContent=el.hasAttribute('data-cu-k')?formatCompact(raw):raw.toLocaleString('zh-CN');el.dataset.cur=String(raw)})}
function hpBar(pct){return quotaBar(pct)}

// ── 剪贴板 ───────────────────────────────────────────────────────────────────
// 明文 http 访问下 navigator.clipboard 根本不存在（本应用常这样就进来了），所以不能
// 只写一行 writeText 了事。三级兜底：clipboard API → 隐藏 textarea + execCommand →
// 交给调用方（把内容摆给用户手动复制）。返回是否写成功，按钮有的话顺带做"已复制"反馈。
function execCopyViaTextarea(text){
  var ta=document.createElement('textarea');
  ta.value=text;ta.setAttribute('readonly','');
  // 不能 display:none —— 选不中的元素复制出来是空的。
  ta.style.position='fixed';ta.style.top='-1000px';ta.style.left='0';ta.style.opacity='0';
  document.body.appendChild(ta);
  var ok=false;
  try{ta.select();ta.setSelectionRange(0,ta.value.length);ok=document.execCommand('copy')}catch(e){ok=false}
  ta.remove();
  return ok;
}
function copyText(text,btn){
  const flash=function(ok){
    if(ok&&btn){const old=btn.textContent;btn.textContent='已复制';setTimeout(function(){btn.textContent=old},1500)}
    return ok;
  };
  if(navigator.clipboard&&navigator.clipboard.writeText){
    return navigator.clipboard.writeText(text).then(function(){return flash(true)},function(){return flash(execCopyViaTextarea(text))});
  }
  return Promise.resolve(flash(execCopyViaTextarea(text)));
}

function toast(msg){
  let wrap=document.getElementById('toastWrap');
  if(!wrap){wrap=document.createElement('div');wrap.id='toastWrap';document.body.appendChild(wrap)}
  const t=document.createElement('div');t.className='toast';t.textContent=msg;wrap.appendChild(t);
  requestAnimationFrame(function(){requestAnimationFrame(function(){t.classList.add('show')})});
  setTimeout(function(){t.classList.remove('show');setTimeout(function(){t.remove()},300)},2200);
}
function toastThen(msg,fn){try{sessionStorage.setItem('tm_toast',msg)}catch(e){}if(fn)fn()}
(function(){
  try{
    const pending=sessionStorage.getItem('tm_toast');
    if(pending){sessionStorage.removeItem('tm_toast');toast(pending)}
  }catch(e){}
  if(/[?&]saved=1/.test(location.search)){
    toast('设置已保存');
    try{history.replaceState(null,'',location.pathname)}catch(e){}
  }
})();

// ── 24 小时图的 48 个半小时槽位 ────────────────────────────────────────────────
// 存储键 "HH:MM"(分钟恒为 00/30)与图上的 x 轴标签是同一个字符串,所以前端不需要任何格式转换。
// 两个页面共用这一份实现:槽位映射写错能静默错掉一整天的数据,只应有一个地方把守卫写对。
function halfHourSlot(key){
  // "HH:MM" → 0..47;旧整点键 "HH" 与任何非法键一律 -1(丢弃)。
  // 旧键必须被**拒绝**而不是当编号用:Number("13") 会落进槽位 13(即 06:30),把一整天的数据静默错位。
  // 形状查得严(length 恰为 5 且第 2 位是 ":"):"" 会被 Number("") 算成 0,split(":") 也会把 "13" 当新键收下。
  if(typeof key!=="string"||key.length!==5||key.charCodeAt(2)!==58)return -1;
  const hh=key.slice(0,2),mm=key.slice(3,5);
  if(!/^\d\d$/.test(hh)||!/^\d\d$/.test(mm))return -1;
  const h=Number(hh),m=Number(mm);
  if(h>23||m>59)return -1;
  // 分钟只向下取整,不要求恰为 00/30:万一写侧忘了取整,数据也只会落进正确的半小时格,
  // 而不是整段从图上消失。读侧对分钟宽容、对形状严格。
  return h*2+(m>=30?1:0);
}
function halfHourLabels(){const out=[];for(let i=0;i<48;i++)out.push(String(i>>1).padStart(2,"0")+":"+(i&1?"30":"00"));return out}
// 一天的 {hour: value} → [[槽位, 原始值, 权重], ...]。权重 1 = 新格式(精确),0.5 = 旧格式阶梯兜底,
// 调用方按权重缩放自己需要的字段(各图的值形状不同,不在这里强行统一)。
// 兜底条件:"HH:00" 与 "HH:30" **都不存在**时才展开 "HH",把这一小时的总量对半落进两格 ——
// 呈现为平阶而非锯齿,日内形状与总量都保真。只要有一格已被新数据占着就不展开,
// 否则那一格会被叠加一次、当天总量凭空变大。宁可少算,不可重复算。
// 判据逐 (日期,小时) 看而不是整天一刀切:按天会让重启当天重启点之前的**完整小时**全部消失。
function halfHourSlots(hours){
  const out=[];
  if(!hours||typeof hours!=="object")return out;
  const seen=new Set();
  for(const k of Object.keys(hours)){const s=halfHourSlot(k);if(s>=0)seen.add(s)}
  for(const k of Object.keys(hours)){
    const v=hours[k];
    if(!v||typeof v!=="object")continue;
    const s=halfHourSlot(k);
    if(s>=0){out.push([s,v,1]);continue}
    // 旧的整点键。1 位也收(与 hourIsPeak 的宽容度一致),尽管写入端一直是补零的两位。
    if(!/^\d{1,2}$/.test(k))continue;
    const h=Number(k);
    if(h>23)continue;
    const a=h*2,b=a+1;
    if(seen.has(a)||seen.has(b))continue;   // 该小时已有新数据落格,展开就等于叠加
    out.push([a,v,0.5],[b,v,0.5]);
  }
  return out;
}

// ── 客户端友好名 ─────────────────────────────────────────────────────────────
// 服务端存的是客户端自己发的原文 product token(usage_daily_client.client),这里只做展示映射。
// 未知的**原样显示**而不是归成「其他」:以后还会有没见过的客户端,把它们藏进一个桶里
// 就再也发现不了。写死的白名单只增不减,新增客户端时在下面补一行即可。
const CLIENT_LABELS={
  'unknown':'未识别',
  'claude-cli':'Claude Code',
  'codex_cli_rs':'Codex CLI',
  'codex-tui':'Codex TUI',
  'codex_vscode':'Codex VSCode',
  'codex_exec':'Codex Exec',
  'codex_sdk_ts':'Codex SDK',
  'codex-app-server':'Codex App',
};
function clientLabel(client){
  const key=String(client==null?'':client);
  if(CLIENT_LABELS[key])return CLIENT_LABELS[key];
  return key||'未识别';
}
// 方案组调度：把星期下标数组渲染成一个紧凑标签（"周一~周五"）。
// **纯展示**，没有判定语义 —— 哪条规则命中由服务端决定，这里只是把紧挨着的那 7 个
// 复选框回显一遍，所以它算错也只是标签难看，不会让人误判路由。
const RULE_DAY_NAMES=['周日','周一','周二','周三','周四','周五','周六'];
const RULE_DAY_ORDER=[1,2,3,4,5,6,0];   // 展示顺序按周一开头，0=周日放最后
function describeRuleDays(days){
  if(!Array.isArray(days)||days.length===0)return '每天';
  // 先映射成「周一开头」的下标，再在线性下标上折叠连续段 —— 比在星期值上判相邻简单得多。
  const idx=[];
  for(let i=0;i<RULE_DAY_ORDER.length;i++)if(days.indexOf(RULE_DAY_ORDER[i])>=0)idx.push(i);
  if(idx.length===0||idx.length===7)return '每天';
  const out=[];
  let i=0;
  while(i<idx.length){
    let j=i;
    while(j+1<idx.length&&idx[j+1]===idx[j]+1)j++;
    if(j-i>=2)out.push(RULE_DAY_NAMES[RULE_DAY_ORDER[idx[i]]]+'~'+RULE_DAY_NAMES[RULE_DAY_ORDER[idx[j]]]);
    else out.push(idx.slice(i,j+1).map(function(k){return RULE_DAY_NAMES[RULE_DAY_ORDER[k]]}).join('、'));
    i=j+1;
  }
  return out.join('、');
}
