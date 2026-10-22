# Use a lightweight Python 3.11 base image.
FROM python:3.11-slim

WORKDIR /app

# Keep container logs immediate and avoid writing Python bytecode.
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV CHROMA_DB_PATH=/app/chroma_db

# Install runtime support for ChromaDB and build tools used by native dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    curl \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir -r requirements.txt

# Copy only the application/runtime files; secrets and local databases are excluded.
COPY app ./app
COPY static ./static
COPY templates ./templates
COPY ingest.py ./ingest.py
COPY data ./data

# Mount a persistent volume here when keeping Chroma vectors between container runs.
VOLUME ["/app/chroma_db"]

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
