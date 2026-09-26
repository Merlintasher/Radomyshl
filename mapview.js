// 2D-карта маршруту (вигляд зверху), без three.js.
// Малює: фонову сітку -> PDF-підложку -> лінію траєкторії ->
// точки-панорами -> шкалу масштабу, на <canvas>.
//
// Підтримує:
// - панорамування drag;
// - zoom колесом;
// - pinch zoom на телефоні;
// - PDF-підложку;
// - прив'язку PDF двома контрольними точками;
// - мінікарту;
// - активну точку;
// - напрямок погляду.
//
// ЗМІНА: рендер під час drag/pinch/wheel/hover тепер батчиться через
// requestAnimationFrame (_scheduleRender), а не викликається напряму
// на кожну подію pointermove/wheel. На телефоні події можуть прилітати
// частіше за частоту оновлення екрана, і без батчингу виходило по
// кілька повних перемальовувань (включно з важким PDF-фоном) на один
// реальний кадр — це й відчувалося як лаги/гальмування карти.

// ---------------------------------------------------------------------------
// COLORS
// ---------------------------------------------------------------------------

const GRID_COLOR = "rgba(18, 30, 26, 0.07)";
const INK_COLOR = "#16241f";

const LINE_CASING = "rgba(236, 238, 231, 0.9)";
const LINE_COLOR = "#2f4f7a";

const MARKER_COLOR = "#2f4f7a";
const MARKER_COLOR_ACTIVE = "#c1440e";
const MARKER_CASING = "rgba(236, 238, 231, 0.95)";

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function formatDistance(m) {
  if (m >= 1000) {
    return `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)} км`;
  }
  if (m < 1) {
    return `${Math.round(m * 100)} см`;
  }
  return `${m} м`;
}

// ---------------------------------------------------------------------------
// AFFINE TRANSFORMATION
// ---------------------------------------------------------------------------
//
// Перетворення: image coordinates -> world coordinates
//
// Растрові координати мають X -> вправо, Y -> вниз.
// Світові координати: X -> вправо, Y -> вгору.
// Тому при переході image -> world Y інвертується.
//
// Використовуються дві контрольні точки. Це дає масштаб, поворот, зміщення.
// Shear не використовується.
// ---------------------------------------------------------------------------

function computeImageToWorld(cp1, cp2) {
  const p1 = cp1.image;
  const p2 = cp2.image;

  const w1 = cp1.world;
  const w2 = cp2.world;

  // У PDF/зображенні Y росте вниз, у світових координатах Y росте вгору.
  const ix1 = p1.x;
  const iy1 = -p1.y;

  const ix2 = p2.x;
  const iy2 = -p2.y;

  const dxImg = ix2 - ix1;
  const dyImg = iy2 - iy1;

  const dxWorld = w2.x - w1.x;
  const dyWorld = w2.y - w1.y;

  const distImg = Math.hypot(dxImg, dyImg) || 1;
  const distWorld = Math.hypot(dxWorld, dyWorld);

  const scale = distWorld / distImg;

  const angle =
    Math.atan2(dyWorld, dxWorld) - Math.atan2(dyImg, dxImg);

  const a = scale * Math.cos(angle);
  const c = scale * Math.sin(angle);
  const b = scale * Math.sin(angle);
  const d = -scale * Math.cos(angle);

  const e = w1.x - a * p1.x - c * p1.y;
  const f = w1.y - b * p1.x - d * p1.y;

  return { a, b, c, d, e, f };
}

// ---------------------------------------------------------------------------
// AFFINE MATRIX MULTIPLICATION
// ---------------------------------------------------------------------------

function multiplyAffine(A, B) {
  return {
    a: A.a * B.a + A.c * B.b,
    b: A.b * B.a + A.d * B.b,
    c: A.a * B.c + A.c * B.d,
    d: A.b * B.c + A.d * B.d,
    e: A.a * B.e + A.c * B.f + A.e,
    f: A.b * B.e + A.d * B.f + A.f,
  };
}

// ---------------------------------------------------------------------------
// PDF LOADING
// ---------------------------------------------------------------------------
//
// PDF.js повинен бути підключений в index.html:
//
// <script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js"></script>
//
// Після цього доступний глобальний: window.pdfjsLib
// ---------------------------------------------------------------------------

