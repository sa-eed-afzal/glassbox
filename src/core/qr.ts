/**
 * QR Code encoder + structural decode check (ISO/IEC 18004), zero runtime
 * dependencies — the in-bundle encoder for QR connect (spec §5.2, §12 #5, M4).
 *
 * Byte mode only (the connect code is a base64url blob — byte data),
 * automatic version selection (smallest symbol that fits), all four
 * error-correction levels, full mask evaluation (penalties N1–N4).
 *
 * `encodeQr` output is cross-validated in tests bit-for-bit against a second,
 * independent implementation (the dev-only `qrcode` package). `decodeQrPayload`
 * simulates the scan step without image processing: it re-reads the format
 * info from both copies (BCH check), de-masks the data modules in placement
 * order, verifies each block's Reed–Solomon integrity, de-interleaves, and
 * recovers the byte-mode payload — the widget's "scan simulated" self-check
 * behind the scanner-less verification path.
 */

export type EcLevel = "L" | "M" | "Q" | "H";

export interface Qr {
	/** QR version (1–40); the symbol is (17 + 4·version)² modules. */
	version: number;
	/** Data mask (0–7) with the lowest penalty. */
	mask: number;
	/** Symbol size in modules. */
	size: number;
	/** Row-major module map; 1 = dark, 0 = light. */
	modules: Uint8Array;
}

// ---------- fixed tables (ISO/IEC 18004) ----------

/** Total codewords (data + EC) per version; index = version (1–40). */
const TOTAL_CW = [
	0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991,
	1085, 1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876,
	3034, 3196, 3362, 3532, 3706,
];

/** Total EC codewords per version × level; index = (version−1)·4 + levelIdx. */
const EC_CODEWORDS = [
	7, 10, 13, 17, 10, 16, 22, 28, 15, 26, 36, 44, 20, 36, 52, 64, 26, 48, 72, 88, 36, 64, 96, 112,
	40, 72, 108, 130, 48, 88, 132, 156, 60, 110, 160, 192, 72, 130, 192, 224, 80, 150, 224, 264, 96,
	176, 260, 308, 104, 198, 288, 352, 120, 216, 320, 384, 132, 240, 360, 432, 144, 280, 408, 480,
	168, 308, 448, 532, 180, 338, 504, 588, 196, 364, 546, 650, 224, 416, 600, 700, 224, 442, 644,
	750, 252, 476, 690, 816, 270, 504, 750, 900, 300, 560, 810, 960, 312, 588, 870, 1050, 336, 644,
	952, 1110, 360, 700, 1020, 1200, 390, 728, 1050, 1260, 420, 784, 1140, 1350, 450, 812, 1200, 1440,
	480, 868, 1290, 1530, 510, 924, 1350, 1620, 540, 980, 1440, 1710, 570, 1036, 1530, 1800, 570,
	1064, 1590, 1890, 600, 1120, 1680, 1980, 630, 1204, 1770, 2100, 660, 1260, 1860, 2220, 720, 1316,
	1950, 2310, 750, 1372, 2040, 2430,
];

/** EC block counts per version × level; index = (version−1)·4 + levelIdx. */
const EC_BLOCKS = [
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 1, 2, 2, 4, 1, 2, 4, 4, 2, 4, 4, 4, 2, 4, 6, 5, 2, 4, 6, 6, 2,
	5, 8, 8, 4, 5, 8, 8, 4, 5, 8, 11, 4, 8, 10, 11, 4, 9, 12, 16, 4, 9, 16, 16, 6, 10, 12, 18, 6, 10,
	17, 16, 6, 11, 16, 19, 6, 13, 18, 21, 7, 14, 21, 25, 8, 16, 20, 25, 8, 17, 23, 25, 9, 17, 23, 34,
	9, 18, 25, 30, 10, 20, 27, 32, 12, 21, 29, 35, 12, 23, 34, 37, 12, 25, 34, 40, 13, 26, 35, 42, 14,
	28, 38, 45, 15, 29, 40, 48, 16, 31, 43, 51, 17, 33, 45, 54, 18, 35, 48, 57, 19, 37, 51, 60, 19,
	38, 53, 63, 20, 40, 56, 66, 21, 43, 59, 70, 22, 45, 62, 74, 24, 47, 65, 77, 25, 49, 68, 81,
];

