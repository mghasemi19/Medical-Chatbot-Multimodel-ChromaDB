"""Local ChromaDB storage and retrieval for the medical PDF knowledge base."""

from functools import lru_cache
from pathlib import Path

import chromadb
from openai import OpenAI
from langchain_openai import ChatOpenAI


from app.config import settings

ROOT = Path(__file__).resolve().parent.parent


@lru_cache(maxsize=1)
def clients():
    """Return the OpenAI client and persistent local Chroma client."""
    if not settings.openai_api_key:
        raise ValueError("OPENAI_API_KEY must be set in the environment or .env file.")

    db_path = Path(settings.chroma_db_path)
    if not db_path.is_absolute():
        db_path = ROOT / db_path

    #ai = OpenAI(api_key=settings.openai_api_key)
    ai = OpenAI(api_key=settings.openai_api_key, base_url=settings.base_url)
    chroma = chromadb.PersistentClient(path=str(db_path))
    return ai, chroma


def get_collection():
    """Open (or create) the persistent collection using cosine distance."""
    _, chroma = clients()
    return chroma.get_or_create_collection(
        name=settings.chroma_collection,
        metadata={"hnsw:space": "cosine"},
    )


def embed(texts):
    """Create OpenAI vectors; Chroma stores/searches them locally."""
    ai, _ = clients()
    result = ai.embeddings.create(model=settings.openai_embed_model, input=texts)
    return [item.embedding for item in result.data]


def upsert_chunks(records):
    """Add or replace records shaped as (id, text, metadata, embedding)."""
    if not records:
        return

    collection = get_collection()
    collection.upsert(
        ids=[record[0] for record in records],
        documents=[record[1] for record in records],
        metadatas=[record[2] for record in records],
        embeddings=[record[3] for record in records],
    )


def search_kb(query, top_k=5):
    """Return relevant PDF passages in the shape expected by the LangGraph."""
    collection = get_collection()
    count = collection.count()
    if not count:
        return []

    vector = embed([query])[0]
    result = collection.query(
        query_embeddings=[vector],
        n_results=min(top_k, count),
        include=["documents", "metadatas", "distances"],
    )

    matches = []
    ids = result.get("ids", [[]])[0]
    documents = result.get("documents", [[]])[0]
    metadatas = result.get("metadatas", [[]])[0]
    distances = result.get("distances", [[]])[0]

    for document_id, document, metadata, distance in zip(ids, documents, metadatas, distances):
        metadata = metadata or {}
        # With cosine distance, 1 - distance provides a similarity-style score,
        # preserving the existing 0.30 retrieval cutoff and 0.62 web-routing threshold.
        score = 1.0 - float(distance)
        if score >= 0.30:
            matches.append(
                {
                    "page": metadata.get("page"),
                    # Pass through the source filename stored during ingestion.
                    "file": metadata.get("file", "Unknown PDF"),
                    "text": document or "",
                    "score": round(score, 3),
                    "source": metadata.get("file", "Unknown PDF"),
                    "id": document_id,
                }
            )

    return matches
