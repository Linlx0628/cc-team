// public/assets/md.js —— 极简 markdown 渲染器（管理端通知预览与成员端站内信共用）。
//
// 为什么不用 marked.js 之类的 CDN 库：部署环境可能不通外网（CSP 也只放行 jsdelivr，
// 断网即静默退化），而通知正文只需要「常用子集」—— 标题/加粗/斜体/行内代码/代码块/
// 链接/列表/引用/分隔线/表格。自带 ~80 行渲染器换掉一个 CDN 依赖，划算。
//
// 安全模型：先把整段文本做 HTML 转义（esc），之后的变换只注入白名单标签 —— 即便
// 管理员正文里写了 <script>，输出也是可见文本而不是活代码。链接只接受 http(s)/
// mailto，其余 scheme（javascript: 等）按纯文本输出。
(function () {
  'use strict';
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // 行内变换。输入已经过 esc，所以原文里的 <> 已是实体，正则不会误吃标签结构。
  function inline(s) {
    var out = s;
    // 行内代码先挖走占位，防止后续变换碰到代码内容
    var codes = [];
    out = out.replace(/`([^`]+)`/g, function (_, c) {
      codes.push('<code>' + c + '</code>');
      return '\x00' + (codes.length - 1) + '\x00';
    });
    // 链接：[text](http://… / https://… / mailto:…)
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, function (_, t, u) {
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
    out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>');
    out = out.replace(/\x00(\d+)\x00/g, function (_, i) { return codes[Number(i)]; });
    return out;
  }
  // 渲染为 HTML 字符串。块级解析按行扫描：标题/代码块/引用/列表/表格/段落。
  function renderMarkdown(src) {
    var lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    var html = [], i = 0;
    var flushP = function (buf) { if (buf.length) html.push('<p>' + buf.map(inline).join('<br>') + '</p>'); };
    var p = [];
    while (i < lines.length) {
      var line = lines[i];
      // 围栏代码块
      var fence = line.match(/^```(\S*)\s*$/);
      if (fence) {
        flushP(p); p = [];
        var code = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
        i++; // 跳过收尾 ```（缺失也终止）
        html.push('<pre' + (fence[1] ? ' data-lang="' + esc(fence[1]) + '"' : '') + '><code>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      // 标题
      var h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { flushP(p); p = []; html.push('<h' + (h[1].length + 2) + '>' + inline(esc(h[2])) + '</h' + (h[1].length + 2) + '>'); i++; continue; }
      // 分隔线
      if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) { flushP(p); p = []; html.push('<hr>'); i++; continue; }
      // 引用
      if (/^>\s?/.test(line)) {
        flushP(p); p = [];
        var quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i++; }
        html.push('<blockquote>' + renderMarkdown(quote.join('\n')) + '</blockquote>');
        continue;
      }
      // 列表（有序/无序，允许嵌套一层：两空格缩进）
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        flushP(p); p = [];
        var items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          var m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          items.push({ indented: m[1].length >= 2, ordered: /\d/.test(m[2]), text: m[3] });
          i++;
        }
        var cur = null, open = false, openTag = '', closeTag = '';
        var out = '';
        items.forEach(function (it) {
          if (!cur || cur !== (it.indented ? 'sub' : 'top')) {
            if (open) out += '</' + closeTag + '>';
            openTag = it.ordered ? 'ol' : 'ul'; closeTag = openTag;
            out += '<' + openTag + (it.indented ? ' class="md-sub"' : '') + '>';
            open = true; cur = it.indented ? 'sub' : 'top';
          }
          out += '<li>' + inline(esc(it.text)) + '</li>';
        });
        if (open) out += '</' + closeTag + '>';
        html.push(out);
        continue;
      }
      // 表格：| a | b |  分隔行 ---|---
      if (/^\s*\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        flushP(p); p = [];
        var cells = function (l) { return l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); }); };
        var head = cells(line);
        i += 2;
        var rows = [];
        while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
        html.push('<table class="md-table"><thead><tr>' + head.map(function (c) { return '<th>' + inline(esc(c)) + '</th>'; }).join('') + '</tr></thead><tbody>'
          + rows.map(function (r) { return '<tr>' + head.map(function (_, ci) { return '<td>' + inline(esc(r[ci] || '')) + '</td>'; }).join('') + '</tr>'; }).join('')
          + '</tbody></table>');
        continue;
      }
      // 空行 = 段落分隔
      if (!line.trim()) { flushP(p); p = []; i++; continue; }
      p.push(line);
      i++;
    }
    flushP(p);
    return html.join('');
  }
  window.renderMarkdown = renderMarkdown;
})();
