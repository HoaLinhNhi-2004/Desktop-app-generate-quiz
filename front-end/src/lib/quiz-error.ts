import i18n from "@/config/i18n";

export interface ParsedQuizError {
  title: string;
  description: string;
  duration?: number;
}

/**
 * Map a backend generation error onto a user-facing toast.
 *
 * Accepts a raw string as well as an Error so the streaming path can pass the
 * message straight from an SSE `error` frame. Uses the i18n singleton rather
 * than useTranslation because it is also called from stream callbacks, where no
 * component is necessarily mounted.
 */
export function parseQuizError(err: Error | string): ParsedQuizError {
  const msg = (typeof err === "string" ? err : err?.message) ?? "";

  // Quota / rate limit (HTTP 429)
  if (/429|quota exceeded|rate.?limit|free.?tier/i.test(msg)) {
    if (/all gemini models exhausted/i.test(msg)) {
      return {
        title: i18n.t("errors.allModelsExhausted.title"),
        description: i18n.t("errors.allModelsExhausted.description"),
        duration: 12000,
      };
    }
    const retryMatch =
      msg.match(/retry(?: in)? (\d+(?:\.\d+)?)\s*s/i) ??
      msg.match(/seconds: (\d+)/i);
    const retrySec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : null;
    const retryNote = retrySec
      ? ` ${i18n.t("errors.quotaExceeded.retryIn", { seconds: retrySec })}`
      : ` ${i18n.t("errors.quotaExceeded.retryLater")}`;
    return {
      title: i18n.t("errors.quotaExceeded.title"),
      description:
        i18n.t("errors.quotaExceeded.description") +
        retryNote +
        ` ${i18n.t("errors.quotaExceeded.checkBilling")}`,
      duration: 10000,
    };
  }

  if (/api key not configured|GEMINI_API_KEY|chưa có gemini/i.test(msg)) {
    return {
      title: i18n.t("errors.noApiKey.title"),
      description: i18n.t("errors.noApiKey.description"),
      duration: 8000,
    };
  }

  if (/401|invalid.?api.?key|api_key_invalid/i.test(msg)) {
    return {
      title: i18n.t("errors.invalidApiKey.title"),
      description: i18n.t("errors.invalidApiKey.description"),
      duration: 8000,
    };
  }

  if (/could not extract any text|no text content/i.test(msg)) {
    return {
      title: i18n.t("errors.noTextExtracted.title"),
      description: i18n.t("errors.noTextExtracted.description"),
      duration: 8000,
    };
  }

  if (/no transcripts|transcripts disabled|captions disabled/i.test(msg)) {
    return {
      title: i18n.t("errors.noTranscript.title"),
      description: i18n.t("errors.noTranscript.description"),
      duration: 8000,
    };
  }

  if (/invalid youtube url/i.test(msg)) {
    return {
      title: i18n.t("errors.invalidYoutubeUrl.title"),
      description: i18n.t("errors.invalidYoutubeUrl.description"),
      duration: 6000,
    };
  }

  if (/network|fetch|ECONNREFUSED|failed to fetch/i.test(msg)) {
    return {
      title: i18n.t("errors.networkError.title"),
      description: i18n.t("errors.networkError.description"),
      duration: 8000,
    };
  }

  return {
    title: i18n.t("errors.quizFailed.title"),
    description:
      msg.length > 200
        ? msg.slice(0, 200) + "…"
        : msg || i18n.t("errors.quizFailed.unknownError"),
    duration: 8000,
  };
}