/** Format-info bits per level (ISO 18004 §6.4: L=01, M=00, Q=11, H=10). */
const ECL_BITS: Record<EcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };
const LVL_IDX: Record<EcLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** Map format-info ecl bits back to a table index. */
const ECL_IDX_FROM_BITS = [1, 0, 3, 2];

// ---------- GF(256), primitive polynomial 0x11D ----------

const LOG = new Uint8Array(256);
const EXP = new Uint8Array(512);
{
	let x = 1;
	for (let i = 0; i < 255; i++) {
		EXP[i] = x;
		LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!; // no mod-255 needed in mul
}

function gmul(a: number, b: number): number {
	if (a === 0 || b === 0) return 0;
	return EXP[LOG[a]! + LOG[b]!]!;
}

function bitLen(x: number): number {
	let n = 0;
	while (x !== 0) {
		n++;
		x >>>= 1;
	}
	return n;
}

/** Reed–Solomon generator polynomial of `degree` (leading coefficient first). */
function genPoly(degree: number): Uint8Array {
	let poly = new Uint8Array([1]);
	for (let i = 0; i < degree; i++) {
		const factor = new Uint8Array([1, EXP[i]!]);
		const out = new Uint8Array(poly.length + 1);
		for (let a = 0; a < poly.length; a++)
			for (let b = 0; b < factor.length; b++) out[a + b] = out[a + b]! ^ gmul(poly[a]!, factor[b]!);
		poly = out;
	}
	return poly;
}

/** EC codewords for one data block (polynomial division remainder). */
function rsEncode(data: Uint8Array, gen: Uint8Array): Uint8Array {
	const res = new Uint8Array(data.length + gen.length - 1);
	res.set(data);
	for (let i = 0; i < data.length; i++) {
		const coef = res[i]!;
		if (coef !== 0)
			for (let j = 1; j < gen.length; j++) res[i + j] = res[i + j]! ^ gmul(gen[j]!, coef);
	}
	return res.slice(data.length);
}

// ---------- fixed modules ----------

/** Centers of the alignment patterns (version ≥ 2), excluding finder corners. */
function alignmentPositions(version: number): Array<[number, number]> {
	if (version < 2) return [];
	const n = Math.floor(version / 7) + 2;
	const size = 17 + 4 * version;
	const step = size === 145 ? 26 : Math.ceil((size - 13) / (2 * n - 2)) * 2;
	// Build descending from the guaranteed last position (size−7), then 6; the
	// ascending construction diverges from the spec for e.g. v15/v16/v18/….
	const coords: number[] = [size - 7];
	for (let i = 1; i < n - 1; i++) coords.push(coords[i - 1]! - step);
	coords.push(6);
	coords.reverse();
	const out: Array<[number, number]> = [];
	for (let i = 0; i < n; i++)
		for (let j = 0; j < n; j++) {
			if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
			out.push([coords[i]!, coords[j]!]);
		}
	return out;
}

/** 1 = function module (reserved by finders/timing/alignment/format/version). */
function buildReserved(size: number, version: number): Uint8Array {
	const res = new Uint8Array(size * size);
	const finder = (r0: number, c0: number): void => {
		for (let r = -1; r <= 7; r++)
			for (let c = -1; c <= 7; c++) {
				const rr = r0 + r;
				const cc = c0 + c;
				if (rr >= 0 && rr < size && cc >= 0 && cc < size) res[rr * size + cc] = 1;
			}
	};
	finder(0, 0);
	finder(0, size - 7);
	finder(size - 7, 0);
	for (let i = 8; i < size - 8; i++) {
		res[i * size + 6] = 1;
		res[6 * size + i] = 1;
	}
	for (const [ar, ac] of alignmentPositions(version))
		for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) res[(ar + r) * size + (ac + c)] = 1;
	// format info, both copies + the always-dark module (ISO 18004 §6.5)
	for (let i = 0; i < 15; i++) {
		if (i < 6) res[i * size + 8] = 1;
		else if (i < 8) res[(i + 1) * size + 8] = 1;
		else res[(size - 15 + i) * size + 8] = 1;
		if (i < 8) res[8 * size + size - 1 - i] = 1;
		else if (i < 9) res[8 * size + 7] = 1;
		else res[8 * size + 15 - 1 - i] = 1;
	}
	res[(size - 8) * size + 8] = 1;
	if (version >= 7)
		for (let i = 0; i < 18; i++) {
			const r = Math.floor(i / 3);
			const c = (i % 3) + size - 11;
			res[r * size + c] = 1;
			res[c * size + r] = 1;
		}
	return res;
}

