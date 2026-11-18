import type { Metadata } from "next";
import { ThemeProvider, Toaster, TooltipProvider, getThemeScript } from "@boilerplate/ui"
import { AppShell } from "@/components/app-shell/app-shell"
import { SapAuthModal } from "@/components/sap-auth-modal"
import "./globals.css";


export const metadata: Metadata = {
  title: "SAP S/4HANA AI Chat",
  description: "An AI assistant for SAP S/4HANA consultants and developers.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: getThemeScript() }} />
      </head>
      <body>
        <ThemeProvider>
          <TooltipProvider>
            {/* Every page sits in the app shell: the icon rail and one content panel. */}
            <AppShell>{children}</AppShell>
            <SapAuthModal />
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}