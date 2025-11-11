// content.js - Injected into every page to add speech-to-text functionality

// =====================================================================
// API key is stored by the popup UI using chrome.storage (sync preferred).
// The content script reads it at runtime so you don't need to hardcode keys here.
const OPENAI_API_URL = "https://api.openai.com/v1/audio/transcriptions";

// Helper to read stored API key (returns null if not set)
function getStoredApiKey() {
  return new Promise((resolve) => {
    try {
      const storage =
        chrome && chrome.storage && chrome.storage.sync
          ? chrome.storage.sync
          : chrome.storage.local;
      storage.get(["openai_api_key"], (items) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          console.warn("chrome.storage get error", chrome.runtime.lastError);
        }
        resolve(items && items.openai_api_key ? items.openai_api_key : null);
      });
    } catch (e) {
      console.warn("getStoredApiKey fallback error", e);
      resolve(null);
    }
  });
}
// =====================================================================

// Global state for recording process
const state = {
  isRecording: false,
  mediaRecorder: null,
  audioChunks: [],
  currentInput: null, // The currently targeted input/textarea/contenteditable element
};

// Global state for UI elements managed outside the DOM flow (appended to body)
const uiState = {
  micButton: null, // The actively displayed mic button element
  blurTimeout: null, // Timeout for removing the button on blur
};

const MIC_BUTTON_DIAMETER = 44;
const MIC_BUTTON_GAP = 12;

// --- CSS Styles for Dynamic Overlay (Appended to body) ---
const styleId = "mic-button-style-v2";
if (!document.getElementById(styleId)) {
  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `
    .speech-mic-button {
      position: absolute !important;
      width: ${MIC_BUTTON_DIAMETER}px;
      height: ${MIC_BUTTON_DIAMETER}px;
      cursor: pointer;
      background: transparent;
      border: none;
      padding: 0;
      z-index: 99999;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s ease, opacity 0.2s ease;
    }

    .speech-mic-button:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px rgba(147, 197, 253, 0.8);
      border-radius: 50%;
    }

    .speech-mic-dot {
      width: 14px;
      height: 14px;
      border-radius: 999px;
      background: radial-gradient(circle at 30% 30%, #ffffff 0%, #3b82f6 45%, #1d4ed8 100%);
      box-shadow: 0 0 10px rgba(59, 130, 246, 0.75);
      transition: transform 0.25s ease, opacity 0.25s ease;
    }

    .speech-mic-control {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 50px;
      height: 50px;
      border-radius: 20px;
      background: #ffffff;
      border: 1px solid rgba(59, 130, 246, 0.25);
      box-shadow: 0 10px 20px rgba(59, 130, 246, 0.18);
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transform: translate(-50%, -50%) scale(0.75);
      transition: opacity 0.25s ease, transform 0.25s ease, box-shadow 0.25s ease, border 0.25s ease, background 0.25s ease;
    }

    .speech-mic-button:hover .speech-mic-control,
    .speech-mic-button.is-recording .speech-mic-control,
    .speech-mic-button.is-processing .speech-mic-control {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }

    .speech-mic-button:hover .speech-mic-dot,
    .speech-mic-button.is-recording .speech-mic-dot,
    .speech-mic-button.is-processing .speech-mic-dot {
      opacity: 0;
      transform: scale(0.4);
    }

    .mic-icon {
      width: 26px;
      height: 26px;
      padding-top: 2px;
      fill: #3b82f6;
      transition: fill 0.25s ease, transform 0.25s ease, opacity 0.2s ease;
    }

    .speech-mic-button:hover .mic-icon {
      transform: translateY(-1px);
    }

    .speech-mic-button.is-recording .speech-mic-control {
      background: #fff5f5;
      border-color: rgba(248, 113, 113, 0.45);
      box-shadow: 0 10px 20px rgba(248, 113, 113, 0.35);
    }

    .speech-mic-button.is-recording .mic-icon {
      fill: #ef4444;
      animation: pulse-mic 1.2s ease-in-out infinite;
    }

 

    .speech-mic-button.is-processing .mic-icon {
      opacity: 0;
    }

    .mic-loader {
      position: absolute;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      border: 2px solid rgba(59, 130, 246, 0.35);
      border-top-color: #3b82f6;
      transform: translate(-50%, -50%);
      opacity: 0;
      transition: opacity 0.2s ease;
    }

    .speech-mic-button.is-processing .mic-loader {
      opacity: 1;
      animation: spin-loader 1s linear infinite;
    }

    @keyframes pulse-mic {
      0% { transform: scale(1); }
      50% { transform: scale(1.12); }
      100% { transform: scale(1); }
    }

    @keyframes spin-loader {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    `;
  document.head.appendChild(style);
}

