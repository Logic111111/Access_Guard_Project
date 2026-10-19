                "https://generativelanguage.googleapis.com/v1beta/models/"
                f"gemini-flash-lite-latest:generateContent?key={self.gemini_key}"
            )
            response = await self._post_with_retry(
                endpoint,
                headers={},
                payload={"contents": [{"parts": [{"text": prompt}]}]},
            )
            content = response.json()["candidates"][0]["content"]["parts"][0]["text"]
            return self._parse_grade(content)
        except Exception as exc:
            logger.warning("Gemini grading failed: %s", exc)
            return None

    async def evaluate_answer(
        self,
        question_id: str,
        question_text: str,
        model_answer: str,
        student_answer: str,
        max_marks: float = 10.0,
        question_type: str = "text",
    ) -> Dict[str, Any]:
        """Evaluate a submission against its question and reference answer."""
        student_text = str(student_answer or "").strip()
        reference_text = str(model_answer or "").strip()

        if not student_text:
            return {
                "score": 0.0,
                "max": max_marks,
                "feedback": "No answer submitted.",
                "retrieved_context": [],
                "rag_confidence": 1.0,
                "method": "empty_answer",
            }

        # Prepare and search the question-specific context.
        store = RAGVectorStore()
        store.add_document(reference_text, {"q_id": question_id, "type": "model_answer"})
        store.add_document(question_text, {"q_id": question_id, "type": "question_text"})

        retrieved = store.retrieve_context(student_text, top_k=3)
        context_texts = [chunk.text for chunk, _ in retrieved]
        best_similarity = retrieved[0][1] if retrieved else 0.0

        # Preserve exact-choice behavior for multiple-choice questions.
        if question_type == "mcq":
            correct = student_text.upper() == reference_text.upper()
            return {
                "score": max_marks if correct else 0.0,
                "max": max_marks,
                "feedback": (
                    f"Correct choice: {reference_text}"
                    if correct
                    else f"Incorrect. Selected: {student_text}, Reference: {reference_text}"
                ),
                "retrieved_context": [reference_text],
                "rag_confidence": 1.0,
                "method": "mcq_exact",
            }

        context_block = "\n".join(f"- {text}" for text in context_texts)
        if not context_block:
            context_block = "- Model Solution: " + reference_text

        prompt = (
            f"=== RAG RETRIEVED CONTEXT ===\n{context_block}\n\n"
            f"=== QUESTION ===\n{question_text}\n\n"
            f"=== REFERENCE SOLUTION ===\n{reference_text}\n\n"
            f"=== STUDENT ANSWER ===\n{student_text}\n\n"
            "Task: Compare the student's answer against the RAG retrieved context "
            "and reference solution.\n"
            "Evaluate: 1. Conceptual Understanding (0-4), "
            "2. Terminology & Key Facts (0-3), 3. Completeness (0-3).\n"
            'Return STRICT JSON only: {"score": <0.0 to 10.0 float>, '
            '"feedback": "<short constructive feedback with evidence citation>"}'
        )

        # Try providers in the same priority order as the existing implementation.
        provider_methods = (
            ("emergent", self._grade_with_emergent),
            ("anthropic", self._grade_with_anthropic),
            ("openai", self._grade_with_openai),
            ("gemini", self._grade_with_gemini),
        )
        ai_score: Optional[float] = None
        feedback = ""
        method: Optional[str] = None

        for provider_name, grade_method in provider_methods:
            result = await grade_method(prompt)
            if result is not None:
                ai_score, feedback = result
                method = provider_name
                break

        # Use lexical overlap when no provider returns a valid grade.
        if ai_score is None:
            student_words = set(_TOKEN_PATTERN.findall(student_text.lower()))
            reference_words = set(_TOKEN_PATTERN.findall(reference_text.lower()))
            overlap = (
                len(student_words & reference_words) / float(len(reference_words))
                if reference_words else 1.0
            )

            combined_score = (best_similarity * 0.6 + overlap * 0.4) * 10.0
            ai_score = max(0.0, min(10.0, round(combined_score, 1)))
            method = "vector_fallback"

            if student_text.lower() == reference_text.lower():
                ai_score = 10.0
                feedback = (
                    "RAG Match: 100% exact semantic alignment with reference solution."
                )
            else:
                feedback = (
                    f"RAG Vector Evaluation ({int(overlap * 100)}% context match). "
                    "Configure OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, "
                    "or EMERGENT_LLM_KEY in backend/.env for AI model reasoning."
                )

        final_score = round((ai_score / 10.0) * max_marks, 2)
        return {
            "score": final_score,
            "max": max_marks,
            "feedback": feedback,
            "retrieved_context": context_texts,
