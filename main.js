import { MapView } from "./mapview.js";
import { loadTrajectory, computeInitialView, computeNavArrowAim } from "./trajectory.js";
import { PanoramaController } from "./panorama.js";

/**
 * ---------------------------------------------------------------------------
 * CONFIG
 * ---------------------------------------------------------------------------
 */

const CONFIG = {
  trajectory: {
    // Файл поз:
    // "#timestamp imgname x y z qx qy qz qw"
    posesUrl: "assets/panoramas/poses.txt",

    // imgname у файлі поз, наприклад:
    // pano/1783518563.624737.jpg
    panoramaBaseUrl: "assets/panoramas/",
  },

  orientation: {
    // Локальний "вперед" знімального ріга.
    forwardAxis: [1, 0, 0],

    // Поправка між світовим азимутом і yaw=0 текстури панорами.
    worldYawOffsetDeg: 0,
  },

  miniMap: {
    // Скільки метрів по горизонталі показувати
    // в мінікарті навколо поточної точки.
    worldSpanMeters: 22,
  },

  /**
   * -------------------------------------------------------------------------
   * PDF-ПІДЛОЖКА
   * -------------------------------------------------------------------------
   *
   * PDF рендериться браузером у зображення і накладається під траєкторію.
   *
   * ВАЖЛИВО:
   *
   * controlPoints містить 2 точки.
   *
   * image:
   *   x — положення точки на PDF по ширині, від 0 до 1
   *   y — положення точки на PDF по висоті, від 0 до 1
   *
   *   x = 0   -> лівий край PDF
   *   x = 1   -> правий край PDF
   *
   *   y = 0   -> верхній край PDF
   *   y = 1   -> нижній край PDF
   *
   * world:
   *   реальні X/Y координати цієї самої точки
   *   у тій самій системі координат, що й poses.txt.
   *
   * Наприклад:
   *
   * controlPoints: [
   *   {
   *     image: { x: 0.1234, y: 0.2456 },
   *     world: { x: 3323260.123, y: 5580900.456 }
   *   },
   *   {
   *     image: { x: 0.8123, y: 0.7312 },
   *     world: { x: 3323340.789, y: 5580960.123 }
   *   }
   * ]
   *
   * Спочатку можна залишити приклад нижче.
   * Після цього потрібно буде підставити свої 2 точки.
   */

    planPdf: {
    enabled: true,

    // -------------------------------------------------------
    // PDF
    // -------------------------------------------------------
    // Положи файл сюда:
    // assets/plan/plan.pdf
    //
    url: "assets/plan/plan.pdf",

    // Первая страница PDF
    pageNumber: 1,

    // Качество рендера PDF
    renderScale: 2.5,

    // Прозорость PDF
    // 0.00 = невидимый
    // 1.00 = полностью непрозрачный
    opacity: 1,

    // -------------------------------------------------------
    // РУЧНЕ КАЛІБРУВАННЯ
    // -------------------------------------------------------
    //
    // Координати точок з різних джерел (кадастр і креслення)
    // не збіглись — тому підв'язка робиться вручну повзунками
    // прямо в браузері (панель "Калібрування PDF" у верхньому
    // лівому куті). Ці числа — лише СТАРТОВА точка, займіть
    // панеллю зручне положення, тоді натисніть "Скопіювати" і
    // вставте отримані значення сюди, щоб зберегти результат.
    //
    // scale       — світових одиниць на 1 точку PDF (~1.0 —
    //               орієнтовно, з попередніх вимірів)
    // rotationDeg — поворот аркуша, градуси
    // offsetX/Y   — світові координати верхнього лівого
    //               кута аркуша PDF (точка 0,0)
    //
    // -------------------------------------------------------

    manual: {
      scale: 0.185,
      rotationDeg: 0,
      offsetX: 3279572,
      offsetY: 5587911,
    },
  },
};


/**
 * ---------------------------------------------------------------------------
 * DOM refs
 * ---------------------------------------------------------------------------
 */

const els = {
  loading: document.getElementById("loading"),
  loadingStatus: document.getElementById("loading-status"),

  mapContainer: document.getElementById("map-view"),

  statPanoramas: document.getElementById("stat-panoramas"),
  statHint: document.getElementById("stat-hint"),

  resetView: document.getElementById("reset-view"),

  miniMapContainer: document.getElementById("mini-map"),

  coordReadout: document.getElementById("coord-readout"),

  panoramaOverlay: document.getElementById("panorama-view"),
  panoramaContainer: document.getElementById("panorama-container"),
  panoCaption: document.getElementById("pano-caption"),

  closeBtn: document.getElementById("pano-close"),
  prevBtn: document.getElementById("pano-prev"),
  nextBtn: document.getElementById("pano-next"),

  iris: document.getElementById("iris"),
};


