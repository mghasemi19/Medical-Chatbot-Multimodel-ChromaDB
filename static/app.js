// Short helper for finding elements by their HTML id.
const $ = (id) => document.getElementById(id);

// Browser-side conversation and media state.
let history = [];
let imageData = null;
let recorder = null;
let audioChunks = [];
let cameraStream = null;
let lastAnswer = "";
let currentUtterance = null;
let speechRequestId = 0;

// Add the optional API token to requests that call protected endpoints.
const headers = () => {
  const requestHeaders = {};
  const token = $("token").value.trim();

  if (token) {
    requestHeaders.Authorization = `Bearer ${token}`;
  }

  return requestHeaders;
};

// Add a message to the conversation and scroll it into view.
function bubble(text, kind = "bot", sources = []) {
  const isUser = kind === "user";
  const row = document.createElement("div");
  row.className = `chat-message-row ${isUser ? "user-row" : "assistant-row"}`;

  const avatar = document.createElement("div");
  avatar.className = `avatar ${isUser ? "user-avatar" : "bot-avatar"}`;
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = isUser ? "●" : "🤖";

  const element = document.createElement("article");
  element.className = "message-card";
  const messageText = document.createElement("div");
  messageText.className = "message-text";
  messageText.textContent = text;
  element.appendChild(messageText);

  if (sources.length) {
    const sourceList = document.createElement("div");
    sourceList.className = "sources";
    const label = document.createElement("strong");
    label.className = "sources-label";
    label.textContent = "Sources";
    sourceList.appendChild(label);

    sources.slice(0, 8).forEach((source, index) => {
      if (source.type === "pdf") {
        const badge = document.createElement("span");
        badge.textContent = `Knowledge base · page ${source.page}`;
        sourceList.appendChild(badge);
        return;
      }

      try {
        const url = new URL(source.url);
        if (!["https:", "http:"].includes(url.protocol)) return;
        const link = document.createElement("a");
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = source.title || `Web source ${index + 1}`;
        sourceList.appendChild(link);
      } catch {
        // Ignore malformed URLs rather than rendering an unsafe source link.
      }
    });

    element.appendChild(sourceList);
  }

  const time = document.createElement("time");
  time.className = "message-time";
  time.dateTime = new Date().toISOString();
  time.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  row.append(avatar, element, time);
  $("messages").appendChild(row);
  $("messages").scrollTop = $("messages").scrollHeight;
  return element;
}

// Check whether the backend and required API configuration are available.
async function check() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    $("status").innerHTML = data.configured
      ? '<span class="status-dot"></span> Connected'
      : '<span class="status-dot status-warning"></span> Configure API keys';
    $("status").classList.toggle("connected", Boolean(data.configured));
    $("status").classList.toggle("disconnected", !data.configured);
  } catch {
    $("status").innerHTML = '<span class="status-dot status-offline"></span> Server offline';
    $("status").classList.add("disconnected");
  }
}

check();

// Fill the question box from the suggested topics and keep its character count current.
document.querySelector(".suggestion-list").addEventListener("click", (event) => {
  const chip = event.target.closest(".prompt-chip");
  if (!chip) return;
  const prompts = {
    "Explain a symptom": "Can you explain what might cause this symptom: ",
    "Interpret test results": "Can you help me understand these test results? ",
    "Medication questions": "I have a question about this medication: ",
    "General health information": "I would like evidence-based information about: ",
  };
  $("message").value = prompts[chip.textContent] || "";
  $("message").focus();
  updateCharacterCount();
});

$("dismissNotice").addEventListener("click", () => {
  $("notice").hidden = true;
});

function updateCharacterCount() {
  $("charCount").textContent = `${$("message").value.length}/4000`;
}

$("message").addEventListener("input", updateCharacterCount);

// Give the static welcome messages a local display time, matching new conversation messages.
document.querySelectorAll(".welcome-time, .intro-time").forEach((time) => {
  const now = new Date();
  time.dateTime = now.toISOString();
  time.textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
});

// Read a selected image as a data URL for the chat request.
function setImage(file) {
  if (!file) return;

  const supportedTypes = ["image/png", "image/jpeg", "image/webp"];
  if (!supportedTypes.includes(file.type) || file.size > 5e6) {
    alert("Use PNG/JPEG/WebP under 5MB");
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    imageData = reader.result;
    $("thumbnail").src = imageData;
    $("preview").hidden = false;
  };
  reader.readAsDataURL(file);
}

// Image picker and remove-preview actions.
$("image").addEventListener("change", (event) => {
  setImage(event.target.files[0]);
});

$("remove").onclick = () => {
  imageData = null;
  $("preview").hidden = true;
  $("image").value = "";
};

// Send the question, recent conversation, and optional image to FastAPI.
$("chatForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  const message = $("message").value.trim();
  if (!message) return;

  const priorMessages = history.slice(-8);
  bubble(message, "user");
  $("message").value = "";
  $("send").disabled = true;
  const pendingMessage = bubble("Thinking…");

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        ...headers(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        history: priorMessages,
        image_data: imageData,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || "Request failed");
    }

    pendingMessage.textContent = data.answer;
    stopReadAloud();
    lastAnswer = data.answer;

    // Attach the PDF and web citations returned by the backend to this answer.
    if (data.sources?.length) {
      const replacement = bubble(data.answer, "bot", data.sources);
      pendingMessage.parentElement.replaceWith(replacement.parentElement);
    }

    history.push(
      { role: "user", content: message },
      { role: "assistant", content: data.answer },
    );

    // Clear the selected image after it has been sent successfully.
    $("remove").click();
  } catch (error) {
    pendingMessage.textContent = `Error: ${error.message}`;
  } finally {
    $("send").disabled = false;
    $("messages").scrollTop = $("messages").scrollHeight;
  }
});

