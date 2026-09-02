"""Backend test suite.

Several tests drive error paths on purpose (a key hitting its rate limit, a
subscriber callback raising). Those paths log at WARNING, which would bury the
actual test result in CI output, so the suite runs quiet — raise the level here
when debugging a failure.
"""
import logging

logging.disable(logging.WARNING)
