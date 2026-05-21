/**
 * Lucide icons (CDN). Use data-lucide="icon-name" in HTML or iconHtml() for templates.
 * @see https://lucide.dev/icons/
 */
(function () {
  const DEFAULT_ATTRS = { "stroke-width": 2 };

  function iconHtml(name, className = "", size = 20) {
    const classes = ["icon", className].filter(Boolean).join(" ");
    return `<i data-lucide="${name}" class="${classes}" style="width:${size}px;height:${size}px" aria-hidden="true"></i>`;
  }

  function refreshIcons(root) {
    if (typeof lucide === "undefined" || typeof lucide.createIcons !== "function") {
      return;
    }
    const opts = { attrs: DEFAULT_ATTRS };
    if (root && root !== document && root.querySelectorAll) {
      opts.root = root;
    }
    lucide.createIcons(opts);
  }

  function initIcons() {
    const run = () => refreshIcons(document);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run);
    } else {
      run();
    }
  }

  window.HomiesIcons = { iconHtml, refreshIcons, initIcons };
})();
