/* 自动生成，请勿手改。
 *
 * 来源：扫雷模拟器.html 中 4 段引擎标记之间的代码
 * 重建：node 叠加器/建引擎.js
 *
 * 这份文件在浏览器和 Node 里都能直接跑：
 *   浏览器 —— 当普通 <script> 加载（module 不存在，导出段自动跳过）
 *   Node    —— require() 它，用 setBoard / setCell / solve / annRun
 */
'use strict';
/* Node 里没有 document；引擎区顶部那三行界面状态会用到它。
   引擎本身不碰 DOM，这里给个空桩即可。
   注意必须用 typeof 判断：浏览器里 window.document 是**只读访问器**，
   严格模式下直接 globalThis.document = ... 会抛 TypeError（踩过）。 */
if (typeof document === 'undefined') globalThis.document = { querySelector: () => null };

/* ============================================================================
   引擎区（ENGINE:BEGIN … ENGINE:END）
   这一段是**纯计算**，只依赖数组和数字，不碰 DOM。
   `工具/抽引擎.js` 会把所有标记之间的代码拼成 `叠加器/engine_core.js`，
   供无头测试与桌面叠加器复用 —— 所以**改引擎只改这里**，
   并且千万别在这几段里写 document / window 调用（上面那三行界面状态是历史遗留，
   Node 侧用一个 document 桩兜住，不要模仿）。
   ============================================================================ */
/* ==================== 常量与状态 ==================== */
const UNKNOWN = 0, BLANK = 1, BLUE = 2, YELLOW = 3, RED = 4;
/* KT / KB —— 「已知事实」：已挖开的宝藏 / 已标注的炸弹（截图里的兔子图标与红色感叹号）。
   规则里只有数字格提供邻域信息，所以它们不产生约束；但它们是**确定的占用**，
   要从全局宝藏 / 炸弹配额里扣掉，并且不再进入未知格分析。 */
const KT = 5, KB = 6;
const V_EMPTY = 0, V_TREASURE = 1, V_BOMB = 2;

let W = 10, H = 10, N = 100;
let T = 8, B = 6;                       // 全局宝藏 / 炸弹总数
let cellState = new Int8Array(N);
let cellNum   = new Int8Array(N);
let neighbors = [];
let sol = null;

const rc = i => ({ r: Math.floor(i / W), c: i % W });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));


/* ---- 对数域计算 ----
   概率只取决于相对大小，因此全部改用 log 值（Number）运算，
   避免 BigInt 大数乘除在分布卷积时成为性能瓶颈。 */
let logFact = null;
function ensureLogFact(n) {
  if (logFact !== null && logFact.length > n) return;
  const m = Math.max(n + 2, 1024);
  logFact = new Float64Array(m);
  for (let i = 1; i < m; i++) logFact[i] = logFact[i - 1] + Math.log(i);
}
function logC(n, k) {
  if (n < 0 || k < 0 || k > n) return -Infinity;
  if (k === 0 || k === n) return 0;
  ensureLogFact(n);
  return logFact[n] - logFact[k] - logFact[n - k];
}
function logAdd(a, b) {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const hi = a > b ? a : b, lo = a > b ? b : a;
  return hi + Math.log1p(Math.exp(lo - hi));
}
/* 稀疏二维分布卷积：key = t*1000 + b，值为 log 计数 */
function logConvolve(A, B) {
  const R = new Map();
  for (const [ka, la] of A) {
    const ta = (ka / 1000) | 0, ba = ka % 1000;
    for (const [kb, lb] of B) {
      const tb = (kb / 1000) | 0, bb = kb % 1000;
      const key = (ta + tb) * 1000 + (ba + bb);
      const v = la + lb;
      const prev = R.get(key);
      R.set(key, prev === undefined ? v : logAdd(prev, v));
    }
  }
  return R;
}
/* 配置总数（log 值）→ 可读文本 */
function fmtLog(logV) {
  if (logV === -Infinity || logV === undefined) return '0';
  const e = logV / Math.LN10;
  if (e < 12) return String(Math.round(Math.pow(10, e))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const ei = Math.floor(e);
  return `${Math.pow(10, e - ei).toFixed(2)} × 10^${ei}`;
}

/* ==================== 棋盘构建 ==================== */
function buildNeighbors() {
  neighbors = new Array(N);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c, nb = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < H && nc >= 0 && nc < W) nb.push(nr * W + nc);
        }
      }
      neighbors[i] = nb;
    }
  }
}


/* ==================== 求解引擎 ==================== */

