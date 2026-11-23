/*
 * glassbox-setup.js — expose the Sudoku game to the Glassbox MCP bridge.
 *
 * Loaded as an ES module after the classic game scripts, so window.SudokuRef
 * (set by main.js) is available when tools are registered.
 */
import { Glassbox, renderWidget } from "../glassbox.js";

const gbox = new Glassbox("sudoku-game");
window.SudokuGlassbox = gbox; // handy for debugging in DevTools

const ref = () => window.SudokuRef;
const game = () => ref()?.game;
const ui = () => ref()?.ui;

const noteMaskToDigits = (mask) => {
	const out = [];
	for (let d = 1; d <= 9; d++) if (mask & (1 << (d - 1))) out.push(d);
	return out;
};

const gridRows = (g) => {
	const rows = [];
	for (let r = 0; r < 9; r++) rows.push(g.grid.slice(r * 9, r * 9 + 9).join(""));
	return rows;
};

/* ------------------------------------------------------------------ */
/* Read tier                                                           */
/* ------------------------------------------------------------------ */

gbox.tool(
	"get_state",
	"Read the current Sudoku board, selection, status and counters",
	{ tier: "read" },
	() => {
		const g = game();
		if (!g) return { error: "game not booted" };
		return {
			difficulty: g.difficulty,
			seed: g.seed,
			clues: g.clues,
			status: g.status,
			grid: gridRows(g), // 9 strings of 9 digits; '0' means empty
			selection: g.selection, // 0..80 row-major, -1 = none
			noteMode: g.noteMode,
			mistakes: g.mistakes,
			hintsLeft: g.hintsLeft,
			wrongCells: [...g.wrongSet],
			notes: g.notes.map(noteMaskToDigits),
			elapsedMs: Math.round(g.elapsed),
			progress: ui()?.progressPercent() ?? 0,
		};
	},
);

gbox.tool("check", "Flash the cells that currently hold a wrong digit", { tier: "read" }, () => {
	const g = game();
	if (!g) return { error: "game not booted" };
	ui()?.flashWrongCells();
	return { wrongCells: [...g.wrongSet], count: g.wrongSet.size };
});

/* ------------------------------------------------------------------ */
/* Write tier — every call is gated by a consent dialog in the widget  */
/* ------------------------------------------------------------------ */

const WRITE = (props, required) => ({
	tier: "write",
	timeoutMs: 30000,
	inputSchema: { type: "object", properties: props, ...(required ? { required } : {}) },
});

gbox.tool(
	"new_game",
	"Start a new puzzle",
	WRITE(
		{
			difficulty: {
				type: "string",
				enum: ["easy", "medium", "hard", "expert"],
				description: "Difficulty: easy | medium | hard | expert",
			},
			seed: { type: "number", description: "Optional 32-bit seed for a reproducible puzzle" },
		},
		["difficulty"],
	),
	({ difficulty, seed }) => {
		const u = ui();
		if (!u) return { ok: false, error: "game not booted" };
		const diff = ["easy", "medium", "hard", "expert"].includes(difficulty) ? difficulty : "medium";
		const prevSeedFn = u.seedFn;
		if (typeof seed === "number" && Number.isFinite(seed)) u.seedFn = () => seed >>> 0;
		try {
			u.newGame(diff);
		} finally {
			u.seedFn = prevSeedFn;
		}
		const g = game();
		return { ok: true, difficulty: g.difficulty, seed: g.seed, clues: g.clues, status: g.status };
	},
);

gbox.tool(
	"select",
	"Select a cell by its row-major index (0-80)",
	WRITE(
		{
			index: { type: "number", description: "Cell index 0-80 (row * 9 + col)" },
		},
		["index"],
	),
	({ index }) => {
		const g = game();
		if (!g || g.status !== "playing") return { ok: false, error: "game not playing" };
		const i = Number(index);
		if (!Number.isInteger(i) || i < 0 || i > 80) return { ok: false, error: "index out of range" };
		ui()?.onCellClick(i);
		return { ok: true, selection: g.selection };
	},
);

gbox.tool(
	"input_number",
	"Place a digit 1-9 in a cell (row-major index)",
	WRITE(
		{
			index: { type: "number", description: "Cell index 0-80 (row * 9 + col)" },
			digit: { type: "number", description: "Digit 1-9" },
		},
		["index", "digit"],
	),
	({ index, digit }) => {
		const g = game();
		const u = ui();
		if (!g || g.status !== "playing")
			return { ok: false, error: "game not playing", status: g?.status };
		const i = Number(index);
		const d = Number(digit);
		if (!Number.isInteger(i) || i < 0 || i > 80) return { ok: false, error: "index out of range" };
		if (!Number.isInteger(d) || d < 1 || d > 9) return { ok: false, error: "digit out of range" };
		g.select(i);
		const result = g.inputNumber(i, d);
		u?.render();
		if (result === "placed") u?.markCorrect(i);
		else if (result === "mistake") u?.markWrong(i);
		else if (result === "note") u?.markEntered(i);
		return {
			ok: result !== "ignored",
			result,
			index: i,
			digit: d,
			value: g.grid[i],
			status: g.status,
			mistakes: g.mistakes,
		};
	},
);

gbox.tool(
	"erase",
	"Clear the digit and notes from a cell",
	WRITE(
		{
			index: { type: "number", description: "Cell index 0-80 (row * 9 + col)" },
		},
		["index"],
	),
	({ index }) => {
		const g = game();
		if (!g || g.status !== "playing") return { ok: false, error: "game not playing" };
		const i = index === undefined || index === null ? g.selection : Number(index);
		if (!Number.isInteger(i) || i < 0 || i > 80) return { ok: false, error: "index out of range" };
		g.select(i);
		const result = g.erase(i);
		ui()?.render();
		return { ok: result !== "ignored", result, index: i, status: g.status };
	},
);

gbox.tool("hint", "Reveal a correct digit (3 hints per game)", WRITE({}, []), () => {
	const g = game();
	if (!g || g.status !== "playing") return { ok: false, error: "game not playing" };
	const result = g.hint();
	ui()?.render();
	if (result === "hint") ui()?.markHinted(g.selection);
	return {
		ok: result === "hint",
		result,
		index: g.selection,
		value: g.grid[g.selection],
		hintsLeft: g.hintsLeft,
	};
});

gbox.tool("undo", "Undo the last placement, erase, note or hint", WRITE({}, []), () => {
	const g = game();
	if (!g) return { ok: false, error: "game not booted" };
	const result = g.undo();
	ui()?.render();
	return { ok: result !== "ignored", result, status: g.status, mistakes: g.mistakes };
});

gbox.tool("toggle_notes", "Turn pencil-note mode on or off", WRITE({}, []), () => {
	const g = game();
	if (!g) return { ok: false, error: "game not booted" };
	const on = g.toggleNoteMode();
	ui()?.render();
	return { ok: true, noteMode: on };
});

/* Placement is owned by the SDK now: a centred pairing overlay becomes a
   compact bottom-right dock when connected (spec §SPEC-WIDGET). The old
   app-local layout layer + compact toggle are removed; no app CSS needed. */
renderWidget(gbox);

console.log("[sudoku-glassbox] widget rendered; tools:", [...gbox.tools.keys()].join(", "));