// --- Utility Functions ---

/**
 * Checks if a given element is a valid, visible, and editable text input, textarea, or contenteditable.
 * @param {HTMLElement} element The element to check.
 * @returns {boolean} True if the element should have a mic button.
 */
function isValidInput(element) {
  const tag = element.tagName;
  const type = element.type;

  // 1. Standard text-based inputs and textareas
  const isStandardText =
    (tag === "INPUT" &&
      (type === "text" ||
        type === "search" ||
        type === "email" ||
        type === "url" ||
        type === "tel" ||
        type === "password")) ||
    tag === "TEXTAREA";

  // 2. Rich Text Editors (contenteditable attribute set to true)
  const isRichText = element.isContentEditable;

  // Check if the element is visible and not disabled/readonly
  const isVisibleAndEditable =
    element.offsetParent !== null && !element.disabled && !element.readOnly;

  return (isStandardText || isRichText) && isVisibleAndEditable;
}

/**
 * Gets the screen position of the input field.
 * @param {HTMLElement} input The input element.
 * @returns {object} Position object with absolute coordinates.
 */
function getPosition(input) {
  const rect = input.getBoundingClientRect();
  return {
    top: rect.top + window.scrollY,
    left: rect.left + window.scrollX,
    right: rect.right + window.scrollX,
    height: rect.height,
    width: rect.width,
  };
}

/**
 * Creates and displays a temporary feedback message near the input.
 * The element is appended to the body and positioned absolutely.
 * @param {HTMLElement} input The input element.
 * @param {string} message The message to display.
 * @param {number} duration The duration in milliseconds.
 */
function showFeedback(input, message, duration = 3000) {
  // Lightweight no-DOM notifier: log and optionally set the mic button title briefly
  try {
    console.debug("STT feedback:", message);
    if (uiState.micButton) {
      // Preserve previous title and restore after duration
      const prev =
        uiState.micButton.getAttribute("data-prev-title") ||
        uiState.micButton.title ||
        "";
      uiState.micButton.setAttribute("data-prev-title", prev);
      uiState.micButton.title = message;
      clearTimeout(uiState._feedbackTimer);
      uiState._feedbackTimer = setTimeout(() => {
        if (uiState.micButton) {
          const restore =
            uiState.micButton.getAttribute("data-prev-title") ||
            "Speech to Text (OpenAI Whisper)";
          uiState.micButton.title = restore;
        }
      }, duration);
    }
  } catch (e) {
    console.debug("showFeedback error", e);
  }
}