async function loadPdfPage(url, pageNumber = 1, renderScale = 2.5) {
  if (typeof window.pdfjsLib === "undefined") {
    throw new Error(
      "PDF.js не знайдено. Додайте pdf.min.js перед main.js в index.html."
    );
  }

  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";

  const loadingTask = window.pdfjsLib.getDocument(url);
  const pdf = await loadingTask.promise;

  if (pageNumber < 1 || pageNumber > pdf.numPages) {
    throw new Error(
      `PDF має ${pdf.numPages} сторінок, але вказано pageNumber=${pageNumber}.`
    );
  }

  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: renderScale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  const ctx = canvas.getContext("2d", { alpha: true });

  await page.render({ canvasContext: ctx, viewport }).promise;

  return canvas;
}

// ---------------------------------------------------------------------------
// MAP VIEW
// ---------------------------------------------------------------------------

export class MapView {
  constructor(
    container,
    { onMarkerClick, onHoverWorld, showGrid = true, showScaleBar = true } = {}
  ) {
    this.container = container;
    this.onMarkerClick = onMarkerClick;
    this.onHoverWorld = onHoverWorld;
    this.showGrid = showGrid;
    this.showScaleBar = showScaleBar;

    this.canvas = document.createElement("canvas");
    container.appendChild(this.canvas);

    this.ctx = this.canvas.getContext("2d");

    this.poses = [];
    this.points = [];
    this.screenPoints = [];

    this.view = { scale: 1, cx: 0, cy: 0 };

    this._fitScale = 1;
    this.activeIndex = -1;
    this.hoverIndex = -1;

    // Батчинг рендеру через requestAnimationFrame.
    this._renderScheduled = false;

    /**
     * PDF-підложка:
     * {
     *   image: HTMLCanvasElement,
     *   opacity: number,
     *   imageToWorld: affine matrix
     * }
     */
    this._plan = null;

    this._activePointers = new Map();
    this._downPointer = null;
    this._dragging = false;
    this._dragStartView = null;
    this._pinchStartDist = null;
    this._pinchStartView = null;
    this._pinchWorldAnchor = null;

    this.width = 0;
    this.height = 0;

    this._bindEvents();
    this._resize();
  }

  // -------------------------------------------------------------------------
  // RENDER SCHEDULING
  // -------------------------------------------------------------------------
  //
  // Замість прямого виклику _render() у "гарячих" обробниках подій
  // (pointermove під час drag/pinch, wheel, hover), плануємо не більше
  // одного реального перемальовування на кадр. Це прибирає зайві важкі
  // рендери (з PDF-фоном), коли події прилітають частіше за частоту
  // оновлення екрана — саме це й відчувалося як лаги на телефоні.
  // -------------------------------------------------------------------------

  _scheduleRender() {
    if (this._renderScheduled) return;

    this._renderScheduled = true;

    requestAnimationFrame(() => {
      this._renderScheduled = false;
      this._render();
    });
  }

  // -------------------------------------------------------------------------
  // EVENTS
  // -------------------------------------------------------------------------

  _bindEvents() {
    const ro = new ResizeObserver(() => this._resize());
    ro.observe(this.container);

    const c = this.canvas;

    c.addEventListener("pointerdown", (e) => {
      this._activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      try {
        c.setPointerCapture(e.pointerId);
      } catch {}

      if (this._activePointers.size === 2) {
        this._downPointer = null;
        this._dragging = false;
        this._startPinch();
        return;
      }

      if (this._activePointers.size === 1) {
        this._downPointer = { x: e.clientX, y: e.clientY };
        this._dragStartView = { ...this.view };
        this._dragging = false;
      }
    });

    c.addEventListener("pointermove", (e) => {
      if (!this._activePointers.has(e.pointerId)) {
        this._updateHover(e);
        return;
      }

      this._activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._activePointers.size >= 2) {
        this._handlePinchMove();
        return;
      }

      if (this._downPointer) {
        const dx = e.clientX - this._downPointer.x;
        const dy = e.clientY - this._downPointer.y;

        if (!this._dragging && Math.hypot(dx, dy) > 6) {
          this._dragging = true;
        }

        if (this._dragging) {
          this.view.cx = this._dragStartView.cx - dx / this.view.scale;
          this.view.cy = this._dragStartView.cy + dy / this.view.scale;

          this._scheduleRender();
        }
      }
    });

