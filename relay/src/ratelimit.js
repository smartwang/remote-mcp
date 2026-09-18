'use strict';
/**
 * 极简滑动窗口限速（进程内存）。
 *
 * 存在的理由很具体：设备批准接口的 user_code 是可被暴力猜的。
 * user_code 是 8 位、31 个字符的字母表（约 2^39），本身很难穷举；但"批准"
 * 这个动作的后果极不对称 —— 猜中一个 user_code 并批准，就意味着**提出请求的
 * 那台机器会变成批准者的远程设备**。受害者的机器被绑到攻击者账号上，
 * 攻击者随后可以读写它的文件、执行命令。这比"绑错账号"严重得多。
 *
 * 所以：短有效期（DEVICE_CODE_TTL_S，默认 5 分钟）+ 限速 + 批准页必须登录，
 * 三者叠加把可行攻击窗口压到可忽略。缺任何一条都不够。
 *
 * 内存实现意味着多副本部署时限速是"每副本各算一份"。要做成全局的得引入
 * Redis 之类，现阶段不值当 —— 但上多副本前必须记得这一点。
 */

function makeLimiter({ max, windowMs, name = 'limiter' }) {
  /** key → number[]（命中时间戳，升序） */
  const hits = new Map();
  let lastSweep = Date.now();

  function sweep(now) {
    // 每 5 分钟清一次空桶，避免 key 无限增长（按 IP 计 key，公网下会长得很快）
    if (now - lastSweep < 5 * 60 * 1000) return;
    lastSweep = now;
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => now - t < windowMs);
      if (kept.length) hits.set(k, kept);
      else hits.delete(k);
    }
  }

  return {
    name,
    /** 记一次命中。返回 { ok, retryAfterS?, remaining? }。 */
    hit(key) {
      const now = Date.now();
      sweep(now);
      const prev = hits.get(key) || [];
      const arr = prev.filter((t) => now - t < windowMs);

      if (arr.length >= max) {
        const oldest = arr[0];
        return {
          ok: false,
          retryAfterS: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)),
          remaining: 0,
        };
      }
      arr.push(now);
      hits.set(key, arr);
      return { ok: true, remaining: max - arr.length };
    },
    /** 成功之后清掉计数（例如登录成功就不该再累积失败次数）。 */
    reset(key) {
      hits.delete(key);
    },
    stats() {
      let total = 0;
      for (const arr of hits.values()) total += arr.length;
      return { buckets: hits.size, hits: total, max, window_ms: windowMs };
    },
  };
}

module.exports = { makeLimiter };
