#!/usr/bin/env node
// 阿里云百炼「控制台令牌」自取脚本（在**你自己的电脑**上跑，不需要装官方 CLI）
//
//   node tools/bailian-console-login.mjs            # 国内站 bailian.console.aliyun.com
//   node tools/bailian-console-login.mjs --intl     # 国际站 modelstudio.console.alibabacloud.com
//   node tools/bailian-console-login.mjs --no-open  # 不自动开浏览器，只打印授权地址
//
// 什么时候用它：面板部署在 Linux 服务器上、而你的浏览器与服务器不是同一台机器
// （直接访问 http://<服务器IP>:6789 时，https 控制台页面发来的回调会被浏览器按
// 「混合内容」拦掉）。本脚本在你这台电脑开一个一次性回调端口，拿到 access_token 后
// 打印出来，粘到「设置 → 上游额度 → 阿里云百炼 Token Plan → 控制台令牌」即可。
//
// 不需要它的情况：
//   · 面板开在本机 —— 直接点面板里的「一键获取令牌」；
//   · 经 SSH 隧道访问面板（ssh -L 6789:127.0.0.1:6789 user@server，浏览器开
//     127.0.0.1:6789）—— 也点面板里的「一键获取令牌」，回调会走隧道回来；
//   · 给这个 RAM 用户加了 modelstudio:GenerateCLIAccessToken 权限 —— 面板会用
//     AccessKey 自动换取 / 自动续期，完全不用手工。
import { execFile } from "node:child_process";
import { startBailianConsoleLogin, bailianConsoleOrigin } from "../lib/bailian-console-login.mjs";

const args = new Set(process.argv.slice(2));
const site = args.has("--intl") || args.has("--international") ? "international" : "domestic";
const origin = bailianConsoleOrigin(site);

function openBrowser(url) {
  const [cmd, argv] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  execFile(cmd, argv, (err) => {
    if (err) console.log("（没能在浏览器里打开，请手动复制上面的地址）");
  });
}

const session = await startBailianConsoleLogin({ site, timeoutMs: 15 * 60 * 1000 });
console.log(`百炼控制台：${origin}（${site === "international" ? "国际站" : "国内站"}）`);
console.log(`\n请在浏览器里打开这个地址，登录后点「授权」：\n\n  ${session.url}\n`);
console.log("回调只监听本机 127.0.0.1，授权完成后这里会自动打印令牌（最多等 15 分钟）。");
if (!args.has("--no-open")) openBrowser(session.url);

try {
  const creds = await session.done;
  session.close();
  console.log("\n✅ 拿到控制台令牌了，把它整段粘到面板的「控制台令牌」输入框里：\n");
  console.log(creds.token);
  if (creds.region) console.log(`\n控制台区域：${creds.region}`);
  process.exit(0);
} catch (err) {
  console.error(`\n❌ 没有拿到令牌：${err.message}`);
  process.exit(1);
}
