/**
 * Invalid-session classifier / 无效会话判定器
 *
 * Pure functions (no IO) so they are trivially unit-testable. Given a
 * SessionMeta plus a set of toggles, returns every reason the session is
 * considered "invalid". An empty result means the session passes all checks.
 * 纯函数（无 IO），便于单测：给定 SessionMeta 与一组开关，返回命中的所有
 * 无效原因；空数组表示该会话不是无效会话。
 */

import type { SessionMeta } from '../parser/message-types.js';

/** Why a session is flagged invalid / 会话被判为无效的原因 */
export type InvalidReason = 'empty' | 'too_short' | 'no_user_input' | 'corrupt';

/**
 * Per-check toggles + the too_short threshold.
 * 各项判定开关 + too_short 阈值
 */
export interface InvalidCriteria {
  empty: boolean;       // Flag sessions with 0 messages / 标记 0 消息会话
  tooShort: boolean;    // Flag sessions with messageCount <= threshold / 标记消息数 <= 阈值
  noUserInput: boolean; // Flag sessions with 0 real user messages / 标记无真实用户输入
  corrupt: boolean;     // Flag empty-byte or unparseable files / 标记 0 字节或损坏文件
  threshold: number;    // Used by too_short: messageCount <= threshold / too_short 用的阈值
}

/** Defensive upper bound for the too_short threshold / too_short 阈值的防御上限 */
const MAX_THRESHOLD = 1000;

/**
 * Sanitize the threshold: coerce to Number, floor negatives to 0, and clamp
 * to a sane upper bound so a hostile/typo value can't flag every session.
 * 阈值防御：Number 化，负数归零,并限制上限,避免误把所有会话标记为无效。
 */
function normalizeThreshold(raw: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > MAX_THRESHOLD) return MAX_THRESHOLD;
  return Math.floor(n);
}

/**
 * Return every invalid reason the session matches under the given criteria.
 * Each rule is gated by its corresponding toggle.
 * 返回该会话在给定 criteria 下命中的所有原因；每条规则受对应开关控制。
 */
export function classifySession(meta: SessionMeta, criteria: InvalidCriteria): InvalidReason[] {
  const reasons: InvalidReason[] = [];

  // empty: zero messages / 空会话：0 条消息
  if (criteria.empty && meta.messageCount === 0) {
    reasons.push('empty');
  }

  // too_short: at-or-below the (sanitized) threshold / 过短：消息数 <= 阈值
  if (criteria.tooShort) {
    const threshold = normalizeThreshold(criteria.threshold);
    if (meta.messageCount <= threshold) {
      reasons.push('too_short');
    }
  }

  // no_user_input: no real user text at all / 无真实用户输入
  if (criteria.noUserInput && meta.userMessageCount === 0) {
    reasons.push('no_user_input');
  }

  // corrupt: empty bytes or unparseable file / 损坏：0 字节或无法解析
  if (criteria.corrupt && (meta.fileSize === 0 || meta.corrupt === true)) {
    reasons.push('corrupt');
  }

  return reasons;
}
