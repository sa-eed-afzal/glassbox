/*
 * game.js — Sudoku game state and rules. Pure logic, no DOM.
 *
 * Browser: exposes window.SudokuGame. Node: module.exports (UMD-style).
 */
(function (factory) {
	if (typeof module !== "undefined" && module.exports) {
		module.exports = factory(require("./rng.js"), require("./generator.js"));
	} else {
		this.SudokuGame = factory(this.SudokuRng, this.SudokuGenerator);
	}
})((Rng, Gen) => {
	const MAX_MISTAKES = 3;
	const MAX_HINTS = 3;
	const HISTORY_LIMIT = 200;

	class Sudoku {
		constructor() {
			this.reset();
		}

		reset() {
			this.difficulty = "medium";
			this.seed = 0;
			this.clues = 0;
			this.grid = new Array(Gen.CELLS).fill(0); // current board (0 = empty)
			this.solution = new Array(Gen.CELLS).fill(0);
			this.givens = new Uint8Array(Gen.CELLS); // 1 = fixed clue cell
			this.notes = new Array(Gen.CELLS).fill(0); // bit mask: bit(d-1) set
			this.selection = -1;
			this.noteMode = false;
			this.mistakes = 0;
			this.hintsLeft = MAX_HINTS;
			this.history = []; // undo stack
			this.status = "idle"; // idle | playing | won | lost
			this.startedAt = null;
			this.elapsedMs = 0; // frozen at game end
			this.strictRule = true; // 3 misses ends the game
			this.wrongSet = new Set(); // filled cells with wrong digit
			this.hintToken = 0; // bump on hint (UI pulse)
		}

		/** True when every cell holds its solution value. */
		get isComplete() {
			for (let i = 0; i < Gen.CELLS; i++) {
				if (this.grid[i] !== this.solution[i]) return false;
			}
			return true;
		}

		/* ------------------------------------------------------------------ */
		/* Game lifecycle                                                      */
		/* ------------------------------------------------------------------ */

		/**
		 * Start a new game.
		 * @param {string} difficulty 'easy'|'medium'|'hard'|'expert'
		 * @param {number} seed - 32-bit seed for the puzzle (reproducible)
		 */
		newGame(difficulty, seed) {
			this.reset();
			this.difficulty = difficulty;
			this.seed = seed >>> 0;
			const rng = Rng.mulberry32(this.seed);
			const target = Gen.DIFFICULTIES[this.difficulty] ?? 32;
			const { grid, solution, givens, clues } = Gen.generatePuzzle(rng, target);
			this.grid = grid;
			this.solution = solution;
			this.givens = givens;
			this.clues = clues;
			this.selection = -1;
			this.status = "playing";
			this.recomputeWrong();
			return this;
		}

		/** Milliseconds of active play (frozen at end of game). */
		get elapsed() {
			if (this.status === "won" || this.status === "lost") return this.elapsedMs;
			if (!this.startedAt) return 0;
			return Date.now() - this.startedAt;
		}

		/* ------------------------------------------------------------------ */
		/* Input actions                                                       */
		/* ------------------------------------------------------------------ */

		select(index) {
			if (this.status !== "playing") return;
			this.selection = index;
		}

		/**
		 * Digit pressed (1-9) for a cell.
		 * - Given cell: ignored.
		 * - Notes mode + empty cell: toggle the pencil mark.
		 * - Normal mode: place the digit (replacing any wrong entry).
		 * @returns {'placed'|'mistake'|'note'|'ignored'}
		 */
		inputNumber(index, digit) {
			if (this.status !== "playing" || !(digit >= 1 && digit <= 9)) return "ignored";
			if (this.givens[index]) return "ignored";

			if (this.noteMode) {
				if (this.grid[index] !== 0) return "ignored";
				this.ensureStarted();
				const before = this.notes[index];
				this.notes[index] ^= 1 << (digit - 1);
				this.pushHistory(index, { num: 0, notes: before });
				return "note";
			}

			// No-op: same digit already placed, no notes pending.
			if (this.grid[index] === digit && this.notes[index] === 0) return "ignored";

			this.ensureStarted();
			const before = { num: this.grid[index], notes: this.notes[index] };
			this.grid[index] = digit;
			this.notes[index] = 0;

			let result;
			if (digit === this.solution[index]) {
				this.sweepNotes(digit, index);
				result = "placed";
			} else {
				this.mistakes++;
				result = "mistake";
				if (this.strictRule && this.mistakes >= MAX_MISTAKES) {
					this.elapsedMs = this.elapsed; // freeze clock before state flip
					this.status = "lost";
				}
			}

			this.pushHistory(index, before, result === "mistake" ? 1 : 0, 0);
			this.recomputeWrong();
			this.checkWin();
			return result;
		}

		/** Clear a cell's value + notes. Givens and empty cells are no-ops. */
		erase(index) {
			if (this.status !== "playing") return "ignored";
			const i = index === undefined || index === null ? this.selection : index;
			if (i < 0 || this.givens[i]) return "ignored";
			if (this.grid[i] === 0 && this.notes[i] === 0) return "ignored";
			this.ensureStarted();
			this.pushHistory(i, { num: this.grid[i], notes: this.notes[i] });
			this.grid[i] = 0;
			this.notes[i] = 0;
			this.recomputeWrong();
			return "erased";
		}

		/** Cancel a single user action (placement, erase, note toggle or hint). */
		undo() {
			if (this.status !== "playing" && this.status !== "lost") return "ignored";
			const step = this.history.pop();
			if (!step) return "ignored";
			if (this.status === "lost") this.status = "playing"; // revive
			this.mistakes = Math.max(0, this.mistakes - step.mistake);
			this.hintsLeft = Math.min(MAX_HINTS, this.hintsLeft + step.hint);
			this.grid[step.index] = step.before.num;
			this.notes[step.index] = step.before.notes;
			this.recomputeWrong();
			this.checkWin();
			return "undone";
		}

		/** Reveal the correct digit in one cell (wrong cells first). 3 uses. */
		hint() {
			if (this.status !== "playing" || this.hintsLeft <= 0) return "ignored";
			this.ensureStarted();

			let target = -1;
			// Prefer a cell holding a wrong digit.
			for (let i = 0; i < Gen.CELLS; i++) {
				if (!this.givens[i] && this.grid[i] !== 0 && this.grid[i] !== this.solution[i]) {
					target = i;
					break;
				}
			}
			// Otherwise an empty editable cell.
			if (target === -1) {
				for (let i = 0; i < Gen.CELLS; i++) {
					if (!this.givens[i] && this.grid[i] === 0) {
						target = i;
						break;
					}
				}
			}
			if (target === -1) return "ignored";

			this.hintsLeft--;
			const before = { num: this.grid[target], notes: this.notes[target] };
			this.grid[target] = this.solution[target];
			this.notes[target] = 0;
			this.sweepNotes(this.solution[target], target);
			this.selection = target;
			this.hintToken++;
			this.pushHistory(target, before, 0, 1);
			this.recomputeWrong();
			this.checkWin();
			return "hint";
		}

		/** Toggle pencil-mark mode. Returns the new state. */
		toggleNoteMode() {
			this.noteMode = !this.noteMode;
			return this.noteMode;
		}

		/* ------------------------------------------------------------------ */
		/* Internals                                                           */
		/* ------------------------------------------------------------------ */

		ensureStarted() {
			if (!this.startedAt) this.startedAt = Date.now();
		}

		/** Remove pencil marks for `digit` from all peers of `index`. */
		sweepNotes(digit, index) {
			const bit = 1 << (digit - 1);
			this.notes[index] = 0;
			for (const p of Gen.peersOf(index)) {
				this.notes[p] &= ~bit;
			}
		}

		/** Rebuild the wrong-cell set from the current grid. */
		recomputeWrong() {
			this.wrongSet = new Set();
			for (let i = 0; i < Gen.CELLS; i++) {
				if (!this.givens[i] && this.grid[i] !== 0 && this.grid[i] !== this.solution[i]) {
					this.wrongSet.add(i);
				}
			}
		}

		pushHistory(index, before, mistake, hint) {
			this.history.push({ index, before, mistake, hint });
			if (this.history.length > HISTORY_LIMIT) this.history.shift();
		}

		checkWin() {
			if (this.status === "playing" && this.isComplete) {
				this.elapsedMs = this.elapsed; // freeze clock before state flip
				this.status = "won";
			}
		}
	}

	Sudoku.MAX_MISTAKES = MAX_MISTAKES;
	Sudoku.MAX_HINTS = MAX_HINTS;

	return { Sudoku };
});
