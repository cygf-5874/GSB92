/**
 * lzpack —— 确定性 LZ77 打包库。
 *
 * 线格式与 11 条对外契约见仓库根目录的 README.md。
 *
 * 本实现只使用普通数组（哈希链）记录候选位置，不依赖 Map/Set 的迭代顺序，
 * 也不使用任何随机源或墙钟，因此同一输入只有一种编码产物。
 */
import { LzError } from './errors.mjs';

export { LzError };

const MIN_MATCH = 3;
const MAX_MATCH = 130;
const MAX_LITERAL = 128;
const WINDOW_SIZE = 32768;

const HASH_BITS = 16;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;

/**
 * 连续 3 字节的确定性滚动哈希（16 位）。
 */
function hash3(data, pos) {
  return ((data[pos] * 6583 + data[pos + 1] * 53 + data[pos + 2]) | 0) & HASH_MASK;
}

/** 可增长字节输出缓冲，最后按实际长度切出 Uint8Array。 */
class ByteSink {
  constructor(capacity = 1024) {
    this.buf = new Uint8Array(capacity);
    this.len = 0;
  }

  ensure(extra) {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length || 16;
    while (cap < need) cap <<= 1;
    const grown = new Uint8Array(cap);
    grown.set(this.buf.subarray(0, this.len));
    this.buf = grown;
  }

  byte(value) {
    this.ensure(1);
    this.buf[this.len++] = value;
  }

  bytes(data, start, count) {
    this.ensure(count);
    this.buf.set(data.subarray(start, start + count), this.len);
    this.len += count;
  }

  finish() {
    return this.buf.slice(0, this.len);
  }
}

/**
 * 把字节流编码为 lzpack 字节流。
 *
 * @param {Uint8Array|Buffer} bytes
 * @returns {Uint8Array}
 */
export function encode(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const n = data.length;
  const out = new ByteSink(n === 0 ? 0 : 64);

  if (n === 0) return out.finish();

  // head[h]：哈希为 h 的最近一个位置；chain[p]：位置 p 之前、同哈希的位置。
  // 均为局部状态，函数可重入（契约⑨）。
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const chain = new Int32Array(n);

  let pos = 0; // 当前编码位置
  let litStart = 0; // 未封口的字面量段起点

  const sealLiterals = (end) => {
    let start = litStart;
    while (start < end) {
      const count = Math.min(MAX_LITERAL, end - start);
      out.byte((count - 1) & 0x7f);
      out.bytes(data, start, count);
      start += count;
    }
    litStart = end;
  };

  const insert = (p) => {
    if (p + 2 < n) {
      const h = hash3(data, p);
      chain[p] = head[h];
      head[h] = p;
    }
  };

  while (pos < n) {
    let bestLen = 0;
    let bestOff = 0;

    if (pos + MIN_MATCH <= n) {
      const maxLen = Math.min(MAX_MATCH, n - pos);
      const oldest = Math.max(0, pos - WINDOW_SIZE);
      const h = hash3(data, pos);
      let cand = head[h];

      // 哈希链天然按「由近到远」排列，因此只在严格更长时更新，
      // 并列时保留的就是 offset 最小（最近）的候选（契约①②）。
      while (cand >= oldest) {
        const off = pos - cand;
        if (off >= 1 &&
          data[cand + bestLen] === data[pos + bestLen] &&
          data[cand] === data[pos] &&
          data[cand + 1] === data[pos + 1]) {
          let len = 0;
          const limit = Math.min(maxLen, n - cand);
          while (len < limit && data[cand + len] === data[pos + len]) len++;
          if (len > bestLen) {
            bestLen = len;
            bestOff = off;
            if (len === maxLen) break;
          }
        }
        cand = chain[cand];
      }
    }

    if (bestLen >= MIN_MATCH) {
      sealLiterals(pos);
      out.byte(0x80 | ((bestLen - MIN_MATCH) & 0x7f));
      out.byte(bestOff & 0xff);
      out.byte((bestOff >> 8) & 0xff);

      // 推进前把跨过的位置全部插入索引（含匹配内部，便于后续引用）。
      const end = pos + bestLen;
      for (let p = pos; p < end; p++) insert(p);
      litStart = end;
      pos = end;
    } else {
      // 字面量连续收集；满 128 字节立即封口。
      if (pos - litStart === MAX_LITERAL) sealLiterals(pos);
      insert(pos);
      pos++;
    }
  }

  sealLiterals(n);
  return out.finish();
}

/**
 * 逐 token 校验并计算展开后总长度。
 * 只做结构性校验与 offset 合法性校验，绝不写入输出，因此不会抛出 RangeError，
 * 也不可能留下部分结果（契约⑤）。
 */
function measure(data) {
  const n = data.length;
  let pos = 0;
  let outLen = 0;

  while (pos < n) {
    const b = data[pos++];

    if (b & 0x80) {
      const len = (b & 0x7f) + MIN_MATCH;
      if (pos + 2 > n) throw new LzError('truncated match payload');
      const off = data[pos] | (data[pos + 1] << 8);
      pos += 2;
      if (off === 0) throw new LzError('invalid match token: offset is 0');
      if (off > outLen) throw new LzError(`offset ${off} out of range`);
      outLen += len;
    } else {
      const len = (b & 0x7f) + 1;
      if (pos + len > n) throw new LzError('truncated literal payload');
      pos += len;
      outLen += len;
    }
  }

  return outLen;
}

/**
 * 把 lzpack 字节流解码回原始字节流。
 *
 * @param {Uint8Array|Buffer} bytes
 * @param {{}} [opts] 保留参数；接受省略、`undefined` 与 `{}`.
 * @returns {Uint8Array}
 */
export function decode(bytes, opts) {
  void opts;
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);

  // 第一遍：校验并确定输出长度（非法输入在此抛 LzError，绝不返回部分结果）。
  const total = measure(data);
  const out = new Uint8Array(total);

  // 第二遍：展开。第一遍已保证所有索引都在界内，这里不会出现 RangeError。
  let pos = 0;
  let outPos = 0;

  while (pos < data.length) {
    const b = data[pos++];

    if (b & 0x80) {
      const len = (b & 0x7f) + MIN_MATCH;
      const off = data[pos] | (data[pos + 1] << 8);
      pos += 2;
      let src = outPos - off;
      for (let i = 0; i < len; i++) out[outPos++] = out[src++]; // 允许自复制
    } else {
      const len = (b & 0x7f) + 1;
      out.set(data.subarray(pos, pos + len), outPos);
      pos += len;
      outPos += len;
    }
  }

  return out;
}

/**
 * 解析一份编码产物，返回其 token 统计。
 *
 * @param {Uint8Array|Buffer} encoded `encode` 的产物
 * @returns {{literals: number, matches: number, literalBytes: number, matchBytes: number}}
 */
export function stats(encoded) {
  const data = encoded instanceof Uint8Array ? encoded : Uint8Array.from(encoded);
  const acc = { literals: 0, matches: 0, literalBytes: 0, matchBytes: 0 };

  let pos = 0;
  while (pos < data.length) {
    const b = data[pos++];
    if (b & 0x80) {
      if (pos + 2 > data.length) throw new LzError('truncated match payload');
      acc.matches += 1;
      acc.matchBytes += (b & 0x7f) + MIN_MATCH;
      pos += 2;
    } else {
      const len = (b & 0x7f) + 1;
      if (pos + len > data.length) throw new LzError('truncated literal payload');
      acc.literals += 1;
      acc.literalBytes += len;
      pos += len;
    }
  }

  return acc;
}
