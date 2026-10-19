# Standard-library helpers for decoding uploaded images and audio, and generating IDs.
import base64
import io
import secrets
from pathlib import Path
import subprocess


from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from pydantic import BaseModel, Field
from openai import OpenAI
from uuid import uuid4
from app.config import settings  # Centralized environment-backed configuration.
from app.agent import graph      # Compiled LangGraph that handles retrieval, routing, and answering.

# Resolve static/template paths relative to the repository, not the shell's working directory.
ROOT = Path(__file__).resolve().parent.parent

# Create the FastAPI application and expose the browser's static assets.
app = FastAPI(title='Medical Agent App',version='1.0.0')

# Restrict browser origins and allowed HTTP methods/headers using .env configuration.
app.add_middleware(CORSMiddleware,allow_origins=settings.allowed_origins.split(','),
                   allow_credentials=False,allow_methods=['GET','POST'],
                   allow_headers=['Authorization','Content-Type'])

app.mount('/static',StaticFiles(directory=ROOT/'static'),name='static')



# Set state for the graph 
class ChatRequest(BaseModel):

    # Pydantic validates the incoming chat payload before the endpoint runs.
    message: str = Field(min_length=1,max_length=4000)

    # Recent browser-supplied messages provide conversational context to the LLM.
    history: list[dict[str,str]] = Field(default_factory=list,max_length=10)

    # Optional image encoded as a data URL (for example, from the browser UI).
    image_data: str | None = None




# Authenticate the login 
def auth(authorization: str | None):

    # Authentication is optional when API_TOKEN is unset; otherwise require a matching Bearer token.
    if settings.api_token and not secrets.compare_digest(authorization or '',f'Bearer {settings.api_token}'):
        raise HTTPException(status_code=401,detail='Invalid API token')




# Handles optional input image
def inspect_image(data):

    # No image means there is no visual observation to add to the agent's input.
    if not data:
        return ''
    try:
        # Split the data URL into its MIME type and base64-encoded image payload.
        header,payload=data.split(',',1)
        mime=header.split(';')[0].split(':')[1]
        raw=base64.b64decode(payload,validate=True)     # decodes the image.

        # Enforce supported formats and a 5 MB decoded-image limit before calling the vision API.
        if mime not in ('image/jpeg','image/png','image/webp') or len(raw)>10_000_000:
            raise ValueError('Only JPEG/PNG/WebP under 10MB supported')
        
    except (ValueError,IndexError) as exc:
        raise HTTPException(status_code=400,detail=f'Invalid image: {exc}')
    
    # Ask the vision model for objective observations only, not a diagnosis.
    client=OpenAI(api_key=settings.openai_api_key,
                  base_url=settings.base_url, 
                  timeout=45)
    result=client.chat.completions.create(model=settings.openai_vision_model,
                                          messages=[{'role':'user','content':[{'type':'text','text':'Describe only objectively visible medical-relevant features. Do not diagnose, estimate severity, or assert absence of illness. If image unclear, say so.'},
                                                                              {'type':'image_url','image_url':{'url':data}}]}],
                                          max_tokens=300)
    
    return result.choices[0].message.content or ''




# Home route
@app.get('/',response_class=HTMLResponse)
def home():
    # Serve the single-page chat interface from the templates directory.
    return (ROOT/'templates'/'index.html').read_text(encoding='utf-8')

# API token checks (backend is configured correctly)
@app.get('/api/health')
def health():
    # ChromaDB is local and is initialized on demand; OpenAI remains needed for embeddings/chat.
    return {'status':'ok',
            'configured':bool(settings.openai_api_key),
            'vector_store':'chroma',
            'tavily':bool(settings.tavily_api_key)}




