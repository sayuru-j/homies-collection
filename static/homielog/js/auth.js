const errEl = document.getElementById("error");

function postAuthRedirect() {
  const next = new URLSearchParams(window.location.search).get("next");
  if (next && next.startsWith("/") && !next.startsWith("//")) {
    window.location.href = next;
    return;
  }
  window.location.href = "/chat";
}

function showError(msg) {
  errEl.textContent = msg || "";
}

document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".auth-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`${tab.dataset.tab}-panel`).classList.add("active");
    showError("");
  });
});

async function checkSession() {
  try {
    await api("/api/users/me");
    postAuthRedirect();
  } catch (_) {}
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  const name = document.getElementById("login-name").value.trim();
  const pin = document.getElementById("login-pin").value;
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ name, pin }),
    });
    postAuthRedirect();
  } catch (ex) {
    showError(ex.message);
  }
});

document.getElementById("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  const name = document.getElementById("register-name").value.trim();
  const pin = document.getElementById("register-pin").value;
  const invite_code = document.getElementById("register-invite").value.trim();
  if (!/^\d{6}$/.test(pin)) {
    showError("PIN must be 6 digits");
    return;
  }
  if (!/^\d{4}$/.test(invite_code)) {
    showError("Invite code must be 4 digits");
    return;
  }
  try {
    await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, pin, invite_code }),
    });
    postAuthRedirect();
  } catch (ex) {
    showError(ex.message);
  }
});

checkSession();