/* 单分量：传播 + 枚举 */
function analyzeComponent(cells, cons, deadline, sampleDeadline) {
  const fixed = new Map();

  /* --- 1. 约束传播 --- */
  let changed = true, guard = 0;
  while (changed && guard++ < 4000) {
    changed = false;
    for (const c of cons) {
      let t = 0, b = 0, u = 0;
      for (const cell of c.cells) {
        const v = fixed.get(cell);
        if (v === 1) t++; else if (v === 2) b++; else if (v === undefined) u++;
      }
      if (c.type === 'T') {                      // 蓝：只有宝藏，共 need 个
        if (b > 0 || t > c.need) return { error: '提示互相矛盾：蓝色数字的邻域内被确定为炸弹。' };
        if (t + u < c.need) return { error: '提示互相矛盾：蓝色数字的邻域内已经放不下这么多宝藏。' };
        if (u > 0 && t === c.need) {
          for (const cell of c.cells) if (fixed.get(cell) === undefined) { fixed.set(cell, V_EMPTY); changed = true; }
        } else if (u > 0 && t + u === c.need) {
          for (const cell of c.cells) if (fixed.get(cell) === undefined) { fixed.set(cell, V_TREASURE); changed = true; }
        }
      } else if (c.type === 'B') {               // 红：只有炸弹，共 need 个
        if (t > 0 || b > c.need) return { error: '提示互相矛盾：红色数字的邻域内被确定为宝藏。' };
        if (b + u < c.need) return { error: '提示互相矛盾：红色数字的邻域内已经放不下这么多炸弹。' };
        if (u > 0 && b === c.need) {
          for (const cell of c.cells) if (fixed.get(cell) === undefined) { fixed.set(cell, V_EMPTY); changed = true; }
        } else if (u > 0 && b + u === c.need) {
          for (const cell of c.cells) if (fixed.get(cell) === undefined) { fixed.set(cell, V_BOMB); changed = true; }
        }
      } else {                                   // 黄：宝藏 + 炸弹 = need，且都 ≥ 1
        const s = t + b;
        if (s > c.need) return { error: '提示互相矛盾：混合提示的邻域总数超限。' };
        if (s + u < c.need) return { error: '提示互相矛盾：混合提示的邻域内已经放不下这么多格子。' };
        if (u > 0 && s === c.need) {
          for (const cell of c.cells) if (fixed.get(cell) === undefined) { fixed.set(cell, V_EMPTY); changed = true; }
        }
        // "宝藏与炸弹同时存在"说的是周围 8 格，所以已知事实（兔子 / 感叹号）也要算进来：
        // 否则「黄3 旁边一只兔子」在扣减后只剩 1 个名额时会被误判成矛盾。
        if (u === 0 && (t + c.kt === 0 || b + c.kb === 0)) {
          return { error: '提示互相矛盾：混合提示要求邻域内宝藏与炸弹同时存在。' };
        }
      }
    }

    // ---- 子集推理：约束 A 的未确定邻域 ⊆ B 时，差集 B\A 可推出新约束 ----
    // 扫雷求解器的核心技巧。邻域至多 8 格，用集合比较即可。
    // 只比较「邻域有交叠」的约束对（经格子倒排筛选），并受时间盒保护。
    if (cons.length > 1 && cons.length <= 400 && performance.now() < deadline) {
      // 关键：need 是「邻域内应有的总数」，而 open 只含未确定的格子，
      // 两者口径不同，必须改用「剩余需求」rem 才能做差值推导。
      for (let ci = 0; ci < cons.length; ci++) {
        const c = cons[ci];
        const open = [];
        let doneT = 0, doneB = 0;
        for (const x of c.cells) {
          const v = fixed.get(x);
          if (v === undefined) open.push(x);
          else if (v === 1) doneT++;
          else if (v === 2) doneB++;
        }
        c.open = open;
        c.openSet = new Set(open);
        c.rem = c.type === 'T' ? c.need - doneT
              : c.type === 'B' ? c.need - doneB
              : c.need - doneT - doneB;
        if (c.rem < 0 || c.rem > open.length) {
          return { error: '提示互相矛盾：某条提示的邻域内数量超出可容纳范围。' };
        }
      }
      const cellCons = new Map();
      for (let ci = 0; ci < cons.length; ci++) {
        for (const cell of cons[ci].open) {
          let arr = cellCons.get(cell);
          if (arr === undefined) { arr = []; cellCons.set(cell, arr); }
          arr.push(ci);
        }
      }
      // 先收集推导，再统一应用，避免中途改动 fixed 使 open/rem 失效
      const toFix = new Map();
      let conflict = false;
      let ops = 0, abort = false;
      for (let i = 0; i < cons.length && !abort; i++) {
        const A = cons[i];
        if (A.open.length === 0) continue;
        let cand = null;
        for (let x = 0; x < A.open.length; x++) {
          const arr = cellCons.get(A.open[x]);
          if (arr === undefined) continue;
          if (cand === null) cand = new Set(arr);
          else for (const ci of arr) cand.add(ci);
        }
        if (cand === null) continue;
        for (const j of cand) {
          if (j === i) continue;
          if ((++ops & 255) === 0 && performance.now() > deadline) { abort = true; break; }
          const B = cons[j];
          if (A.type !== B.type) continue;                 // 仅同类型，保证推导安全
          if (A.open.length > B.open.length) continue;
          let sub = true;
          for (let x = 0; x < A.open.length; x++) {
            if (!B.openSet.has(A.open[x])) { sub = false; break; }
          }
          if (!sub) continue;
          const needDiff = B.rem - A.rem;
          const dCount = B.open.length - A.open.length;
          /* 这两个越界条件在**自洽盘面上数学上不可能成立**，所以这里的 continue 是
             纯防御，不是"漏检矛盾"（曾被人当成 bug 报过，别再改）：
               rem = |真实解集 ∩ open|（蓝/红/黄三种类型同构），而 A.open ⊆ B.open
               ⟹ rem_A ≤ rem_B，即 needDiff ≥ 0；
               同理 needDiff ≤ |B.open \ A.open| = dCount。
             只有用户标注本身自相矛盾时才可能触及，那时枚举阶段会兜底报
             "没有任何自洽的配置"（错误信息不如这里具体，但结论一样）。
             真值盘面上实测触发 0 次。 */
          if (needDiff < 0 || needDiff > dCount) continue;
          if (needDiff === 0) {                            // 差集全部为空
            for (let x = 0; x < B.open.length; x++) {
              const cell = B.open[x];
              if (!A.openSet.has(cell)) toFix.set(cell, V_EMPTY);
            }
          } else if (needDiff === dCount && A.type !== 'M') {  // 差集全是宝藏 / 全是炸弹
            const vv = A.type === 'T' ? V_TREASURE : V_BOMB;
            for (let x = 0; x < B.open.length; x++) {
              const cell = B.open[x];
              if (!A.openSet.has(cell)) toFix.set(cell, vv);
            }
          }
        }
      }
      for (const [cell, v] of toFix) {
        const cur = fixed.get(cell);
        if (cur === undefined) { fixed.set(cell, v); changed = true; }
        else if (cur !== v) { conflict = true; }
      }
      if (conflict) return { error: '提示互相矛盾：不同提示给出了不一致的格子状态。' };
    }
  }

  /* --- 2. 未确定格子 --- */
  const undet = cells.filter(c => !fixed.has(c));
  const n = undet.length;
  let baseT = 0, baseB = 0;
  for (const v of fixed.values()) { if (v === 1) baseT++; else if (v === 2) baseB++; }

  // 局部计数一律用 Number：单分量解数被 SOL_LIMIT 封顶，绝不会越界，
  // 返回前再统一转 BigInt，避免枚举热路径上反复做 BigInt 运算。
  const dist = new Map();
  const statT = [], statB = [], statE = [];
  const toLog = m => { const r = new Map(); for (const [k, v] of m) r.set(k, Math.log(v)); return r; };

  if (n === 0) {
    dist.set(baseT * 1000 + baseB, 1);
    return { cells, fixed, undet, dist: toLog(dist), statT, statB, statE, approx: false };
  }

  // 枚举下标映射：用 Int32Array 直查，避免热路径上的 Map 查找
  const idxArr = new Int32Array(N).fill(-1);
  undet.forEach((c, k) => { idxArr[c] = k; });

  // 约束的格子预先翻译成枚举下标
  const consIdx = cons.map(c => {
    const a = [];
    for (const cell of c.cells) { const k = idxArr[cell]; if (k >= 0) a.push(k); }
    return a;
  });

  const consOf = Array.from({ length: n }, () => []);
  cons.forEach((c, ci) => {
    for (const k of consIdx[ci]) consOf[k].push(ci);
  });

  const consBase = cons.map(c => {
    let t = 0, b = 0;
    for (const cell of c.cells) {
      const v = fixed.get(cell);
      if (v === 1) t++; else if (v === 2) b++;
    }
    return { t, b };
  });

  for (let k = 0; k < n; k++) { statT.push(new Map()); statB.push(new Map()); statE.push(new Map()); }

  // 变量排序：参与约束多的优先（强剪枝）
  const order = Array.from({ length: n }, (_, k) => k)
    .sort((a, b) => consOf[b].length - consOf[a].length);

  const val = new Int8Array(n).fill(-1);

  function okCons(ci) {
    const c = cons[ci];
    const list = consIdx[ci];
    let t = consBase[ci].t, b = consBase[ci].b, u = 0;
    for (let x = 0; x < list.length; x++) {
      const v = val[list[x]];
      if (v === 1) t++; else if (v === 2) b++; else if (v === -1) u++;
    }
    if (c.type === 'T') {
      if (b > 0 || t > c.need) return false;
      if (t + u < c.need) return false;
    } else if (c.type === 'B') {
      if (t > 0 || b > c.need) return false;
      if (b + u < c.need) return false;
    } else {
      const s = t + b;
      if (s > c.need) return false;
      if (s + u < c.need) return false;
      // "宝藏与炸弹同时存在"说的是周围 8 格 —— 已知事实（兔子 / 感叹号）也要算进来。
      // 典型例子：「黄2 旁边一个已标注炸弹，只剩 1 个未知格」是**有解**的
      // （那个未知格就是宝藏），但只看 cells 会判成"既没有宝藏也没有炸弹"而无解。
      const kt = c.kt || 0, kb = c.kb || 0;
      if (u === 0) { if (t + kt === 0 || b + kb === 0) return false; }
      else {
        const rem = c.need - s;
        if (t + kt === 0 && rem < 1) return false;
        if (b + kb === 0 && rem < 1) return false;
      }
    }
    return true;
  }

  function record() {
    let t = baseT, b = baseB;
    for (let k = 0; k < n; k++) { const v = val[k]; if (v === 1) t++; else if (v === 2) b++; }
    const key = t * 1000 + b;
    dist.set(key, (dist.get(key) || 0) + 1);
    for (let k = 0; k < n; k++) {
      const v = val[k];
      const m = v === 1 ? statT[k] : v === 2 ? statB[k] : statE[k];
      m.set(key, (m.get(key) || 0) + 1);
    }
  }

  const NODE_LIMIT = 3_000_000, SOL_LIMIT = 200_000;
  // 单分量枚举的试探窗口：约束强则很快枚举完（精确），约束弱则及早转抽样。
  // 保证每个分量都有最小窗口，避免先处理的大分量耗尽预算后，
  // 后续本可秒解的小分量也被迫走抽样。
  const enumDeadline = Math.max(
    Math.min(deadline, performance.now() + 400),
    performance.now() + (n <= 24 ? 60 : 8)
  );
  let nodes = 0, sols = 0, overflow = false;

  function rec(pos) {
    if (overflow) return;
    if (++nodes > NODE_LIMIT) { overflow = true; return; }
    if ((nodes & 2047) === 0 && performance.now() > enumDeadline) { overflow = true; return; }
    if (pos === n) {
      if (++sols > SOL_LIMIT) { overflow = true; return; }
      record();
      return;
    }
    const k = order[pos];
    for (let v = 0; v <= 2; v++) {
      val[k] = v;
      let ok = true;
      const list = consOf[k];
      for (let x = 0; x < list.length; x++) { if (!okCons(list[x])) { ok = false; break; } }
      if (ok) rec(pos + 1);
      if (overflow) { val[k] = -1; return; }
    }
    val[k] = -1;
  }
  if (n <= 200) rec(0); else overflow = true;   // 变量过多时枚举必然爆炸，直接跳到抽样

  /* --- 3. 超限则改用随机抽样估算 --- */
  let approx = false;
  let got = 0, tries = 0;
  if (overflow) {
    approx = true;
    dist.clear();
    for (let k = 0; k < n; k++) { statT[k].clear(); statB[k].clear(); statE[k].clear(); }
    const SAMPLES = 6000, NODE_BUDGET = 300000;
    // 采样同样受全局时间盒约束，单分量最多再花 800ms
    const hardDeadline = Math.max(
      Math.min(sampleDeadline, performance.now() + 800),
      performance.now() + 25
    );

    // 采样采用「随机决策 + 立即传播」：每步赋值后先跑一遍约束传播，
    // 把必然确定的格子直接定下来，搜索深度被压到极小，
    // 避免纯随机 DFS 在强约束下几乎必然撞死。
    const modLog = [];
    const undoTo = len => { while (modLog.length > len) val[modLog.pop()] = -1; };

    // 注意：need 是「整个邻域内应有的总数」，其中一部分可能已经被约束传播定死了
    // （consBase）。因此这里必须用 consBase 作为基数，否则剪枝口径就错了：
    // 既会漏掉大量可推导的信息，也会把非法赋值当成解收进来。
    // 下面的检查与精确枚举的 okCons 等价 —— **但 kt / kb（已知事实）必须一起算**，
    // 这一点曾经漏过（consBase 只统计 c.cells 里被定死的格子，不含已知事实）。
    function propAssign() {
      let changed = true;
      while (changed) {
        changed = false;
        for (let ci = 0; ci < cons.length; ci++) {
          const c = cons[ci], list = consIdx[ci];
          let t = consBase[ci].t, b = consBase[ci].b, u = 0;
          for (let x = 0; x < list.length; x++) {
            const v = val[list[x]];
            if (v === 1) t++; else if (v === 2) b++; else if (v === -1) u++;
          }
          if (c.type === 'T') {
            if (b > 0 || t > c.need) return false;
            if (t + u < c.need) return false;
            if (u > 0 && t === c.need) {
              for (let x = 0; x < list.length; x++) { const kk = list[x]; if (val[kk] === -1) { val[kk] = 0; modLog.push(kk); changed = true; } }
            } else if (u > 0 && t + u === c.need) {
              for (let x = 0; x < list.length; x++) { const kk = list[x]; if (val[kk] === -1) { val[kk] = 1; modLog.push(kk); changed = true; } }
            }
          } else if (c.type === 'B') {
            if (t > 0 || b > c.need) return false;
            if (b + u < c.need) return false;
            if (u > 0 && b === c.need) {
              for (let x = 0; x < list.length; x++) { const kk = list[x]; if (val[kk] === -1) { val[kk] = 0; modLog.push(kk); changed = true; } }
            } else if (u > 0 && b + u === c.need) {
              for (let x = 0; x < list.length; x++) { const kk = list[x]; if (val[kk] === -1) { val[kk] = 2; modLog.push(kk); changed = true; } }
            }
          } else {
            const s = t + b;
            if (s > c.need) return false;
            if (s + u < c.need) return false;
            const rem = c.need - s;                 // 还需要放几个「非空」格子
            /* 「宝藏与炸弹同时存在」说的是**整个邻域**，所以已知事实（兔子 / 感叹号）
               也要算进来 —— 与 okCons 口径一致。漏掉 kt/kb 会**过度剪枝**：
               「黄N 旁边一只已标注的兔子」这种本来合法的配置会被整趟丢掉，
               抽样分布被压偏。真机实测（探针，第三张真值盘面）触发 2404 次。 */
            const kt = c.kt || 0, kb = c.kb || 0;
            if (t + kt === 0 && rem < 1) return false;   // 还得有宝藏，但没位置了
            if (b + kb === 0 && rem < 1) return false;   // 还得有炸弹，但没位置了
            if (u > 0 && rem === 0) {
              for (let x = 0; x < list.length; x++) { const kk = list[x]; if (val[kk] === -1) { val[kk] = 0; modLog.push(kk); changed = true; } }
            }
          }
        }
      }
      return true;
    }

    // 「不回头的随机下潜」：随机挑格子、随机赋值、立刻传播；一旦传播发现矛盾就整趟丢弃重来。
    // 大而松的分量里，随机序 DFS 可能很久才摸到第一个叶子（甚至一直超时），
    // 而每趟下潜只要 O(深度)，能立刻攒出样本——总比退回「按平均密度猜」强得多。
    let dives = 0, diveFails = 0;
    function diveOnce() {
      dives++;
      val.fill(-1);
      modLog.length = 0;
      for (;;) {
        if (!propAssign()) { undoTo(0); diveFails++; return false; }
        // 蓄水池抽样，随机挑一个还没定的格子
        let k = -1, cnt = 0;
        for (let x = 0; x < n; x++) if (val[x] === -1) { cnt++; if ((Math.random() * cnt | 0) === 0) k = x; }
        if (k === -1) { got++; record(); undoTo(0); return true; }
        val[k] = (Math.random() * 3) | 0;
        modLog.push(k);            // 一并登记，undoTo(0) 时全部回滚
      }
    }
    const diveUntil = Math.min(hardDeadline, performance.now() + 250);
    while (got < SAMPLES && dives < 20000 && diveFails < 400 && performance.now() < diveUntil) diveOnce();

    // 随机序枚举：DFS 每一层的取值顺序都打乱，沿途把解收下。
    // 关键在「一趟只收一小批就重开」：
    //   一趟 DFS 会先把第一个分支的整棵子树走完，那批解的 (t,b) 会挤在很窄的一段里，
    //   采样再多也补不回来（真实解可能整段都落空）。
    //   每趟只取 PER_PASS 个就换一套随机序重来，才能把 (t,b) 的覆盖面铺开。
    const PER_PASS = 48;
    let nodes = 0, stop = false, passStop = false, passGot = 0;
    function randCollect() {
      if (stop || passStop) return;
      if ((++nodes & 511) === 0) {
        if (performance.now() > hardDeadline || got >= SAMPLES) { stop = true; return; }
      }

      const mark = modLog.length;
      if (!propAssign()) { undoTo(mark); return; }

      // 选参与约束最多的未确定格子（MRV 启发式）
      let k = -1, best = -1;
      for (let x = 0; x < n; x++) {
        if (val[x] !== -1) continue;
        const d = consOf[x].length;
        if (d > best) { best = d; k = x; }
      }
      if (k === -1) {
        got++; passGot++; record();
        if (passGot >= PER_PASS) passStop = true;
        undoTo(mark); return;
      }

      const vs = [0, 1, 2];
      for (let x = 2; x > 0; x--) { const y = (Math.random() * (x + 1)) | 0; const t = vs[x]; vs[x] = vs[y]; vs[y] = t; }
      for (let i = 0; i < 3; i++) {
        val[k] = vs[i];
        randCollect();
        val[k] = -1;
        if (stop || passStop) break;
      }
      undoTo(mark);
    }

    let deadPasses = 0;
    while (!stop && got < SAMPLES && nodes < NODE_BUDGET) {
      tries++;
      val.fill(-1);
      modLog.length = 0;
      passStop = false;
      passGot = 0;
      randCollect();
      if (passGot === 0 && ++deadPasses > 200) break;   // 连续多趟一无所获，别再耗时间
    }
    if (got === 0) {
      // 采样完全失败。注意：真实解是存在的，只是该分量过大无法枚举/抽样，
      // 这不是「矛盾」，交由上层用剩余区域平均密度兜底。
      return { cells, fixed, undet, dist: null, statT, statB, statE, approx: true, degraded: true, got, tries };
    }  }

  return {
    cells, fixed, undet,
    dist: toLog(dist),
    statT: statT.map(toLog), statB: statB.map(toLog), statE: statE.map(toLog),
    approx, got, tries
  };
}

