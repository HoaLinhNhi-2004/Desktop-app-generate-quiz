import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import confetti from "canvas-confetti";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useSpeech } from "@/lib/use-speech";
import { buildQuestionSpeech } from "@/lib/quiz-speech";
import { useA11y } from "@/config/a11y-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileSpreadsheet,
  Loader2,
  Printer,
  Download,
  Eye,
  FileText,
  Image as ImageIcon,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { DocxPreview } from "../components/DocxPreview";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { exportQuizToDocx, exportQuizToKahoot } from "@/lib/export";
import { QuizQuestion } from "../components/QuizQuestion";
import { QuizStreamPending } from "../components/QuizStreamPending";
import {
  useQuizDraft,
  useQuizSource,
  useQuizStreamContext,
} from "@/features/quizz";
import type {
  QuizQuestion as QuizQuestionType,
  QuizResult,
} from "@/features/quizz";
import { useSaveAttempt } from "@/features/stats";

export function QuizPage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { ttsEnabled, ttsRate } = useA11y();
  const reduceMotion = useReducedMotion();
  const speech = useSpeech({
    rate: ttsRate,
    lang: i18n.language === "en" ? "en-US" : "vi-VN",
  });

  const { job, stopQuizStream } = useQuizStreamContext();
  const source = useQuizSource(job);
  const {
    questions,
    expectedTotal,
    isLive,
    isStreamComplete,
    isRehydrating,
    sourceFiles,
    quizSetId,
    folderId,
  } = source;
  const loadedCount = questions.length;

  const { initialDraft, saveDraft, clearDraft } = useQuizDraft(quizSetId);
  const [answers, setAnswers] = useState<Record<string, string>>(
    initialDraft.answers,
  );
  const [currentIndex, setCurrentIndex] = useState(initialDraft.currentIndex);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [mountTime] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);

  // While streaming, the clock starts when question 1 lands: the user cannot
  // answer before that, and OCR minutes must not be charged to their attempt.
  const startTime = isLive ? source.firstQuestionAt : mountTime;

  const saveAttempt = useSaveAttempt();

  // Nothing to show and nothing on the way — go home.
  useEffect(() => {
    if (!isLive && !isRehydrating && loadedCount === 0) {
      navigate("/", { replace: true });
    }
  }, [isLive, isRehydrating, loadedCount, navigate]);

  useEffect(() => {
    saveDraft({ answers, currentIndex });
  }, [answers, currentIndex, saveDraft]);

  const currentQuestion = questions[currentIndex];

  // Timer
  useEffect(() => {
    if (isSubmitted || startTime === null) return;
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime, isSubmitted]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const handleAnswerChange = useCallback(
    (questionId: string, answerId: string) => {
      if (isSubmitted) return;
      setAnswers((prev) => ({ ...prev, [questionId]: answerId }));
    },
    [isSubmitted],
  );

  const handleToggleRead = useCallback(
    (q: QuizQuestionType) => {
      if (!ttsEnabled || !speech.supported) return;
      if (speech.speakingId === q.id) {
        speech.stop();
        return;
      }
      const text = buildQuestionSpeech(q, t, isSubmitted);
      speech.speak(text, q.id);
    },
    [ttsEnabled, speech, t, isSubmitted],
  );

  const answeredCount = Object.keys(answers).length;
  // Progress is measured against the target, not against what happens to have
  // arrived, so the bar does not jump backwards as questions stream in.
  const progressPercent =
    expectedTotal > 0 ? (answeredCount / expectedTotal) * 100 : 0;
  const canSubmit = answeredCount > 0 && (!isLive || isStreamComplete);

  const result: QuizResult | null = useMemo(() => {
    if (!isSubmitted) return null;

    const questionResults = questions.map((q) => {
      const isMulti = q.type === "multiple-answer";
      const selectedRaw = answers[q.id] || null;
      const selectedIdsArr = isMulti
        ? (selectedRaw || "").split(",").filter(Boolean).sort()
        : [];
      const correctIdsArr = isMulti
        ? (q.correctAnswerIds ?? []).slice().sort()
        : [];
      const isCorrect = isMulti
        ? selectedIdsArr.join(",") === correctIdsArr.join(",")
        : selectedRaw === q.correctAnswerId;
      return {
        questionId: q.id,
        questionText: q.questionText,
        selectedAnswerId: isMulti ? null : selectedRaw,
        selectedAnswerIds: isMulti ? selectedIdsArr : undefined,
        correctAnswerId: q.correctAnswerId,
        correctAnswerIds: isMulti ? correctIdsArr : undefined,
        isCorrect,
      };
    });

    const correct = questionResults.filter((r) => r.isCorrect).length;
    const skipped = questionResults.filter(
      (r) => r.selectedAnswerId === null && !r.selectedAnswerIds?.length,
    ).length;

    return {
      totalQuestions: questions.length,
      correctAnswers: correct,
      wrongAnswers: questions.length - correct - skipped,
      skippedQuestions: skipped,
      score: (correct / questions.length) * 100,
      timeTaken: elapsed,
      questionResults,
    };
  }, [isSubmitted, questions, answers, elapsed]);

  const handleSubmit = useCallback(() => {
    // Freeze the job first so every denominator below counts only what the user
    // was actually shown.
    if (isLive && !isStreamComplete) stopQuizStream();
    setIsSubmitted(true);
    clearDraft();

    // Confetti effect
    const correctCount = questions.filter((q) => {
      const isMulti = q.type === "multiple-answer";
      const raw = answers[q.id] || null;
      if (isMulti) {
        const sel = (raw || "").split(",").filter(Boolean).sort();
        const cor = (q.correctAnswerIds ?? []).slice().sort();
        return sel.join(",") === cor.join(",");
      }
      return raw === q.correctAnswerId;
    }).length;
    const scorePercent = (correctCount / questions.length) * 100;

    // Initial burst
    setTimeout(() => {
      confetti({
        particleCount: scorePercent >= 80 ? 150 : scorePercent >= 50 ? 80 : 40,
        spread: 70,
        origin: { y: 0.6 },
      });
    }, 100);

    // Side streams for good scores
    if (scorePercent >= 50) {
      setTimeout(() => {
        confetti({
          particleCount: 50,
          angle: 60,
          spread: 55,
          origin: { x: 0, y: 0.7 },
        });
        confetti({
          particleCount: 50,
          angle: 120,
          spread: 55,
          origin: { x: 1, y: 0.7 },
        });
      }, 400);
    }

    // Continuous streams for excellent scores
    if (scorePercent >= 80) {
      const duration = 2500;
      const end = Date.now() + duration;
      const frame = () => {
        confetti({
          particleCount: 3,
          angle: 60,
          spread: 55,
          origin: { x: 0, y: 0.6 },
        });
        confetti({
          particleCount: 3,
          angle: 120,
          spread: 55,
          origin: { x: 1, y: 0.6 },
        });
        if (Date.now() < end) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }

    // Save attempt to backend (fire-and-forget)
    if (quizSetId) {
      const questionResults = questions.map((q) => {
        const isMulti = q.type === "multiple-answer";
        const selectedRaw = answers[q.id] || null;
        const selectedIdsArr = isMulti
          ? (selectedRaw || "").split(",").filter(Boolean).sort()
          : [];
        const correctIdsArr = isMulti
          ? (q.correctAnswerIds ?? []).slice().sort()
          : [];
        const isCorrect = isMulti
          ? selectedIdsArr.join(",") === correctIdsArr.join(",")
          : selectedRaw === q.correctAnswerId;
        return {
          questionId: q.id,
          questionText: q.questionText,
          selectedAnswerId: isMulti ? null : selectedRaw,
          selectedAnswerIds: isMulti ? selectedIdsArr : undefined,
          correctAnswerId: q.correctAnswerId,
          correctAnswerIds: isMulti ? correctIdsArr : undefined,
          isCorrect,
        };
      });
      const correct = questionResults.filter((r) => r.isCorrect).length;
      const skipped = questionResults.filter(
        (r) => r.selectedAnswerId === null && !r.selectedAnswerIds?.length,
      ).length;
      saveAttempt.mutate({
        quizSetId,
        folderId: folderId || undefined,
        score: (correct / questions.length) * 100,
        correctCount: correct,
        wrongCount: questions.length - correct - skipped,
        skippedCount: skipped,
        totalQuestions: questions.length,
        timeTaken: elapsed,
        questionResults,
      });
    }
  }, [
    quizSetId,
    folderId,
    questions,
    answers,
    elapsed,
    saveAttempt,
    isLive,
    isStreamComplete,
    stopQuizStream,
    clearDraft,
  ]);

  const handleRetry = () => {
    setAnswers({});
    setCurrentIndex(0);
    setIsSubmitted(false);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when user is typing
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      // Don't intercept modifier combos
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // R key: toggle read-aloud (works in both quiz + result modes)
      if (e.key === "r" || e.key === "R") {
        if (!ttsEnabled || !speech.supported || !currentQuestion) return;
        e.preventDefault();
        handleToggleRead(currentQuestion);
        return;
      }

      // The remaining shortcuts only apply while the quiz is active
      if (isSubmitted) return;

      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          setCurrentIndex((i) => Math.max(0, i - 1));
          break;
        case "ArrowRight":
          e.preventDefault();
          setCurrentIndex((i) => Math.min(questions.length - 1, i + 1));
          break;
        case "Enter": {
          e.preventDefault();
          // While streaming, question 1 *is* the last loaded question — Enter
          // must not submit a one-question quiz.
          if (currentIndex === questions.length - 1) {
            if (canSubmit) handleSubmit();
          } else {
            setCurrentIndex((i) => Math.min(questions.length - 1, i + 1));
          }
          break;
        }
        default: {
          if (!currentQuestion) break;
          const key = e.key.toUpperCase();
          let optionIndex = -1;
          if (key.length === 1 && key >= "A" && key <= "D") {
            optionIndex = key.charCodeAt(0) - 65;
          } else if (key.length === 1 && key >= "1" && key <= "4") {
            optionIndex = parseInt(key) - 1;
          }
          if (
            optionIndex >= 0 &&
            currentQuestion.type !== "fill-blank" &&
            currentQuestion.options[optionIndex]
          ) {
            e.preventDefault();
            const optId = currentQuestion.options[optionIndex].id;
            if (currentQuestion.type === "multiple-answer") {
              // Toggle the selected option
              const current = answers[currentQuestion.id] || "";
              const currentSet = new Set(current.split(",").filter(Boolean));
              if (currentSet.has(optId)) currentSet.delete(optId);
              else currentSet.add(optId);
              handleAnswerChange(
                currentQuestion.id,
                [...currentSet].sort().join(","),
              );
            } else {
              handleAnswerChange(currentQuestion.id, optId);
            }
          }
          break;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    isSubmitted,
    currentIndex,
    questions.length,
    currentQuestion,
    handleAnswerChange,
    handleSubmit,
    canSubmit,
    answers,
    ttsEnabled,
    speech.supported,
    handleToggleRead,
  ]);

  // A live job renders the full chrome even before the first question lands.
  if (loadedCount === 0 && !isLive) {
    return null;
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 min-h-0 gap-6 overflow-hidden p-6">
      {/* Main quiz area */}
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {/* Top bar */}
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/")}
            className="gap-1.5"
          >
            <ArrowLeft className="size-4" />
            {t("quiz.back")}
          </Button>
          <div className="flex items-center gap-3">
            {sourceFiles.length > 0 && (
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 hidden sm:flex text-muted-foreground hover:text-foreground"
                  >
                    <Eye className="size-4" />
                    {t("quiz.viewDoc")}
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col p-0 overflow-hidden">
                  <DialogHeader className="px-6 py-4 border-b shrink-0">
                    <DialogTitle>{t("quiz.docTitle")}</DialogTitle>
                  </DialogHeader>
                  <ScrollArea className="flex-1">
                    <div className="p-6 space-y-8">
                      {sourceFiles.map((f) => (
                        <div key={f.id} className="space-y-3">
                          <h3 className="font-medium flex items-center gap-2 text-primary">
                            {f.type === "application/pdf" ? (
                              <FileText className="size-5 text-red-500" />
                            ) : (
                              <ImageIcon className="size-5 text-blue-500" />
                            )}
                            {f.name}
                          </h3>
                          {f.preview ? (
                            f.type === "application/pdf" ? (
                              <iframe
                                src={`${f.preview}#toolbar=0`}
                                title={f.name}
                                className="w-full h-[65vh] border rounded-lg bg-muted/30"
                              />
                            ) : f.type.includes("wordprocessingml") ||
                              f.type.includes("msword") ? (
                              <DocxPreview url={f.preview} />
                            ) : (
                              <img
                                src={f.preview}
                                alt={f.name}
                                className="w-full rounded-lg object-contain bg-muted/30 max-h-[65vh]"
                              />
                            )
                          ) : (
                            <p className="text-sm text-muted-foreground italic">
                              {t("quiz.noPreview")}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </DialogContent>
              </Dialog>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={loadedCount === 0}
                >
                  <Download className="size-4" />
                  {t("quiz.export")}
                  <ChevronDown className="size-3 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <FileText className="size-4" />
                    {t("quiz.downloadDocx")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem
                      onClick={() =>
                        exportQuizToDocx(questions, t("quiz.title"), true)
                      }
                    >
                      {t("quiz.withAnswers")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        exportQuizToDocx(questions, t("quiz.title"), false)
                      }
                    >
                      {t("quiz.withoutAnswers")}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem onClick={() => exportQuizToKahoot(questions)}>
                  <FileSpreadsheet className="size-4" />
                  {t("quiz.exportKahoot")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => window.print()}>
                  <Printer className="size-4" />
                  {t("quiz.downloadPdf")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Badge
              variant="outline"
              className="gap-1.5 px-3 py-1 hidden lg:flex"
              aria-hidden="true"
            >
              <Clock className="size-3.5" aria-hidden="true" />
              {formatTime(elapsed)}
            </Badge>
            <Badge
              variant="secondary"
              className="px-3 py-1"
              role="status"
              aria-live="polite"
            >
              {answeredCount}/{expectedTotal} {t("quiz.answered")}
            </Badge>
          </div>
        </div>

        {/* Progress */}
        <div className="space-y-1.5">
          <Progress value={progressPercent} className="h-2" />
          <p className="text-xs text-muted-foreground text-right">
            {Math.round(progressPercent)}% {t("quiz.complete")}
          </p>
        </div>

        {/* Count-only live region: with read-aloud on, announcing the question
            text here would make the screen reader repeat it on every arrival. */}
        <span className="sr-only" role="status" aria-live="polite">
          {isLive
            ? t("a11y.live.questionArrived", {
                n: loadedCount,
                total: expectedTotal,
              })
            : ""}
        </span>

        {source.error && loadedCount > 0 && (
          <div
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {t("quiz.stream.failedPartial", { count: loadedCount })}
          </div>
        )}

        {/* Question card */}
        <Card className="flex min-h-0 flex-1 flex-col">
          <CardContent className="min-h-0 flex-1 p-0">
            <ScrollArea className="h-full">
              <div className="p-6">
                {isSubmitted ? (
                  // Show all questions with results
                  <div className="space-y-6 pr-4">
                    {questions.map((q) => (
                      <div key={q.id}>
                        <QuizQuestion
                          question={q}
                          selectedAnswer={answers[q.id]}
                          onAnswerChange={handleAnswerChange}
                          showResult
                          onToggleRead={
                            ttsEnabled && speech.supported
                              ? handleToggleRead
                              : undefined
                          }
                          isReading={speech.speakingId === q.id}
                        />
                        {q.id !== questions[questions.length - 1].id && (
                          <Separator className="mt-6" />
                        )}
                      </div>
                    ))}
                  </div>
                ) : currentQuestion ? (
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={currentQuestion.id}
                      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={
                        reduceMotion ? { opacity: 1 } : { opacity: 0, y: -6 }
                      }
                      transition={{
                        duration: reduceMotion ? 0 : 0.18,
                        ease: "easeOut",
                      }}
                    >
                      <QuizQuestion
                        question={currentQuestion}
                        selectedAnswer={answers[currentQuestion.id]}
                        onAnswerChange={handleAnswerChange}
                        onToggleRead={
                          ttsEnabled && speech.supported
                            ? handleToggleRead
                            : undefined
                        }
                        isReading={speech.speakingId === currentQuestion.id}
                      />
                    </motion.div>
                  </AnimatePresence>
                ) : (
                  <QuizStreamPending
                    source={source}
                    onBackToFolder={
                      folderId ? () => navigate(`/folder/${folderId}`) : undefined
                    }
                  />
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Navigation buttons */}
        {!isSubmitted && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
                disabled={currentIndex === 0}
                className="gap-1.5"
              >
                <ArrowLeft className="size-4" />
                {t("quiz.prevQuestion")}
              </Button>

              <div className="flex-1 flex justify-center mx-4">
                <span className="text-sm font-medium text-muted-foreground">
                  {t("quiz.questionOf", {
                    current: currentIndex + 1,
                    total: expectedTotal,
                  })}
                </span>
              </div>

              {currentIndex < loadedCount - 1 ? (
                <Button
                  onClick={() =>
                    setCurrentIndex((i) => Math.min(loadedCount - 1, i + 1))
                  }
                  className="gap-1.5"
                >
                  {t("quiz.nextQuestion")}
                  <ArrowRight className="size-4" />
                </Button>
              ) : isLive && !isStreamComplete ? (
                <Button disabled className="gap-1.5">
                  <Loader2 className="size-4 animate-spin" />
                  {t("quiz.stream.waitingNext")}
                </Button>
              ) : (
                <Button disabled className="gap-1.5">
                  {t("quiz.nextQuestion")}
                  <ArrowRight className="size-4" />
                </Button>
              )}
            </div>
            {/* Keyboard hint */}
            <p className="text-center text-[11px] text-muted-foreground/60 select-none hidden sm:block">
              <kbd className="font-mono">←</kbd>
              <kbd className="font-mono">→</kbd> {t("quiz.shortcuts.navigate")}{" "}
              &nbsp;·&nbsp;
              <kbd className="font-mono">A</kbd>
              <kbd className="font-mono">B</kbd>
              <kbd className="font-mono">C</kbd>
              <kbd className="font-mono">D</kbd>{" "}
              {t("quiz.shortcuts.selectAnswer")} &nbsp;·&nbsp;
              <kbd className="font-mono">Enter</kbd>{" "}
              {t("quiz.shortcuts.nextOrSubmit")}
              {ttsEnabled && speech.supported && (
                <>
                  {" "}
                  &nbsp;·&nbsp;
                  <kbd className="font-mono">R</kbd>{" "}
                  {t("a11y.shortcuts.readQuestion")}
                </>
              )}
            </p>
          </div>
        )}
      </div>

      {/* Right sidebar - Score / Question map */}
      <div className="flex min-h-0 w-72 shrink-0 flex-col space-y-4 overflow-y-auto">
        {isSubmitted && result ? (
          // Result panel
          <Card
            className="overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500"
            role="region"
            aria-label={t("quiz.results.correct")}
          >
            <div
              className={cn(
                "px-6 pt-6 pb-5 text-center",
                result.score >= 80
                  ? "bg-linear-to-b from-green-500/15 to-transparent"
                  : result.score >= 50
                    ? "bg-linear-to-b from-yellow-500/15 to-transparent"
                    : "bg-linear-to-b from-red-500/15 to-transparent",
              )}
            >
              <div className="flex flex-col items-center gap-3">
                <div
                  className={cn(
                    "flex size-28 items-center justify-center rounded-full border-[5px] shadow-lg",
                    result.score >= 80
                      ? "border-green-500 shadow-green-500/25"
                      : result.score >= 50
                        ? "border-yellow-500 shadow-yellow-500/25"
                        : "border-red-500 shadow-red-500/25",
                  )}
                >
                  <span
                    className={cn(
                      "text-4xl font-bold",
                      result.score >= 80
                        ? "text-green-500"
                        : result.score >= 50
                          ? "text-yellow-500"
                          : "text-red-500",
                    )}
                  >
                    {Math.round(result.score)}%
                  </span>
                </div>
                <div className="text-center">
                  <p className="font-semibold text-lg">
                    {result.score >= 80
                      ? t("quiz.results.excellent")
                      : result.score >= 50
                        ? t("quiz.results.good")
                        : t("quiz.results.needsWork")}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {result.correctAnswers}/{result.totalQuestions}{" "}
                    {t("quiz.results.correct").toLowerCase()}
                  </p>
                </div>
              </div>
            </div>

            <CardContent className="p-5 space-y-4">
              {/* Stat bars */}
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground flex items-center gap-1.5">
                      <div className="size-2.5 rounded-full bg-green-500" />
                      {t("quiz.results.correct")}
                    </span>
                    <span className="font-semibold text-green-500">
                      {result.correctAnswers}/{result.totalQuestions}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-green-500 transition-all duration-1000 ease-out"
                      style={{
                        width: `${(result.correctAnswers / result.totalQuestions) * 100}%`,
                      }}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground flex items-center gap-1.5">
                      <div className="size-2.5 rounded-full bg-red-500" />
                      {t("quiz.results.wrong")}
                    </span>
                    <span className="font-semibold text-red-500">
                      {result.wrongAnswers}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-red-500 transition-all duration-1000 ease-out"
                      style={{
                        width: `${(result.wrongAnswers / result.totalQuestions) * 100}%`,
                      }}
                    />
                  </div>
                </div>

                {result.skippedQuestions > 0 && (
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground flex items-center gap-1.5">
                        <div className="size-2.5 rounded-full bg-muted-foreground/40" />
                        {t("quiz.results.skipped")}
                      </span>
                      <span className="font-semibold text-muted-foreground">
                        {result.skippedQuestions}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-muted-foreground/40 transition-all duration-1000 ease-out"
                        style={{
                          width: `${(result.skippedQuestions / result.totalQuestions) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-center gap-2 py-2.5 rounded-lg bg-muted/50">
                <Clock
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="text-sm font-medium">
                  {formatTime(result.timeTaken)}
                </span>
              </div>

              {/* Screen-reader announcer for final score */}
              <span className="sr-only" role="status" aria-live="polite">
                {t("a11y.live.scoreAnnounce", {
                  score: Math.round(result.score),
                  correct: result.correctAnswers,
                  total: result.totalQuestions,
                })}
              </span>

              <Separator />

              {/* Actions */}
              <div className="space-y-2">
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  onClick={handleRetry}
                >
                  {t("quiz.results.retake")}
                </Button>
                <Button className="w-full gap-2" onClick={() => navigate("/")}>
                  {t("quiz.results.newQuiz")}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Question navigator */}
            <div className="flex min-h-0 flex-1 flex-col gap-4">
              <Card className="flex min-h-0 flex-1 flex-col">
                <CardHeader className="pb-3 shrink-0">
                  <CardTitle className="text-sm font-medium">
                    {t("quiz.questionList")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="min-h-0 flex-1 p-0">
                  <ScrollArea className="h-full">
                    <div className="px-6 pb-6">
                      <div className="grid grid-cols-5 gap-2">
                        {Array.from(
                          { length: Math.max(expectedTotal, loadedCount) },
                          (_, i) => questions[i],
                        ).map((q, i) =>
                          q ? (
                            <motion.button
                              key={q.id}
                              type="button"
                              initial={
                                reduceMotion ? false : { scale: 0.9, opacity: 0 }
                              }
                              animate={{ scale: 1, opacity: 1 }}
                              transition={{ duration: reduceMotion ? 0 : 0.15 }}
                              onClick={() => setCurrentIndex(i)}
                              aria-current={
                                i === currentIndex ? "true" : undefined
                              }
                              aria-label={t("quiz.questionOf", {
                                current: i + 1,
                                total: expectedTotal,
                              })}
                              className={cn(
                                "flex size-10 items-center justify-center rounded-md text-sm font-medium transition-all",
                                i === currentIndex
                                  ? "bg-primary text-primary-foreground ring-2 ring-primary/30"
                                  : answers[q.id]
                                    ? "bg-green-500/15 text-green-500 border border-green-500/30"
                                    : "bg-muted text-muted-foreground hover:bg-muted/80",
                              )}
                            >
                              {i + 1}
                            </motion.button>
                          ) : (
                            // `disabled` also removes it from the tab order.
                            <button
                              key={`pending-${i}`}
                              type="button"
                              disabled
                              aria-label={t("quiz.stream.pendingSlot", {
                                n: i + 1,
                              })}
                              className="flex size-10 items-center justify-center rounded-md border border-dashed bg-muted/40 text-sm font-medium text-muted-foreground/40"
                            >
                              {i === loadedCount ? (
                                <Loader2 className="size-3 animate-spin" />
                              ) : (
                                i + 1
                              )}
                            </button>
                          ),
                        )}
                      </div>

                      <Separator className="my-4" />

                      <div className="space-y-2 text-xs text-muted-foreground">
                        <div className="flex items-center gap-2">
                          <div className="size-3 rounded-sm bg-primary" />
                          <span>{t("quiz.viewing")}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="size-3 rounded-sm bg-green-500/15 border border-green-500/30" />
                          <span>{t("quiz.answeredStatus")}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="size-3 rounded-sm bg-muted" />
                          <span>{t("quiz.unanswered")}</span>
                        </div>
                        {isLive && !isStreamComplete && (
                          <div className="flex items-center gap-2">
                            <div className="size-3 rounded-sm border border-dashed bg-muted/40" />
                            <span>{t("quiz.stream.pendingLegend")}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>

              <div className="shrink-0 space-y-2">
                <Button
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  className="w-full gap-2"
                  size="lg"
                >
                  {isLive && !isStreamComplete ? (
                    <>
                      <Loader2 className="size-5 animate-spin" />
                      {t("quiz.stream.generating", {
                        loaded: loadedCount,
                        total: expectedTotal,
                      })}
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="size-5" />
                      {t("quiz.submitCount", {
                        count: answeredCount,
                        total: expectedTotal,
                      })}
                    </>
                  )}
                </Button>

                {isLive && !isStreamComplete && loadedCount > 0 && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="sm" className="w-full">
                        {t("quiz.stream.stopAndSubmit")}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t("quiz.stream.stopConfirmTitle")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("quiz.stream.stopConfirmDesc", {
                            count: loadedCount,
                          })}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>
                          {t("common.cancel")}
                        </AlertDialogCancel>
                        <AlertDialogAction onClick={handleSubmit}>
                          {t("quiz.stream.stopConfirmAction")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
