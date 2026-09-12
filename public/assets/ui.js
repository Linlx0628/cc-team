// public/assets/ui.js —— 全部页面共享的客户端基础：UI_HELPERS(紧凑数字/配额条/计数上色) + TOAST_JS
// (toast 通知与 saved=1 回显)。在页面自身脚本之前加载，无任何按请求数据，可长期强缓存。
function formatCompact(n){if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'k';return Number(n).toLocaleString('zh-CN')}
function totalTokens(row){row=row||{};return(row.inputTokens??row.totalInputTokens??row.input??0)+(row.outputTokens??row.totalOutputTokens??row.output??0)+(row.cacheCreationTokens??row.cacheWrite??0)+(row.cacheReadTokens??row.cacheRead??0)}
function ioTokens(row){row=row||{};return(row.inputTokens??row.totalInputTokens??row.input??0)+(row.outputTokens??row.totalOutputTokens??row.output??0)}
function quotaBar(pct){var value=Math.max(0,Math.min(100,Number(pct)||0));var cls=value>90?'crit':value>70?'warn':'';return '<span class="quota-progress '+cls+'" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+value+'"><i style="width:'+value+'%"></i></span>'}
function runCountUps(root){(root||document).querySelectorAll('[data-cu]').forEach(function(el){var raw=Number(el.dataset.cu)||0;el.textContent=el.hasAttribute('data-cu-k')?formatCompact(raw):raw.toLocaleString('zh-CN');el.dataset.cur=String(raw)})}
function hpBar(pct){return quotaBar(pct)}

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
