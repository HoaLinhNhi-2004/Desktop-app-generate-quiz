import { useCallback, useEffect, useRef, useState } from "react";

export type SpeechRate = "slow" | "normal" | "fast";

export interface SpeechOptions {
  lang?: string;
  rate?: SpeechRate;
  pitch?: number;
  onEnd?: () => void;
  onError?: () => void;
}

export interface UseSpeechReturn {
  supported: boolean;
  speakingId: string | null;
  speak: (text: string, id: string, options?: SpeechOptions) => void;
  stop: () => void;
}

const RATE_VALUE: Record<SpeechRate, number> = {
  slow: 0.7,
  normal: 1,
  fast: 1.4,
};

export function useSpeech(defaultOptions?: SpeechOptions): UseSpeechReturn {
  const supported =
    typeof window !== "undefined" && "speechSynthesis" in window;
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const stop = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    setSpeakingId(null);
  }, [supported]);

  const speak = useCallback(
    (text: string, id: string, options?: SpeechOptions) => {
      if (!supported || !text.trim()) return;
      window.speechSynthesis.cancel();

      const utt = new SpeechSynthesisUtterance(text);
      utt.lang = options?.lang ?? defaultOptions?.lang ?? "vi-VN";
      const rateKey = options?.rate ?? defaultOptions?.rate ?? "normal";
      utt.rate = RATE_VALUE[rateKey];
      utt.pitch = options?.pitch ?? defaultOptions?.pitch ?? 1;

      utt.onstart = () => setSpeakingId(id);
      utt.onend = () => {
        setSpeakingId(null);
        options?.onEnd?.();
      };
      utt.onerror = () => {
        setSpeakingId(null);
        options?.onError?.();
      };

      utteranceRef.current = utt;
      window.speechSynthesis.speak(utt);
    },
    [supported, defaultOptions],
  );

  useEffect(() => {
    return () => {
      if (supported) window.speechSynthesis.cancel();
    };
  }, [supported]);

  return { supported, speakingId, speak, stop };
}
