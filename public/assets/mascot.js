// mascot.js —— 我的用量页右下角的吉祥物挂件(视线跟随鼠标、点击有表情、可换角色)。
// 原生 JS 改写自开源组件 page-mascot:https://github.com/nilbuild/page-mascot
// (MIT License, Copyright (c) Kamran Ahmed),精灵图为 3x3 网格的两张 webp,
// 静态托管在本目录(角色名-directions.webp / 角色名-reactions.webp)。
// 本文件自包含:不依赖 ui.js/my-usage.js,样式全部内联,找不到 #mascotDock 就整体不挂。
(function () {
  'use strict';

  // 可选角色(与 public/assets/ 下的精灵图文件一一对应)。默认 bear。
  var CHARS = [
    ['bear', '小熊'], ['bunny', '兔子'], ['cat', '小猫'], ['otter', '水獭'],
    ['panda', '熊猫'], ['redpanda', '小浣熊'], ['sheep', '小绵羊'],
    ['crt', '克特'], ['toaster', '烤面包机'], ['cube', '小方块'],
  ];
  var STORE_KEY = 'mascotChar';

  // 3x3 网格的行优先顺序(素材图就是按这个排的),center 下标 4。
  var DIRECTIONS = ['up-left', 'up', 'up-right', 'left', 'center', 'right', 'down-left', 'down', 'down-right'];
  // 表情层同款顺序:blink/heart/sparkle/surprised/wink/bashful/sleepy/dizzy/delighted。
  var REACTIONS = ['blink', 'heart', 'sparkle', 'surprised', 'wink', 'bashful', 'sleepy', 'dizzy', 'delighted'];

  // —— 以下常量与 page-mascot 原版一致 ——
  // 从右开始顺时针,匹配 y 向下的 atan2。
  var CLOCKWISE = ['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right'];
  var SECTOR = (Math.PI * 2) / CLOCKWISE.length;
  var HYSTERESIS = 0.12;          // 扇区滞回:指针略出界不切向,避免临界抖动
  var DEAD_ZONE = 70;             // 指针离得太近就回正中
  var PAYOFF_IDX = [1, 2, 8];     // heart/sparkle/delighted 在 REACTIONS 里的下标
  var BOOP_PAYOFF = 120;
  var BOOP_END = 560;
  var SQUASH_MS = 420;
  var DIZZY_AFTER = 4;            // 1600ms 内连戳 4 次会晕
  var DIZZY_WINDOW = 1600;
  var DIZZY_END = 1100;
  // 原版注释:关键帧各自带 easing、效果本体 linear —— easing 放在效果上会把每个
  // offset 重新插值,整段回弹会被前置。
  var SQUASH = [
    { transform: 'scale(1, 1)', easing: 'ease-in' },
    { transform: 'scale(1.10, 0.86)', offset: 0.18, easing: 'ease-out' },
    { transform: 'scale(0.95, 1.08)', offset: 0.45, easing: 'ease-in-out' },
    { transform: 'scale(1.03, 0.97)', offset: 0.72, easing: 'ease-in-out' },
    { transform: 'scale(1, 1)' },
  ];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // background-size 300% 让每格正好落在 0/50/100% 的步进上。
  function cellPos(index) {
    return (index % 3) * 50 + '% ' + Math.floor(index / 3) * 50 + '%';
  }
  function wrapAngle(a) {
    return Math.atan2(Math.sin(a), Math.cos(a));
  }
  function sheetUrl(name, kind) {
    return '/assets/' + name + '-' + kind + '.webp';
  }

  function init(dock) {
    if (!dock) return;
    var picked = 'bear';
    try {
      var saved = window.localStorage.getItem(STORE_KEY);
      for (var i = 0; i < CHARS.length; i++) if (CHARS[i][0] === saved) picked = saved;
    } catch (e) { /* 隐私模式等场景 localStorage 不可用,回落默认角色 */ }

    var layerCss = 'position:absolute;inset:0;background-size:300% 300%;background-repeat:no-repeat;';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', '摸摸' + charLabel(picked));
    btn.style.cssText = 'position:relative;display:block;width:140px;height:140px;padding:0;border:0;'
      + 'background:transparent;appearance:none;cursor:pointer;user-select:none;-webkit-user-select:none;';
    btn.innerHTML = '<span style="position:relative;display:block;width:100%;height:100%;transform-origin:50% 78%">'
      + '<span data-layer="dir" style="' + layerCss + '"></span>'
      + '<span data-layer="re" style="' + layerCss + 'opacity:0"></span>'
      + '</span>';
    var squashEl = btn.firstChild;
    var dirLayer = btn.querySelector('[data-layer="dir"]');
    var reLayer = btn.querySelector('[data-layer="re"]');

    // 换角色入口:小字按钮,与浮层一起叠在吉祥物上方。
    var swap = document.createElement('button');
    swap.type = 'button';
    swap.textContent = '换角色';
    swap.style.cssText = 'margin-top:2px;align-self:flex-end;font-size:11px;color:var(--dim,#8888);cursor:pointer;'
      + 'background:transparent;border:0;padding:2px 6px;';

    var pop = document.createElement('div');
    // 开合用内联 display 控制:hidden 属性会被内联 display:grid 压过,弹层会常开。
    pop.setAttribute('role', 'menu');
    pop.style.cssText = 'display:none;position:absolute;right:0;bottom:178px;background:var(--bg,#fff);color:var(--text,#333);'
      + 'border:1px solid var(--border-strong,#ccc);border-radius:10px;box-shadow:0 10px 28px rgba(24,24,22,.18);'
      + 'padding:6px;grid-template-columns:1fr 1fr;gap:2px;z-index:2;';
    pop.innerHTML = CHARS.map(function (c) {
      var on = c[0] === picked;
      return '<button type="button" role="menuitem" data-char="' + esc(c[0]) + '" style="font-size:12px;text-align:left;'
        + 'padding:4px 10px;border-radius:7px;border:0;background:' + (on ? 'var(--accent,#2f6e50)' : 'transparent') + ';'
        + 'color:' + (on ? '#fff' : 'inherit') + ';cursor:pointer;">' + esc(c[1]) + '</button>';
    }).join('');

    dock.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:40;display:flex;flex-direction:column;align-items:flex-end;';
    dock.appendChild(pop);
    dock.appendChild(btn);
    dock.appendChild(swap);

    function charLabel(name) {
      for (var i = 0; i < CHARS.length; i++) if (CHARS[i][0] === name) return CHARS[i][1];
      return '吉祥物';
    }
    // 角色切换只改两张 background-image:没被选中的精灵图永远不会被下载。
    function applyChar(name) {
      dirLayer.style.backgroundImage = 'url(' + sheetUrl(name, 'directions') + ')';
      reLayer.style.backgroundImage = 'url(' + sheetUrl(name, 'reactions') + ')';
      btn.setAttribute('aria-label', '摸摸' + charLabel(name));
    }
    applyChar(picked);

    // —— 视线跟随(仅精确指针设备;触屏没有 hover,直接跳过,点击表情不受影响) ——
    var sector = -1;
    var pointer = null;
    var dirIndex = 4; // center
    function paintDir() {
      // 有表情在播时方向层是隐藏的,等表情结束再涂也能落到正确一格。
      dirLayer.style.backgroundPosition = cellPos(dirIndex);
    }
    function aim() {
      if (!pointer) return;
      var box = btn.getBoundingClientRect();
      var dx = pointer.x - (box.left + box.width / 2);
      var dy = pointer.y - (box.top + box.height / 2);
      if (Math.hypot(dx, dy) < DEAD_ZONE) {
        sector = -1;
        dirIndex = 4;
        paintDir();
        return;
      }
      var angle = Math.atan2(dy, dx);
      if (sector !== -1 && Math.abs(wrapAngle(angle - sector * SECTOR)) < SECTOR / 2 + HYSTERESIS) return;
      sector = (Math.round(angle / SECTOR) + CLOCKWISE.length) % CLOCKWISE.length;
      dirIndex = DIRECTIONS.indexOf(CLOCKWISE[sector]);
      paintDir();
    }
    function onPointerMove(e) {
      pointer = { x: e.clientX, y: e.clientY };
      aim();
    }
    if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      window.addEventListener('scroll', aim, { passive: true });
    }

    // —— Boop:点击出表情,连戳会晕,配合挤压回弹动画 ——
    var timers = [];
    var boopCount = 0;
    var boopAt = 0;
    var reactionIdx = null;
    function paintReaction() {
      // 常驻第二层而不是现挂:精灵图在首次渲染就拉好,第一次点击不会闪加载。
      reLayer.style.backgroundPosition = cellPos(reactionIdx == null ? 0 : reactionIdx);
      reLayer.style.opacity = reactionIdx == null ? 0 : 1;
    }
    function later(ms, fn) { timers.push(window.setTimeout(fn, ms)); }
    function boop() {
      timers.forEach(window.clearTimeout);
      timers = [];
      var now = Date.now();
      boopCount = now - boopAt < DIZZY_WINDOW ? boopCount + 1 : 1;
      boopAt = now;
      if (boopCount >= DIZZY_AFTER) {
        boopCount = 0;
        reactionIdx = 7; // dizzy
        paintReaction();
        later(DIZZY_END, function () { reactionIdx = null; paintReaction(); });
      } else {
        var c = boopCount;
        reactionIdx = 0; // blink
        paintReaction();
        later(BOOP_PAYOFF, function () { reactionIdx = PAYOFF_IDX[(c - 1) % PAYOFF_IDX.length]; paintReaction(); });
        later(BOOP_END, function () { reactionIdx = null; paintReaction(); });
      }
      if (!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
        && squashEl.animate) {
        squashEl.animate(SQUASH, { duration: SQUASH_MS, easing: 'linear' });
      }
    }
    btn.addEventListener('click', boop);

    // —— 换角色浮层 ——
    function closePop() { pop.style.display = 'none'; }
    swap.addEventListener('click', function (e) {
      e.stopPropagation();
      pop.style.display = pop.style.display === 'grid' ? 'none' : 'grid';
    });
    pop.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-char]');
      if (!b) return;
      picked = b.getAttribute('data-char');
      applyChar(picked);
      try { window.localStorage.setItem(STORE_KEY, picked); } catch (err) { /* 存不了就当次会话生效 */ }
      for (var i = 0; i < pop.children.length; i++) {
        var item = pop.children[i];
        var on = item.getAttribute('data-char') === picked;
        item.style.background = on ? 'var(--accent,#2f6e50)' : 'transparent';
        item.style.color = on ? '#fff' : 'inherit';
      }
      closePop();
    });
    document.addEventListener('click', function (e) {
      if (pop.style.display === 'grid' && !dock.contains(e.target)) closePop();
    });
  }

  init(document.getElementById('mascotDock'));
})();
