"""Shared pytest fixtures for the Mongo-free (but live-dev-Mongo-backed) backend
test files. The app's module-level Motor client binds to the event loop of its
first request, so every test in the session that needs a running lifespan must
share one TestClient/event loop rather than each opening its own `with
TestClient(app)` block — opening more than one across a session breaks Motor on
the second one with "Event loop is closed".
"""
import pytest
from fastapi.testclient import TestClient
from server import app


@pytest.fixture(scope="session")
def live_client():
    with TestClient(app) as c:
        yield c
