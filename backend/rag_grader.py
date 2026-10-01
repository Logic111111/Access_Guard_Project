"""RAG (Retrieval-Augmented Generation) AI Grading Engine for AccessGuard.

Indexes reference model solutions, rubrics, and key concepts into a vector store,
retrieves relevant semantic context for student answers, and performs RAG-contextualized grading.
Supports OpenAI, Anthropic, Gemini, and Emergent LLM API Keys.
"""

import os
import math
import re
import json
import uuid
import asyncio
import logging
from typing import List, Dict, Any, Optional, Tuple
import httpx

log = logging.getLogger("accessguard.rag")


class VectorChunk:
    def __init__(self, chunk_id: str, text: str, metadata: Dict[str, Any]):
        self.chunk_id = chunk_id
        self.text = text
        self.metadata = metadata
        self.vector = self._tokenize_and_vectorize(text)

    @staticmethod
    def _tokenize_and_vectorize(text: str) -> Dict[str, float]:
        words = re.findall(r"\w+", (text or "").lower())
        if not words:
            return {}
        tf = {}
        for w in words:
            tf[w] = tf.get(w, 0) + 1
        length = math.sqrt(sum(v * v for v in tf.values()))
        if length > 0:
            return {k: v / length for k, v in tf.items()}
        return {}


class RAGVectorStore:
    def __init__(self):
        self.chunks: List[VectorChunk] = []

    def add_document(self, text: str, metadata: Dict[str, Any]):
        if not text:
            return
        sentences = [s.strip() for s in re.split(r"[.\n;]+", text) if s.strip()]
        if not sentences:
            sentences = [text.strip()]
        for idx, sentence in enumerate(sentences):
            chunk_id = f"{metadata.get('q_id', 'doc')}-{idx}"
            self.chunks.append(VectorChunk(chunk_id, sentence, metadata))

    def retrieve_context(self, query: str, top_k: int = 3) -> List[Tuple[VectorChunk, float]]:
        query_vec = VectorChunk._tokenize_and_vectorize(query)
        if not query_vec or not self.chunks:
            return []

        scored = []
        for chunk in self.chunks:
            dot_product = sum(query_vec.get(w, 0.0) * val for w, val in chunk.vector.items())
            if dot_product > 0:
                scored.append((chunk, dot_product))

        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:top_k]


