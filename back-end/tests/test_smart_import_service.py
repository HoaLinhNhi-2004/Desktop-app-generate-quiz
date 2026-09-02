"""Tests for the smart-import job state machine.

The pipeline runs on a background thread and the UI drives it through
pause/resume/cancel plus a polled progress dict. Nothing here starts that
thread: these tests drive the state functions directly, which is the layer where
a wrong transition strands a job at "paused forever" or reports 12/10 files done.
"""
import os
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone

from app.features.folder import smart_import_service as sis


def _blank_job(job_id, status="scanning"):
    """Same shape `start_import_job()` seeds, without spawning the worker."""
    return {
        "id": job_id,
        "status": status,
        "dirPath": "/tmp/whatever",
        "totalFiles": 0,
        "completed": 0,
        "skipped": 0,
        "reviewCount": 0,
        "files": [],
        "createdFolders": [],
        "error": None,
        "warning": "",
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "paused": False,
        "cancelRequested": False,
        "rateLimitInfo": "",
    }


class SmartImportTestCase(unittest.TestCase):
    """Keeps the module-global job store isolated per test."""

    def setUp(self):
        with sis._jobs_lock:
            self._saved = dict(sis._import_jobs)
            sis._import_jobs.clear()

    def tearDown(self):
        with sis._jobs_lock:
            sis._import_jobs.clear()
            sis._import_jobs.update(self._saved)

    def make_job(self, job_id="job-1", status="scanning"):
        with sis._jobs_lock:
            sis._import_jobs[job_id] = _blank_job(job_id, status)
        return job_id


class JobLookupTests(SmartImportTestCase):
    def test_get_job_returns_none_for_an_unknown_id(self):
        self.assertIsNone(sis.get_job("nope"))

    def test_get_job_returns_the_job_dict(self):
        job_id = self.make_job()

        self.assertEqual(sis.get_job(job_id)["id"], job_id)

    def test_predicates_are_false_for_an_unknown_job(self):
        self.assertFalse(sis._is_job_paused("nope"))
        self.assertFalse(sis._is_job_cancelled("nope"))

    def test_update_job_on_an_unknown_id_is_a_no_op(self):
        sis._update_job("nope", status="importing")

        self.assertIsNone(sis.get_job("nope"))


class PauseResumeCancelTests(SmartImportTestCase):
    def test_pause_then_resume(self):
        job_id = self.make_job()

        self.assertTrue(sis.pause_job(job_id))
        self.assertTrue(sis._is_job_paused(job_id))

        self.assertTrue(sis.resume_job(job_id))
        self.assertFalse(sis._is_job_paused(job_id))

    def test_pause_is_rejected_for_a_finished_job(self):
        for status in ("completed", "error", "cancelled"):
            with self.subTest(status=status):
                job_id = self.make_job(f"job-{status}", status=status)

                self.assertFalse(sis.pause_job(job_id))
                self.assertFalse(sis._is_job_paused(job_id))

    def test_pause_is_allowed_while_running(self):
        for status in ("scanning", "categorizing", "importing"):
            with self.subTest(status=status):
                job_id = self.make_job(f"job-{status}", status=status)

                self.assertTrue(sis.pause_job(job_id))

    def test_pause_and_resume_on_an_unknown_job_return_false(self):
        self.assertFalse(sis.pause_job("nope"))
        self.assertFalse(sis.resume_job("nope"))

    def test_cancel_sets_the_flag(self):
        job_id = self.make_job()

        self.assertTrue(sis.cancel_job(job_id))
        self.assertTrue(sis._is_job_cancelled(job_id))

    def test_cancel_unpauses_so_the_loop_can_exit(self):
        """A paused job that is cancelled must not stay parked in the wait loop."""
        job_id = self.make_job()
        sis.pause_job(job_id)

        sis.cancel_job(job_id)

        self.assertFalse(sis._is_job_paused(job_id))
        self.assertTrue(sis._is_job_cancelled(job_id))

    def test_cancel_on_an_unknown_job_returns_false(self):
        self.assertFalse(sis.cancel_job("nope"))


