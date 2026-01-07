import type { Board, CellId } from './board';

export interface SolveResult {
  /**
   * 当前条件下可确定为“安全/必开”的格子集合。
   * 注意：这里并不会自动修改棋盘，只用于 UI 高亮提示。
   */
  forcedSafe: ReadonlySet<CellId>;
  /**
   * 当前条件下可确定为“雷/必雷”的格子集合。
   * 注意：这里并不会自动修改棋盘，只用于 UI 高亮提示。
   */
  forcedMines: ReadonlySet<CellId>;
  /**
   * 输入可能存在矛盾/不一致时的提示（例如数字与已标雷冲突）。
   * 求解仍会尽可能给出能推出的确定结论。
   */
  warnings: string[];
}

type BigCount = bigint;

/**
 * 一个数字格子诱导出的“线性约束”：
 *
 *   对于某个已揭示数字格 source，设它周围“仍未知”的邻居集合为 vars，
 *   该数字要求这些未知邻居中的雷数之和等于 rhs：
 *
 *     sum_{v in vars} x_v = rhs, 其中 x_v ∈ {0,1}
 *
 * rhs 的计算方式为：数字 n 减去（已标雷 + 已推断必雷）的邻居数量。
 */
type Constraint = { vars: CellId[]; rhs: number; source: CellId };

type LocalConstraint = { vars: number[]; rhs: number };

type ComponentEnumeration = {
  vars: CellId[];
  countByMines: BigCount[];
  mineCountByVarAndMines: BigCount[][];
};

function isSubsetSorted(a: readonly number[], b: readonly number[]): boolean {
  /**
   * 判断 a 是否为 b 的子集（a ⊆ b）。
   *
   * 关键假设：a/b 都必须是“升序且去重”的数组（本文件中由 buildConstraints 负责保证）。
   * 这样就可以用双指针线性判断子集关系。
   */
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const av = a[i]!;
    const bv = b[j]!;
    if (av === bv) {
      i++;
      j++;
    } else if (av > bv) {
      j++;
    } else {
      return false;
    }
  }
  return i === a.length;
}

function diffSorted(b: readonly number[], a: readonly number[]): number[] {
  /**
   * 计算集合差：返回 (b \ a)。
   *
   * 关键假设：a/b 都是“升序且去重”的数组，并且 a ⊆ b 时效率最佳。
   * 这里用双指针线性扫描，避免 O(n^2)。
   */
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < b.length) {
    const bv = b[i]!;
    const av = j < a.length ? a[j]! : undefined;
    if (av === undefined) {
      out.push(bv);
      i++;
      continue;
    }
    if (bv === av) {
      i++;
      j++;
      continue;
    }
    if (bv < av) {
      out.push(bv);
      i++;
      continue;
    }
    // bv > av
    j++;
  }
  return out;
}

function buildConstraints(
  board: Board,
  forcedSafe: ReadonlySet<CellId>,
  forcedMines: ReadonlySet<CellId>,
  warnings: string[],
): Constraint[] {
  /**
   * 把当前棋盘状态转换为一组约束。
   *
   * 注意：forcedSafe/forcedMines 是推理过程中“临时推出的结论”，并不会写回 board。
   * 因为我们要做“闭包推理”（推一次会产生新的 forced 集合，再反过来影响 rhs/vars）。
   */
  const constraints: Constraint[] = [];

  for (let cell = 0; cell < board.size; cell++) {
    const st = board.getStatus(cell);
    if (st !== 'revealed') continue;
    const n = board.getNumber(cell);
    if (n === null) continue;

    let rhs = n;
    const vars: CellId[] = [];

    for (const nb of board.neighborsOf(cell)) {
      const nbStatus = board.getStatus(nb);
      if (nbStatus === 'flagged' || forcedMines.has(nb)) {
        rhs -= 1;
        continue;
      }
      if (nbStatus === 'revealed' || forcedSafe.has(nb)) {
        continue;
      }
      vars.push(nb);
    }

    // 子集推理需要集合可比较：排序 + 去重，后续才能用双指针算法。
    vars.sort((a, b) => a - b);
    // de-dupe, just in case
    for (let i = vars.length - 1; i > 0; i--) {
      if (vars[i] === vars[i - 1]) vars.splice(i, 1);
    }

    if (rhs < 0 || rhs > vars.length) {
      warnings.push(
        `矛盾：格 ${cell} 的数字为 ${n}，但当前标雷/推断导致需要 ${rhs} 个雷（未知邻居 ${vars.length}）。`,
      );
    }

    if (vars.length === 0) continue;
    constraints.push({ vars, rhs, source: cell });
  }

  return constraints;
}

