/** Public API for the mcp-glassbox bridge. */

export {
	type AuditConsent,
	type AuditEntry,
	type AuditSink,
	FileAudit,
	InMemoryAudit,
} from "./bridge/audit.js";
export {
	Bridge,
	type BridgeOptions,
	type ChannelAgg,
	type ChannelView,
	hashArgs,
	type McpToolView,
	type Session,
	type SessionView,
	type Tier,
	type ToolRegistration,
} from "./bridge/bridge.js";
export {
	type CodeRecord,
	CodeStore,
	type MintedCode,
	type MintOpts,
	type ParsedCode,
} from "./bridge/code.js";
export type { Link } from "./bridge/link.js";
export {
	autoPolicy,
	type ConsentDecision,
	DEFAULT_TIER_POLICY,
	defaultPolicy,
	loadPolicy,
	type Policy,
	PolicyError,
	PolicyFile,
	type PolicyResolver,
	resolveDecision,
	type TierPolicy,
	validatePolicy,
} from "./bridge/policy.js";
export { ManualScheduler, nodeScheduler, type Scheduler } from "./bridge/scheduler.js";
export { main as cliMain } from "./cli.js";
export {
	type Credential,
	defaultCredsFile,
	generateKey,
	loadOrCreate,
} from "./core/credentials.js";
export {
	NonceAuth,
	type NonceAuthOptions,
	NonceRegistry,
	publicKeyFromB64,
	signingMessage,
	signRequest,
	verifyRequest,
} from "./core/nonce.js";
export {
	checkAuditModes,
	checkCredentialFile,
	checkDependencies,
	runSelfCheck,
	type SelfCheckOptions,
	type SelfCheckProblem,
	type SelfCheckResult,
} from "./core/selfcheck.js";
export { createHost, type Host, type HostEndpoint, type HostOptions } from "./host/host.js";
export { createMcpServer, type McpHandle } from "./mcp/server.js";
