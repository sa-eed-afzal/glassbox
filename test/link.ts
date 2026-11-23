/** Minimal in-process transport pair. In M1 this becomes the WebSocket link — same codec. */
export interface Link {
	send(frame: string): void;
	onMessage(cb: (frame: string) => void): void;
}

export function makePair(): { a: Link; b: Link } {
	let aCb: ((f: string) => void) | undefined;
	let bCb: ((f: string) => void) | undefined;
	const a: Link = {
		send: (f) => queueMicrotask(() => bCb?.(f)),
		onMessage: (cb) => (aCb = cb),
	};
	const b: Link = {
		send: (f) => queueMicrotask(() => aCb?.(f)),
		onMessage: (cb) => (bCb = cb),
	};
	return { a, b };
}

/** Let queued microtasks / immediates settle. */
export async function flush(times = 4): Promise<void> {
	for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}