function computeSolutionCore() {
  const t0 = performance.now();

  // 抽样/估算时，某些取值会因为「样本里没出现」而被算成 0——那只是没采到，不是不可能。
  // 给这类取值抬一个下限，但抬起来的概率会凭空增加总量，所以按棋盘格子数摊薄，
  // 把 ΣP 的总偏差控制在 FLOOR_BUDGET 以内（而不是每格固定 1e-3 那样随棋盘放大）。
  const FLOOR_BUDGET = 0.02;
  const floorEps = got => Math.min(1 / (2 * Math.max(1, got)), FLOOR_BUDGET / N);
  sol = {
    ok: true, error: null, approx: false, logTotal: -Infinity, ms: 0,
    probs: new Float64Array(N * 3), certain: new Uint8Array(N),
    estimated: new Uint8Array(N), degradedCount: 0
  };

  /* 未知格 */
  const unk = [];
  /* 已知事实（KT/KB）先扣掉：它们必然各占掉一个宝藏 / 炸弹名额，且已不是未知格。
     它们不产生邻域约束——规则里只有数字格给信息，所以下面的约束构建会跳过它们。 */
  let knownT = 0, knownB = 0;
  for (let i = 0; i < N; i++) {
    if (cellState[i] === UNKNOWN) unk.push(i);
    else if (cellState[i] === KT) knownT++;
    else if (cellState[i] === KB) knownB++;
  }
  const F = unk.length;
  const Trest = T - knownT, Brest = B - knownB;

  if (Trest < 0 || Brest < 0) {
    sol.ok = false;
    sol.error = `已标记 ${knownT} 个宝藏 / ${knownB} 个炸弹，超过了设定的总数（宝藏 ${T} · 炸弹 ${B}）。`;
    sol.ms = performance.now() - t0; return;
  }
  if (Trest + Brest > F) {
    sol.ok = false;
    sol.error = `扣掉已标记的之后还剩 ${Trest} 宝藏 + ${Brest} 炸弹，但未挖开格子只剩 ${F} 个，放不下。`;
    sol.ms = performance.now() - t0; return;
  }

  /* 构建约束 */
  const cons = [];
  for (let i = 0; i < N; i++) {
    const st = cellState[i];
    if (st !== BLUE && st !== YELLOW && st !== RED) continue;
    const cells = [];
    /* 已挖开的宝藏 / 已标注的炸弹也占着邻域名额。
       提示数说的是"周围 8 格"，而那 8 格里可能有已经确定的事实（截图里的兔子 / 红色感叹号）：
       它们不是未知格，进不了 cells，但**必须从提示数里扣掉** ——
       否则「蓝1 旁边正好一只兔子」会被判成"周围未挖开格只有 0 个，放不下 1 个"而无解。
       谁扣谁：蓝只数宝藏（兔子扣、炸弹不扣），红只数炸弹（炸弹扣、兔子不扣），黄两者都数。 */
    let known = 0, kt = 0, kb = 0;
    for (const j of neighbors[i]) {
      const sj = cellState[j];
      if (sj === UNKNOWN) cells.push(j);
      else if (sj === KT) { kt++; if (st !== RED) known++; }
      else if (sj === KB) { kb++; if (st !== BLUE) known++; }
    }
    const raw = cellNum[i];
    const need = raw - known;
    const type = st === BLUE ? 'T' : (st === RED ? 'B' : 'M');
    const p = rc(i);

    if (type === 'M' && raw < 2) {
      sol.ok = false; sol.error = `(${p.r + 1},${p.c + 1}) 黄 ${raw}：混合提示的总数至少为 2。`;
      sol.ms = performance.now() - t0; return;
    }
    if (need < 0) {
      sol.ok = false;
      const cn = st === BLUE ? '蓝' : st === RED ? '红' : '黄';
      sol.error = `(${p.r + 1},${p.c + 1}) 标注为 ${cn}${raw}，但周围已经有 ${known} 个已知事实，超出了提示数。`;
      sol.ms = performance.now() - t0; return;
    }
    if (cells.length < need) {
      sol.ok = false;
      const cn = st === BLUE ? '蓝' : st === RED ? '红' : '黄';
      sol.error = `(${p.r + 1},${p.c + 1}) 标注为 ${cn}${raw}（扣掉已知事实后还需 ${need} 个），但周围未挖开格只有 ${cells.length} 个。`;
      sol.ms = performance.now() - t0; return;
    }
    if (cells.length === 0 && need !== 0) {
      sol.ok = false; sol.error = '存在无法满足的提示（邻域内没有未挖开格子）。';
      sol.ms = performance.now() - t0; return;
    }
    cons.push({ type, need, cells, kt, kb });
  }

  /* 连通分量 */
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  for (const c of cons) for (let k = 1; k < c.cells.length; k++) union(c.cells[0], c.cells[k]);

  const inCon = new Uint8Array(N);
  for (const c of cons) for (const i of c.cells) inCon[i] = 1;

  const groups = new Map();
  for (const i of unk) {
    if (!inCon[i]) continue;
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }

  const compConsMap = new Map();
  for (const c of cons) {
    if (!c.cells.length) continue;
    const r = find(c.cells[0]);
    if (!compConsMap.has(r)) compConsMap.set(r, []);
    compConsMap.get(r).push(c);
  }

  let inComp = 0;
  for (const arr of groups.values()) inComp += arr.length;
  const FfreeBase = F - inComp;

  /* 求解各分量（全局时间盒：枚举 1.2s，抽样总截止 2.6s，保证 UI 不冻结） */
  const deadline = t0 + 2000;
  const sampleDeadline = t0 + 3000;
  const comps = [];
  const degraded = [];
  let minGot = Infinity;      // 抽样分量的最少样本数，用作概率下限的分辨率
  for (const [root, cells] of groups) {
    const r = analyzeComponent(cells, compConsMap.get(root) || [], deadline, sampleDeadline);
    if (r.error) { sol.ok = false; sol.error = r.error; sol.ms = performance.now() - t0; return; }
    if (r.approx) sol.approx = true;
    if (r.approx && r.got > 0) minGot = Math.min(minGot, r.got);
    if (r.degraded) degraded.push(r); else comps.push(r);
  }

  // 降级分量虽无法精确分析，但其格子仍要参与全局数量分配，因此并入「自由格」口径；
  // 其中已被传播确定的格子则要从全局总量中扣除，否则全局约束会无处落地而误报矛盾。
  let degN = 0, degFixT = 0, degFixB = 0;
  for (const r of degraded) {
    degN += r.undet.length;
    for (const v of r.fixed.values()) { if (v === 1) degFixT++; else if (v === 2) degFixB++; }
  }
  const Ffree = FfreeBase + degN;
  const Tg = Trest - degFixT, Bg = Brest - degFixB;

  /* 全局合并 */
  const m = comps.length;
  const pre = new Array(m + 1), suf = new Array(m + 1);
  pre[0] = new Map([[0, 0]]);                       // log(1) = 0
  for (let i = 0; i < m; i++) pre[i + 1] = logConvolve(pre[i], comps[i].dist);
  suf[m] = new Map([[0, 0]]);
  for (let i = m - 1; i >= 0; i--) suf[i] = logConvolve(comps[i].dist, suf[i + 1]);
  const A = pre[m];

  const logWaysFree = (t, b) => {
    if (t < 0 || b < 0 || t + b > Ffree) return -Infinity;
    return logC(Ffree, t) + logC(Ffree - t, b);
  };

  let logZ = -Infinity;
  for (const [key, la] of A) {
    const t = (key / 1000) | 0, b = key % 1000;
    const lw = logWaysFree(Tg - t, Bg - b);
    if (lw === -Infinity) continue;
    logZ = logAdd(logZ, la + lw);
  }

  // 还剩多少宝藏 / 炸弹没被"已知事实"占掉。pickNext 要用（死区过滤的前提是 Trest ≥ 1）。
  sol.Trest = Trest; sol.Brest = Brest;

  // 诊断用：记录分量规模、抽样样本数与全局 (t,b) 支撑，便于外部脚本核对
  sol.__dbg = {
    F, FfreeBase, degN, degFixT, degFixB, Tg, Bg, Ffree, knownT, knownB, Trest, Brest,
    A: [...A.keys()].sort((a, b) => a - b),
    comps: comps.map(c => ({ n: c.undet.length, fixed: c.fixed.size, keys: c.dist.size, approx: c.approx, got: c.got, tries: c.tries })),
    deg: degraded.map(c => ({ n: c.undet.length, fixed: c.fixed.size, approx: c.approx, got: c.got, tries: c.tries })),
  };

  if (logZ === -Infinity) {
    if (!sol.approx && degraded.length === 0) {
      // 所有分量都精确求解过，这时「无解」才真的是标注本身自相矛盾
      sol.ok = false;
      sol.error = '当前标注与全局数量矛盾：没有任何自洽的配置。';
      sol.ms = performance.now() - t0; return;
    }
    // 有抽样/降级分量时，「没找到自洽配置」可能只是近似没覆盖到真实解。
    // 此时不能断言标注矛盾——退回「按剩余区域平均密度估算」，并全部标为估算值。
    let fixT = 0, fixB = 0;
    for (const r of comps.concat(degraded)) {
      for (const [cell, v] of r.fixed) {
        sol.certain[cell] = v === 1 ? 1 : v === 2 ? 2 : 3;
        sol.probs[cell * 3 + (v === 1 ? 0 : v === 2 ? 1 : 2)] = 1;
        if (v === 1) fixT++; else if (v === 2) fixB++;
      }
    }
    const restCells = [];
    for (const r of comps.concat(degraded)) for (const cell of r.undet) restCells.push(cell);
    for (const i of unk) if (!inCon[i]) restCells.push(i);
    const n2 = restCells.length;
    let pT = n2 > 0 ? Math.max(0, T - fixT) / n2 : 0;
    let pB = n2 > 0 ? Math.max(0, B - fixB) / n2 : 0;
    let pE = Math.max(0, 1 - pT - pB);
    if (n2 > 0) {
      const eps = floorEps(n2);
      pT = Math.max(pT, eps); pB = Math.max(pB, eps); pE = Math.max(pE, eps);
      const z = pT + pB + pE; pT /= z; pB /= z; pE /= z;
    }
    for (const cell of restCells) {
      sol.probs[cell * 3] = pT; sol.probs[cell * 3 + 1] = pB; sol.probs[cell * 3 + 2] = pE;
      sol.estimated[cell] = 1;
    }
    sol.approx = true;
    sol.fallback = true;
    sol.degradedCount = n2;
    sol.ms = performance.now() - t0; return;
  }
  sol.logTotal = logZ;

  /* 传播确定的格子（含降级分量中已被传播确定的部分） */
  for (const r of comps) {
    for (const [cell, v] of r.fixed) {
      sol.certain[cell] = v === 1 ? 1 : v === 2 ? 2 : 3;
      sol.probs[cell * 3 + (v === 1 ? 0 : v === 2 ? 1 : 2)] = 1;
    }
  }
  for (const r of degraded) {
    for (const [cell, v] of r.fixed) {
      sol.certain[cell] = v === 1 ? 1 : v === 2 ? 2 : 3;
      sol.probs[cell * 3 + (v === 1 ? 0 : v === 2 ? 1 : 2)] = 1;
    }
  }

  /* 未确定格子的精确边际 */
  for (let i = 0; i < m; i++) {
    const r = comps[i];
    const others = logConvolve(pre[i], suf[i + 1]);

    // waysOther 只取决于 (u,v)，而同一分量的所有格子共享同一组 (t,b) 取值，
    // 因此按 (u,v) 缓存：把 O(格子数 × 分布²) 降为 O(分布² + 格子数 × 分布)
    const wCache = new Map();
    const waysOther = (u, v) => {
      const ck = u * 1000 + v;
      const hit = wCache.get(ck);
      if (hit !== undefined) return hit;
      let lw = -Infinity;
      for (const [ok, lo] of others) {
        const ot = (ok / 1000) | 0, ob = ok % 1000;
        const lf = logWaysFree(u - ot, v - ob);
        if (lf === -Infinity) continue;
        lw = logAdd(lw, lo + lf);
      }
      wCache.set(ck, lw);
      return lw;
    };
    const weightSum = statMap => {
      let lw = -Infinity;
      for (const [key, lc] of statMap) {
        const t = (key / 1000) | 0, b = key % 1000;
        const u = Tg - t, v = Bg - b;
        if (u < 0 || v < 0) continue;
        const w = waysOther(u, v);
        if (w === -Infinity) continue;
        lw = logAdd(lw, lc + w);
      }
      return lw;
    };

    // 抽样近似时，样本里没出现过的取值会算出 0——那只是「没采到」，不是「不可能」。
    // 以采样分辨率 1/(2·got) 做下限，并封顶在 1e-3，避免下限本身把 ΣP 的总量顶偏。
    const eps = r.approx ? floorEps(r.got) : 0;
    for (let k = 0; k < r.undet.length; k++) {
      const cell = r.undet[k];
      const lT = weightSum(r.statT[k]);
      const lB = weightSum(r.statB[k]);
      const lE = weightSum(r.statE[k]);
      const lTot = logAdd(logAdd(lT, lB), lE);
      if (lTot === -Infinity) continue;
      let pT = Math.exp(lT - lTot), pB = Math.exp(lB - lTot), pE = Math.exp(lE - lTot);
      if (eps > 0) {
        pT = Math.max(pT, eps); pB = Math.max(pB, eps); pE = Math.max(pE, eps);
        const z = pT + pB + pE; pT /= z; pB /= z; pE /= z;
        sol.estimated[cell] = 1;
      }
      sol.probs[cell * 3]     = pT;
      sol.probs[cell * 3 + 1] = pB;
      sol.probs[cell * 3 + 2] = pE;
      // 「确定」只能来自精确枚举：抽样时所有样本恰好同值 ≠ 该值必然成立
      if (r.approx) continue;
      if (lTot - lT < 1e-9) sol.certain[cell] = 1;
      else if (lTot - lB < 1e-9) sol.certain[cell] = 2;
      else if (lTot - lE < 1e-9) sol.certain[cell] = 3;
    }
  }

  /* 自由格：彼此对称，概率 = 期望值 / 自由格数 */
  if (Ffree > 0) {
    const terms = [];
    let lwTot = -Infinity;
    for (const [key, la] of A) {
      const t = (key / 1000) | 0, b = key % 1000;
      const rt = Tg - t, rb = Bg - b;
      if (rt < 0 || rb < 0) continue;
      const lf = logWaysFree(rt, rb);
      if (lf === -Infinity) continue;
      const l = la + lf;
      terms.push([rt, rb, l]);
      lwTot = logAdd(lwTot, l);
    }
    let eT = 0, eB = 0;
    for (const [rt, rb, l] of terms) {
      const p = Math.exp(l - lwTot);
      eT += p * rt;
      eB += p * rb;
    }
    const pT = eT / Ffree, pB = eB / Ffree;
    const pE = Math.max(0, 1 - pT - pB);
    // 自由格的概率由「各分量的精确分布 + 组合数」推出；只要有任何分量是近似的，
    // 这里就不是精确值，也就不能据此宣称「确定」，同时要防它算出 0。
    const exactAll = !sol.approx && degraded.length === 0;
    let fpT = pT, fpB = pB, fpE = pE;
    if (!exactAll) {
      const g = minGot === Infinity ? Ffree : minGot;
      const eps = floorEps(g);
      fpT = Math.max(fpT, eps); fpB = Math.max(fpB, eps); fpE = Math.max(fpE, eps);
      const z = fpT + fpB + fpE; fpT /= z; fpB /= z; fpE /= z;
    }
    for (const i of unk) {
      if (inCon[i]) continue;
      sol.probs[i * 3] = fpT; sol.probs[i * 3 + 1] = fpB; sol.probs[i * 3 + 2] = fpE;
      if (!exactAll) { sol.estimated[i] = 1; continue; }
      if (pT > 1 - 1e-9) sol.certain[i] = 1;
      else if (pB > 1 - 1e-9) sol.certain[i] = 2;
      else if (pE > 1 - 1e-9) sol.certain[i] = 3;
    }
  }

  /* 无法分析的分量：用剩余区域的平均密度兜底，并标记为估算值 */
  if (degraded.length > 0) {
    sol.approx = true;
    // 已「用掉」的宝藏/炸弹：精确分量的确定值 + 其未确定格子的期望值 + 降级分量的确定值
    let usedT = 0, usedB = 0;
    for (const r of comps) {
      for (const v of r.fixed.values()) { if (v === 1) usedT++; else if (v === 2) usedB++; }
      for (const cell of r.undet) { usedT += sol.probs[cell * 3]; usedB += sol.probs[cell * 3 + 1]; }
    }
    for (const r of degraded) {
      for (const v of r.fixed.values()) { if (v === 1) usedT++; else if (v === 2) usedB++; }
    }
    const restN = Ffree;   // 自由格 + 降级分量中未确定的格子
    let pT = restN > 0 ? Math.max(0, T - usedT) / restN : 0;
    let pB = restN > 0 ? Math.max(0, B - usedB) / restN : 0;
    let pE = Math.max(0, 1 - pT - pB);
    // 密度估算同样可能算出 0（例如配额已被前面的分量「用尽」），
    // 但那只是估算值，不能当成「不可能」。下限取 1/(2·restN)。
    if (restN > 0) {
      const eps = floorEps(restN);
      pT = Math.max(pT, eps); pB = Math.max(pB, eps); pE = Math.max(pE, eps);
      const z = pT + pB + pE; pT /= z; pB /= z; pE /= z;
    }
    for (const r of degraded) {
      for (const cell of r.undet) {
        sol.probs[cell * 3] = pT; sol.probs[cell * 3 + 1] = pB; sol.probs[cell * 3 + 2] = pE;
        sol.estimated[cell] = 1;
      }
    }
    sol.degradedCount = degN;
  }

  sol.ms = performance.now() - t0;
}

