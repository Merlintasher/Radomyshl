import { Viewer } from "@photo-sphere-viewer/core";
import { MarkersPlugin } from "@photo-sphere-viewer/markers-plugin";

/**
 * Обгортка над Photo Sphere Viewer.
 *
 * - lazily створюється при першому open() і перевикористовується для кожної
 *   наступної панорами (setPanorama робить кросфейд замість перестворення
 *   в'юєра — рух вперед/назад по маршруту виглядає плавно).
 *
 * Навігація "вперед/назад" тепер продубльована двома способами:
 *   1) бічні кнопки-стрілки (#pano-prev / #pano-next у main.js) — надійні
 *      на телефоні, не залежать від того, куди зараз повернутий погляд;
 *   2) маркери прямо всередині самої панорами (via MarkersPlugin),
 *      розташовані по реальному напрямку на сусідню точку маршруту —
 *      як стрілки в Google Street View. onMarkerNavigate() викликається
 *      при кліку/тапі по такому маркеру.
 */

export class PanoramaController {
  constructor(container, { onPositionChange, onMarkerNavigate } = {}) {
    this.container = container;
    this.onPositionChange = onPositionChange;
    this.onMarkerNavigate = onMarkerNavigate;
    this.viewer = null;
    this.markersPlugin = null;
  }

  async open(url, { yaw = 0, pitch = 0, caption = "" } = {}) {
    if (!this.viewer) {
      this.viewer = new Viewer({
        container: this.container,
        panorama: url,
        navbar: false,
        defaultYaw: yaw,
        defaultPitch: pitch,
        caption,
        loadingTxt: "Завантаження панорами…",
        touchmoveTwoFingers: false,
        mousewheelCtrlKey: false,
        plugins: [[MarkersPlugin, {}]],
      });

      this.markersPlugin = this.viewer.getPlugin(MarkersPlugin);
      this.markersPlugin.addEventListener("select-marker", ({ marker }) => {
        if (marker?.data && this.onMarkerNavigate) this.onMarkerNavigate(marker.data);
      });

      this.viewer.addEventListener("position-updated", ({ position }) => {
        if (this.onPositionChange) this.onPositionChange(position);
      });

      await new Promise((resolve) => {
        this.viewer.addEventListener("ready", () => resolve(), { once: true });
      });
      return;
    }

    await this.viewer.setPanorama(url, {
      position: { yaw, pitch },
      caption,
      transition: { effect: "fade", speed: 500, rotation: false },
    });
  }

  // markers: [{ id: "prev"|"next", yaw, pitch, direction: "prev"|"next", targetIndex }]
  // yaw/pitch — у радіанах, той самий формат, що повертає computeNavArrowAim().
  setNavMarkers(markers = []) {
    if (!this.markersPlugin) return;
    this.markersPlugin.clearMarkers();
    markers.forEach((m) => {
      this.markersPlugin.addMarker({
        id: m.id,
        position: { yaw: m.yaw, pitch: m.pitch },
        html: navArrowHtml(m.direction),
        anchor: "center center",
        data: m,
      });
    });
  }

  destroy() {
    if (this.viewer) {
      this.viewer.destroy();
      this.viewer = null;
      this.markersPlugin = null;
    }
  }
}

function navArrowHtml(direction) {
  const cls = direction === "prev" ? "pano-nav-marker pano-nav-marker--prev" : "pano-nav-marker";
  const rotation = direction === "prev" ? 180 : 0;
  return (
    `<div class="${cls}">` +
    `<svg viewBox="0 0 24 24" width="20" height="20" style="transform:rotate(${rotation}deg)">` +
    `<path d="M12 4 4 14h5v6h6v-6h5z" fill="currentColor"/></svg></div>`
  );
}
