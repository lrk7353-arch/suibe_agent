"""Load the bundled embedding model without importing the upstream KB source tree."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def model_path():
    value = os.environ.get("XIAOMAO_EMBEDDING_MODEL", "models/bge-small-zh-v1.5")
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def load_model(device=None):
    from sentence_transformers import SentenceTransformer

    path = model_path()
    if not (path / "config.json").is_file():
        raise FileNotFoundError("embedding model missing: %s" % path)
    return SentenceTransformer(str(path), device=device or os.environ.get("XIAOMAO_EMBEDDING_DEVICE", "cpu"))
