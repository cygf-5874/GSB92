#!/usr/bin/env node
/**
 * lzpack 固定验收程序（固定件）。
 *
 * 用法（在仓库根目录）：
 *   node check/check.mjs            跑全部场景
 *   node check/check.mjs -list      只列出 `组/名`
 *   node check/check.mjs --only <组>  只跑某一组
 *
 * 输出：逐场景 `PASS <组>/<名>` 或 `FAIL <组>/<名>  期望=… 实际=…`，
 * 结尾 `结果：通过 x/N`；全过 exit 0，否则 exit 1；失败不早退。
 *
 * 判据只描述**对外可见性质**（线格式是否自洽、往返是否逐字节相同、编码是否唯一/确定、
 * decode 是否按契约抛错、stats 是否与产物一致），不引用任何内部实现细节。
 * 本文件不包含 LZ77 实现，只有测试向量与产物的独立解析器。
 */
import { Buffer } from 'node:buffer';

import { encode, decode, stats } from '../src/lzpack.mjs';
import { LzError } from '../src/errors.mjs';

/* ------------------------------------------------------------------ 工具 */

const ASCII = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

const HEX = (h) =>
  Uint8Array.from(
    h.trim().split(/\s+/).filter(Boolean),
    (t) => parseInt(t, 16),
  );

const concat = (...parts) => {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let k = 0;
  for (const p of parts) {
    out.set(p, k);
    k += p.length;
  }
  return out;
};

/** 固定 LCG，保证测试输入逐字节可复现（不使用 Math.random / 墙钟）。 */
const lcgBytes = (seed, len) => {
  let x = seed >>> 0;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = (x >>> 24) & 0xff;
  }
  return out;
};

const shortHex = (u8) => {
  const cap = 48;
  const head = Array.from(u8.subarray(0, cap), (b) => b.toString(16).padStart(2, '0')).join(' ');
  return u8.length > cap ? `${head} …(共 ${u8.length} 字节)` : head;
};

const describe = (v) => {
  if (v instanceof Uint8Array) return `Uint8Array(${v.length}) [${shortHex(v)}]`;
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (v === null) return 'null';
  if (typeof v === 'object') return `object ${JSON.stringify(v)}`;
  return `${typeof v} ${String(v)}`;
};

const fail = (msg) => {
  throw new Error(msg);
};

function assertIsU8(value, label) {
  if (!(value instanceof Uint8Array)) fail(`${label}：期望返回 Uint8Array，实际 ${describe(value)}`);
}

function eqBytes(actual, expected, label) {
  assertIsU8(actual, label);
  if (actual.length !== expected.length) {
    fail(
      `${label}：期望 ${expected.length} 字节 [${shortHex(expected)}]，` +
        `实际 ${actual.length} 字节 [${shortHex(actual)}]`,
    );
  }
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      fail(
        `${label}：第 ${i} 字节期望 0x${expected[i].toString(16).padStart(2, '0')}，` +
          `实际 0x${actual[i].toString(16).padStart(2, '0')}；` +
          `期望 [${shortHex(expected)}]，实际 [${shortHex(actual)}]`,
      );
    }
  }
}

/**
 * 独立解析编码产物（固定件自己的解析器，不依赖被测代码的内部计数），
 * 并校验每一处**线格式对外可见的性质**：
 * 首字节类型位、token 载荷完整性、offset ∈ 1..32768、offset ≤ 已输出长度（自复制合法）。
 * 返回产物展开后的总字节数。
 */
function walkWire(enc, label) {
  if (!(enc instanceof Uint8Array)) fail(`${label}：产物不是 Uint8Array，实际 ${describe(enc)}`);
  let outLen = 0;
  let i = 0;
  while (i < enc.length) {
    const b = enc[i++];
    if (b & 0x80) {
      const len = (b & 0x7f) + 3; // 3..130，由首字节保证
      if (i + 2 > enc.length) fail(`${label}：末尾的匹配 token 缺少 offset 载荷`);
      const off = enc[i] | (enc[i + 1] << 8);
      i += 2;
      if (off === 0) fail(`${label}：产物中出现 offset=0 的非法 token`);
      if (off > 32768) fail(`${label}：产物中出现 offset=${off}，超出 32 KiB 窗口`);
      if (off > outLen) fail(`${label}：产物中出现越界 offset=${off}（此刻只输出了 ${outLen} 字节）`);
      outLen += len;
    } else {
      const len = (b & 0x7f) + 1; // 1..128，由首字节保证
      if (i + len > enc.length) fail(`${label}：末尾的字面量 token 剩余载荷不足`);
      i += len;
      outLen += len;
    }
  }
  return outLen;
}