class RAGGrader:
    def __init__(
        self,
        llm_chat=None,
        openai_key: Optional[str] = None,
        anthropic_key: Optional[str] = None,
        gemini_key: Optional[str] = None,
    ):
        # None means "not provided, fall back to the environment"; an explicit
        # "" means "no key", and must NOT fall back — otherwise a caller can
        # never force the no-key path when the environment has one configured.
        self.llm_chat = llm_chat
        self.openai_key = openai_key if openai_key is not None else os.environ.get("OPENAI_API_KEY", "")
        self.anthropic_key = anthropic_key if anthropic_key is not None else os.environ.get("ANTHROPIC_API_KEY", "")
        self.gemini_key = (
            gemini_key if gemini_key is not None
            else os.environ.get("GEMINI_API_KEY", os.environ.get("GOOGLE_API_KEY", ""))
        )

    async def evaluate_many(self, items: List[Dict[str, Any]], concurrency: int = 5) -> List[Dict[str, Any]]:
        """Runs evaluate_answer over many items concurrently, capped at `concurrency`
        in-flight calls, preserving input order in the returned list."""
        semaphore = asyncio.Semaphore(max(1, concurrency))

        async def _run_one(item: Dict[str, Any]) -> Dict[str, Any]:
            async with semaphore:
                return await self.evaluate_answer(**item)

        return list(await asyncio.gather(*[_run_one(item) for item in items]))

    async def _post_with_retry(
        self,
        url: str,
        headers: Dict[str, str],
        payload: Dict[str, Any],
        timeout: float = 20.0,
        retries: int = 1,
        backoff: float = 0.3,
    ) -> "httpx.Response":
        """POSTs JSON with one retry on timeout/5xx before letting the caller fall through
        to the next grading provider."""
        last_exc: Optional[Exception] = None
        for attempt in range(retries + 1):
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    resp = await client.post(url, headers=headers, json=payload)
                    if resp.status_code >= 500:
                        resp.raise_for_status()
                    resp.raise_for_status()
                    return resp
            except Exception as e:
                last_exc = e
                if attempt < retries:
                    await asyncio.sleep(backoff * (attempt + 1))
                    continue
        raise last_exc

    async def evaluate_answer(
        self,
        question_id: str,
        question_text: str,
        model_answer: str,
        student_answer: str,
        max_marks: float = 10.0,
        question_type: str = "text",
    ) -> Dict[str, Any]:
        """Runs RAG pipeline to evaluate a student's submission against reference solutions."""
        student_clean = str(student_answer or "").strip()
        model_clean = str(model_answer or "").strip()

        if not student_clean:
            return {
                "score": 0.0,
                "max": max_marks,
                "feedback": "No answer submitted.",
                "retrieved_context": [],
                "rag_confidence": 1.0,
                "method": "empty_answer",
            }

        # 1. Build Knowledge Store for this question
        vector_store = RAGVectorStore()
        vector_store.add_document(model_clean, {"q_id": question_id, "type": "model_answer"})
        vector_store.add_document(question_text, {"q_id": question_id, "type": "question_text"})

        # 2. RAG Retrieval Step: Retrieve top semantic evidence chunks
        retrieved_results = vector_store.retrieve_context(student_clean, top_k=3)
        retrieved_chunks = [chunk.text for chunk, sim in retrieved_results]
        top_similarity = retrieved_results[0][1] if retrieved_results else 0.0

        # 3. Handle MCQ type directly
        if question_type == "mcq":
            is_correct = student_clean.upper() == model_clean.upper()
            score = max_marks if is_correct else 0.0
            feedback = (
                f"Correct choice: {model_clean}"
                if is_correct
                else f"Incorrect. Selected: {student_clean}, Reference: {model_clean}"
            )
            return {
                "score": score,
                "max": max_marks,
                "feedback": feedback,
                "retrieved_context": [model_clean],
                "rag_confidence": 1.0,
                "method": "mcq_exact",
            }

        # 4. Contextual LLM RAG Reasoning Step
        ai_score = None
        method = None
        feedback = ""
        context_block = "\n".join([f"- {c}" for c in retrieved_chunks]) or "- Model Solution: " + model_clean
        prompt = (
            f"=== RAG RETRIEVED CONTEXT ===\n{context_block}\n\n"
            f"=== QUESTION ===\n{question_text}\n\n"
            f"=== REFERENCE SOLUTION ===\n{model_clean}\n\n"
            f"=== STUDENT ANSWER ===\n{student_clean}\n\n"
            "Task: Compare the student's answer against the RAG retrieved context and reference solution.\n"
            "Evaluate: 1. Conceptual Understanding (0-4), 2. Terminology & Key Facts (0-3), 3. Completeness (0-3).\n"
            "Return STRICT JSON only: {\"score\": <0.0 to 10.0 float>, \"feedback\": \"<short constructive feedback with evidence citation>\"}"
        )

        # Try Emergent LLM Chat
        if self.llm_chat and ai_score is None:
            try:
                from emergentintegrations.llm.chat import UserMessage
                raw = await self.llm_chat.send_message(UserMessage(text=prompt))
                match = re.search(r"\{.*\}", raw, re.DOTALL)
                if match:
                    parsed = json.loads(match.group(0))
                    ai_score = max(0.0, min(10.0, float(parsed.get("score", 0))))
                    feedback = str(parsed.get("feedback", "")).strip()
                    method = "emergent"
            except Exception as e:
                log.warning(f"Emergent LLM evaluation exception: {e}")

        # Try Anthropic API directly
        if self.anthropic_key and ai_score is None:
            try:
                resp = await self._post_with_retry(
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": self.anthropic_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    payload={
                        "model": "claude-sonnet-4-5-20250929",
                        "max_tokens": 512,
                        "messages": [{"role": "user", "content": prompt}],
                    },
                )
                content = resp.json()["content"][0]["text"]
                match = re.search(r"\{.*\}", content, re.DOTALL)
                if match:
                    parsed = json.loads(match.group(0))
                    ai_score = max(0.0, min(10.0, float(parsed.get("score", 0))))
                    feedback = str(parsed.get("feedback", "")).strip()
                    method = "anthropic"
            except Exception as e:
                log.warning(f"Anthropic evaluation exception: {e}")

        # Try OpenAI API directly
        if self.openai_key and ai_score is None:
            try:
                resp = await self._post_with_retry(
                    "https://api.openai.com/v1/chat/completions",
                    headers={"Authorization": f"Bearer {self.openai_key}"},
                    payload={
                        "model": "gpt-4o-mini",
                        "messages": [{"role": "user", "content": prompt}],
                        "temperature": 0.2,
                    },
                )
                content = resp.json()["choices"][0]["message"]["content"]
                match = re.search(r"\{.*\}", content, re.DOTALL)
                if match:
                    parsed = json.loads(match.group(0))
                    ai_score = max(0.0, min(10.0, float(parsed.get("score", 0))))
                    feedback = str(parsed.get("feedback", "")).strip()
                    method = "openai"
            except Exception as e:
                log.warning(f"OpenAI evaluation exception: {e}")

        # Try Gemini API directly
        if self.gemini_key and ai_score is None:
            try:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key={self.gemini_key}"
                resp = await self._post_with_retry(url, headers={}, payload={"contents": [{"parts": [{"text": prompt}]}]})
                content = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
                match = re.search(r"\{.*\}", content, re.DOTALL)
                if match:
                    parsed = json.loads(match.group(0))
                    ai_score = max(0.0, min(10.0, float(parsed.get("score", 0))))
                    feedback = str(parsed.get("feedback", "")).strip()
                    method = "gemini"
            except Exception as e:
                log.warning(f"Gemini evaluation exception: {e}")

        # 5. Vector Evidence Fallback if LLM unavailable or fails
        if ai_score is None:
            s_words = set(re.findall(r"\w+", student_clean.lower()))
            m_words = set(re.findall(r"\w+", model_clean.lower()))
            overlap = len(s_words.intersection(m_words)) / max(1.0, float(len(m_words))) if m_words else 1.0
            
            raw_rag_score = (top_similarity * 0.6 + overlap * 0.4) * 10.0
            ai_score = max(0.0, min(10.0, round(raw_rag_score, 1)))
            method = "vector_fallback"
            if student_clean.lower() == model_clean.lower():
                ai_score = 10.0
                feedback = "RAG Match: 100% exact semantic alignment with reference solution."
            else:
                feedback = f"RAG Vector Evaluation ({int(overlap * 100)}% context match). Provide OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or EMERGENT_LLM_KEY in backend/.env for AI model reasoning."

        scaled_score = round((ai_score / 10.0) * max_marks, 2)

        return {
            "score": scaled_score,
            "max": max_marks,
            "feedback": feedback,
            "retrieved_context": retrieved_chunks,
            "rag_confidence": round(min(1.0, top_similarity + 0.2), 2),
            "method": method,
        }
