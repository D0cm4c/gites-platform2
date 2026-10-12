export type ImprovementStatus = "nouveau" | "en_cours" | "fait" | "ecarte";

export interface Improvement {
  id: number;
  createdAt: string;
  updatedAt: string;
  author: string;
  pagePath: string;
  pageTitle: string | null;
  text: string;
  status: ImprovementStatus;
  adminNote: string | null;
  userAgent: string | null;
  viewportWidth: number | null;
}

export interface ImprovementList {
  improvements: Improvement[];
  counts: Record<ImprovementStatus, number>;
}

export const TEXT_MIN = 3;
export const TEXT_MAX = 2000;
export const NOTE_MAX = 2000;
