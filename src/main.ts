import { invoke } from "@tauri-apps/api/core";

document.addEventListener("DOMContentLoaded", async () => {
  const form = document.getElementById("connect-form") as HTMLFormElement;
  const urlInput = document.getElementById("server-url") as HTMLInputElement;
  const connectBtn = document.getElementById("connect-btn") as HTMLButtonElement;
  const statusMsg = document.getElementById("status-msg") as HTMLParagraphElement;

  // Try to load saved server URL
  try {
    const savedUrl = await invoke<string | null>("get_saved_server");
    if (savedUrl) {
      urlInput.value = savedUrl;
      statusMsg.textContent = "Reconnecting...";
      statusMsg.className = "status info";
      await connectToServer(savedUrl);
      return;
    }
  } catch (e) {
    console.log("No saved server:", e);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim().replace(/\/+$/, "");
    if (!url) return;
    await connectToServer(url);
  });

  async function connectToServer(url: string) {
    connectBtn.disabled = true;
    statusMsg.textContent = "Connecting...";
    statusMsg.className = "status info";

    try {
      const result = await invoke<{ name: string; version: string; id: string }>(
        "check_server_connectivity",
        { url }
      );

      statusMsg.textContent = `Connected to ${result.name} (v${result.version})`;
      statusMsg.className = "status success";

      // Save server URL
      await invoke("save_server_url", { url });

      // Navigate to jellyfin-web on the server
      setTimeout(async () => {
        await invoke("navigate_to_server", { url });
      }, 500);
    } catch (err: any) {
      statusMsg.textContent = `Failed: ${err}`;
      statusMsg.className = "status error";
      connectBtn.disabled = false;
    }
  }
});