function chooseBigInt(n: number, k: number): BigCount {
  if (k < 0 || k > n) return 0n;
  k = Math.min(k, n - k);
  let res = 1n;
  for (let i = 1; i <= k; i++) {
    res = (res * BigInt(n - k + i)) / BigInt(i);
  }
  return res;
}

class UnionFind<T> {
  private parent = new Map<T, T>();

  add(x: T) {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }

  find(x: T): T {
    const p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    const r = this.find(p);
    this.parent.set(x, r);
    return r;
  }

  union(a: T, b: T) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function enumerateComponent(
  vars: CellId[],
  constraints: Constraint[],
  maxVars: number,
  maxSolutions: bigint,
): ComponentEnumeration | null {
  if (vars.length === 0) return null;
  if (vars.length > maxVars) return null;

  // Heuristic: assign higher-frequency vars first (helps pruning).
  const freq = new Map<CellId, number>();
  for (const c of constraints) {
    for (const v of c.vars) freq.set(v, (freq.get(v) ?? 0) + 1);
  }
  vars = [...vars].sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0));

  const idxOf = new Map<CellId, number>();
  for (let i = 0; i < vars.length; i++) idxOf.set(vars[i]!, i);

  const localConstraints: LocalConstraint[] = [];
  for (const c of constraints) {
    const localVars: number[] = [];
    for (const v of c.vars) {
      const idx = idxOf.get(v);
      if (idx === undefined) continue;
      localVars.push(idx);
    }
    localVars.sort((a, b) => a - b);
    localConstraints.push({ vars: localVars, rhs: c.rhs });
  }

  const constraintsByVar: number[][] = new Array(vars.length).fill(null).map(() => []);
  for (let ci = 0; ci < localConstraints.length; ci++) {
    for (const vi of localConstraints[ci]!.vars) constraintsByVar[vi]!.push(ci);
  }

  const k = vars.length;
  const assigned = new Int8Array(k);
  assigned.fill(-1);

  const sumAssigned = new Int16Array(localConstraints.length);
  const remaining = new Int16Array(localConstraints.length);
  for (let ci = 0; ci < localConstraints.length; ci++) {
    remaining[ci] = localConstraints[ci]!.vars.length;
  }

  const countByMines: BigCount[] = new Array(k + 1).fill(0n);
  const mineCountByVarAndMines: BigCount[][] = new Array(k)
    .fill(null)
    .map(() => new Array(k + 1).fill(0n));

  let totalSolutions: BigCount = 0n;
  let mineSoFar = 0;

  const applyAssign = (varIdx: number, val: 0 | 1) => {
    assigned[varIdx] = val;
    mineSoFar += val;
    for (const ci of constraintsByVar[varIdx]!) {
      sumAssigned[ci] += val;
      remaining[ci] -= 1;
    }
  };

  const undoAssign = (varIdx: number, val: 0 | 1) => {
    assigned[varIdx] = -1;
    mineSoFar -= val;
    for (const ci of constraintsByVar[varIdx]!) {
      sumAssigned[ci] -= val;
      remaining[ci] += 1;
    }
  };

  const feasibleNow = (): boolean => {
    for (let ci = 0; ci < localConstraints.length; ci++) {
      const rhs = localConstraints[ci]!.rhs;
      const s = sumAssigned[ci]!;
      const r = remaining[ci]!;
      if (s > rhs) return false;
      if (s + r < rhs) return false;
    }
    return true;
  };

  const dfs = (i: number) => {
    if (totalSolutions > maxSolutions) return;
    if (i === k) {
      for (let ci = 0; ci < localConstraints.length; ci++) {
        if (sumAssigned[ci] !== localConstraints[ci]!.rhs) return;
      }
      totalSolutions += 1n;
      countByMines[mineSoFar] += 1n;
      for (let vi = 0; vi < k; vi++) {
        if (assigned[vi] === 1) mineCountByVarAndMines[vi]![mineSoFar] += 1n;
      }
      return;
    }

    applyAssign(i, 0);
    if (feasibleNow()) dfs(i + 1);
    undoAssign(i, 0);

    applyAssign(i, 1);
    if (feasibleNow()) dfs(i + 1);
    undoAssign(i, 1);
  };

  dfs(0);
  if (totalSolutions === 0n) return { vars, countByMines, mineCountByVarAndMines };
  if (totalSolutions > maxSolutions) return null;
  return { vars, countByMines, mineCountByVarAndMines };
}

