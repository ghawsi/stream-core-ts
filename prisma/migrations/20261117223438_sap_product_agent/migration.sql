-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN "metadata" TEXT;

-- CreateTable
CREATE TABLE "SapAuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "chatId" TEXT,
    "sapSystemId" TEXT,
    "toolName" TEXT NOT NULL,
    "httpMethod" TEXT NOT NULL,
    "requestUrl" TEXT NOT NULL,
    "requestPayload" TEXT,
    "responseStatus" INTEGER NOT NULL,
    "errorMessage" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SapAuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SapChangePlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "sapSystemId" TEXT NOT NULL,
    "chatId" TEXT,
    "operation" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "entitySet" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "etag" TEXT,
    "payload" TEXT,
    "diff" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resultStatus" INTEGER,
    "resultMessage" TEXT,
    "decidedBy" TEXT,
    "decidedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SapChangePlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SapChangePlan_sapSystemId_fkey" FOREIGN KEY ("sapSystemId") REFERENCES "SapSystem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ChatSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL DEFAULT 'New Chat',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "sapSystemId" TEXT,
    CONSTRAINT "ChatSession_sapSystemId_fkey" FOREIGN KEY ("sapSystemId") REFERENCES "SapSystem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ChatSession" ("createdAt", "id", "title", "updatedAt") SELECT "createdAt", "id", "title", "updatedAt" FROM "ChatSession";
DROP TABLE "ChatSession";
ALTER TABLE "new_ChatSession" RENAME TO "ChatSession";
CREATE INDEX "ChatSession_updatedAt_idx" ON "ChatSession"("updatedAt");
CREATE TABLE "new_SapSystem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "baseUrl" TEXT NOT NULL,
    "sapClient" TEXT NOT NULL,
    "servicePath" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'DEV',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SapSystem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SapSystem" ("baseUrl", "createdAt", "description", "id", "isActive", "name", "sapClient", "servicePath", "updatedAt", "userId") SELECT "baseUrl", "createdAt", "description", "id", "isActive", "name", "sapClient", "servicePath", "updatedAt", "userId" FROM "SapSystem";
DROP TABLE "SapSystem";
ALTER TABLE "new_SapSystem" RENAME TO "SapSystem";
CREATE INDEX "SapSystem_userId_idx" ON "SapSystem"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "SapAuditLog_userId_createdAt_idx" ON "SapAuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SapAuditLog_chatId_idx" ON "SapAuditLog"("chatId");

-- CreateIndex
CREATE INDEX "SapChangePlan_userId_status_idx" ON "SapChangePlan"("userId", "status");

-- CreateIndex
CREATE INDEX "SapChangePlan_chatId_idx" ON "SapChangePlan"("chatId");
