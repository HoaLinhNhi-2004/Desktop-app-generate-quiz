import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "./ModeToggle";
import { LanguageSwitcher } from "./LanguageSwitcher";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { SettingsContent } from "@/ui/pages/SettingsPage";
import { useUpdateCheck } from "@/features/updates";

export function FloatingToolbar() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { t } = useTranslation();
  const { data: update } = useUpdateCheck();
  const updateAvailable = update?.status === "update-available";

  return (
    <>
      <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-full border border-border bg-card/80 px-2 py-1.5 shadow-lg backdrop-blur-md">
        <Button
          variant={settingsOpen ? "secondary" : "ghost"}
          size="icon"
          className="relative size-8 rounded-full"
          onClick={() => setSettingsOpen(true)}
          aria-label={
            updateAvailable
              ? t("updates.badgeAriaLabel", { version: update?.latestVersion })
              : t("header.settingsTitle")
          }
        >
          <Settings className="size-4" />
          {updateAvailable && (
            <span
              aria-hidden="true"
              className="absolute right-0.5 top-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-card"
            />
          )}
        </Button>
        <ModeToggle />
        <LanguageSwitcher />
      </div>

      <Drawer
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        direction="right"
      >
        <DrawerContent className="h-full w-full sm:max-w-3xl lg:max-w-5xl">
          <DrawerHeader>
            <DrawerTitle>{t("header.settingsTitle")}</DrawerTitle>
            <DrawerDescription>
              {t("header.settingsDescription")}
            </DrawerDescription>
          </DrawerHeader>
          <div className="flex-1 overflow-hidden">
            <SettingsContent />
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
