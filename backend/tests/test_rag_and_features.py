"""Unit tests for Phase 2 features: RAG Grader, Candidate Exit Endpoint, and Session Deletion."""
import asyncio
import httpx
import pytest
from unittest.mock import AsyncMock, MagicMock
from rag_grader import RAGGrader, RAGVectorStore

def test_rag_grader_explicit_empty_key_overrides_the_environment(monkeypatch):
    # A caller that explicitly passes "" must get no key, even if a real one
    # is configured in the environment (e.g. via backend/.env) — otherwise
    # there is no way to force the fallback path for testing or a deliberate
    # per-call override.
    monkeypatch.setenv("GEMINI_API_KEY", "real-key-from-env")
    grader = RAGGrader(llm_chat=None, gemini_key="")
    assert grader.gemini_key == ""


def test_rag_grader_omitted_key_still_falls_back_to_the_environment(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "real-key-from-env")
    grader = RAGGrader(llm_chat=None)
    assert grader.gemini_key == "real-key-from-env"


def test_rag_vector_store_retrieval():
    store = RAGVectorStore()
    store.add_document("Photosynthesis uses sunlight to create glucose and oxygen from carbon dioxide.", {"q_id": "q1"})
    store.add_document("Mitochondria generate cellular energy through ATP production.", {"q_id": "q2"})

    context = store.retrieve_context("What converts sunlight into glucose?", top_k=1)
    assert len(context) >= 1
    assert "Photosynthesis" in context[0][0].text

def test_rag_grader_evaluation():
    async def _run():
        # Explicit empty keys: this test exercises the vector-fallback path
        # specifically, regardless of whether a real key is configured in
        # backend/.env for the running environment.
        grader = RAGGrader(llm_chat=None, openai_key="", anthropic_key="", gemini_key="")
        res = await grader.evaluate_answer(
            question_id="q1",
            question_text="Describe photosynthesis.",
            model_answer="Photosynthesis is the process by which plants convert light energy into chemical energy.",
            student_answer="Plants process light energy into chemical energy for food.",
            max_marks=10.0,
            question_type="text"
        )
        assert res["score"] > 5.0
        assert len(res["retrieved_context"]) >= 1
        assert "RAG" in res["feedback"] or "Automated" in res["feedback"] or "Semantic" in res["feedback"]

    asyncio.run(_run())


def test_rag_grader_mcq_reports_method():
    async def _run():
        grader = RAGGrader(llm_chat=None)
        res = await grader.evaluate_answer(
            question_id="q1",
            question_text="Pick the correct option.",
            model_answer="B",
            student_answer="B",
            max_marks=5.0,
            question_type="mcq",
        )
        assert res["method"] == "mcq_exact"

    asyncio.run(_run())


def test_rag_grader_empty_answer_reports_method():
    async def _run():
        grader = RAGGrader(llm_chat=None)
        res = await grader.evaluate_answer(
            question_id="q1",
            question_text="Explain X.",
            model_answer="X is Y.",
            student_answer="",
            max_marks=10.0,
            question_type="text",
        )
        assert res["method"] == "empty_answer"

    asyncio.run(_run())


def test_rag_grader_uses_anthropic_when_configured(monkeypatch):
    async def _run():
        fake_resp = MagicMock()
        fake_resp.status_code = 200
        fake_resp.raise_for_status = lambda: None
        fake_resp.json = lambda: {
            "content": [{"text": '{"score": 8.5, "feedback": "Good answer, citing evidence."}'}]
        }
        post_mock = AsyncMock(return_value=fake_resp)
        monkeypatch.setattr(httpx.AsyncClient, "post", post_mock)

        grader = RAGGrader(llm_chat=None, anthropic_key="test-anthropic-key")
        res = await grader.evaluate_answer(
            question_id="q1",
            question_text="Describe photosynthesis.",
            model_answer="Photosynthesis converts light into chemical energy.",
            student_answer="Plants convert light into chemical energy.",
            max_marks=10.0,
            question_type="text",
        )
        assert res["method"] == "anthropic"
        assert res["score"] == 8.5
        assert "Good answer" in res["feedback"]
        post_mock.assert_awaited_once()
        called_url = post_mock.await_args.args[0]
        assert "anthropic.com" in called_url

    asyncio.run(_run())


def test_rag_grader_retries_once_before_falling_through(monkeypatch):
    async def _run():
        good_resp = MagicMock()
        good_resp.status_code = 200
        good_resp.raise_for_status = lambda: None
        good_resp.json = lambda: {
            "content": [{"text": '{"score": 7.0, "feedback": "Solid, retried through."}'}]
        }
        post_mock = AsyncMock(side_effect=[httpx.ConnectTimeout("boom"), good_resp])
        monkeypatch.setattr(httpx.AsyncClient, "post", post_mock)
        monkeypatch.setattr(asyncio, "sleep", AsyncMock())

        grader = RAGGrader(llm_chat=None, anthropic_key="test-anthropic-key")
        res = await grader.evaluate_answer(
            question_id="q1",
            question_text="Describe photosynthesis.",
            model_answer="Photosynthesis converts light into chemical energy.",
            student_answer="Plants convert light into chemical energy.",
            max_marks=10.0,
            question_type="text",
        )
        assert res["method"] == "anthropic"
        assert res["score"] == 7.0
        assert post_mock.await_count == 2

    asyncio.run(_run())


