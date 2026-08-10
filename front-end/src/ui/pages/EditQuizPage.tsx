import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { arrayMove } from "@dnd-kit/sortable";
import { ArrowLeft, List, Loader2, Save } from "lucide-react";

import { getQuizSetApi } from "@/features/quizz/api";
import { useUpdateQuizSet } from "@/features/quizz/hooks";
import type { QuizQuestion } from "@/features/quizz";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { QuestionEditor, QuestionNavigator } from "@/ui/components/edit-quiz";

type PendingDelete =
  | { kind: "question"; id: string }
  | { kind: "bulk"; ids: string[] }
  | { kind: "option"; questionId: string; optionId: string };

const newQuestion = (position: number): QuizQuestion => ({
  id: crypto.randomUUID(),
  questionNumber: position,
  type: "multiple-choice",
  questionText: "",
  options: [
    { id: crypto.randomUUID(), text: "" },
    { id: crypto.randomUUID(), text: "" },
  ],
  correctAnswerId: "",
  explanation: "",
});

/** The backend orders questions by `question_number`, so a reorder or a delete
 * only survives a reload if the whole list is renumbered before the PUT. */
const renumber = (list: QuizQuestion[]): QuizQuestion[] =>
  list.map((q, i) => (q.questionNumber === i + 1 ? q : { ...q, questionNumber: i + 1 }));

