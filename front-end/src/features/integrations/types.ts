export type IntegrationProvider = "google" | "notion";

export interface IntegrationConnection {
  provider: IntegrationProvider;
  accountLabel: string;
  connectedAt: string | null;
  expiresAt: string | null;
}

export interface NotionPage {
  id: string;
  title: string;
  url: string;
  lastEditedTime: string | null;
}

export interface IntegrationStatus {
  provider: IntegrationProvider;
  /** False when the build shipped no OAuth client for this provider. */
  configured: boolean;
  connection: IntegrationConnection | null;
}
