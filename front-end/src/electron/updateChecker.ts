import { app, net } from "electron";

// Must stay in sync with the `publish` block in electron-builder.json — that is
// the repo the release workflow uploads the installers to.
const REPO_OWNER = "HoangLong08";
const REPO_NAME = "Desktop-app-generate-quiz";

const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const RELEASES_PAGE_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;

const CACHE_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RELEASE_NOTES_CHARS = 4000;

type ParsedVersion = { release: number[]; prerelease: string[] };

/** Parse a semver-ish tag (`v1.6.0`, `1.6`, `2.0.0-rc.1+build`) into comparable parts. */
export function parseVersion(raw: string): ParsedVersion | null {
  const withoutBuild = raw.trim().replace(/^v/i, "").split("+")[0];
  const dash = withoutBuild.indexOf("-");
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? "" : withoutBuild.slice(dash + 1);

  const parts = core.split(".");
  if (parts.length === 0 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d+$/.test(p))) return null;

  const release = parts.map(Number);
  while (release.length < 3) release.push(0);

  return { release, prerelease: pre === "" ? [] : pre.split(".") };
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  // semver: numeric identifiers always rank lower than alphanumeric ones.
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i++) {
    if (a.release[i] !== b.release[i]) {
      return a.release[i] < b.release[i] ? -1 : 1;
    }
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  // A release outranks any prerelease of the same core version.
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const cmp = compareIdentifiers(left, right);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/** null when either side is not a version we can reason about. */
export function isNewerVersion(
  latest: string,
  current: string,
): boolean | null {
  const parsedLatest = parseVersion(latest);
  const parsedCurrent = parseVersion(current);
  if (!parsedLatest || !parsedCurrent) return null;
  return compareVersions(parsedLatest, parsedCurrent) > 0;
}

type GithubRelease = {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
};

type FetchOutcome =
  | { ok: true; release: GithubRelease }
  | { ok: false; code: UpdateCheckErrorCode; message: string };

function causeOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Runs in the main process on purpose: the renderer's CSP only allows
 * connect-src to the bundled backend, so api.github.com is unreachable there.
 */
async function fetchLatestRelease(): Promise<FetchOutcome> {
  let response: Response;
  try {
    response = await net.fetch(LATEST_RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": `${REPO_NAME}/${app.getVersion()}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, code: "offline", message: causeOf(err) };
  }

  if (response.status === 404) {
    return {
      ok: false,
      code: "no-release",
      message: `No published release on ${REPO_OWNER}/${REPO_NAME}`,
    };
  }
  // Unauthenticated GitHub API allows 60 requests/hour per IP; both codes mean
  // "come back later", never "there is no update".
  if (response.status === 403 || response.status === 429) {
    return {
      ok: false,
      code: "rate-limited",
      message: `GitHub API rate limited (HTTP ${response.status})`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      code: "unexpected",
      message: `GitHub API responded with HTTP ${response.status}`,
    };
  }

  try {
    return { ok: true, release: (await response.json()) as GithubRelease };
  } catch (err) {
    return { ok: false, code: "unexpected", message: causeOf(err) };
  }
}

let cached: UpdateCheckResult | null = null;
let cachedAtMs = 0;
let inFlight: Promise<UpdateCheckResult> | null = null;

function errorResult(
  code: UpdateCheckErrorCode,
  message: string,
): UpdateCheckResult {
  return {
    status: "error",
    currentVersion: app.getVersion(),
    latestVersion: null,
    releaseUrl: null,
    releaseName: null,
    releaseNotes: null,
    publishedAt: null,
    error: { code, message },
    checkedAt: new Date().toISOString(),
  };
}

async function runCheck(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  const outcome = await fetchLatestRelease();
  if (!outcome.ok) return errorResult(outcome.code, outcome.message);

  const tag = asString(outcome.release.tag_name);
  if (!tag) {
    return errorResult("unexpected", "Release payload has no tag_name");
  }

  const newer = isNewerVersion(tag, currentVersion);
  if (newer === null) {
    return errorResult(
      "unexpected",
      `Cannot compare release tag "${tag}" with app version "${currentVersion}"`,
    );
  }

  const notes = asString(outcome.release.body);
  return {
    status: newer ? "update-available" : "up-to-date",
    currentVersion,
    latestVersion: tag.replace(/^v/i, ""),
    releaseUrl: asString(outcome.release.html_url) ?? RELEASES_PAGE_URL,
    releaseName: asString(outcome.release.name),
    releaseNotes: notes ? notes.slice(0, MAX_RELEASE_NOTES_CHARS) : null,
    publishedAt: asString(outcome.release.published_at),
    error: null,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Latest published release vs. the running build.
 *
 * Successful results are cached so mounting the renderer repeatedly (or several
 * windows) cannot burn through GitHub's unauthenticated hourly budget; failures
 * are not cached so a retry after the network comes back works immediately.
 */
export function checkForUpdate(force: boolean): Promise<UpdateCheckResult> {
  if (
    !force &&
    cached &&
    cached.status !== "error" &&
    Date.now() - cachedAtMs < CACHE_TTL_MS
  ) {
    return Promise.resolve(cached);
  }
  if (inFlight) return inFlight;

  inFlight = runCheck()
    .then((result) => {
      if (result.status !== "error") {
        cached = result;
        cachedAtMs = Date.now();
      }
      return result;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * The renderer may only hand us release links on our own GitHub repo — this is
 * a download prompt, not a general "open whatever URL the page asks for".
 */
export function isAllowedReleaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname.startsWith(`/${REPO_OWNER}/${REPO_NAME}/`)
    );
  } catch {
    return false;
  }
}