/* ---- 「点开会连锁」的概率 ----
   引擎的三态模型是 宝藏 / 炸弹 / **非道具**。但"非道具"里混着两种东西：
     · 空地：周围 8 格没有任何道具 → 点开会**连锁翻开一大片**（边界数字格一起露出来）
     · 数字格：周围有道具 → 点了**只翻开这一格**
   两者对步数的影响差着量级，可三态模型分不出来（这就是"P空 高"其实没用：
   这张 18×18 盘上 260 个非道具格里只有 53 个是空地，81% 是数字格）。

   要单独算「点开会连锁」，判据是**这格和它周围 8 格都不是道具** ——
   因为只有 0 个相邻道具的格子才会触发连锁。
   已挖开的格是确定的：数字格/空白格 = 非道具（因子 1），
   已标注的宝藏/炸弹 = 道具（因子 0，直接归零）。
   剩下的用逐格边缘概率连乘近似（假设独立；排序够用，不当精确概率用）。

   **邻域全是已翻开格时必须归零。** 已翻开的格因子是 1（不拉低乘积），
   于是"周围一圈都已经翻开、只剩它自己"的格子会算出 pc ≈ 1，被打成最高分 ——
   可点它连锁进的是**已经翻开的地盘**，一个新格子都翻不出来，白费一步。
   （实测：125 步里 74 步被标成 cascade，真正连锁的只有 8 步。）
   所以要求**至少有一个未挖开的邻格**，否则连锁没有新增收益。

   还必须**在包装层调用，不能塞在 computeSolutionCore 末尾** ——
   那个函数有两个成功出口（正常路径 + 降级兜底路径，后者在 logZ === -Infinity 时提前 return），
   塞在末尾会让降级路径上 pCascade 是 undefined，表现是"推荐突然变回旧行为"。
   （上一版就踩了这个，靠"两个出口"那条教训改过来的。） */
function computeCascade() {
  const pc = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    if (cellState[i] !== UNKNOWN) continue;
    let v = sol.probs[i * 3 + 2];
    let nUnk = 0;
    for (const j of neighbors[i]) {
      const sj = cellState[j];
      if (sj === KT || sj === KB) { v = 0; break; }      // 邻格是道具 → 一定不连锁
      if (sj !== UNKNOWN) continue;                       // 已挖开的数字/空白 = 非道具，因子 1
      nUnk++;
      v *= sol.probs[j * 3 + 2];
    }
    pc[i] = nUnk > 0 ? v : 0;      // 邻域全是已知格 → 点了也翻不出新东西
  }
  sol.pCascade = pc;
}

/* ==================== 下一步推荐 ==================== */
/* 目标：**找到全部宝藏，步数越少越好**。两条游戏机制决定了规则：
     ① 点到炸弹**直接结束本局** —— 所以只要还有零风险格，就绝不能推风险格。
        这不是"风险偏好"问题，生存压倒一切。
     ② 点开空格会**连锁翻开一大片** —— 所以"点开会连锁"是实实在在的收益
        （一步换一大片线索），必须当成一等项，不能只当并列时的次要条件。
        **但注意用的是 `P连锁`，不是 `P空`** —— 见 computeCascade 上面那段。

   为什么"步数"会被浪费掉 —— 把每一步的三种结局摊开看：

     结局           这一步算不算浪费   带回什么
     挖到宝藏       不浪费（宝藏本来  什么信息都没有 —— 兔子只占掉一个配额，
                    就必须点）        不给邻域提示
     点开空地       浪费一步          **连锁翻一大片** → 一大堆数字格 → 大量线索
     点到数字格     浪费一步          只有一个提示

   总步数 = 宝藏数（每个宝藏都得自己点） + 浪费掉的步数。
   宝藏数是死的，所以真正要压的是**浪费步数**：让每一次"浪费"尽可能换回最多的信息。
   空地换回一大片，数字格只换回一个 —— 两者差着量级。

   **关键：不能拿 P空 当"点开会连锁"用。** 引擎的三态里"空"= 非道具，
   而这张 18×18 盘上 260 个非道具格里只有 53 个是真空地，另外 207 个是数字格。
   拿 P空 加权等于在奖励"点到数字格"，方向正好反了（实测：步数从 152 涨到 178）。
   所以求解器额外算了一个 `pCascade` = **这格和它 8 邻域都不是道具**的概率，
   那才是"点开会连锁"的概率。见 computeSolutionCore 末尾。

   排序规则（两层）：
     1) 零风险格（P弹 == 0）里挑 **score = P宝 + W_CASCADE × P连锁** 最高的。
        · P宝 高 = 这一步很可能直接拿到宝藏，等于没浪费。
        · P连锁 高 = 这一步很可能点开一片空地，一次连锁换回一大片信息。
        · 两者都是好结果；坏结果只有"点到一个普通数字格"。
        · P宝 = 1 时 score 必然最高，不用单独写分支。
        · W_CASCADE = 0 就退化成只看 P宝（旧行为）。
     2) 一个零风险格都没有 → 必须冒险。挑 **P弹 最小**的（生存优先），
        P弹 相同（±0.5pp）时再挑 score 最大的。

   为什么不按"期望收益"综合打分（比如 pt − λ·pb）：炸弹是**直接结束**，
   不是扣分。任何把 P弹 折成有限代价的加权，都是在给"赌一把"开绿灯，方向就错了。
   W_CASCADE 只作用在**零风险格内部**，不碰风险格，两者不是一回事。
*/
/* W_CASCADE 的取值是**在真值盘面上量出来的**，不是拍的：
   拿用户的通关截图还原出 18×18 真值（38 宝 / 26 炸 / 53 空地 / 207 数字格，
   207 个提示零矛盾），用 叠加器/模拟对局.js 把整局跑一遍数步数：
     W=0（只看 P宝，旧行为）152 步 → W∈[0.05, 0.5] 稳定 125 步（-18%）。
   平台很宽（0.05~0.5 全是 125），所以取中间值 0.3，对并列抖动不敏感。
   作弊上界（用真值排序、宝藏优先）是 123 步 —— 离 125 只差 2 步，
   说明**瓶颈已经不在排序上**了，继续加启发式收益极小。
   随机盘面的稳健性另见 叠加器/调权重.js（多档密度 × 多块盘面）。 */
let PICK_W_CASCADE = 0.3;
function pickScore(pt, pc) { return pt + PICK_W_CASCADE * pc; }

/* 死区过滤开关（默认开）。关掉**只为 A/B** —— 用来量"不过滤死区"要多花多少步，
   也给以后改这条规则的人留个对照。生产路径永远是 true。 */
let PICK_SKIP_DEAD = true;

/* ---- 「死区」：不可能再有宝藏的那一整片未知区域 ----
   未知格按 8 连通分组。约束是**局部**的（一个已翻开格只约束它周围 8 格），
   所以信息不会跨组流动 —— 某组里 P宝 全为 0，这组就再也翻不出宝藏。

   为什么必须排除掉：
     · **只要宝藏还没找齐，活区必然存在**：ΣP宝 = 剩余宝藏数 > 0，
       所以至少有一格的 P宝 > 0。也就是说死区**永远不该点**，这不是启发式。
       用户报的现象就是这个："一小片区域显然不会再有宝箱，算法还是推荐挖它"。
     · 白花的步是实测出来的：三块真值盘面上分别是 12 步 / 0 步 / 8 步
       （占探路的 10~14%）；80 块冻结盘面配对比，甲组 -7.1 步、乙组 -7.8 步
       （-5.8% / -6.3%，39:2 和 47:0 的胜负比），踩雷数一格没变。
       见 叠加器/诊断.js 的【死区】段、叠加器/配对.py。

   为什么之前会点进去：死区是大连通块，里面的格"未挖开邻格数"多，
   而平局次序（下面那个 nu）正是优先 nu 大的格 —— 上一轮加的次序把这个毛病放大了。

   只在解算**精确**时启用：近似/降级路径下 P宝 可能被算成 0 而其实是宝藏，
   那时把"全 0"当真会误杀。诊断脚本必须用同一个门槛，否则会把这种步记成
   "引擎点了死区"（第三张第 56 步踩过）。 */
function deadComponents() {
  const comp = new Int32Array(N).fill(-1);
  const dead = [];
  for (let i = 0; i < N; i++) {
    if (cellState[i] !== UNKNOWN || comp[i] >= 0) continue;
    const id = dead.length;
    let mx = 0;
    const q = [i]; comp[i] = id;
    while (q.length) {
      const t = q.pop();
      if (sol.probs[t * 3] > mx) mx = sol.probs[t * 3];
      for (const j of neighbors[t]) {
        if (cellState[j] === UNKNOWN && comp[j] < 0) { comp[j] = id; q.push(j); }
      }
    }
    dead.push(mx <= 1e-9);
  }
  return { comp, dead };
}

function pickNext() {
  if (!sol || !sol.ok) return null;
  const pcs = sol.pCascade || null;
  /* 死区过滤的启用条件：
       ① 开关开着；
       ② 解算**精确**（近似/降级路径下 P宝 可能被算成 0 而其实是宝藏，那时把"全 0"
          当真会误杀）；
       ③ **宝藏还没找齐**（Trest ≥ 1）。
     第 ③ 条是后加的（2026-09-25）：Trest === 0 时每一组的 P宝 都是 0，所有未知格都会被
     判成死区，于是 liveSafe 被剔空、退回原池，而 deadSkipped 照样累加，
     推荐理由就自相矛盾了 —— "推荐点这格" + "已跳过 N 个在'不可能再有宝藏'区域里的格"，
     而且 N 正好等于候选总数（实测 2x2 是 2/2、3x3 是 6/6）。
     "活区必然存在"这条论证本来就以 Trest ≥ 1 为前提（ΣP宝 = 剩余宝藏数 > 0），
     Trest === 0 时它不成立，过滤也就没有意义了 —— 此时所有格子的收益都是 0，
     只能退回原池照常给推荐。 */
  const deadInfo = (PICK_SKIP_DEAD && sol.Trest > 0 && !(sol.approx || sol.degradedCount))
    ? deadComponents() : null;
  const safe = [], risky = [];
  for (let i = 0; i < N; i++) {
    if (cellState[i] !== UNKNOWN) continue;
    const pt = sol.probs[i * 3], pb = sol.probs[i * 3 + 1], pe = sol.probs[i * 3 + 2];
    if (sol.certain[i] === 2) continue;            // 已证明是炸弹，永远不推
    const pc = pcs ? pcs[i] : 0;                   // 点开会连锁的概率
    let nu = 0;                                    // 未挖开的邻格数（平局时用）
    for (const j of neighbors[i]) if (cellState[j] === UNKNOWN) nu++;
    const dead = !!(deadInfo && deadInfo.dead[deadInfo.comp[i]]);
    (pb <= 1e-9 ? safe : risky).push({ i, pt, pb, pe, pc, nu, dead, est: !!sol.estimated[i] });
  }
  /* 两个池子都先剔掉死区格；万一剔光了（降级路径 / 宝藏已找齐）退回原池，
     不能给不出推荐。 */
  const liveSafe = safe.filter(c => !c.dead);
  const liveRisky = risky.filter(c => !c.dead);
  const pool = liveSafe.length ? liveSafe : safe;
  /* 有风险的池子也要剔死区，而且理由更强：死区里 P宝=0，赌赢了也拿不到任何东西、
     也推不出任何关于活区的信息（约束是局部的，死区那一片的约束已经全部确定），
     所以那是一次**纯亏的赌博** —— 只增加送命机会，不换来任何东西。
     唯一看着像理由的情形（"死区那格 P弹 更低、活下来再说"）也不成立：
     活下来之后局面没有任何改善，还是得在活区赌，只是多冒了一次险。
     而且 Trest ≥ 1（宝藏没找齐）时活区必然存在，永远不会落到"只能点死区"。 */
  const riskyPool = liveRisky.length ? liveRisky : risky;
  /* 只有**真的用了过滤后的池子**才算"跳过"。某个池子被剔空而退回原池时，
     那里的格子并没有被跳过 —— 把它们算进 deadSkipped 就会出现
     "推荐这格 + 已跳过这格"的自相矛盾（宝藏找齐那一步实测踩到过）。 */
  const deadSkipped = (liveSafe.length ? safe.length - liveSafe.length : 0)
                    + (liveRisky.length ? risky.length - liveRisky.length : 0);
  /* 零风险：按 score 降序。同分时先看 P宝，再看**未挖开邻格数**（多的优先）。
     平局时数组下标顺序（左上优先）是纯任意的，而平局里翻出的是哪一格数字，
     会决定后面能不能早点推出宝藏 —— 这个次序不是"无所谓"的。
     实测（叠加器/基准18.js，两组各 80 块冻结盘面，18×18/38宝/26弹，从零开局）：
       W=0.3 平均步数  甲组 146.72 → 123.13（-16.1%），乙组 145.98 → 123.90（-15.1%）
       两张真值盘面：第一张 125 → 124，第二张 136 → 101
     踩雷数没有变差；求解耗时平均 1.3ms、最慢 7.8ms（真值盘面），叠加器刷新不会卡。
     注意 nu **只能当平局次序**，不能给权重：infoGain 策略（纯按 nu 排）要 161/172 步，很差。 */
  pool.sort((a, b) => (pickScore(b.pt, b.pc) - pickScore(a.pt, a.pc))
    || (b.pt - a.pt) || (b.nu - a.nu));
  // 有风险：P弹 升序（生存优先），相近时 score 降序
  riskyPool.sort((a, b) => (a.pb - b.pb) || (pickScore(b.pt, b.pc) - pickScore(a.pt, a.pc)));

  let p = pool[0];
  if (p) {
    /* 四种"零风险"的情形分开报，别混成一句话：
         certainT —— 求解器证明是宝藏
         safeT    —— 可能出宝藏（P宝 > 0 且不低于 P连锁）
         cascade  —— P连锁 更大，图的是翻一片
         probe    —— P宝 = P连锁 = 0：**既不出宝藏也不连锁**，纯粹为了多一条线索。
                    这一种在残局很常见（活区里剩下的全是"已证明非道具"的格），
                    以前归到 safeT 里，面板上会显示"零风险，0.0% 是宝藏"，
                    看着像在推荐一步毫无意义的棋 —— 其实它是有用的（见下面 reason）。 */
    p.kind = (p.pt > 1 - 1e-9) ? 'certainT'
      : (p.pt > 0 && p.pt >= p.pc) ? 'safeT'
        : (p.pc > 0) ? 'cascade' : 'probe';
  } else {
    p = riskyPool[0];
    if (p) p.kind = 'risky';
  }
  if (!p) return null;

  const pct = v => (v * 100).toFixed(1) + '%';
  let reason;
  if (p.kind === 'certainT') {
    reason = '确定是宝藏，直接挖';
  } else if (p.kind === 'cascade') {
    reason = '零风险（不可能是炸弹），' + pct(p.pc) + ' 会连锁翻开一片空地'
           + ' —— 一步换一大片线索（' + pct(p.pt) + ' 是宝藏）';
  } else if (p.kind === 'safeT') {
    reason = '零风险（不可能是炸弹），' + pct(p.pt) + ' 是宝藏';
    if (p.pc >= 0.05) reason += '，还有 ' + pct(p.pc) + ' 会连锁翻一片';
  } else if (p.kind === 'probe') {
    reason = '零风险，但这格既不出宝藏也不连锁 —— 它是"已证明非道具"里的一条线索：'
           + '点开它能看到数字，给旁边的未知格补上约束（没有更好的棋时才走这种）';
  } else {
    reason = '没有零风险格了，这格炸弹概率最低（' + pct(p.pb) + '），但点到炸弹会直接结束';
  }
  if (p.est) reason += '（估算值，非精确概率）';
  if (deadSkipped > 0) {
    reason += '（已跳过 ' + deadSkipped + ' 个在"不可能再有宝藏"区域里的格）';
  }
  if (sol.fallback) reason = '约束过复杂，只能按平均密度估，参考价值有限：' + reason;

  return {
    i: p.i, gx: p.i % W, gy: (p.i / W) | 0, kind: p.kind,
    pt: p.pt, pb: p.pb, pe: p.pe, pc: p.pc,
    estimated: p.est,
    safeLeft: safe.length, riskyLeft: risky.length,
    deadSkipped,
    reason,
  };
}

