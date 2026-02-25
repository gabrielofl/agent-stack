// src/panel/panel.ui.js
import { EXT_CONFIG } from "../config.js";
import { createAuthUI } from "../auth/auth.ui.js";

export function createPanelUI(els) {
  function setStatusTitle(msg) {
    els.statusTitleEl.textContent = msg || "—";
  }

  function setStatus(msg) {
    els.statusEl.textContent = msg || "";
  }

  function getSelectedTypes() {
    return Array.from(els.typesEl.selectedOptions).map((o) => o.value);
  }

  function setSelectedTypes(types) {
    const allowed = new Set(types || []);
    for (const opt of Array.from(els.typesEl.options)) {
      opt.selected = allowed.has(opt.value);
    }
  }

  function initDefaultsFromConfig() {
    const cfg = EXT_CONFIG || {};

    els.selectorEl.value = cfg.site?.imageSelector || "img";
    els.nextSelectorEl.value = cfg.site?.nextSelector || "";

    els.maxPagesEl.value = String(cfg.site?.maxPages ?? 1);
    els.pageWaitMsEl.value = String(cfg.site?.pageWaitMs ?? 2500);

    els.minWidthEl.value = String(cfg.filters?.minWidth ?? 64);
    els.minHeightEl.value = String(cfg.filters?.minHeight ?? 64);
    els.minKbEl.value = String(Math.round((cfg.filters?.minBytes ?? 10 * 1024) / 1024));

    setSelectedTypes(cfg.filters?.allowedTypes || ["image/jpeg", "image/png", "image/webp"]);

    els.parentFolderIdEl.value = cfg.google?.parentFolderId || "";
  }

  function readOptionsFromUI() {
    return {
      selector: els.selectorEl.value.trim() || "img",
      nextSelector: els.nextSelectorEl.value.trim(),
      maxPages: Number(els.maxPagesEl.value || 1),
      pageWaitMs: Number(els.pageWaitMsEl.value || 2500),

      minWidth: Number(els.minWidthEl.value || 64),
      minHeight: Number(els.minHeightEl.value || 64),
      minBytes: Number(els.minKbEl.value || 10) * 1024,
      allowedTypes: getSelectedTypes(),

      parentFolderId: els.parentFolderIdEl.value.trim() || ""
    };
  }

  function clearPreviews() {
    els.previewListEl.innerHTML = "";
  }

  function makeImgBlock(label, src) {
    const wrap = document.createElement("div");
    wrap.className = "img-wrap";

    const cap = document.createElement("div");
    cap.className = "img-label";
    cap.textContent = label;

    const img = document.createElement("img");
    img.src = src;
    img.alt = label;

    wrap.appendChild(cap);
    wrap.appendChild(img);
    return wrap;
  }

  function renderSideBySide(compareArea, originalSrc, transformedSrc) {
    compareArea.innerHTML = "";

    const grid = document.createElement("div");
    grid.className = "side-by-side";
    grid.appendChild(makeImgBlock("Original", originalSrc));
    grid.appendChild(makeImgBlock("Transformed", transformedSrc));

    compareArea.appendChild(grid);
  }

  function renderSlider(compareArea, originalSrc, transformedSrc) {
    compareArea.innerHTML = "";

    const sliderBox = document.createElement("div");
    sliderBox.className = "slider-box";

    const badgeLeft = document.createElement("div");
    badgeLeft.className = "slider-badge left";
    badgeLeft.textContent = "Original";

    const badgeRight = document.createElement("div");
    badgeRight.className = "slider-badge right";
    badgeRight.textContent = "Transformed";

    const baseImg = document.createElement("img");
    baseImg.src = originalSrc;
    baseImg.alt = "Original";

    const overlay = document.createElement("div");
    overlay.className = "slider-overlay";
    overlay.style.width = "50%";

    const overlayImg = document.createElement("img");
    overlayImg.src = transformedSrc;
    overlayImg.alt = "Transformed";

    overlay.appendChild(overlayImg);

    const divider = document.createElement("div");
    divider.className = "slider-divider";
    divider.style.left = "50%";

    sliderBox.appendChild(baseImg);
    sliderBox.appendChild(overlay);
    sliderBox.appendChild(divider);
    sliderBox.appendChild(badgeLeft);
    sliderBox.appendChild(badgeRight);

    const rangeWrap = document.createElement("div");
    rangeWrap.className = "range-wrap";

    const range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "100";
    range.value = "50";

    range.addEventListener("input", () => {
      const v = Number(range.value);
      overlay.style.width = `${v}%`;
      divider.style.left = `${v}%`;
    });

    rangeWrap.appendChild(range);

    compareArea.appendChild(sliderBox);
    compareArea.appendChild(rangeWrap);
  }

  function renderPreviews(previews = []) {
    for (const p of previews) {
      const card = document.createElement("div");
      card.className = "preview-card";

      const title = document.createElement("div");
      title.className = "preview-title";
      title.textContent = p.fileName || "image";
      card.appendChild(title);

      const sub = document.createElement("div");
      sub.className = "preview-sub";
      sub.textContent = p.sourceUrl || "";
      card.appendChild(sub);

      const transformedSrc = p.transformed?.dataUrl || p.transformed?.url || null;
      const originalSrc = p.originalDataUrl || null;

      if (!originalSrc) {
        const note = document.createElement("div");
        note.className = "note";
        note.textContent = "Original preview unavailable.";
        card.appendChild(note);
        els.previewListEl.appendChild(card);
        continue;
      }

      if (!transformedSrc) {
        card.appendChild(makeImgBlock("Original", originalSrc));

        const note = document.createElement("div");
        note.className = "note";
        note.textContent = "No transformed image returned by backend.";
        card.appendChild(note);

        if (p.driveFileId) {
          const meta = document.createElement("div");
          meta.className = "note";
          meta.textContent = `Drive file ID: ${p.driveFileId}`;
          card.appendChild(meta);
        }

        els.previewListEl.appendChild(card);
        continue;
      }

      const toolbar = document.createElement("div");
      toolbar.className = "compare-toolbar";

      const sideBtn = document.createElement("button");
      sideBtn.textContent = "Side by side";

      const sliderBtn = document.createElement("button");
      sliderBtn.textContent = "Slider";

      toolbar.appendChild(sideBtn);
      toolbar.appendChild(sliderBtn);
      card.appendChild(toolbar);

      const compareArea = document.createElement("div");
      card.appendChild(compareArea);

      const setActive = (mode) => {
        sideBtn.classList.toggle("active", mode === "side");
        sliderBtn.classList.toggle("active", mode === "slider");
      };

      sideBtn.addEventListener("click", () => {
        setActive("side");
        renderSideBySide(compareArea, originalSrc, transformedSrc);
      });

      sliderBtn.addEventListener("click", () => {
        setActive("slider");
        renderSlider(compareArea, originalSrc, transformedSrc);
      });

      setActive("side");
      renderSideBySide(compareArea, originalSrc, transformedSrc);

      if (p.driveFileId) {
        const meta = document.createElement("div");
        meta.className = "note";
        meta.textContent = `Drive file ID: ${p.driveFileId}`;
        card.appendChild(meta);
      }

      els.previewListEl.appendChild(card);
    }
  }

  const auth = createAuthUI(els, {
    setStatusTitle,
    setStatus
  });

  return {
    auth,
    setStatusTitle,
    setStatus,
    initDefaultsFromConfig,
    readOptionsFromUI,
    clearPreviews,
    renderPreviews
  };
}