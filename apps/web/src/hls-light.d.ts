/**
 * Облегчённая сборка hls.js (без субтитров, альтернативного звука, DRM и CMCD;
 * AES-128 и ABR — на месте). Пакет отдаёт её как `hls.js/light`, но без типов:
 * берём типы полной сборки, API у них общий.
 */
declare module "hls.js/light" {
  import Hls from "hls.js";
  export default Hls;
}