function drawFixedModules(mod: Uint8Array, size: number, version: number): void {
	const finder = (r0: number, c0: number): void => {
		for (let r = -1; r <= 7; r++)
			for (let c = -1; c <= 7; c++) {
				const rr = r0 + r;
				const cc = c0 + c;
				if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
				const dark =
					(r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
					(c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
					(r >= 2 && r <= 4 && c >= 2 && c <= 4);
				mod[rr * size + cc] = dark ? 1 : 0;
			}
	};
	finder(0, 0);
	finder(0, size - 7);
	finder(size - 7, 0);
	for (let i = 8; i < size - 8; i++) {
		const v = i % 2 === 0 ? 1 : 0;
		mod[i * size + 6] = v;
		mod[6 * size + i] = v;
	}
	for (const [ar, ac] of alignmentPositions(version))
		for (let r = -2; r <= 2; r++)
			for (let c = -2; c <= 2; c++)
				mod[(ar + r) * size + (ac + c)] =
					r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0) ? 1 : 0;
	// version info (constant for the symbol — present while masks are evaluated)
	if (version >= 7) {
		const bits = versionBits(version);
		for (let i = 0; i < 18; i++) {
			const b = (bits >> i) & 1;
			const r = Math.floor(i / 3);
			const c = (i % 3) + size - 11;
			mod[r * size + c] = b;
			mod[c * size + r] = b;
		}
	}
}

/** 15-bit format info (BCH(15,5), generator 0x537, XOR mask 0x5412). */
function formatBits(lvl: EcLevel, mask: number): number {
	const data5 = (ECL_BITS[lvl] << 3) | mask;
	let d = data5 << 10;
	while (bitLen(d) >= 11) d ^= 0x537 << (bitLen(d) - 11);
	return ((data5 << 10) | d) ^ 0x5412;
}

/** 18-bit version info (BCH(18,6), generator 0x1f25); version ≥ 7 only. */
function versionBits(version: number): number {
	let d = version << 12;
	while (bitLen(d) >= 13) d ^= 0x1f25 << (bitLen(d) - 13);
	return (version << 12) | d;
}

/**
 * Write the format-info bits for `mask` (both copies + the always-dark module).
 * The mask candidate's own bits must be present while its penalty is evaluated.
 */
function writeFormatInfo(mod: Uint8Array, size: number, lvl: EcLevel, mask: number): void {
	const fmt = formatBits(lvl, mask);
	for (let i = 0; i < 15; i++) {
		const b = (fmt >> i) & 1;
		if (i < 6) mod[i * size + 8] = b;
		else if (i < 8) mod[(i + 1) * size + 8] = b;
		else mod[(size - 15 + i) * size + 8] = b;
		if (i < 8) mod[8 * size + size - 1 - i] = b;
		else if (i < 9) mod[8 * size + 7] = b;
		else mod[8 * size + 15 - 1 - i] = b;
	}
	mod[(size - 8) * size + 8] = 1;
}

// ---------- data codewords ----------

/** Smallest version whose byte-mode capacity fits `dataLen` bytes. */
function pickVersion(dataLen: number, lvlIdx: number): number {
	for (let v = 1; v <= 40; v++) {
		const dataCw = TOTAL_CW[v]! - EC_CODEWORDS[(v - 1) * 4 + lvlIdx]!;
		const usable = dataCw * 8 - 4 - (v < 10 ? 8 : 16);
		if (dataLen * 8 <= usable) return v;
	}
	throw new Error("glassbox qr: payload too large for any QR version");
}

/** Byte-mode codeword stream: mode + count + data, terminator, 0xEC/0x11 pads. */
function dataCodewords(version: number, lvlIdx: number, data: Uint8Array): Uint8Array {
	const dataCw = TOTAL_CW[version]! - EC_CODEWORDS[(version - 1) * 4 + lvlIdx]!;
	const ccBits = version < 10 ? 8 : 16;
	const bits: number[] = [];
	const push = (val: number, n: number): void => {
		for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
	};
	push(0b0100, 4);
	push(data.length, ccBits);
	for (const b of data) push(b, 8);
	const total = dataCw * 8;
	if (bits.length + 4 <= total) push(0, 4);
	while (bits.length % 8 !== 0) bits.push(0);
	const pads = [0xec, 0x11];
	let pad = 0;
	while (bits.length < total) {
		push(pads[pad % 2]!, 8);
		pad++;
	}
	const out = new Uint8Array(dataCw);
	for (let i = 0; i < dataCw; i++) {
		let v = 0;
		for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]!;
		out[i] = v;
	}
	return out;
}

