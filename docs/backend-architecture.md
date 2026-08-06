# Back-end Architecture — Web Quiz

The back-end is a **Flask** (Python) application using **SQLAlchemy** with SQLite, organized in a **feature-based** structure (each feature is a module: routes, models, services).

---

## 1. Overview

- **Entry point:** `app.py` → calls `create_app()` from `app/__init__.py`
- **Configuration:** `config.py` (development/production, env from `.env`)
- **Database:** Flask-SQLAlchemy, SQLite at `instance/web_quizz.db` (or based on `USER_DATA_PATH` when running desktop/Electron)
- **API prefix:** `/api/` — blueprints registered per feature

---

## 2. Directory Structure

```
back-end/
├── app.py                 # Entry point, starts Flask
├── config.py              # Config (SECRET_KEY, DB, upload, Gemini, CORS)
├── requirements.txt       # Dependencies
├── ARCHITECTURE.md        # This file
│
├── app/
│   ├── __init__.py        # create_app(), register blueprints, CORS, migrate folders.json
│   ├── db.py              # SQLAlchemy instance (db)
│   ├── data/
│   │   └── folders.json   # Legacy folder data (migrated once into SQLite if DB is empty)
│   │
│   └── features/          # Feature modules
│       ├── __init__.py
│       ├── folder/        # Folders / quiz collections
│       │   ├── models.py
│       │   ├── folder_service.py
│       │   └── routes.py
│       ├── quizz/         # Quiz generation, text extraction, CRUD quiz sets
│       │   ├── models.py
│       │   ├── routes.py
│       │   ├── quiz_generator.py   # LLM (Gemini) question generation
│       │   ├── ocr_service.py      # Gemini Vision OCR for images
│       │   ├── pdf_service.py      # PDF → text (pdfplumber + Gemini OCR fallback)
│       │   ├── docx_service.py     # DOCX → text
│       │   ├── youtube_service.py  # YouTube transcript
│       │   ├── text_processing.py  # Chunk, clean, select important passages
│       │   └── debug/              # Prompt/response debug (per chunk)
│       ├── upload/        # Upload file record management
│       │   ├── models.py
│       │   └── routes.py
│       └── stats/         # Quiz attempt statistics (attempts, heatmap, timeline)
│           ├── models.py
│           └── routes.py
│
├── instance/
│   └── web_quizz.db       # SQLite DB (auto-created)
├── uploads/               # Upload file storage (configured in config.py)
└── packages/              # Virtual env / dependencies (if using local venv)
```

---

## 3. Configuration (`config.py`)