export function EditQuizPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const { data: quizSet, isLoading, error, refetch } = useQuery({
    queryKey: ["quizSet", id],
    queryFn: () => getQuizSetApi(id!),
    enabled: !!id,
  });

  const updateQuizSet = useUpdateQuizSet();

  const [title, setTitle] = useState("");
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  // A boolean flag rather than a snapshot diff: comparing a 200-question tree on
  // every render was the dominant cost while typing. Trade-off: manually undoing
  // an edit still counts as dirty.
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (!quizSet) return;
    const loaded: QuizQuestion[] = quizSet.questions
      ? JSON.parse(JSON.stringify(quizSet.questions))
      : [];
    /* eslint-disable react-hooks/set-state-in-effect */
    setTitle(quizSet.title || "");
    setQuestions(loaded);
    setActiveId(loaded[0]?.id ?? null);
    setIsDirty(false);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [quizSet]);

  // Electron puts Ctrl+R one keystroke away from wiping every unsaved edit, so
  // guard the reload too — the Back button has its own confirm.
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  const mutate = useCallback(
    (updater: (prev: QuizQuestion[]) => QuizQuestion[]) => {
      setQuestions(updater);
      setIsDirty(true);
    },
    [],
  );

  const activeIndex = useMemo(
    () => questions.findIndex((q) => q.id === activeId),
    [questions, activeId],
  );
  const activeQuestion = activeIndex >= 0 ? questions[activeIndex] : null;

  const updateActive = useCallback(
    <K extends keyof QuizQuestion>(field: K, value: QuizQuestion[K]) => {
      mutate((prev) =>
        prev.map((q) => (q.id === activeId ? { ...q, [field]: value } : q)),
      );
    },
    [activeId, mutate],
  );

  const updateOptionText = useCallback(
    (optionId: string, text: string) => {
      mutate((prev) =>
        prev.map((q) =>
          q.id === activeId
            ? {
                ...q,
                options: q.options.map((opt) =>
                  opt.id === optionId ? { ...opt, text } : opt,
                ),
              }
            : q,
        ),
      );
    },
    [activeId, mutate],
  );

  const addOption = useCallback(() => {
    mutate((prev) =>
      prev.map((q) =>
        q.id === activeId
          ? { ...q, options: [...q.options, { id: crypto.randomUUID(), text: "" }] }
          : q,
      ),
    );
  }, [activeId, mutate]);

  const removeOption = useCallback(
    (questionId: string, optionId: string) => {
      mutate((prev) =>
        prev.map((q) => {
          if (q.id !== questionId) return q;
          const options = q.options.filter((opt) => opt.id !== optionId);
          // Dropping the option that held the answer would otherwise leave
          // correctAnswerId pointing at an id that no longer exists.
          return {
            ...q,
            options,
            correctAnswerId:
              q.correctAnswerId === optionId
                ? (options[0]?.id ?? "")
                : q.correctAnswerId,
            correctAnswerIds: (q.correctAnswerIds ?? []).filter(
              (optId) => optId !== optionId,
            ),
          };
        }),
      );
    },
    [mutate],
  );

  const addQuestion = useCallback(() => {
    const created = newQuestion(questions.length + 1);
    mutate((prev) => [...prev, created]);
    setActiveId(created.id);
    setNavOpen(false);
  }, [questions.length, mutate]);

  const removeQuestions = useCallback(
    (ids: string[]) => {
      const doomed = new Set(ids);
      mutate((prev) => renumber(prev.filter((q) => !doomed.has(q.id))));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const removed of ids) next.delete(removed);
        return next;
      });
      setActiveId((prev) => {
        if (prev && !doomed.has(prev)) return prev;
        const survivors = questions.filter((q) => !doomed.has(q.id));
        const fallbackIndex = Math.min(
          Math.max(activeIndex, 0),
          survivors.length - 1,
        );
        return survivors[fallbackIndex]?.id ?? null;
      });
    },
    [mutate, questions, activeIndex],
  );

  const reorder = useCallback(
    (fromId: string, toId: string) => {
      mutate((prev) => {
        const from = prev.findIndex((q) => q.id === fromId);
        const to = prev.findIndex((q) => q.id === toId);
        if (from < 0 || to < 0) return prev;
        return renumber(arrayMove(prev, from, to));
      });
    },
    [mutate],
  );

  const toggleChecked = useCallback((questionId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });
  }, []);

  const setSelection = useCallback(
    (ids: string[]) => setSelectedIds(new Set(ids)),
    [],
  );

  const toggleSelectMode = useCallback(() => {
    setSelectMode((prev) => {
      if (prev) setSelectedIds(new Set());
      return !prev;
    });
  }, []);

  const selectQuestion = useCallback((questionId: string) => {
    setActiveId(questionId);
    setNavOpen(false);
  }, []);

  const handleSave = () => {
    updateQuizSet.mutate(
      { id: id!, payload: { title, questions: renumber(questions) } },
      {
        onSuccess: () => {
          setIsDirty(false);
          toast.success(t("editQuiz.saveSuccess"));
          navigate(quizSet?.folderId ? `/folder/${quizSet.folderId}` : "/");
        },
        onError: (err) => {
          toast.error(t("editQuiz.saveFailed"), { description: err.message });
        },
      },
    );
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    if (pendingDelete.kind === "option") {
      removeOption(pendingDelete.questionId, pendingDelete.optionId);
    } else if (pendingDelete.kind === "question") {
      removeQuestions([pendingDelete.id]);
    } else {
      removeQuestions(pendingDelete.ids);
    }
    setPendingDelete(null);
  };

  const deleteCopy = () => {
    if (pendingDelete?.kind === "option") {
      return {
        title: t("confirm.deleteOption.title"),
        description: t("confirm.deleteOption.desc"),
      };
    }
    if (pendingDelete?.kind === "bulk") {
      return {
        title: t("editQuiz.bulkDeleteTitle", { count: pendingDelete.ids.length }),
        description: t("editQuiz.bulkDeleteDesc"),
      };
    }
    return {
      title: t("confirm.deleteQuestion.title", { n: activeIndex + 1 }),
      description: t("confirm.deleteQuestion.desc"),
    };
  };

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Loader2 className="size-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !quizSet) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
        <p className="font-medium text-destructive">{t("editQuiz.loadFailed")}</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => refetch()}>
            {t("common.retry")}
          </Button>
          <Button variant="ghost" onClick={() => navigate(-1)}>
            {t("common.back")}
          </Button>
        </div>
      </div>
    );
  }

  const navigator = (
    <QuestionNavigator
      questions={questions}
      activeId={activeId}
      selectedIds={selectedIds}
      selectMode={selectMode}
      onSelectQuestion={selectQuestion}
      onToggleChecked={toggleChecked}
      onSetSelection={setSelection}
      onToggleSelectMode={toggleSelectMode}
      onAddQuestion={addQuestion}
      onReorder={reorder}
      onRequestBulkDelete={() =>
        setPendingDelete({ kind: "bulk", ids: [...selectedIds] })
      }
    />
  );

  const copy = deleteCopy();

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
      <h1 className="sr-only">{t("editQuiz.title")}</h1>
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-background/80 p-3 backdrop-blur-md supports-[backdrop-filter]:bg-background/60">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => (isDirty ? setDiscardOpen(true) : navigate(-1))}
          className="gap-1.5 px-2"
        >
          <ArrowLeft className="size-4" />
          {t("common.back")}
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 lg:hidden"
          onClick={() => setNavOpen(true)}
        >
          <List className="size-4" />
          {t("editQuiz.questionListTitle")}
        </Button>

        <Input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setIsDirty(true);
          }}
          placeholder={t("editQuiz.titlePlaceholder")}
          aria-label={t("editQuiz.titleLabel")}
          className="h-8 min-w-[12rem] flex-1 font-medium"
        />

        <Button
          onClick={handleSave}
          disabled={updateQuizSet.isPending || !isDirty}
          className="gap-2"
        >
          {updateQuizSet.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          {t("editQuiz.saveChanges")}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-80 shrink-0 border-r lg:block">
          {navigator}
        </aside>

        {/* Not a <main>: App.tsx already provides the page's main landmark. */}
        <section className="min-h-0 min-w-0 flex-1">
          {activeQuestion ? (
            <QuestionEditor
              key={activeQuestion.id}
              question={activeQuestion}
              index={activeIndex}
              total={questions.length}
              onChange={updateActive}
              onOptionTextChange={updateOptionText}
              onAddOption={addOption}
              onRequestDeleteOption={(optionId) =>
                setPendingDelete({
                  kind: "option",
                  questionId: activeQuestion.id,
                  optionId,
                })
              }
              onRequestDeleteQuestion={() =>
                setPendingDelete({ kind: "question", id: activeQuestion.id })
              }
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground">
              {t("editQuiz.noQuestions")}
            </div>
          )}
        </section>
      </div>

      <Drawer open={navOpen} onOpenChange={setNavOpen}>
        <DrawerContent className="h-[80vh]">
          <DrawerTitle className="sr-only">
            {t("editQuiz.questionListTitle")}
          </DrawerTitle>
          <div className="min-h-0 flex-1">{navigator}</div>
        </DrawerContent>
      </Drawer>

      <ConfirmDialog
        destructive
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={copy.title}
        description={copy.description}
        confirmLabel={t("common.delete")}
        onConfirm={confirmDelete}
      />

      <ConfirmDialog
        destructive
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={t("confirm.discardEdits.title")}
        description={t("confirm.discardEdits.desc")}
        confirmLabel={t("confirm.discardEdits.action")}
        onConfirm={() => navigate(-1)}
      />
    </div>
  );
}
