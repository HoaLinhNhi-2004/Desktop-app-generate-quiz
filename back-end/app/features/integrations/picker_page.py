"""
The Google Picker page, served by the backend and opened in the system browser.

It cannot live in the Electron renderer: the Picker loads apis.google.com,
which the app's Content-Security-Policy blocks by design, and Google refuses
OAuth inside embedded webviews anyway. Serving it from Flask keeps the access
token on the same origin that issued it.
"""
import json


def render_picker_page(
    access_token: str,
    api_key: str,
    app_id: str,
    folder_id: str,
    result_url: str,
) -> str:
    config = json.dumps(
        {
            "token": access_token,
            "apiKey": api_key,
            "appId": app_id,
            "folderId": folder_id,
            "resultUrl": result_url,
        }
    )

    return """<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chọn tệp từ Google Drive</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0a0a0a; color:#e5e5e5;
         font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
  .card { max-width:30rem; padding:2rem; text-align:center; }
  h1 { font-size:1.15rem; margin:0 0 .5rem; }
  p { font-size:.9rem; line-height:1.5; color:#a3a3a3; margin:.25rem 0; }
  .err { color:#f87171; }
  .ok { color:#4ade80; }
  ul { text-align:left; font-size:.85rem; color:#a3a3a3; }
</style></head>
<body>
  <div class="card">
    <h1 id="heading">Đang mở Google Drive...</h1>
    <p id="detail">Nếu cửa sổ chọn tệp không hiện ra, hãy kiểm tra trình chặn popup.</p>
    <div id="errors"></div>
  </div>
<script src="https://apis.google.com/js/api.js"></script>
<script>
(function () {
  var CONFIG = __CONFIG__;
  var heading = document.getElementById("heading");
  var detail = document.getElementById("detail");

  function show(text, sub, cls) {
    heading.textContent = text;
    heading.className = cls || "";
    detail.textContent = sub || "";
  }

  function onPicked(data) {
    if (data.action === google.picker.Action.CANCEL) {
      show("Đã huỷ", "Bạn có thể đóng tab này.");
      return;
    }
    if (data.action !== google.picker.Action.PICKED) return;

    var ids = (data.docs || []).map(function (d) { return d.id; });
    if (!ids.length) { show("Không có tệp nào được chọn", "Bạn có thể đóng tab này."); return; }

    show("Đang tải " + ids.length + " tệp về ứng dụng...", "Vui lòng không đóng tab.");

    fetch(CONFIG.resultUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId: CONFIG.folderId, fileIds: ids })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body.error || "Lỗi không xác định");
        var added = (res.body.records || []).length;
        var errors = res.body.errors || [];
        show(
          "Đã thêm " + added + " tài liệu",
          errors.length ? "" : "Quay lại ứng dụng để xem tiến trình xử lý. Bạn có thể đóng tab này.",
          "ok"
        );
        if (errors.length) {
          var list = document.createElement("ul");
          errors.forEach(function (e) {
            var li = document.createElement("li");
            li.textContent = e.message;
            list.appendChild(li);
          });
          document.getElementById("errors").appendChild(list);
        }
      })
      .catch(function (e) { show("Không thêm được tài liệu", String(e.message || e), "err"); });
  }

  function openPicker() {
    var view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false);
    var builder = new google.picker.PickerBuilder()
      .setOAuthToken(CONFIG.token)
      .setDeveloperKey(CONFIG.apiKey)
      .addView(view)
      .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
      .setCallback(onPicked);
    if (CONFIG.appId) builder = builder.setAppId(CONFIG.appId);
    builder.build().setVisible(true);
  }

  if (typeof gapi === "undefined") {
    show("Không tải được Google Picker", "Kiểm tra kết nối mạng rồi thử lại.", "err");
    return;
  }
  gapi.load("picker", { callback: openPicker });
})();
</script>
</body></html>""".replace("__CONFIG__", config)