/* 两个成功出口（正常路径 + 降级兜底路径）都要带上推荐与连锁概率。包一层，
   免得以后再加出口时漏掉 —— 漏掉的表现是"推荐凭空消失"或"悄悄退回旧行为"，很难查。 */
function computeSolution() {
  computeSolutionCore();
  if (sol.ok) computeCascade();
  sol.next = pickNext();
}


/* ==================== 自动标注器 · 字形识别 ==================== */
/* 思路：格子内部取彩色像素 -> 连通域挑出字形 -> 归一化成"行/列投影剖面 + 长宽比 + 孔洞数"
   再跟多字体模板集成取最小距离。剖面归一化后抗字重/抗字号，孔洞数负责区分 0/6/8/9 与 1/2/3/4/5/7。 */
const ANN_FONTS = ['Arial', 'Helvetica', 'Verdana', 'Tahoma', '"Segoe UI"', '"Trebuchet MS"',
  'Calibri', 'Roboto', '"Microsoft YaHei"', '"Arial Black"', '"Noto Sans"', 'sans-serif',
  'Georgia', '"Comic Sans MS"', 'Candara', '"Malgun Gothic"', '"Yu Gothic"', 'Meiryo',
  'Impact', '"Franklin Gothic Medium"', 'Consolas'];
const ANN_WEIGHTS = [400, 600, 700, 800];
const ANN_ROW = 20, ANN_COL = 14, ANN_TPL_PX = 62;
/* 2D 粗网格的尺寸。行/列投影各自只有 20 / 14 个标量，丢掉了"笔画摆在格子哪儿"的信息；
   加一层占用网格后，形状相近但布局不同的字形（最典型：开口 4 与闭口 4）才分得开。 */
const ANN_GR = 10, ANN_GC = 8;
let annTpl = null, annTplMs = 0;

function annFeatures(on, w, minX, minY, maxX, maxY) {
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const row = new Float64Array(ANN_ROW), col = new Float64Array(ANN_COL);
  // 按比例精确重采样成固定长度剖面（不要用 floor 分箱：字形高度与模板不同时会引入量化偏差，
  // 曾把"2"的底横压低导致误判成"3"）
  for (let i = 0; i < ANN_ROW; i++) {
    let y = Math.round((i + 0.5) * bh / ANN_ROW - 0.5);
    if (y < 0) y = 0; else if (y >= bh) y = bh - 1;
    const base = (minY + y) * w + minX;
    let c = 0;
    for (let x = 0; x < bw; x++) if (on[base + x]) c++;
    row[i] = c / bw;
  }
  for (let i = 0; i < ANN_COL; i++) {
    let x = Math.round((i + 0.5) * bw / ANN_COL - 0.5);
    if (x < 0) x = 0; else if (x >= bw) x = bw - 1;
    let c = 0;
    for (let y = 0; y < bh; y++) if (on[(minY + y) * w + minX + x]) c++;
    col[i] = c / bh;
  }
  let mr = 1e-9, mc = 1e-9;
  for (let i = 0; i < ANN_ROW; i++) if (row[i] > mr) mr = row[i];
  for (let i = 0; i < ANN_COL; i++) if (col[i] > mc) mc = col[i];
  for (let i = 0; i < ANN_ROW; i++) row[i] /= mr;
  for (let i = 0; i < ANN_COL; i++) col[i] /= mc;

  // 2D 占用网格（每个格子取该区域被笔迹覆盖的比例，不做归一化——覆盖率本身就是信息）
  const grid = new Float64Array(ANN_GR * ANN_GC);
  for (let gy = 0; gy < ANN_GR; gy++) {
    const ya = Math.floor(gy * bh / ANN_GR);
    const yb = Math.max(ya + 1, Math.floor((gy + 1) * bh / ANN_GR));
    for (let gx = 0; gx < ANN_GC; gx++) {
      const xa = Math.floor(gx * bw / ANN_GC);
      const xb = Math.max(xa + 1, Math.floor((gx + 1) * bw / ANN_GC));
      let n = 0, t = 0;
      for (let y = ya; y < yb; y++) {
        const base = (minY + y) * w + minX;
        for (let x = xa; x < xb; x++) { t++; if (on[base + x]) n++; }
      }
      grid[gy * ANN_GC + gx] = t ? n / t : 0;
    }
  }

  const get = (x, y) => on[(minY + y) * w + (minX + x)];
  const seen = new Uint8Array(bw * bh);
  const st = [];
  for (let x = 0; x < bw; x++) { st.push(x, 0, x, bh - 1); }
  for (let y = 0; y < bh; y++) { st.push(0, y, bw - 1, y); }
  while (st.length) {
    const yy = st.pop(), xx = st.pop();
    if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
    const id = yy * bw + xx;
    if (seen[id] || get(xx, yy)) continue;
    seen[id] = 1;
    st.push(xx + 1, yy, xx - 1, yy, xx, yy + 1, xx, yy - 1);
  }
  let holes = 0;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const id = y * bw + x;
    if (seen[id] || get(x, y)) continue;
    holes++;
    seen[id] = 1;
    const q = [x, y];
    while (q.length) {
      const b2 = q.pop(), a2 = q.pop();
      for (let k = 0; k < 4; k++) {
        const nx = a2 + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = b2 + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const nid = ny * bw + nx;
        if (seen[nid] || get(nx, ny)) continue;
        seen[nid] = 1; q.push(nx, ny);
      }
    }
  }
  return { row, col, grid, aspect: bw / bh, holes: Math.min(holes, 2) };
}

function annDist(a, b) {
  let s = 0;
  for (let i = 0; i < ANN_ROW; i++) { const d = a.row[i] - b.row[i]; s += d * d; }
  for (let i = 0; i < ANN_COL; i++) { const d = a.col[i] - b.col[i]; s += d * d; }
  /* 孔洞数只当弱先验（0.10），不能当主判据。
     理由：小字号下孔洞本来就不可靠——一个"闭口 4"左上角那个 2×5 的小孔
     会在二值化时糊掉，而"开口 4"本来就没有孔。
     实测：真机截图里的开口 4（孔洞 0）到 84 个模板的距离全被这一项顶高
     （模板库里 84 个"4"全是闭口、孔洞 1），光这一项就贡献 0.30，
     把剖面距离只有 0.145 的正确模板压成了 0.455，反而输给 7（0.328）。
     真正该区分形状的活儿交给 2D 网格。 */
  let g = 0;
  for (let i = 0; i < ANN_GR * ANN_GC; i++) { const d = a.grid[i] - b.grid[i]; g += d * d; }
  g /= (ANN_GR * ANN_GC);
  s /= (ANN_ROW + ANN_COL);
  return Math.sqrt(0.5 * s + 0.5 * g)
    + Math.min(2, Math.abs(a.aspect - b.aspect)) * 0.35
    + Math.abs(a.holes - b.holes) * 0.10;
}

