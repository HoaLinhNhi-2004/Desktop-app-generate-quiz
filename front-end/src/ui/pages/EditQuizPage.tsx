import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, Save, Loader2, Plus, Trash2 } from "lucide-react";

import { getQuizSetApi } from "@/features/quizz/api";
import { useUpdateQuizSet } from "@/features/quizz/hooks";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { QuestionType, QuizQuestion } from "@/features/quizz/types";

const EDITABLE_TYPES: QuestionType[] = [
  "multiple-choice",
  "multiple-answer",
  "true-false",
];

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
  // Snapshot of what was loaded, so "dirty" means "differs from the server"
  // rather than "the user touched something and undid it".
  const [pristine, setPristine] = useState("");

  useEffect(() => {
    if (quizSet) {
      const loadedTitle = quizSet.title || "";
      const loadedQuestions: QuizQuestion[] = quizSet.questions
        ? JSON.parse(JSON.stringify(quizSet.questions))
        : [];
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPristine(
        JSON.stringify({ title: loadedTitle, questions: loadedQuestions }),
      );
      setTitle(loadedTitle);
      setQuestions(loadedQuestions);
    }
  }, [quizSet]);

  const isDirty = useMemo(() => {
    if (!pristine) return false;
    return JSON.stringify({ title, questions }) !== pristine;
  }, [title, questions, pristine]);

  // The app runs in Electron where Ctrl+R is one keystroke away from wiping
  // every unsaved edit, so guard the reload too — not just in-app navigation.
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center min-h-0">
        <Loader2 className="size-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !quizSet) {
    return (
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3">
        <p className="text-destructive font-medium">{t("editQuiz.loadFailed")}</p>
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

  const handleSave = () => {
    updateQuizSet.mutate(
      { id: id!, payload: { title, questions } },
      {
        onSuccess: () => {
          toast.success(t("editQuiz.saveSuccess"));
          navigate(`/folder/${quizSet.folderId}`);
        },
        onError: (err) => {
          toast.error(t("editQuiz.saveFailed"), { description: err.message });
        }
      }
    );
  };

  const updateQuestion = <K extends keyof QuizQuestion>(index: number, field: K, value: QuizQuestion[K]) => {
    const newQs = [...questions];
    newQs[index] = { ...newQs[index], [field]: value };
    setQuestions(newQs);
  };

  const updateOption = (qIndex: number, optIndex: number, text: string) => {
    const newQs = [...questions];
    const newOpts = [...newQs[qIndex].options];
    newOpts[optIndex] = { ...newOpts[optIndex], text };
    newQs[qIndex] = { ...newQs[qIndex], options: newOpts };
    setQuestions(newQs);
  };

  const addOption = (qIndex: number) => {
    const newQs = [...questions];
    const newId = `opt_${Date.now()}`;
    newQs[qIndex] = {
      ...newQs[qIndex],
      options: [...newQs[qIndex].options, { id: newId, text: "" }],
    };
    setQuestions(newQs);
  };

  const removeOption = (qIndex: number, optIndex: number) => {
    const question = questions[qIndex];
    const removedId = question.options[optIndex].id;
    const options = question.options.filter((_, i) => i !== optIndex);
    // Dropping the option that held the correct answer would otherwise leave
    // correctAnswerId pointing at an id that no longer exists.
    const correctAnswerIds = (question.correctAnswerIds ?? []).filter(
      (optId) => optId !== removedId,
    );
    const correctAnswerId =
      question.correctAnswerId === removedId
        ? (options[0]?.id ?? "")
        : question.correctAnswerId;

    const newQs = [...questions];
    newQs[qIndex] = { ...question, options, correctAnswerId, correctAnswerIds };
    setQuestions(newQs);
  };

  const addQuestion = () => {
    setQuestions([
      ...questions,
      {
        id: `new_${Date.now()}`,
        questionNumber: questions.length + 1,
        type: "multiple-choice",
        questionText: "",
        options: [
          { id: "a", text: "" },
          { id: "b", text: "" }
        ],
        correctAnswerId: "a",
        explanation: "",
      } as QuizQuestion
    ]);
  };

  const removeQuestion = (index: number) => {
    const newQs = [...questions];
    newQs.splice(index, 1);
    setQuestions(newQs);
  };

  const goBack = () => navigate(-1);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 min-h-0 flex-col gap-6 p-6 overflow-y-auto">
      <div className="sticky top-0 z-50 flex items-center justify-between shrink-0 rounded-lg bg-background/80 p-3 backdrop-blur-md supports-[backdrop-filter]:bg-background/60 border border-border/50 shadow-sm -mx-2 -mt-2">
        <div className="flex items-center gap-3">
          {isDirty ? (
            <ConfirmDialog
              destructive
              title={t("confirm.discardEdits.title")}
              description={t("confirm.discardEdits.desc")}
              confirmLabel={t("confirm.discardEdits.action")}
              onConfirm={goBack}
            >
              <Button variant="ghost" size="sm" className="gap-1.5 px-2">
                <ArrowLeft className="size-4" />
                {t("common.back")}
              </Button>
            </ConfirmDialog>
          ) : (
            <Button variant="ghost" size="sm" onClick={goBack} className="gap-1.5 px-2">
              <ArrowLeft className="size-4" />
              {t("common.back")}
            </Button>
          )}
          <h1 className="text-xl font-bold">{t("editQuiz.title")}</h1>
        </div>
        <Button
          onClick={handleSave}
          disabled={updateQuizSet.isPending || !isDirty}
          className="gap-2"
        >
          {updateQuizSet.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          {t("editQuiz.saveChanges")}
        </Button>
      </div>

      <Card className="shrink-0">
        <CardHeader>
          <CardTitle>{t("editQuiz.detailsTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2">
            <Label htmlFor="title">{t("editQuiz.titleLabel")}</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("editQuiz.titlePlaceholder")}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between mt-4">
        <h2 className="text-lg font-semibold">
          {t("editQuiz.questionsHeading", { count: questions.length })}
        </h2>
        <Button variant="outline" size="sm" onClick={addQuestion} className="gap-1.5">
          <Plus className="size-4" /> {t("editQuiz.addQuestion")}
        </Button>
      </div>

      <div className="space-y-6 pb-12">
        {questions.map((q, qIndex) => (
          <Card key={q.id || qIndex}>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="flex items-center justify-center size-6 rounded-full bg-primary/10 text-primary font-bold text-xs">
                  {qIndex + 1}
                </span>
                <Select
                  value={q.type}
                  onValueChange={(val) => updateQuestion(qIndex, "type", val as QuestionType)}
                >
                  <SelectTrigger
                    className="w-[180px] h-8 text-xs"
                    aria-label={t("editQuiz.questionTypePlaceholder")}
                  >
                    <SelectValue placeholder={t("editQuiz.questionTypePlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {EDITABLE_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {t(`quizConfig.types.${type}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <ConfirmDialog
                destructive
                title={t("confirm.deleteQuestion.title", { n: qIndex + 1 })}
                description={t("confirm.deleteQuestion.desc")}
                confirmLabel={t("common.delete")}
                onConfirm={() => removeQuestion(qIndex)}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  aria-label={t("editQuiz.deleteQuestion")}
                >
                  <Trash2 className="size-4" />
                </Button>
              </ConfirmDialog>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-2">
                <Label htmlFor={`question-text-${qIndex}`}>
                  {t("editQuiz.questionTextLabel")}
                </Label>
                <Textarea
                  id={`question-text-${qIndex}`}
                  value={q.questionText}
                  onChange={(e) => updateQuestion(qIndex, "questionText", e.target.value)}
                  rows={2}
                  className="resize-none"
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span
                    id={`options-label-${qIndex}`}
                    className="text-sm font-medium leading-none"
                  >
                    {t("editQuiz.optionsLabel")}
                  </span>
                  {q.type !== "true-false" && (
                    <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={() => addOption(qIndex)}>
                      <Plus className="size-3 mr-1" /> {t("editQuiz.addOption")}
                    </Button>
                  )}
                </div>

                {q.type === "true-false" && q.options.length !== 2 && (
                   <span className="text-xs text-destructive">
                     {t("editQuiz.trueFalseWarning")}
                   </span>
                )}

                <div className="space-y-2" role="group" aria-labelledby={`options-label-${qIndex}`}>
                  {q.options.map((opt, optIndex) => (
                    <div key={opt.id} className="flex items-center gap-2">
                      <input
                        type={q.type === "multiple-answer" ? "checkbox" : "radio"}
                        name={`correct_${q.id}`}
                        aria-label={t("editQuiz.markCorrect")}
                        checked={q.type === "multiple-answer"
                          ? (q.correctAnswerIds?.includes(opt.id) || false)
                          : q.correctAnswerId === opt.id
                        }
                        onChange={(e) => {
                          if (q.type === "multiple-answer") {
                            const current = q.correctAnswerIds || [];
                            const next = e.target.checked
                              ? [...current, opt.id]
                              : current.filter(id => id !== opt.id);
                            updateQuestion(qIndex, "correctAnswerIds", next);
                          } else {
                            updateQuestion(qIndex, "correctAnswerId", opt.id);
                          }
                        }}
                        className="size-4 cursor-pointer"
                      />
                      <Input
                        value={opt.text}
                        onChange={(e) => updateOption(qIndex, optIndex, e.target.value)}
                        className="h-8 flex-1"
                        placeholder={t("editQuiz.optionPlaceholder")}
                        aria-label={t("editQuiz.optionPlaceholder")}
                      />
                      {q.type !== "true-false" && (
                        <ConfirmDialog
                          destructive
                          title={t("confirm.deleteOption.title")}
                          description={t("confirm.deleteOption.desc")}
                          confirmLabel={t("common.delete")}
                          onConfirm={() => removeOption(qIndex, optIndex)}
                        >
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0"
                            aria-label={t("editQuiz.deleteOption")}
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        </ConfirmDialog>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-2 border-t pt-4">
                <Label htmlFor={`explanation-${qIndex}`} className="text-muted-foreground">
                  {t("editQuiz.explanationLabel")}
                </Label>
                <Textarea
                  id={`explanation-${qIndex}`}
                  value={q.explanation || ""}
                  onChange={(e) => updateQuestion(qIndex, "explanation", e.target.value)}
                  rows={1}
                  className="resize-none text-sm"
                  placeholder={t("editQuiz.explanationPlaceholder")}
                />
              </div>
            </CardContent>
          </Card>
        ))}
        {questions.length === 0 && (
          <div className="text-center py-10 text-muted-foreground border rounded-lg border-dashed">
            {t("editQuiz.noQuestions")}
          </div>
        )}
      </div>
    </div>
  );
}
