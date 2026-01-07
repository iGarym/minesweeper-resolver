import { clampInt, createBoard, idToRC, type Board, type CellId } from './board';
import { solveDeterministic, type SolveResult } from './solver';

type Suggestion = 'none' | 'safe' | 'mine';

export function createApp(root: HTMLDivElement) {
  const el = htmlToElement<HTMLDivElement>(`
    <div class="app">
      <div class="topbar">
        <div class="row">
          <div class="field">
            <label for="rows">行</label>
            <input id="rows" type="number" inputmode="numeric" min="1" max="40" value="16" />
          </div>
          <div class="field">
            <label for="cols">列</label>
            <input id="cols" type="number" inputmode="numeric" min="1" max="60" value="30" />
          </div>
          <div class="field">
            <label for="mines">雷（可选）</label>
            <input id="mines" type="number" inputmode="numeric" min="0" placeholder="不填" />
          </div>
          <button class="btn primary" data-action="generate">生成棋盘</button>
          <div class="spacer"></div>
          <button class="btn" data-action="solve">求解（只高亮）</button>
          <button class="btn" data-action="clearSuggest">清除高亮</button>
        </div>
        <div class="hint">
          PC：点击格子选中后，键盘输入 <b>0~8</b> 填数字；<b>F</b> 标旗；<b>U</b> 设未知；<b>Esc</b> 取消选择。
          <br />
          移动端：选中格子后底部会出现数字键盘。
        </div>
      </div>

      <div class="main">
        <div class="panel">
          <div class="panelTitle">
            <h2>结果</h2>
            <div class="badge" data-role="counts">—</div>
          </div>
          <div class="list" data-role="warnings"></div>
        </div>

        <div class="boardWrap">
          <div class="board" data-role="board"></div>
        </div>
      </div>

      <div class="keypad" data-role="keypad">
        <div class="keyGrid" data-role="keys"></div>
        <div class="footerNote" data-role="selectedInfo">未选中格子</div>
      </div>
    </div>
  `);

  root.replaceChildren(el);

  const rowsInput = el.querySelector<HTMLInputElement>('#rows')!;
  const colsInput = el.querySelector<HTMLInputElement>('#cols')!;
  const minesInput = el.querySelector<HTMLInputElement>('#mines')!;

  const boardEl = el.querySelector<HTMLDivElement>('[data-role="board"]')!;
  const boardWrapEl = el.querySelector<HTMLDivElement>('.boardWrap')!;
  const countsEl = el.querySelector<HTMLDivElement>('[data-role="counts"]')!;
  const warningsEl = el.querySelector<HTMLDivElement>('[data-role="warnings"]')!;
  const keypadEl = el.querySelector<HTMLDivElement>('[data-role="keypad"]')!;
  const keysEl = el.querySelector<HTMLDivElement>('[data-role="keys"]')!;
  const selectedInfoEl = el.querySelector<HTMLDivElement>('[data-role="selectedInfo"]')!;

  let board: Board = createBoard(16, 30);
  let totalMines: number | null = null;
  let selected: CellId | null = null;
  let suggestions = new Map<CellId, Suggestion>();
  let lastSolve: SolveResult | null = null;

  function renderBoard() {
    // 只负责把 board/suggestions/selected 渲染到 DOM；不做任何推理或状态修改。
    boardEl.style.gridTemplateColumns = `repeat(${board.cols}, var(--cell-size))`;
    const frag = document.createDocumentFragment();

    const selectedRC = selected === null ? null : idToRC(board.cols, selected);

    for (let id = 0; id < board.size; id++) {
      const st = board.getStatus(id);
      const btn = document.createElement('button');
      btn.className = 'cell';
      btn.type = 'button';
      btn.dataset.id = String(id);
      btn.dataset.status = st;
      btn.setAttribute('aria-label', cellAria(board, id));
      btn.textContent = cellText(board, id);
      if (selected === id) btn.classList.add('selected');
      if (selectedRC) {
        const rc = idToRC(board.cols, id);
        const dr = Math.abs(rc.r - selectedRC.r);
        const dc = Math.abs(rc.c - selectedRC.c);
        if (dr <= 1 && dc <= 1) btn.classList.add('near-selected');
      }
      const sug = suggestions.get(id) ?? 'none';
      if (sug === 'safe') btn.classList.add('suggest-safe');
      if (sug === 'mine') btn.classList.add('suggest-mine');
      frag.appendChild(btn);
    }
    boardEl.replaceChildren(frag);
  }

  function renderPanel() {
    // 右侧（或移动端下方）面板只展示求解结果摘要与矛盾提示。
    const safeCount = lastSolve?.forcedSafe.size ?? 0;
    const mineCount = lastSolve?.forcedMines.size ?? 0;
    const minesText = totalMines === null ? '未设置' : String(totalMines);
    countsEl.textContent = `必开 ${safeCount} · 必雷 ${mineCount} · 总雷 ${minesText}`;
    warningsEl.replaceChildren();
    const warnings = lastSolve?.warnings ?? [];

    if (!lastSolve) {
      const div = document.createElement('div');
      div.className = 'hint';
      div.textContent = '尚未求解：请先录入一些数字/标雷，然后点击“求解（只高亮）”。';
      warningsEl.appendChild(div);
      return;
    }

    if (warnings.length > 0) {
      for (const w of warnings) {
        const div = document.createElement('div');
        div.style.color = 'rgba(255, 207, 90, 0.92)';
        div.textContent = w;
        warningsEl.appendChild(div);
      }
      return;
    }

    if (safeCount === 0 && mineCount === 0) {
      const div = document.createElement('div');
      div.className = 'hint';
      div.textContent = '当前条件下没有可确定的必开/必雷；请继续录入数字或标雷后再求解。';
      warningsEl.appendChild(div);
      return;
    }

    const div = document.createElement('div');
    div.className = 'hint';
    div.textContent = '没有矛盾提示。';
    warningsEl.appendChild(div);
  }

  function updateKeypadVisibility() {
    // 移动端适配：粗指针设备（touch）选中格子后显示底部数字键盘，避免依赖物理键盘。
    const isCoarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
    const shouldShow = selected !== null && isCoarse;
    keypadEl.classList.toggle('visible', shouldShow);
    selectedInfoEl.textContent =
      selected === null
        ? '未选中格子'
        : `当前：(${idToRC(board.cols, selected).r + 1}, ${idToRC(board.cols, selected).c + 1})`;
  }

  function clearSuggestions() {
    // 用户修改输入后需要重新“点求解”才会出现新高亮；因此清除上一次求解产物。
    suggestions = new Map();
    lastSolve = null;
    renderBoard();
    renderPanel();
  }

  function recomputeCellSize() {
    // Make the board fit without forcing page scroll; keep interactions stable on mobile/desktop.
    const isSmallScreen = window.innerWidth <= 480;
    const gap = isSmallScreen || board.cols >= 26 ? 2 : 4;

    // Use the actual container width (important on desktop when the right-side panel narrows the board area).
    const wrapStyle = window.getComputedStyle(boardWrapEl);
    const padL = Number.parseFloat(wrapStyle.paddingLeft) || 0;
    const padR = Number.parseFloat(wrapStyle.paddingRight) || 0;
    const innerW = Math.max(120, boardWrapEl.clientWidth - padL - padR);
    const maxW = Math.max(200, innerW);

    // Height is less strict; keep board reasonably visible without forcing long scroll.
    const maxH = Math.max(200, window.innerHeight * 0.62);

    const cellW = (maxW - gap * (board.cols - 1)) / board.cols;
    const cellH = (maxH - gap * (board.rows - 1)) / board.rows;

    // On mobile we prefer avoiding horizontal scroll, so allow smaller cells.
    const minCell = isSmallScreen ? 12 : 14;
    const cell = Math.floor(Math.max(minCell, Math.min(44, Math.min(cellW, cellH))));
    document.documentElement.style.setProperty('--cell-gap', `${gap}px`);
    document.documentElement.style.setProperty('--cell-size', `${cell}px`);
  }

  function selectCell(id: CellId | null) {
    // 选中只影响 UI（边框/键盘），不改变格子状态。
    selected = id;
    updateKeypadVisibility();
    renderBoard();
  }

  function applyInputToSelected(action: 'reveal' | 'flag' | 'unknown', value?: number) {
    if (selected === null) return;
    // 输入行为：只修改棋盘录入状态；不会触发自动求解（求解由按钮显式触发）。
    if (action === 'reveal') {
      board.setRevealedNumber(selected, clampInt(value ?? 0, 0, 8));
    } else if (action === 'flag') {
      const st = board.getStatus(selected);
      board.setFlagged(selected, st !== 'flagged');
    } else {
      board.setUnknown(selected);
    }
    // 不主动清空上次求解状态：只有再次“求解”时才会覆盖为新结果。
    // 但如果当前格子已经不再是 unknown，则移除它的旧高亮，避免视觉混淆。
    if (board.getStatus(selected) !== 'unknown') {
      suggestions.delete(selected);
    }
    renderBoard();
    renderPanel();
    updateKeypadVisibility();
  }

  function doSolve() {
    // 求解器只返回“确定解”，这里把结果映射成 UI 高亮；不会写回 board。
    const minesRaw = minesInput.value.trim();
    if (minesRaw.length === 0) {
      totalMines = null;
    } else {
      totalMines = clampInt(Number(minesRaw), 0, board.size);
      minesInput.value = String(totalMines);
    }
    const res = solveDeterministic(board, totalMines);
    lastSolve = res;
    suggestions = new Map();
    for (const id of res.forcedSafe) suggestions.set(id, 'safe');
    for (const id of res.forcedMines) suggestions.set(id, 'mine');
    renderBoard();
    renderPanel();
  }

  // Keypad buttons (mobile)
  keysEl.replaceChildren();
  const keys: Array<{ label: string; onClick: () => void; kind?: 'safe' | 'danger' | 'action' }> =
    [];
  for (let n = 0; n <= 8; n++) {
    keys.push({
      label: String(n),
      onClick: () => applyInputToSelected('reveal', n),
      kind: 'safe',
    });
  }
  keys.push({ label: 'F 标旗', onClick: () => applyInputToSelected('flag'), kind: 'danger' });
  keys.push({ label: 'U 未知', onClick: () => applyInputToSelected('unknown'), kind: 'action' });
  keys.push({ label: '取消', onClick: () => selectCell(null), kind: 'action' });
  for (const k of keys) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'keyBtn';
    if (k.kind) b.classList.add(k.kind);
    if (k.kind === 'action') b.classList.add('action');
    b.textContent = k.label;
    b.addEventListener('click', k.onClick);
    keysEl.appendChild(b);
  }

  // Global events
  el.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const actionBtn = target.closest<HTMLElement>('[data-action]');
    if (actionBtn) {
      const action = actionBtn.dataset.action;
      if (action === 'generate') {
        const r = clampInt(Number(rowsInput.value), 1, 40);
        const c = clampInt(Number(colsInput.value), 1, 60);
        const maxMines = r * c;
        minesInput.max = String(maxMines);

        const minesRaw = minesInput.value.trim();
        if (minesRaw.length === 0) {
          totalMines = null;
        } else {
          totalMines = clampInt(Number(minesRaw), 0, maxMines);
          minesInput.value = String(totalMines);
        }

        board = createBoard(r, c);
        selected = null;
        clearSuggestions();
        recomputeCellSize();
        updateKeypadVisibility();
        renderBoard();
      } else if (action === 'solve') {
        doSolve();
      } else if (action === 'clearSuggest') {
        clearSuggestions();
      }
      return;
    }

    const cellBtn = target.closest<HTMLButtonElement>('.cell');
    if (cellBtn) {
      const id = Number(cellBtn.dataset.id);
      if (!Number.isFinite(id)) return;
      selectCell(id);
      return;
    }
  });

  window.addEventListener('keydown', (e) => {
    if (selected === null) return;

    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key >= '0' && e.key <= '8') {
      applyInputToSelected('reveal', Number(e.key));
      e.preventDefault();
      return;
    }
    if (e.key === 'f' || e.key === 'F') {
      applyInputToSelected('flag');
      e.preventDefault();
      return;
    }
    if (e.key === 'u' || e.key === 'U' || e.key === 'Backspace' || e.key === 'Delete') {
      applyInputToSelected('unknown');
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      selectCell(null);
      e.preventDefault();
    }
  });

  window.addEventListener('resize', () => {
    recomputeCellSize();
  });

  function syncMinesMax() {
    const r = clampInt(Number(rowsInput.value), 1, 40);
    const c = clampInt(Number(colsInput.value), 1, 60);
    minesInput.max = String(r * c);
  }

  rowsInput.addEventListener('input', () => {
    syncMinesMax();
  });

  colsInput.addEventListener('input', () => {
    syncMinesMax();
  });

  // Initial render
  syncMinesMax();
  recomputeCellSize();
  updateKeypadVisibility();
  renderBoard();
  renderPanel();
}

function cellText(board: Board, id: CellId): string {
  const st = board.getStatus(id);
  if (st === 'flagged') return '🚩';
  if (st === 'revealed') {
    const n = board.getNumber(id);
    return n === null ? '' : String(n);
  }
  return '';
}

function cellAria(board: Board, id: CellId): string {
  const { r, c } = idToRC(board.cols, id);
  const st = board.getStatus(id);
  if (st === 'flagged') return `第 ${r + 1} 行第 ${c + 1} 列：标旗`;
  if (st === 'revealed') {
    const n = board.getNumber(id);
    return `第 ${r + 1} 行第 ${c + 1} 列：数字 ${n ?? 0}`;
  }
  return `第 ${r + 1} 行第 ${c + 1} 列：未知`;
}

function htmlToElement<T extends Element>(html: string): T {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}