    c.addEventListener("pointerleave", () => {
      if (this.hoverIndex !== -1) {
        this.hoverIndex = -1;
        this._scheduleRender();
      }

      if (this.onHoverWorld) {
        this.onHoverWorld(null);
      }
    });

    const endPointer = (e) => {
      const wasTracked = this._activePointers.has(e.pointerId);

      this._activePointers.delete(e.pointerId);

      try {
        c.releasePointerCapture(e.pointerId);
      } catch {}

      if (!wasTracked) {
        return;
      }

      if (this._activePointers.size >= 2) {
        this._startPinch();
        return;
      }

      if (this._activePointers.size === 1) {
        this._pinchStartDist = null;

        const [remaining] = this._activePointers.values();

        this._downPointer = { x: remaining.x, y: remaining.y };
        this._dragStartView = { ...this.view };
        this._dragging = true;

        return;
      }

      // Останній палець прибрано.
      this._pinchStartDist = null;

      const wasDragging = this._dragging;
      const start = this._downPointer;

      this._dragging = false;
      this._downPointer = null;

      if (wasDragging || !start) {
        return;
      }

      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;

      if (Math.hypot(dx, dy) > 6) {
        return;
      }

      this._handleClick(e);
    };

    c.addEventListener("pointerup", endPointer);
    c.addEventListener("pointercancel", endPointer);

