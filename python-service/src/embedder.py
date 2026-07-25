"""Text embedding via a local Ollama model (default bge-m3)."""

from __future__ import annotations

import logging
import os

from ollama import Client

logger = logging.getLogger(__name__)

# The embedding model to use. bge-m3 (BAAI, MIT, 1024-dim) has the strongest
# multilingual/Arabic retrieval of the practical local options.
DEFAULT_EMBED_MODEL = os.environ.get("EMBED_MODEL", "bge-m3")


class OllamaEmbedder:
    """Embeds batches of texts with a local Ollama embedding model."""

    def __init__(
        self,
        model: str = DEFAULT_EMBED_MODEL,
        host: str = "http://localhost:11434",
    ) -> None:
        self.model = model
        self.host = host
        self.client = Client(host=host)
        logger.info("Embedder initialized: model=%s host=%s", model, host)

    def embed(
        self, texts: list[str], model: str | None = None
    ) -> tuple[list[list[float]], str]:
        """Embed `texts`; returns (embeddings, model_used).

        Raises RuntimeError with an actionable message when Ollama is down,
        the model isn't pulled, or the response is malformed.
        """
        use_model = (model or self.model).strip()
        try:
            response = self.client.embed(model=use_model, input=texts)
        except Exception as exc:
            raise RuntimeError(
                f"Embedding request failed (model={use_model}). Is Ollama running "
                f"and the model pulled? Try: ollama pull {use_model}. Error: {exc}"
            ) from exc
        embeddings = [list(e) for e in response["embeddings"]]
        if len(embeddings) != len(texts):
            raise RuntimeError(
                f"Embedding count mismatch: sent {len(texts)} texts, "
                f"got {len(embeddings)} embeddings (model={use_model})."
            )
        return embeddings, use_model
