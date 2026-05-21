/**
 * Bored menu — pick a feature when you're restless.
 */
(function () {
  const FEATURES = [
    {
      id: "stranger-danger",
      label: "StrangerDanger",
      description: "Neo-brutal live video with strangers",
      href: "/stranger-danger",
      color: "#ef4444",
    },
    { id: "soon-1", label: "Coming soon", description: "More chaos on the way", disabled: true, color: "#3ba55d" },
    { id: "soon-2", label: "Coming soon", description: "More chaos on the way", disabled: true, color: "#faa61a" },
    { id: "soon-3", label: "Coming soon", description: "More chaos on the way", disabled: true, color: "#ed4245" },
  ];

  const modal = document.getElementById("bored-wheel-modal");
  const listEl = document.getElementById("bored-features-list");

  function openBoredMenu() {
    if (!modal) return;
    if (typeof openModal === "function") openModal("bored-wheel-modal");
    else modal.classList.remove("hidden");
    renderFeatures();
    if (typeof HomiesIcons !== "undefined") HomiesIcons.initIcons(modal);
  }

  function renderFeatures() {
    if (!listEl) return;
    listEl.innerHTML = "";

    FEATURES.forEach((feature) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bored-feature-btn";
      if (feature.disabled || !feature.href) {
        btn.classList.add("bored-feature-btn--disabled");
        btn.disabled = true;
      }

      const swatch = document.createElement("span");
      swatch.className = "bored-feature-swatch";
      swatch.style.background = feature.color;
      swatch.setAttribute("aria-hidden", "true");

      const text = document.createElement("span");
      text.className = "bored-feature-text";

      const title = document.createElement("span");
      title.className = "bored-feature-label";
      title.textContent = feature.label;

      const desc = document.createElement("span");
      desc.className = "bored-feature-desc";
      desc.textContent = feature.description || "";

      text.appendChild(title);
      if (feature.description) text.appendChild(desc);

      btn.appendChild(swatch);
      btn.appendChild(text);

      if (feature.href && !feature.disabled) {
        btn.addEventListener("click", () => {
          window.location.href = feature.href;
        });
      }

      listEl.appendChild(btn);
    });
  }

  document.querySelectorAll(".bored-wheel-trigger").forEach((btn) => {
    btn.addEventListener("click", openBoredMenu);
  });

  window.HomiesBoredWheel = { open: openBoredMenu };
})();
