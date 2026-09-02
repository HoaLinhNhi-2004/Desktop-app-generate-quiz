# Backend test suite

Runs on the standard library's `unittest` — there is no test dependency to
install, so the suite works in a bare checkout and CI needs no extra step.
pytest picks these classes up unchanged if it is ever added.

```bash
cd back-end
python -m unittest discover -s tests -t . -v
```

`-t .` matters: it makes `back-end/` the import root so `from app.features…`
resolves. Running a single module works the same way:

```bash
python -m unittest tests.test_key_manager -v
```

## Scope

Three services, chosen because a silent regression there is expensive and
because the git history shows regressions have actually happened in each.

| File | Covers |
|---|---|
| `test_quiz_generator.py` | chunk splitting, dedup, the streaming JSON parser, the sink's quota + numbering |
| `test_key_manager.py` | round-robin rotation, 429 cooldown, auto-recovery, usage accounting |
| `test_smart_import_service.py` | the pause/resume/cancel state machine and its progress counters |

Tests that pin a specific past bug name it in their docstring, so the reason the
assertion exists survives the next refactor.

## Fixtures

`support.py` builds a real app through `create_app()` against a throwaway SQLite
file rather than stubbing the DB. That costs a few milliseconds per test and
covers the startup path itself — the migration runner, the API-key encryption
backfill and the per-connection `foreign_keys` pragma have each caused a
user-visible bug, and each is exercised here.

`test_smart_import_service.py` swaps the module-global job store out per test,
so the state-machine tests never see each other's jobs.
