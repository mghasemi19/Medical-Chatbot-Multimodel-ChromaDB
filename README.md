# MedGuide AI — LangGraph + ChromaDB + FastAPI

A medical assistant with retrieval from the medical books, optional Tavily fallback, image observations, speech input/output, and a vanilla JavaScript web UI. ChromaDB stores vectors locally; OpenAI creates embeddings and generates answers.

<img width="1099" height="713" alt="Screenshot 2026-10-19 152723" src="https://github.com/user-attachments/assets/9b68a3c4-054b-45cb-9fe1-bd99b906b551" />

![Medical AI architecture diagram](docs/Medical%20AI%20Agent%20Architecture%20Infographic.png)

## Requirements

Python 3.11> , an OpenAI API key, and internet access for OpenAI. A Tavily API key is optional and enables web search fallback. This is a tutorial reference implementation, **not** a clinically validated diagnostic system or HIPAA-compliant deployment.

## Start

```bash
conda create -n medical-agent python=3.11 -y
conda activate medical-agent
pip install -r requirements.txt
```

Create a `.env` file in the project root:

```dotenv
OPENAI_API_KEY=your-openai-api-key
TAVILY_API_KEY=your-tavily-api-key
# Optional settings:
# CHROMA_DB_PATH=chroma_db
# CHROMA_COLLECTION=medical-book
```

Ingest the bundled PDF once, then start the API:

```bash
python ingest.py --pdf data/Medical_book.pdf
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

On Windows, use the same commands in Anaconda Prompt or PowerShell after activating the environment. The local Chroma database is created in `chroma_db/` and persists across restarts. Ingestion calls OpenAI to create embeddings, so OpenAI API connectivity and usage still apply even though Pinecone is no longer used.

Open **http://127.0.0.1:8000**. API documentation: **http://127.0.0.1:8000/docs**. `/api/health` reports whether OpenAI is configured and identifies ChromaDB as the vector store. Re-run ingestion after changing the source PDF; the script upserts current chunks and removes stale chunks for that same PDF after a successful run.

## Structure

- `app/config.py` — environment settings and SSL certificate handling
- `app/knowledge.py` — OpenAI embedding calls and persistent ChromaDB retrieval
- `app/agent.py` — LangGraph retrieve → route → optional Tavily search → answer
- `app/main.py` — FastAPI endpoints, image observations, Whisper and text-to-speech
- `ingest.py` — extracts and chunks the PDF, embeds it, and stores records in ChromaDB
- `chroma_db/` — local persistent vector database, created on first use
- `templates/index.html`, `static/app.js`, `static/style.css` — web interface
- `data/Medical_book.pdf` — historical reference PDF

## Troubleshooting

- **Missing API key**: set `OPENAI_API_KEY` in `.env`; restart the API after changing it.
- **No knowledge-base results**: run `python ingest.py --pdf data/Medical_book.pdf` and check that `chroma_db/` was created.
- **OpenAI connection errors**: ChromaDB is local, but embeddings, chat, vision, transcription, and speech still call OpenAI. Check VPN/proxy routing for OpenAI API access.
- **401**: if `API_TOKEN` is configured, enter it in the UI's API access section. Do not expose this token in a public browser deployment.
- **Camera/microphone**: browser permissions and localhost or HTTPS are required.
- **Tavily**: optional; without its key, external search is disabled.

## Security and production limitations

This project is a functional tutorial scaffold, not a production medical device. Before deploying to real patients: replace the shared API token with server-side identity/authentication; add encrypted conversation storage and retention/deletion controls; enforce request throttling and upload content verification; implement observability, tests, clinically reviewed emergency triage and evaluation; verify licensing to host/index the Gale PDF; obtain privacy/security/legal review; use current authoritative clinical references; and secure deployment behind HTTPS. Do not send identifiable patient data to third-party APIs without appropriate consent and agreements.

The historical book may contain obsolete clinical advice; model instructions do not guarantee safety. Images can be described but cannot confirm or rule out disease. This software does not make diagnoses.
