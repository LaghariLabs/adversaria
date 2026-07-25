"""Tests for the OllamaEmbedder module and /embed endpoint."""

from __future__ import annotations

import importlib
import sys
from typing import TYPE_CHECKING
from unittest.mock import MagicMock

import pytest

if TYPE_CHECKING:
    from fastapi.testclient import TestClient

# Mock ollama before any import that might trigger it
_fake_ollama = MagicMock()
_fake_client_instance = MagicMock()
_fake_ollama.Client.return_value = _fake_client_instance
sys.modules["ollama"] = _fake_ollama

# Reload src.embedder to pick up the mock (addresses ordering issues when
# other test files also mock ollama at the module level)
import src.embedder  # noqa: E402
importlib.reload(src.embedder)

from src.embedder import OllamaEmbedder, DEFAULT_EMBED_MODEL  # noqa: E402


@pytest.fixture
def embedder() -> OllamaEmbedder:
    """Create an OllamaEmbedder with mocked ollama client."""
    embedder = OllamaEmbedder(model=DEFAULT_EMBED_MODEL, host="http://localhost:11434")
    # Reset the shared mock to avoid cross-test call-count interference
    # (every OllamaEmbedder() gets the same _fake_client_instance).
    # reset_mock() alone doesn't clear side_effect/return_value — pass both.
    embedder.client.embed.reset_mock(return_value=True, side_effect=True)
    return embedder


class TestOllamaEmbedderEmbed:
    """Unit tests for OllamaEmbedder.embed()."""

    def test_embed_returns_vectors_and_model(self, embedder: OllamaEmbedder) -> None:
        """embed() returns (embeddings, model) on a successful response."""
        embedder.client.embed.return_value = {
            "embeddings": [[0.1, 0.2], [0.3, 0.4]],
        }
        vectors, model = embedder.embed(["hello", "world"])
        assert vectors == [[0.1, 0.2], [0.3, 0.4]]
        assert model == DEFAULT_EMBED_MODEL

    def test_embed_model_override(self, embedder: OllamaEmbedder) -> None:
        """A per-request model override is passed to client.embed."""
        embedder.client.embed.return_value = {
            "embeddings": [[0.5, 0.6]],
        }
        vectors, model = embedder.embed(["test"], model="other-model")
        embedder.client.embed.assert_called_once_with(
            model="other-model", input=["test"]
        )
        assert model == "other-model"
        assert vectors == [[0.5, 0.6]]

    def test_embed_client_error_raises_with_pull_hint(
        self, embedder: OllamaEmbedder
    ) -> None:
        """A client error raises RuntimeError whose message includes 'ollama pull'."""
        embedder.client.embed.side_effect = Exception("Connection refused")
        with pytest.raises(RuntimeError, match="ollama pull"):
            embedder.embed(["test"])

    def test_embed_count_mismatch_raises(
        self, embedder: OllamaEmbedder
    ) -> None:
        """A count mismatch (2 texts, 1 embedding) raises RuntimeError."""
        embedder.client.embed.return_value = {
            "embeddings": [[0.1, 0.2]],  # only 1, but we sent 2
        }
        with pytest.raises(RuntimeError, match="count mismatch"):
            embedder.embed(["a", "b"])


# ---------------------------------------------------------------------------
# Endpoint tests — use TestClient with a mocked _embedder singleton.
# We do NOT reload src.server here — test_server.py already sets up
# _transcriber and _summarizer at module scope; a reload would wipe them.
# ---------------------------------------------------------------------------


@pytest.fixture
def client() -> "TestClient":
    """Return a TestClient for the server app."""
    from fastapi.testclient import TestClient
    from src.server import app

    return TestClient(app)


@pytest.fixture
def mock_embed() -> MagicMock:
    """A MagicMock whose embed() returns 2 4-dim vectors for bge-m3."""
    m = MagicMock()
    m.embed.return_value = ([[0.1] * 4, [0.2] * 4], "bge-m3")
    return m


class TestEmbedEndpoint:
    """Tests for POST /embed."""

    def test_embed_success(self, client, mock_embed) -> None:
        """POST /embed with 2 texts returns 200 with correct shape."""
        import src.server as srv
        srv._embedder = mock_embed
        resp = client.post("/embed", json={"texts": ["hello", "world"]})
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["embeddings"]) == 2
        assert data["model"] == "bge-m3"
        assert data["dim"] == 4

    def test_embed_empty_texts(self, client, mock_embed) -> None:
        """POST /embed with empty texts list returns 400."""
        import src.server as srv
        srv._embedder = mock_embed
        resp = client.post("/embed", json={"texts": []})
        assert resp.status_code == 400

    def test_embed_too_many_texts(self, client, mock_embed) -> None:
        """POST /embed with 129 texts returns 400."""
        import src.server as srv
        srv._embedder = mock_embed
        resp = client.post("/embed", json={"texts": ["x"] * 129})
        assert resp.status_code == 400

    def test_embed_embedder_none(self, client) -> None:
        """POST /embed when _embedder is None returns 503."""
        import src.server as srv
        srv._embedder = None
        resp = client.post("/embed", json={"texts": ["hello"]})
        assert resp.status_code == 503

    def test_embed_runtime_error(self, client) -> None:
        """POST /embed when embed() raises RuntimeError returns 503 with hint."""
        import src.server as srv
        error_embedder = MagicMock()
        error_embedder.embed.side_effect = RuntimeError(
            "Embedding request failed (model=bge-m3). Is Ollama running "
            "and the model pulled? Try: ollama pull bge-m3. Error: Conn refused"
        )
        srv._embedder = error_embedder
        resp = client.post("/embed", json={"texts": ["hello"]})
        assert resp.status_code == 503
        assert "ollama pull" in resp.json()["detail"]
