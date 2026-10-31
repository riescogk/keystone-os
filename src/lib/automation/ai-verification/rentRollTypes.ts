import type {
  AIVerificationConfidence,
  AIVerificationEvidence,
} from "./types";

export interface RentRollVerificationUnit {
  unit: string;
  unitType: string | null;
  sqft: number | string | null;
  unitCategory: string | null;
  residentName: string | null;
  marketRent: number | string | null;
  chargeCodes: string[] | string | null;
  rentAmount: number | string | null;
  evidence?: AIVerificationEvidence[];
  explanation?: string;
  confidence?: AIVerificationConfidence;
}

export interface RentRollVerificationDocument {
  propertyName: string | null;
  asOfDate: string | null;
  expectedUnitCount: number | null;
  units: RentRollVerificationUnit[];
  warnings: string[];
}
