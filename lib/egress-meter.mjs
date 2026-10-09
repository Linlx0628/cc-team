// lib/egress-meter.mjs —— 出网字节观测(内存日累计)。非计费口径,只为回答「带宽花在哪」:
//   upBytes       发往上游的请求体字节(每轮全量重放的 context 都算;若启用上游压缩则为压缩后字节;
//                 同一请求的重试/failover/自愈多次上传逐次累计)
//   downBytes     回传客户端的应用层字节(SSE 流 + JSON 响应体;不含响应头与 TCP 封装开销)
//   upstreamPosts 上游上传次数(含重试/failover/自愈;>1 即存在放大)
//   requests      完成的代理请求数
// 按北京时间日界滚动;进程重启后由 server 启动时回放今日 requests JSONL 回填(reseed)。
import { cnDate } from "./time.mjs";

// 字节数一律走这里归一,不要用 `| 0` —— `| 0` 是 ToInt32,单次入参 ≥ 2^31(2.15 GiB)
// 会被截断成负数。触发点就是重启回填:reseed 一次收到的是**全天**上行总量,生产上
// 单价很容易超过 2 GiB(实测出现过显示 -1877773424 B = ToInt32(2417193872))。
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function createEgressMeter() {
  let day = cnDate();
  let up = 0, down = 0, posts = 0, reqs = 0;
  let since = Date.now();

  function roll() {
    const d = cnDate();
    if (d === day) return;
    day = d; up = 0; down = 0; posts = 0; reqs = 0; since = Date.now();
  }

  return {
    // 一个代理请求收尾时记一次(attachRequestLogger 的 finish/close 钩子)。
    noteRequest(upBytes, downBytes, upstreamPosts) {
      roll();
      up += num(upBytes); down += num(downBytes); posts += num(upstreamPosts); reqs += 1;
    },
    // 重启回填:累加今日 JSONL 里已有的量,不覆盖为 0(所以叫 reseed 不是 reset)。
    reseed(upBytes, downBytes, upstreamPosts, requestCount) {
      roll();
      up += num(upBytes); down += num(downBytes); posts += num(upstreamPosts); reqs += num(requestCount);
    },
    snapshot() {
      roll();
      return { day, upBytes: up, downBytes: down, upstreamPosts: posts, requests: reqs, since };
    },
  };
}