// --- Modal shown when API key is missing ---
function createKeyMissingModal() {
  const existing = document.getElementById("stt-key-modal");
  if (existing) {
    const shakeTarget = existing.__modalElements?.modalBox;
    if (shakeTarget) {
      shakeTarget.classList.remove("stt-modal-shake");
      // Trigger reflow to restart animation
      void shakeTarget.offsetWidth;
      shakeTarget.classList.add("stt-modal-shake");
    }
    existing.focus({ preventScroll: true });
    return;
  }

  const host = document.createElement("div");
  host.id = "stt-key-modal";
  host.tabIndex = -1;
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.zIndex = "2147483647";
  host.style.display = "flex";
  host.style.alignItems = "flex-start";
  host.style.justifyContent = "center";
  host.style.padding = "24px 16px";
  host.style.background = "rgba(15, 23, 42, 0.45)";
  host.style.backdropFilter = "blur(8px)";
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "true");
  host.setAttribute("aria-labelledby", "stt-modal-title");

  const shadow = host.attachShadow({ mode: "open" });

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("output.css");
  shadow.append(link);

  const localStyle = document.createElement("style");
  localStyle.textContent = `
    :host {
      font-family: var(--font-sans, 'Segoe UI', system-ui, sans-serif);
    }
    @keyframes stt-fade-in {
      from {
        opacity: 0;
        transform: translateY(-8px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    @keyframes stt-shake {
      0%, 100% {
        transform: translateX(0);
      }
      20%, 60% {
        transform: translateX(-6px);
      }
      40%, 80% {
        transform: translateX(6px);
      }
    }
    .stt-modal-animate {
      animation: stt-fade-in 220ms ease-out;
    }
    .stt-modal-shake {
      animation: stt-shake 360ms ease;
    }
    .step-list li::marker {
      color: var(--color-primary);
    }
  `;
  shadow.append(localStyle);

  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-theme", "garden");
  wrapper.className = "modal modal-open";
  wrapper.style.color = "var(--color-base-content)";
  wrapper.innerHTML = `
    <div class="modal-box stt-modal-animate max-w-lg bg-base-100 shadow-2xl space-y-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2 id="stt-modal-title" class="text-xl font-semibold ">API key required</h2>
          <p class="text-sm opacity-80 mt-1">Whisker needs your OpenAI API key before it can transcribe audio.</p>
        </div>
        <button class="btn btn-sm btn-circle btn-ghost" data-close-modal aria-label="Close modal">✕</button>
      </div>
      <div class="alert alert-soft alert-warning">
        <span class="font-medium">Heads up:</span>
        Keys stay on-device and are never shared with page scripts.
      </div>
      <ol class="step-list list-decimal space-y-2 pl-4 text-sm leading-relaxed">
        <li>Click the Whisker icon or open it from your extensions menu.</li>
        <li>Paste your OpenAI API key into the <span class="badge badge-outline badge-primary">OpenAI API Key</span> field.</li>
        <li>Press <span class="kbd kbd-sm">Save key</span> and try recording again.</li>
      </ol>
      <div class="card bg-base-200 shadow-sm">
        <div class="card-body gap-2 p-4 text-sm opacity-80">
          <div class="flex items-center gap-2">
            <span class="status status-success status-sm"></span>
            <span>Stored securely inside your browser's extension storage.</span>
          </div>
        </div>
      </div>
      <div class="modal-action flex flex-wrap gap-2 justify-end pt-2">
        <button class="btn btn-primary" id="stt-modal-open-popup" type="button">Open setup</button>
        <button class="btn btn-ghost" data-close-modal type="button">Close</button>
      </div>
    </div>
    <div class="modal-backdrop" data-close-modal></div>
  `;
  shadow.append(wrapper);

  const modalBox = wrapper.querySelector(".modal-box");
  host.__modalElements = {
    wrapper,
    modalBox,
  };

  const closeModal = () => {
    removeKeyMissingModal();
  };

  shadow.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", closeModal);
  });

  const openSetup = shadow.getElementById("stt-modal-open-popup");
  if (openSetup) {
    openSetup.addEventListener("click", () => {
      try {
        const popupUrl = chrome.runtime.getURL("popup.html");
        window.open(popupUrl, "_blank", "noopener");
      } catch (error) {
        console.debug("Whisker: unable to open popup", error);
      }
      removeKeyMissingModal();
    });
  }

  const escHandler = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      removeKeyMissingModal();
    }
  };

  host.addEventListener("keydown", escHandler);
  host.__escHandler = escHandler;

  document.documentElement.appendChild(host);

  requestAnimationFrame(() => {
    const focusTarget = shadow.getElementById("stt-modal-open-popup");
    (focusTarget || host).focus({ preventScroll: true });
  });
}

function removeKeyMissingModal() {
  const host = document.getElementById("stt-key-modal");
  if (!host) return;

  if (typeof host.__escHandler === "function") {
    host.removeEventListener("keydown", host.__escHandler);
    delete host.__escHandler;
  }

  if (host.__modalElements) {
    delete host.__modalElements;
  }

  host.remove();
}

/**
 * Sends the audio data to the OpenAI Whisper API for transcription.
 * @param {Blob} audioBlob The recorded audio data blob.
 * @param {HTMLElement} input The target input element.
 * @param {HTMLElement} micButton The mic button element for state management.
 */
async function transcribeAudio(audioBlob, input, micButton) {
  // Read stored API key (from popup)
  const storedKey = await getStoredApiKey();
  if (!storedKey) {
    // Show modal instructing user to add the key
    createKeyMissingModal();
    micButton.classList.remove("is-processing");
    return;
  }

  // Set button to processing state
  micButton.classList.remove("is-recording");
  micButton.classList.add("is-processing");

  showFeedback(input, "Processing audio...", 60000); // Long duration for loading

  // Create a File object from the Blob
  const audioFile = new File([audioBlob], "audio.webm", { type: "audio/webm" });

  // Construct FormData for the API
  const formData = new FormData();
  formData.append("file", audioFile);
  formData.append("model", "whisper-1");
  formData.append("response_format", "text");

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${storedKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const transcription = await response.text();
    const transcribedText = transcription.trim();

    // Insert transcribed text into the focused field
    if (input.isContentEditable) {
      // For contenteditable, insert at cursor position if possible
      document.execCommand(
        "insertText",
        false,
        (input.textContent.trim() ? " " : "") + transcribedText
      );
    } else {
      // For standard inputs/textareas, append to value
      input.value = (input.value ? input.value + " " : "") + transcribedText;
    }

    input.focus(); // Re-focus to keep the button visible
    showFeedback(input, "Transcription complete!", 2000);
  } catch (error) {
    console.error("Transcription failed:", error);
    showFeedback(
      input,
      "Transcription failed. Check console for details.",
      5000
    );
  } finally {
    micButton.classList.remove("is-recording");
    micButton.classList.remove("is-processing");
    // Set short feedback for ready state
    showFeedback(input, "Ready to record.", 2000);
    if (document.activeElement !== input) {
      removeMicButton();
    }
  }
}

