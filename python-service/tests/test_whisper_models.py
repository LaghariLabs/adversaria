"""On-device Whisper model registry — key→repo mapping and the picker list."""

from src.transcriber import (
    DEFAULT_WHISPER_MODEL,
    WHISPER_MODELS,
    list_whisper_models,
    whisper_repo_for,
)


def test_whisper_repo_mapping_and_fallback():
    assert whisper_repo_for("large-v3") == "mlx-community/whisper-large-v3-mlx"
    assert whisper_repo_for("large-v3-turbo-q4") == "mlx-community/whisper-large-v3-turbo-q4"
    # Unknown / None fall back to the default model's repo.
    default_repo = WHISPER_MODELS[DEFAULT_WHISPER_MODEL]["repo"]
    assert whisper_repo_for(None) == default_repo
    assert whisper_repo_for("nonexistent") == default_repo


def test_list_whisper_models_schema():
    models = list_whisper_models()
    assert len(models) >= 3
    for m in models:
        assert set(m.keys()) == {"key", "label", "size", "downloaded"}
        assert isinstance(m["downloaded"], bool)
        assert m["key"] in WHISPER_MODELS
