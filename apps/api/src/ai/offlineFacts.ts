/**
 * ФАКТЫ ОФЛАЙН-КУРСА — значения по умолчанию (те же, что на сайте на
 * 05.09.2026). Настоящие читаются из Settings через
 * services/salesTextsService.getOfflineFacts(); владелец правит их в разделе
 * «Тексты и цены». Файл без зависимостей — его импортируют и карточка бота
 * (offlineCourse.ts), и сервис настроек, и тесты.
 */
export type OfflineFacts = {
  /** Стоимость в сомони. */
  price: number;
  /** Длительность в днях. */
  days: number;
  /** Часы занятий строкой — «14:00 до 17:00». */
  hours: string;
  /** Сколько видов десертов готовят. */
  desserts: number;
  address: string;
};

export const DEFAULT_OFFLINE_FACTS: OfflineFacts = {
  price: 700,
  days: 8,
  hours: "14:00 до 17:00",
  desserts: 20,
  address: "Душанбе, ул. Рудаки, 156а",
};
