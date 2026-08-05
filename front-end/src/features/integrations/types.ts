export type IntegrationProvider = "google" | "notion";

export interface IntegrationConnection {
  provider: IntegrationProvider;
  accountLabel: string;
  connectedAt: string | null;
  expiresAt: string | null;
}

/** The stored OAuth app, with its secrets masked by the backend. */
export interface IntegrationCredential {
  provider: IntegrationProvider;
  clientId: string;
  clientSecretMasked: string;
  pickerApiKeyMasked: string;
  updatedAt: string | null;
}

/** Codes the backend returns when an OAuth app is checked with the provider. */
export type CredentialVerificationCode =
  | "valid"
  | "empty_client_id"
  | "empty_client_secret"
  | "empty_picker_key"
  | "invalid_format"
  | "invalid_client"
  | "invalid_key"
  | "key_restricted"
  | "redirect_uri_mismatch"
  | "unauthorized_client"
  | "rejected"
  | "network_error"
  | "service_unavailable"
  | "unknown_provider";

/** One named assertion — rendered as a line in the verification result list. */
export interface CredentialCheck {
  name: "client" | "picker_key";
  ok: boolean;
  code: CredentialVerificationCode;
  /** English fallback from the backend, shown when no localized string exists. */
  message: string;
  /** False when the verdict is "we could not check", not "the provider said no". */
  reachedProvider: boolean;
}

export interface CredentialVerification {
  ok: boolean;
  code: CredentialVerificationCode;
  message: string;
  reachedProvider: boolean;
  checks: CredentialCheck[];
}

export interface IntegrationStatus {
  provider: IntegrationProvider;
  /** An OAuth app is available — stored here or injected through the env. */
  configured: boolean;
  /** Google also needs a Picker API key before Drive can be browsed. */
  needsPickerApiKey: boolean;
  /** Null when nothing is stored, including when the env supplies the app. */
  credential: IntegrationCredential | null;
  /** Must be registered verbatim with the provider. */
  redirectUri: string;
  connection: IntegrationConnection | null;
}

export interface SaveCredentialsInput {
  provider: IntegrationProvider;
  clientId: string;
  /** Blank keeps the stored secret — the UI never round-trips a masked value. */
  clientSecret: string;
  pickerApiKey?: string;
}

export interface SaveCredentialsResult {
  credential: IntegrationCredential;
  verification: CredentialVerification;
  /** True when the client ID changed and the signed-in account was dropped. */
  connectionCleared: boolean;
}

export interface NotionPage {
  id: string;
  title: string;
  url: string;
  lastEditedTime: string | null;
}

/** Error thrown by the integrations API layer, carrying the backend's code. */
export class IntegrationError extends Error {
  readonly code: string;
  readonly verification?: CredentialVerification;

  constructor(
    message: string,
    code: string,
    verification?: CredentialVerification,
  ) {
    super(message);
    this.name = "IntegrationError";
    this.code = code;
    this.verification = verification;
  }
}
