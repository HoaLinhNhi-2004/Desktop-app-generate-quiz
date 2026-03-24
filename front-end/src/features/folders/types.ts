export interface Folder {
  id: string;
  name: string;
  description?: string;
  color: string;
  createdAt: string;
  quizCount: number;
  isFavorite: boolean;
  lastAccessedAt: string | null;
  processingCount: number;
}
