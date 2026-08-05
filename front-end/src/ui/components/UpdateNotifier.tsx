import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  useOpenReleasePage,
  useUpdateCheck,
  useUpdateDismissal,
} from "@/features/updates";

/**
 * Announces a newer GitHub release once per app session.
 *
 * Renders nothing — the persistent affordances are the badge on the settings
 * button and the card inside settings; this only surfaces the news unprompted,
 * the way VS Code does. "Later" silences this exact version for good.
 */
export function UpdateNotifier() {
  const { t } = useTranslation();
  const { data } = useUpdateCheck();
  const openReleasePage = useOpenReleasePage();
  const { isDismissed, dismiss } = useUpdateDismissal(data?.latestVersion);
  const announcedVersion = useRef<string | null>(null);

  useEffect(() => {
    if (data?.status !== "update-available" || !data.latestVersion) return;
    if (isDismissed) return;
    if (announcedVersion.current === data.latestVersion) return;
    announcedVersion.current = data.latestVersion;

    toast.info(t("updates.notice.title", { version: data.latestVersion }), {
      description: t("updates.notice.description", {
        current: data.currentVersion,
      }),
      duration: 20000,
      action: {
        label: t("updates.download"),
        onClick: () => {
          void openReleasePage(data.releaseUrl).then((opened) => {
            if (!opened) toast.error(t("updates.openFailed"));
          });
        },
      },
      cancel: {
        label: t("updates.later"),
        onClick: dismiss,
      },
    });
  }, [data, isDismissed, dismiss, openReleasePage, t]);

  return null;
}
