"""
Integrations feature - API routes for connecting third-party document sources.

Endpoints:
  GET    /api/integrations/                            - Status, credentials, setup info
  POST   /api/integrations/<provider>/credentials/verify - Check an OAuth app, save nothing
  PUT    /api/integrations/<provider>/credentials      - Verify then store an OAuth app
  DELETE /api/integrations/<provider>/credentials      - Forget the OAuth app
  GET    /api/integrations/<provider>/authorize        - Redirect to the consent screen
  GET    /api/integrations/<provider>/callback         - OAuth redirect target
  DELETE /api/integrations/<provider>                  - Disconnect the signed-in account

The authorize/callback pair is opened in the user's system browser, not in the
app window, so the callback answers with a small HTML page instead of JSON.
"""
import html
import logging
import os
import uuid
from datetime import datetime, timezone

from flask import Blueprint, current_app, jsonify, redirect, request

from app.db import db
from app.features.integrations import oauth
from app.features.integrations.models import IntegrationConnection, IntegrationCredential
from app.features.integrations.verifier import verify_credentials
from app.features.upload.models import UploadedFileRecord

logger = logging.getLogger(__name__)

integrations_bp = Blueprint("integrations", __name__)


def _result_page(heading: str, detail: str, ok: bool) -> tuple[str, int]:
    accent = "#16a34a" if ok else "#dc2626"
    page = f"""<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quiz Generator</title>
<style>
  body {{ margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0a0a0a; color:#e5e5e5;
         font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }}
  .card {{ max-width:26rem; padding:2rem; text-align:center; }}
  h1 {{ font-size:1.15rem; margin:0 0 .5rem; color:{accent}; }}
  p {{ font-size:.9rem; line-height:1.5; color:#a3a3a3; margin:0; }}
</style></head>
<body><div class="card">
  <h1>{html.escape(heading)}</h1>
  <p>{html.escape(detail)}</p>
</div>
<script>setTimeout(function () {{ window.close(); }}, 2500);</script>
</body></html>"""
    return page, (200 if ok else 400)


