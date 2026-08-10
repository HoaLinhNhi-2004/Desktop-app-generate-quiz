import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { motion, type Transition } from "framer-motion";
import { Trash2, Star, Folder, Pencil, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

// ─── Types ───────────────────────────────────────────────────────────────────

interface InteractiveFolderProps {
  id: string;
  name: string;
  description?: string;
  color: string;
  quizCount: number;
  createdAt: string;
  isFavorite?: boolean;
  processingCount?: number;
  onClick: () => void;
  onDelete: () => void;
  onToggleFavorite?: () => void;
  onEdit?: () => void;
}

interface PaperConfig {
  restRotate: number;
  restY: number;
  hoverY: number;
  hoverRotate: number;
  left: number;
  titleKey: string;
}

// ─── Physics ─────────────────────────────────────────────────────────────────

const springHover: Transition = { type: "spring", stiffness: 200, damping: 20 };
const springGentle: Transition = {
  type: "spring",
  stiffness: 160,
  damping: 22,
};

// ─── Color util ──────────────────────────────────────────────────────────────

function withAlpha(hsl: string, alpha: number): string {
  if (hsl.includes("/")) return hsl;
  return hsl.replace(")", ` / ${alpha})`);
}

// ─── Paper configs ───────────────────────────────────────────────────────────

const PAPERS: PaperConfig[] = [
  {
    restRotate: -5,
    restY: -6,
    hoverY: -30,
    hoverRotate: -9,
    left: 12,
    titleKey: "interactiveFolder.quizSet",
  },
  {
    restRotate: 2,
    restY: -12,
    hoverY: -40,
    hoverRotate: 4,
    left: 18,
    titleKey: "interactiveFolder.paper1",
  },
  {
    restRotate: 7,
    restY: -4,
    hoverY: -24,
    hoverRotate: 11,
    left: 24,
    titleKey: "interactiveFolder.paper2",
  },
];

const FOLDER_BACK_PATH =
  "M 0 60 C 0 26.863 26.863 0 60 0 L 297.24 0 C 347.1 0 390.697 30.64 407.604 77.464 L 422.955 119.349 C 427.602 132.029 439.697 140.404 453.151 140.404 L 900 140.404 C 933.137 140.404 960 167.267 960 200.404 L 960 680.404 C 960 713.541 933.137 740.404 900 740.404 L 60 740.404 C 26.863 740.404 0 713.541 0 680.404 Z";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// ─── Bee SVG ─────────────────────────────────────────────────────────────────

function BeeSvg({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      {/* Wings - translucent, rounded, slightly overlapping body */}
      <ellipse
        cx="21"
        cy="24"
        rx="11"
        ry="7"
        fill="rgba(255,255,255,0.75)"
        stroke="rgba(173,216,230,0.6)"
        strokeWidth="0.8"
        transform="rotate(-15 21 24)"
      />
      <ellipse
        cx="43"
        cy="24"
        rx="11"
        ry="7"
        fill="rgba(255,255,255,0.75)"
        stroke="rgba(173,216,230,0.6)"
        strokeWidth="0.8"
        transform="rotate(15 43 24)"
      />

      {/* Chubby body */}
      <ellipse cx="32" cy="38" rx="14" ry="15" fill="#FFD54F" />

      {/* Body stripes - gentle curves */}
      <path
        d="M20 33 Q32 31 44 33"
        stroke="#5D4037"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M19 40 Q32 38 45 40"
        stroke="#5D4037"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />

      {/* Round head */}
      <circle cx="32" cy="22" r="9" fill="#5D4037" />

      {/* Big kawaii eyes - white */}
      <ellipse cx="28" cy="21" rx="3.2" ry="3.5" fill="white" />
      <ellipse cx="36" cy="21" rx="3.2" ry="3.5" fill="white" />

      {/* Pupils */}
      <circle cx="28.8" cy="21.5" r="1.8" fill="#1a1a2e" />
      <circle cx="36.8" cy="21.5" r="1.8" fill="#1a1a2e" />

      {/* Eye highlights */}
      <circle cx="27.6" cy="20" r="0.9" fill="white" />
      <circle cx="35.6" cy="20" r="0.9" fill="white" />

      {/* Blush cheeks */}
      <ellipse
        cx="24"
        cy="25"
        rx="2.5"
        ry="1.5"
        fill="rgba(255,150,150,0.45)"
      />
      <ellipse
        cx="40"
        cy="25"
        rx="2.5"
        ry="1.5"
        fill="rgba(255,150,150,0.45)"
      />

      {/* Cute smile */}
      <path
        d="M29.5 26 Q32 28.5 34.5 26"
        stroke="#FFB74D"
        strokeWidth="1.2"
        strokeLinecap="round"
        fill="none"
      />

      {/* Antennae - bouncy curves */}
      <path
        d="M28 14 Q25 6 21 4"
        stroke="#5D4037"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M36 14 Q39 6 43 4"
        stroke="#5D4037"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />

      {/* Antenna tips - little hearts/circles */}
      <circle cx="21" cy="4" r="2" fill="#FF8A80" />
      <circle cx="43" cy="4" r="2" fill="#FF8A80" />

      {/* Tiny stinger */}
      <ellipse cx="32" cy="53" rx="2" ry="2.5" fill="#5D4037" />
    </svg>
  );
}

// ─── Bee flight configs ──────────────────────────────────────────────────────

interface BeeConfig {
  size: number;
  delay: number;
  startX: string;
  startY: string;
  xPath: number[];
  yPath: number[];
  rotatePath: number[];
  xDuration: number;
  yDuration: number;
}

const BEES: BeeConfig[] = [
  {
    size: 26,
    delay: 0,
    startX: "42%",
    startY: "18%",
    xPath: [0, 60, -30, 120, 50, 140, 80],
    yPath: [0, -50, -100, -60, -140, -110, -160],
    rotatePath: [0, 15, -10, 20, -15, 8, -5],
    xDuration: 5,
    yDuration: 4.2,
  },
  {
    size: 20,
    delay: 0.15,
    startX: "35%",
    startY: "22%",
    xPath: [0, -50, -100, -40, -130, -80, -150],
    yPath: [0, -40, -80, -130, -90, -160, -120],
    rotatePath: [0, -12, 8, -18, 12, -6, 10],
    xDuration: 4.5,
    yDuration: 5,
  },
  {
    size: 18,
    delay: 0.35,
    startX: "50%",
    startY: "15%",
    xPath: [0, 40, 100, 30, 80, 130, 110],
    yPath: [0, -60, -30, -110, -80, -150, -130],
    rotatePath: [0, 10, -14, 6, -10, 16, -8],
    xDuration: 4.8,
    yDuration: 4.6,
  },
];

// ─── Folder Bees (3 bees fly out on hover for empty folders) ─────────────────

function FolderBees({ isHovered }: { isHovered: boolean }) {
  return (
    <>
      {BEES.map((bee, i) => (
        <motion.div
          key={i}
          className="absolute pointer-events-none"
          style={{ left: bee.startX, top: bee.startY, zIndex: 20 }}
          initial={{ opacity: 0, x: 0, y: 0 }}
          animate={
            isHovered
              ? {
                  opacity: [0, 1, 1, 1, 1, 1, 1],
                  x: bee.xPath,
                  y: bee.yPath,
                  rotate: bee.rotatePath,
                }
              : { opacity: 0, x: 0, y: 0, rotate: 0 }
          }
          transition={
            isHovered
              ? {
                  opacity: { duration: 0.4, delay: bee.delay },
                  x: {
                    duration: bee.xDuration,
                    repeat: Infinity,
                    repeatType: "mirror",
                    ease: "easeInOut",
                    delay: bee.delay,
                  },
                  y: {
                    duration: bee.yDuration,
                    repeat: Infinity,
                    repeatType: "mirror",
                    ease: "easeInOut",
                    delay: bee.delay,
                  },
                  rotate: {
                    duration: 3.2,
                    repeat: Infinity,
                    repeatType: "mirror",
                    ease: "easeInOut",
                    delay: bee.delay,
                  },
                }
              : { duration: 0.25 }
          }
        >
          {/* Wing flutter */}
          <motion.div
            animate={isHovered ? { scaleY: [1, 0.5, 1] } : { scaleY: 1 }}
            transition={
              isHovered
                ? { duration: 0.1, repeat: Infinity, repeatType: "mirror" }
                : {}
            }
            style={{ originY: 1 }}
          >
            <BeeSvg size={bee.size} />
          </motion.div>
        </motion.div>
      ))}
    </>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function InteractiveFolder({
  id,
  name,
  color,
  quizCount,
  isFavorite = false,
  processingCount = 0,
  onClick,
  onDelete,
  onToggleFavorite,
  onEdit,
}: InteractiveFolderProps) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const isProcessing = processingCount > 0;

  return (
    <motion.div
      className="relative cursor-pointer select-none flex flex-col gap-3 rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      role="button"
      tabIndex={0}
      aria-label={t("a11y.labels.openFolder", { name })}
      onHoverStart={() => setIsHovered(true)}
      onHoverEnd={() => setIsHovered(false)}
      onFocus={() => setIsHovered(true)}
      onBlur={() => setIsHovered(false)}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="relative w-full" style={{ aspectRatio: "1 / 0.82" }}>
        {/* ── BACK ── */}
        <div className="absolute inset-0 z-[1]">
          <svg
            style={{ width: "100%", height: "100%", overflow: "visible" }}
            preserveAspectRatio="none"
            viewBox="0 0 960 740"
          >
            <defs>
              <linearGradient
                id={`grad-${id}`}
                x1="0%"
                y1="0%"
                x2="0%"
                y2="100%"
              >
                <stop offset="0%" stopColor={withAlpha(color, 0.5)} />
                <stop offset="100%" stopColor={withAlpha(color, 0.28)} />
              </linearGradient>
            </defs>
            <path d={FOLDER_BACK_PATH} fill={`url(#grad-${id})`} />
          </svg>
        </div>

        {/* ── PAPERS ── */}
        {quizCount > 0 &&
          PAPERS.map((cfg) => (
            <motion.div
              key={cfg.titleKey}
              className="absolute z-[5] rounded-lg overflow-hidden"
              style={{
                width: "62%",
                height: "48%",
                left: `${cfg.left}%`,
                top: "8%",
                transformOrigin: "50% 100%",
                background:
                  "linear-gradient(175deg, rgba(255,255,255,0.95) 0%, rgba(245,248,255,0.9) 100%)",
                boxShadow:
                  "0 2px 8px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)",
                border: "1px solid rgba(255,255,255,0.5)",
              }}
              animate={{
                y: isHovered ? cfg.hoverY : cfg.restY,
                rotate: isHovered ? cfg.hoverRotate : cfg.restRotate,
              }}
              transition={springHover}
            >
              <div className="p-2.5 pt-3 space-y-1.5">
                <p className="text-[9px] font-bold text-gray-600 truncate leading-none">
                  {t(cfg.titleKey)}
                </p>
                <div className="h-[2.5px] rounded-full bg-gray-300/60 w-full" />
                <div className="h-[2.5px] rounded-full bg-gray-200/50 w-[85%]" />
                <div className="h-[2.5px] rounded-full bg-gray-200/40 w-[65%]" />
                <div className="h-[2.5px] rounded-full bg-gray-100/40 w-[50%]" />
              </div>
            </motion.div>
          ))}

        {/* ── BEES (empty folders) ── */}
        {quizCount === 0 && <FolderBees isHovered={isHovered} />}

        {/* ── FRONT PIECE ── */}
        <div
          className={cn(
            "absolute z-[10] rounded-[10px] overflow-hidden transition-all duration-500",
            isProcessing && "shadow-[0_4px_25px_rgba(59,130,246,0.25)]"
          )}
          style={{
            top: "38%",
            left: 0,
            right: 0,
            bottom: 0,
            background: `linear-gradient(180deg, 
              ${withAlpha(color, 0.72)} 0%, 
              ${withAlpha(color, 0.55)} 40%, 
              ${withAlpha(color, 0.48)} 100%)`,
            backdropFilter: "blur(12px) saturate(180%)",
            boxShadow: `
              0 8px 32px rgba(0,0,0,0.18),
              inset 0 2px 6px rgba(255,255,255,0.12),
              inset 0 -1px 3px rgba(0,0,0,0.04)
            `,
          }}
        >
          {/* Subtle shimmer effect when processing */}
          {isProcessing && (
            <motion.div
              className="absolute inset-0 z-0 pointer-events-none"
              style={{
                background: 'linear-gradient(115deg, transparent 20%, rgba(255,255,255,0.25) 45%, rgba(255,255,255,0.35) 50%, rgba(255,255,255,0.25) 55%, transparent 80%)',
                backgroundSize: '200% 100%'
              }}
              animate={{ backgroundPosition: ['200% 0', '-100% 0'] }}
              transition={{ duration: 2.5, repeat: Infinity, ease: 'linear' }}
            />
          )}

          <div
            className="absolute inset-x-0 top-0 pointer-events-none"
            style={{
              height: "35%",
              background: "linear-gradient(180deg, rgba(255,255,255,0.1), transparent)",
              borderRadius: "inherit",
            }}
          />

          {/* ── Details ── */}
          <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 px-2 pb-3 z-10">
            <p className="text-xs font-semibold text-white truncate w-full text-center drop-shadow-sm">
              {name}
            </p>
            <div className="h-3.5 flex items-center justify-center text-center w-full">
              {isProcessing ? (
                <motion.span 
                  className="text-[10px] text-white/90 font-medium tracking-wide flex items-center gap-1"
                  animate={{ opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
                >
                  <Loader2 className="size-2.5 animate-spin" />
                  {t("interactiveFolder.processing", { count: processingCount })}
                </motion.span>
              ) : (
                <span className="text-[10px] text-white/60">
                  {quizCount === 0
                    ? t("interactiveFolder.empty")
                    : t("interactiveFolder.documents", { count: quizCount })}
                </span>
              )}
            </div>
          </div>

          {/* ── Favorite ── */}
          {onToggleFavorite && (
            <motion.button
              className={cn(
                "absolute left-2 top-2 size-6 flex items-center justify-center rounded-md backdrop-blur-sm transition-colors",
                isFavorite
                  ? "bg-yellow-400/30 text-yellow-300"
                  : "bg-black/20 text-white/50 hover:text-yellow-300 hover:bg-yellow-400/20",
              )}
              animate={{ opacity: isHovered || isFavorite ? 1 : 0 }}
              transition={{ duration: 0.2 }}
              aria-label={t(
                isFavorite
                  ? "a11y.labels.removeFavorite"
                  : "a11y.labels.addFavorite",
                { name },
              )}
              aria-pressed={isFavorite}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite();
              }}
            >
              <Star className={cn("size-3", isFavorite && "fill-current")} />
            </motion.button>
          )}

          {/* ── Actions (top-right) ── */}
          <motion.div
            className="absolute right-2 top-2 flex items-center gap-1"
            animate={{ opacity: isHovered ? 1 : 0 }}
            transition={{ duration: 0.2 }}
          >
            {onEdit && (
              <button
                className="size-6 flex items-center justify-center rounded-md bg-black/20 backdrop-blur-sm text-white/50 hover:text-white hover:bg-white/20 transition-colors"
                aria-label={t("a11y.labels.editFolder", { name })}
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
              >
                <Pencil className="size-3" />
              </button>
            )}
            <ConfirmDialog
              stopPropagation
              destructive
              title={t("confirm.deleteFolder.title", { name })}
              description={t("confirm.deleteFolder.desc")}
              confirmLabel={t("common.delete")}
              onConfirm={onDelete}
            >
              <button
                className="size-6 flex items-center justify-center rounded-md bg-black/20 backdrop-blur-sm text-white/50 hover:text-white hover:bg-red-500/50 transition-colors"
                aria-label={t("a11y.labels.deleteFolder", { name })}
              >
                <Trash2 className="size-3" />
              </button>
            </ConfirmDialog>
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Folder List Item ────────────────────────────────────────────────────────

export function FolderListItem({
  name,
  description,
  color,
  quizCount,
  createdAt,
  isFavorite = false,
  processingCount = 0,
  onClick,
  onDelete,
  onToggleFavorite,
  onEdit,
}: InteractiveFolderProps) {
  const { t } = useTranslation();
  const isProcessing = processingCount > 0;
  return (
    <motion.div
      className={cn(
        "group flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer hover:bg-muted/50 transition-colors border select-none outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        isProcessing ? "border-blue-500/20 bg-blue-500/5" : "border-transparent hover:border-border/40"
      )}
      role="button"
      tabIndex={0}
      aria-label={t("a11y.labels.openFolder", { name })}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      whileHover={{ x: 2 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
    >
      {/* ── Color icon ── */}
      <div
        className="relative size-10 rounded-xl flex-shrink-0 flex items-center justify-center"
        style={{ background: withAlpha(color, 0.18) }}
      >
        <Folder className="size-5" style={{ color }} />
        {isProcessing && (
          <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-blue-400 animate-pulse" />
        )}
      </div>

      {/* ── Info ── */}
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm truncate leading-tight">{name}</p>
        {isProcessing ? (
          <p className="text-xs text-blue-400 flex items-center gap-1">
            <Loader2 className="size-3 animate-spin" />
            {t("interactiveFolder.processingFiles", { count: processingCount })}
          </p>
        ) : description ? (
          <p className="text-xs text-muted-foreground truncate">
            {description}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground/50">
            {formatDate(createdAt)}
          </p>
        )}
      </div>

      {/* ── Meta ── */}
      {isProcessing ? (
        <Badge variant="secondary" className="shrink-0 text-[9px] px-2 py-0 bg-blue-500/10 text-blue-600 border-blue-500/30 overflow-hidden relative shadow-[0_0_8px_rgba(59,130,246,0.2)] flex items-center">
          <Sparkles className="size-2.5 animate-pulse mr-1" />
          <span className="font-bold tracking-wider">SCANNING</span>
          <motion.div
            className="absolute inset-0 bg-gradient-to-r from-transparent via-blue-200/50 to-transparent skew-x-12"
            animate={{ x: ['-200%', '400%'] }}
            transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut', repeatDelay: 1 }}
          />
        </Badge>
      ) : (
        <Badge variant="secondary" className="shrink-0 text-[10px] px-1.5 py-0">
          {quizCount === 0
            ? t("interactiveFolder.empty")
            : t("interactiveFolder.docs", { count: quizCount })}
        </Badge>
      )}
      {description && (
        <span className="text-xs text-muted-foreground hidden sm:block shrink-0 w-20 text-right">
          {formatDate(createdAt)}
        </span>
      )}

      {/* ── Actions ── */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {onToggleFavorite && (
          <button
            className={cn(
              "size-7 flex items-center justify-center rounded-md transition-colors",
              isFavorite
                ? "text-yellow-400"
                : "text-muted-foreground hover:text-yellow-400 hover:bg-muted",
            )}
            aria-label={t(
              isFavorite
                ? "a11y.labels.removeFavorite"
                : "a11y.labels.addFavorite",
              { name },
            )}
            aria-pressed={isFavorite}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite();
            }}
          >
            <Star className={cn("size-3.5", isFavorite && "fill-current")} />
          </button>
        )}
        {onEdit && (
          <button
            className="size-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label={t("a11y.labels.editFolder", { name })}
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <Pencil className="size-3.5" />
          </button>
        )}
        <ConfirmDialog
          stopPropagation
          destructive
          title={t("confirm.deleteFolder.title", { name })}
          description={t("confirm.deleteFolder.desc")}
          confirmLabel={t("common.delete")}
          onConfirm={onDelete}
        >
          <button
            className="size-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            aria-label={t("a11y.labels.deleteFolder", { name })}
          >
            <Trash2 className="size-3.5" />
          </button>
        </ConfirmDialog>
      </div>
    </motion.div>
  );
}

// ─── Create Folder Card ──────────────────────────────────────────────────────

export function CreateFolderCard({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const [displayedText, setDisplayedText] = useState("");
  const [isTypingComplete, setIsTypingComplete] = useState(false);
  const fullText = t("interactiveFolder.clickToStart");

  useEffect(() => {
    if (isHovered) {
      setDisplayedText("");
      setIsTypingComplete(false);
      let currentIndex = 0;
      const interval = setInterval(() => {
        if (currentIndex <= fullText.length) {
          setDisplayedText(fullText.slice(0, currentIndex));
          currentIndex++;
        } else {
          clearInterval(interval);
          setIsTypingComplete(true);
        }
      }, 60);
      return () => clearInterval(interval);
    } else {
      setDisplayedText("");
      setIsTypingComplete(false);
    }
  }, [isHovered, fullText]);

  return (
    <div
      className="relative cursor-pointer select-none rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      role="button"
      tabIndex={0}
      aria-label={t("home.createFolderNew")}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onFocus={() => setIsHovered(true)}
      onBlur={() => setIsHovered(false)}
    >
      <style>{`
        @keyframes folder-cursor-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>

      <div className="relative w-full" style={{ aspectRatio: "1 / 0.82" }}>
        {/* ── BACK (folder shape, dashed) ── */}
        <div className="absolute inset-0 z-[1]">
          <svg
            style={{ width: "100%", height: "100%", overflow: "visible" }}
            preserveAspectRatio="none"
            viewBox="0 0 960 740"
          >
            <path
              d={FOLDER_BACK_PATH}
              fill="none"
              stroke="currentColor"
              strokeWidth="18"
              strokeDasharray="40 22"
              className="text-border/40"
            />
          </svg>
        </div>

        {/* ── Content ── */}
        <div
          className="absolute z-[10] flex items-center justify-center text-muted-foreground/50"
          style={{ top: "38%", left: 0, right: 0, bottom: 0 }}
        >
          <motion.div
            animate={{ rotate: isHovered ? 90 : 0 }}
            transition={springGentle}
            className="flex size-12 items-center justify-center rounded-2xl bg-muted/20"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </motion.div>

          <p
            className="absolute bottom-4 left-0 right-0 text-xs text-muted-foreground/60 text-center"
            style={{ opacity: isHovered ? 1 : 0, transition: "opacity 0.2s" }}
          >
            {displayedText}
            {isHovered && (
              <span
                className="inline-block w-[2px] h-[12px] bg-current ml-0.5"
                style={{
                  verticalAlign: "text-bottom",
                  animation: isTypingComplete
                    ? "folder-cursor-blink 1s step-end infinite"
                    : "none",
                }}
              />
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
