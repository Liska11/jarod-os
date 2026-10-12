// GÉNÉRÉ par scripts/gen_hermes_shim.cjs depuis S:\SANK-UI\src\shared (rév. 3aaadb0, MIT © github.com/fathah). Ne pas éditer à la main.
/**
 * Types des charges utiles de la surface `hermesAPI` (dette D1 soldée) : repris à l'identique des
 * modules `src/shared/*` de SANK-UI que son preload importe, avec leurs dépendances de types
 * (40 déclarations, 13 modules). Aucune valeur : seulement des types.
 */
/* eslint-disable */

// ── shared/i18n/types.ts ──

export type AppLocale =
  | "en"
  | "ar"
  | "es"
  | "he"
  | "id"
  | "ja"
  | "pl"
  | "pt-BR"
  | "pt-PT"
  | "tr"
  | "zh-CN"
  | "zh-TW";

// ── shared/attachments.ts ──

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
  // Images: data:image/<mime>;base64,<...>
  dataUrl?: string;
  // Images: present iff the renderer transcoded/downsampled the source
  // before pushing the attachment (e.g. a 12 MB photo compressed to fit
  // the gateway's 10 MB request-body cap — see #405). UI uses this to
  // surface the size delta in the attachment chip so the user knows
  // quality changed.
  originalSize?: number;
  // Text files: raw UTF-8 contents (already validated to be text)
  text?: string;
  // Path-ref attachments (PDFs, docx, etc.): absolute filesystem path.
  // Origin is the original file path for picker/drag-drop, or a staged
  // copy under %LOCALAPPDATA%/hermes/desktop-staging/<session>/ for paste.
  path?: string;
}

// Shared attachment constants + helpers used by renderer, preload, and main.
// Do not import renderer-only or main-only modules from this file.

export type AttachmentKind = "image" | "text-file" | "path-ref";

// ── shared/model-override.ts ──

/**
 * A session-scoped model selection made from the in-chat (bottom) model
 * picker. Unlike the persisted `config.yaml` default, this override belongs to
 * one conversation only; desktop persists it by session id and threads it
 * through the send pipeline on every message (renderer → preload IPC → main
 * `sendMessage`).
 *
 * It carries the *full* model identity — not just the model name — because a
 * cross-provider switch (e.g. an OpenAI-Codex default → Gemini) must change the
 * provider and base URL that the request routes through, not only the `model`
 * string. It intentionally stores only routing identity — never API keys.
 */
export interface SessionModelOverride {
  provider: string;
  model: string;
  baseUrl: string;
}

// ── shared/session-continuation.ts ──

export type DesktopSessionContinuationItem =
  | {
      kind: "user";
      content: string;
      attachments?: Attachment[];
    }
  | {
      kind: "assistant";
      content: string;
      error?: string;
      attachments?: Attachment[];
    }
  | {
      kind: "reasoning";
      text: string;
    }
  | {
      kind: "tool_call";
      callId: string;
      name: string;
      args: string;
    }
  | {
      kind: "tool_result";
      callId: string;
      name: string;
      content: string;
      attachments?: Attachment[];
    };

export interface DesktopSessionLocalError {
  error: string;
  userContent: string;
}

// ── shared/wallets.ts ──

export interface ImportWalletInput {
  profile?: string;
  name?: string;
  recoveryPhrase: string;
}

export interface ProfileWallet {
  id: string;
  name: string;
  address: string;
  network: typeof BASE_NETWORK_ID;
  createdAt: number;
  imported: boolean;
}

export declare const BASE_NETWORK_ID: "base";

/** Result of provisioning a backend (Bankr) wallet for a profile's agent. */
export interface ProvisionWalletResult {
  /** `exists`: the agent already has a provisioned wallet (backend 409). */
  status: "ok" | "exists" | "signed-out" | "unlinked" | "foreign" | "error";
  wallet?: WalletView;
  error?: string;
}

/**
 * A wallet as the pane renders it, from either origin. Local wallets come from
 * the per-profile `wallets.json`; cloud wallets are fetched live from the
 * backend for the profile's linked agent and are never persisted locally.
 */
export interface WalletView {
  id: string;
  name: string;
  address: string;
  network: typeof BASE_NETWORK_ID;
  source: "local" | "cloud";
  createdAt: number;
  /** Local only: whether the wallet was imported vs generated. */
  imported?: boolean;
  /** Cloud only: backend wallet kind ("bankr" | "local" | "external"). */
  kind?: string;
  /** Cloud only: address is receive-only (no custody on this device). */
  receiveOnly?: boolean;
  /** Cloud only: backend can move funds (has a stored transaction secret). */
  canTransact?: boolean;
}

export interface WalletMutationResult {
  success: boolean;
  wallet?: ProfileWallet;
  recoveryPhrase?: string;
  error?: string;
}