/**
 * ---------------------------------------------------------------------------
 * STATE
 * ---------------------------------------------------------------------------
 */

let poses = [];
let currentIndex = -1;


/**
 * ---------------------------------------------------------------------------
 * MAIN MAP
 * ---------------------------------------------------------------------------
 */

const map = new MapView(els.mapContainer, {
  onMarkerClick: (index, event) => openPanoramaAt(index, event),

  onHoverWorld: (pt) => {
    if (!els.coordReadout) return;

    els.coordReadout.textContent = pt
      ? `X ${pt.x.toFixed(1)}  ·  Y ${pt.y.toFixed(1)}`
      : "";
  },
});


/**
 * ---------------------------------------------------------------------------
 * MINI MAP
 * ---------------------------------------------------------------------------
 */

const miniMap = new MapView(els.miniMapContainer, {
  onMarkerClick: (index, event) => openPanoramaAt(index, event),

  showGrid: false,
  showScaleBar: false,
});


/**
 * ---------------------------------------------------------------------------
 * PANORAMA
 * ---------------------------------------------------------------------------
 */

const panorama = new PanoramaController(els.panoramaContainer, {

  onPositionChange: ({ yaw }) => {
    if (currentIndex < 0) return;

    const offsetRad =
      (CONFIG.orientation.worldYawOffsetDeg * Math.PI) / 180;

    const twoPi = Math.PI * 2;

    const worldBearing =
      ((yaw - offsetRad) % twoPi + twoPi) % twoPi;

    miniMap.setHeading(currentIndex, worldBearing);
  },

  onMarkerNavigate: (data) => {
    openPanoramaAt(data.targetIndex);
  },
});


/**
 * ---------------------------------------------------------------------------
 * INIT
 * ---------------------------------------------------------------------------
 */

async function init() {
  setStatus("Завантаження траєкторії панорам…");

  try {
    poses = await loadTrajectory(
      CONFIG.trajectory.posesUrl
    );

    map.setTrajectory(poses);
    miniMap.setTrajectory(poses);

    els.statPanoramas.textContent = String(poses.length);

  } catch (err) {
    console.error(err);

    setStatus(
      "Не вдалося завантажити файл траєкторії. " +
      "Перевірте шлях і консоль браузера (F12)."
    );

    return;
  }


  /**
   * -------------------------------------------------------------------------
   * Завантаження PDF-підложки
   * -------------------------------------------------------------------------
   */

  if (CONFIG.planPdf.enabled) {
    try {
      setStatus("Завантаження PDF-підложки…");

      await Promise.all([
        map.setPlanPdf(
          CONFIG.planPdf.url,
          null,
          CONFIG.planPdf.opacity,
          CONFIG.planPdf.pageNumber,
          CONFIG.planPdf.renderScale
        ),

        miniMap.setPlanPdf(
          CONFIG.planPdf.url,
          null,
          CONFIG.planPdf.opacity,
          CONFIG.planPdf.pageNumber,
          CONFIG.planPdf.renderScale
        ),
      ]);

      map.setPlanManual(CONFIG.planPdf.manual);
      miniMap.setPlanManual(CONFIG.planPdf.manual);

    } catch (err) {
      console.error(err);

      console.warn(
        "PDF-підложку не вдалося завантажити. " +
        "Маршрут продовжить працювати без неї."
      );
    }
  }


  hideLoading();
}


/**
 * ---------------------------------------------------------------------------
 * STATUS / LOADING
 * ---------------------------------------------------------------------------
 */

function setStatus(text) {
  els.loadingStatus.textContent = text;
}


function hideLoading() {
  els.loading.classList.add("hidden");
}


/**
 * ---------------------------------------------------------------------------
 * PANORAMA FLOW
 * ---------------------------------------------------------------------------
 */

function panoramaUrlFor(pose) {
  return CONFIG.trajectory.panoramaBaseUrl + pose.imgname;
}


function formatCaption(pose) {
  const date = new Date(pose.timestamp * 1000);

  const dateStr = Number.isFinite(date.getTime())
    ? date.toLocaleString("uk-UA")
    : "";

  return `${dateStr}  ·  ${pose.index + 1} / ${poses.length}`;
}