    c.addEventListener("wheel", (e) => this._handleWheel(e), {
      passive: false,
    });
  }

  // -------------------------------------------------------------------------
  // PINCH
  // -------------------------------------------------------------------------

  _pointerMidScreen() {
    const [p1, p2] = this._activePointers.values();
    const rect = this.canvas.getBoundingClientRect();

    return {
      x: (p1.x + p2.x) / 2 - rect.left,
      y: (p1.y + p2.y) / 2 - rect.top,
    };
  }

  _pointerDist() {
    const [p1, p2] = this._activePointers.values();
    return Math.hypot(p1.x - p2.x, p1.y - p2.y);
  }

  _startPinch() {
    this._pinchStartDist = this._pointerDist();

    const mid = this._pointerMidScreen();

    this._pinchStartView = { ...this.view };
    this._pinchWorldAnchor = this.screenToWorld(mid.x, mid.y);
  }

  _handlePinchMove() {
    if (this._pinchStartDist == null || !this._pinchWorldAnchor) {
      this._startPinch();
      return;
    }

    const dist = this._pointerDist();
    const mid = this._pointerMidScreen();

    const factor = dist / this._pinchStartDist;

    const newScale = clamp(
      this._pinchStartView.scale * factor,
      this._fitScale * 0.15,
      this._fitScale * 60
    );

    this.view.scale = newScale;

    this.view.cx =
      this._pinchWorldAnchor.x - (mid.x - this.width / 2) / newScale;

    this.view.cy =
      this._pinchWorldAnchor.y + (mid.y - this.height / 2) / newScale;

    this._scheduleRender();
  }

  // -------------------------------------------------------------------------
  // RESIZE
  // -------------------------------------------------------------------------

  _resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;

    if (w === 0 || h === 0) {
      return;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.width = w;
    this.height = h;

    this._render();
  }

  // -------------------------------------------------------------------------
  // DATA
  // -------------------------------------------------------------------------

  setTrajectory(poses) {
    this.poses = poses;

    this.points = poses.map((p) => ({
      x: p.position.x,
      y: p.position.y,
      index: p.index,
    }));

    this.fitToBounds(poses);
  }

  // -------------------------------------------------------------------------
  // PDF PLAN
  // -------------------------------------------------------------------------
  //
  // controlPoints:
  //
  // [
  //   { image: { x: 0..1, y: 0..1 }, world: { x, y } },
  //   { image: { x: 0..1, y: 0..1 }, world: { x, y } }
  // ]
  //
  // image.x / image.y — нормалізовані координати PDF.
  // -------------------------------------------------------------------------

  async setPlanPdf(
    url,
    controlPoints,
    opacity = 0.55,
    pageNumber = 1,
    renderScale = 2.5
  ) {
    if (!url) {
      return;
    }

    const image = await loadPdfPage(url, pageNumber, renderScale);

    // -------------------------------------------------------------------
    // РУЧНИЙ РЕЖИМ: якщо контрольних точок нема (або менше 2) —
    // просто завантажуємо PDF з тимчасовим "нейтральним" перетворенням.
    // Реальне положення/масштаб/поворот потім виставляються через
    // setPlanManual().
    // -------------------------------------------------------------------

    if (!controlPoints || controlPoints.length < 2) {
      this._plan = {
        image,
        opacity,
        renderScale,
        imageToWorld: { a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 },
      };

      this._render();
      return;
    }

    /**
     * Перетворюємо контрольні точки у фактичні пікселі відрендереного PDF.
     *
     * Підтримуються два формати точки:
     *
     * 1) cp.pdf.{x,y} — АБСОЛЮТНІ координати просто зняті з PDF
     *    (наприклад, лінійкою / інструментом виміру в переглядачі PDF),
     *    в одиницях самого PDF (points, 1/72 дюйма), без прив'язки до
     *    розміру сторінки. Це рекомендований спосіб: не треба вгадувати
     *    точний розмір сторінки — canvas відрендерений з тим самим
     *    renderScale, тому переклад у пікселі — просто множення на
     *    renderScale.
     *
     * 2) cp.image.{x,y} — застарілий формат: нормалізовані 0..1
     *    координати відносно розміру сторінки. Похибка в припущенні
     *    про розмір сторінки тут напряму спотворює масштаб прив'язки.
     */

    const normalizedPoints = controlPoints.map((cp) => {
      if (cp.pdf) {
        return {
          image: { x: cp.pdf.x * renderScale, y: cp.pdf.y * renderScale },
          world: { x: cp.world.x, y: cp.world.y },
        };
      }

      return {
        image: { x: cp.image.x * image.width, y: cp.image.y * image.height },
        world: { x: cp.world.x, y: cp.world.y },
      };
    });

    this._plan = {
      image,
      opacity,
      renderScale,
      imageToWorld: computeImageToWorld(
        normalizedPoints[0],
        normalizedPoints[1]
      ),
    };

    this._render();
  }

  clearPlanImage() {
    this._plan = null;
    this._render();
  }

  // -------------------------------------------------------------------------
  // РУЧНЕ КАЛІБРУВАННЯ PDF
  // -------------------------------------------------------------------------
  //
  // Замість двох "точних" контрольних точок — просто масштаб (світові
  // одиниці на 1 точку PDF), поворот у градусах і зсув по X/Y у світових
  // одиницях.
  //
  // scale застосовується до СИРИХ точок PDF (тих самих "абсолютних"
  // одиниць, що дає лінійка/вимірювач у PDF), а не до пікселів канви —
  // тому цифра масштабу лишається зрозумілою (~1.0 і подібне), незалежно
  // від renderScale.
  //
  // offsetX/offsetY — це світові координати, куди повинна потрапити
  // точка (0,0) верхнього лівого кута PDF-аркуша.
  // -------------------------------------------------------------------------

  setPlanManual({ scale = 1, rotationDeg = 0, offsetX = 0, offsetY = 0 } = {}) {
    if (!this._plan) {
      return;
    }

    const renderScale = this._plan.renderScale || 1;

    // scale задано "на точку PDF", а imageToWorld працює з пікселями
    // канви (canvasPx = pdfPoint * renderScale), тому ділимо на renderScale.
    const effScale = scale / renderScale;

    const angle = (rotationDeg * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const a = effScale * cos;
    const c = effScale * sin;
    const b = effScale * sin;
    const d = -effScale * cos;

    this._plan.imageToWorld = { a, b, c, d, e: offsetX, f: offsetY };

    this._render();
  }

  setPlanOpacity(value) {
    if (!this._plan) {
      return;
    }

    this._plan.opacity = Math.max(0, Math.min(1, Number(value)));
    this._render();
  }

  // -------------------------------------------------------------------------
  // FIT
  // -------------------------------------------------------------------------

  fitToBounds(poses = this.poses) {
    if (!poses.length || this.width === 0) {
      return;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    poses.forEach((p) => {
      if (
        !Number.isFinite(p.position.x) ||
        !Number.isFinite(p.position.y)
      ) {
        return;
      }

      minX = Math.min(minX, p.position.x);
      maxX = Math.max(maxX, p.position.x);
      minY = Math.min(minY, p.position.y);
      maxY = Math.max(maxY, p.position.y);
    });

    if (!Number.isFinite(minX)) {
      return;
    }

    const w = Math.max(maxX - minX, 1);
    const h = Math.max(maxY - minY, 1);

    const pad = 0.82;

    const scale =
      Math.min(this.width / w, this.height / h) * pad;

    this._fitScale = clamp(scale, 0.0001, 100000);

    this.view = {
      scale: this._fitScale,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
    };

    this._render();
  }

  // -------------------------------------------------------------------------
  // COORDINATES
  // -------------------------------------------------------------------------

  worldToScreen(x, y) {
    return {
      sx: this.width / 2 + (x - this.view.cx) * this.view.scale,
      sy: this.height / 2 - (y - this.view.cy) * this.view.scale,
    };
  }

  screenToWorld(sx, sy) {
    return {
      x: this.view.cx + (sx - this.width / 2) / this.view.scale,
      y: this.view.cy - (sy - this.height / 2) / this.view.scale,
    };
  }

  // -------------------------------------------------------------------------
  // ZOOM / PAN
  // -------------------------------------------------------------------------

  _handleWheel(e) {
    e.preventDefault();

    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    const before = this.screenToWorld(sx, sy);

    const factor = Math.exp(-e.deltaY * 0.0012);

    this.view.scale = clamp(
      this.view.scale * factor,
      this._fitScale * 0.15,
      this._fitScale * 60
    );

    const after = this.screenToWorld(sx, sy);

    this.view.cx += before.x - after.x;
    this.view.cy += before.y - after.y;

    this._scheduleRender();
  }

  // -------------------------------------------------------------------------
  // PICKING
  // -------------------------------------------------------------------------

  _hitTest(sx, sy, radius = 15) {
    let found = -1;
    let bestD = Infinity;

    for (const p of this.screenPoints) {
      const d = Math.hypot(p.sx - sx, p.sy - sy);

      if (d < radius && d < bestD) {
        bestD = d;
        found = p.index;
      }
    }

    return found;
  }

  _updateHover(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    const idx = this._hitTest(sx, sy);

    this.canvas.style.cursor = idx >= 0 ? "pointer" : "grab";

    if (idx !== this.hoverIndex) {
      this.hoverIndex = idx;
      this._scheduleRender();
    }

    if (this.onHoverWorld) {
      this.onHoverWorld(this.screenToWorld(sx, sy));
    }
  }

  _handleClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    const idx = this._hitTest(sx, sy);

    if (idx >= 0 && this.onMarkerClick) {
      this.onMarkerClick(idx, e);
    }
  }

  // -------------------------------------------------------------------------
  // MARKERS
  // -------------------------------------------------------------------------

  setActiveMarker(index, { worldSpan } = {}) {
    this.activeIndex = index;

    if (worldSpan) {
      const targetScale = this.width / worldSpan;

      this.view.scale = clamp(
        targetScale,
        this._fitScale * 0.1,
        this._fitScale * 300
      );
    }

    this._panTo(index);
    this._render();
  }

  clearActiveMarker() {
    this.activeIndex = -1;
    this._heading = null;
    this._render();
  }

  setHeading(index, bearingRad) {
    this._heading = { index, bearing: bearingRad };
    this._render();
  }

  clearHeading() {
    this._heading = null;
    this._render();
  }

  _panTo(index) {
    const p = this.points[index];

    if (!p) {
      return;
    }

    const startCx = this.view.cx;
    const startCy = this.view.cy;

    const t0 = performance.now();
    const duration = 420;

    const step = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - t, 3);

      this.view.cx = startCx + (p.x - startCx) * eased;
      this.view.cy = startCy + (p.y - startCy) * eased;

      this._render();

      if (t < 1) {
        requestAnimationFrame(step);
      }
    };

    requestAnimationFrame(step);
  }

  // -------------------------------------------------------------------------
  // SCALE
  // -------------------------------------------------------------------------

  _niceScaleValue(targetPx) {
    const steps = [1, 2, 5];

    let best = null;
    let bestDiff = Infinity;

    for (let exp = -3; exp <= 6; exp++) {
      const magnitude = Math.pow(10, exp);

      for (const s of steps) {
        const val = s * magnitude;
        const px = val * this.view.scale;

        if (px < 34 || px > targetPx * 2.4) {
          continue;
        }

        const diff = Math.abs(px - targetPx);

        if (diff < bestDiff) {
          bestDiff = diff;
          best = val;
        }
      }
    }

    return best;
  }

  // -------------------------------------------------------------------------
  // GRID
  // -------------------------------------------------------------------------

  _drawGrid() {
    const spacing = this._niceScaleValue(90);

    if (!spacing) {
      return;
    }

    const ctx = this.ctx;

    const topLeft = this.screenToWorld(0, 0);
    const bottomRight = this.screenToWorld(this.width, this.height);

    const minX = Math.min(topLeft.x, bottomRight.x);
    const maxX = Math.max(topLeft.x, bottomRight.x);
    const minY = Math.min(topLeft.y, bottomRight.y);
    const maxY = Math.max(topLeft.y, bottomRight.y);

    ctx.save();

    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;

    ctx.beginPath();

    const startX = Math.floor(minX / spacing) * spacing;

    for (let x = startX; x <= maxX; x += spacing) {
      const { sx } = this.worldToScreen(x, 0);

      ctx.moveTo(Math.round(sx) + 0.5, 0);
      ctx.lineTo(Math.round(sx) + 0.5, this.height);
    }

    const startY = Math.floor(minY / spacing) * spacing;

    for (let y = startY; y <= maxY; y += spacing) {
      const { sy } = this.worldToScreen(0, y);

      ctx.moveTo(0, Math.round(sy) + 0.5);
      ctx.lineTo(this.width, Math.round(sy) + 0.5);
    }

    ctx.stroke();
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // PLAN MATRIX
  // -------------------------------------------------------------------------

  _composePlanMatrix() {
    const s = this.view.scale;

    const screenFromWorld = {
      a: s,
      b: 0,
      c: 0,
      d: -s,
      e: this.width / 2 - s * this.view.cx,
      f: this.height / 2 + s * this.view.cy,
    };

    return multiplyAffine(screenFromWorld, this._plan.imageToWorld);
  }

  // -------------------------------------------------------------------------
  // DRAW PDF
  // -------------------------------------------------------------------------

  _drawPlanImage() {
    if (!this._plan || !this._plan.image) {
      return;
    }

    const image = this._plan.image;

    if (!image.width || !image.height) {
      return;
    }

    const ctx = this.ctx;

    const { a, b, c, d, e, f } = this._composePlanMatrix();

    ctx.save();

    ctx.globalAlpha = this._plan.opacity;

    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(image, 0, 0);

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // SCALE BAR
  // -------------------------------------------------------------------------

  _drawScaleBar() {
    const value = this._niceScaleValue(110);

    if (!value) {
      return;
    }

    const ctx = this.ctx;

    const widthPx = value * this.view.scale;

    const x0 = 16;
    const y0 = this.height - 20;

    ctx.save();

    ctx.strokeStyle = INK_COLOR;
    ctx.fillStyle = INK_COLOR;
    ctx.lineWidth = 1.4;

    ctx.beginPath();

    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + widthPx, y0);

    ctx.moveTo(x0, y0 - 5);
    ctx.lineTo(x0, y0 + 5);

    ctx.moveTo(x0 + widthPx, y0 - 5);
    ctx.lineTo(x0 + widthPx, y0 + 5);

    ctx.stroke();

    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.textBaseline = "bottom";

    ctx.fillText(formatDistance(value), x0, y0 - 8);

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // RETICLE
  // -------------------------------------------------------------------------

  _drawReticle(sx, sy, r) {
    const ctx = this.ctx;
    const tick = 6;

    ctx.save();

    ctx.strokeStyle = MARKER_COLOR_ACTIVE;
    ctx.lineWidth = 1.4;

    ctx.beginPath();

    ctx.moveTo(sx - r, sy - r + tick);
    ctx.lineTo(sx - r, sy - r);
    ctx.lineTo(sx - r + tick, sy - r);

    ctx.moveTo(sx + r - tick, sy - r);
    ctx.lineTo(sx + r, sy - r);
    ctx.lineTo(sx + r, sy - r + tick);

    ctx.moveTo(sx + r, sy + r - tick);
    ctx.lineTo(sx + r, sy + r);
    ctx.lineTo(sx + r - tick, sy + r);

    ctx.moveTo(sx - r + tick, sy + r);
    ctx.lineTo(sx - r, sy + r);
    ctx.lineTo(sx - r, sy + r - tick);

    ctx.stroke();
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // MAIN RENDER
  // -------------------------------------------------------------------------

  _render() {
    const ctx = this.ctx;

    ctx.clearRect(0, 0, this.width, this.height);

    // 1. Сітка
    if (this.showGrid) {
      this._drawGrid();
    }

    // 2. PDF-підложка
    this._drawPlanImage();

    // 3. Якщо траєкторії немає
    if (!this.points.length) {
      if (this.showScaleBar) {
        this._drawScaleBar();
      }

      return;
    }

    // -------------------------------------------------------------------
    // ROUTE
    // -------------------------------------------------------------------

    ctx.beginPath();

    this.points.forEach((p, i) => {
      const { sx, sy } = this.worldToScreen(p.x, p.y);

      if (i === 0) {
        ctx.moveTo(sx, sy);
      } else {
        ctx.lineTo(sx, sy);
      }
    });

    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // Світла обводка маршруту поверх PDF.
    ctx.strokeStyle = LINE_CASING;
    ctx.lineWidth = 4.5;
    ctx.stroke();

    // Основна лінія маршруту.
    ctx.strokeStyle = LINE_COLOR;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // -------------------------------------------------------------------
    // PANORAMA POINTS
    // -------------------------------------------------------------------

    this.screenPoints = [];

    this.points.forEach((p) => {
      const { sx, sy } = this.worldToScreen(p.x, p.y);

      if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
        return;
      }

      this.screenPoints.push({ sx, sy, index: p.index });

      const isActive = p.index === this.activeIndex;
      const isHover = p.index === this.hoverIndex;

      const half = isActive ? 6.5 : isHover ? 5.6 : 4.2;

      ctx.save();

      ctx.translate(sx, sy);
      ctx.rotate(Math.PI / 4);

      // Обводка точки.
      ctx.fillStyle = MARKER_CASING;

      ctx.fillRect(
        -half - 1.8,
        -half - 1.8,
        (half + 1.8) * 2,
        (half + 1.8) * 2
      );

      // Сама точка.
      ctx.fillStyle = isActive ? MARKER_COLOR_ACTIVE : MARKER_COLOR;

      ctx.fillRect(-half, -half, half * 2, half * 2);

      ctx.restore();

      // Активна точка.
      if (isActive) {
        this._drawReticle(sx, sy, half + 9);

        if (this._heading && this._heading.index === p.index) {
          this._drawHeadingCone(sx, sy, this._heading.bearing);
        }
      }
    });

    // Масштаб.
    if (this.showScaleBar) {
      this._drawScaleBar();
    }
  }

  // -------------------------------------------------------------------------
  // HEADING CONE
  // -------------------------------------------------------------------------

  _drawHeadingCone(sx, sy, bearing) {
    const ctx = this.ctx;

    // Світовий напрямок: 0 = +Y, 90° = +X. На екрані Y інвертований.
    const dirX = Math.sin(bearing);
    const dirY = -Math.cos(bearing);

    const angle = Math.atan2(dirY, dirX);

    const radius = 46;
    const halfFov = 0.5;

    ctx.save();

    ctx.translate(sx, sy);

    ctx.beginPath();

    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, angle - halfFov, angle + halfFov);

    ctx.closePath();

    ctx.fillStyle = "rgba(193, 68, 14, 0.15)";
    ctx.fill();

    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "rgba(193, 68, 14, 0.55)";
    ctx.stroke();

    // Центральний промінь.
    ctx.beginPath();

    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);

    ctx.strokeStyle = "rgba(193, 68, 14, 0.8)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();
  }
}
