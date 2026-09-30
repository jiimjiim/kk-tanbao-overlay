/* ============================================================================
   引擎桥 —— 一个常驻 Node 进程，让 Python 用上浏览器里那套识别 + 求解引擎。

   协议（stdin/stdout，二进制安全）：
     Python -> Node   一行 JSON 头（以 \n 结束）；若头里有 "bytes":N，紧跟 N 字节裸数据
        {"cmd":"frame","w":784,"h":788,"want":18,"bytes":2471168}  + 裸 RGBA
        {"cmd":"params","T":38,"B":26}
        {"cmd":"ping"}
        {"cmd":"quit"}
     Node -> Python   一行 JSON
        {"ok":true,"nW":18,"nH":18,"bd":{...},"cells":[...],"sol":{...},"ms":{...}}
        {"ok":false,"error":"..."}

   为什么不让 Python 自己实现识别：这套引擎在 207 例 sweep / 792 例留一 / 真机 68 格上
   验证过，重写一遍等于把这些验证全部作废。这里直接复用同一份代码（engine_core.js
   就是从 扫雷模拟器.html 抽出来的），识别行为天然一致。
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./engine_core.js');

/* 字形模板：在浏览器里渲染好后导出的纯数字，跟页面用的是同一套。
   （浏览器与 Node 的字形栅格化不同，所以不能在这边现渲染 —— 见 建引擎.js。） */
E.setTemplates(JSON.parse(fs.readFileSync(path.join(__dirname, 'templates.json'), 'utf8')));

let params = { T: 38, B: 26 };

/* 悬停保持用的上一帧读数：key = 格子下标，值 = {state, num}。
   只在格子**没被鼠标压住**的帧里更新 —— 所以存的是"这一格最近一次
   不被悬停时的读数"，悬停一挪开就用它对新读数、并重新记录。 */
let holdPrev = null;
let holdGen = null;      // 框选换代号：换区域（重新框选）后旧读数全部作废

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

/* ---------------- 一帧：识别 + 求解 ---------------- */
function handleFrame(hdr, rgba) {
  const w = hdr.w | 0, h = hdr.h | 0;
  if (!(w > 0 && h > 0)) return { ok: false, error: '宽高不对：' + w + 'x' + h };
  if (rgba.length < w * h * 4) return { ok: false, error: '像素数据不够长' };

  const t0 = Date.now();
  /* annRun 要 {data,width,height} —— 字段名跟浏览器 ImageData 对齐，
     直接传个同形状的对象就行（Buffer 支持 [i] 下标取值）。 */
  const R = E.annRun({ data: rgba, width: w, height: h }, w, h, hdr.want || 18);
  if (R.error) return { ok: false, error: R.error };
  const recMs = Date.now() - t0;

  /* 棋盘大小以**识别出来的**为准：截图里有几格就是几格，不拿参数去硬套。 */
  const W = R.nW, H = R.nH;
  const P = hdr.params || params;
  E.setBoard(W, H, P.T | 0, P.B | 0);

  /* ---- 悬停保持 ----
     游戏在鼠标悬停时会改变那一格的像素（高亮）。未挖开格子上本来就印着
     淡淡的兔子水印，高亮把对比度一抬，annIcon 就把它当成了"已挖开的宝藏"（KT）——
     全局宝藏配额被错扣一格，整个棋盘跟着重算，鼠标挪开又变回去，来回闪。
     处理：鼠标正压着的那一格（hdr.mx/my 落在它的像素范围里），读数和上一帧
     不一样时**沿用上一帧的读数**（见 holdPrev 注释）；其余格照常识别、照常更新。
     悬停挪开的那一刻，这一格不再是"被压住"，新读数立即生效 —— 自愈。
     存证重跑（hdr.debug）不走这套：那边要的就是"识别到底看到了什么"的原始结果，
     而且不能让重跑污染 holdPrev。 */
  if (hdr.gen !== holdGen) { holdGen = hdr.gen; holdPrev = null; }
  if (!holdPrev || holdPrev.W !== W || holdPrev.H !== H) holdPrev = { W, H, m: new Map() };
  const mx = +hdr.mx, my = +hdr.my;
  let hoverI = -1;
  if (Number.isFinite(mx) && Number.isFinite(my) && !hdr.debug) {
    for (const c of R.cells) {
      if (mx >= c.sx && mx < c.ex && my >= c.sy && my < c.ey) {
        hoverI = c.gy * W + c.gx;
        break;
      }
    }
  }

  const cells = [];
  let opened = 0;
  for (const c of R.cells) {
    const i = c.gy * W + c.gx;
    let state = c.state, num = c.num, icon = c.icon || null;
    if (i === hoverI) {
      const pv = holdPrev.m.get(i);
      if (pv && (pv.state !== state || pv.num !== num)) {
        state = pv.state; num = pv.num; icon = null;
        c.note = (c.note ? c.note + ' · ' : '') + '悬停保持';
      }
    } else {
      holdPrev.m.set(i, { state, num });
    }
    if (state !== 0 /* UNKNOWN */) opened++;
    E.setCell(i, state, num);
    cells.push({
      i, gy: c.gy, gx: c.gx, state, num, conf: c.conf,
      note: c.note || '', icon, hue: c.hue,
      sx: c.sx, sy: c.sy, ex: c.ex, ey: c.ey,   // 该格在截图里的像素范围
    });
  }

  const t1 = Date.now();
  const s = E.solve();
  const solveMs = Date.now() - t1;

  const res = {
    ok: true,
    nW: W, nH: H, auto: !!R.auto, want: R.want,
    /* opened 用保持后的格子数：悬停把某格顶成"已挖开"又保持回去时，
       这个数必须跟格子读数一致，否则上层指纹会以为画面变了。 */
    bd: R.bd, opened, lowConf: R.lowConf,
    cells,
    ms: { rec: recMs, solve: solveMs },
    sol: s.ok ? {
      ok: true, approx: !!s.approx, degraded: s.degradedCount | 0, ms: s.ms,
      probs: Array.from(s.probs),        // 长度 N*3，逐格 [P宝, P弹, P空]
      certain: Array.from(s.certain),    // 0 未定 / 1 确定宝藏 / 2 确定炸弹 / 3 确定空地
      estimated: Array.from(s.estimated),
      /* 点开会连锁翻开一片的概率 = 这格和它 8 邻域都不是道具。
         **不能拿 P空 代替**：三态的"空"= 非道具，把数字格也算进去了
         （18×18 实测：260 个非道具格里只有 53 个是真空地，81% 是数字格）。 */
      pCascade: s.pCascade ? Array.from(s.pCascade) : null,
      /* 下一步推荐。规则见引擎里的 pickNext()：
         零风险格（P弹==0）里挑 P宝 + W×P连锁 最高的，一个都没有才退到"P弹 最小"。
         pickW 一起带出来，好让自检脚本按**引擎当前生效的权重**复算排序，而不是猜一个。 */
      next: s.next || null,
      pickW: E.getPickW(),
    } : { ok: false, error: s.error, ms: s.ms },
  };

  /* 格线检测的原始数据。数错格子（比如 18×18 数成 36×18）时，光看结论没法定位，
     得看投影低谷段和拟合出来的栅格。用 {"debug":true} 打开。 */
  if (hdr.debug) {
    const g = R.g || {};
    res.dbg = {
      bgLum: g.bgLum, cellLum: g.cellLum, TOL: g.TOL, extR: g.extR, extC: g.extC,
      rowRuns: (g.rowRuns || []).map(r => ({ pos: r.pos, w: r.w })),
      colRuns: (g.colRuns || []).map(r => ({ pos: r.pos, w: r.w })),
      rowLines: (g.rowLines || []).map(r => r.pos),
      colLines: (g.colLines || []).map(r => r.pos),
      dbgRow: g.dbgRow, dbgCol: g.dbgCol,
      squareFix: g.squareFix || null,   // 非空 = 两轴格距不一致，动过手（半格退化）
      /* 「已挖开 / 未挖开」的判据。数错已挖开格数时（比如整盘报 324/324）光看分布
         看不出来，得看这两簇的中心和阈值是怎么分的。 */
      open: {
        thr: R.thr, openLum: R.openLum, shutLum: R.shutLum,
        delta: R.OPEN_DELTA, darkN: R.darkN, opened: R.opened, lowConf: R.lowConf,
        // 逐格背景亮度分出来的"颜色组"：每组多少格、多少格有字形。
        // 判"已挖开/未挖开"就是靠它 —— 字形占比高的组是已挖开色，几乎没有字形的组是盖色。
        groups: (R.grp || []).map(t => ({ lo: t.lo, hi: t.hi, n: t.n, nG: t.nG,
                                          mean: +(t.sum / Math.max(1, t.n)).toFixed(1),
                                          ratio: +(t.nG / Math.max(1, t.n)).toFixed(3) })),
        // 逐格：背景亮度 + 有没有字形（有字形＝铁定已挖开）
        cells: R.cells.map(c => ({ gx: c.gx, gy: c.gy, bg: Math.round(c.bg),
                                   hasGlyph: !!c.hasGlyph, state: c.state })),
      },
    };
  }
  return res;
}

