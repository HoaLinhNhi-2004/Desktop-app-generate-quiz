/**
 * SpreadsheetSourceViewer — Read-only viewer for Excel/CSV sourced quizzes.
 *
 * Layout: Dialog (90vw × 88vh)
 *   Left  38%: scrollable question list
 *   Right 62%: Excel sheet viewer with tabs
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  X,
  FileSpreadsheet,
  ChevronRight,
  Loader2,
  TableProperties,
} from "lucide-react";
import { read, utils } from "xlsx";
import type { QuizQuestion } from "@/features/quizz";

// ─── Question row ─────────────────────────────────────────────────────────────

function QuestionRow({
  question,
  index,
  active,
  onClick,
}: {
  question: QuizQuestion;
  index: number;
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const pages = question.sourcePages ?? [];
  const [isExpanded, setIsExpanded] = useState(false);

  const handleClick = () => {
    setIsExpanded((prev) => !prev);
    if (!active) {
      onClick();
    }
  };

  return (
    <div
      className={cn(
        "w-full rounded-lg transition-all text-left",
        active ? "bg-primary/12 ring-2 ring-primary/40" : "hover:bg-muted/60",
      )}
    >
      <button
        onClick={handleClick}
        className="w-full p-3 flex items-start gap-2 text-left"
      >
        <span
          className={cn(
            "mt-0.5 flex h-5 min-w-5 items-center justify-center rounded-full text-[10px] font-bold shrink-0",
            active
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground",
          )}
        >
          {index + 1}
        </span>
        <div className="flex flex-1 flex-col gap-1 min-w-0">
          <p
            className={cn(
              "text-xs leading-snug",
              active ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {isExpanded
              ? question.questionText
              : question.questionText.length > 120
                ? question.questionText.slice(0, 120) + "…"
                : question.questionText}
          </p>
          {pages.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-muted-foreground">
                {t("pdfViewer.sectionLabel", { defaultValue: "Đoạn" })}
              </span>
              {pages.map((p) => (
                <Badge
                  key={p}
                  variant={active ? "default" : "outline"}
                  className="h-4 px-1 text-[10px]"
                >
                  {p}
                </Badge>
              ))}
            </div>
          )}
          {question.sourceKeyword && question.sourceKeyword.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {question.sourceKeyword.map((kw, i) => (
                <span
                  key={i}
                  className="text-[10px] italic text-amber-600 dark:text-amber-400"
                >
                  &ldquo;{kw}&rdquo;
                </span>
              ))}
            </div>
          )}
        </div>
        <ChevronRight
          className={cn(
            "mt-0.5 size-3.5 shrink-0 transition-transform",
            isExpanded ? "rotate-90 text-primary" : "text-muted-foreground/50",
          )}
        />
      </button>

      {isExpanded && (
        <div className="px-3 pb-3 pt-0 text-sm animate-in slide-in-from-top-2 fade-in duration-200">
          <div className="space-y-1.5 mt-1 border-t pt-2 border-primary/10">
            {question.options?.map((opt) => {
              const isCorrect =
                opt.id === question.correctAnswerId ||
                question.correctAnswerIds?.includes(opt.id);
              return (
                <div
                  key={opt.id}
                  className={cn(
                    "px-2 py-1.5 rounded text-xs flex gap-2",
                    isCorrect
                      ? "bg-emerald-100/60 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300 font-medium"
                      : "text-muted-foreground bg-background/50",
                  )}
                >
                  <span className="font-semibold shrink-0 uppercase">
                    {opt.id}.
                  </span>
                  <span>{opt.text}</span>
                </div>
              );
            })}
            {question.explanation && (
              <div className="mt-3 text-xs text-muted-foreground bg-muted p-2 rounded-md">
                <span className="font-semibold text-foreground">Giải thích:</span>{" "}
                {question.explanation}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

interface SpreadsheetSourceViewerProps {
  open: boolean;
  onClose: () => void;
  questions: QuizQuestion[];
  quizTitle: string;
  excelUrl: string;
  fileName?: string;
}

export function SpreadsheetSourceViewer({
  open,
  onClose,
  questions,
  quizTitle,
  excelUrl,
  fileName,
}: SpreadsheetSourceViewerProps) {
  const [loading, setLoading] = useState(true);
  const [activeQIdx, setActiveQIdx] = useState<number | null>(null);

  // Spreadsheet state
  const [workbook, setWorkbook] = useState<import("xlsx").WorkBook | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState<string>("");
  const [sheetData, setSheetData] = useState<unknown[][]>([]);

  useEffect(() => {
    if (!open || !excelUrl) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetch(excelUrl)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch spreadsheet");
        return res.arrayBuffer();
      })
      .then((buffer) => {
        const wb = read(buffer, { type: "array" });
        setWorkbook(wb);
        setSheetNames(wb.SheetNames);
        if (wb.SheetNames.length > 0) {
          const firstSheet = wb.SheetNames[0];
          setActiveSheet(firstSheet);
          const data = utils.sheet_to_json(wb.Sheets[firstSheet], { header: 1 });
          setSheetData(data as unknown[][]);
        }
      })
      .catch((err) => {
        console.error("Error reading excel file:", err);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open, excelUrl]);

  const handleSheetChange = (sheet: string) => {
    if (!workbook) return;
    setActiveSheet(sheet);
    const data = utils.sheet_to_json(workbook.Sheets[sheet], { header: 1 });
    setSheetData(data as unknown[][]);
  };

  const handleQuestionClick = (idx: number) => {
    if (activeQIdx === idx) {
      setActiveQIdx(null);
      return;
    }
    setActiveQIdx(idx);
    // Spreadsheet scrolling to keyword isn't perfectly feasible out of the box without tracking dom nodes,
    // so we'll just highlight the row in css if needed. But for now, just active highlighting is fine.
  };

  if (!open) return null;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="flex flex-col gap-0 p-0 overflow-hidden"
        style={{
          width: "96vw",
          maxWidth: "96vw",
          height: "96vh",
          maxHeight: "96vh",
        }}
        showCloseButton={false}
      >
        {/* Header */}
        <DialogHeader className="shrink-0 flex flex-row items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <FileSpreadsheet className="size-4 shrink-0 text-amber-500" />
            <DialogTitle className="truncate text-sm font-semibold">
              {quizTitle || fileName || "Spreadsheet View"}
            </DialogTitle>
            <Badge variant="secondary" className="text-[10px] shrink-0">
              Excel / CSV
            </Badge>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </DialogHeader>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Left: Question list */}
          <div className="w-[38%] shrink-0 border-r flex flex-col min-h-0">
            <div className="shrink-0 px-4 py-2 border-b">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {questions.length} CH CÓ THỂ ĐÃ ĐƯỢC TẠO
              </h3>
            </div>
            <ScrollArea className="flex-1 h-0">
              <div className="p-2 space-y-1">
                {questions.map((q, i) => (
                  <QuestionRow
                    key={q.id}
                    question={q}
                    index={i}
                    active={activeQIdx === i}
                    onClick={() => handleQuestionClick(i)}
                  />
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Right: Spreadsheet content */}
          <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-muted/20">
            {loading ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="size-8 animate-spin text-muted-foreground" />
              </div>
            ) : sheetData.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-sm text-muted-foreground">
                <TableProperties className="size-10 mb-2 opacity-50" />
                <p>Không có dữ liệu hợp lệ trong file này.</p>
              </div>
            ) : (
              <>
                {/* Tabs for Sheets */}
                {sheetNames.length > 1 && (
                  <div className="flex items-center gap-1 border-b px-2 py-1 overflow-x-auto bg-background shrink-0">
                    {sheetNames.map((sheet) => (
                      <button
                        key={sheet}
                        onClick={() => handleSheetChange(sheet)}
                        className={cn(
                          "px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors whitespace-nowrap",
                          activeSheet === sheet
                            ? "bg-primary/10 text-primary border-b-2 border-primary"
                            : "text-muted-foreground hover:bg-muted"
                        )}
                      >
                        {sheet}
                      </button>
                    ))}
                  </div>
                )}
                
                {/* Table Data */}
                <ScrollArea className="flex-1 h-0 border-t">
                  <div className="p-4 min-w-max">
                    <div className="rounded-md border bg-card shadow-sm overflow-hidden">
                      <table className="w-full caption-bottom text-sm border-collapse">
                        <tbody className="[&_tr:last-child]:border-0 bg-background">
                          {sheetData.map((row, rowIndex) => (
                            <tr
                              key={rowIndex}
                              className={cn(
                                "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
                                rowIndex === 0 && "font-medium bg-muted/40 text-muted-foreground"
                              )}
                            >
                              {row.map((cell, cellIndex) => (
                                <td
                                  key={cellIndex}
                                  className="p-3 align-top [&:has([role=checkbox])]:pr-0 border-r border-border/50 last:border-r-0 min-w-[100px] max-w-[500px] whitespace-normal break-words"
                                >
                                  {cell !== undefined && cell !== null ? String(cell) : ""}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <ScrollBar orientation="horizontal" />
                  <ScrollBar orientation="vertical" />
                </ScrollArea>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