/**
 * Full codeword stream: each block RS-encoded, then data codewords and EC
 * codewords interleaved block-wise (ISO 18004 §8.6).
 */
function encodeAll(data: Uint8Array, version: number, lvlIdx: number): Uint8Array {
	const totalCw = TOTAL_CW[version]!;
	const ecCw = EC_CODEWORDS[(version - 1) * 4 + lvlIdx]!;
	const dataCw = totalCw - ecCw;
	const blocks = EC_BLOCKS[(version - 1) * 4 + lvlIdx]!;
	const g2 = totalCw % blocks; // blocks with the larger data size
	const g1 = blocks - g2;
	const d1 = Math.floor(dataCw / blocks);
	const d2 = d1 + 1;
	const ecPer = Math.floor(totalCw / blocks) - d1;
	const gen = genPoly(ecPer);
	const dc: Uint8Array[] = [];
	const ec: Uint8Array[] = [];
	let off = 0;
	for (let b = 0; b < blocks; b++) {
		const ds = b < g1 ? d1 : d2;
		const block = data.subarray(off, off + ds);
		dc.push(block);
		ec.push(rsEncode(block, gen));
		off += ds;
	}
	const out = new Uint8Array(totalCw);
	let idx = 0;
	for (let i = 0; i < d2; i++)
		for (let b = 0; b < blocks; b++) if (i < (b < g1 ? d1 : d2)) out[idx++] = dc[b]![i]!;
	for (let i = 0; i < ecPer; i++) for (let b = 0; b < blocks; b++) out[idx++] = ec[b]![i]!;
	return out;
}

// ---------- placement & masking ----------

/** Data-module positions in placement order (zigzag from bottom-right, skipping column 6). */
function* placementOrder(size: number, reserved: Uint8Array): Generator<[number, number]> {
	let inc = -1;
	let row = size - 1;
	for (let col = size - 1; col > 0; col -= 2) {
		if (col === 6) col--;
		while (true) {
			for (let c = 0; c < 2; c++) {
				if (reserved[row * size + col - c] === 0) yield [row, col - c];
			}
			row += inc;
			if (row < 0 || row >= size) {
				row -= inc;
				inc = -inc;
				break;
			}
		}
	}
}