/* ---------------- 增量解析：一行 JSON 头 + 可选裸数据 ---------------- */
let phase = 'line';
let lineBuf = [];
let head = null, need = 0, dataBuf = null, dataRead = 0;

function startLine(line) {
  let hdr;
  try { hdr = JSON.parse(line.toString('utf8')); }
  catch (e) { out({ ok: false, error: 'JSON 头解析失败：' + e.message }); return; }

  if (hdr.cmd === 'quit') process.exit(0);
  if (hdr.cmd === 'ping') { out({ ok: true, pong: true }); return; }
  if (hdr.cmd === 'params') {
    if (hdr.T != null) params.T = hdr.T | 0;
    if (hdr.B != null) params.B = hdr.B | 0;
    out({ ok: true, params });
    return;
  }
  if (hdr.cmd !== 'frame') { out({ ok: false, error: '未知命令：' + hdr.cmd }); return; }

  need = hdr.bytes | 0;
  if (need > 0) {
    head = hdr; dataBuf = Buffer.allocUnsafe(need); dataRead = 0; phase = 'data';
  } else {
    out(handleFrame(hdr, Buffer.alloc(0)));
  }
}

function feed(chunk) {
  let off = 0;
  while (off < chunk.length) {
    if (phase === 'line') {
      const nl = chunk.indexOf(10, off);
      if (nl < 0) { lineBuf.push(chunk.subarray(off)); break; }
      if (nl > off) lineBuf.push(chunk.subarray(off, nl));
      const line = Buffer.concat(lineBuf); lineBuf = [];
      off = nl + 1;
      if (line.length) startLine(line);
      continue;
    }
    // phase === 'data'
    const take = Math.min(need - dataRead, chunk.length - off);
    chunk.copy(dataBuf, dataRead, off, off + take);
    dataRead += take; off += take;
    if (dataRead >= need) {
      const d = dataBuf, h = head;
      phase = 'line'; head = null; dataBuf = null; need = 0; dataRead = 0;
      out(handleFrame(h, d));
    }
  }
}

process.stdin.on('data', feed);
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();

out({ ok: true, ready: true, params });