function buildNavMarkers(index, pose) {
  const offsetRad =
    (CONFIG.orientation.worldYawOffsetDeg * Math.PI) / 180;

  const markers = [];


  if (index > 0) {
    const aim = computeNavArrowAim(
      pose,
      poses[index - 1],
      {
        offsetRad,
      }
    );

    markers.push({
      id: "prev",
      yaw: aim.yaw,
      pitch: aim.pitch,
      direction: "prev",
      targetIndex: index - 1,
    });
  }


  if (index < poses.length - 1) {
    const aim = computeNavArrowAim(
      pose,
      poses[index + 1],
      {
        offsetRad,
      }
    );

    markers.push({
      id: "next",
      yaw: aim.yaw,
      pitch: aim.pitch,
      direction: "next",
      targetIndex: index + 1,
    });
  }


  return markers;
}


async function openPanoramaAt(index, event) {
  const pose = poses[index];

  if (!pose) return;


  currentIndex = index;

  map.setActiveMarker(index);

  miniMap.setActiveMarker(
    index,
    {
      worldSpan: CONFIG.miniMap.worldSpanMeters,
    }
  );


  triggerIris(event);

  els.panoramaOverlay.classList.add("visible");


  const { yaw, pitch } =
    computeInitialView(
      pose,
      CONFIG.orientation.forwardAxis
    );


  const caption = formatCaption(pose);

  els.panoCaption.textContent = caption;

  updateNavButtons();


  const navMarkers =
    buildNavMarkers(index, pose);


  try {
    await panorama.open(
      panoramaUrlFor(pose),
      {
        yaw,
        pitch,
        caption,
      }
    );

    panorama.setNavMarkers(navMarkers);

  } catch (err) {
    console.error(err);

    els.panoCaption.textContent =
      "Не вдалося завантажити зображення панорами";
  }
}


function step(delta) {
  const next = currentIndex + delta;

  if (
    next < 0 ||
    next >= poses.length
  ) {
    return;
  }

  openPanoramaAt(next);
}


function closePanorama() {
  els.panoramaOverlay.classList.remove("visible");

  map.clearActiveMarker();
  miniMap.clearActiveMarker();

  currentIndex = -1;
}


function updateNavButtons() {
  els.prevBtn.disabled =
    currentIndex <= 0;

  els.nextBtn.disabled =
    currentIndex >= poses.length - 1;
}


/**
 * ---------------------------------------------------------------------------
 * IRIS TRANSITION
 * ---------------------------------------------------------------------------
 */

function triggerIris(event) {
  const x = event
    ? event.clientX
    : window.innerWidth / 2;

  const y = event
    ? event.clientY
    : window.innerHeight / 2;


  els.iris.style.setProperty(
    "--x",
    `${x}px`
  );

  els.iris.style.setProperty(
    "--y",
    `${y}px`
  );


  els.iris.classList.remove("play");

  void els.iris.offsetWidth;

  els.iris.classList.add("play");
}


/**
 * ---------------------------------------------------------------------------
 * EVENTS
 * ---------------------------------------------------------------------------
 */

const TAP_MOVE_THRESHOLD_PX = 10;


function bindTapButton(el, handler) {
  let startPos = null;
  let startedOnButton = false;


  el.addEventListener("pointerdown", (e) => {
    startedOnButton = true;

    startPos = {
      x: e.clientX,
      y: e.clientY,
    };
  });


  el.addEventListener("pointermove", (e) => {
    if (
      !startedOnButton ||
      !startPos
    ) {
      return;
    }


    const dx =
      e.clientX - startPos.x;

    const dy =
      e.clientY - startPos.y;


    if (
      Math.hypot(dx, dy) >
      TAP_MOVE_THRESHOLD_PX
    ) {
      startedOnButton = false;
    }
  });


  el.addEventListener("pointerup", (e) => {
    if (startedOnButton) {
      handler(e);
    }

    startedOnButton = false;
    startPos = null;
  });


  el.addEventListener("pointercancel", () => {
    startedOnButton = false;
    startPos = null;
  });


  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
}


bindTapButton(
  els.closeBtn,
  closePanorama
);

bindTapButton(
  els.prevBtn,
  () => step(-1)
);

bindTapButton(
  els.nextBtn,
  () => step(1)
);

bindTapButton(
  els.resetView,
  () => map.fitToBounds(poses)
);


window.addEventListener("keydown", (e) => {
  if (
    !els.panoramaOverlay.classList.contains(
      "visible"
    )
  ) {
    return;
  }


  if (e.key === "ArrowRight") {
    step(1);
  }

  if (e.key === "ArrowLeft") {
    step(-1);
  }

  if (e.key === "Escape") {
    closePanorama();
  }
});


/**
 * ---------------------------------------------------------------------------
 * START
 * ---------------------------------------------------------------------------
 */

init();