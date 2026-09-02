"""Tests for the API-key pool: rotation, cooldown and usage accounting.

The pool decides which key every LLM call spends. A rotation bug quietly drains
one key while the others idle, and a cooldown bug hands out a key that is still
rate-limited — both surface to the user as "generation failed" with no clue why.
"""
import unittest
from datetime import datetime, timedelta, timezone

from app.db import db
from app.features.api_keys import key_manager
from app.features.api_keys.models import ApiKey, GeminiApiKeyDailyUsage, today_pst
from tests.support import AppTestCase


def _utcnow():
    return datetime.now(timezone.utc)


class KeyManagerTestCase(AppTestCase, unittest.TestCase):
    def _add_key(self, plaintext, provider="gemini", status="active", last_used_at=None):
        key = ApiKey(provider=provider, label=plaintext, status=status)
        key.key = plaintext  # property setter encrypts + hashes
        key.last_used_at = last_used_at
        db.session.add(key)
        db.session.commit()
        return key


class GetOptimalKeyTests(KeyManagerTestCase):
    def test_returns_none_on_an_empty_pool(self):
        self.assertIsNone(key_manager.get_optimal_key())

    def test_prefers_a_never_used_key(self):
        self._add_key("AQ.used-key", last_used_at=_utcnow() - timedelta(minutes=1))
        fresh = self._add_key("AQ.fresh-key", last_used_at=None)

        self.assertEqual(key_manager.get_optimal_key().id, fresh.id)

    def test_picks_the_least_recently_used_key(self):
        now = _utcnow()
        oldest = self._add_key("AQ.oldest", last_used_at=now - timedelta(hours=3))
        self._add_key("AQ.newer", last_used_at=now - timedelta(hours=1))
        self._add_key("AQ.newest", last_used_at=now)

        self.assertEqual(key_manager.get_optimal_key().id, oldest.id)

    def test_honours_the_provider_filter(self):
        self._add_key("AQ.gemini-one", provider="gemini", last_used_at=None)
        claude = self._add_key(
            "sk-ant-claude", provider="anthropic", last_used_at=_utcnow()
        )

        chosen = key_manager.get_optimal_key(provider="anthropic")

        self.assertEqual(chosen.id, claude.id)

    def test_provider_none_searches_the_whole_pool(self):
        self._add_key("sk-ant-only", provider="anthropic", last_used_at=None)

        self.assertIsNotNone(key_manager.get_optimal_key())

    def test_returns_none_when_the_provider_has_no_key(self):
        self._add_key("AQ.gemini-only", provider="gemini")

        self.assertIsNone(key_manager.get_optimal_key(provider="openai"))

    def test_skips_excluded_ids(self):
        first = self._add_key("AQ.first", last_used_at=_utcnow() - timedelta(hours=2))
        second = self._add_key("AQ.second", last_used_at=_utcnow())

        chosen = key_manager.get_optimal_key(exclude_ids=[first.id])

        self.assertEqual(chosen.id, second.id)

    def test_skips_disabled_and_cooldown_keys(self):
        self._add_key("AQ.disabled", status="disabled", last_used_at=None)
        cooling = self._add_key("AQ.cooling", status="cooldown", last_used_at=None)
        cooling.cooldown_until = _utcnow() + timedelta(minutes=5)
        db.session.commit()

        self.assertIsNone(key_manager.get_optimal_key())

    def test_rotation_spreads_load_evenly(self):
        """Round-robin: three keys, six calls, two uses each."""
        for i in range(3):
            self._add_key(f"AQ.rotate-{i}", last_used_at=None)

        picks = []
        for _ in range(6):
            key = key_manager.get_optimal_key()
            picks.append(key.id)
            key_manager.record_success(key.id)

        self.assertEqual(len(set(picks)), 3)
        for key_id in set(picks):
            self.assertEqual(picks.count(key_id), 2)


