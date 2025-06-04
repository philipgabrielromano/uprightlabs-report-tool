document.addEventListener("DOMContentLoaded", async () => {
  const checkbox = document.getElementById("rememberCheckbox");

  // Load state from server
  const res = await fetch("/api/checkbox-state");
  const data = await res.json();
  checkbox.checked = data.checked;

  // Send state to server on change
  checkbox.addEventListener("change", async () => {
    await fetch("/api/checkbox-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checked: checkbox.checked }),
    });
  });
});