| Key                               | Description                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| **SECRET_KEY**                    | From env, defaults to `dev-secret-key`                                                 |
| **SQLALCHEMY_DATABASE_URI**       | SQLite: `instance/web_quizz.db` (or based on `USER_DATA_PATH`)                         |
| **UPLOAD_FOLDER**                 | Upload file storage directory, max 50MB                                                |
| **ALLOWED_EXTENSIONS**            | pdf, png, jpg, jpeg, bmp, webp, tiff, docx, doc                                        |
| **GEMINI_API_KEY / GEMINI_MODEL** | Google Gemini for question generation (fallback chain: flash → flash-lite → 2.0-flash) |
| **CORS_ORIGINS**                  | CORS for frontend (localhost, Electron file:// when USER_DATA_PATH is set)             |

`get_config()` selects `DevelopmentConfig` or `ProductionConfig` based on `FLASK_ENV`.

---

## 4. Database (`app/db.py` + models)

- **app/db.py:** a single `SQLAlchemy()` instance — `db`.
- **Table creation:** in `create_app()`, after importing all models: `Folder`, `QuizSet`, `Question`, `UploadedFileRecord`, `QuizAttempt` → `db.create_all()`.
- **Data migration:** if the folder table is empty and `app/data/folders.json` exists, data is imported once into SQLite.

**Main models:**

| Model                  | Feature | Description                                                     |
| ---------------------- | ------- | --------------------------------------------------------------- |
| **Folder**             | folder  | Folder/collection (name, description, color)                    |
| **QuizSet**            | quizz   | Quiz set (linked to folder, source text, metadata)              |
| **Question**           | quizz   | Individual question in a QuizSet (content, answer, explanation) |
| **UploadedFileRecord** | upload  | Upload file record (folder_id, stored_path, …)                  |
| **QuizAttempt**        | stats   | Quiz attempt (quiz_set_id, folder_id, score, duration)          |

---

## 5. Features and API

### 5.1 Folder (`/api/folders`)

- **Blueprint:** `app.features.folder.routes.folder_bp`
- **Business logic:** `folder_service.py` (get_all_folders, create_folder, update_folder, delete_folder)

| Method | Endpoint       | Description                              |
| ------ | -------------- | ---------------------------------------- |
| GET    | `/`            | Get all folders                          |
| POST   | `/`            | Create folder (name, description, color) |
| PUT    | `/<folder_id>` | Update folder                            |
| DELETE | `/<folder_id>` | Delete folder                            |

---

### 5.2 Quiz (`/api/quiz`)

- **Blueprint:** `app.features.quizz.routes.quiz_bp`
- **Quiz generation input:** `inputType` = `files` | `youtube` | `text` (multipart/form or form field)

| Method | Endpoint        | Description                                               |
| ------ | --------------- | --------------------------------------------------------- |
| GET    | `/health`       | Health check quiz service                                 |
| GET    | `/sets`         | List quiz sets (query: `folder_id`)                       |
| GET    | `/sets/<id>`    | Get quiz set details + questions                          |
| DELETE | `/sets/<id>`    | Delete quiz set                                           |
| POST   | `/generate`     | Generate quiz from file/YouTube/text (extract → LLM)      |
| POST   | `/extract-text` | Extract text only (preview), without generating questions |

**Main flow:**

1. **Text extraction:**
   - **files:** upload → save to `uploads/` → call `pdf_service`, `docx_service`, or `ocr_service` based on file type.
   - **youtube:** `youtube_service` (transcript).
   - **text:** receive `rawText` from form.

2. **Question generation:**
   - `text_processing`: clean, chunk, select important passages.
   - `quiz_generator`: call Gemini (or fallback), parse questions, validate, save `QuizSet` + `Question`.

**Service files in `quizz/`:**

- **quiz_generator.py:** prompt, call LLM, handle long chunks, cache, parse/validate questions.
- **ocr_service.py:** Gemini Vision API for text recognition from images (single/multiple images).
- **pdf_service.py:** pdfplumber for text-based PDFs; Gemini OCR for scanned PDFs.
- **docx_service.py:** read DOCX content.
- **youtube_service.py:** get transcript, optional summarization.
- **text_processing.py:** clean_text, chunk_text, chunk_importance, select_important_chunks.

---

### 5.3 Upload (`/api/uploads`)

- **Blueprint:** `app.features.upload.routes.upload_bp`
- Only manages file **records** (metadata); actual files are stored in `UPLOAD_FOLDER` (and may be created when calling `/api/quiz/generate` with inputType=files).

| Method | Endpoint       | Description                                       |
| ------ | -------------- | ------------------------------------------------- |
| GET    | `/`            | List upload records (query: `folder_id`)          |
| DELETE | `/<record_id>` | Delete record and remove file from disk if exists |

---

### 5.4 Stats (`/api/stats`)

- **Blueprint:** `app.features.stats.routes.stats_bp`
- Uses model `QuizAttempt` with relations to `QuizSet`, `Folder`.

| Method | Endpoint    | Description                                  |
| ------ | ----------- | -------------------------------------------- |
| POST   | `/attempts` | Save a quiz attempt (quizSetId, score, …)    |
| GET    | `/attempts` | List attempts (query: `folder_id`)           |
| GET    | `/heatmap`  | Heatmap data (accuracy per folder)           |
| GET    | `/timeline` | Timeline data (query: `folder_id`, `period`) |
| GET    | `/overview` | Statistics overview                          |

---

## 6. Health & Running the Application

- **GET /api/health** — App-wide health check (defined in `app/__init__.py`).
- **GET /api/quiz/health** — Quiz service health check.

Run:

```bash
python app.py
# or
flask run --port 5000
```

When `USER_DATA_PATH` is set (desktop/Electron): host `127.0.0.1`, debug off, CORS allows `null`/`file://`.

---

## 7. Main Dependencies (`requirements.txt`)

- **Web:** flask, flask-cors, flask-sqlalchemy, python-dotenv
- **Image:** pillow, numpy
- **PDF:** pdfplumber, PyMuPDF (bounding boxes + page rendering for OCR)
- **LLM:** requests, google-generativeai, google-genai
- **YouTube:** youtube-transcript-api

---

This document describes the current back-end structure and flow. When adding a new feature, create a module under `app/features/<feature_name>/` (models, routes, service as needed) and register the blueprint in `app/__init__.py`.
