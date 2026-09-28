"""Standalone DeepKrak3n FastAPI entrypoint for Railway.

Gunicorn imports ``app`` from this module. The development-server block is
kept only for direct local execution and never runs during import.
"""

import os

import uvicorn

from deepkrak3n_service.app.main import app

__all__ = ["app"]


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
    )