class WaitWhilePausedTests(SmartImportTestCase):
    def test_returns_immediately_when_not_paused(self):
        job_id = self.make_job()

        started = time.monotonic()
        cancelled = sis._wait_while_paused(job_id)

        self.assertFalse(cancelled)
        self.assertLess(time.monotonic() - started, 0.3)

    def test_reports_cancellation_of_a_running_job(self):
        job_id = self.make_job()
        sis.cancel_job(job_id)

        self.assertTrue(sis._wait_while_paused(job_id))

    def test_unblocks_when_the_job_is_resumed(self):
        job_id = self.make_job()
        sis.pause_job(job_id)
        released = threading.Event()

        def waiter():
            sis._wait_while_paused(job_id)
            released.set()

        threading.Thread(target=waiter, daemon=True).start()
        self.assertFalse(released.wait(timeout=0.6), "should still be blocked while paused")

        sis.resume_job(job_id)

        self.assertTrue(released.wait(timeout=3), "resume did not release the waiter")

    def test_unblocks_and_reports_cancelled_when_cancelled_while_paused(self):
        job_id = self.make_job()
        sis.pause_job(job_id)
        result = {}

        def waiter():
            result["cancelled"] = sis._wait_while_paused(job_id)

        thread = threading.Thread(target=waiter, daemon=True)
        thread.start()
        time.sleep(0.1)

        sis.cancel_job(job_id)
        thread.join(timeout=3)

        self.assertFalse(thread.is_alive(), "cancel did not release the waiter")
        self.assertTrue(result["cancelled"])


class FileStatusTests(SmartImportTestCase):
    def test_add_file_status_appends_an_entry(self):
        job_id = self.make_job()

        sis._add_file_status(job_id, "/docs/a.pdf", "a.pdf", "scanning")

        files = sis.get_job(job_id)["files"]
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0]["key"], "/docs/a.pdf")
        self.assertEqual(files[0]["name"], "a.pdf")
        self.assertEqual(files[0]["status"], "scanning")

    def test_add_file_status_on_an_unknown_job_is_a_no_op(self):
        sis._add_file_status("nope", "/docs/a.pdf", "a.pdf", "scanning")

        self.assertIsNone(sis.get_job("nope"))

    def test_update_moves_the_file_to_the_new_status(self):
        job_id = self.make_job()
        sis._add_file_status(job_id, "/docs/a.pdf", "a.pdf", "scanning")

        sis._update_file_status(job_id, "/docs/a.pdf", "done", folder_name="Toan", record_id="r1")

        entry = sis.get_job(job_id)["files"][0]
        self.assertEqual(entry["status"], "done")
        self.assertEqual(entry["folderName"], "Toan")
        self.assertEqual(entry["recordId"], "r1")

    def test_same_basename_in_two_folders_stays_separate(self):
        """The regression behind "stop mixing up same-named files".

        Matching used to be on the bare filename, so `Toan/Chuong 1.pdf` and
        `Ly/Chuong 1.pdf` shared one entry: one got updated twice (double-counting
        progress) and the other never left "scanning".
        """
        job_id = self.make_job()
        sis._add_file_status(job_id, "/root/Toan/Chuong 1.pdf", "Chuong 1.pdf", "scanning")
        sis._add_file_status(job_id, "/root/Ly/Chuong 1.pdf", "Chuong 1.pdf", "scanning")

        sis._update_file_status(job_id, "/root/Toan/Chuong 1.pdf", "done", folder_name="Toan")

        job = sis.get_job(job_id)
        by_key = {f["key"]: f for f in job["files"]}
        self.assertEqual(by_key["/root/Toan/Chuong 1.pdf"]["status"], "done")
        self.assertEqual(by_key["/root/Ly/Chuong 1.pdf"]["status"], "scanning")
        self.assertEqual(job["completed"], 1, "only one file finished")

    def test_update_for_an_unknown_key_changes_nothing(self):
        job_id = self.make_job()
        sis._add_file_status(job_id, "/docs/a.pdf", "a.pdf", "scanning")

        sis._update_file_status(job_id, "/docs/missing.pdf", "done")

        self.assertEqual(sis.get_job(job_id)["files"][0]["status"], "scanning")
        self.assertEqual(sis.get_job(job_id)["completed"], 0)


