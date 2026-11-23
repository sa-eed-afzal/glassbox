/**
 * Minimal ambient types for the dev-only `qrcode` package (second-implementation
 * cross-validation in test/qr.test.ts — not a runtime dependency).
 */
declare module "qrcode" {
	export interface QrOptions {
		errorCorrectionLevel?: "L" | "M" | "Q" | "H";
		version?: number;
		maskPattern?: number;
	}
	export interface QrModules {
		size: number;
		data: Uint8Array;
		get(r: number, c: number): number;
	}
	export interface QrSymbol {
		modules: QrModules;
		version: number;
		maskPattern: number;
		errorCorrectionLevel: string;
	}
	export function create(data: string, options?: QrOptions): QrSymbol;
	const qrcode: { create: typeof create };
	export default qrcode;
}