/** Result of `GET /api/wallets/:id/portfolio` for a profile's cloud wallet. */
export interface WalletPortfolioResult {
  /** `foreign`: the profile's cloud link belongs to a different account. */
  status: "ok" | "signed-out" | "unlinked" | "foreign" | "error";
  totalUsd?: number;
  tokens?: PortfolioTokenView[];
  error?: string;
}

/** One token row of a cloud wallet's portfolio (backend-normalised shape). */
export interface PortfolioTokenView {
  symbol: string;
  name: string;
  /** Human-readable amount (backend normalises decimals). */
  balance: number;
  balanceUsd: number;
}

/** Result of fetching the linked agent's cloud wallets. */
export interface WalletSyncResult {
  /** `foreign`: the profile's cloud link belongs to a different account. */
  status: "ok" | "signed-out" | "unlinked" | "foreign" | "error";
  /** Cloud wallets only; the renderer merges local wallets in separately. */
  wallets: WalletView[];
  error?: string;
}

// ── shared/tokens.ts ──

export interface TokenBalancesResponse {
  address: string;
  balances: TokenBalanceResult[];
  /** Epoch ms when the balances were fetched. */
  fetchedAt: number;
}

export interface TokenBalanceResult {
  tokenId: string;
  symbol: string;
  /** Raw BigInt balance as a decimal string, e.g. "1000000000000000000". */
  raw: string;
  /** Compact formatted balance with K/M suffixes, e.g. "10.5K". */
  formatted: string;
  /** Full formatted balance without suffixes, e.g. "10500". Used for tooltips. */
  formattedFull: string;
  /** Present when the RPC call for this token failed. */
  error?: string;
}

// ── shared/custom-providers.ts ──

/**
 * A user-configured custom (OpenAI-compatible) LLM provider, persisted as a
 * first-class record in the desktop's per-profile `providers.json`.
 *
 * This store owns provider *identity* only — its name and base URL. The API key
 * still lives in the profile's `.env` (under `customProviderEnvKey(name)`, the
 * value never stored here) and the provider's models still live in the global
 * `models.json`. Keeping identity here is what lets a provider render as a card
 * the moment it is saved, before any model is added — previously the card was
 * re-derived solely from `models.json`, so a keyed-but-modelless provider was
 * invisible.
 */
export interface CustomProviderRecord {
  /** Stable id (uuid). */
  id: string;
  /** Display name; also the anchor from which the `.env` key name is derived. */
  name: string;
  /** OpenAI-compatible endpoint base URL. */
  baseUrl: string;
  /** Epoch ms the record was first created. */
  createdAt: number;
}

// ── shared/messaging-platforms.ts ──

export interface MessagingPlatformsResponse {
  editable: boolean;
  message?: string;
  platforms: MessagingPlatformInfo[];
  source: "desktop" | "remote-api";
}

export interface MessagingPlatformInfo {
  configured: boolean;
  description: string;
  docs_url: string;
  enabled: boolean;
  env_vars: MessagingEnvVarInfo[];
  error_code?: string | null;
  error_message?: string | null;
  gateway_running: boolean;
  home_channel?: MessagingHomeChannel | null;
  id: string;
  name: string;
  state?: string | null;
  toolsets: MessagingToolsetInfo[];
  updated_at?: string | null;
}

export interface MessagingEnvVarInfo {
  advanced: boolean;
  description: string;
  is_password: boolean;
  is_set: boolean;
  key: string;
  prompt: string;
  redacted_value: string | null;
  required: boolean;
  url: string | null;
}

export interface MessagingHomeChannel {
  chat_id: string;
  name: string;
  platform: string;
  thread_id?: string;
}

export interface MessagingToolsetInfo {
  description: string;
  enabled: boolean;
  key: string;
  label: string;
  risk: MessagingToolsetRisk;
}

export type MessagingToolsetRisk = "normal" | "high";

export interface MessagingPlatformTestResponse {
  message: string;
  ok: boolean;
  state?: string | null;
}

export interface MessagingPlatformUpdate {
  clear_env?: string[];
  enabled?: boolean;
  env?: Record<string, string>;
  toolsets?: Record<string, boolean>;
}

// ── shared/chat-stream.ts ──

export interface ChatToolEvent {
  callId: string;
  hasStableCallId?: boolean;
  name: string;
  status: "running" | "completed" | "failed";
  label?: string;
  emoji?: string;
  preview?: string;
  result?: string;
}

// ── shared/account.ts ──

/** Emitted once the backend issues a device code, so the modal can show it. */
export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

/** Outcome of the auto-provisioned Hermes One Inference key check. */
export interface EnsureHermesOneKeyResult {
  status: "created" | "exists" | "signed-out" | "error";
  error?: string;
}

export interface HermesAccount {
  apiUrl: string;
  user: HermesAccountUser;
}

// Shared shapes for the Hermes account (device-login) surface, used across the
// main process, preload bridge, and renderer.

