// popup.js — Manage API key storage and UI interactions
const keyInput = document.getElementById("apiKey");
const saveBtn = document.getElementById("saveBtn");
const clearBtn = document.getElementById("clearBtn");
const status = document.getElementById("status");
const toggleReveal = document.getElementById("toggleReveal");
const showEye = document.getElementById("show-eye");
const closeEye = document.getElementById("close-eye");

function showStatus(msg, timeout = 2500) {
  status.textContent = msg;
  if (timeout) {
    setTimeout(() => {
      status.textContent = "";
    }, timeout);
  }
}

function getStorage() {
  return chrome.storage && chrome.storage.sync
    ? chrome.storage.sync
    : chrome.storage.local;
}

function loadKey() {
  const storage = getStorage();
  storage.get(["openai_api_key"], (items) => {
    if (chrome.runtime.lastError) {
      console.error("Error reading storage", chrome.runtime.lastError);
      showStatus("Error reading storage");
      return;
    }
    if (items && items.openai_api_key) {
      keyInput.value = items.openai_api_key;
    }
  });
}

function saveKey() {
  const val = keyInput.value.trim();
  const storage = getStorage();
  if (!val) {
    showStatus("Enter an API key or use Clear");
    return;
  }
  storage.set({ openai_api_key: val }, () => {
    if (chrome.runtime.lastError) {
      console.error("Error saving key", chrome.runtime.lastError);
      showStatus("Save failed");
      return;
    }
    showStatus("Saved");
  });
}

function clearKey() {
  const storage = getStorage();
  storage.remove(["openai_api_key"], () => {
    if (chrome.runtime.lastError) {
      console.error("Error clearing key", chrome.runtime.lastError);
      showStatus("Clear failed");
      return;
    }
    keyInput.value = "";
    showStatus("Cleared");
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadKey();

  saveBtn.addEventListener("click", (e) => {
    e.preventDefault();
    saveKey();
  });

  clearBtn.addEventListener("click", (e) => {
    e.preventDefault();
    clearKey();
  });

  toggleReveal.addEventListener("click", (e) => {
    e.preventDefault();
    if (keyInput.type === "password") {
      keyInput.type = "text";
      showEye.className = "hidden";
      closeEye.className = "";
    } else {
      keyInput.type = "password";
      showEye.className = "";
      closeEye.className = "hidden";
    }
  });
});
