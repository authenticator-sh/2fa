export interface Account {
  id: string;
  name: string;
  issuer: string;
  secret: string;
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: 6 | 8;
  period: number;
  createdAt: number;
  color?: string;
}

export interface TOTPCode {
  code: string;
  remaining: number;
  period: number;
}

export type SortOrder = 'name-asc' | 'name-desc' | 'date-asc' | 'date-desc';