class CooldownTests(KeyManagerTestCase):
    def test_rate_limit_error_moves_the_key_into_cooldown(self):
        key = self._add_key("AQ.rate-limited")

        key_manager.record_error(key.id, "429 quota exceeded", is_rate_limit=True)

        refreshed = db.session.get(ApiKey, key.id)
        self.assertEqual(refreshed.status, "cooldown")
        self.assertIsNotNone(refreshed.cooldown_until)
        self.assertEqual(refreshed.error_count, 1)
        self.assertIn("429", refreshed.last_error)

    def test_cooldown_lasts_the_configured_window(self):
        key = self._add_key("AQ.window")
        before = datetime.now(timezone.utc).replace(tzinfo=None)

        key_manager.record_error(key.id, "429", is_rate_limit=True)

        refreshed = db.session.get(ApiKey, key.id)
        elapsed = (refreshed.cooldown_until - before).total_seconds()
        self.assertGreaterEqual(elapsed, key_manager.COOLDOWN_SECONDS - 5)
        self.assertLessEqual(elapsed, key_manager.COOLDOWN_SECONDS + 5)

    def test_non_rate_limit_error_leaves_the_key_active(self):
        key = self._add_key("AQ.bad-request")

        key_manager.record_error(key.id, "400 invalid argument", is_rate_limit=False)

        refreshed = db.session.get(ApiKey, key.id)
        self.assertEqual(refreshed.status, "active")
        self.assertIsNone(refreshed.cooldown_until)
        self.assertEqual(refreshed.error_count, 1)

    def test_error_message_is_truncated(self):
        key = self._add_key("AQ.verbose")

        key_manager.record_error(key.id, "x" * 900)

        self.assertEqual(len(db.session.get(ApiKey, key.id).last_error), 500)

    def test_expired_cooldown_is_recovered_on_the_next_pick(self):
        key = self._add_key("AQ.expired", status="cooldown")
        key.cooldown_until = _utcnow() - timedelta(seconds=1)
        db.session.commit()

        chosen = key_manager.get_optimal_key()

        self.assertIsNotNone(chosen, "an expired cooldown should return to the pool")
        self.assertEqual(chosen.id, key.id)
        self.assertEqual(chosen.status, "active")
        self.assertIsNone(chosen.cooldown_until)

    def test_unexpired_cooldown_is_left_alone(self):
        key = self._add_key("AQ.still-cooling", status="cooldown")
        key.cooldown_until = _utcnow() + timedelta(seconds=30)
        db.session.commit()

        self.assertIsNone(key_manager.get_optimal_key())
        self.assertEqual(db.session.get(ApiKey, key.id).status, "cooldown")

    def test_recovery_does_not_revive_a_disabled_key(self):
        key = self._add_key("AQ.disabled-forever", status="disabled")
        key.cooldown_until = _utcnow() - timedelta(hours=1)
        db.session.commit()

        key_manager.get_optimal_key()

        self.assertEqual(db.session.get(ApiKey, key.id).status, "disabled")


class RecordSuccessTests(KeyManagerTestCase):
    def test_counts_the_call_and_its_tokens(self):
        key = self._add_key("AQ.counter")

        key_manager.record_success(key.id, input_tokens=120, output_tokens=340)

        refreshed = db.session.get(ApiKey, key.id)
        self.assertEqual(refreshed.usage_count, 1)
        self.assertEqual(refreshed.total_input_tokens, 120)
        self.assertEqual(refreshed.total_output_tokens, 340)
        self.assertIsNotNone(refreshed.last_used_at)

    def test_accumulates_across_calls(self):
        key = self._add_key("AQ.accumulate")

        key_manager.record_success(key.id, input_tokens=10, output_tokens=20)
        key_manager.record_success(key.id, input_tokens=5, output_tokens=7)

        refreshed = db.session.get(ApiKey, key.id)
        self.assertEqual(refreshed.usage_count, 2)
        self.assertEqual(refreshed.total_input_tokens, 15)
        self.assertEqual(refreshed.total_output_tokens, 27)

    def test_success_clears_the_previous_error_message(self):
        key = self._add_key("AQ.recovering")
        key_manager.record_error(key.id, "500 server error")

        key_manager.record_success(key.id)

        self.assertEqual(db.session.get(ApiKey, key.id).last_error, "")

    def test_per_model_breakdown_is_recorded(self):
        key = self._add_key("AQ.breakdown")

        key_manager.record_success(
            key.id,
            input_tokens=100,
            output_tokens=200,
            model_stats={
                "gemini-2.5-flash": {"input_tokens": 60, "output_tokens": 150},
                "gemini-2.0-flash": {"input_tokens": 40, "output_tokens": 50},
            },
        )

        usage = db.session.get(ApiKey, key.id).get_model_usage()
        self.assertEqual(usage["gemini-2.5-flash"]["requests"], 1)
        self.assertEqual(usage["gemini-2.5-flash"]["input_tokens"], 60)
        self.assertEqual(usage["gemini-2.0-flash"]["output_tokens"], 50)

    def test_daily_usage_row_is_created_and_incremented(self):
        key = self._add_key("AQ.daily")
        stats = {"gemini-2.5-flash": {"input_tokens": 10, "output_tokens": 20}}

        key_manager.record_success(key.id, model_stats=stats)
        key_manager.record_success(key.id, model_stats=stats)

        row = GeminiApiKeyDailyUsage.query.filter_by(
            key_id=key.id, model="gemini-2.5-flash", date_pst=today_pst()
        ).one()
        self.assertEqual(row.requests, 2)
        self.assertEqual(row.input_tokens, 20)
        self.assertEqual(row.output_tokens, 40)
        self.assertEqual(row.provider, "gemini")

    def test_daily_usage_records_the_key_provider(self):
        key = self._add_key("sk-ant-daily", provider="anthropic")

        key_manager.record_success(
            key.id, model_stats={"claude-sonnet-4": {"input_tokens": 1, "output_tokens": 2}}
        )

        row = GeminiApiKeyDailyUsage.query.filter_by(key_id=key.id).one()
        self.assertEqual(row.provider, "anthropic")

    def test_unknown_key_id_is_a_no_op(self):
        key_manager.record_success("does-not-exist", input_tokens=5)
        key_manager.record_error("does-not-exist", "boom", is_rate_limit=True)

        self.assertEqual(ApiKey.query.count(), 0)