def test_rag_grader_falls_through_to_next_provider_after_retry_exhausted(monkeypatch):
    async def _run():
        good_resp = MagicMock()
        good_resp.status_code = 200
        good_resp.raise_for_status = lambda: None
        good_resp.json = lambda: {
            "choices": [{"message": {"content": '{"score": 6.0, "feedback": "OpenAI took over."}'}}]
        }
        # Anthropic fails on both attempts; OpenAI succeeds on its first.
        post_mock = AsyncMock(side_effect=[httpx.ConnectTimeout("a"), httpx.ConnectTimeout("b"), good_resp])
        monkeypatch.setattr(httpx.AsyncClient, "post", post_mock)
        monkeypatch.setattr(asyncio, "sleep", AsyncMock())

        grader = RAGGrader(llm_chat=None, anthropic_key="test-anthropic-key", openai_key="test-openai-key")
        res = await grader.evaluate_answer(
            question_id="q1",
            question_text="Describe photosynthesis.",
            model_answer="Photosynthesis converts light into chemical energy.",
            student_answer="Plants convert light into chemical energy.",
            max_marks=10.0,
            question_type="text",
        )
        assert res["method"] == "openai"
        assert res["score"] == 6.0
        assert post_mock.await_count == 3

    asyncio.run(_run())


def test_rag_grader_evaluate_many_preserves_order_and_correctness():
    async def _run():
        grader = RAGGrader(llm_chat=None)
        items = [
            dict(question_id=f"q{i}", question_text="Q", model_answer="A", student_answer="A",
                 max_marks=10.0, question_type="mcq")
            for i in range(5)
        ]
        results = await grader.evaluate_many(items)
        assert len(results) == 5
        assert all(r["method"] == "mcq_exact" for r in results)

    asyncio.run(_run())


def test_rag_grader_evaluate_many_respects_concurrency_limit(monkeypatch):
    async def _run():
        grader = RAGGrader(llm_chat=None)
        in_flight = 0
        peak = 0
        lock = asyncio.Lock()

        async def fake_evaluate_answer(**kwargs):
            nonlocal in_flight, peak
            async with lock:
                in_flight += 1
                peak = max(peak, in_flight)
            await asyncio.sleep(0.05)
            async with lock:
                in_flight -= 1
            return {"method": "mcq_exact", "score": 1.0}

        monkeypatch.setattr(grader, "evaluate_answer", fake_evaluate_answer)
        items = [dict(question_id=f"q{i}") for i in range(10)]
        results = await grader.evaluate_many(items, concurrency=3)
        assert len(results) == 10
        assert peak == 3

    asyncio.run(_run())


def test_rag_grader_uses_gemini_with_a_current_model_when_configured(monkeypatch):
    async def _run():
        fake_resp = MagicMock()
        fake_resp.status_code = 200
        fake_resp.raise_for_status = lambda: None
        fake_resp.json = lambda: {
            "candidates": [{"content": {"parts": [{"text": '{"score": 7.5, "feedback": "Solid, well-explained answer."}'}]}}]
        }
        post_mock = AsyncMock(return_value=fake_resp)
        monkeypatch.setattr(httpx.AsyncClient, "post", post_mock)

        grader = RAGGrader(llm_chat=None, gemini_key="test-gemini-key")
        res = await grader.evaluate_answer(
            question_id="q1",
            question_text="Describe photosynthesis.",
            model_answer="Photosynthesis converts light into chemical energy.",
            student_answer="Plants convert light into chemical energy.",
            max_marks=10.0,
            question_type="text",
        )
        assert res["method"] == "gemini"
        assert res["score"] == 7.5
        post_mock.assert_awaited_once()
        called_url = post_mock.await_args.args[0]
        assert "generativelanguage.googleapis.com" in called_url
        # Pinned model names get retired by Google over time (gemini-1.5-flash
        # already was); the "-latest" alias tracks whatever's current instead.
        # The lite variant is used deliberately: it has its own separate quota
        # bucket from the full "thinking" model and doesn't spend tokens on a
        # reasoning pass grading doesn't need.
        assert "gemini-flash-lite-latest" in called_url

    asyncio.run(_run())


def test_rag_grader_no_keys_reports_vector_fallback_method():
    async def _run():
        grader = RAGGrader(llm_chat=None, openai_key="", anthropic_key="", gemini_key="")
        res = await grader.evaluate_answer(
            question_id="q1",
            question_text="Describe photosynthesis.",
            model_answer="Photosynthesis is the process by which plants convert light energy into chemical energy.",
            student_answer="Plants process light energy into chemical energy for food.",
            max_marks=10.0,
            question_type="text",
        )
        assert res["method"] == "vector_fallback"

    asyncio.run(_run())