function annBuildTemplates() {
  if (annTpl) return annTpl;
  const t0 = performance.now();
  const S = 112;
  const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const out = [];
  for (const f of ANN_FONTS) {
    for (const wt of ANN_WEIGHTS) {
      const set = [];
      let ok = true;
      for (let d = 0; d <= 8; d++) {
        cx.fillStyle = '#000'; cx.fillRect(0, 0, S, S);
        cx.fillStyle = '#fff';
        cx.font = wt + ' ' + ANN_TPL_PX + 'px ' + f;
        cx.textAlign = 'center'; cx.textBaseline = 'middle';
        cx.fillText(String(d), S / 2, S / 2);
        const id = cx.getImageData(0, 0, S, S);
        const on = new Uint8Array(S * S);
        let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const i = y * S + x;
          if (id.data[i * 4] > 128) {
            on[i] = 1;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
        if (maxX < 0) { ok = false; break; }
        set.push(annFeatures(on, S, minX, minY, maxX, maxY));
      }
      if (ok) out.push(set);
    }
  }
  annTpl = out;
  annTplMs = performance.now() - t0;
  return annTpl;
}

/* 返回 {d, conf, gap}：conf 越大越可信（模板集成的最小距离取负，再归一化） */
function annRecognize(on, w, minX, minY, maxX, maxY) {
  const tpl = annBuildTemplates();
  const f = annFeatures(on, w, minX, minY, maxX, maxY);
  const ds = [];
  for (let d = 0; d <= 8; d++) {
    let cd = Infinity;
    for (const set of tpl) {
      const dd = annDist(f, set[d]);
      if (dd < cd) cd = dd;
    }
    ds.push(cd);
  }
  let best = 0, second = Infinity;
  for (let d = 1; d <= 8; d++) if (ds[d] < ds[best]) best = d;
  for (let d = 0; d <= 8; d++) if (d !== best && ds[d] < second) second = ds[d];
  const gap = second - ds[best];
  const conf = clamp(gap / 0.12, 0, 1) * clamp((0.30 - ds[best]) / 0.30, 0, 1);
  return { d: best, dist: ds[best], gap, conf, all: ds };
}

/* ==================== 自动标注器 · 棋盘识别 ==================== */
/* 1) 用图像外圈中位色当背景，取前景外接矩形 -> 棋盘区域（再向内收缩掉散点）
   2) 按边长均分 N×N，取每格"内部区域"（缩进 13%，避开格线/立体高光）算平均亮度
   3) Otsu 把格子分成"已挖开（暗）/ 未挖开（亮）"
   4) 已挖开格：内部取饱和像素 -> 连通域挑最大竖向分量当字形 -> 色相定类型、形状定数字 */
const ANN_INSET = 0.13;
const ANN_SAT = 55, ANN_VAL = 60;
let annChainDbg = null;      // chain() 最近一次拟合结果（调试用）

/* 棋盘定位：找格线而不是找格子。
   格线所在的行/列，"格子色像素数"会掉到接近 0，形成一串低谷；把它们串成等距栅格，
   既得到精确的格子边界，也直接得到边长（格线数 - 1）。
   好处：不依赖外圈是否已挖开，也不依赖明暗主题。 */
function annDetectGrid(id, iw, ih, want) {
  const N0 = iw * ih;
  const lum = new Float64Array(N0);
  for (let i = 0; i < N0; i++) {
    lum[i] = 0.299 * id.data[i * 4] + 0.587 * id.data[i * 4 + 1] + 0.114 * id.data[i * 4 + 2];
  }
  // 页面底色（外圈 3px 中位数）与格子色（全图亮度众数，棋盘占画面主体）
  const edge = [];
  for (let x = 0; x < iw; x++) {
    for (let k = 0; k < 3; k++) { edge.push(lum[k * iw + x]); edge.push(lum[(ih - 1 - k) * iw + x]); }
  }
  for (let y = 0; y < ih; y++) {
    for (let k = 0; k < 3; k++) { edge.push(lum[y * iw + k]); edge.push(lum[y * iw + iw - 1 - k]); }
  }
  edge.sort((a, b) => a - b);
  const bgLum = edge[edge.length >> 1];

  const RB = 64;
  const hist = new Int32Array(RB);
  let kept = 0;
  const fillHist = skipPage => {
    hist.fill(0); kept = 0;
    for (let i = 0; i < N0; i++) {
      if (skipPage && Math.abs(lum[i] - bgLum) < 10) continue;
      hist[Math.min(RB - 1, (lum[i] * RB / 256) | 0)]++;
      kept++;
    }
  };
  // 格子色 = 全图亮度众数，但先排除"贴近页面底色"的像素：浅色主题下白底与浅灰格子
  // 只差 30 出头，棋盘若大部分被挖开，白底 + 已挖开格会跟格子抢众数，把 cellLum 带偏。
  fillHist(true);
  if (kept < N0 * 0.4) fillHist(false);     // 排除过头（棋盘铺满整幅画面）-> 退回原始直方图
  let mi = 0, bw = -1;
  for (let b = 0; b < RB; b++) {
    const s = hist[b] + (b > 0 ? hist[b - 1] * 0.5 : 0) + (b + 1 < RB ? hist[b + 1] * 0.5 : 0);
    if (s > bw) { bw = s; mi = b; }
  }
  let cellLum = (mi + 0.5) * 256 / RB;
  if (bw < kept * 0.15) {                   // 众数不够集中 -> 退回中位数
    let acc = 0;
    for (let b = 0; b < RB; b++) { acc += hist[b]; if (acc >= kept * 0.5) { cellLum = (b + 0.5) * 256 / RB; break; } }
  }
  // 容差跟"格子色与底色的距离"挂钩：浅色主题下白底与浅灰格子只差 30 多，
  // 固定容差会把边距误当成格子（曾经踩过）。**现在只留作诊断输出** ——
  // 真正的板面判据见下面「板面像素」那一段（单色 + 容差会随游戏进度翻转）。
  const TOL = clamp(0.5 * Math.abs(cellLum - bgLum), 14, 80);

  /* ---- 「板面像素」的判据：落在**任何一个格子色**附近，而不是"贴近某一个格子色" ----
     为什么必须多色（2026-09-25 真机复现）：
     棋盘从"几乎全未挖开"走到"几乎全挖开"时，亮度众数会在盖色与已挖开色之间翻转
     （真机实测 154 ↔ 54），而容差又是按"到页面底色的距离"给的（14~80）。
     当页面底色恰好夹在两种格子色中间时（真机 65 夹在 52 与 148 之间），
     **任何单一容差都盖不住两种格子色** —— 盖住已挖开色就漏掉盖色，反之亦然。

     后果不是"识别变糊"，而是**板面范围直接缩水**：
     拿真机图把右侧两列整条涂成"已挖开"（模拟挖开十几二十格之后），
     extC 从 0 跳到 42（正好一格宽），栅格外推丢掉最左侧那条格线，
     18×18 直接数成 **17×18**，整个棋盘错位、识别结果全废。
     用户侧的表现就是"挖开十几二十格之后识别就不对了，重新框选一次才好"
     —— 重新框选换了裁切，众数翻回盖色，于是又对了。

     所以这里改成多色判据：把直方图里所有成规模的峰都当格子色，
     板面范围就不再随"哪一色占多数"漂移。 */
  const MODE_GAP = 12;                            // 亮度差超过它就算两种格子色
  const MODE_MIN = Math.max(4, Math.round(N0 * 0.002));
  const centers = [];
  for (let b = 0; b < RB; b++) {
    if (hist[b] < MODE_MIN) continue;
    const v = (b + 0.5) * 256 / RB;
    const t = centers[centers.length - 1];
    if (t && v - t.hi <= MODE_GAP) {
      t.v = (t.v * t.n + v * hist[b]) / (t.n + hist[b]);
      t.hi = v; t.n += hist[b];
    } else {
      centers.push({ lo: v, hi: v, v, n: hist[b] });
    }
  }
  const cellColors = centers;
  // 每档的容差 = 到"最近邻档"距离的一半（不超过 30）。用"最近邻"而不是"到底色"，
  // 是为了不让两个相邻格子色互相吞并 —— 真机上 52 与 65 只差 13，半程 6.5 刚好分开。
  //
  // **页面底色必须也算一个"邻档"**：它不在直方图里（上面按 <10 剔掉了），但它就贴在
  // 格子色旁边（真机底色 65、已挖开色 52，只差 13）。容差一放大就会把它吞回来，
  // 于是每一行/列都"是板面"，低谷全消失、格线一条也找不到（改这版时立刻踩到：
  // 容差按"到最近中心的一半"给到 30，边框整圈被判成板面，直接报"没找到棋盘格线"）。
  for (const t of centers) {
    let near = Infinity;
    for (const u of centers) {
      if (u === t) continue;
      const dd = Math.abs(u.v - t.v);
      if (dd < near) near = dd;
    }
    const dBg = Math.abs(bgLum - t.v);
    if (dBg > 1e-6 && dBg < near) near = dBg;
    t.tol = near < Infinity ? Math.max(2.5, Math.min(30, near / 2)) : 30;
  }
  // 一档都没找到（退化图）→ 退回原来的单色判据，保持旧行为
  const isCellLum = cellColors.length
    ? (v => { for (let i = 0; i < cellColors.length; i++) if (Math.abs(v - cellColors[i].v) <= cellColors[i].tol) return true; return false; })
    : (v => Math.abs(v - cellLum) <= TOL);

  /* 两套计数，用途不同：
       rowC/colC   —— **单色**（贴近 cellLum）。findRuns 靠"低谷"找格线，必须用
                      格子色当参考：格线本身是另一种颜色，所以格线处计数才会掉下去。
                      若把格线颜色也算进"板面"，低谷就全没了（踩过：colRuns 从 30 段
                      掉到 1 段，直接报"没找到棋盘格线"）。
       rowCA/colCA —— **多色**（落在任一格子色附近）。只用来定板面范围 extR/extC。 */
  const rowC = new Int32Array(ih), colC = new Int32Array(iw);
  const rowCA = new Int32Array(ih), colCA = new Int32Array(iw);
  for (let y = 0; y < ih; y++) {
    const base = y * iw;
    let n = 0, na = 0;
    for (let x = 0; x < iw; x++) {
      const v = lum[base + x];
      if (Math.abs(v - cellLum) <= TOL) n++;
      if (isCellLum(v)) na++;
    }
    rowC[y] = n; rowCA[y] = na;
  }
  for (let x = 0; x < iw; x++) {
    let n = 0, na = 0;
    for (let y = 0; y < ih; y++) {
      const v = lum[y * iw + x];
      if (Math.abs(v - cellLum) <= TOL) n++;
      if (isCellLum(v)) na++;
    }
    colC[x] = n; colCA[x] = na;
  }
  // 棋盘范围 = "格子色像素成片出现"的那些行/列。格线只可能落在这个范围里（边界外一格），
  // 用它把页面留白之类的假低谷段挡在栅格拟合之外——否则它们会被当成格线内点，
  // 把相位带偏（真机截图上曾把 18×18 数成 18×17）。
  //
  // **范围必须用多色计数（rowCA/colCA）**：单色计数会随"哪一色占多数"漂移，
  // 挖开十几二十格之后板面范围会缩成"多数派区域的包围盒"，最外侧格线被丢掉
  // （真机实测：右侧两列整条挖开 → extC 从 0 跳到 42 → 18×18 数成 17×18）。
  const cutOf = arr => { let mx = 0; for (let i = 0; i < arr.length; i++) if (arr[i] > mx) mx = arr[i]; return Math.max(3, mx * 0.2); };
  const cutR = cutOf(rowC), cutC = cutOf(colC);
  const extentOf = (arr, cut) => {
    const th = Math.max(2, cut * 0.1);
    let a = -1, b = -1;
    for (let i = 0; i < arr.length; i++) if (arr[i] > th) { if (a < 0) a = i; b = i; }
    return a < 0 ? null : { a, b };
  };
  const extR = extentOf(rowCA, cutOf(rowCA)) || { a: 0, b: ih - 1 };
  const extC = extentOf(colCA, cutOf(colCA)) || { a: 0, b: iw - 1 };

  // 低谷 = 格线。用"段内最暗的那一行/列"精确定位（比取段中点稳：
  // 贴边界的低谷常常把页边距和边界格线连成一段）。
  const rowMean = new Float64Array(ih), colMean = new Float64Array(iw);
  for (let y = 0; y < ih; y++) {
    let s = 0; const b = y * iw;
    for (let x = 0; x < iw; x++) s += lum[b + x];
    rowMean[y] = s / iw;
  }
  for (let x = 0; x < iw; x++) {
    let s = 0;
    for (let y = 0; y < ih; y++) s += lum[y * iw + x];
    colMean[x] = s / ih;
  }
  // 每行/列"不均匀度"：在中部 70% 范围内，偏离该行众数亮度 > 35 的像素占比。
  // 真格线整行都是均匀的格线色（≈0）；而"格子带内部被数字字形压出来的假极小行"
  // 必然夹着字形像素，必然不均匀。这一条是把假极小挡掉的关键闸门
  // （合成测试里 dark 主题 + 一半格子挖开时，假极小会把边长数成两倍）。
  // 只取中部 70%：页面留白与格线色差很大，整行统计会把真格线也判成"不均匀"。
  const DEV_LUM = 35, DEV_A = 0.15, DEV_B = 0.85;
  const rowDev = new Float64Array(ih), colDev = new Float64Array(iw);
  for (let y = 0; y < ih; y++) {
    const base = y * iw, x0 = Math.round(iw * DEV_A), x1 = Math.round(iw * DEV_B);
    const h = new Int32Array(64);
    for (let x = x0; x < x1; x++) h[Math.min(63, (lum[base + x] * 64 / 256) | 0)]++;
    let mi = 0; for (let b = 1; b < 64; b++) if (h[b] > h[mi]) mi = b;
    const c = (mi + 0.5) * 4;
    let n = 0;
    for (let x = x0; x < x1; x++) if (Math.abs(lum[base + x] - c) > DEV_LUM) n++;
    rowDev[y] = n / Math.max(1, x1 - x0);
  }
  for (let x = 0; x < iw; x++) {
    const y0 = Math.round(ih * DEV_A), y1 = Math.round(ih * DEV_B);
    const h = new Int32Array(64);
    for (let y = y0; y < y1; y++) h[Math.min(63, (lum[y * iw + x] * 64 / 256) | 0)]++;
    let mi = 0; for (let b = 1; b < 64; b++) if (h[b] > h[mi]) mi = b;
    const c = (mi + 0.5) * 4;
    let n = 0;
    for (let y = y0; y < y1; y++) if (Math.abs(lum[y * iw + x] - c) > DEV_LUM) n++;
    colDev[x] = n / Math.max(1, y1 - y0);
  }
  const findRuns = (cntArr, mean, dev, len, cut) => {
    const DEV_TOL = 0.05;
    const out = [];
    let s = -1;
    for (let i = 0; i <= len; i++) {
      const d = i < len && cntArr[i] < cut;
      if (d) { if (s < 0) s = i; continue; }
      if (s < 0) continue;
      const a = s, b = i - 1;
      s = -1;
      // 段内找"局部极小且至少一侧明显下凹"的位置当格线。
      // 一条格子带整条被挖开时，多个格线会连成一段，取段内最暗一行会漏掉后面的格线，
      // 所以这里找全部局部极小；而整条挖开的格子带本身是平坦的，不会被误取。
      const cand = [];
      for (let y = a; y <= b; y++) {
        if (dev[y] > DEV_TOL) continue;      // 该行夹着字形像素 -> 不是格线（见上面 rowDev 的说明）
        let isMin = true;
        for (let k = Math.max(a, y - 2); k <= Math.min(b, y + 2); k++) {
          if (mean[k] < mean[y] - 0.5) { isMin = false; break; }
        }
        if (!isMin) continue;
        const dl = y - 3 >= a ? mean[y - 3] - mean[y] : -1e9;
        const dr = y + 3 <= b ? mean[y + 3] - mean[y] : -1e9;
        if (Math.max(dl, dr) < 2) continue;
        cand.push(y);
      }
      const merged = [];
      for (const y of cand) {
        if (merged.length && y - merged[merged.length - 1] <= 3) {
          if (mean[y] < mean[merged[merged.length - 1]]) merged[merged.length - 1] = y;
        } else merged.push(y);
      }
      if (merged.length) { for (const y of merged) out.push({ pos: y, w: 3 }); continue; }
      // 段内没有下凹 -> 贴边界的段兜底取最暗行（页边距与边界格线同色时靠这条），
      // 细段也兜底；宽的内段判定为"整条格子带被挖开"，丢弃。
      if (a === 0 || b === len - 1 || (b - a + 1) <= 12) {
        let pos = -1, best = Infinity;
        for (let k = a; k <= b; k++) if (dev[k] <= DEV_TOL && mean[k] < best) { best = mean[k]; pos = k; }
        if (pos < 0) {                       // 段内全是字形行 -> 退回最暗行
          best = Infinity;
          for (let k = a; k <= b; k++) if (mean[k] < best) { best = mean[k]; pos = k; }
        }
        out.push({ pos, w: b - a + 1 });
      }
    }
    return out;
  };
  // 串成等距栅格。格线本身严格等距，但低谷检测会混进杂点（整条格子带被挖开、
  // 数字字形的暗行、格线高光…），所以不能用"最长连续链"——一个杂点就能把链截断，
  // 尾巴上的格线全丢（曾经把 18×18 数成 18×15）。
  // 改为在 (锚点, 步长) 上做鲁棒拟合：枚举所有点对当候选 -> 打分 -> 用内点最小二乘微调
  // -> 按棋盘范围把整条栅格补齐（漏检的格线、以及只有倒角没有暗分隔条的边界格线都能补回来）。
  //
  // 打分 = F1 − 2×(残差/步长)：
  //   F1 负责"别用更细的步长去硬套杂点"（查准）+"别在栅格上留缺位"（查全）；
  //   残差项负责"步长差一点点"的伪栅格——靠 22% 的宽容差它也能全覆盖，
  //   但真格线的残差是亚像素级，伪栅格大一个量级。这一项同时把半格/三分格挡掉
  //   （同样的像素噪声占更小步长的比例更大）。
  const chain = (runs, ext, want, stepHint) => {
    if (!runs || runs.length < 3) return null;
    const P = runs.map(r => r.pos);
    const n = P.length;
    const lo = Math.min(ext.a, P[0]), hi = Math.max(ext.b, P[n - 1]);
    const REL = 0.22, EXT = 0.4;
    let best = null;
    /* 候选步长怎么来：对每个低谷段点对 (i,j)，距离是 P[j]-P[i]，
       而这两段之间隔了 m 条格线 —— m 取 1..(j-i) 全试一遍。

       这里踩过一次，别改回去：早先只试 m = j-i，等于**假设低谷段和格线一一对应**。
       可低谷段比格线多（数字字形的暗列、格子纹理、宽段兜底取值都会多出杂点段），
       于是一张 18×18 的图里出现 30 段低谷、真格线只有 19 条，
       点对的索引差普遍大于格线差 —— 真实格距 43.5 压根没被枚举到，
       最后选中了步长 21.75 的"半格栅格"，把 18 列数成了 36 列，
       整个棋盘从中间劈开，识别结果全废（求解报"已标记 82 个炸弹，超过总数"）。

       放宽到 m 遍历 1..(j-i) 之后，真实格距就能被枚举到，而且得分明显更高
       （同一张图：43.5 得 0.8385，21.75 只有 0.7075）。
       代价是候选数从 O(n²) 涨到 O(n³/6)，所以下面加了一层去重。 */
    const seen = new Set();
    for (let j = 1; j < n; j++) {
      for (let i = 0; i < j; i++) {
        const dist = P[j] - P[i];
        for (let m = 1; m <= j - i; m++) {
          const step = dist / m;
          if (!(step >= 5)) continue;
          // stepHint：只在提示格距附近找。给"半格退化"的轴重拟合时用（见下面两轴一致性那段）。
          if (stepHint && Math.abs(step - stepHint) / stepHint > 0.15) continue;
          // 同一个锚点 + 近似步长只算一次（不同 m 经常给出几乎一样的步长）
          const key = i * 1e6 + Math.round(step * 8);
          if (seen.has(key)) continue;
          seen.add(key);
          const tol = Math.max(2, step * REL);
          let hit = 0, se = 0;
          for (let k = 0; k < n; k++) {
            const t = (P[k] - P[i]) / step;
            const r = Math.abs(t - Math.round(t)) * step;
            if (r <= tol) { hit++; se += r * r; }
          }
          if (hit < 3) continue;
          const rms = Math.sqrt(se / hit);
          const kMin = Math.ceil((lo - P[i]) / step - EXT);
          const kMax = Math.floor((hi - P[i]) / step + EXT);
          const lines = kMax - kMin + 1;
          if (lines < 3) continue;
          const prec = hit / n, rec = Math.min(1, hit / lines);
          const score = 2 * prec * rec / (prec + rec) - 2 * (rms / step);
          // 设定边长（用户填的棋盘边长）只当并列时的优先项，不当硬约束：
          // 若没有任何候选符合它，说明识别结果和设定不符，界面照常给告警。
          const wantOk = (want && lines === want + 1) ? 1 : 0;
          if (!best || score > best.score + 1e-9 ||
              (Math.abs(score - best.score) <= 1e-9 && wantOk > best.wantOk) ||
              (Math.abs(score - best.score) <= 1e-9 && wantOk === best.wantOk && step > best.step)) {
            best = { i, step, hit, lines, rms, score, wantOk };
          }
        }
      }
    }
    if (!best) return null;
    annChainDbg = best;
    // 内点最小二乘微调：pos = phase + k*step（消掉整步取整带来的漂移）
    const tol = Math.max(2, best.step * REL);
    const ks = [], ps = [];
    for (let k = 0; k < n; k++) {
      const t = (P[k] - P[best.i]) / best.step;
      const kk = Math.round(t);
      if (Math.abs(t - kk) * best.step <= tol) { ks.push(kk); ps.push(P[k]); }
    }
    if (ks.length < 3) return null;
    let kBar = 0, pBar = 0;
    for (let m = 0; m < ks.length; m++) { kBar += ks[m]; pBar += ps[m]; }
    kBar /= ks.length; pBar /= ps.length;
    let num = 0, den = 0;
    for (let m = 0; m < ks.length; m++) {
      const dk = ks[m] - kBar;
      num += dk * (ps[m] - pBar); den += dk * dk;
    }
    const step = den > 1e-9 ? num / den : best.step;
    if (!(step >= 5)) return null;
    const phase = pBar - step * kBar;
    annChainDbg = Object.assign({}, best, { stepRef: step, phase, inliers: ks.length });
    // EXT 让栅格能往外多推 0.4 格：棋盘边界常常只有倒角高光、没有暗分隔条，
    // 靠这一步把最外侧那条格线补回来（真机截图上就是这条把 18×17 救回 18×18）。
    const kMin = Math.ceil((lo - phase) / step - EXT);
    const kMax = Math.floor((hi - phase) / step + EXT);
    const out = [];
    for (let k = kMin; k <= kMax; k++) {
      // 不要在这里按 hi 截断：外推出来的最外侧格线本来就落在低谷段范围之外
      // （棋盘边界常常只有倒角高光），截断会把最后一条格线丢掉（曾把 18×18 数成 18×17）。
      out.push({ pos: Math.round(phase + k * step), w: 1 });
    }
    return out.length >= 3 ? out : null;
  };
  // 棋盘范围只用来给栅格"外推"定界（见 chain 里的 lo/hi），不过滤低谷段：
  // 底部格子带整条被挖开时 rowC 会掉到 0，棋盘范围会缩掉一整行，过滤会误杀最外侧格线。
  const rowRuns = findRuns(rowC, rowMean, rowDev, ih, cutR);
  const colRuns = findRuns(colC, colMean, colDev, iw, cutC);
  let rl = chain(rowRuns, extR, want); let dbgRow = annChainDbg;
  let cl = chain(colRuns, extC, want); let dbgCol = annChainDbg;

  /* 两轴的格距必须一致 —— 扫雷棋盘的格子是正方形。
     这条不变量专门挡"半格退化"：某个轴的投影里混进杂点后（数字字形的暗列最典型），
     栅格拟合会选到步长只有一半的"半格栅格"。半格栅格把所有真格线和所有杂点都解释了，
     分数比真栅格**还高** —— 单看那一个轴的投影没有任何办法分辨
     （真机踩过：18×18 数成 36×18，棋盘从中间劈开，求解报"已标记 82 个炸弹，超过总数 26"）。

     所以退化的那个轴不靠自己判断，交给另一个轴来定：
     细轴的格距若是粗轴的 1/2、1/3…（整数倍关系），就认定它退化了，
     用粗轴的格距在 ±15% 内重拟合一次。
     只在整数倍关系上动手，是为了不误伤正常的等距棋盘 —— 两个轴都退化时这条也救不了，
     那种输入里半格栅格确实是像素的唯一合理解释（真机不会出现，合成图才会）。 */
  let squareFix = null;
  const spanStep = (ls) => (ls && ls.length >= 2)
    ? (ls[ls.length - 1].pos - ls[0].pos) / (ls.length - 1) : 0;
  const sR = spanStep(rl), sC = spanStep(cl);
  if (sR > 0 && sC > 0) {
    const coarse = Math.max(sR, sC), fine = Math.min(sR, sC);
    const k = Math.round(coarse / fine);
    if (k >= 2 && Math.abs(coarse / fine - k) < 0.08) {
      const colFine = sC < sR;
      const re = chain(colFine ? colRuns : rowRuns, colFine ? extC : extR, want, coarse);
      if (re) {
        squareFix = { axis: colFine ? 'col' : 'row', k, from: +fine.toFixed(2), to: +spanStep(re).toFixed(2) };
        if (colFine) { cl = re; dbgCol = annChainDbg; } else { rl = re; dbgRow = annChainDbg; }
      }
    }
  }

  return {
    rowLines: rl, colLines: cl, rowRuns, colRuns, rowC, colC, rowMean, colMean,
    cellLum, bgLum, TOL, extR, extC, dbgRow, dbgCol, squareFix,
    // 颜色档（板面判据用的）：v=中心亮度 n=像素数 tol=容差
    colors: centers.map(t => ({ v: +t.v.toFixed(1), n: t.n, tol: +t.tol.toFixed(1) })),
    nR: rl ? rl.length - 1 : 0, nC: cl ? cl.length - 1 : 0,
  };
}

function annOtsu(vals) {
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!(hi - lo > 8)) return null;
  const B = 64, hist = new Float64Array(B);
  for (const v of vals) hist[Math.min(B - 1, ((v - lo) / (hi - lo) * B) | 0)]++;
  const tot = vals.length;
  let sum = 0;
  for (let i = 0; i < B; i++) sum += i * hist[i];
  let wB = 0, sumB = 0, best = -1, thr = null;
  for (let i = 0; i < B; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = tot - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = lo + (i + 0.5) * (hi - lo) / B; }
  }
  return thr;
}

