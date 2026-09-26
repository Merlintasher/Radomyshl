import * as THREE from "three";

/**
 * Завантажує і парсить файл траєкторії панорам.
 *
 * Очікуваний формат (через пробіл, один заголовковий рядок з #):
 *   #timestamp imgname x y z qx qy qz qw
 *   1783518563.624737 pano/1783518563.624737.jpg 3323287.427846 5580917.481488 168.578918 0.539840 -0.475107 0.521073 -0.459706
 *
 * x, y, z вважаються тією самою системою координат, що й хмара точок
 * (горизонтальна площина x/y, z — висота).
 */
export async function loadTrajectory(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Не вдалося завантажити файл траєкторії: ${url} (HTTP ${res.status})`);
  }
  const buffer = await res.arrayBuffer();
  const text = decodeText(buffer);

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  const parsed = lines
    .map((line, i) => {
      const parts = line.split(/\s+/);
      if (parts.length < 9) return null;
      const [timestamp, imgname, x, y, z, qx, qy, qz, qw] = parts;
      return {
        timestamp: parseFloat(timestamp),
        imgname,
        position: { x: parseFloat(x), y: parseFloat(y), z: parseFloat(z) },
        quaternion: { x: parseFloat(qx), y: parseFloat(qy), z: parseFloat(qz), w: parseFloat(qw) },
        _sourceLine: i + 1,
      };
    })
    .filter(Boolean);

  // Один рядок із нечисловим значенням (кома замість крапки в десяткових,
  // зайва колонка, "битий" рядок з експорту тощо) через Math.min/Math.max
  // у MapView.fitToBounds перетворює NaN на межі ВСІЄЇ карти — і траєкторія
  // мовчки перестає малюватись без жодної помилки в консолі. Тому такі
  // рядки краще одразу відкинути й голосно попередити, ніж пропустити далі.
  const poses = [];
  let dropped = 0;
  for (const p of parsed) {
    const nums = [
      p.timestamp, p.position.x, p.position.y, p.position.z,
      p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w,
    ];
    if (nums.every(Number.isFinite)) {
      delete p._sourceLine;
      poses.push(p);
    } else {
      dropped += 1;
      console.warn(
        `poses.txt: рядок №${p._sourceLine} пропущено — не вдалося розпарсити число ` +
        `(перевірте кому замість крапки в десяткових, зайві пробіли чи кількість колонок):`,
        p
      );
    }
  }
  if (dropped > 0) {
    console.warn(`poses.txt: пропущено ${dropped} з ${parsed.length} рядків через нечислові значення.`);
  }

  poses.sort((a, b) => a.timestamp - b.timestamp);
  poses.forEach((p, i) => (p.index = i));

  return poses;
}

/**
 * Розкодовує байти файлу траєкторії у текст, автоматично визначаючи
 * кодування. Текстові редактори (особливо Notepad на Windows) часто
 * зберігають "простий текстовий" файл у UTF-16 замість UTF-8 — якщо це
 * прочитати як UTF-8, кожен символ ASCII перетворюється на "символ +
 * пробіл/сміття", рядок розсипається на десятки "колонок" замість 9,
 * жодне число не парситься, і файл траєкторії мовчки вважається порожнім.
 * Тому спершу перевіряємо BOM (позначку кодування на початку файлу),
 * а якщо BOM немає — евристично шукаємо нульові байти через один, що
 * теж видає UTF-16 без BOM.
 */
function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer.slice(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buffer.slice(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(buffer.slice(3));
  }

  // Немає BOM — перевіряємо перші ~40 байт на характерний для UTF-16
  // патерн "нульовий байт через один" (ASCII-символи в UTF-16 завжди
  // мають старший байт 0x00).
  const sampleLen = Math.min(bytes.length, 40);
  let zerosAtOdd = 0;
  let zerosAtEven = 0;
  for (let i = 0; i < sampleLen; i++) {
    if (bytes[i] === 0) {
      if (i % 2 === 0) zerosAtEven += 1;
      else zerosAtOdd += 1;
    }
  }
  if (zerosAtOdd > sampleLen / 4) return new TextDecoder("utf-16le").decode(buffer);
  if (zerosAtEven > sampleLen / 4) return new TextDecoder("utf-16be").decode(buffer);

  return new TextDecoder("utf-8").decode(buffer);
}

/**
 * Перетворює кватерніон пози на початковий yaw/pitch (радіани) для
 * панорамного в'юєра, щоб панорама відкривалась обличчям у той бік,
 * куди дивилась камера під час зйомки.
 *
 * `forwardAxis` — локальний "вперед" знімального ріга у власній системі
 * координат (той самий порядок осей, що й кватерніон).
 *
 * Якщо панорами відкриваються не в той бік — пробуйте [0,1,0], [0,0,1],
 * [-1,0,0] і т.д. у main.js -> CONFIG.orientation.forwardAxis, доки не
 * стане правильно. Це залежить від того, як конкретний SLAM/знімальний
 * риг визначає свої локальні осі, і наперед це знати неможливо.
 */
export function computeInitialView(pose, forwardAxis = [1, 0, 0]) {
  const q = new THREE.Quaternion(
    pose.quaternion.x,
    pose.quaternion.y,
    pose.quaternion.z,
    pose.quaternion.w
  );

  const forward = new THREE.Vector3(...forwardAxis)
    .normalize()
    .applyQuaternion(q)
    .normalize();

  // Photo Sphere Viewer: X -> right, Y -> up, Z -> forward
  const yaw = Math.atan2(forward.x, forward.z);
  const pitch = Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1));

  return { yaw, pitch };
}

/**
 * Обчислює, куди в панорамі має "дивитись" стрілка навігації "вперед/назад"
 * (як у Google Street View), щоб вона виглядала прив'язаною до реального
 * маршруту, а не висіла в довільному місці кадру.
 *
 * yaw — напрямок за світовими x/y (горизонтальна площина). Використовує
 * лише позиції, без кватерніона: панорамна текстура має ФІКСОВАНУ
 * орієнтацією відносно світу (типово вирівняну по компасу під час зйомки),
 * тому один і той самий offsetRad працює для всіх точок маршруту.
 * Якщо стрілки показують не в той бік — підберіть offsetRad (у main.js ->
 * CONFIG.orientation.worldYawOffsetDeg), той самий принцип підбору методом
 * спроб, що й для forwardAxis вище.
 *
 * pitch — нахил "до землі", розрахований з трикутника
 * (висота ока над землею) / (горизонтальна відстань до сусідньої точки) +
 * враховує різницю висот (z) між точками. Завдяки цьому стрілка до
 * ближньої панорами дивиться різкіше вниз, а до дальньої — майже
 * горизонтально, як і має бути. minPitch/maxPitch — межі, щоб стрілка не
 * "залипала" в підлогу чи не спливала до горизонту при екстремальних
 * відстанях; eyeHeight — підберіть під зріст оператора/висоту камери, якщо
 * стрілки виглядають зависокими чи занизькими.
 */
export function computeNavArrowAim(
  fromPose,
  toPose,
  {
    offsetRad = 0,
    eyeHeight = 1.6,
    minPitch = -0.55,
    maxPitch = -0.05,
  } = {}
) {
  const dx = toPose.position.x - fromPose.position.x;
  const dy = toPose.position.y - fromPose.position.y;
  const dz = toPose.position.z - fromPose.position.z;

  const horizDist = Math.max(Math.hypot(dx, dy), 0.3);
  const dist3d = Math.hypot(dx, dy, dz);

  const twoPi = Math.PI * 2;
  let yaw = Math.atan2(dx, dy) + offsetRad;
  yaw = ((yaw % twoPi) + twoPi) % twoPi;

  // Ціль — точка на "землі" сусідньої панорами: настільки нижче рівня ока,
  // наскільки нижча (чи вища) сама точка з урахуванням висоти ока.
  const verticalDrop = Math.max(eyeHeight - dz, 0.15);
  let pitch = -Math.atan2(verticalDrop, horizDist);
  pitch = Math.min(maxPitch, Math.max(minPitch, pitch));

  return { yaw, pitch, distance: dist3d };
}