class CounterTests(SmartImportTestCase):
    def test_in_progress_statuses_count_nowhere(self):
        job_id = self.make_job()

        sis._add_file_status(job_id, "/a.pdf", "a.pdf", "scanning")
        sis._add_file_status(job_id, "/b.pdf", "b.pdf", "categorizing")

        job = sis.get_job(job_id)
        self.assertEqual((job["completed"], job["skipped"], job["reviewCount"]), (0, 0, 0))

    def test_each_terminal_status_lands_in_its_own_bucket(self):
        job_id = self.make_job()

        sis._add_file_status(job_id, "/a.pdf", "a.pdf", "done")
        sis._add_file_status(job_id, "/b.pdf", "b.pdf", "skipped")
        sis._add_file_status(job_id, "/c.pdf", "c.pdf", "error")
        sis._add_file_status(job_id, "/d.pdf", "d.pdf", "review")

        job = sis.get_job(job_id)
        self.assertEqual(job["completed"], 1)
        self.assertEqual(job["skipped"], 2, "skipped and error share a bucket")
        self.assertEqual(job["reviewCount"], 1)

    def test_relabelling_a_file_gives_the_old_bucket_its_count_back(self):
        """Counting the transition, not the destination, is what keeps totals sane."""
        job_id = self.make_job()
        sis._add_file_status(job_id, "/a.pdf", "a.pdf", "categorizing")

        sis._update_file_status(job_id, "/a.pdf", "done")
        self.assertEqual(sis.get_job(job_id)["completed"], 1)

        sis._update_file_status(job_id, "/a.pdf", "error")

        job = sis.get_job(job_id)
        self.assertEqual(job["completed"], 0, "the done bucket must give the file back")
        self.assertEqual(job["skipped"], 1)

    def test_repeating_the_same_status_does_not_double_count(self):
        job_id = self.make_job()
        sis._add_file_status(job_id, "/a.pdf", "a.pdf", "done")

        sis._update_file_status(job_id, "/a.pdf", "done")
        sis._update_file_status(job_id, "/a.pdf", "done")

        self.assertEqual(sis.get_job(job_id)["completed"], 1)

    def test_counters_never_go_negative(self):
        job_id = self.make_job()
        sis._add_file_status(job_id, "/a.pdf", "a.pdf", "categorizing")

        sis._update_file_status(job_id, "/a.pdf", "done")
        sis._update_file_status(job_id, "/a.pdf", "categorizing")
        sis._update_file_status(job_id, "/a.pdf", "categorizing")

        self.assertEqual(sis.get_job(job_id)["completed"], 0)

    def test_concurrent_updates_keep_the_totals_exact(self):
        job_id = self.make_job()
        paths = [f"/docs/file-{i}.pdf" for i in range(60)]
        for p in paths:
            sis._add_file_status(job_id, p, os.path.basename(p), "categorizing")
        barrier = threading.Barrier(6)

        def worker(subset):
            barrier.wait()
            for p in subset:
                sis._update_file_status(job_id, p, "done")

        threads = [
            threading.Thread(target=worker, args=(paths[i::6],)) for i in range(6)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(sis.get_job(job_id)["completed"], 60)


class NormalizeFolderNameTests(unittest.TestCase):
    def test_blank_becomes_uncategorized(self):
        self.assertEqual(sis._normalize_folder_name("   "), "Uncategorized")

    def test_title_cases_and_collapses_whitespace(self):
        self.assertEqual(sis._normalize_folder_name("  toan   cao   cap "), "Toan Cao Cap")

    def test_truncates_on_a_word_boundary(self):
        name = sis._normalize_folder_name(" ".join(["Word"] * 30))

        self.assertLessEqual(len(name), 50)
        self.assertFalse(name.endswith(" "))
        self.assertTrue(name.startswith("Word Word"))


class ValidateDirPathTests(unittest.TestCase):
    def test_accepts_a_real_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(
                sis._validate_dir_path(tmp), os.path.normpath(os.path.abspath(tmp))
            )

    def test_rejects_a_missing_directory(self):
        with self.assertRaises(ValueError):
            sis._validate_dir_path(os.path.join(tempfile.gettempdir(), "definitely-not-here-42"))

    def test_rejects_a_file_path(self):
        with tempfile.NamedTemporaryFile(delete=False) as fh:
            path = fh.name
        try:
            with self.assertRaises(ValueError):
                sis._validate_dir_path(path)
        finally:
            os.unlink(path)

    def test_normalises_traversal_segments_away(self):
        with tempfile.TemporaryDirectory() as tmp:
            nested = os.path.join(tmp, "sub")
            os.makedirs(nested)

            resolved = sis._validate_dir_path(os.path.join(nested, "..", "sub"))

            self.assertEqual(resolved, os.path.normpath(nested))
            self.assertNotIn("..", resolved)


if __name__ == "__main__":
    unittest.main()
