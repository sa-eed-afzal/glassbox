/*
 * rng.js — deterministic, seedable pseudo-random number helpers.
 * Browser: exposes window.SudokuRng. Node: module.exports (UMD-style).
 */
(function (factory) {
	if (typeof module !== "undefined" && module.exports) {
		module.exports = factory();
	} else {
		this.SudokuRng = factory();
	}
})(() => {
	/**
	 * mulberry32: small, fast, high-quality 32-bit seeded PRNG.
	 * @param {number} seed - any number (coerced to uint32)
	 * @returns {() => number} function returning floats in [0, 1)
	 */
	function mulberry32(seed) {
		let a = seed >>> 0;
		return () => {
			a |= 0;
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	/** In-place Fisher–Yates shuffle using the given rng function. */
	function shuffle(arr, rng) {
		for (let i = arr.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1));
			const tmp = arr[i];
			arr[i] = arr[j];
			arr[j] = tmp;
		}
		return arr;
	}

	/** Random 32-bit unsigned integer from an rng function. */
	function uint32(rng) {
		return Math.floor(rng() * 0x100000000) >>> 0;
	}

	return Object.freeze({ mulberry32, shuffle, uint32 });
});
