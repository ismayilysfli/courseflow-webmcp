import asyncio
import unittest

from agent.course_agent import _run_with_provider_retries


class FakeProviderError(Exception):
    def __init__(self, status_code: int):
        super().__init__(f"provider status {status_code}")
        self.status_code = status_code


class WrappedProviderError(Exception):
    def __init__(self, error: Exception):
        super().__init__("wrapped provider error")
        self.error = error


class ProviderRetryTests(unittest.TestCase):
    def test_transient_failure_retries_twice_then_succeeds(self):
        attempts = 0

        async def operation():
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise WrappedProviderError(FakeProviderError(503))
            return "ok"

        result = asyncio.run(
            _run_with_provider_retries(operation, delay_seconds=0)
        )
        self.assertEqual(result, "ok")
        self.assertEqual(attempts, 3)

    def test_transient_failure_stops_after_three_attempts(self):
        attempts = 0

        async def operation():
            nonlocal attempts
            attempts += 1
            raise FakeProviderError(429)

        with self.assertRaises(FakeProviderError):
            asyncio.run(
                _run_with_provider_retries(operation, delay_seconds=0)
            )
        self.assertEqual(attempts, 3)

    def test_permanent_provider_failure_is_not_retried(self):
        attempts = 0

        async def operation():
            nonlocal attempts
            attempts += 1
            raise FakeProviderError(401)

        with self.assertRaises(FakeProviderError):
            asyncio.run(
                _run_with_provider_retries(operation, delay_seconds=0)
            )
        self.assertEqual(attempts, 1)

    def test_validation_style_failure_is_not_retried(self):
        attempts = 0

        async def operation():
            nonlocal attempts
            attempts += 1
            raise ValueError("invalid structured output")

        with self.assertRaises(ValueError):
            asyncio.run(
                _run_with_provider_retries(operation, delay_seconds=0)
            )
        self.assertEqual(attempts, 1)


if __name__ == "__main__":
    unittest.main()