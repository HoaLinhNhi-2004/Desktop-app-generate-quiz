"""
Vector Store Service — ChromaDB wrapper for document chunk storage and retrieval.

Uses ChromaDB with default embedding function (ONNX all-MiniLM-L6-v2).
Stores document chunks with metadata for retrieval during quiz generation.
"""

import os
import time
import logging
import threading

import chromadb

logger = logging.getLogger(__name__)

_client: chromadb.ClientAPI | None = None
_client_lock = threading.Lock()

COLLECTION_NAME = "document_chunks"


def _get_client() -> chromadb.ClientAPI:
    """Get or create a persistent ChromaDB client (thread-safe)."""
    global _client
    if _client is not None:
        return _client

    with _client_lock:
        # Double-check after acquiring lock
        if _client is not None:
            return _client

        from flask import current_app
        db_path = current_app.config.get("CHROMADB_PATH", "")
        if not db_path:
            base_dir = os.path.dirname(os.path.abspath(__file__))
            db_path = os.path.join(base_dir, "..", "..", "instance", "chromadb")

        db_path = os.path.abspath(db_path)
        os.makedirs(db_path, exist_ok=True)

        # ChromaDB v1.x uses Rust bindings with a shared system singleton.
        # Retry if initialization fails due to race conditions.
        last_err = None
        for attempt in range(3):
            try:
                _client = chromadb.PersistentClient(path=db_path)
                logger.info("ChromaDB initialized at %s", db_path)
                return _client
            except (ValueError, KeyError, AttributeError) as e:
                last_err = e
                logger.warning("ChromaDB init attempt %d failed: %s", attempt + 1, e)
                time.sleep(0.5 * (attempt + 1))
        raise RuntimeError(f"Failed to initialize ChromaDB after 3 attempts: {last_err}")


def _get_collection():
    """Get or create the main document chunks collection."""
    client = _get_client()
    return client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )


def store_chunks(
    record_id: str,
    folder_id: str,
    source_name: str,
    chunks: list[str],
) -> int:
    """
    Store text chunks in ChromaDB for a given upload record.
    Returns the number of chunks stored.
    """
    if not chunks:
        return 0

    collection = _get_collection()

    ids = [f"{record_id}_chunk_{i}" for i in range(len(chunks))]
    metadatas = [
        {
            "record_id": record_id,
            "folder_id": folder_id,
            "source_name": source_name,
            "chunk_index": i,
            "chunk_total": len(chunks),
        }
        for i in range(len(chunks))
    ]

    # ChromaDB auto-embeds via default embedding function
    collection.add(documents=chunks, metadatas=metadatas, ids=ids)

    logger.info(
        "Stored %d chunks for record %s (%s)", len(chunks), record_id, source_name
    )
    return len(chunks)


def get_record_chunks(record_id: str) -> list[str]:
    """Retrieve all chunks for a specific upload record, ordered by chunk_index."""
    collection = _get_collection()
    results = collection.get(
        where={"record_id": record_id},
        include=["documents", "metadatas"],
    )

    if not results["documents"]:
        return []

    paired = list(zip(results["documents"], results["metadatas"]))
    paired.sort(key=lambda x: x[1].get("chunk_index", 0))

    return [doc for doc, _ in paired]


def get_records_chunks(record_ids: list[str]) -> list[str]:
    """Retrieve all chunks for multiple upload records, preserving per-record order."""
    all_chunks: list[str] = []
    for rid in record_ids:
        all_chunks.extend(get_record_chunks(rid))
    return all_chunks


def query_chunks(
    query_text: str,
    record_ids: list[str] | None = None,
    n_results: int = 20,
) -> list[str]:
    """
    Semantic search for relevant chunks.
    Optionally filter by specific record IDs.
    """
    collection = _get_collection()

    where_filter = None
    if record_ids:
        if len(record_ids) == 1:
            where_filter = {"record_id": record_ids[0]}
        else:
            where_filter = {"record_id": {"$in": record_ids}}

    results = collection.query(
        query_texts=[query_text],
        n_results=n_results,
        where=where_filter,
        include=["documents"],
    )

    if not results["documents"] or not results["documents"][0]:
        return []

    return results["documents"][0]


def delete_record_chunks(record_id: str) -> None:
    """Delete all chunks for a specific upload record."""
    try:
        collection = _get_collection()
        results = collection.get(where={"record_id": record_id}, include=[])
        if results["ids"]:
            collection.delete(ids=results["ids"])
            logger.info(
                "Deleted %d chunks for record %s", len(results["ids"]), record_id
            )
    except Exception as e:
        logger.warning("Could not delete chunks for record %s: %s", record_id, e)


def delete_folder_chunks(folder_id: str) -> None:
    """Delete all chunks for a folder."""
    try:
        collection = _get_collection()
        results = collection.get(where={"folder_id": folder_id}, include=[])
        if results["ids"]:
            collection.delete(ids=results["ids"])
            logger.info(
                "Deleted %d chunks for folder %s", len(results["ids"]), folder_id
            )
    except Exception as e:
        logger.warning("Could not delete chunks for folder %s: %s", folder_id, e)


def has_record_chunks(record_id: str) -> bool:
    """Check if a record has chunks stored in ChromaDB."""
    try:
        collection = _get_collection()
        results = collection.get(where={"record_id": record_id}, include=[])
        return bool(results["ids"])
    except Exception:
        return False