/**
 * Toggles the recording state (start/stop) for a specific input field.
 */
async function toggleRecording(input, micButton) {
  if (micButton.classList.contains("is-processing")) {
    showFeedback(input, "Processing audio...", 2000);
    return;
  }

  if (state.isRecording && state.currentInput === input) {
    // --- STOP RECORDING ---
    micButton.classList.remove("is-recording");
    state.isRecording = false;
    // state.currentInput = null; // <-- REMOVED THIS LINE. State is cleaned up in removeMicButton()

    if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
      state.mediaRecorder.stop();
      showFeedback(input, "Recording stopped. Sending to API...");
    } else {
      showFeedback(input, "Error: Recorder not active.", 3000);
    }
  } else if (!state.isRecording) {
    // --- START RECORDING ---
    // Ensure an API key is configured before requesting microphone access
    try {
      const storedKey = await getStoredApiKey();
      if (!storedKey) {
        // Show a dismissible modal with instructions instead of the small feedback tooltip
        createKeyMissingModal();
        // Ensure button is not stuck in any recording/processing state
        micButton.classList.remove("is-recording");
        micButton.classList.remove("is-processing");
        state.isRecording = false;
        state.currentInput = null;
        return;
      }

      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Initialize MediaRecorder
      state.mediaRecorder = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus",
      });
      state.audioChunks = [];

      state.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          state.audioChunks.push(event.data);
        }
      };

      state.mediaRecorder.onstop = () => {
        const audioBlob = new Blob(state.audioChunks, { type: "audio/webm" });

        // Stop the mic stream tracks to release the mic light
        stream.getTracks().forEach((track) => track.stop());

        transcribeAudio(audioBlob, input, micButton);
      };

      state.mediaRecorder.start();

      // Update state and UI
      state.isRecording = true;
      state.currentInput = input;
      micButton.classList.remove("is-processing");
      micButton.classList.add("is-recording");
      showFeedback(input, "Recording... Click to stop.", 60000); // Long duration message
    } catch (error) {
      console.error("Error accessing microphone:", error);
      showFeedback(
        input,
        "Microphone access denied or error: " + error.name,
        5000
      );
      micButton.classList.remove("is-recording");
      state.isRecording = false;
      state.currentInput = null;
    }
  } else {
    // A different input is recording
    showFeedback(input, "Another recording is in progress.", 3000);
  }
}

/**
 * Creates the mic button element with SVG icon.
 * @returns {HTMLElement} The mic button element.
 */
function createMicButton() {
  const micButton = document.createElement("button");
  micButton.className = "speech-mic-button";
  // micButton.setAttribute("title", "Speech to Text (OpenAI Whisper)");
  micButton.type = "button"; // Prevent form submission

  // Inline SVG for the mic icon (modern and minimal)
  micButton.innerHTML = `
    <span class="speech-mic-dot"></span>
    <span class="speech-mic-control">
      <svg class="mic-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
<path d="M8.01274 11.5354C8.28867 13.3882 9.69144 14.8306 11.4618 15.0818L11.5732 15.0976C11.8593 15.1382 12.1492 15.1382 12.4353 15.0976L12.5318 15.0839C14.3104 14.8315 15.719 13.381 15.9934 11.5191C16.2329 9.89423 16.2328 8.23912 15.9932 6.61428C15.7189 4.75331 14.3126 3.30082 12.5353 3.04484L12.4417 3.03136C12.1514 2.98955 11.8571 2.98955 11.5668 3.03136L11.4583 3.04699C9.68928 3.30177 8.28872 4.74606 8.01293 6.59791C7.76936 8.2334 7.76917 9.89995 8.01274 11.5354Z" />
<path d="M5.95161 11.0953C5.95161 10.6745 5.62666 10.3334 5.22581 10.3334C4.82495 10.3334 4.5 10.6745 4.5 11.0953C4.5 15.1864 7.47261 18.5487 11.2742 18.9319V20.2381C11.2742 20.6589 11.5991 21 12 21C12.4009 21 12.7258 20.6589 12.7258 20.2381V18.9319C16.5274 18.5487 19.5 15.1864 19.5 11.0953C19.5 10.6745 19.175 10.3334 18.7742 10.3334C18.3733 10.3334 18.0484 10.6745 18.0484 11.0953C18.0484 14.6018 15.3404 17.4445 12 17.4445C8.65957 17.4445 5.95161 14.6018 5.95161 11.0953Z" />
</svg><span class="mic-loader"></span>
    </span>
  `;
  return micButton;
}

