/*
 * generator.js — Sudoku puzzle generation with a guaranteed unique solution.
 *
 * Strategy:
 *   1. Fill a complete valid grid via randomized backtracking (MRV cell choice).
 *   2. Remove digits so the puzzle has exactly the target number of givens
 *      while still having exactly ONE solution:
 *        pass A: remove cells in 180°-rotation symmetric pairs (puzzle stays
 *                rotationally symmetric);
 *        pass B: if still above target (pair removal can get stuck), try
 *                single cells in random order as a fine tune.
 *
 * Browser: exposes window.SudokuGenerator. Node: module.exports (UMD-style).
 */
(function (factory) {
	if (typeof module !== "undefined" && module.exports) {
		module.exports = factory(require("./rng.js"));
	} else {
		this.SudokuGenerator = factory(this.SudokuRng);
	}
})((Rng) => {
	const SIZE = 9;
	const CELLS = 81;

	/** Difficulty -> target number of givens (clues). */
	const DIFFICULTIES = Object.freeze({
		easy: 36,
		medium: 32,
		hard: 27,
		expert: 24,
	});

	const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

	function rowOf(i) {
		return (i / SIZE) | 0;
	}
	function colOf(i) {
		return i % SIZE;
	}
	function boxOf(i) {
		return ((rowOf(i) / 3) | 0) * 3 + ((colOf(i) / 3) | 0);
	}
	/** 180° rotation (center symmetry) of a cell index. */
	function rotate(i) {
		return (8 - rowOf(i)) * SIZE + (8 - colOf(i));
	}

	/** Can `value` be placed at `index` of `grid` (0 = empty)? */
	function canPlace(grid, index, value) {
		const r = rowOf(index);
		const c = colOf(index);
		for (let i = 0; i < SIZE; i++) {
			const rowI = r * SIZE + i;
			if (rowI !== index && grid[rowI] === value) return false;
			const colI = i * SIZE + c;
			if (colI !== index && grid[colI] === value) return false;
		}
		const br = (r / 3) | 0,
			bc = (c / 3) | 0;
		for (let dr = 0; dr < 3; dr++) {
			for (let dc = 0; dc < 3; dc++) {
				const i = (br * 3 + dr) * SIZE + bc * 3 + dc;
				if (i !== index && grid[i] === value) return false;
			}
		}
		return true;
	}

	/** Candidate digits for an empty cell. Empty array = dead end. */
	function candidates(grid, index) {
		const out = [];
		for (const d of DIGITS) {
			if (canPlace(grid, index, d)) out.push(d);
		}
		return out;
	}

	/**
	 * Fill a grid (in place) with random backtracking. Returns true on success.
	 * Uses MRV (most constrained cell first) for speed.
	 */
	function solveRandom(grid, rng) {
		let best = -1;
		let bestCands = null;
		for (let i = 0; i < CELLS; i++) {
			if (grid[i] !== 0) continue;
			const cands = candidates(grid, i);
			if (cands.length === 0) return false;
			if (bestCands === null || cands.length < bestCands.length) {
				best = i;
				bestCands = cands;
				if (cands.length === 1) break;
			}
		}
		if (best === -1) return true; // solved

		Rng.shuffle(bestCands, rng);
		for (const d of bestCands) {
			grid[best] = d;
			if (solveRandom(grid, rng)) return true;
		}
		grid[best] = 0;
		return false;
	}

	/**
	 * Count solutions of a grid (unique copy is made internally — safe to pass
	 * a working grid), short-circuiting after `limit` (default 2).
	 */
	function countSolutions(grid, limit) {
		if (limit === undefined) limit = 2;
		const work = grid.slice();
		let count = 0;

		function search() {
			let best = -1;
			let bestCands = null;
			for (let i = 0; i < CELLS; i++) {
				if (work[i] !== 0) continue;
				const cands = candidates(work, i);
				if (cands.length === 0) return; // dead end
				if (bestCands === null || cands.length < bestCands.length) {
					best = i;
					bestCands = cands;
					if (cands.length === 1) break;
				}
			}
			if (best === -1) {
				count++;
				return;
			}

			for (const d of bestCands) {
				work[best] = d;
				search();
				work[best] = 0;
				if (count >= limit) return;
			}
		}

		search();
		return count;
	}

	/** Generate a complete, fully valid Sudoku grid. */
	function generateFullGrid(rng) {
		const grid = new Array(CELLS).fill(0);
		solveRandom(grid, rng);
		return grid;
	}

	function countClues(puzzle) {
		let n = 0;
		for (let i = 0; i < CELLS; i++) if (puzzle[i] !== 0) n++;
		return n;
	}

	/**
	 * Generate a puzzle with a unique solution.
	 * @param {() => number} rng - seeded random function
	 * @param {number} targetClues - desired number of givens (>= 17)
	 * @returns {{grid: number[], solution: number[], givens: Uint8Array, clues: number}}
	 *   grid: the puzzle (0 = empty) · solution: complete grid ·
	 *   givens: 1 where the cell is a clue · clues: final clue count.
	 */
	function generatePuzzle(rng, targetClues) {
		if (targetClues < 17 || targetClues > 81) {
			throw new RangeError("targetClues must be in [17, 81]");
		}

		// 1) Complete grid.
		const solution = (() => {
			const grid = new Array(CELLS).fill(0);
			solveRandom(grid, rng);
			return grid;
		})();

		const puzzle = solution.slice();

		// 2) Pass A — symmetric pair removal (keeps 180° rotational symmetry).
		const pairs = [];
		for (let i = 0; i < CELLS; i++) {
			const j = rotate(i);
			if (j > i) pairs.push([i, j]);
		}
		pairs.push([40]); // center cell maps to itself
		Rng.shuffle(pairs, rng);

		for (const pair of pairs) {
			if (countClues(puzzle) <= targetClues) break;
			const saved = pair.map((i) => puzzle[i]);
			for (const i of pair) puzzle[i] = 0;
			if (countSolutions(puzzle, 2) !== 1) {
				// Uniqueness lost — restore the pair.
				pair.forEach((i, k) => {
					puzzle[i] = saved[k];
				});
			}
		}

		// 3) Pass B — single-cell fine tune if we are still above target.
		if (countClues(puzzle) > targetClues) {
			const singles = Rng.shuffle([...Array(CELLS).keys()], rng);
			for (const i of singles) {
				if (countClues(puzzle) <= targetClues) break;
				if (puzzle[i] === 0) continue;
				puzzle[i] = 0;
				if (countSolutions(puzzle, 2) !== 1) puzzle[i] = solution[i];
			}
		}

		// 4) Build the givens mask.
		const givens = new Uint8Array(CELLS);
		let clues = 0;
		for (let i = 0; i < CELLS; i++) {
			givens[i] = puzzle[i] !== 0 ? 1 : 0;
			clues += givens[i];
		}

		return { grid: puzzle, solution, givens, clues };
	}

	/** A filled/nearly-filled grid has no row/col/box duplicates? */
	function validateGrid(grid) {
		const rows = new Array(9).fill(0).map(() => new Set());
		const cols = new Array(9).fill(0).map(() => new Set());
		const boxes = new Array(9).fill(0).map(() => new Set());
		for (let i = 0; i < CELLS; i++) {
			const v = grid[i];
			if (v === 0) continue;
			const r = rowOf(i),
				c = colOf(i),
				b = boxOf(i);
			if (rows[r].has(v) || cols[c].has(v) || boxes[b].has(v)) return false;
			rows[r].add(v);
			cols[c].add(v);
			boxes[b].add(v);
		}
		return true;
	}

	/** Indices of every cell sharing a row, column or box with `index`. */
	function peersOf(index) {
		const out = [];
		const r = rowOf(index),
			c = colOf(index);
		const br = (r / 3) | 0,
			bc = (c / 3) | 0;
		for (let i = 0; i < CELLS; i++) {
			if (i === index) continue;
			const rr = rowOf(i),
				cc = colOf(i);
			const rb = (rr / 3) | 0,
				cb = (cc / 3) | 0;
			if (rr === r || cc === c || (rb === br && cb === bc)) out.push(i);
		}
		return out;
	}

	return Object.freeze({
		SIZE,
		CELLS,
		DIFFICULTIES,
		DIGITS,
		rowOf,
		colOf,
		boxOf,
		rotate,
		canPlace,
		candidates,
		solveRandom,
		countSolutions,
		generateFullGrid,
		generatePuzzle,
		validateGrid,
		peersOf,
	});
});
