-- Сертификаты о прохождении курса. Новая таблица, существующие не трогаются.
CREATE TABLE "Certificate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "lang" TEXT NOT NULL DEFAULT 'ru',
    "number" INTEGER NOT NULL,
    "issuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Certificate_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Certificate_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Certificate_contactId_courseId_key" ON "Certificate"("contactId", "courseId");