def _json_body() -> dict:
    """Request body as a dict, tolerating a missing/incorrect Content-Type."""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _clean_str(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


@integrations_bp.route("/", methods=["GET"])
def list_integrations():
    """Per-provider setup state.

    `configured` means an OAuth app is available (stored or from env);
    `credential` is the stored one with its secrets masked, absent when the
    credentials come from the environment instead.
    """
    connections = {c.provider: c for c in IntegrationConnection.query.all()}
    credentials = {c.provider: c for c in IntegrationCredential.query.all()}

    providers = []
    for provider in oauth.PROVIDERS:
        connection = connections.get(provider)
        credential = credentials.get(provider)
        providers.append({
            "provider": provider,
            "configured": oauth.is_configured(provider),
            "needsPickerApiKey": provider == "google",
            "credential": credential.to_dict() if credential else None,
            "redirectUri": oauth.redirect_uri(provider),
            "connection": connection.to_dict() if connection else None,
        })
    return jsonify({"providers": providers}), 200


@integrations_bp.route("/<provider>/credentials/verify", methods=["POST"])
def verify_provider_credentials(provider):
    """Check an OAuth app against the provider without storing anything.

    Backs the "Kiểm tra" button, so the user can find a typo while the form is
    still open instead of discovering it on a consent screen in another tab.
    """
    try:
        oauth.get_provider(provider)
    except oauth.OAuthError as e:
        return jsonify({"error": str(e), "code": "unknown_provider"}), 404

    data = _json_body()
    verdict = verify_credentials(
        provider,
        client_id=_clean_str(data.get("clientId")),
        client_secret=_resolve_secret(provider, data, "clientSecret"),
        redirect_uri=oauth.redirect_uri(provider),
        picker_api_key=_resolve_secret(provider, data, "pickerApiKey"),
    )
    return jsonify({"verification": verdict.to_dict()}), 200


def _resolve_secret(provider: str, data: dict, field: str) -> str:
    """Use the submitted secret, or fall back to the stored one.

    The UI shows secrets masked and leaves the field blank on edit, so an
    untouched field must mean "keep what is stored" rather than "clear it" —
    otherwise re-saving to change only the client ID would wipe the secret.
    """
    submitted = _clean_str(data.get(field))
    if submitted:
        return submitted

    stored = oauth.get_stored_credential(provider)
    if not stored:
        return ""
    return stored.client_secret if field == "clientSecret" else stored.picker_api_key


@integrations_bp.route("/<provider>/credentials", methods=["PUT"])
def save_provider_credentials(provider):
    """Verify then store an OAuth app. A rejected credential is never stored."""
    try:
        oauth.get_provider(provider)
    except oauth.OAuthError as e:
        return jsonify({"error": str(e), "code": "unknown_provider"}), 404

    data = _json_body()
    client_id = _clean_str(data.get("clientId"))
    client_secret = _resolve_secret(provider, data, "clientSecret")
    picker_api_key = _resolve_secret(provider, data, "pickerApiKey")

    verdict = verify_credentials(
        provider,
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=oauth.redirect_uri(provider),
        picker_api_key=picker_api_key,
    )
    if not verdict.ok:
        logger.info("Rejected %s OAuth credentials (%s): %s", provider, verdict.code, verdict.message)
        return jsonify({
            "error": verdict.message,
            "code": verdict.code,
            "verification": verdict.to_dict(),
        }), 400

    credential = oauth.get_stored_credential(provider)
    if credential is None:
        credential = IntegrationCredential(provider=provider)
        db.session.add(credential)

    # A live connection holds tokens issued by the *previous* OAuth app; once
    # the client ID changes they can never be refreshed, so drop it and let the
    # user sign in again rather than leave a connection that silently expires.
    client_changed = credential.client_id and credential.client_id != client_id
    if client_changed:
        IntegrationConnection.query.filter_by(provider=provider).delete()

    credential.client_id = client_id
    credential.client_secret = client_secret
    if provider == "google":
        credential.picker_api_key = picker_api_key
    credential.updated_at = datetime.now(timezone.utc)

    db.session.commit()
    logger.info("Stored %s OAuth credentials (verification: %s)", provider, verdict.code)

    return jsonify({
        "credential": credential.to_dict(),
        "verification": verdict.to_dict(),
        "connectionCleared": bool(client_changed),
    }), 200


@integrations_bp.route("/<provider>/credentials", methods=["DELETE"])
def delete_provider_credentials(provider):
    """Forget the OAuth app, and with it any account signed in through it."""
    credential = IntegrationCredential.query.filter_by(provider=provider).first()
    if not credential:
        return jsonify({"error": "Chưa cấu hình nhà cung cấp này", "code": "not_found"}), 404

    IntegrationConnection.query.filter_by(provider=provider).delete()
    db.session.delete(credential)
    db.session.commit()
    logger.info("Removed %s OAuth credentials", provider)
    return jsonify({"message": "Removed"}), 200


@integrations_bp.route("/<provider>/authorize", methods=["GET"])
def authorize(provider):
    try:
        return redirect(oauth.build_authorize_url(provider))
    except oauth.OAuthError as e:
        return _result_page("Không thể kết nối", str(e), ok=False)


@integrations_bp.route("/<provider>/callback", methods=["GET"])
def callback(provider):
    error = request.args.get("error")
    if error:
        return _result_page("Đã huỷ kết nối", f"Nhà cung cấp trả về: {error}", ok=False)

    code = (request.args.get("code") or "").strip()
    state = (request.args.get("state") or "").strip()
    if not code or not state:
        return _result_page("Không thể kết nối", "Thiếu tham số code hoặc state.", ok=False)

    try:
        connection = oauth.exchange_code(provider, code, state)
    except oauth.OAuthError as e:
        return _result_page("Không thể kết nối", str(e), ok=False)
    except Exception:
        logger.exception("OAuth callback failed for provider=%s", provider)
        db.session.rollback()
        return _result_page(
            "Không thể kết nối",
            "Đã xảy ra lỗi khi hoàn tất kết nối. Xem log backend để biết chi tiết.",
            ok=False,
        )

    return _result_page(
        "Đã kết nối thành công",
        f"Tài khoản {connection.account_label} đã được liên kết. Bạn có thể đóng tab này.",
        ok=True,
    )


@integrations_bp.route("/notion/pages", methods=["GET"])
def notion_pages():
    """Pages the user shared with the integration, for the material picker."""
    from app.features.integrations import notion_service

    try:
        pages = notion_service.search_pages(request.args.get("q", ""))
    except oauth.OAuthError as e:
        return jsonify({"error": str(e)}), 409
    except ValueError as e:
        return jsonify({"error": str(e)}), 502

    return jsonify({"pages": pages}), 200


@integrations_bp.route("/google/picker", methods=["GET"])
def google_picker():
    """Google Picker UI. Opened in the system browser, never in the app window."""
    from app.features.integrations.picker_page import render_picker_page

    folder_id = (request.args.get("folderId") or "").strip()
    if not folder_id:
        return _result_page("Thiếu thư mục", "Không rõ thêm tài liệu vào thư mục nào.", ok=False)

    api_key = oauth.get_picker_api_key()
    if not api_key:
        return _result_page(
            "Chưa cấu hình Google Picker",
            "Thiếu Picker API key. Vào Cài đặt → Nguồn tài liệu bên ngoài để nhập.",
            ok=False,
        )

    try:
        access_token = oauth.get_valid_access_token("google")
    except oauth.OAuthError as e:
        return _result_page("Chưa kết nối Google Drive", str(e), ok=False)

    base = current_app.config.get("OAUTH_REDIRECT_BASE", "http://127.0.0.1:5000")
    return render_picker_page(
        access_token=access_token,
        api_key=api_key,
        app_id=oauth.get_app_id(),
        folder_id=folder_id,
        result_url=f"{base}/api/integrations/google/picker-result",
    )


@integrations_bp.route("/google/picker-result", methods=["POST"])
def google_picker_result():
    """Download the picked files and hand them to the folder's processing queue."""
    from app.features.integrations import google_drive_service
    from app.features.upload.routes import _start_processing

    data = request.get_json(silent=True) or {}
    folder_id = (data.get("folderId") or "").strip()
    file_ids = [str(f) for f in (data.get("fileIds") or []) if f]
    if not folder_id:
        return jsonify({"error": "folderId is required"}), 400
    if not file_ids:
        return jsonify({"error": "fileIds is required"}), 400

    upload_folder = current_app.config.get("UPLOAD_FOLDER", "uploads")
    os.makedirs(upload_folder, exist_ok=True)
    max_bytes = current_app.config.get("MAX_CONTENT_LENGTH", 50 * 1024 * 1024)

    created_records: list[dict] = []
    errors: list[dict] = []

    for file_id in file_ids:
        try:
            info = google_drive_service.download_file(file_id, upload_folder, max_bytes)
        except (google_drive_service.DriveError, oauth.OAuthError) as e:
            errors.append({"fileId": file_id, "message": str(e)})
            continue
        except Exception:
            logger.exception("Unexpected failure downloading Drive file %s", file_id)
            errors.append({"fileId": file_id, "message": "Lỗi không xác định khi tải tệp."})
            continue

        record = UploadedFileRecord(
            id=str(uuid.uuid4()),
            folder_id=folder_id,
            original_name=info["originalName"],
            file_size=info["fileSize"],
            file_type=info["fileType"],
            input_mode="gdrive",
            source_label=info["webViewLink"],
            stored_path=info["storedPath"],
        )
        db.session.add(record)
        created_records.append(record.to_dict())

    db.session.commit()
    logger.info(
        "Imported %d Drive file(s) into folder %s (%d failed)",
        len(created_records), folder_id, len(errors),
    )

    _start_processing(folder_id, [rec["id"] for rec in created_records])
    return jsonify({"records": created_records, "errors": errors}), 201


@integrations_bp.route("/<provider>", methods=["DELETE"])
def disconnect(provider):
    try:
        connection = oauth.get_connection(provider)
    except oauth.OAuthError as e:
        return jsonify({"error": str(e)}), 400

    if not connection:
        return jsonify({"error": "Chưa kết nối nhà cung cấp này"}), 404

    db.session.delete(connection)
    db.session.commit()
    logger.info("Disconnected %s integration", provider)
    return jsonify({"message": "Disconnected"}), 200
