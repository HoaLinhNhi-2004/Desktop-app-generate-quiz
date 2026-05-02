# Improvement Backlog — Quiz Generator

> Tổng hợp từ audit toàn bộ codebase (front-end + back-end + UX). Phân nhóm theo độ ưu tiên P0 → P3, mỗi task độc lập có thể tạo PR riêng.
>
> Cập nhật lần cuối: 2026-05-02

## Tổng quan

- **38 task** tổng cộng: 5 P0 + 14 P1 + 10 P2 + 9 P3.
- Đề xuất chia làm 4 milestone (xem cuối file).
- Mỗi task có file đích cụ thể để dễ assign + track.

---

## P0 — Critical (làm trước khi public/production)

| # | Task | File / Vị trí | Effort |
|---|---|---|---|
| 1 | Bắt buộc `SECRET_KEY` từ env, raise lỗi khi `FLASK_ENV=production` mà thiếu. Bỏ default `"dev-secret-key"`. | [back-end/config.py:9](../back-end/config.py#L9) | S |
| 2 | Encrypt Gemini API key at rest (AES-GCM, derive key từ `USER_DATA_PATH` + machine ID). Không lưu plaintext. | [back-end/app/features/api_keys/models.py:41](../back-end/app/features/api_keys/models.py#L41), [key_manager.py](../back-end/app/features/api_keys/key_manager.py) | M |
| 3 | Sanitize error response: catch `Exception` không trả `str(e)` thẳng — log chi tiết server-side, trả message generic + error code. | [folder/routes.py:20,36,52,64](../back-end/app/features/folder/routes.py), `quiz/routes.py`, `upload/routes.py` | S-M |
| 4 | Thêm migration version table + check schema khi `_add_missing_columns()` chạy. Cover được cột FK / index / NOT NULL với default. | [back-end/app/__init__.py:8-77](../back-end/app/__init__.py#L8-L77) | M |
| 5 | Set Content-Security-Policy cho BrowserWindow Electron, xoá `console.log` lộ URL. | [front-end/src/electron/main.ts](../front-end/src/electron/main.ts), [src/electron/util.ts:28](../front-end/src/electron/util.ts#L28) | S |

---

## P1 — High (sprint kế tiếp)

### Bảo mật & chất lượng

| # | Task | File / Vị trí | Effort |
|---|---|---|---|
| 6 | File upload kiểm tra magic bytes (python-magic), không chỉ extension. | [upload/routes.py:23](../back-end/app/features/upload/routes.py#L23), [quiz/routes.py:37](../back-end/app/features/quizz/routes.py#L37) | S |
| 7 | Test suite tối thiểu cho 3 service rủi ro cao: `quiz_generator` (chunk dedup + merge), `key_manager` (rotation/cooldown), `smart_import_service` (pause/resume state machine). | `back-end/tests/` (mới) | M |
| 8 | ESLint stricter: bật `@typescript-eslint/recommended-type-checked`, `no-console`, `no-unused-vars`, `no-explicit-any`. | [front-end/eslint.config.js](../front-end/eslint.config.js) | S |
| 9 | Husky pre-commit thêm `ruff check back-end/` khi có file `back-end/**.py` staged. | [.husky/pre-commit](../.husky/pre-commit) | S |

### DB & hiệu năng

| # | Task | File / Vị trí | Effort |
|---|---|---|---|
| 10 | Thêm index: `UploadedFileRecord.processing_status`, `QuizSet.created_at`, `QuizAttempt(folder_id, completed_at)`. Cập nhật `_add_missing_columns()` để CREATE INDEX IF NOT EXISTS. | [back-end/app/features/*/models.py](../back-end/app/features), [app/__init__.py](../back-end/app/__init__.py) | S |
| 11 | Sửa race condition: smart_import tìm `UploadedFileRecord` by ID thay vì `original_name`. | [smart_import_service.py:788](../back-end/app/features/folder/smart_import_service.py#L788) | S |
| 12 | Cache `Folder.query.all()` trong job state, gọi 1 lần/job thay vì 2 lần/batch. | [smart_import_service.py:643,685](../back-end/app/features/folder/smart_import_service.py) | S |
| 13 | Persist tối thiểu job state vào DB (status + last checkpoint) để FE polling không 404 khi backend restart. | [smart_import_service.py](../back-end/app/features/folder/smart_import_service.py) | M |
| 14 | Sửa `try/except: pass` ở token tracking — log warning, không nuốt im lặng (ảnh hưởng dashboard quota). | [quiz_generator.py:161-163](../back-end/app/features/quizz/quiz_generator.py#L161-L163) | S |

### UX nhanh

| # | Task | File / Vị trí | Effort |
|---|---|---|---|
| 15 | **Onboarding banner** ở HomePage detect chưa có Gemini key → CTA dẫn đến Settings. Reuse query `useApiKeys()` từ `@/features/api-keys`. | [front-end/src/ui/pages/HomePage.tsx](../front-end/src/ui/pages/HomePage.tsx) | S |
| 16 | **Auto-save edit quiz** debounce 3-5s + dirty indicator + `useBlocker` cảnh báo discard khi rời trang. | [front-end/src/ui/pages/EditQuizPage.tsx](../front-end/src/ui/pages/EditQuizPage.tsx) | S-M |
| 17 | **Drag & drop zone** với visual feedback (highlight border khi dragover). | [front-end/src/ui/components/FileUpload.tsx](../front-end/src/ui/components/FileUpload.tsx) | S |
| 18 | i18n: chuyển 10+ chuỗi tiếng Anh hardcode về `vi.json/en.json` (`Edit`, `Back`, `Failed to update quiz`, `Quiz Details`, `Title`, `Failed to fetch spreadsheet`…). | [EditQuizPage.tsx:51,61,65,128,144,148,389](../front-end/src/ui/pages/EditQuizPage.tsx), `SpreadsheetSourceViewer:197`, `locales/{vi,en}.json` | S |
| 19 | Cho phép ESC trong `GeneratingModal` khi job ở trạng thái có thể cancel. Đang `e.preventDefault()` cứng. | [FolderDetailPage.tsx:665-709](../front-end/src/ui/pages/FolderDetailPage.tsx#L665-L709) | S |

---

## P2 — Medium (giá trị cao, effort vừa)

### UX & a11y

| # | Task | File / Vị trí | Effort |
|---|---|---|---|
| 20 | Form input thêm `htmlFor`/`id` link với `<Label>`. Thêm `aria-describedby` cho input có error/hint. | InputSourceTabs, MaterialSelectPanel, QuizConfig, FileUpload | S-M |
| 21 | Type guard / zod parse cho `routeState` thay vì `as` cast. | [QuizPage.tsx:61-74](../front-end/src/ui/pages/QuizPage.tsx#L61-L74) | S |
| 22 | Lazy-load route nặng bằng `React.lazy` cho QuizPage + FolderDetailPage + EditQuizPage. Manual chunk split Recharts/react-pdf/docx trong `vite.config.ts`. | [front-end/src/ui/App.tsx](../front-end/src/ui/App.tsx), [vite.config.ts](../front-end/vite.config.ts) | M |
| 23 | Virtualize danh sách câu hỏi (>50) trong PdfQuizViewer + danh sách upload (>20) trong InputSourceTabs bằng `@tanstack/react-virtual`. | [components/PdfQuizViewer.tsx](../front-end/src/ui/components/PdfQuizViewer.tsx), [components/InputSourceTabs.tsx](../front-end/src/ui/components/InputSourceTabs.tsx) | M |
| 24 | Tách Context cục bộ trong FolderDetailPage cho `selectedIds` + `config` để giảm prop drilling 3-4 level. Reuse `QuizConfig` từ `@/features/quizz`. | [pages/FolderDetailPage.tsx](../front-end/src/ui/pages/FolderDetailPage.tsx) | M |
| 25 | Test responsive ở 375px viewport. Stack columns ở `<sm` cho material+config; sửa dropdown `align="end"` không bị tràn. | [QuizPage.tsx:433-473](../front-end/src/ui/pages/QuizPage.tsx#L433-L473), [Header.tsx:40](../front-end/src/ui/components/Header.tsx#L40), [FolderDetailPage.tsx:907](../front-end/src/ui/pages/FolderDetailPage.tsx#L907) | S-M |

### Tính năng cho user

| # | Task | Mô tả | Effort |
|---|---|---|---|
| 26 | **Review mode** sau attempt — highlight câu sai, hiển thị giải thích. Data đã có trong `QuizAttempt.questionResults`. | M |
| 27 | **Import quiz từ file JSON/Excel** — hoàn tất proposal `docs/smart_quiz_import_feature.md`, thêm route `action="import"` ở `quizz/routes.py` + UI tab trong FolderDetailPage. Reuse `QuizQuestion` từ `@/features/quizz` (KHÔNG redeclare union). | M |
| 28 | **Soft delete + Trash 7 ngày** — thêm cột `deleted_at` vào Folder/QuizSet/UploadedFileRecord, filter query mặc định, route `/restore`, UI Trash. | M |
| 29 | **Backup/restore JSON** toàn DB — endpoint dump SQLite + zip uploads, restore từ file. Quan trọng cho desktop offline-first. | S-M |

---

## P3 — Low / nice-to-have

| # | Task | Effort |
|---|---|---|
| 30 | **Share quiz link + QR** — cần cloud relay nhỏ (Electron chỉ local). Backend endpoint `/api/quiz/sets/<id>/share-token`, FE dùng `qrcode.react`. | M-L |
| 31 | **Spaced repetition / Flashcard mode** — implement SM-2 algorithm, thêm bảng `ReviewSchedule`. | L |
| 32 | **Print-friendly view** — CSS `@media print` riêng cho QuizPage. | S |
| 33 | **Tag + search** câu hỏi trong quiz set ở EditQuizPage. | M |
| 34 | CONTRIBUTING.md với coding standards + PR process. | S |
| 35 | Comment language: chọn 1 ngôn ngữ thống nhất (đề xuất English) cho code comments. | S |
| 36 | Trailing slash consistency giữa các blueprint (ghi chú trong CLAUDE.md đã có nhưng có thể chuẩn hoá). | S |
| 37 | ChromaDB `_init_client()` thêm global lock tránh tạo 2 client instance khi concurrent. | S |
| 38 | `Folder.to_dict()` eager-load count để tránh N+1 khi list folders. | S |

---

## Roadmap milestone

| Milestone | Phạm vi | Thời lượng dự kiến | Output |
|---|---|---|---|
| **M1 — Hardening** | P0 (#1-5) | 1 tuần | App sẵn sàng public, không leak secret/key |
| **M2 — Quality** | P1 (#6-19) | 1-2 tuần | Có test, lint nghiêm, UX polish vòng 1 |
| **M3 — Features** | P2 (#20-29) | 2-3 tuần | Review mode + import quiz + soft delete + backup → user cảm thấy "đầy đủ" |
| **M4 — Growth** | P3 (#30-38) | tuỳ priority | Share + flashcard kéo retention dài hạn |

---

## Quy ước khi triển khai

- **Type discipline (front-end)**: trước khi tạo union/interface domain, BẮT BUỘC grep `front-end/src/features/*/types.ts`. Không re-declare `QuestionType`, `Difficulty`, `InputMode`, `QuizConfig`, `QuizQuestion`, `QuizSetSummary`, `Folder`, `UploadRecord`, `GeminiApiKey`, `ImportJob`, `FolderDetailStats`. Import qua barrel `@/features/<name>`.
- **JSON từ backend là camelCase** (đã convert trong `to_dict()`): `folderId`, `createdAt`, `processingStatus`, `sourceUploadIds`, `pageDistribution`, `correctAnswerId`, `questionText`, `sourcePages`, `sourceKeyword`, `isFavorite`, `lastAccessedAt`. Không phỏng đoán tên field.
- **Hooks** luôn typed tường minh qua generic `useQuery<T, Error>` / `useMutation<T, Error, V>`.
- **Migration**: mỗi khi thêm/sửa cột model SQLAlchemy → bắt buộc cập nhật `_add_missing_columns()` ở [back-end/app/__init__.py](../back-end/app/__init__.py).
- **Conventional Commits + ESLint pre-commit** đã enforce qua Husky — không `--no-verify`.
- **API URL** luôn qua `APP_CONFIG.API_URL` từ [@/config/app](../front-end/src/config/app.ts), không hardcode `http://localhost:5000`.