// Record microphone audio and send it to the transcription endpoint.
// Convert the browser's recording (usually WebM/Opus) to standard PCM WAV.
// The configured transcription provider accepts WAV reliably, while some
// compatible providers cannot parse WebM's duration metadata.
async function convertRecordingToWav(recording) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("This browser cannot convert microphone audio for transcription.");
  }

  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    const targetRate = 16000;
    const sourceRate = decoded.sampleRate;
    const outputLength = Math.ceil(decoded.length * targetRate / sourceRate);
    const wavBuffer = new ArrayBuffer(44 + outputLength * 2);
    const view = new DataView(wavBuffer);
    const writeText = (offset, value) => {
      for (let index = 0; index < value.length; index++) {
        view.setUint8(offset + index, value.charCodeAt(index));
      }
    };

    // Write a mono, 16-bit PCM WAV header at 16 kHz.
    writeText(0, "RIFF");
    view.setUint32(4, 36 + outputLength * 2, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, outputLength * 2, true);

    // Mix channels to mono and resample to keep uploads compact.
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, channel) =>
      decoded.getChannelData(channel),
    );
    for (let index = 0; index < outputLength; index++) {
      const sourceIndex = Math.min(Math.floor(index * sourceRate / targetRate), decoded.length - 1);
      const monoSample = channels.reduce((sum, channel) => sum + channel[sourceIndex], 0) / channels.length;
      const sample = Math.max(-1, Math.min(1, monoSample));
      view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }

    return new Blob([wavBuffer], { type: "audio/wav" });
  } finally {
    await context.close();
  }
}

$("mic").onclick = async () => {
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    $("mic").textContent = "🎤 Voice";
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];

    // Prefer a supported browser format and send its real MIME type/extension.
    const recordingType = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
    ].find((type) => MediaRecorder.isTypeSupported(type));
    recorder = recordingType
      ? new MediaRecorder(stream, { mimeType: recordingType })
      : new MediaRecorder(stream);
    recorder.ondataavailable = (event) => audioChunks.push(event.data);

    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      $("mic").disabled = true;

      try {
        const recording = new Blob(audioChunks, { type: recorder.mimeType || "audio/webm" });
        const audioBlob = await convertRecordingToWav(recording);
        const formData = new FormData();
        formData.append("file", audioBlob, "voice.wav");
        const response = await fetch("/api/transcribe", {
          method: "POST",
          headers: headers(),
          body: formData,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail);
        $("message").value = data.text;
      } catch (error) {
        alert(error.message);
      } finally {
        $("mic").disabled = false;
      }
    };

    recorder.start();
    $("mic").textContent = "⏹ Stop recording";
  } catch (error) {
    alert(`Microphone unavailable: ${error.message}`);
  }
};

// Keep the read-aloud control in sync with the browser's speech engine.
function setReadAloudButton(speaking) {
  $("listenLabel").textContent = speaking ? "Stop reading" : "Read answer";
  $("listenIcon").textContent = speaking ? "■" : "◖))";
  $("listen").setAttribute("aria-label", speaking ? "Stop reading aloud" : "Read answer aloud");
  $("listen").setAttribute("aria-pressed", String(speaking));
}

// Cancel any current or queued utterance immediately and reset the button.
function stopReadAloud() {
  speechRequestId++;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  currentUtterance = null;
  setReadAloudButton(false);
}

// Read the latest answer aloud; clicking again stops speech immediately.
// This uses the browser's speech engine, so it does not require a separate TTS API call.
$("listen").onclick = () => {
  if (!lastAnswer) return alert("Ask a question first");
  if (!("speechSynthesis" in window)) {
    return alert("Read aloud is not supported by this browser");
  }

  if (window.speechSynthesis.speaking || window.speechSynthesis.pending || currentUtterance) {
    stopReadAloud();
    return;
  }

  const requestId = ++speechRequestId;
  const utterance = new SpeechSynthesisUtterance(lastAnswer);
  currentUtterance = utterance;
  utterance.lang = document.documentElement.lang || navigator.language || "en";
  utterance.onstart = () => {
    if (requestId === speechRequestId) setReadAloudButton(true);
  };
  const finishUtterance = () => {
    if (requestId === speechRequestId) {
      currentUtterance = null;
      setReadAloudButton(false);
    }
  };
  utterance.onend = finishUtterance;
  utterance.onerror = finishUtterance;
  window.speechSynthesis.speak(utterance);
};

// Start the device camera and show its preview.
$("camera").onclick = async () => {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    $("video").srcObject = cameraStream;
    $("video").hidden = false;
    $("cameraActions").hidden = false;
  } catch (error) {
    alert(`Camera unavailable: ${error.message}`);
  }
};

// Stop the camera tracks and hide its controls.
$("closeCamera").onclick = () => {
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  $("video").hidden = true;
  $("cameraActions").hidden = true;
};

// Capture a frame from the camera, convert it to a JPEG, and use the image preview flow.
$("snap").onclick = () => {
  const video = $("video");
  const canvas = $("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);

  canvas.toBlob(
    (blob) => setImage(new File([blob], "camera.jpg", { type: "image/jpeg" })),
    "image/jpeg",
    0.85,
  );
  $("closeCamera").click();
};