function maskAt(mask: number, r: number, c: number): boolean {
	switch (mask) {
		case 0:
			return (r + c) % 2 === 0;
		case 1:
			return r % 2 === 0;
		case 2:
			return c % 3 === 0;
		case 3:
			return (r + c) % 3 === 0;
		case 4:
			return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
		case 5:
			return ((r * c) % 2) + ((r * c) % 3) === 0;
		case 6:
			return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
		default:
			return (((r * c) % 3) + ((r + c) % 2)) % 2 === 0;
	}
}

function applyMask(mask: number, mod: Uint8Array, reserved: Uint8Array, size: number): void {
	for (let r = 0; r < size; r++)
		for (let c = 0; c < size; c++)
			if (reserved[r * size + c] === 0)
				mod[r * size + c] = mod[r * size + c]! ^ (maskAt(mask, r, c) ? 1 : 0);
}

function n1Line(size: number, get: (i: number) => number): number {
	let points = 0;
	let run = 0;
	let last = -1;
	for (let i = 0; i < size; i++) {
		const v = get(i);
		if (v === last) run++;
		else {
			if (run >= 5) points += 3 + (run - 5);
			last = v;
			run = 1;
		}
	}
	if (run >= 5) points += 3 + (run - 5);
	return points;
}

function n3Line(size: number, get: (i: number) => number): number {
	let points = 0;
	let bits = 0;
	for (let i = 0; i < size; i++) {
		bits = ((bits << 1) & 0x7ff) | get(i);
		if (i >= 10 && (bits === 0x5d0 || bits === 0x5d)) points += 40;
	}
	return points;
}

/** ISO 18004 §7.8 mask penalty: N1 + N2 + N3 + N4. */
function penalty(mod: Uint8Array, size: number): number {
	let p = 0;
	for (let r = 0; r < size; r++) p += n1Line(size, (i) => mod[r * size + i]!);
	for (let c = 0; c < size; c++) p += n1Line(size, (i) => mod[i * size + c]!);
	for (let r = 0; r < size - 1; r++)
		for (let c = 0; c < size - 1; c++) {
			const v =
				mod[r * size + c]! +
				mod[r * size + c + 1]! +
				mod[(r + 1) * size + c]! +
				mod[(r + 1) * size + c + 1]!;
			if (v === 0 || v === 4) p += 3;
		}
	for (let r = 0; r < size; r++) p += n3Line(size, (i) => mod[r * size + i]!);
	for (let c = 0; c < size; c++) p += n3Line(size, (i) => mod[i * size + c]!);
	let dark = 0;
	for (let i = 0; i < mod.length; i++) dark += mod[i]!;
	p += Math.abs(Math.ceil((dark * 100) / mod.length / 5) - 10) * 10;
	return p;
}

// ---------- public API ----------

/**
 * Encode `text` as a QR symbol (byte mode, automatic version, mask chosen by
 * lowest penalty). The default EC level is L — the QR-connect budget (spec
 * §12 #5: ~200-char code blob, smallest scannable symbol).
 */
export function encodeQr(text: string, opts: { ecLevel?: EcLevel } = {}): Qr {
	if (text.length === 0) throw new Error("glassbox qr: empty payload");
	const lvl = opts.ecLevel ?? "L";
	const lvlIdx = LVL_IDX[lvl];
	const data = new Uint8Array(new TextEncoder().encode(text));
	const version = pickVersion(data.length, lvlIdx);
	const all = encodeAll(dataCodewords(version, lvlIdx, data), version, lvlIdx);

	const size = 17 + 4 * version;
	const mod = new Uint8Array(size * size);
	const reserved = buildReserved(size, version);
	drawFixedModules(mod, size, version);

	let bitIdx = 7;
	let byteIdx = 0;
	for (const [r, c] of placementOrder(size, reserved)) {
		mod[r * size + c] = byteIdx < all.length ? (all[byteIdx]! >>> bitIdx) & 1 : 0;
		bitIdx--;
		if (bitIdx < 0) {
			bitIdx = 7;
			byteIdx++;
		}
	}

	let best = 0;
	let bestPenalty = Infinity;
	for (let m = 0; m < 8; m++) {
		writeFormatInfo(mod, size, lvl, m); // candidate's own bits count toward the penalty
		applyMask(m, mod, reserved, size);
		const p = penalty(mod, size);
		applyMask(m, mod, reserved, size); // undo
		if (p < bestPenalty) {
			bestPenalty = p;
			best = m;
		}
	}
	applyMask(best, mod, reserved, size);
	writeFormatInfo(mod, size, lvl, best);
	return { version, mask: best, size, modules: mod };
}

