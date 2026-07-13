from __future__ import annotations
from dataclasses import dataclass
from typing import Optional, Dict, Any


@dataclass
class UserMessage:
    text: str


class LlmChat:
    def __init__(self, api_key: str, session_id: str, system_message: str):
        self.api_key = api_key
        self.session_id = session_id
        self.system_message = system_message
        self.model_name: Optional[str] = None

    def with_model(self, provider: str, model: str):
        self.model_name = f"{provider}:{model}"
        return self

    async def send_message(self, message: UserMessage) -> str:
        # Local fallback for grading when the emergentintegrations package is unavailable.
        # Returns a predictable JSON result for the backend to parse.
        return '{"score": 8, "feedback": "Placeholder grade"}'