# Main route to chat response
@app.post('/api/chat')
def chat(
    payload: ChatRequest,
    authorization: str | None = Header(default=None),
    conversation_id: str | None = Header(default=None, alias='X-Conversation-ID')
):
    # Reject unauthorized requests before invoking any external AI services.
    auth(authorization)

    # OpenAI is required for model calls and embeddings; ChromaDB runs locally.
    if not settings.openai_api_key:
        raise HTTPException(503,'Set OPENAI_API_KEY in .env')

    # Keep only well-formed user/assistant messages and cap the context sent to the graph.
    history=[x for x in payload.history if x.get('role') in ('user','assistant') and isinstance(x.get('content'),str)][:10]

    # The graph's SQLite checkpointer uses thread_id to associate state with a conversation.
    # Clients should send the returned ID back in X-Conversation-ID on subsequent requests.
    thread_id = conversation_id or str(uuid4())
    config = {"configurable": {"thread_id": thread_id}}

    try:
        # Convert an optional image into a cautious text observation for the graph.
        observation=inspect_image(payload.image_data)

        # Run the LangGraph: retrieve PDF passages, optionally search the web, then draft an answer.
        state=graph.invoke(
            {
                'question':payload.message,
                'history':history,
                'image_description':observation,
                'kb':[],
                'web':[],
                'answer':'',
                'route':''
            },
            config=config
        )

        # Return the answer alongside source metadata and a record of which tools contributed.
        return {
            'answer':state['answer'],
            'sources': [{'type':'pdf','page':x['page'],'score':x['score']} for x in state['kb']]+
                       [{'type':'web','url':x['url'],'title':x['title']} for x in state['web']],
            'tools': ['chromadb']+(['tavily'] if state['route']=='web' and settings.tavily_api_key else [])+
                     (['vision'] if observation else []),
            'conversation_id':thread_id
        }

    except HTTPException:
        # Preserve intentional HTTP errors such as validation/authentication failures.
        raise
    except Exception as exc:
        # Log diagnostic details server-side, but send a generic upstream error to the client.
        print('Chat error:',repr(exc),flush=True)
        raise HTTPException(502,'AI service failed. Check server logs, OpenAI credentials, local Chroma data, and connectivity.')




# Speech-to-text endpoint. This endpoint receives recorded audio
@app.post('/api/transcribe')
async def transcribe(file:UploadFile=File(...),authorization:str|None=Header(default=None)):

    # Validate the same optional Bearer-token policy used by the chat endpoint.
    auth(authorization)

    # Read one byte beyond the limit so oversized uploads can be detected without loading all of them.
    data=await file.read(10_000_001)

    if len(data)>10_000_000:
        raise HTTPException(413,'Audio exceeds 10 MB')
    
    # Preserve the browser's filename/extension so the API can identify the
    # actual recording format (for example, WebM on Chrome or MP4 on Safari).
    audio=io.BytesIO(data)
    audio.name=Path(file.filename or 'voice.webm').name

    try:
        # Convert the uploaded recording to text for the browser to place in its message box.
        # Match the timeout used by the working standalone test. The SDK's default
        # connection timeout is short, which can fail during a slower VPN/proxy handshake.
        client=OpenAI(api_key=settings.openai_api_key, base_url=settings.base_url, timeout=60)
        result=client.audio.transcriptions.create(model='whisper-1',file=audio)
        #result=client.audio.transcriptions.create(model='gpt-4o-transcribe',file=audio)
        return {'text':result.text}
    
    except Exception as exc:
        # Keep provider details in the server log rather than returning them to the browser.
        print('Transcription error:',repr(exc),flush=True)
        raise HTTPException(502,'Speech transcription unavailable')





# Text-to-speech endpoint
@app.post('/api/speak')
def speak(payload:dict,authorization:str|None=Header(default=None)):

    # Convert a bounded text response to audio for the UI's read-aloud control.
    auth(authorization)

    text=str(payload.get('text',''))[:3000]
    
    if not text:
        raise HTTPException(400,'Missing text')
    
    try:
        # Return synthesized speech as an MP3 response.
        speech=OpenAI(api_key=settings.openai_api_key, base_url=settings.base_url).audio.speech.create(model='tts-1',voice='alloy',input=text)
        return Response(content=speech.content,media_type='audio/mpeg')
    
    except Exception:
        raise HTTPException(502,'Speech synthesis unavailable')
