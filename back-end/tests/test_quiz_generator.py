"""Tests for the quiz generation pipeline's pure logic.

Everything here runs without an app context, a DB or a network call — the
module is written so the chunking/parsing/merging half can be exercised on its
own, and that is exactly the half where the expensive regressions have landed.
"""
import threading
import unittest

from app.features.quizz.quiz_generator import (
    _QuestionSink,
    _StreamingArrayParser,
    _calc_max_output_tokens,
    _deduplicate_questions,
    _exact_key,
    _extract_section_titles,
    _split_into_chunks,
)


def _question(text, options=("A", "B", "C", "D")):
    return {
        "questionText": text,
        "options": [{"id": f"o{i}", "text": t} for i, t in enumerate(options)],
    }


class SplitIntoChunksTests(unittest.TestCase):
    def test_short_text_is_one_chunk_untouched(self):
        text = "One paragraph only."
        self.assertEqual(_split_into_chunks(text, max_chunk_size=100), [text])

    def test_text_exactly_at_the_limit_is_not_split(self):
        text = "x" * 100
        self.assertEqual(_split_into_chunks(text, max_chunk_size=100), [text])

    def test_long_text_splits_on_paragraph_boundaries(self):
        paragraphs = [f"Paragraph number {i} " + "y" * 60 for i in range(10)]
        chunks = _split_into_chunks("\n\n".join(paragraphs), max_chunk_size=200, overlap=0)

        self.assertGreater(len(chunks), 1)
        # No paragraph may be torn in half: each one lands inside some chunk whole.
        for para in paragraphs:
            self.assertTrue(
                any(para in c for c in chunks),
                f"paragraph was split across chunks: {para[:40]!r}",
            )

    def test_no_content_is_dropped(self):
        """The regression behind "stop discarding most of a long document".

        Every paragraph of the input has to survive into at least one chunk — a
        splitter that silently drops the tail still returns a plausible list.
        """
        paragraphs = [f"Section {i}: unique marker {i * 7919}" for i in range(120)]
        text = "\n\n".join(paragraphs)

        chunks = _split_into_chunks(text, max_chunk_size=500, overlap=50)
        joined = "\n".join(chunks)

        missing = [p for p in paragraphs if p not in joined]
        self.assertEqual(missing, [], f"{len(missing)} paragraph(s) lost while chunking")

    def test_chunk_body_respects_the_size_limit(self):
        text = "\n\n".join(f"Para {i} " + "z" * 80 for i in range(40))
        max_size, overlap = 400, 60

        chunks = _split_into_chunks(text, max_chunk_size=max_size, overlap=overlap)

        # Chunks after the first carry a prepended tail of the previous one, so
        # the ceiling there is max + overlap rather than max.
        self.assertLessEqual(len(chunks[0]), max_size)
        for c in chunks[1:]:
            self.assertLessEqual(len(c), max_size + overlap)

    def test_adjacent_chunks_overlap(self):
        text = "\n\n".join(f"Para {i} " + "w" * 80 for i in range(20))

        chunks = _split_into_chunks(text, max_chunk_size=300, overlap=60)

        self.assertGreater(len(chunks), 1)
        for prev, nxt in zip(chunks, chunks[1:]):
            head = nxt.split("\n\n")[0]
            self.assertTrue(head, "overlap head should not be empty")
            self.assertIn(head, prev, "each chunk should start with a tail of the previous")

    def test_overlap_zero_disables_the_prefix(self):
        text = "\n\n".join(f"Para {i} " + "v" * 80 for i in range(10))

        chunks = _split_into_chunks(text, max_chunk_size=300, overlap=0)

        self.assertGreater(len(chunks), 1)
        self.assertTrue(chunks[1].startswith("Para "))

    def test_oversized_paragraph_is_split_on_sentence_boundaries(self):
        para = " ".join(f"Sentence {i} about something." for i in range(60))

        chunks = _split_into_chunks(para, max_chunk_size=300, overlap=0)

        self.assertGreater(len(chunks), 1)
        rejoined = " ".join(chunks) + " "
        for i in range(60):
            self.assertIn(f"Sentence {i} ", rejoined)

    def test_single_unbreakable_sentence_is_kept_whole(self):
        """Known limit, asserted so that changing it is a deliberate act.

        A paragraph past the limit with no sentence terminator cannot be split
        without cutting mid-word, so it is emitted oversized rather than mangled.
        """
        para = "x" * 900

        chunks = _split_into_chunks(para, max_chunk_size=300, overlap=0)

        self.assertEqual(chunks, [para])


