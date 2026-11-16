import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { Prisma } from "@/prisma/prisma/generated/prisma/browser";

export const auth = betterAuth({
  database: prismaAdapter(Prisma, {
    provider: "sqlite",
  }),
  emailAndPassword:{
    enabled: true
  }
});
