import * as React from "react"
import { useTranslation } from "react-i18next"
import { Loader2 } from "lucide-react"

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
} from "@/components/ui/alert-dialog"

type ConfirmDialogProps = {
  /**
   * Trigger element. Omit it and drive `open`/`onOpenChange` instead when one
   * shared dialog serves a long list — a trigger per row means a dialog root
   * per row.
   */
  children?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  pending?: boolean
  /**
   * Keeps the click from reaching an ancestor that is itself clickable — folder
   * cards put the delete trigger inside the card's own onClick target.
   */
  stopPropagation?: boolean
  onConfirm: () => void
}

export function ConfirmDialog({
  children,
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
  pending = false,
  stopPropagation = false,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useTranslation()
  const swallow = stopPropagation
    ? (e: React.MouseEvent) => e.stopPropagation()
    : undefined

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {children && (
        <AlertDialogTrigger asChild onClick={swallow}>
          {children}
        </AlertDialogTrigger>
      )}
      <AlertDialogContent onClick={swallow}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {cancelLabel ?? t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={onConfirm}
          >
            {pending && <Loader2 className="size-4 animate-spin" />}
            {confirmLabel ?? t("common.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
