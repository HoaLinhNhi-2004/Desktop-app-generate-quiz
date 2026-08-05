# Google Drive & Notion Setup Guide

> This project is open source, so it cannot ship OAuth credentials — anything committed
> here would be public, and a leaked client secret can be used to impersonate the app.
> Each user registers their own OAuth app and enters it in **Settings > External document
> sources**. Secrets are encrypted with AES-256-GCM before they touch the database
> (same helper as the Gemini keys, see [`api_keys/crypto.py`](../back-end/app/features/api_keys/crypto.py))
> and never leave the machine.
>
> The `GOOGLE_OAUTH_*` / `NOTION_OAUTH_*` environment variables still exist as an override
> for self-hosted and CI setups. A stored credential always wins over them.

---

## 0. The redirect URI

Both providers need one value from this app, shown with a copy button in the setup dialog:

```
http://127.0.0.1:5000/api/integrations/google/callback
http://127.0.0.1:5000/api/integrations/notion/callback
```

It must be registered **verbatim** — a trailing slash or `localhost` instead of `127.0.0.1`
is a different URI to the provider. If the backend does not listen on `127.0.0.1:5000`, set
`OAUTH_REDIRECT_BASE` in `back-end/.env` and re-read the value from the dialog.

Sign-in always opens in the **system browser**, never inside the app: Google rejects
embedded webviews with `disallowed_useragent`, and the Electron renderer's CSP blocks
provider scripts. The main process only opens URLs whose host is on an allowlist
(the local backend plus the two provider consoles) — see
[`main.ts`](../front-end/src/electron/main.ts).

---

## 1. Google Drive

Console: <https://console.cloud.google.com/apis/credentials>

1. Pick or create a project.
2. **APIs & Services → Library → Google Picker API → Enable.**
3. **Credentials → Create credentials → OAuth client ID**, application type
   **Web application**. Add the redirect URI above under *Authorized redirect URIs*,
   then copy the **Client ID** and **Client secret**.
4. **Credentials → Create credentials → API key.** This is the *Picker API key* — the
   Picker is a JavaScript API and authenticates with a browser key, not with OAuth.
5. On the **OAuth consent screen**, add your own Google account under *Test users* while
   the app is in Testing mode, otherwise consent is refused.

### Why `drive.file` and not `drive.readonly`

The app requests only `https://www.googleapis.com/auth/drive.file`, which grants access to
the files the user picked through the Google Picker and nothing else. It is a
**non-sensitive** scope, so the OAuth app needs no Google verification.

`drive.readonly` would allow an in-app folder tree, but it is a **restricted** scope: using
it in a published app requires a third-party security assessment, billed annually. Do not
widen the scope in [`oauth.py`](../back-end/app/features/integrations/oauth.py) without
accepting that cost.

### What happens to a picked file

Google-native documents have no byte stream and are exported on the way in:

| Drive type          | Stored as | Why                                    |
| ------------------- | --------- | -------------------------------------- |
| Docs, Slides, Drawings | PDF    | keeps the PDF viewer and heatmap usable |
| Sheets              | `.xlsx`   | the spreadsheet extractor reads it      |
| Uploaded files      | as-is     | already a real file                     |

Files land in `UPLOAD_FOLDER` with a real extension and reuse the whole `files` pipeline —
see [`google_drive_service.py`](../back-end/app/features/integrations/google_drive_service.py).

---

## 2. Notion

Console: <https://www.notion.so/my-integrations>

1. **New integration.**
2. On the **Configuration** tab choose type **Public** and fill in the required fields
   (name, icon, company URLs). A private integration issues a token instead of an OAuth
   client and will not work here.
3. Paste the redirect URI above under *Redirect URIs*, then copy the **OAuth client ID**
   and **OAuth client secret**.
4. Save in the app, then click **Connect**. Notion's own consent screen is the page
   picker — the app can only ever read pages selected there.

Notion access tokens do not expire, so there is no refresh token to manage.

---

## 3. Testing before saving

**Test** in the setup dialog checks the credentials without storing anything. It asks the
provider's token endpoint to redeem a deliberately bogus authorization code: the client is
authenticated *before* the code is examined, so the two failures are distinct.

| Result                 | Meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `invalid_client`       | The client ID / secret pair is wrong                            |
| `redirect_uri_mismatch`| The redirect URI is not registered on the OAuth app             |
| `unauthorized_client`  | The app may not use the authorization code flow                 |
| `invalid_key`          | Google rejected the Picker API key                              |
| `key_restricted`       | The key exists but is API-restricted — could not confirm Picker |
| `network_error`        | Could not reach the provider; the credential is stored anyway   |

A rejection **from the provider** blocks the save. Our own inability to reach the provider
never does — it stores the credential and says so, so a dropped connection cannot lock
anyone out of configuring the app. Same rule as
[`api_keys/verifier.py`](../back-end/app/features/api_keys/verifier.py).

Saving a **different client ID** deletes the stored connection: its tokens were issued by
the previous OAuth app and can never be refreshed.

---

## 4. API surface

| Method | Endpoint                                          | Description                          |
| ------ | ------------------------------------------------- | ------------------------------------ |
| GET    | `/api/integrations/`                              | Status, masked credentials, redirect URIs |
| POST   | `/api/integrations/<provider>/credentials/verify` | Test an OAuth app, store nothing     |
| PUT    | `/api/integrations/<provider>/credentials`        | Verify then store                    |
| DELETE | `/api/integrations/<provider>/credentials`        | Forget the OAuth app and its connection |
| GET    | `/api/integrations/<provider>/authorize`          | Redirect to the consent screen       |
| GET    | `/api/integrations/<provider>/callback`           | OAuth redirect target (HTML page)    |
| DELETE | `/api/integrations/<provider>`                    | Sign the account out, keep the app   |
| GET    | `/api/integrations/notion/pages?q=`               | Pages shared with the integration    |
| GET    | `/api/integrations/google/picker?folderId=`       | Picker page (system browser)         |
| POST   | `/api/integrations/google/picker-result`          | Download picked files into a folder  |

Tables: `integration_credentials` (the OAuth app) and `integration_connections` (the signed-in
account), created by migrations 009 and 008 in [`migrations.py`](../back-end/app/migrations.py).

---

## 5. Troubleshooting

**"Chưa cấu hình" even after saving** — Google also needs the Picker API key; without it
Drive stays hidden because it could not be browsed anyway.

**Consent screen says the app is unverified** — expected while the OAuth app is in Testing
mode. Add your account under *Test users*; `drive.file` never needs verification.

**Callback opens but the app still says "not connected"** — the status refreshes when the
app window regains focus. Click back into the app.

**`Không kết nối được backend`** — the backend is not running, or an older instance is
holding port 5000. Kill the stale listener first; the new process never binds and the
callback reaches the wrong one.
