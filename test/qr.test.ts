/**
 * QR connect (spec §5.2, §12 #5): the in-bundle encoder cross-validated
 * bit-for-bit against a second, independent implementation (dev-only
 * `qrcode` package), plus the structural "scan simulated" decode check and
 * the terminal/SVG renderers.
 */
import fc from "fast-check";
import * as QR from "qrcode";
import { describe, expect, it } from "vitest";
import { decodeQrPayload, type EcLevel, encodeQr, qrToAscii, qrToSvg } from "../src/core/qr.js";

/** A realistic glassbox connect-code blob (spec §5.2 code format). */
function codeBlob(): string {
	const json = JSON.stringify({
		v: "gbx/v1",
		host: "127.0.0.1",
		port: 47123,
		channel: "127.0.0.1:47123",
		app: "echo-app",
		codeId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
		expMs: 60000,
	});
	return Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Printable ASCII characters that are never alphanumeric per the QR spec
 * (`[A-Z0-9 $%*+-./:]` is the alphanumeric set; digits are the numeric set).
 * The reference encoder (`qrcode`) runs a Dijkstra segment optimizer that
 * splits a payload into numeric/alphanumeric/byte segments whenever that
 * saves bits, while this encoder is byte-mode only — two valid but
 * different codeword streams, hence different matrices. Restricting test
 * payloads to this alphabet forces a single byte-mode segment on both
 * sides, which makes the bit-for-bit comparison meaningful.
 */
const SAFE_ALPHABET: string[] = [];
for (let c = 33; c <= 126; c++) {
	const ch = String.fromCharCode(c);
	if (!/[A-Z0-9$%*+\-./:]/.test(ch)) SAFE_ALPHABET.push(ch);
}

/** Deterministic pseudo-random string over the byte-mode-only alphabet. */
function ascii(len: number, seed = 0): string {
	let s = "";
	let x = seed + len;
	for (let i = 0; i < len; i++) {
		x = (x * 1103515245 + 12345) & 0x7fffffff;
		s += SAFE_ALPHABET[x % SAFE_ALPHABET.length]!;
	}
	return s;
}

function refSymbol(text: string, level: EcLevel): { m: Uint8Array; version: number; mask: number } {
	const c = QR.create(text, { errorCorrectionLevel: level });
	const s = c.modules.size;
	const m = new Uint8Array(s * s);
	for (let r = 0; r < s; r++)
		for (let col = 0; col < s; col++) m[r * s + col] = c.modules.get(r, col) ? 1 : 0;
	return { m, version: c.version, mask: c.maskPattern };
}

describe("qr encoder vs second implementation (bit-for-bit)", () => {
	const lengths = [
		1, 2, 3, 5, 10, 15, 20, 32, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300, 400, 500, 700, 1000,
	];

	it.each(lengths)("matches the reference at length %i (EC L)", (len) => {
		const text = ascii(len, len);
		const mine = encodeQr(text, { ecLevel: "L" });
		const ref = refSymbol(text, "L");
		expect(mine.version).toBe(ref.version);
		expect(mine.mask).toBe(ref.mask);
		expect(Array.from(mine.modules)).toEqual(Array.from(ref.m));
	});

	it("matches the reference for a realistic connect-code blob (EC L)", () => {
		const blob = codeBlob();
		const mine = encodeQr(blob);
		const ref = refSymbol(blob, "L");
		expect(mine.version).toBe(ref.version);
		expect(mine.mask).toBe(ref.mask);
		expect(Array.from(mine.modules)).toEqual(Array.from(ref.m));
	});

	it.each(["M", "Q", "H"] as const)("matches the reference at EC level %s", (level) => {
		for (const len of [1, 20, 60, 130, 200, 320, 500]) {
			const text = ascii(len, len + 7);
			const mine = encodeQr(text, { ecLevel: level });
			const ref = refSymbol(text, level);
			expect(mine.version, `version @len ${len}`).toBe(ref.version);
			expect(mine.mask, `mask @len ${len}`).toBe(ref.mask);
			expect(Array.from(mine.modules), `modules @len ${len}`).toEqual(Array.from(ref.m));
		}
	});

	it("matches the reference for random payloads (property)", () => {
		fc.assert(
			fc.property(fc.string({ minLength: 1, maxLength: 399 }), (raw) => {
				// project onto the byte-mode-only alphabet (see SAFE_ALPHABET)
				const text = [...raw]
					.map((ch) => SAFE_ALPHABET[ch.charCodeAt(0) % SAFE_ALPHABET.length]!)
					.join("");
				const mine = encodeQr(text, { ecLevel: "L" });
				const ref = refSymbol(text, "L");
				return (
					mine.version === ref.version &&
					mine.mask === ref.mask &&
					mine.modules.every((v, i) => v === ref.m[i])
				);
			}),
			{ numRuns: 120 },
		);
	});

	it("is deterministic", () => {
		const a = encodeQr(codeBlob());
		const b = encodeQr(codeBlob());
		expect(Array.from(a.modules)).toEqual(Array.from(b.modules));
		expect(a.version).toBe(b.version);
	});

	it("rejects payloads beyond v40 capacity", () => {
		expect(() => encodeQr(ascii(3000))).toThrow(/too large/);
	});
});

describe("qr simulated-scan decode (structural round-trip)", () => {
	it("recovers the connect-code blob verbatim", () => {
		const blob = codeBlob();
		expect(decodeQrPayload(encodeQr(blob))).toBe(blob);
	});

	it("recovers payloads across versions and EC levels", () => {
		for (const len of [1, 3, 15, 32, 60, 100, 150, 200, 300, 500, 900]) {
			const text = ascii(len, len);
			for (const lvl of ["L", "M", "H"] as const) {
				expect(decodeQrPayload(encodeQr(text, { ecLevel: lvl })), `len ${len} ${lvl}`).toBe(text);
			}
		}
	});

	it("recovers non-ASCII UTF-8 payloads", () => {
		const text = `héllo wörld ✓ — code: ${codeBlob().slice(0, 40)}`;
		expect(decodeQrPayload(encodeQr(text))).toBe(text);
	});

	it("rejects a corrupted data module (RS integrity fails)", () => {
		const blob = codeBlob();
		const qr = encodeQr(blob);
		// flip a data module: (1,10) is outside finders/format/timing/alignment for v1–v40
		const idx = 1 * qr.size + 10;
		const qr2 = { ...qr, modules: qr.modules.slice() };
		qr2.modules[idx] = qr2.modules[idx]! ^ 1;
		expect(decodeQrPayload(qr2)).toBeNull();
	});

	it("rejects a corrupted format-info bit", () => {
		const qr = encodeQr(ascii(50));
		const qr2 = { ...qr, modules: qr.modules.slice() };
		qr2.modules[8 * qr.size + 3] = qr2.modules[8 * qr.size + 3]! ^ 1; // format copy A
		expect(decodeQrPayload(qr2)).toBeNull();
	});

	it("rejects a non-QR shape", () => {
		expect(
			decodeQrPayload({ version: 1, mask: 0, size: 22, modules: new Uint8Array(22 * 22) }),
		).toBeNull();
	});
});

describe("qr renderers", () => {
	const qr = encodeQr(codeBlob());

	it("ascii: quiet zone + one line per module row, uniform width", () => {
		const lines = qrToAscii(qr).split("\n");
		expect(lines).toHaveLength(qr.size + 2); // border row top + bottom
		const w = (qr.size + 4) * 2; // 2-module quiet zone, scale 2
		for (const line of lines) expect(line).toHaveLength(w);
	});

	it("ascii: scale 1 is single-wide", () => {
		const line = qrToAscii(qr, { scale: 1 }).split("\n")[1]!;
		expect(line).toHaveLength(qr.size + 4);
	});

	it("svg: single-path, currentColor, correct viewBox", () => {
		const svg = qrToSvg(qr);
		const n = qr.size + 4;
		expect(svg).toContain(`<svg`);
		expect(svg).toContain(`viewBox="0 0 ${n} ${n}"`);
		expect(svg).toContain(`fill="currentColor"`);
		expect(svg).toMatch(/<path d="M.*z"\/><\/svg>$/);
		const m = svg.match(/d="([^"]+)"/)!;
		expect(m[1]).not.toContain("NaN");
	});

	it("svg dark-area sanity: finder corners are dark in both encodings", () => {
		const lines = qrToAscii(qr).split("\n");
		// first module row, after the quiet-zone pad (scale 2 → 4 spaces)
		expect(lines[1]!.slice(4).startsWith("██")).toBe(true); // top-left finder dark
		const svg = qrToSvg(qr);
		expect(svg).toContain("M2 2h7v1"); // finder top row: 7 dark modules at (2,2)
	});
});
