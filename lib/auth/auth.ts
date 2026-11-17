import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createAuthMiddleware } from "better-auth/api";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/prisma/prisma/generated/prisma/client";
import { SAP_SESSION_COOKIE_PREFIX } from "@/lib/sap/constants";

const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL!, // e.g., "file:./dev.db"
});

const prisma = new PrismaClient({ adapter });

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "sqlite",
  }),
  emailAndPassword: {
    enabled: true,
  },
  hooks: {
    // Signing out ends every SAP session in this browser: the encrypted
    // sap_sess_* cookies are deleted. (They are also bound to the Better Auth
    // session ID, so a leftover cookie would be rejected anyway.)
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-out") return;
      const cookieHeader = ctx.headers?.get("cookie") ?? "";
      for (const part of cookieHeader.split(";")) {
        const name = part.split("=")[0]?.trim();
        if (name?.startsWith(SAP_SESSION_COOKIE_PREFIX)) {
          ctx.setCookie(name, "", {
            path: "/",
            maxAge: 0,
            httpOnly: true,
            sameSite: "strict",
            secure: process.env.NODE_ENV === "production",
          });
        }
      }
    }),
  },
});