class GetAllActiveKeysTests(KeyManagerTestCase):
    def test_excludes_disabled_but_includes_cooldown(self):
        self._add_key("AQ.active-one")
        cooling = self._add_key("AQ.cooling-one", status="cooldown")
        cooling.cooldown_until = _utcnow() + timedelta(minutes=5)
        self._add_key("AQ.disabled-one", status="disabled")
        db.session.commit()

        keys = key_manager.get_all_active_keys()

        self.assertEqual({k.status for k in keys}, {"active", "cooldown"})
        self.assertEqual(len(keys), 2)

    def test_recovers_expired_cooldowns_as_a_side_effect(self):
        key = self._add_key("AQ.expiring", status="cooldown")
        key.cooldown_until = _utcnow() - timedelta(seconds=1)
        db.session.commit()

        key_manager.get_all_active_keys()

        self.assertEqual(db.session.get(ApiKey, key.id).status, "active")


class PoolSummaryTests(KeyManagerTestCase):
    def test_counts_keys_by_status(self):
        self._add_key("AQ.summary-active")
        cooling = self._add_key("AQ.summary-cooling", status="cooldown")
        cooling.cooldown_until = _utcnow() + timedelta(minutes=5)
        self._add_key("AQ.summary-disabled", status="disabled")
        db.session.commit()

        summary = key_manager.get_pool_summary()

        self.assertEqual(summary["totalKeys"], 3)
        self.assertEqual(summary["activeKeys"], 1)
        self.assertEqual(summary["cooldownKeys"], 1)
        self.assertEqual(summary["disabledKeys"], 1)

    def test_aggregates_tokens_and_today_counters(self):
        key = self._add_key("AQ.summary-tokens")
        key_manager.record_success(
            key.id,
            input_tokens=100,
            output_tokens=250,
            model_stats={"gemini-2.5-flash": {"input_tokens": 100, "output_tokens": 250}},
        )

        summary = key_manager.get_pool_summary()

        self.assertEqual(summary["totalInputTokens"], 100)
        self.assertEqual(summary["totalOutputTokens"], 250)
        self.assertEqual(summary["totalTokens"], 350)
        self.assertEqual(summary["totalRequestsToday"], 1)
        self.assertEqual(summary["totalTokensToday"], 350)

    def test_empty_pool_summarises_to_zeroes(self):
        summary = key_manager.get_pool_summary()

        self.assertEqual(summary["totalKeys"], 0)
        self.assertEqual(summary["totalTokens"], 0)
        self.assertEqual(summary["modelUsage"], [])
        self.assertEqual(summary["providerUsage"], [])


class ForeignKeyPragmaTests(KeyManagerTestCase):
    def test_deleting_a_key_cascades_to_its_daily_usage(self):
        """Guards the per-connection `foreign_keys` pragma in `create_app()`.

        SQLite defaults it to OFF, and without it the `ondelete="CASCADE"` on
        the usage table is inert — orphan rows then skew every stats screen.
        """
        key = self._add_key("AQ.cascade")
        key_manager.record_success(
            key.id, model_stats={"gemini-2.5-flash": {"input_tokens": 1, "output_tokens": 1}}
        )
        self.assertEqual(GeminiApiKeyDailyUsage.query.count(), 1)

        db.session.delete(db.session.get(ApiKey, key.id))
        db.session.commit()

        self.assertEqual(GeminiApiKeyDailyUsage.query.count(), 0)


class KeyEncryptionTests(KeyManagerTestCase):
    def test_key_is_not_stored_in_plaintext(self):
        plaintext = "AQ.super-secret-value"

        key = self._add_key(plaintext)

        stored = db.session.execute(
            db.text("SELECT key FROM gemini_api_keys WHERE id = :id"), {"id": key.id}
        ).scalar_one()
        self.assertNotIn(plaintext, stored)
        self.assertTrue(stored.startswith("enc.v1:"))

    def test_key_round_trips_through_the_property(self):
        plaintext = "AQ.round-trip-value"

        key = self._add_key(plaintext)

        self.assertEqual(db.session.get(ApiKey, key.id).key, plaintext)

    def test_masked_key_hides_the_middle(self):
        key = self._add_key("AQ.abcdefghijklmnop")

        masked = key.masked_key()

        self.assertTrue(masked.startswith("AQ.a"))
        self.assertTrue(masked.endswith("mnop"))
        self.assertIn("•", masked)


if __name__ == "__main__":
    unittest.main()