/* 格内"背景色亮度" = 格内亮度直方图的众数（32 桶）。
   为什么要它而不是"格内平均亮度"：平均亮度会被数字字形拉低——浅色主题下
   "带数字的已挖开格"（≈207）比"未挖开格"（≈222）还暗，两者直接重叠，
   于是"哪一簇是已挖开"会判反。众数取的是占比最大的底色，数字盖不住 50%，
   所以"带数字"和"空白"的已挖开格会稳稳落在同一个簇里。 */
function annCellBgLum(id, iw, x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0;
  if (w <= 3 || h <= 3) return null;
  const hb = new Int32Array(32);
  for (let y = 0; y < h; y++) {
    const base = (y0 + y) * iw + x0;
    for (let x = 0; x < w; x++) {
      const i = (base + x) * 4;
      const l = 0.299 * id.data[i] + 0.587 * id.data[i + 1] + 0.114 * id.data[i + 2];
      hb[Math.min(31, (l * 32 / 256) | 0)]++;
    }
  }
  let mi = 0;
  for (let b = 1; b < 32; b++) if (hb[b] > hb[mi]) mi = b;
  return (mi + 0.5) * 8;
}

/* 从格内像素提取字形。
   关键：格内背景色 = 颜色直方图众数；与背景差异大的像素才是字形。
   这样既不会被"亮字形抬高平均亮度"骗到，也能分开"黄字 vs 棕色格底"这种同色相的情况。 */
function annGlyph(id, iw, x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0;
  if (w <= 3 || h <= 3) return null;
  const q = new Map();
  for (let y = 0; y < h; y++) {
    const base = (y0 + y) * iw + x0;
    for (let x = 0; x < w; x++) {
      const i = (base + x) * 4;
      const k = ((id.data[i] >> 4) << 8) | ((id.data[i + 1] >> 4) << 4) | (id.data[i + 2] >> 4);
      q.set(k, (q.get(k) || 0) + 1);
    }
  }
  let bk = 0, bc = -1;
  for (const [k, v] of q) if (v > bc) { bc = v; bk = k; }
  const mr = ((bk >> 8) & 15) * 16 + 8, mg = ((bk >> 4) & 15) * 16 + 8, mb = (bk & 15) * 16 + 8;

  const on = new Uint8Array(w * h);
  let cnt = 0;
  for (let y = 0; y < h; y++) {
    const base = (y0 + y) * iw + x0;
    for (let x = 0; x < w; x++) {
      const i = (base + x) * 4;
      const d = Math.abs(id.data[i] - mr) + Math.abs(id.data[i + 1] - mg) + Math.abs(id.data[i + 2] - mb);
      if (d > 100) { on[y * w + x] = 1; cnt++; }
    }
  }
  if (cnt < 20) return null;

  // 连通域（8 邻域）单遍标记
  const lab = new Int32Array(w * h).fill(-1);
  const comps = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!on[s] || lab[s] >= 0) continue;
    const cid = comps.length;
    let n = 0, tminY = 1e9, tmaxY = -1;
    lab[s] = cid; stack.push(s);
    while (stack.length) {
      const p = stack.pop();
      const py = (p / w) | 0, px = p - py * w;
      n++;
      if (py < tminY) tminY = py; if (py > tmaxY) tmaxY = py;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const t = ny * w + nx;
        if (!on[t] || lab[t] >= 0) continue;
        lab[t] = cid; stack.push(t);
      }
    }
    comps.push({ minY: tminY, maxY: tmaxY, n });
  }
  let bi = -1, bh = -1, bn = 0;
  for (let c = 0; c < comps.length; c++) {
    const hh = comps[c].maxY - comps[c].minY + 1;
    if (hh > bh || (hh === bh && comps[c].n > bn)) { bh = hh; bi = c; bn = comps[c].n; }
  }
  if (bi < 0) return null;

  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, hcx = 0, hcy = 0, hcnt = 0;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (lab[p] !== bi) continue;
    mask[p] = 1;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    if (!mask[y * w + x]) continue;
    const i = ((y0 + y) * iw + x0 + x) * 4;
    const r = id.data[i], gg = id.data[i + 1], b = id.data[i + 2];
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), d = mx - mn;
    if (!d) continue;
    let hue;
    if (mx === r) hue = 60 * (((gg - b) / d) % 6);
    else if (mx === gg) hue = 60 * ((b - r) / d + 2);
    else hue = 60 * ((r - gg) / d + 4);
    if (hue < 0) hue += 360;
    const rad = hue * Math.PI / 180;
    hcx += Math.cos(rad); hcy += Math.sin(rad); hcnt++;
  }
  let hue = Math.atan2(hcy / Math.max(1, hcnt), hcx / Math.max(1, hcnt)) * 180 / Math.PI;
  if (hue < 0) hue += 360;
  return { mask, w, h, minX, minY, maxX, maxY, hue, satPx: cnt, glyphPx: bn, bh: bh, bw: maxX - minX + 1 };
}

/* 色相 -> 类型（锚点：红 0 / 黄 40 / 蓝 205） */
function annHueType(hue) {
  const anchors = [[0, RED], [40, YELLOW], [205, BLUE]];
  let best = RED, bd = 1e9;
  for (const [a, t] of anchors) {
    let d = Math.abs(hue - a);
    if (d > 180) d = 360 - d;
    if (d < bd) { bd = d; best = t; }
  }
  return { type: best, off: bd };
}

/* 识别两类"非数字"图标 —— 源游戏里用它们表示"已挖开的宝藏"和"已标注的炸弹"。
   硬套数字模板会得到荒唐的结果（实测：兔子→8、感叹号→7），所以要在识别数字**之前**拦掉。

   判据只用形状，不认颜色 —— 形状是图标自身的属性，换主题也不变。
   阈值全部来自实测（真机截图 × 6 种格径 22–52px + 合成 sweep 里的全部数字）：

   · 宝藏图标（兔子）：接近正方形 **且** 填充率极高。
       兔子   har 1.00–1.11   fill 0.733–0.800
       数字   har 1.37–2.36   fill 0.429–0.532
       两个条件各自都有 0.2 以上的余量，且没有任何数字能同时满足。
       **不要用"字形高/格高"当判据**：它随格径漂移得厉害（兔子实测 0.83–0.88，
       而数字能到 0.84，两者重叠）。真机截图那次兔子恰好是 0.94，很容易误以为它可靠。

   · 炸弹标记（感叹号）：极窄极高 + 左右镜像高度对称。
       感叹号 har 1.86–2.20   sym 0.767–1.000
       数字 "1" 是最容易混的一个：har 2.17–2.36（一样高瘦），
       但它的"左上斜旗 + 右下竖笔"严重不对称（sym 0.195–0.198），据此分开。
       sym 阈值取 0.60（感叹号最低 0.767，数字最高 0.198，中间很空），
       不用 0.80 —— 小格径下感叹号的点被抗锯齿糊掉，对称度会掉到 0.767。
       （0 和 8 也左右对称，但 har 只有 ~1.4，过不了 har 这一关。）

       试过再加一条"自上而下收窄成锥形"（wBot <= wTop*0.45）来进一步排除"无旗的 1"，
       实测不成立：「!」底部是 5px 宽（不是 1px），wBot/wTop = 0.49，
       而数字 "1" 是 0.59 —— 只差 0.10，判不开，反而把小格径下的感叹号全挡掉了。
       har 上限取 5：防止二值化碎裂产生的细长碎片被当成炸弹。 */
