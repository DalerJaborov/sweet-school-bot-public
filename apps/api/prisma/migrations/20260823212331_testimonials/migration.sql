-- AlterTable
ALTER TABLE "Contact" ADD COLUMN "testimonialSentAt" DATETIME;

-- CreateTable
CREATE TABLE "Testimonial" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "imageUrl" TEXT NOT NULL,
    "caption" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastShownAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
