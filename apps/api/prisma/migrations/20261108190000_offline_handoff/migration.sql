-- Состояние диалога «офлайн: передано Ширин» (ai/offlineHandoff.ts).
-- Ставится после карточки офлайн-курса, снимается словом «онлайн» или покупкой.
ALTER TABLE "Contact" ADD COLUMN "offlineHandoffAt" DATETIME;