function annIcon(g) {
  if (!g) return null;
  const bw = g.bw, bh = g.bh;
  if (bw < 4 || bh < 4) return null;
  const har = bh / bw;
  const fill = g.glyphPx / (bw * bh);
  if (har <= 1.30 && fill >= 0.60) return 'T';
  if (har >= 1.70 && har <= 5 && bh >= 8) {
    let inter = 0, uni = 0;
    for (let y = 0; y < bh; y++) {
      const base = (g.minY + y) * g.w + g.minX;
      for (let x = 0; x < bw; x++) {
        const a = g.mask[base + x] ? 1 : 0;
        const b = g.mask[base + bw - 1 - x] ? 1 : 0;
        if (a || b) uni++;
        if (a && b) inter++;
      }
    }
    if (uni > 0 && inter / uni >= 0.60) return 'B';
  }
  return null;
}

/* 兜底：格线没串成规则栅格时，用所有低谷的外沿当棋盘范围，再按设定边长均分 */
function annExtentOf(runs, len) {
  if (!runs || runs.length < 2) return null;
  const a = Math.round(runs[0].pos), b = Math.round(runs[runs.length - 1].pos);
  if (!(b - a > 24)) return null;
  return { a, b };
}

/* 引擎入口：给一整张 ImageData，返回逐格识别结果。
   纯函数、不碰 DOM —— 页面、无头测试、桌面叠加器走的都是这一条路径，
   所以识别行为在三处天然一致（改这里就同时改了三处）。 */
function annRun(id, iw, ih, want) {
  want = clamp(want | 0 || 18, 3, 25);
  const g = annDetectGrid(id, iw, ih, want);
  if (!g) return { error: '读不出图像亮度，换张截图试试。' };

  // 格线串成了规则栅格 -> 直接用格线位置当格子边界，边长 = 格线数 - 1
  let rl, cl, auto = true;
  if (g.rowLines && g.colLines && g.rowLines.length >= 3 && g.colLines.length >= 3) {
    rl = g.rowLines.map(r => r.pos);
    cl = g.colLines.map(r => r.pos);
  } else {
    const er = annExtentOf(g.rowRuns), ec = annExtentOf(g.colRuns);
    if (!er || !ec) return { error: '没找到棋盘格线 — 可能格线太淡，或截图里棋盘占画面太小。' };
    auto = false;
    rl = []; cl = [];
    for (let k = 0; k <= want; k++) { rl.push(er.a + (er.b - er.a) * k / want); cl.push(ec.a + (ec.b - ec.a) * k / want); }
  }
  const nR = rl.length - 1, nC = cl.length - 1;

  const cells = [], bgs = [];
  for (let gy = 0; gy < nR; gy++) {
    for (let gx = 0; gx < nC; gx++) {
      const yA = rl[gy], yB = rl[gy + 1], xA = cl[gx], xB = cl[gx + 1];
      const hh = yB - yA, ww = xB - xA;
      const px0 = Math.round(xA + ww * ANN_INSET), px1 = Math.round(xB - ww * ANN_INSET);
      const py0 = Math.round(yA + hh * ANN_INSET), py1 = Math.round(yB - hh * ANN_INSET);
      let s = 0, k = 0;
      for (let y = Math.max(0, py0); y < Math.min(ih, py1); y++) {
        const base = y * iw;
        for (let x = Math.max(0, px0); x < Math.min(iw, px1); x++) {
          const i = base + x;
          s += 0.299 * id.data[i * 4] + 0.587 * id.data[i * 4 + 1] + 0.114 * id.data[i * 4 + 2];
          k++;
        }
      }
      const cc = {
        gy, gx, sx: xA, sy: yA, ex: xB, ey: yB,
        px0: Math.max(0, px0), py0: Math.max(0, py0), px1: Math.min(iw, px1), py1: Math.min(ih, py1),
        lum: s / Math.max(1, k), state: UNKNOWN, num: 0, conf: 1, note: '',
      };
      cc.bg = annCellBgLum(id, iw, cc.px0, cc.py0, cc.px1, cc.py1);
      cells.push(cc);
      bgs.push(cc.bg === null ? cc.lum : cc.bg);
    }
  }

  // 先给每格算字形。除了识别数字，它还有一个用途：
  // 游戏里只有"已挖开"的格子才会显示数字，所以"有字形"是判定已挖开的硬证据，
  // 用它来锚定下面两簇里哪一簇是"已挖开色"。
  for (const c of cells) {
    c.gl = annGlyph(id, iw, c.px0, c.py0, c.px1, c.py1);
    const ih2 = c.py1 - c.py0;
    c.hasGlyph = !!c.gl && c.gl.bh >= ih2 * 0.34 && c.gl.glyphPx >= 22;
  }
  // 「未挖开色」怎么定：**用字形当硬证据反推**，不要用二簇 Otsu。
  //
  // 二簇 Otsu 的坑（真机踩过，2026-09-24）：一张真实棋盘上格子颜色可能有 3~4 种
  // （已挖开深色、未挖开盖色、宝藏亮色、大红数字把众数带偏的色…）。只切两刀的话，
  // 其中两种会被并成一类，算出**任何格子都不存在的**"未挖开色"—— 真机上 thr 落在
  // 最低档 53.375，盖色(148) 和宝藏亮色(228) 被并成 179.4，于是 |148-179.4| = 31.4
  // 只比阈值 30 大了 1.4，58 个未挖开格全被判成已挖开，求解报"未挖开格子只剩 0 个"。
  //
  // 改成按颜色分组再反推：
  //   ① 有字形的格子铁定已挖开（只有挖开的格子才显示数字）-> 字形占比高的组 = 已挖开色；
  //   ② 一个组里几乎没有字形 -> 它就是未挖开盖色。
  // 不需要知道主题，也不怕格子有几种颜色。占比阈值（而不是"有没有字形"）是为了扛住
  // 零星误检：未挖开盖色上的水印偶尔会被 annGlyph 当成字形。
  const GAP = 12;                 // 亮度差超过它就算两种颜色
  const RATIO_OPEN = 0.2;         // 字形占比到这个数才算"已挖开色"
  const uniq = [];
  {
    const seen = new Set();
    for (const c of cells) if (!seen.has(c.bg)) { seen.add(c.bg); uniq.push(c.bg); }
    uniq.sort((a, b) => a - b);
  }
  const grp = [];
  for (const v of uniq) {
    const t = grp[grp.length - 1];
    if (t && v - t.hi <= GAP) t.hi = v;
    else grp.push({ lo: v, hi: v, n: 0, nG: 0, sum: 0 });
  }
  for (const c of cells) {
    for (const t of grp) {
      if (c.bg >= t.lo && c.bg <= t.hi) { t.n++; t.sum += c.bg; if (c.hasGlyph) t.nG++; break; }
    }
  }
  for (const t of grp) t.ratio = t.nG / Math.max(1, t.n);

  const thr = annOtsu(bgs);        // 留作诊断输出；判据不再依赖它
  const openGrp = grp.filter(t => t.nG >= 2 && t.ratio >= RATIO_OPEN);
  // 盖色候选：字形占比最低的那些组。**先比占比再比大小** —— 只看大小会在
  // "已挖开格大多是空白格"（占比低于阈值、掉进候选）时把已挖开色错认成盖色。
  const coverGrp = grp.filter(t => t.n >= 2 && openGrp.indexOf(t) < 0)
    .sort((a, b) => (a.ratio - b.ratio) || (b.n - a.n));

  let openLum = null, shutLum = g.cellLum, darkN = 0;
  if (openGrp.length) {
    let s = 0, n = 0;
    for (const t of openGrp) { s += t.sum; n += t.n; }
    openLum = s / n;
  }
  if (openGrp.length && coverGrp.length) {
    shutLum = coverGrp[0].sum / coverGrp[0].n;
  }
  // 找不到"已挖开色"或找不到"盖色"时，退回旧的二簇 Otsu：
  // 这种图上新判据没有依据，保持原行为比乱猜安全。
  else if (thr !== null) {
    let sLo = 0, nLo = 0, sHi = 0, nHi = 0, gLo = 0, gHi = 0;
    for (const c of cells) {
      if (c.bg >= thr) { sHi += c.bg; nHi++; if (c.hasGlyph) gHi++; }
      else { sLo += c.bg; nLo++; if (c.hasGlyph) gLo++; }
    }
    const mLo = nLo ? sLo / nLo : thr, mHi = nHi ? sHi / nHi : thr;
    if (Math.abs(mHi - mLo) > 8) {
      if (gLo > gHi) { openLum = mLo; shutLum = mHi; }
      else if (gHi > gLo) { openLum = mHi; shutLum = mLo; }
    }
  }
  // 容差：跟"离最近的另一个颜色组有多远"挂钩，而不是跟页面底色挂钩。
  // 盖色现在是实打实测出来的，容差只要小于"到最近邻组距离的一半"，邻组就不会被
  // 误判成未挖开；同时盖色自己（距离 0）一定落在容差内。
  // 真机上这就是 0.5×40 = 20（旧公式给 30，把邻组 188 也快吞进去了）。
  let OPEN_DELTA;
  {
    let near = Infinity;
    for (const t of grp) {
      const mu = t.sum / Math.max(1, t.n);
      const dd = Math.abs(mu - shutLum);
      if (dd > 1e-6 && dd < near) near = dd;
    }
    OPEN_DELTA = near < Infinity
      ? clamp(0.5 * near, 10, 30)
      : clamp(0.5 * Math.abs(shutLum - g.bgLum), 10, 30);
  }
  let opened = 0, lowConf = 0;
  for (const c of cells) {
    const gl = c.gl;
    // 注意这里不能改成"离哪一簇更近"：浅色主题下"带数字的已挖开格"内部亮度
    // （数字把均值拉下来）和"未挖开格"几乎重合，按簇心比距离会把噪声放大。
    // 用"离未挖开色足够远"+ hasGlyph 两条，稳得多。
    const dark = Math.abs(c.bg - shutLum) > OPEN_DELTA;
    if (dark) darkN++;
    if (!dark && !c.hasGlyph) continue;
    opened++;
    if (!gl) { c.state = BLANK; c.num = 0; c.conf = 1; c.note = '无字形'; continue; }
    c.hue = Math.round(gl.hue);
    c.box = gl.bw + '×' + gl.bh;
    // 先拦图标：兔子（已挖开的宝藏）/ 红色感叹号（已标注的炸弹）都不是数字，
    // 送去跑数字模板只会得到 8 / 7 这种结果。
    const icon = annIcon(gl);
    if (icon) {
      c.state = icon === 'T' ? KT : KB;
      c.num = 0; c.conf = 1; c.icon = icon;
      c.note = icon === 'T' ? '宝藏图标' : '炸弹标记';
      continue;
    }
    const ht = annHueType(gl.hue);
    c.state = ht.type;
    const r = annRecognize(gl.mask, gl.w, gl.minX, gl.minY, gl.maxX, gl.maxY);
    c.num = r.d; c.conf = r.conf; c.dist = r.dist; c.gap = r.gap;
    if (ht.off > 45) c.note = '色相偏离(' + c.hue + '°)';
    if (r.conf < 0.35) { c.note += (c.note ? ' · ' : '') + '数字存疑'; lowConf++; }
  }

  const bd = { x0: cl[0], y0: rl[0], x1: cl[nC], y1: rl[nR], w: cl[nC] - cl[0], h: rl[nR] - rl[0] };
  return { nW: nC, nH: nR, cells, bd, opened, lowConf, thr, darkN, auto, want, g, openLum, shutLum, OPEN_DELTA, grp };
}

/* ==================== Node 导出垫片（建引擎.js 追加） ==================== */
function engineSetBoard(w, h, t, b) {
  W = w; H = h; N = w * h; T = t; B = b;
  cellState = new Int8Array(N);
  cellNum = new Int8Array(N);
  buildNeighbors();
}
function engineSetCell(i, st, n) { cellState[i] = st; cellNum[i] = n | 0; }
function engineSolve() { computeSolution(); return sol; }
function engineSetTemplates(t) { annTpl = t; annTplMs = 0; }
/* 推荐里「点开会连锁」的权重。调它的是 模拟对局.js —— 拿真值盘面数步数，
   扫出最优值再改回引擎默认值。生产路径不会用到这两个函数。
   注意是 P连锁 不是 P空：三态模型里的"空"= 非道具，把数字格也算进去了，
   拿 P空 加权等于奖励"点到数字格"，方向是反的（实测步数 152 → 178）。 */
function engineSetPickW(w) { PICK_W_CASCADE = w; }
function engineGetPickW() { return PICK_W_CASCADE; }
/* 死区过滤开关，同样是给 A/B 用的（见 基准18.js --no-skip-dead）。
   关掉能复现"旧规则会把步数花在不可能再有宝藏的区域里"那个现象。 */
function engineSetSkipDead(v) { PICK_SKIP_DEAD = !!v; }
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    UNKNOWN, BLANK, BLUE, YELLOW, RED, KT, KB,
    setBoard: engineSetBoard, setCell: engineSetCell, solve: engineSolve,
    setTemplates: engineSetTemplates,
    setPickW: engineSetPickW, getPickW: engineGetPickW,
    setSkipDead: engineSetSkipDead,
    annRun, annFeatures, annDist, annRecognize, annIcon, annDetectGrid,
    annHueType, annGlyph, annCellBgLum, annOtsu, annExtentOf, annBuildTemplates,
  };
}
