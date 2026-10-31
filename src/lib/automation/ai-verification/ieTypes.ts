import type {
  AIVerificationConfidence,
  AIVerificationEvidence,
} from "./types";

export type IEVerificationReportType =
  | "annual"
  | "t12"
  | "separate_annual"
  | "budget"
  | "annualized"
  | "unknown";

export interface IEVerificationSource {
  filename: string;
  reportType: IEVerificationReportType;
  periodLabels: string[];
}

export interface IEVerificationRow {
  accountCode: string | null;
  internalNumber: string | number | null;
  lineItem: string;
  values: Record<string, number | string | null>;
  isSummary: boolean;
  evidence?: AIVerificationEvidence[];
  explanation?: string;
  confidence?: AIVerificationConfidence;
}

export interface IEVerificationDocument {
  propertyName: string | null;
  sources: IEVerificationSource[];
  periodLabels: string[];
  rows: IEVerificationRow[];
  warnings: string[];
}