/**
 * Creates the mic button overlay and positions it over the focused input.
 * @param {HTMLElement} input The focused input element.
 */
function injectMicButton(input) {
  // If a button is already displayed, remove it first
  if (uiState.micButton) {
    removeMicButton(state.currentInput);
  }

  // 1. Create the button, assign a unique ID for referencing, and append to body
  const micButton = createMicButton();
  uiState.micButton = micButton;

  // Assign a temporary ID to the input element if it doesn't have one, for reference
  input.id =
    input.id || `stt-input-${Math.random().toString(36).substring(2, 9)}`;
  micButton.dataset.targetInputId = input.id;
  state.currentInput = input;

  document.body.appendChild(micButton);

  // 2. Position the button relative to the input
  const position = getPosition(input);

  const buttonLeft = position.left - (MIC_BUTTON_DIAMETER + MIC_BUTTON_GAP);

  micButton.style.top = `${position.top + position.height / 2}px`;
  micButton.style.left = `${buttonLeft}px`;
  micButton.style.transform = "translateY(-50%)";

  // 3. Attach event handlers
  micButton.addEventListener("mousedown", (e) => {
    // CRITICAL: Prevent mousedown from stealing focus from the input.
    // This stops the 'focusout' event from firing on the input,
    // which was causing the button to disappear.
    e.preventDefault();
  });

  micButton.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleRecording(input, micButton);
  });
}

/**
 * Removes the mic button and feedback element from the DOM.
 * Only call this when not recording.
 */
function removeMicButton() {
  if (
    uiState.micButton &&
    !state.isRecording &&
    !uiState.micButton.classList.contains("is-processing")
  ) {
    uiState.micButton.remove();
    uiState.micButton = null;
    state.currentInput = null;
  }
}

// --- Event Handlers for Focus/Blur ---

function handleFocus(event) {
  const input = event.target;

  if (!isValidInput(input)) {
    return;
  }

  // Clear any pending blur removal timeout
  clearTimeout(uiState.blurTimeout);

  // If we're already recording into this input, do nothing
  if (state.isRecording && state.currentInput === input) {
    return;
  }

  // If a button is already displayed for a different input, remove it
  if (
    uiState.micButton &&
    uiState.micButton.dataset.targetInputId !== input.id
  ) {
    removeMicButton();
  }

  // Inject the button
  injectMicButton(input);

  // Re-position the button on scroll/resize (critical for absolute positioning)
  window.addEventListener("scroll", updateMicButtonPosition);
  window.addEventListener("resize", updateMicButtonPosition);
}

function handleBlur(event) {
  const input = event.target;

  // Set a timeout to allow the user to click the button before it disappears
  uiState.blurTimeout = setTimeout(() => {
    removeMicButton();
  }, 150); // Small delay to allow button click

  // Remove positioning listeners on blur
  window.removeEventListener("scroll", updateMicButtonPosition);
  window.removeEventListener("resize", updateMicButtonPosition);
}

/**
 * Updates the position of the active mic button and feedback element on scroll or resize.
 */
function updateMicButtonPosition() {
  if (!uiState.micButton || !state.currentInput) return;

  const input = state.currentInput;
  const position = getPosition(input);

  // Update button position
  const buttonLeft = position.left - (MIC_BUTTON_DIAMETER + MIC_BUTTON_GAP);
  uiState.micButton.style.top = `${position.top + position.height / 2}px`;
  uiState.micButton.style.left = `${buttonLeft}px`;

  // Update feedback position if visible
  // Feedback element removed — no DOM tooltip to update.
}

/**
 * Initializes listeners on the entire document body for focus/blur events.
 */
function initializeInputListeners() {
  document.body.addEventListener("focusin", handleFocus);
  document.body.addEventListener("focusout", handleBlur);
}

// --- Main Execution ---

// Start listening for focus events on all elements
initializeInputListeners();
