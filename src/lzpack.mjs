/**
 * lzpack —— 确定性 LZ77 打包库。
 *
 * 线格式与 11 条对外契约见仓库根目录的 README.md。
 */
import { LzError } from './errors.mjs';

export { LzError };

const MIN_MATCH = 3;
const MAX_MATCH = 130;
const MAX_LITERAL = 128;
const MAX_OFFSET = 32768;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;

/**
 * 对位置 pos 处开始的 3 字节取哈希（pos + 2 必须在输入范围内）。
 * @param {Uint8Array} data
 * @param {number} pos
 */
function hash3(data, pos) {
  return ((data[pos] << 10) ^ (data[pos + 1] << 5) ^ data[pos + 2]) & HASH_MASK;
}

/**
 * 把字节流编码为 lzpack 字节流。
 *
 * @param {Uint8Array|Buffer} bytes
 * @returns {Uint8Array}
 */
export function encode(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('encode: 入参必须是 Uint8Array（或 Buffer）');
  }

  const input = bytes;
  const total = input.length;
  if (total === 0) return new Uint8Array(0);

  // 输出缓冲：最坏情况下每输入字节约 1 个首字节（实际远小于），按 1.1 倍预留并按需扩容。
  let outCap = total + 1024 + (total >>> 3);
  let out = new Uint8Array(outCap);
  let op = 0;

  const ensure = (extra) => {
    if (op + extra <= outCap) return;
    let nextCap = outCap;
    while (nextCap < op + extra) nextCap <<= 1;
    const grown = new Uint8Array(nextCap);
    grown.set(out);
    out = grown;
    outCap = nextCap;
  };

  // 哈希链：head[h] 为最近一个以哈希 h 开头的位置；prev[p] 为位置 p 之前
  // 同一个哈希桶里的上一个位置。-1 表示无。全部按位置顺序写入，迭代顺序确定。
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(total).fill(-1);

  let pos = 0;
  let litStart = 0; // 当前未封口字面量段起点（litStart === pos 表示没有挂起的字面量）

  /** 以长度 len 封口并写出当前字面量 token。 */
  const flushLiteral = (end) => {
    let from = litStart;
    while (from < end) {
      const chunk = Math.min(MAX_LITERAL, end - from);
      ensure(1 + chunk);
      out[op++] = chunk - 1;
      out.set(input.subarray(from, from + chunk), op);
      op += chunk;
      from += chunk;
    }
    litStart = end;
  };

  while (pos < total) {
    let bestLen = 0;
    let bestOff = 0;

    if (pos + MIN_MATCH <= total) {
      const maxLen = Math.min(MAX_MATCH, total - pos);
      const windowStart = pos - MAX_OFFSET < 0 ? 0 : pos - MAX_OFFSET;
      const h = hash3(input, pos);
      let candidate = head[h];

      while (candidate >= windowStart) {
        // 快速检查：候选在当前最好长度处的字节一致才做完整比较，减少无谓比较。
        if (input[candidate + bestLen] === input[pos + bestLen]) {
          let len = 0;
          const lim = Math.min(maxLen, total - candidate);
          while (len < lim && input[candidate + len] === input[pos + len]) len++;
          // 链由近到远遍历，只有严格更长才替换 → 天然实现「并列取最近」。
          if (len > bestLen) {
            bestLen = len;
            bestOff = pos - candidate;
            if (len === maxLen) break; // 已达上限，无需再看更远候选
          }
        }
        candidate = prev[candidate];
      }

      // 把当前位置挂到哈希链最前（最近）。
      prev[pos] = head[h];
      head[h] = pos;
    }

    if (bestLen >= MIN_MATCH) {
      flushLiteral(pos);
      ensure(3);
      out[op++] = 0x80 | (bestLen - MIN_MATCH);
      out[op++] = bestOff & 0xff;
      out[op++] = (bestOff >>> 8) & 0xff;
      // 匹配内部位置同样入链（标准 LZ77 做法），但不重新搜索。
      const end = pos + bestLen;
      for (let p = pos + 1; p < end && p + MIN_MATCH <= total; p++) {
        const hp = hash3(input, p);
        prev[p] = head[hp];
        head[hp] = p;
      }
      pos = end;
      litStart = pos;
    } else {
      pos++;
      if (pos - litStart === MAX_LITERAL) flushLiteral(pos);
    }
  }

  flushLiteral(total);
  return out.subarray(0, op).slice();
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
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('decode: 入参必须是 Uint8Array（或 Buffer）');
  }

  const input = bytes;
  const total = input.length;

  let outCap = total > 0 ? total : 16;
  let out = new Uint8Array(outCap);
  let outLen = 0;

  const ensure = (extra) => {
    if (outLen + extra <= outCap) return;
    let nextCap = outCap;
    while (nextCap < outLen + extra) nextCap <<= 1;
    const grown = new Uint8Array(nextCap);
    grown.set(out.subarray(0, outLen));
    out = grown;
    outCap = nextCap;
  };

  let i = 0;
  while (i < total) {
    const tag = input[i++];

    if (tag & 0x80) {
      const len = (tag & 0x7f) + MIN_MATCH;
      if (i + 2 > total) {
        throw new LzError('截断的匹配 token：缺少 offset 载荷');
      }
      const offset = input[i] | (input[i + 1] << 8);
      i += 2;
      if (offset === 0) {
        throw new LzError('非法匹配 token：offset = 0');
      }
      if (offset > MAX_OFFSET) {
        throw new LzError(`非法匹配 token：offset = ${offset} 超出 32 KiB 窗口`);
      }
      if (offset > outLen) {
        throw new LzError(`越界 offset = ${offset}（当前已输出 ${outLen} 字节）`);
      }
      ensure(len);
      // 按字节顺序复制，允许 offset < len 的重叠（自复制）。
      let src = outLen - offset;
      for (let k = 0; k < len; k++) out[outLen++] = out[src++];
    } else {
      const len = (tag & 0x7f) + 1;
      if (i + len > total) {
        throw new LzError('截断的字面量 token：载荷不足');
      }
      ensure(len);
      out.set(input.subarray(i, i + len), outLen);
      outLen += len;
      i += len;
    }
  }

  return out.subarray(0, outLen).slice();
}

