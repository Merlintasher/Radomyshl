/**
 * PDF overlay для геопривязанного плана.
 *
 * Контрольные точки:
 *
 * PDF:
 *   P1 = 425, 193
 *   P7 = 865, 447
 *
 * WORLD:
 *   P1 = 3279595.82, 5587810.46
 *   P7 = 3279988.00, 5587679.99
 *
 * PDF Y направлен вниз.
 * WORLD Y направлен вверх.
 */

export class PdfOverlay {

  constructor({
    layer,
    canvas,
    pdfUrl = "./plan.pdf",
    opacity = 0.65,
  }) {
    this.layer = layer;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    this.pdfUrl = pdfUrl;
    this.opacity = opacity;

    this.pdf = null;
    this.page = null;

    /*
     * Размер PDF.
     * Для загруженного plan.pdf:
     * 2384 × 1684
     */
    this.pdfWidth = 2384;
    this.pdfHeight = 1684;

    /*
     * Контрольные точки.
     */
    this.gcp = {
      p1: {
        pdf: {
          x: 425,
          y: 193,
        },
        world: {
          x: 3279595.82,
          y: 5587810.46,
        },
      },

      p7: {
        pdf: {
          x: 865,
          y: 447,
        },
        world: {
          x: 3279988.00,
          y: 5587679.99,
        },
      },
    };

    this.opacity = opacity;

    /*
     * Трансформация:
     *
     * worldX = a * pdfX + b * pdfY + tx
     * worldY = c * pdfX + d * pdfY + ty
     *
     * Она вычисляется автоматически.
     */
    this.transform = null;

    this.visible = true;
  }

  async load() {

    if (!window.pdfjsLib) {
      throw new Error(
        "PDF.js не найден. Проверь подключение pdf.min.js в index.html."
      );
    }

    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";

    this.pdf = await window.pdfjsLib.getDocument(this.pdfUrl).promise;

    this.page = await this.pdf.getPage(1);

    const viewport = this.page.getViewport({
      scale: 1,
    });

    this.pdfWidth = viewport.width;
    this.pdfHeight = viewport.height;

    /*
     * Рендерим PDF один раз.
     *
     * Далее двигаем/масштабируем готовый canvas,
     * а не рендерим PDF заново при каждом движении карты.
     */

    const renderScale = 1;

    const renderViewport = this.page.getViewport({
      scale: renderScale,
    });

    this.canvas.width = Math.ceil(renderViewport.width);
    this.canvas.height = Math.ceil(renderViewport.height);

    this.canvas.style.width = `${renderViewport.width}px`;
    this.canvas.style.height = `${renderViewport.height}px`;

    await this.page.render({
      canvasContext: this.ctx,
      viewport: renderViewport,
    }).promise;

    this.calculateTransform();

    this.layer.style.opacity = this.opacity;

    return this;
  }

  calculateTransform() {

    const p1 = this.gcp.p1;
    const p7 = this.gcp.p7;

    const pdfDx =
      p7.pdf.x - p1.pdf.x;

    const pdfDy =
      p7.pdf.y - p1.pdf.y;

    const worldDx =
      p7.world.x - p1.world.x;

    const worldDy =
      p7.world.y - p1.world.y;

    /*
     * Поскольку у нас только две точки,
     * строим similarity transformation:
     *
     * масштаб + поворот + перенос.
     */

    const pdfDistance =
      Math.hypot(pdfDx, pdfDy);

    const worldDistance =
      Math.hypot(worldDx, worldDy);

    const scale =
      worldDistance / pdfDistance;

    /*
     * PDF координаты:
     * Y вниз.
     *
     * Поэтому при переводе в WORLD
     * учитываем изменение направления Y.
     */

    const anglePdf =
      Math.atan2(pdfDy, pdfDx);

    const angleWorld =
      Math.atan2(worldDy, worldDx);

    const angle =
      angleWorld - anglePdf;

    const cos =
      Math.cos(angle);

    const sin =
      Math.sin(angle);

    const a = scale * cos;
    const b = -scale * sin;
    const c = scale * sin;
    const d = scale * cos;

    /*
     * Перенос так, чтобы P1 совпала
     * с абсолютной координатой P1.
     */

    const tx =
      p1.world.x -
      (a * p1.pdf.x + b * p1.pdf.y);

    const ty =
      p1.world.y -
      (c * p1.pdf.x + d * p1.pdf.y);

    this.transform = {
      a,
      b,
      c,
      d,
      tx,
      ty,
      scale,
      angle,
    };

    console.log("PDF геопривязка:", this.transform);
  }

  /*
   * Перевести точку PDF в WORLD.
   */
  pdfToWorld(x, y) {

    const t = this.transform;

    return {
      x:
        t.a * x +
        t.b * y +
        t.tx,

      y:
        t.c * x +
        t.d * y +
        t.ty,
    };
  }

  /*
   * Перевести WORLD в PDF.
   */
  worldToPdf(x, y) {

    const t = this.transform;

    const det =
      t.a * t.d -
      t.b * t.c;

    if (Math.abs(det) < 1e-12) {
      throw new Error(
        "Невозможно инвертировать PDF transform."
      );
    }

    const dx =
      x - t.tx;

    const dy =
      y - t.ty;

    return {
      x:
        (t.d * dx -
          t.b * dy) /
        det,

      y:
        (-t.c * dx +
          t.a * dy) /
        det,
    };
  }

  /*
   * Привязать PDF к экрану.
   *
   * worldToScreen —
   * функция карты:
   *
   * worldToScreen(x, y)
   * →
   * { x, y }
   *
   * Именно её должен предоставить MapView.
   */
  update(worldToScreen) {

    if (!this.transform) {
      return;
    }

    const corners = [
      this.pdfToWorld(0, 0),

      this.pdfToWorld(
        this.pdfWidth,
        0
      ),

      this.pdfToWorld(
        this.pdfWidth,
        this.pdfHeight
      ),

      this.pdfToWorld(
        0,
        this.pdfHeight
      ),
    ];

    const screenCorners =
      corners.map((p) =>
        worldToScreen(
          p.x,
          p.y
        )
      );

    /*
     * Получаем экранные координаты
     * двух базовых направлений PDF.
     */

    const p0 =
      screenCorners[0];

    const p1 =
      screenCorners[1];

    const p3 =
      screenCorners[3];

    const vx = {
      x: p1.x - p0.x,
      y: p1.y - p0.y,
    };

    const vy = {
      x: p3.x - p0.x,
      y: p3.y - p0.y,
    };

    /*
     * CSS matrix:
     *
     * x' = a*x + c*y + e
     * y' = b*x + d*y + f
     */

    const a =
      vx.x / this.pdfWidth;

    const b =
      vx.y / this.pdfWidth;

    const c =
      vy.x / this.pdfHeight;

    const d =
      vy.y / this.pdfHeight;

    const e =
      p0.x;

    const f =
      p0.y;

    this.layer.style.transformOrigin =
      "0 0";

    this.layer.style.transform =
      `matrix(${a},${b},${c},${d},${e},${f})`;
  }

  setOpacity(value) {

    this.opacity =
      Math.max(
        0,
        Math.min(
          1,
          Number(value)
        )
      );

    this.layer.style.opacity =
      this.opacity;
  }

  show() {

    this.visible = true;

    this.layer.style.display =
      "block";
  }

  hide() {

    this.visible = false;

    this.layer.style.display =
      "none";
  }
}