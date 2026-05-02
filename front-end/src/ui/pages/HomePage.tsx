import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  FolderPlus,
  Folder,
  LayoutGrid,
  List,
  Clock,
  Star,
  FolderInput,
} from "lucide-react";
import { useFolders } from "@/features/folders";
import { useSmartImportContext } from "@/features/smart-import";
import { cn } from "@/lib/utils";
import {
  InteractiveFolder,
  CreateFolderCard,
  FolderListItem,
} from "../components/InteractiveFolder";

const FOLDER_COLORS = [
  "hsl(262 83% 58%)",
  "hsl(217 91% 60%)",
  "hsl(142 71% 45%)",
  "hsl(38 92% 50%)",
  "hsl(346 87% 58%)",
  "hsl(187 88% 40%)",
];

const gridItemVariants = {
  hidden: { opacity: 0, y: 20, scale: 0.95 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { type: "spring" as const, stiffness: 240, damping: 24 },
  },
  exit: {
    opacity: 0,
    scale: 0.9,
    transition: { duration: 0.2 },
  },
};

export function HomePage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const {
    folders,
    loading,
    error,
    createFolder,
    deleteFolder,
    updateFolder,
    toggleFavorite,
    recordAccess,
    refreshFolders,
  } = useFolders();
  const [open, setOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderDesc, setFolderDesc] = useState("");
  const [selectedColor, setSelectedColor] = useState(FOLDER_COLORS[0]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Edit folder state
  const [editOpen, setEditOpen] = useState(false);
  const [editingFolder, setEditingFolder] = useState<{
    id: string;
    name: string;
    description: string;
    color: string;
  } | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editColor, setEditColor] = useState(FOLDER_COLORS[0]);

  // Smart Import (state lifted to App-level context so widget persists across pages)
  const smartImport = useSmartImportContext();
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState("");
  const prevJobStatus = useRef<string | null>(null);

  // Auto-refresh folder list when import job completes
  useEffect(() => {
    const currentStatus = smartImport.job?.status ?? null;
    if (
      prevJobStatus.current &&
      prevJobStatus.current !== "completed" &&
      prevJobStatus.current !== "cancelled" &&
      (currentStatus === "completed" || currentStatus === "cancelled")
    ) {
      refreshFolders();
    }
    prevJobStatus.current = currentStatus;
  }, [smartImport.job?.status, refreshFolders]);

  const handleStartImport = () => {
    const trimmed = importPath.trim();
    if (!trimmed) return;
    smartImport.startImport(trimmed);
    setImportOpen(false);
    setImportPath("");
  };

  const handleBrowseFolder = async () => {
    // Try Electron native dialog first, fallback to manual input
    if (window.electron?.selectFolder) {
      try {
        const selected = await window.electron.selectFolder();
        if (selected) {
          setImportPath(selected);
        }
      } catch {
        // Fallback: user types path manually
      }
    }
  };

  const [viewMode, setViewMode] = useState<"grid" | "list">(
    () =>
      (localStorage.getItem("folder-view-mode") as "grid" | "list") ?? "grid",
  );
  const [activeTab, setActiveTab] = useState<"all" | "recent" | "favorites">(
    "all",
  );

  const filteredFolders = useMemo(() => {
    if (activeTab === "favorites") return folders.filter((f) => f.isFavorite);
    if (activeTab === "recent")
      return [...folders]
        .filter((f) => f.lastAccessedAt !== null)
        .sort(
          (a, b) =>
            new Date(b.lastAccessedAt!).getTime() -
            new Date(a.lastAccessedAt!).getTime(),
        )
        .slice(0, 10);
    return folders;
  }, [folders, activeTab]);

  const changeViewMode = (mode: "grid" | "list") => {
    setViewMode(mode);
    localStorage.setItem("folder-view-mode", mode);
  };

  const handleCreate = async () => {
    if (!folderName.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const newFolder = await createFolder(
        folderName,
        folderDesc,
        selectedColor,
      );
      setFolderName("");
      setFolderDesc("");
      setSelectedColor(FOLDER_COLORS[0]);
      setOpen(false);
      navigate(`/folder/${newFolder.id}`);
    } catch (err) {
      console.error("Failed to create folder:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEditOpen = (folder: {
    id: string;
    name: string;
    description?: string;
    color: string;
  }) => {
    setEditingFolder({
      id: folder.id,
      name: folder.name,
      description: folder.description || "",
      color: folder.color,
    });
    setEditName(folder.name);
    setEditDesc(folder.description || "");
    setEditColor(folder.color);
    setEditOpen(true);
  };

  const handleUpdate = async () => {
    if (!editingFolder || !editName.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await updateFolder(editingFolder.id, {
        name: editName,
        description: editDesc,
        color: editColor,
      });
      setEditOpen(false);
      setEditingFolder(null);
    } catch (err) {
      console.error("Failed to update folder:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-muted-foreground"
        >
          {t("home.loading")}
        </motion.div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2">
        <p className="text-destructive font-medium">
          {t("home.errorPrefix", { error })}
        </p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
        {/* Header row */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="flex items-center justify-between shrink-0"
        >
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              {t("home.title")}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {t("home.subtitle")}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Dialog open={importOpen} onOpenChange={setImportOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="outline"
                  className="gap-2"
                  disabled={smartImport.isStarting || (smartImport.job !== null && smartImport.job.status !== "completed" && smartImport.job.status !== "error")}
                >
                  <FolderInput className="size-4" />
                  {t("home.importFolder", "Import Folder")}
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[480px]">
                <DialogHeader>
                  <DialogTitle>{t("smartImport.title", "Smart Import")}</DialogTitle>
                  <DialogDescription>
                    {t("smartImport.dialogDesc", "Enter the absolute path of the folder containing your study materials. AI will automatically categorize and organize files into folders.")}
                  </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3 py-2">
                  <div className="flex flex-col gap-1.5">
                    <Label>{t("smartImport.pathLabel", "Folder Path")}</Label>
                    <div className="flex gap-2">
                      <Input
                        placeholder={t("smartImport.pathPlaceholder", "D:\\Documents\\Study Materials")}
                        value={importPath}
                        onChange={(e) => setImportPath(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleStartImport();
                        }}
                        autoFocus
                        className="flex-1"
                      />
                      {window.electron?.selectFolder && (
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={handleBrowseFolder}
                          title={t("smartImport.browse", "Browse")}
                        >
                          <FolderInput className="size-4" />
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("smartImport.supportedFormats", "Supports: PDF, DOCX, DOC, TXT, PPTX")}
                    </p>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="ghost" onClick={() => setImportOpen(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    onClick={handleStartImport}
                    disabled={!importPath.trim() || smartImport.isStarting}
                    className="gap-2"
                  >
                    <FolderInput className="size-4" />
                    {smartImport.isStarting
                      ? t("smartImport.starting", "Starting...")
                      : t("smartImport.startBtn", "Start Import")}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <FolderPlus className="size-4" />
                {t("home.createFolder")}
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[420px]">
              <DialogHeader>
                <DialogTitle>{t("home.createDialog.title")}</DialogTitle>
                <DialogDescription>
                  {t("home.createDialog.description")}
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4 py-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="folder-name">
                    {t("home.createDialog.nameLabel")}
                  </Label>
                  <Input
                    id="folder-name"
                    placeholder={t("home.createDialog.namePlaceholder")}
                    value={folderName}
                    onChange={(e) => setFolderName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                    autoFocus
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="folder-desc">
                    {t("home.createDialog.descLabel")}
                  </Label>
                  <Input
                    id="folder-desc"
                    placeholder={t("home.createDialog.descPlaceholder")}
                    value={folderDesc}
                    onChange={(e) => setFolderDesc(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>{t("home.createDialog.colorLabel")}</Label>
                  <div className="flex gap-2">
                    {FOLDER_COLORS.map((color) => (
                      <motion.button
                        key={color}
                        type="button"
                        whileHover={{ scale: 1.2 }}
                        whileTap={{ scale: 0.9 }}
                        className="size-7 rounded-full"
                        style={{
                          backgroundColor: color,
                          outline:
                            selectedColor === color
                              ? `3px solid ${color}`
                              : "3px solid transparent",
                          outlineOffset: "2px",
                        }}
                        onClick={() => setSelectedColor(color)}
                      />
                    ))}
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  {t("common.cancel")}
                </Button>
                <Button onClick={handleCreate} disabled={!folderName.trim()}>
                  {t("home.createFolder")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          </div>
        </motion.div>

        {/* ── Toolbar: tabs + view toggle ── */}
        <div className="flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-1 bg-muted/40 rounded-xl p-1">
            {(
              [
                { key: "all", label: t("home.tabs.all"), icon: Folder },
                { key: "recent", label: t("home.tabs.recent"), icon: Clock },
                {
                  key: "favorites",
                  label: t("home.tabs.favorites"),
                  icon: Star,
                },
              ] as const
            ).map(({ key, label, icon: Icon }) => {
              const count =
                key === "all"
                  ? folders.length
                  : key === "favorites"
                    ? folders.filter((f) => f.isFavorite).length
                    : folders.filter((f) => f.lastAccessedAt !== null).length;
              return (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-all font-medium",
                    activeTab === key
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5" />
                  {label}
                  {count > 0 && (
                    <span
                      className={cn(
                        "text-[10px] font-semibold px-1.5 py-0.5 rounded-full",
                        activeTab === key
                          ? "bg-primary/10 text-primary"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1 bg-muted/40 rounded-xl p-1">
            <button
              onClick={() => changeViewMode("grid")}
              className={cn(
                "size-8 flex items-center justify-center rounded-lg transition-all",
                viewMode === "grid"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <LayoutGrid className="size-4" />
            </button>
            <button
              onClick={() => changeViewMode("list")}
              className={cn(
                "size-8 flex items-center justify-center rounded-lg transition-all",
                viewMode === "list"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <List className="size-4" />
            </button>
          </div>
        </div>

        {/* ── Content ── */}
        {folders.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 200, damping: 25 }}
            className="flex flex-1 flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border py-20 text-center"
          >
            <motion.div
              animate={{ y: [0, -6, 0], rotate: [0, -3, 3, 0] }}
              transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
              className="flex size-16 items-center justify-center rounded-full bg-muted"
            >
              <Folder className="size-8 text-muted-foreground" />
            </motion.div>
            <div>
              <p className="font-medium text-foreground">
                {t("home.empty.title")}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("home.empty.description")}
              </p>
            </div>
            <Button
              variant="outline"
              className="gap-2 mt-2"
              onClick={() => setOpen(true)}
            >
              <FolderPlus className="size-4" />
              {t("home.createFolderNew")}
            </Button>
          </motion.div>
        ) : filteredFolders.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center gap-3 py-16 text-center"
          >
            {activeTab === "favorites" ? (
              <>
                <Star className="size-10 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">
                  {t("home.emptyFavorites")}
                </p>
              </>
            ) : (
              <>
                <Clock className="size-10 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">
                  {t("home.emptyRecent")}
                </p>
              </>
            )}
          </motion.div>
        ) : viewMode === "grid" ? (
          <AnimatePresence mode="wait">
            <motion.div
              key="grid"
              className="grid grid-cols-2 gap-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <AnimatePresence mode="popLayout">
                {activeTab === "all" && (
                  <motion.div
                    key="create-new"
                    layout
                    variants={gridItemVariants}
                    initial="hidden"
                    animate="visible"
                  >
                    <CreateFolderCard onClick={() => setOpen(true)} />
                  </motion.div>
                )}

                {filteredFolders.map((folder) => (
                  <motion.div
                    key={folder.id}
                    layout
                    variants={gridItemVariants}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                  >
                    <InteractiveFolder
                      id={folder.id}
                      name={folder.name}
                      description={folder.description}
                      color={folder.color}
                      quizCount={folder.quizCount}
                      createdAt={folder.createdAt}
                      isFavorite={folder.isFavorite}
                      processingCount={folder.processingCount}
                      onClick={() => {
                        recordAccess(folder.id);
                        navigate(`/folder/${folder.id}`);
                      }}
                      onDelete={() => deleteFolder(folder.id)}
                      onToggleFavorite={() => toggleFavorite(folder.id)}
                      onEdit={() => handleEditOpen(folder)}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          </AnimatePresence>
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key="list"
              className="flex flex-col gap-1"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {activeTab === "all" && (
                <button
                  onClick={() => setOpen(true)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-muted/50 transition-colors border border-dashed border-border/40 text-muted-foreground/60 hover:text-muted-foreground mb-1"
                >
                  <div className="size-10 rounded-xl flex-shrink-0 flex items-center justify-center border border-dashed border-border/40">
                    <FolderPlus className="size-4" />
                  </div>
                  <span className="text-sm font-medium">
                    {t("home.createFolderNew")}
                  </span>
                </button>
              )}

              <AnimatePresence mode="popLayout">
                {filteredFolders.map((folder) => (
                  <motion.div
                    key={folder.id}
                    layout
                    variants={gridItemVariants}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                  >
                    <FolderListItem
                      id={folder.id}
                      name={folder.name}
                      description={folder.description}
                      color={folder.color}
                      quizCount={folder.quizCount}
                      createdAt={folder.createdAt}
                      isFavorite={folder.isFavorite}
                      processingCount={folder.processingCount}
                      onClick={() => {
                        recordAccess(folder.id);
                        navigate(`/folder/${folder.id}`);
                      }}
                      onDelete={() => deleteFolder(folder.id)}
                      onToggleFavorite={() => toggleFavorite(folder.id)}
                      onEdit={() => handleEditOpen(folder)}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          </AnimatePresence>
        )}
      </div>

      {/* ── Edit Folder Dialog ── */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t("home.editDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("home.editDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-folder-name">
                {t("home.createDialog.nameLabel")}
              </Label>
              <Input
                id="edit-folder-name"
                placeholder={t("home.createDialog.namePlaceholder")}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleUpdate()}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-folder-desc">
                {t("home.createDialog.descLabel")}
              </Label>
              <Input
                id="edit-folder-desc"
                placeholder={t("home.createDialog.descPlaceholder")}
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t("home.createDialog.colorLabel")}</Label>
              <div className="flex gap-2">
                {FOLDER_COLORS.map((color) => (
                  <motion.button
                    key={color}
                    type="button"
                    whileHover={{ scale: 1.2 }}
                    whileTap={{ scale: 0.9 }}
                    className="size-7 rounded-full"
                    style={{
                      backgroundColor: color,
                      outline:
                        editColor === color
                          ? `3px solid ${color}`
                          : "3px solid transparent",
                      outlineOffset: "2px",
                    }}
                    onClick={() => setEditColor(color)}
                  />
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleUpdate}
              disabled={!editName.trim() || isSubmitting}
            >
              {t("home.editDialog.saveChanges")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </ScrollArea>
  );
}