/**
 * 解析一份编码产物，返回其 token 统计。
 *
 * @param {Uint8Array|Buffer} encoded `encode` 的产物
 * @returns {{literals: number, matches: number, literalBytes: number, matchBytes: number}}
 */
export function stats(encoded) {
  if (!(encoded instanceof Uint8Array)) {
    throw new TypeError('stats: 入参必须是 Uint8Array（或 Buffer）');
  }

  const acc = { literals: 0, matches: 0, literalBytes: 0, matchBytes: 0 };
  const input = encoded;
  const total = input.length;
  let outLen = 0;
  let i = 0;

  while (i < total) {
    const tag = input[i++];
    if (tag & 0x80) {
      const len = (tag & 0x7f) + MIN_MATCH;
      if (i + 2 > total) {
        throw new LzError('截断的匹配 token：缺少 offset 载荷');
      }
      const offset = input[i] | (input[i + 1] << 8);
      i += 2;
      if (offset === 0) throw new LzError('非法匹配 token：offset = 0');
      if (offset > MAX_OFFSET) {
        throw new LzError(`非法匹配 token：offset = ${offset} 超出 32 KiB 窗口`);
      }
      if (offset > outLen) {
        throw new LzError(`越界 offset = ${offset}（当前已输出 ${outLen} 字节）`);
      }
      acc.matches += 1;
      acc.matchBytes += len;
      outLen += len;
    } else {
      const len = (tag & 0x7f) + 1;
      if (i + len > total) {
        throw new LzError('截断的字面量 token：载荷不足');
      }
      i += len;
      acc.literals += 1;
      acc.literalBytes += len;
      outLen += len;
    }
  }

  return acc;
}
