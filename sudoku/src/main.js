/*
 * main.js — entry point: boots the game once the DOM is ready.
 */
(() => {
	function start() {
		window.SudokuRef = SudokuUI.boot(); // convenient handle for debugging (view: SudokuRef.game)
	}
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", start);
	} else {
		start();
	}
})();