/**
 * Simulated scan: recover the payload a scanner would read from `qr`, or
 * return null if the symbol is inconsistent (format copies disagree, BCH
 * fails, RS integrity fails, or the data is not a well-formed byte-mode
 * payload). No image processing — the matrix is read structurally.
 */
export function decodeQrPayload(qr: Qr): string | null {
	try {
		const { version, size, modules } = qr;
		if (version < 1 || version > 40 || size !== 17 + 4 * version) return null;
		const reserved = buildReserved(size, version);
		const get = (r: number, c: number): number => modules[r * size + c]!;

		// format info: bit i (LSB-first) at these positions, both copies
		const posA: Array<[number, number]> = [
			[0, 8],
			[1, 8],
			[2, 8],
			[3, 8],
			[4, 8],
			[5, 8],
			[7, 8],
			[8, 8],
			[8, 7],
		];
		for (let i = 9; i < 15; i++) posA.push([8, 14 - i]);
		const posB: Array<[number, number]> = [];
		for (let i = 0; i < 8; i++) posB.push([8, size - 1 - i]);
		for (let i = 8; i < 15; i++) posB.push([size - 15 + i, 8]);
		const toVal = (pos: Array<[number, number]>): number =>
			pos.reduce((v, [r, c], i) => v | (get(r, c) << i), 0);
		const va = toVal(posA);
		if (va !== toVal(posB)) return null;
		const xored = va ^ 0x5412;
		const data5 = xored >> 10;
		let rem = data5 << 10;
		while (bitLen(rem) >= 11) rem ^= 0x537 << (bitLen(rem) - 11);
		if (rem !== (xored & 0x3ff)) return null;
		const ecl = data5 >> 3;
		const mask = data5 & 7;
		if (ecl > 3) return null;

		// data modules: de-mask in placement order, LSB-first per codeword
		let bit = 0;
		let nBits = 0;
		const cw: number[] = [];
		for (const [r, c] of placementOrder(size, reserved)) {
			bit = (bit << 1) | (get(r, c) ^ (maskAt(mask, r, c) ? 1 : 0));
			if (++nBits === 8) {
				cw.push(bit);
				bit = 0;
				nBits = 0;
			}
		}
		if (cw.length !== TOTAL_CW[version]!) return null;

		// RS integrity per block (verify only — no correction; a scanner would correct).
		// Interleaved position of data codeword (i, b): row i holds only blocks whose
		// data size exceeds i, so the larger blocks' extra row compacts to
		// d1·blocks + (b − g1).
		const lvlIdx = ECL_IDX_FROM_BITS[ecl]!;
		const totalCw = TOTAL_CW[version]!;
		const dataCw = totalCw - EC_CODEWORDS[(version - 1) * 4 + lvlIdx]!;
		const blocks = EC_BLOCKS[(version - 1) * 4 + lvlIdx]!;
		const g2 = totalCw % blocks;
		const g1 = blocks - g2;
		const d1 = Math.floor(dataCw / blocks);
		const d2 = d1 + 1;
		const ecPer = Math.floor(totalCw / blocks) - d1;
		const dataPos = (i: number, b: number): number =>
			i < d1 ? i * blocks + b : i * blocks + b - g1;
		for (let b = 0; b < blocks; b++) {
			const ds = b < g1 ? d1 : d2;
			const block: number[] = [];
			for (let i = 0; i < ds; i++) block.push(cw[dataPos(i, b)]!);
			for (let i = 0; i < ecPer; i++) block.push(cw[dataCw + i * blocks + b]!);
			for (let k = 0; k < ecPer; k++) {
				let s = 0;
				for (const v of block) s = s === 0 ? v : EXP[LOG[s]! + k]! ^ v;
				if (s !== 0) return null;
			}
		}

		// de-interleave → data codewords (block 0's data followed by block 1's, …)
		const dBytes: number[] = [];
		for (let b = 0; b < blocks; b++)
			for (let i = 0; i < (b < g1 ? d1 : d2); i++) dBytes.push(cw[dataPos(i, b)]!);
		if (dBytes.length !== dataCw) return null;

		// byte-mode payload + terminator + pad structure
		const totalBits = dataCw * 8;
		const bitAt = (i: number): number => (dBytes[Math.floor(i / 8)]! >> (7 - (i % 8))) & 1;
		const mode = (bitAt(0) << 3) | (bitAt(1) << 2) | (bitAt(2) << 1) | bitAt(3);
		if (mode !== 0b0100) return null;
		const ccn = version < 10 ? 8 : 16;
		let cc = 0;
		for (let i = 4; i < 4 + ccn; i++) cc = (cc << 1) | bitAt(i);
		if (4 + ccn + cc * 8 > totalBits) return null;
		const payload: number[] = [];
		const byteStart = (4 + ccn) % 8; // payload starts mid-codeword (bit 12 / 20)
		for (let i = 4 + ccn; i < 4 + ccn + cc * 8; i++) {
			if (i % 8 === byteStart) payload.push(0);
			payload[payload.length - 1] = (payload[payload.length - 1]! << 1) | bitAt(i);
		}
		let p = 4 + ccn + cc * 8;
		const term = Math.min(4, totalBits - p);
		for (let i = 0; i < term; i++) if (bitAt(p + i) !== 0) return null;
		p += term;
		while (p % 8 !== 0) {
			if (bitAt(p) !== 0) return null;
			p++;
		}
		for (let byte = 0; p + byte * 8 < totalBits; byte++) {
			const expected = byte % 2 === 0 ? 0xec : 0x11;
			for (let j = 0; j < 8; j++)
				if (bitAt(p + byte * 8 + j) !== ((expected >> (7 - j)) & 1)) return null;
		}
		return new TextDecoder().decode(new Uint8Array(payload));
	} catch {
		return null;
	}
}