/** 固定件自己的统计器：直接数产物里的 token。 */
function countTokens(enc, label) {
  const acc = { literals: 0, matches: 0, literalBytes: 0, matchBytes: 0 };
  let i = 0;
  while (i < enc.length) {
    const b = enc[i++];
    if (b & 0x80) {
      const len = (b & 0x7f) + 3;
      if (i + 2 > enc.length) fail(`${label}：末尾的匹配 token 缺少 offset 载荷`);
      i += 2;
      acc.matches += 1;
      acc.matchBytes += len;
    } else {
      const len = (b & 0x7f) + 1;
      if (i + len > enc.length) fail(`${label}：末尾的字面量 token 剩余载荷不足`);
      i += len;
      acc.literals += 1;
      acc.literalBytes += len;
    }
  }
  return acc;
}

/** decode 必须抛 LzError（且不是 RangeError、不得静默返回）。 */
function expectLzError(enc, label) {
  let thrown = null;
  try {
    decode(enc);
  } catch (e) {
    thrown = e;
  }
  if (thrown === null) fail(`${label}：期望 decode 抛 LzError，实际正常返回`);
  if (!(thrown instanceof LzError)) {
    fail(
      `${label}：期望 LzError 实例，实际抛了 ` +
        `${thrown && thrown.constructor ? thrown.constructor.name : typeof thrown}: ${thrown && thrown.message}`,
    );
  }
  if (thrown.name !== 'LzError') fail(`${label}：期望 err.name === 'LzError'，实际 '${thrown.name}'`);
}

/* -------------------------------------------------------------- 测试输入 */

// > 32768 字节：A B A C，第二段 A 与第一段距离 24000（窗口内）必须被压缩，窗口必然滑出。
const SEG = 12000;
const segA = lcgBytes(0x12345678, SEG);
const segB = lcgBytes(0x9e3779b9, SEG);
const segC = lcgBytes(0x0badf00d, SEG);
const LONG_INPUT = concat(segA, segB, segA, segC); // 48000 字节

// 「最长优先」：位置 10 处 offset=6 能连续匹配 6 字节，offset=10 只能匹配 3 字节 —— 必须取前者。
const LONGEST_IN = ASCII('ABCXABCDEFABCDEFG');
const LONGEST_OUT = HEX('03 41 42 43 58 80 04 00 02 44 45 46 83 06 00 00 47');

// 「并列取最近」：位置 12 处 offset=4 与 offset=8 都只能匹配 3 字节 —— 必须取 offset=4。
const TIE_IN = ASCII('wxyzABCXABCYABCZ');
const TIE_OUT = HEX('07 77 78 79 7a 41 42 43 58 80 04 00 00 59 80 04 00 00 5a');

// 「重叠自复制」：offset(1) < len(5) 与 offset(1) < len(130)，源字节在复制过程中被继续读取。
const SIX_A_IN = ASCII('aaaaaa');
const SIX_A_OUT = HEX('00 61 82 01 00');
const MANY_A_IN = new Uint8Array(300).fill(0x61);
const MANY_A_OUT = HEX('00 61 ff 01 00 ff 01 00 a4 01 00');

// stats 用例输入
const STATS_TEXT = concat(
  ASCII('the quick brown fox jumps over the lazy dog. '),
  ASCII('the quick brown fox jumps over the lazy dog. '),
  ASCII('tail!'),
);
const STATS_BLOCK = concat(lcgBytes(0x5151, 400), lcgBytes(0x5151, 400));
const STATS_SAME = new Uint8Array(500).fill(0x5a);

// determinism 用例输入
const DET_IN = concat(ASCII('determinism-'), lcgBytes(0x777, 5000), lcgBytes(0x777, 5000), ASCII('-end'));
const DET_OTHER = concat(ASCII('other-'), lcgBytes(0xabc, 300));

/* ---------------------------------------------------------------- 场景表 */

