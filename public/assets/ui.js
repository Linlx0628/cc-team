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