class ExtractSectionTitlesTests(unittest.TestCase):
    def test_recognises_the_four_heading_shapes(self):
        text = "\n".join([
            "I. Roman numeral heading",
            "body text that is not a heading at all, it is much too long to match",
            "## Markdown heading",
            "ALL CAPS HEADING",
            "**Bold heading**",
        ])

        titles = _extract_section_titles(text)

        self.assertIn("I. Roman numeral heading", titles)
        self.assertIn("Markdown heading", titles)
        self.assertIn("ALL CAPS HEADING", titles)
        self.assertIn("Bold heading", titles)

    def test_caps_at_twelve_and_deduplicates(self):
        text = "\n".join(["## Repeated"] * 5 + [f"## Heading {i}" for i in range(30)])

        titles = _extract_section_titles(text)

        self.assertLessEqual(len(titles), 12)
        self.assertEqual(len(titles), len(set(titles)))


class DeduplicateQuestionsTests(unittest.TestCase):
    def test_drops_near_duplicates_and_preserves_order(self):
        questions = [
            _question("What is the capital of France?"),
            _question("What is the capital of France ?"),
            _question("Which river runs through Cairo?"),
        ]

        result = _deduplicate_questions(questions)

        self.assertEqual(
            [q["questionText"] for q in result],
            ["What is the capital of France?", "Which river runs through Cairo?"],
        )

    def test_keeps_genuinely_different_questions(self):
        questions = [
            _question("Who wrote the Aeneid?"),
            _question("Define photosynthesis."),
            _question("When did the Berlin Wall fall?"),
            _question("Name the largest ocean."),
        ]

        self.assertEqual(len(_deduplicate_questions(questions)), 4)

    def test_empty_input(self):
        self.assertEqual(_deduplicate_questions([]), [])


class CalcMaxOutputTokensTests(unittest.TestCase):
    def test_small_request_gets_the_floor(self):
        self.assertEqual(_calc_max_output_tokens(1, "multiple-choice"), 8_192)

    def test_scales_with_question_count(self):
        self.assertEqual(_calc_max_output_tokens(40, "multiple-choice"), 20_000)

    def test_never_exceeds_the_model_ceiling(self):
        self.assertEqual(_calc_max_output_tokens(10_000, "multiple-choice"), 65_536)


class ExactKeyTests(unittest.TestCase):
    def test_ignores_question_numbering_and_whitespace(self):
        a = _question("Câu 1: Thủ đô của Pháp là gì?")
        b = _question("Câu 27:  Thủ đô  của Pháp   là gì?")

        self.assertEqual(_exact_key(a), _exact_key(b))

    def test_different_options_are_different_keys(self):
        a = _question("Same stem?", options=("A", "B"))
        b = _question("Same stem?", options=("A", "C"))

        self.assertNotEqual(_exact_key(a), _exact_key(b))


class StreamingArrayParserTests(unittest.TestCase):
    def test_parses_a_raw_array(self):
        parser = _StreamingArrayParser()

        found = parser.feed('[{"a": 1}, {"a": 2}]')

        self.assertEqual(found, [{"a": 1}, {"a": 2}])
        self.assertEqual(parser.emitted_count, 2)

    def test_parses_a_fenced_array(self):
        parser = _StreamingArrayParser()

        found = parser.feed('```json\n[{"a": 1}]\n```')

        self.assertEqual(found, [{"a": 1}])

    def test_parses_a_wrapper_object(self):
        """The stack (not a brace counter) is what makes this case emit early."""
        parser = _StreamingArrayParser()

        found = parser.feed('{"questions": [{"a": 1}, {"a": 2}]}')

        self.assertEqual(found, [{"a": 1}, {"a": 2}])

    def test_emits_incrementally_before_the_array_closes(self):
        parser = _StreamingArrayParser()

        first = parser.feed('[{"a": 1},')

        self.assertEqual(first, [{"a": 1}])
        self.assertEqual(parser.feed(' {"a": 2}]'), [{"a": 2}])

    def test_char_by_char_feeding_matches_one_shot(self):
        payload = '{"questions": [{"q": "x", "opts": ["a", "b"]}, {"q": "y", "opts": []}]}'

        drip = _StreamingArrayParser()
        streamed = []
        for ch in payload:
            streamed.extend(drip.feed(ch))

        self.assertEqual(streamed, _StreamingArrayParser().feed(payload))
        self.assertEqual(len(streamed), 2)

    def test_braces_inside_strings_do_not_confuse_the_scanner(self):
        parser = _StreamingArrayParser()

        found = parser.feed('[{"q": "use {} and [] carefully"}, {"q": "second"}]')

        self.assertEqual(len(found), 2)
        self.assertEqual(found[0]["q"], "use {} and [] carefully")

    def test_escaped_quote_inside_a_string(self):
        parser = _StreamingArrayParser()

        found = parser.feed(r'[{"q": "he said \"hi\" once"}]')

        self.assertEqual(found[0]["q"], 'he said "hi" once')

    def test_incomplete_trailing_object_is_not_emitted(self):
        parser = _StreamingArrayParser()

        found = parser.feed('[{"a": 1}, {"a": 2')

        self.assertEqual(found, [{"a": 1}])
        self.assertEqual(parser.emitted_count, 1)

    def test_nested_objects_emit_only_the_top_level_element(self):
        parser = _StreamingArrayParser()

        found = parser.feed('[{"a": {"deep": true}}, {"b": 2}]')

        self.assertEqual(found, [{"a": {"deep": True}}, {"b": 2}])