const scenarios = [
  {
    group: 'roundtrip',
    name: '空输入',
    expect: 'encode 空输入得到 0 字节产物，decode 还原为 0 字节',
    run() {
      const enc = encode(new Uint8Array(0));
      assertIsU8(enc, 'encode(空输入) 返回值');
      eqBytes(enc, new Uint8Array(0), 'encode(空输入) 的产物');
      const dec = decode(enc);
      assertIsU8(dec, 'decode(空产物) 返回值');
      eqBytes(dec, new Uint8Array(0), 'decode(空产物) 的结果');
    },
  },
  {
    group: 'roundtrip',
    name: '单字节',
    expect: '对 0x00 / 0x41 / 0xff 单字节输入，产物自洽且 decode(encode(x)) 逐字节还原',
    run() {
      for (const v of [0x00, 0x41, 0xff]) {
        const input = Uint8Array.from([v]);
        const enc = encode(input);
        const label = `单字节 0x${v.toString(16).padStart(2, '0')}`;
        if (walkWire(enc, `${label} 的产物`) !== 1) fail(`${label}：产物展开长度应为 1`);
        eqBytes(decode(enc), input, `${label} 的往返结果`);
      }
    },
  },
  {
    group: 'roundtrip',
    name: 'LCG长序列',
    expect:
      '48000 字节（A B A C，重复段距离 24000，窗口必然滑出）产物自洽、decode(encode(x)) 与 x 逐字节相同，且产物短于输入',
    run() {
      const enc = encode(LONG_INPUT);
      assertIsU8(enc, 'encode(LCG 长序列) 返回值');
      const expanded = walkWire(enc, 'LCG 长序列的产物');
      if (expanded !== LONG_INPUT.length) {
        fail(`LCG 长序列：产物展开为 ${expanded} 字节，期望 ${LONG_INPUT.length} 字节`);
      }
      eqBytes(decode(enc), LONG_INPUT, 'LCG 长序列的往返结果');
      if (!(enc.length < LONG_INPUT.length)) {
        fail(
          `LCG 长序列：重复段必须被匹配压缩，期望产物 < ${LONG_INPUT.length} 字节，实际 ${enc.length} 字节`,
        );
      }
    },
  },

  {
    group: 'match',
    name: '最长优先',
    expect:
      'encode("ABCXABCDEFABCDEFG") 在位置 10 取 len=6/offset=6 的匹配（而非 len=3/offset=10），产物逐字节等于固定向量',
    run() {
      const enc = encode(LONGEST_IN);
      eqBytes(enc, LONGEST_OUT, 'encode("ABCXABCDEFABCDEFG") 的产物');
      eqBytes(decode(enc), LONGEST_IN, '"ABCXABCDEFABCDEFG" 的往返结果');
    },
  },
  {
    group: 'match',
    name: '并列取最近',
    expect:
      'encode("wxyzABCXABCYABCZ") 在位置 12 两处等长匹配中取 offset=4（较近），产物逐字节等于固定向量',
    run() {
      const enc = encode(TIE_IN);
      eqBytes(enc, TIE_OUT, 'encode("wxyzABCXABCYABCZ") 的产物');
      eqBytes(decode(enc), TIE_IN, '"wxyzABCXABCYABCZ" 的往返结果');
    },
  },
  {
    group: 'match',
    name: '重叠自复制',
    expect:
      '"aaaaaa" → 字面量 a + offset=1/len=5；300 个 0x61 → 首字节 0x00/0xff/0xff/0xa4 的 token 序列；两者往返一致',
    run() {
      eqBytes(encode(SIX_A_IN), SIX_A_OUT, 'encode("aaaaaa") 的产物');
      eqBytes(decode(encode(SIX_A_IN)), SIX_A_IN, '"aaaaaa" 的往返结果');
      const enc = encode(MANY_A_IN);
      eqBytes(enc, MANY_A_OUT, 'encode(300 个 0x61) 的产物');
      eqBytes(decode(enc), MANY_A_IN, '300 个 0x61 的往返结果');
    },
  },

  {
    group: 'errors',
    name: '越界offset',
    expect: 'offset > 已输出长度时 decode 抛 LzError（空流首 token offset=1；已有 1 字节输出后 offset=2 与 offset=5）',
    run() {
      expectLzError(HEX('80 01 00'), '输出为 0 字节时 offset=1');
      expectLzError(HEX('00 41 80 02 00'), '输出为 1 字节时 offset=2');
      expectLzError(HEX('00 41 80 05 00'), '输出为 1 字节时 offset=5');
    },
  },
  {
    group: 'errors',
    name: '非法token',
    expect: 'offset = 0 的匹配 token（编码器不可能产生）decode 抛 LzError',
    run() {
      expectLzError(HEX('80 00 00'), '空流首 token offset=0');
      expectLzError(HEX('00 41 80 00 00'), '已有 1 字节输出后 offset=0');
    },
  },
  {
    group: 'errors',
    name: '截断载荷',
    expect: 'token 声明载荷不足时 decode 抛 LzError（字面量缺字节、匹配缺 1 或 2 个 offset 字节、末尾只剩首字节）',
    run() {
      expectLzError(HEX('00'), '只剩首字节，字面量 len=1 无载荷');
      expectLzError(HEX('03 41 42'), '字面量声明 4 字节只给 2');
      expectLzError(HEX('7f 41'), '字面量声明 128 字节只给 1');
      expectLzError(HEX('80'), '匹配 token 缺 2 个 offset 字节');
      expectLzError(HEX('80 01'), '匹配 token 缺 1 个 offset 字节');
      expectLzError(HEX('00 41 80 01'), '前有字面量时匹配 token 缺 1 个 offset 字节');
    },
  },

  {
    group: 'stats',
    name: '与产物一致',
    expect:
      'stats(产物) 的 {literals,matches,literalBytes,matchBytes} 与固定件自行解析产物得到的四个字段完全一致（空输入/文本重复/随机块重复/全同字节）',
    run() {
      const cases = [
        ['空输入', new Uint8Array(0)],
        ['文本重复', STATS_TEXT],
        ['随机块重复', STATS_BLOCK],
        ['全同字节', STATS_SAME],
      ];
      for (const [label, input] of cases) {
        const enc = encode(input);
        const want = countTokens(enc, `${label} 的产物`);
        const got = stats(enc);
        if (got === null || typeof got !== 'object') fail(`${label}：stats 未返回对象，实际 ${describe(got)}`);
        for (const k of ['literals', 'matches', 'literalBytes', 'matchBytes']) {
          if (got[k] !== want[k]) {
            fail(`${label}：stats().${k} 期望 ${want[k]}（产物解析），实际 ${String(got[k])}`);
          }
        }
      }
    },
  },
  {
    group: 'determinism',
    name: '确定性',
    expect:
      '同一输入两次 encode 逐字节相同；中途编码其它输入不影响结果且不改动先前结果；Buffer 入参与 Uint8Array 入参产物一致；返回值均为 Uint8Array',
    run() {
      const e1 = encode(DET_IN);
      assertIsU8(e1, 'encode(DET_IN) 返回值');
      const snap1 = Uint8Array.from(e1);

      const e2 = encode(DET_IN);
      eqBytes(e2, snap1, '同输入第二次 encode 的产物');
      eqBytes(e1, snap1, '第一次产物在第二次 encode 后未被改动');

      const ey = encode(DET_OTHER);
      const e3 = encode(DET_IN);
      eqBytes(e3, snap1, '中途编码其它输入后重编 DET_IN 的产物');
      eqBytes(e1, snap1, '第一次产物在中途编码其它输入后未被改动');

      eqBytes(decode(snap1), DET_IN, 'DET_IN 的往返结果');
      eqBytes(decode(ey), DET_OTHER, 'DET_OTHER 的往返结果');
      eqBytes(decode(e3), DET_IN, 'DET_IN 重编后的往返结果');

      const eb = encode(Buffer.from(DET_IN));
      assertIsU8(eb, 'encode(Buffer) 返回值');
      eqBytes(eb, snap1, 'Buffer 入参的产物与 Uint8Array 入参一致');

      const db = decode(Buffer.from(snap1));
      assertIsU8(db, 'decode(Buffer) 返回值');
      eqBytes(db, DET_IN, 'Buffer 入参 decode 的结果');

      const s1 = stats(snap1);
      const s2 = stats(snap1);
      if (!s1 || !s2) fail('stats 未返回对象');
      for (const k of ['literals', 'matches', 'literalBytes', 'matchBytes']) {
        if (s1[k] !== s2[k]) fail(`stats().${k} 两次调用不一致：${String(s1[k])} vs ${String(s2[k])}`);
      }
    },
  },
];

