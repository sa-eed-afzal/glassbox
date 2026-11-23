/**
 * Transport seam (spec §5) between the bridge core and a page session.
 * A real WebSocket session (src/host) and an in-memory test pair both satisfy it,
 * so the bridge core stays transport-agnostic and trivially testable.
 */
export interface Link {
	send(frame: string): void;
	onMessage(cb: (frame: string) => void): void;
	close?(): void;
}
