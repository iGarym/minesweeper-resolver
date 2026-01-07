export type CellId = number;

/**
 * 单元格状态约定：
 * - unknown：未确定（既没有数字也没有标旗）
 * - revealed：用户已录入“已揭示数字 0~8”
 * - flagged：用户已标雷（旗子）
 *
 * 注意：这是“解题输入”的棋盘，不是真实游戏棋盘；不会自动翻开/扩展 0 区域。
 */
export type CellStatus = 'unknown' | 'revealed' | 'flagged';

export interface Board {
  readonly rows: number;
  readonly cols: number;
  readonly size: number;
  getStatus(id: CellId): CellStatus;
  /**
   * 当 status === revealed 时返回 0~8；否则返回 null。
   */
  getNumber(id: CellId): number | null;
  setUnknown(id: CellId): void;
  setFlagged(id: CellId, flagged: boolean): void;
  setRevealedNumber(id: CellId, n: number): void;
  /**
   * 返回该格周围最多 8 个邻居的 CellId 列表（预计算，避免频繁重复算坐标）。
   */
  neighborsOf(id: CellId): readonly CellId[];
}

type CellStatusCode = 0 | 1 | 2; // unknown | revealed | flagged

function encodeStatus(status: CellStatus): CellStatusCode {
  if (status === 'unknown') return 0;
  if (status === 'revealed') return 1;
  return 2;
}

function decodeStatus(code: CellStatusCode): CellStatus {
  if (code === 0) return 'unknown';
  if (code === 1) return 'revealed';
  return 'flagged';
}

export function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

/**
 * CellId 与坐标的映射：
 * - id = r * cols + c
 * - r ∈ [0, rows), c ∈ [0, cols)
 */
export function idToRC(cols: number, id: CellId): { r: number; c: number } {
  return { r: Math.floor(id / cols), c: id % cols };
}

export function rcToId(cols: number, r: number, c: number): CellId {
  return r * cols + c;
}

export function createBoard(rows: number, cols: number): Board {
  /**
   * 内部存储：
   * - status: Uint8Array，存状态码（0/1/2）
   * - numbers: Int8Array，存数字；-1 表示“没有数字/未揭示”
   *
   * 这样 UI 渲染与 solver 查询都能保持 O(1) 访问。
   */
  const size = rows * cols;
  const status = new Uint8Array(size) as unknown as Uint8Array & {
    [i: number]: CellStatusCode;
  };
  const numbers = new Int8Array(size);
  numbers.fill(-1);

  // 预计算每个格子的邻居列表（最多 8 个），后续 solver/UI 直接用。
  const neighbors: CellId[][] = new Array(size);
  for (let id = 0; id < size; id++) {
    const { r, c } = idToRC(cols, id);
    const list: CellId[] = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        list.push(rcToId(cols, rr, cc));
      }
    }
    neighbors[id] = list;
  }

  const board: Board = {
    rows,
    cols,
    size,
    getStatus(id) {
      return decodeStatus(status[id] ?? 0);
    },
    getNumber(id) {
      if (decodeStatus(status[id] ?? 0) !== 'revealed') return null;
      const v = numbers[id] ?? -1;
      return v >= 0 ? v : null;
    },
    setUnknown(id) {
      // unknown 状态不允许携带数字
      status[id] = encodeStatus('unknown');
      numbers[id] = -1;
    },
    setFlagged(id, flagged) {
      if (flagged) {
        status[id] = encodeStatus('flagged');
        numbers[id] = -1;
        return;
      }
      status[id] = encodeStatus('unknown');
      numbers[id] = -1;
    },
    setRevealedNumber(id, n) {
      // revealed 状态必须携带 0~8 数字（UI/键盘可能传入其他值，统一 clamp）
      status[id] = encodeStatus('revealed');
      numbers[id] = clampInt(n, 0, 8);
    },
    neighborsOf(id) {
      return neighbors[id] ?? [];
    },
  };

  return board;
}
