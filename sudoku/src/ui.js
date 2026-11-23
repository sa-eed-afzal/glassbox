/*
 * ui.js — DOM rendering + input for the Sudoku game.
 * Browser: exposes window.SudokuUI.
 */
(function (factory) {
	if (typeof document === "undefined") return; // script-safe when loaded in Node
	const scope = typeof window !== "undefined" ? window : this;
	scope.SudokuUI = factory(scope.SudokuGenerator);
})((Gen) => {
	const MAX_HINTS = 3;

	const $ = (sel) => document.querySelector(sel);

	const STORAGE = {
		strict: "sudoku.strict",
		theme: "sudoku.theme",
		best: (diff) => "sudoku.best." + diff,
	};

	function formatTime(ms) {
		const total = Math.max(0, Math.floor(ms / 1000));
		const m = Math.floor(total / 60);
		const s = total % 60;
		return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
	}

	class UI {
		/**
		 * @param {Sudoku} game - an instance of window.SudokuGame.Sudoku
		 * @param {object} [opts]
		 * @param {() => number} [opts.seedFn] - returns a 32-bit puzzle seed
		 */
		constructor(game, opts = {}) {
			this.game = game;
			this.seedFn = opts.seedFn || (() => (Math.random() * 0x100000000) >>> 0);
			this.cells = [];
			this.padButtons = [];
			this._endShown = false;
			this._hintedCell = -1;
			this._lastHintToken = 0;
			this._enteredTimers = {};
			this._boardTimer = null;
			this._confettiDone = false;
			this.theme = "system"; // system | light | dark
			this.build();
			this.bindKeys();
			this.loadPrefs();
			this.startTicker();
		}

		/* ------------------------------------------------------------------ */
		/* Build & events                                                      */
		/* ------------------------------------------------------------------ */

		build() {
			// Board
			const board = $("#board");
			board.innerHTML = "";
			this.cells = [];
			for (let i = 0; i < Gen.CELLS; i++) {
				const cell = document.createElement("div");
				cell.className = "cell";
				cell.dataset.idx = String(i);
				cell.innerHTML = '<span class="digit"></span><span class="notes"></span>';
				cell.addEventListener("click", () => this.onCellClick(i));
				board.appendChild(cell);
				this.cells.push(cell);
			}

			// Digit pad
			const pad = $("#pad");
			pad.innerHTML = "";
			this.padButtons = [];
			for (let d = 1; d <= 9; d++) {
				const btn = document.createElement("button");
				btn.type = "button";
				btn.className = "pad-btn";
				btn.innerHTML = `<span class="pad-num">${d}</span><span class="pad-left">9</span>`;
				btn.addEventListener("click", () => this.onPadPress(d));
				pad.appendChild(btn);
				this.padButtons.push(btn);
			}

			// Control buttons
			$("#btn-undo").addEventListener("click", () => this.act("undo"));
			$("#btn-erase").addEventListener("click", () => this.act("erase"));
			$("#btn-notes").addEventListener("click", () => this.act("notes"));
			$("#btn-hint").addEventListener("click", () => this.act("hint"));
			$("#btn-check").addEventListener("click", () => this.act("check"));

			// New game / difficulty
			$("#btn-new").addEventListener("click", () => this.newGame());
			$("#select-diff").addEventListener("change", (e) => this.newGame(e.target.value));
			$("#btn-again").addEventListener("click", () => this.newGame());

			// Rules / how-to-play modal
			$("#btn-rules").addEventListener("click", () => this.openRulesModal());
			$("#btn-rules-close").addEventListener("click", () => this.closeRulesModal());
			$("#btn-rules-gotit").addEventListener("click", () => this.closeRulesModal());
			$("#rules-modal").addEventListener("click", (e) => {
				if (e.target === e.currentTarget) this.closeRulesModal(); // backdrop
			});

			// Strict rule toggle
			const strict = $("#opt-strict");
			strict.addEventListener("change", () => {
				this.game.strictRule = strict.checked;
				this.savePrefs();
				this.render();
			});

			// Theme toggle (cycles system -> light -> dark -> system)
			$("#theme-toggle").addEventListener("click", () => this.cycleTheme());
		}

		bindKeys() {
			document.addEventListener("keydown", (e) => {
				if (e.ctrlKey || e.metaKey || e.altKey) return;
				const key = e.key;

				// Escape closes the rules modal (gameplay keys are dropped too)
				if (key === "Escape") {
					this.closeRulesModal();
					return;
				}

				// Ignore gameplay shortcuts while the dialog is open.
				if (!$("#rules-modal").classList.contains("hidden")) return;

				// Movement (no edge wrapping)
				const move = {
					ArrowUp: -9,
					ArrowDown: 9,
					ArrowLeft: -1,
					ArrowRight: 1,
					w: -9,
					s: 9,
					a: -1,
					d: 1,
				};
				if (key in move) {
					e.preventDefault();
					this.moveSelection(move[key]);
					return;
				}
				if (key >= "1" && key <= "9") {
					this.onPadPress(Number(key));
					return;
				}
				if (key === "0" || key === "Backspace" || key === "Delete") {
					e.preventDefault();
					this.act("erase");
					return;
				}
				const k = key.toLowerCase();
				if (k === "n" || k === "p") {
					e.preventDefault();
					this.act("notes");
				} else if (k === "h") this.act("hint");
				else if (k === "u") this.act("undo");
				else if (k === "c") this.act("check");
			});
		}

		/* ------------------------------------------------------------------ */
		/* Actions                                                             */
		/* ------------------------------------------------------------------ */

		/** Start a new game (optionally forcing the difficulty). */
		newGame(difficulty) {
			const g = this.game;
			const diff = difficulty || $("#select-diff").value;
			g.newGame(diff, this.seedFn());
			g.strictRule = $("#opt-strict").checked; // reset() clobbers it — reapply
			this._endShown = false;
			this._confettiDone = false;
			this._hintedCell = -1;
			this._lastHintToken = 0;
			$("#select-diff").value = diff;
			this.hideModal();
			this.render();
			this.boardIn();
		}

		/** Central action dispatcher for buttons & keys. */
		act(name) {
			const g = this.game;
			let changed = false;
			let transient = null; // a cell to animate after render
			switch (name) {
				case "undo":
					if (g.undo() !== "ignored") changed = true;
					break;
				case "erase":
					if (g.erase() !== "ignored") changed = true;
					break;
				case "notes":
					g.toggleNoteMode();
					changed = true;
					break;
				case "hint":
					if (g.hint() !== "ignored") {
						changed = true;
						transient = g.selection;
					}
					break;
				case "check":
					this.flashWrongCells();
					break;
			}
			if (changed && g.status === "playing") this.hideModal();
			this.render();
			if (transient !== null) this.markHinted(transient);
		}

		onCellClick(i) {
			this.game.select(i);
			this.render();
		}

		onPadPress(d) {
			const g = this.game;
			if (g.status !== "playing") return;
			if (g.selection === -1) g.selection = 0;
			g.inputNumber(g.selection, d);
			this.hideModal();
			this.render();
		}

		moveSelection(delta) {
			const g = this.game;
			if (g.status !== "playing") return;
			let sel = g.selection === -1 ? 0 : g.selection;
			sel += delta;
			// No wrap around the board edges.
			if (sel < 0 || sel > 80) return;
			if (delta === -1 && sel % 9 === 0) return; // was at column 0
			if (delta === 1 && (sel - 1) % 9 === 8) return; // was at column 8
			g.select(sel);
			this.render();
		}

		/* ------------------------------------------------------------------ */
		/* Rendering                                                           */
		/* ------------------------------------------------------------------ */

		render() {
			this.renderBoard();
			this.renderPad();
			this.renderHud();
		}

		renderBoard() {
			const g = this.game;
			const sel = g.selection;
			const selDigit = sel >= 0 ? g.grid[sel] : 0;
			const selRow = sel >= 0 ? Gen.rowOf(sel) : -1;
			const selCol = sel >= 0 ? Gen.colOf(sel) : -1;
			const selBox = sel >= 0 ? Gen.boxOf(sel) : -1;

			// Track which cell was just hinted (persistent subtle mark).
			if (g.hintToken !== this._lastHintToken) {
				this._lastHintToken = g.hintToken;
				this._hintedCell = g.hintToken ? g.selection : -1;
			}

			for (let i = 0; i < Gen.CELLS; i++) {
				const cell = this.cells[i];
				const v = g.grid[i];
				const isGiven = !!g.givens[i];
				const isSel = i === sel;
				const peer =
					sel >= 0 &&
					!isSel &&
					(Gen.rowOf(i) === selRow || Gen.colOf(i) === selCol || Gen.boxOf(i) === selBox);

				let cls = "cell";
				if (Gen.colOf(i) === 2 || Gen.colOf(i) === 5) cls += " cell-v3";
				if (Gen.rowOf(i) === 2 || Gen.rowOf(i) === 5) cls += " cell-h3";
				if (isGiven) cls += " given";
				if (isSel) cls += " selected";
				else if (peer) cls += " peer";
				if (!isSel && selDigit !== 0 && v === selDigit) cls += " same";
				if (g.wrongSet.has(i)) cls += " wrong";
				if (i === this._hintedCell) cls += " hinted";
				if (v === 0 && (g.notes[i] || 0) !== 0) cls += " has-notes";
				cell.className = cls;

				const digitEl = cell.querySelector(".digit");
				const notesEl = cell.querySelector(".notes");
				if (v !== 0) {
					digitEl.textContent = String(v);
					notesEl.innerHTML = "";
				} else {
					digitEl.textContent = "";
					const mask = g.notes[i] || 0;
					let html = "";
					for (let d = 1; d <= 9; d++) {
						if (mask & (1 << (d - 1))) html += `<span>${d}</span>`;
					}
					notesEl.innerHTML = html;
				}
			}
		}

		renderPad() {
			const g = this.game;
			const counts = new Array(10).fill(0);
			for (const v of g.grid) if (v !== 0) counts[v]++;
			for (let d = 1; d <= 9; d++) {
				const btn = this.padButtons[d - 1];
				const left = Math.max(0, 9 - counts[d]);
				btn.querySelector(".pad-left").textContent = String(left);
				btn.classList.toggle("complete", left <= 0);
				btn.disabled = g.status !== "playing" || left <= 0;
			}
		}

		renderHud() {
			const g = this.game;
			$("#timer").textContent = formatTime(g.elapsed);

			document.querySelectorAll("#mistakes .pip").forEach((pip, i) => {
				pip.classList.toggle("filled", i < g.mistakes);
			});
			$("#mistake-count").textContent = String(g.mistakes);

			document.querySelectorAll("#hints .pdot").forEach((dot, i) => {
				dot.classList.toggle("filled", i < g.hintsLeft);
			});

			const notesBtn = $("#btn-notes");
			notesBtn.classList.toggle("active", g.noteMode);
			notesBtn.textContent = g.noteMode ? "✎ ON" : "✎ OFF";

			$("#opt-strict").checked = g.strictRule;
			$("#best-time").textContent =
				this.bestFor(g.difficulty) > 0 ? formatTime(this.bestFor(g.difficulty)) : "—";

			const label = $("#status-label");
			if (g.status === "playing") {
				label.textContent = g.noteMode ? "Note mode" : "Play";
			} else {
				label.textContent = "";
			}

			const pct = this.progressPercent();
			const fill = $("#progress-fill");
			const track = $("#progress");
			if (fill) fill.style.width = pct + "%";
			if (track) track.setAttribute("aria-valuenow", String(pct));
			const plabel = $("#progress-label");
			if (plabel) plabel.textContent = pct + "%";
		}

		flashWrongCells() {
			const ws = [...this.game.wrongSet];
			for (const i of ws) {
				const cell = this.cells[i];
				cell.classList.remove("flash");
				void cell.offsetWidth; // restart CSS animation
				cell.classList.add("flash");
				setTimeout(() => cell.classList.remove("flash"), 1200);
			}
			$("#check-msg").textContent = ws.length
				? `${ws.length} wrong cell${ws.length > 1 ? "s" : ""}`
				: "No mistakes — keep going!";
		}

		/* ---- cell feedback animations ---------------------------------- */

		markEntered(i) {
			this.animate(i, "pop", 320);
		}
		markCorrect(i) {
			this.animate(i, "correct", 500);
		}
		markWrong(i) {
			this.animate(i, "shake", 320);
		}
		markHinted(i) {
			this.animate(i, "hinted-pulse", 800);
		}

		/** Append a transient CSS class, re-triggering its animation, then drop it. */
		animate(i, cls, ms) {
			const c = this.cells[i];
			if (!c) return;
			c.classList.remove(cls);
			void c.offsetWidth; // reflow so the animation restarts
			c.classList.add(cls);
			clearTimeout(this._enteredTimers[i]);
			this._enteredTimers[i] = setTimeout(() => c.classList.remove(cls), ms);
		}

		/** Percentage of non-given cells that currently hold the right digit. */
		progressPercent() {
			const g = this.game;
			let matched = 0,
				total = 0;
			for (let i = 0; i < Gen.CELLS; i++) {
				if (g.givens[i]) continue;
				total++;
				if (g.grid[i] === g.solution[i]) matched++;
			}
			return total ? Math.round((matched / total) * 100) : 0;
		}

		/** Small entrance animation when a new board is dealt. */
		boardIn() {
			const b = $("#board");
			if (!b) return;
			b.classList.remove("new");
			void b.offsetWidth; // reflow so the animation restarts
			b.classList.add("new");
			clearTimeout(this._boardTimer);
			this._boardTimer = setTimeout(() => b.classList.remove("new"), 300);
		}

		/* ---- end-of-game modal ------------------------------------------- */

		showEndModal(isRecord) {
			const g = this.game;
			const won = g.status === "won";
			$("#modal-emoji").textContent = won ? "🎉" : "💥";
			$("#modal-title").textContent = won ? "Solved!" : "Game Over";
			$("#modal-sub").textContent = won
				? `You beat the ${g.difficulty} puzzle in ${formatTime(g.elapsedMs)}.`
				: "Three mistakes — the puzzle had the final word.";

			const stats = [
				["Time", formatTime(g.elapsedMs)],
				["Difficulty", g.difficulty],
				["Mistakes", String(g.mistakes)],
				["Hints used", String(MAX_HINTS - g.hintsLeft)],
				["Clues", String(g.clues)],
				["Puzzle code", String(g.seed)],
			];
			$("#modal-stats").innerHTML = stats
				.map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`)
				.join("");
			$("#modal-record").textContent =
				won && isRecord ? `★ New best time for ${g.difficulty}!` : "";

			if (won && !this._confettiDone) {
				this._confettiDone = true;
				this.confetti();
			}

			const pfill = $("#progress-fill");
			if (pfill) pfill.style.width = "0%";
			const ptrack = $("#progress");
			if (ptrack) ptrack.setAttribute("aria-valuenow", "0");
			const plabel = $("#progress-label");
			if (plabel) plabel.textContent = "0%";

			$("#modal").classList.remove("hidden");
		}

		hideModal() {
			$("#modal").classList.add("hidden");
			const layer = document.getElementById("confetti-layer");
			if (layer) layer.innerHTML = "";
		}

		/** Launch a CSS confetti burst (used on a win). */
		confetti() {
			let layer = document.getElementById("confetti-layer");
			if (!layer) {
				layer = document.createElement("div");
				layer.id = "confetti-layer";
				layer.setAttribute("aria-hidden", "true");
				const root = document.body || document.documentElement;
				if (root) root.appendChild(layer);
			}
			layer.innerHTML = "";
			const colors = ["#2563eb", "#f59e0b", "#dc2626", "#16a34a", "#7c3aed", "#0891b2", "#ec4899"];
			const n = 80;
			for (let i = 0; i < n; i++) {
				const piece = document.createElement("span");
				piece.className = "confetti-piece";
				const size = 6 + Math.random() * 8;
				piece.style.background = colors[(Math.random() * colors.length) | 0];
				piece.style.width = size + "px";
				piece.style.height = size + "px";
				piece.style.left = Math.random() * 100 + "%";
				piece.style.setProperty("--drift", (Math.random() * 220 - 110).toFixed(1) + "px");
				piece.style.animationDelay = (Math.random() * 0.4).toFixed(2) + "s";
				piece.style.animationDuration = (1.3 + Math.random() * 1.2).toFixed(2) + "s";
				if (Math.random() < 0.5) piece.style.borderRadius = "50%";
				layer.appendChild(piece);
			}
			setTimeout(() => {
				if (layer) layer.innerHTML = "";
			}, 3000);
		}

		openRulesModal() {
			$("#rules-modal").classList.remove("hidden");
		}

		closeRulesModal() {
			$("#rules-modal").classList.add("hidden");
			// gameplay input only fires while the modal is hidden
		}

		/* ------------------------------------------------------------------ */
		/* Timer tick / persistence                                            */
		/* ------------------------------------------------------------------ */

		startTicker() {
			setInterval(() => {
				this.renderHud();
				const g = this.game;
				if ((g.status === "won" || g.status === "lost") && !this._endShown) {
					this._endShown = true;
					const isRecord = g.status === "won" ? this.recordBest() : false;
					this.showEndModal(isRecord);
					this.renderHud();
				}
				if (g.status === "playing") this._endShown = false;
			}, 250);
		}

		/** Store a new best time if warranted. Returns true on a record. */
		recordBest() {
			const g = this.game;
			try {
				const key = STORAGE.best(g.difficulty);
				const prev = Number(localStorage.getItem(key)) || 0;
				if (!prev || g.elapsedMs < prev) {
					localStorage.setItem(key, String(g.elapsedMs));
					return true;
				}
			} catch {
				/* storage unavailable */
			}
			return false;
		}

		bestFor(diff) {
			try {
				return Number(localStorage.getItem(STORAGE.best(diff || this.game.difficulty))) || 0;
			} catch {
				return 0;
			}
		}

		loadPrefs() {
			try {
				const v = localStorage.getItem(STORAGE.strict);
				if (v !== null) this.game.strictRule = v === "1";
			} catch {
				/* ignore */
			}
			try {
				const t = localStorage.getItem(STORAGE.theme);
				if (t === "light" || t === "dark" || t === "system") this.theme = t;
			} catch {
				/* ignore */
			}
			this.applyTheme();
		}

		savePrefs() {
			try {
				localStorage.setItem(STORAGE.strict, this.game.strictRule ? "1" : "0");
			} catch {
				/* ignore */
			}
		}

		/* ---- theme (light / dark / system) -------------------------------- */

		/** Resolve the currently-applicable theme from this.theme. */
		resolveTheme() {
			if (this.theme === "light") return "light";
			if (this.theme === "dark") return "dark";
			return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches
				? "dark"
				: "light";
		}

		/** Apply the resolved theme as a data attribute and refresh the toggle icon. */
		applyTheme() {
			const resolved = this.resolveTheme();
			const de = document.documentElement;
			if (de) de.setAttribute("data-theme", resolved);
			this.updateThemeIcon(resolved);
		}

		/** Set the theme toggle icon to point toward the opposite theme. */
		updateThemeIcon(resolved) {
			const btn = $("#theme-toggle");
			if (!btn) return;
			btn.textContent = resolved === "dark" ? "☀️" : "🌙";
			btn.title = "Switch to " + (resolved === "dark" ? "light" : "dark") + " theme";
		}

		/** Cycle the theme system -> light -> dark -> system. */
		cycleTheme() {
			const order = ["system", "light", "dark"];
			const idx = order.indexOf(this.theme);
			this.theme = order[(idx + 1) % order.length];
			this.saveTheme();
			this.applyTheme();
		}

		saveTheme() {
			try {
				localStorage.setItem(STORAGE.theme, this.theme);
			} catch {
				/* ignore */
			}
		}
	}

	/**
	 * Boot the game inside the current document.
	 * @returns {{game: Sudoku, ui: UI}}
	 */
	function boot() {
		const game = new window.SudokuGame.Sudoku();
		const ui = new UI(game);
		ui.newGame("medium");
		return { game, ui };
	}

	return { UI, boot, formatTime };
});
