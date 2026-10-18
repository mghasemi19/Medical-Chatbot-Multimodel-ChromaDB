// Short helper for finding elements by their HTML id.
const $ = (id) => document.getElementById(id);

// Browser-side conversation and media state.
let history = [];
let imageData = null;
let recorder = null;
let audioChunks = [];
let cameraStream = null;
let lastAnswer = "";

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
  const element = document.createElement("article");
  element.className = kind;
  element.textContent = text;

  if (sources.length) {
    const sourceList = document.createElement("div");
    sourceList.className = "sources";
    sourceList.textContent =
      "Sources: " +
      sources
        .slice(0, 8)
        .map((source) =>
          source.type === "pdf" ? `PDF page ${source.page}` : source.url,
        )
        .join(" | ");
    element.appendChild(sourceList);
  }

  $("messages").appendChild(element);
  $("messages").scrollTop = $("messages").scrollHeight;
  return element;
}

// Check whether the backend and required API configuration are available.
async function check() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    $("status").textContent = data.configured
      ? "● Connected"
      : "⚠ Configure API keys";
  } catch {
    $("status").textContent = "● Server offline";
  }
}

check();

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
    lastAnswer = data.answer;

    // Show the PDF pages or web URLs returned by the backend.
    if (data.sources?.length) {
      const sourceList = document.createElement("div");
      sourceList.className = "sources";
      sourceList.textContent =
        "Sources: " +
        data.sources
          .slice(0, 8)
          .map((source) =>
            source.type === "pdf" ? `PDF page ${source.page}` : source.url,
          )
          .join(" | ");
      pendingMessage.appendChild(sourceList);
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

// Read the latest answer aloud using the browser's built-in speech engine.
// This avoids requiring the configured model API to support a separate TTS endpoint.
$("listen").onclick = () => {
  if (!lastAnswer) return alert("Ask a question first");
  if (!("speechSynthesis" in window)) {
    return alert("Read aloud is not supported by this browser");
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(lastAnswer);
  utterance.lang = document.documentElement.lang || navigator.language || "en";
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