function convolveCounts(a: BigCount[], b: BigCount[], limit: number): BigCount[] {
  const out = new Array(limit + 1).fill(0n);
  for (let i = 0; i <= limit; i++) {
    if (a[i] === 0n) continue;
    for (let j = 0; j + i <= limit && j < b.length; j++) {
      if (b[j] === 0n) continue;
      out[i + j] += a[i]! * b[j]!;
    }
  }
  return out;
}

export function solveDeterministic(board: Board, totalMines?: number | null): SolveResult {
  const forcedSafe = new Set<CellId>();
  const forcedMines = new Set<CellId>();
  const warnings: string[] = [];
  const warningSet = new Set<string>();

  const pushWarningOnce = (msg: string) => {
    if (warningSet.has(msg)) return;
    warningSet.add(msg);
    warnings.push(msg);
  };

  /**
   * 闭包/不动点推理（Fixed point closure）：
   * - 每轮从 board + forced 集合重新构建约束
   * - 应用规则推出新的 forcedSafe/forcedMines
   * - 直到本轮没有新增结论为止
   *
   * 重要：不修改 board，这样 UI 的“录入状态”完全由用户控制；
   * 我们仅返回“在当前条件下能确定的提示”。
   */
  let changed = true;
  let guard = 0;
  while (changed) {
    guard++;
    if (guard > 200) {
      pushWarningOnce('内部保护：推理迭代次数过多，已中止。');
      break;
    }

    changed = false;
    const constraints = buildConstraints(board, forcedSafe, forcedMines, warnings);

    // Basic rules
    for (const c of constraints) {
      // 若 rhs == 0：所有 vars 都必为安全
      if (c.rhs === 0) {
        for (const v of c.vars) {
          if (!forcedSafe.has(v) && !forcedMines.has(v)) {
            forcedSafe.add(v);
            changed = true;
          }
        }
        // 若 rhs == |vars|：所有 vars 都必为雷
      } else if (c.rhs === c.vars.length) {
        for (const v of c.vars) {
          if (!forcedMines.has(v) && !forcedSafe.has(v)) {
            forcedMines.add(v);
            changed = true;
          }
        }
      }
    }

    // Global mine-count constraint (optional)
    // If totalMines is known, it applies to the whole board: there are exactly totalMines mines.
    // This can yield additional forced safe/mine deductions.
    if (totalMines !== null && totalMines !== undefined) {
      let flaggedCount = 0;
      for (let id = 0; id < board.size; id++) {
        if (board.getStatus(id) === 'flagged') flaggedCount++;
      }

      let forcedMinesUnknown = 0;
      for (const id of forcedMines) {
        if (board.getStatus(id) === 'unknown') forcedMinesUnknown++;
      }

      let unknownRemaining = 0;
      for (let id = 0; id < board.size; id++) {
        if (board.getStatus(id) !== 'unknown') continue;
        if (forcedSafe.has(id)) continue;
        if (forcedMines.has(id)) continue;
        unknownRemaining++;
      }

      const remainingMines = totalMines - flaggedCount - forcedMinesUnknown;
      if (remainingMines < 0 || remainingMines > unknownRemaining) {
        pushWarningOnce(
          `矛盾：总雷数=${totalMines}，已标雷=${flaggedCount}，已推断必雷=${forcedMinesUnknown}，剩余未知=${unknownRemaining}。`,
        );
      } else if (remainingMines === 0) {
        for (let id = 0; id < board.size; id++) {
          if (board.getStatus(id) !== 'unknown') continue;
          if (forcedSafe.has(id) || forcedMines.has(id)) continue;
          forcedSafe.add(id);
          changed = true;
        }
      } else if (remainingMines === unknownRemaining) {
        for (let id = 0; id < board.size; id++) {
          if (board.getStatus(id) !== 'unknown') continue;
          if (forcedSafe.has(id) || forcedMines.has(id)) continue;
          forcedMines.add(id);
          changed = true;
        }
      }
    }

    // Subset inference
    // If A.vars ⊆ B.vars then sum(B\A) = B.rhs - A.rhs
    for (let i = 0; i < constraints.length; i++) {
      const a = constraints[i]!;
      for (let j = 0; j < constraints.length; j++) {
        if (i === j) continue;
        const b = constraints[j]!;
        if (a.vars.length > b.vars.length) continue;
        if (!isSubsetSorted(a.vars, b.vars)) continue;

        const diff = diffSorted(b.vars, a.vars);
        const diffRhs = b.rhs - a.rhs;

        if (diffRhs < 0 || diffRhs > diff.length) {
          pushWarningOnce(`矛盾：子集推理中出现非法 RHS（来源 ${a.source} ⊆ ${b.source}）。`);
          continue;
        }

        if (diff.length === 0) continue;
        // 推出“差集”上的雷数 diffRhs：
        // - diffRhs == 0 => 差集全安全
        // - diffRhs == |diff| => 差集全是雷
        if (diffRhs === 0) {
          for (const v of diff) {
            if (!forcedSafe.has(v) && !forcedMines.has(v)) {
              forcedSafe.add(v);
              changed = true;
            }
          }
        } else if (diffRhs === diff.length) {
          for (const v of diff) {
            if (!forcedMines.has(v) && !forcedSafe.has(v)) {
              forcedMines.add(v);
              changed = true;
            }
          }
        }
      }
    }

    // Enumeration-based deduction (conservative; only if totalMines is set and cheap rules are stable)
    if (!changed && totalMines !== null && totalMines !== undefined) {
      // Count flagged / remaining mines
      let flaggedCount = 0;
      for (let id = 0; id < board.size; id++) {
        if (board.getStatus(id) === 'flagged') flaggedCount++;
      }

      let forcedMinesUnknown = 0;
      for (const id of forcedMines) {
        if (board.getStatus(id) === 'unknown') forcedMinesUnknown++;
      }

      const remainingMines = totalMines - flaggedCount - forcedMinesUnknown;
      if (remainingMines < 0) {
        pushWarningOnce(
          `矛盾：总雷数=${totalMines}，已标雷=${flaggedCount}，已推断必雷=${forcedMinesUnknown}。`,
        );
        continue;
      }

      // Collect unknown variables participating in constraints (frontier) and unconstrained unknowns.
      const frontier = new Set<CellId>();
      for (const c of constraints) for (const v of c.vars) frontier.add(v);

      const unconstrained: CellId[] = [];
      for (let id = 0; id < board.size; id++) {
        if (board.getStatus(id) !== 'unknown') continue;
        if (forcedSafe.has(id) || forcedMines.has(id)) continue;
        if (!frontier.has(id)) unconstrained.push(id);
      }

      // Build connected components over frontier vars via constraints.
      const uf = new UnionFind<CellId>();
      for (const v of frontier) uf.add(v);
      for (const c of constraints) {
        if (c.vars.length <= 1) continue;
        const first = c.vars[0]!;
        for (let i = 1; i < c.vars.length; i++) uf.union(first, c.vars[i]!);
      }

      const varsByRoot = new Map<CellId, CellId[]>();
      for (const v of frontier) {
        const r = uf.find(v);
        const list = varsByRoot.get(r);
        if (list) list.push(v);
        else varsByRoot.set(r, [v]);
      }

      const constraintsByRoot = new Map<CellId, Constraint[]>();
      for (const c of constraints) {
        const r = uf.find(c.vars[0]!);
        const list = constraintsByRoot.get(r);
        if (list) list.push(c);
        else constraintsByRoot.set(r, [c]);
      }

      const MAX_VARS_PER_COMPONENT = 18;
      const MAX_SOLUTIONS_PER_COMPONENT = 200_000n;

      const components: ComponentEnumeration[] = [];
      for (const [r, vars] of varsByRoot.entries()) {
        const cs = constraintsByRoot.get(r) ?? [];
        const enumRes = enumerateComponent(
          vars,
          cs,
          MAX_VARS_PER_COMPONENT,
          MAX_SOLUTIONS_PER_COMPONENT,
        );
        if (!enumRes) {
          pushWarningOnce(
            `提示：变量规模较大（${vars.length} 个未知格）或解空间过大，已跳过枚举推导（更保守）。`,
          );
          // Conservative: if we skip any component, do not attempt global enumeration deduction.
          components.length = 0;
          break;
        }
        components.push(enumRes);
      }

      if (components.length === 0) continue;

      // Remaining unknown cells = frontier vars + unconstrained (but frontier vars are handled by components).
      const unconstrainedCount = unconstrained.length;
      if (remainingMines > frontier.size + unconstrainedCount) {
        pushWarningOnce(
          `矛盾：总雷数=${totalMines} 导致剩余雷=${remainingMines}，但剩余未知格只有 ${
            frontier.size + unconstrainedCount
          }。`,
        );
        continue;
      }

      // Build DP across (components + unconstrained free cells).
      const limit = remainingMines;
      const countLists: BigCount[][] = components.map((c) => c.countByMines.slice(0, limit + 1));
      const freeCounts: BigCount[] = new Array(limit + 1).fill(0n);
      for (let m = 0; m <= limit; m++) freeCounts[m] = chooseBigInt(unconstrainedCount, m);
      countLists.push(freeCounts);

      // prefix[i] = ways for first i items (0..i-1)
      const prefix: BigCount[][] = [];
      prefix[0] = new Array(limit + 1).fill(0n);
      prefix[0]![0] = 1n;
      for (let i = 0; i < countLists.length; i++) {
        prefix[i + 1] = convolveCounts(prefix[i]!, countLists[i]!, limit);
      }

      const totalWays = prefix[countLists.length]![limit]!;
      if (totalWays === 0n) {
        pushWarningOnce('矛盾：在当前数字/标雷约束下，不存在满足“总雷数”的解。');
        continue;
      }

      // suffix[i] = ways for items i..end-1
      const suffix: BigCount[][] = [];
      suffix[countLists.length] = new Array(limit + 1).fill(0n);
      suffix[countLists.length]![0] = 1n;
      for (let i = countLists.length - 1; i >= 0; i--) {
        suffix[i] = convolveCounts(countLists[i]!, suffix[i + 1]!, limit);
      }

      // For each component var, compute mineWays and force if mineWays is 0 or total.
      for (let ci = 0; ci < components.length; ci++) {
        // otherWays[need] = ways for all items except this component to contribute exactly need mines
        const otherWays: BigCount[] = new Array(limit + 1).fill(0n);
        for (let a = 0; a <= limit; a++) {
          const left = prefix[ci]![a]!;
          if (left === 0n) continue;
          for (let b = 0; b + a <= limit; b++) {
            const right = suffix[ci + 1]![b]!;
            if (right === 0n) continue;
            otherWays[a + b] += left * right;
          }
        }

        const comp = components[ci]!;
        for (let vi = 0; vi < comp.vars.length; vi++) {
          let mineWays = 0n;
          for (let m = 0; m <= limit && m < comp.countByMines.length; m++) {
            const mineInComp = comp.mineCountByVarAndMines[vi]![m]!;
            if (mineInComp === 0n) continue;
            const needOther = limit - m;
            mineWays += mineInComp * otherWays[needOther]!;
          }

          const cellId = comp.vars[vi]!;
          if (mineWays === 0n) {
            forcedSafe.add(cellId);
            changed = true;
          } else if (mineWays === totalWays) {
            forcedMines.add(cellId);
            changed = true;
          }
        }
      }
    }
  }

  // UI 只需要“未知格”的建议：避免对已揭示/已标雷的格子重复提示。
  for (const id of [...forcedSafe]) {
    const st = board.getStatus(id);
    if (st !== 'unknown') forcedSafe.delete(id);
  }
  for (const id of [...forcedMines]) {
    const st = board.getStatus(id);
    if (st !== 'unknown') forcedMines.delete(id);
  }

  return { forcedSafe, forcedMines, warnings };
}