export interface HermesAccountUser {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

/** The signed-in account's AI-credit balance (USD-denominated; null when
 *  signed out or unavailable). */
export interface HermesOneCreditsResult {
  balance: number | null;
  error?: string;
}

// ── shared/agent-sync.ts ──

export interface AgentSyncResult {
  status: "ok" | "signed-out" | "unauthorized" | "error";
  /** Set when status is "error" (network/server failure before any per-agent work). */
  error?: string;
  outcomes: AgentSyncOutcome[];
  /** Epoch ms when the pass finished. */
  finishedAt: number;
}

// Shared shapes for cloud agent sync (desktop profiles ↔ hermes-one-backend
// /api/agents), used across the main process, preload bridge, and renderer.

/** Per-agent outcome of one sync pass. */
export interface AgentSyncOutcome {
  /** Local profile name ("default" included), or the sanitized name for a pull-created profile. */
  profile: string;
  /** Cloud agent id the profile is (now) linked to, when linked. */
  agentId?: string;
  action:
    | "up-to-date"
    | "pushed"
    | "pulled"
    | "created-remote"
    | "created-local"
    | "unlinked"
    // Left untouched: the link belongs to a different Hermes account (or a
    // legacy link whose agent this account can't see).
    | "skipped"
    | "error";
  /** Human-readable notes: skipped oversize parts, name mismatches, errors. */
  warnings: string[];
}

/** What the renderer polls to render the sync affordance. */
export interface AgentSyncStatus {
  signedIn: boolean;
  /** Email/name of the signed-in user, for display. */
  accountLabel: string | null;
  running: boolean;
  lastResult: AgentSyncResult | null;
}

// ── shared/gpu.ts ──

/** User-facing hardware-acceleration preference. "auto" = crash-guard driven
 *  (default), "on"/"off" = explicit user choice from Settings → Appearance. */
export type GpuPreferenceMode = "auto" | "on" | "off";

/** Why hardware acceleration is currently off, surfaced to the renderer so the
 *  Office tab can explain SwiftShader slowness instead of failing silently. */
export interface GpuStatus {
  disabled: boolean;
  /** "env" = HERMES_DISABLE_GPU=1, "preference" = user chose "off" in
   *  Settings, "sentinel" = relaunched after a crash this session, "flag" =
   *  persisted crash flag from an earlier launch. */
  reason: "env" | "preference" | "sentinel" | "flag" | null;
  /** ISO timestamp from the flag file when reason is "flag". */
  flagWrittenAt: string | null;
  /** False when the env var or the user's own Settings choice forces GPU off —
   *  the Office banner's one-click re-enable only applies to crash fallbacks. */
  canReenable: boolean;
  /** The persisted Settings preference, independent of what disabled the GPU
   *  this session (a changed preference applies on next launch). */
  preference: GpuPreferenceMode;
  /** The preference this process actually launched with. When it differs from
   *  `preference`, a restart is pending — the Settings pane shows the prompt
   *  even after being closed and reopened. */
  bootPreference: GpuPreferenceMode;
}

// ── shared/ssh-docker.ts ──

export interface SshHermesTargetInspection {
  /** A host-level CLI install plus a real ~/.hermes were found. */
  hostInstallFound: boolean;
  /** State of ~/.hermes on the host: missing | directory | symlink. */
  hermesHomeState: "missing" | "directory" | "symlink";
  /**
   * True when hermesHomeState is "directory" and the directory is empty —
   * setup can replace it with the data-volume symlink, so it is not a
   * conflict.
   */
  hermesHomeEmpty: boolean;
  /** Symlink target when hermesHomeState is "symlink". */
  hermesHomeTarget: string | null;
  /** Desktop-managed docker hook, some other executable, or none. */
  launcherState: "missing" | "docker" | "custom";
  /** Container the managed hook routes to (launcherState "docker"). */
  launcherContainerName: string | null;
  dockerAvailable: boolean;
  dockerContainers: SshHermesDockerContainer[];
  selectedDockerContainerName: string;
  error?: string;
}

// Docker-backed SSH target types (issue #432), shared by the main-process
// inspection/provisioning in src/main/ssh-docker.ts, the preload bridge, and
// the renderer target-selection UI.

export interface SshHermesDockerContainer {
  id: string;
  name: string;
  image: string;
  ports: string;
  /** Host path mounted at /opt/data, "" when the container has no data mount. */
  dataHome: string;
  /** True when the container publishes the configured remote API port. */
  matchesRemotePort: boolean;
}

export interface SshDockerProvisionResult {
  ok: boolean;
  containerName: string;
  /** Host path of the container's /opt/data mount. */
  dataHome: string;
  /** `docker exec` user flag baked into the hook ("" = container default). */
  execUser: string;
  /** Hermes CLI path inside the container. */
  cliPath: string;
  /** `hermes --version` output through the provisioned launcher. */
  version: string;
  warnings: string[];
  error?: string;
}