/** Terminal art for `qr` (default: 2-wide modules, 2-module quiet zone). */
export function qrToAscii(qr: Qr, opts: { scale?: number; quiet?: number } = {}): string {
	const scale = opts.scale ?? 2;
	const quiet = opts.quiet ?? 2;
	const dark = scale >= 2 ? "██" : "█";
	const light = scale >= 2 ? "  " : " ";
	const lines: string[] = [];
	const border = " ".repeat((qr.size + quiet * 2) * scale);
	lines.push(border);
	const pad = light.repeat(quiet);
	for (let r = 0; r < qr.size; r++) {
		let line = pad;
		for (let c = 0; c < qr.size; c++) line += qr.modules[r * qr.size + c]! !== 0 ? dark : light;
		lines.push(line + pad);
	}
	lines.push(border);
	return lines.join("\n");
}

/** Compact SVG (single run-length path, `fill="currentColor"`) for the widget. */
export function qrToSvg(qr: Qr, opts: { quiet?: number } = {}): string {
	const quiet = opts.quiet ?? 2;
	const n = qr.size + quiet * 2;
	let d = "";
	for (let r = 0; r < qr.size; r++) {
		let c = 0;
		while (c < qr.size) {
			if (qr.modules[r * qr.size + c]! !== 0) {
				let w = 0;
				while (c + w < qr.size && qr.modules[r * qr.size + c + w]! !== 0) w++;
				d += `M${c + quiet} ${r + quiet}h${w}v1h-${w}z`;
				c += w;
			} else {
				c++;
			}
		}
	}
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" ` +
		`shape-rendering="crispEdges" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`
	);
}
