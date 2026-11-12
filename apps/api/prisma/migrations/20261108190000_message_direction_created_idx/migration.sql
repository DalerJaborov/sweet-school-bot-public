-- Сторож неотвеченных (inboundWatch.ts) раз в минуту читает входящие по (direction, createdAt);
-- без индекса это полный проход по таблице сообщений. Индекс только добавляется, данные не трогаются.
-- CreateIndex
CREATE INDEX IF NOT EXISTS "Message_direction_createdAt_idx" ON "Message"("direction", "createdAt");