/* ---------------------------------------------------------------- 运行器 */

const argv = process.argv.slice(2);

if (argv.includes('-list')) {
  for (const s of scenarios) process.stdout.write(`${s.group}/${s.name}\n`);
  process.exit(0);
}

let only = null;
const onlyAt = argv.indexOf('--only');
if (onlyAt >= 0) {
  only = argv[onlyAt + 1];
  if (only === undefined) {
    process.stdout.write('用法：node check/check.mjs --only <组名>（组名：roundtrip / match / errors / stats / determinism）\n');
    process.exit(1);
  }
}

const selected = only === null ? scenarios.slice() : scenarios.filter((s) => s.group === only);

if (selected.length === 0) {
  process.stdout.write(`结果：通过 0/0（没有匹配的场景：--only ${String(only)}）\n`);
  process.exit(1);
}

let passed = 0;
for (const s of selected) {
  const id = `${s.group}/${s.name}`;
  try {
    s.run();
    passed += 1;
    process.stdout.write(`PASS ${id}\n`);
  } catch (e) {
    const actual = e instanceof Error ? e.message : String(e);
    process.stdout.write(`FAIL ${id}  期望=${s.expect} 实际=${actual}\n`);
  }
}

process.stdout.write(`结果：通过 ${passed}/${selected.length}\n`);
process.exit(passed === selected.length ? 0 : 1);