class QuestionSinkTests(unittest.TestCase):
    def test_numbers_questions_sequentially_and_assigns_ids(self):
        sink = _QuestionSink(limit=3, on_question=None)

        for text in ("Who painted Guernica?", "Define entropy.", "Capital of Peru?"):
            self.assertTrue(sink.offer(_question(text)))

        numbers = [q["questionNumber"] for q in sink.snapshot()]
        self.assertEqual(numbers, [1, 2, 3])
        self.assertEqual(len({q["id"] for q in sink.snapshot()}), 3)

    def test_enforces_the_limit_and_signals_quota_reached(self):
        sink = _QuestionSink(limit=2, on_question=None)

        self.assertTrue(sink.offer(_question("Who discovered penicillin?")))
        self.assertTrue(sink.offer(_question("Define a prime number.")))
        self.assertFalse(sink.offer(_question("Largest moon of Saturn?")))

        self.assertEqual(sink.count, 2)
        self.assertTrue(sink.quota_reached.is_set())

    def test_fuzzy_mode_drops_near_duplicates(self):
        sink = _QuestionSink(limit=10, on_question=None, dedupe_mode="fuzzy")

        self.assertTrue(sink.offer(_question("What is the capital of France?")))
        self.assertFalse(sink.offer(_question("What is the capital of France ?")))

        self.assertEqual(sink.count, 1)

    def test_exact_mode_keeps_stem_templated_exam_questions(self):
        """Import mode's whole reason for existing.

        An exam paper repeats one stem with a changed tail; fuzzy similarity
        scores those ~0.98 and would delete almost the entire paper.
        """
        sink = _QuestionSink(limit=10, on_question=None, dedupe_mode="exact")
        stems = [f"Thiết bị nào được lắp đặt ở tầng {i} của toà nhà?" for i in range(1, 6)]

        for stem in stems:
            self.assertTrue(sink.offer(_question(stem)), f"exact mode dropped {stem!r}")

        self.assertEqual(sink.count, 5)

    def test_exact_mode_still_drops_literal_repeats(self):
        sink = _QuestionSink(limit=10, on_question=None, dedupe_mode="exact")

        self.assertTrue(sink.offer(_question("Câu 1: Giá trị của x là bao nhiêu?")))
        self.assertFalse(sink.offer(_question("Câu 9:  Giá trị của x là bao nhiêu?")))

        self.assertEqual(sink.count, 1)

    def test_off_mode_accepts_everything(self):
        sink = _QuestionSink(limit=10, on_question=None, dedupe_mode="off")

        for _ in range(4):
            self.assertTrue(sink.offer(_question("Identical text every time?")))

        self.assertEqual(sink.count, 4)

    def test_callback_receives_each_accepted_question_in_order(self):
        seen = []
        sink = _QuestionSink(limit=5, on_question=lambda q, n: seen.append(n))

        for text in ("Boiling point of water?", "Who is Ada Lovelace?", "Define a vector."):
            sink.offer(_question(text))

        self.assertEqual(seen, [1, 2, 3])

    def test_a_failing_callback_does_not_reject_the_question(self):
        def explode(_q, _n):
            raise RuntimeError("subscriber died")

        sink = _QuestionSink(limit=5, on_question=explode)

        self.assertTrue(sink.offer(_question("Still accepted?")))
        self.assertEqual(sink.count, 1)

    def test_concurrent_offers_produce_contiguous_numbering(self):
        """The sink is shared by the parallel chunk workers."""
        sink = _QuestionSink(limit=80, on_question=None, dedupe_mode="off")
        barrier = threading.Barrier(8)

        def worker(base):
            barrier.wait()
            for i in range(10):
                sink.offer(_question(f"worker {base} question {i}?"))

        threads = [threading.Thread(target=worker, args=(b,)) for b in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        numbers = sorted(q["questionNumber"] for q in sink.snapshot())
        self.assertEqual(numbers, list(range(1, 81)))
        self.assertTrue(sink.quota_reached.is_set())

    def test_concurrent_offers_never_exceed_the_limit(self):
        sink = _QuestionSink(limit=25, on_question=None, dedupe_mode="off")

        def worker():
            for i in range(20):
                sink.offer(_question(f"q{i}?"))

        threads = [threading.Thread(target=worker) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(sink.count, 25)


if __name__ == "__main__":
    unittest.main()
