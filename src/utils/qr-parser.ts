import { parseMigrationURL, type MigrationAccount } from './migration-parser';

export interface ParsedOTPAuth {
  name: string;
  issuer: string;
  secret: string;
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: 6 | 8;
  period: number;
}

export interface ParsedQRResult {
  type: 'single' | 'migration';
  accounts: ParsedOTPAuth[];
}

export function parseOTPAuthURL(url: string): ParsedOTPAuth | null {
  try {
    // Never log the URL itself — it carries ?secret=.

    // Trim whitespace and check if it starts with otpauth://
    const trimmedUrl = url.trim();

    if (!trimmedUrl.startsWith('otpauth://')) {
      console.error('URL does not start with otpauth://', trimmedUrl);
      return null;
    }

    // Support both totp and hotp (treat hotp as totp)
    if (!trimmedUrl.startsWith('otpauth://totp/') && !trimmedUrl.startsWith('otpauth://hotp/')) {
      console.error('URL is not totp or hotp:', trimmedUrl);
      return null;
    }

    const urlObj = new URL(trimmedUrl);
    const params = urlObj.searchParams;

    const secret = params.get('secret');
    if (!secret) {
      console.error('No secret found in URL');
      return null;
    }

    // Parse the path: can be "Issuer:Account" or just "Account"
    const pathParts = decodeURIComponent(urlObj.pathname.substring(1)).split(':');
    const issuer = params.get('issuer') || (pathParts.length > 1 ? pathParts[0] : 'Unknown');
    const name = pathParts.length > 1 ? pathParts[1] : (pathParts[0] || 'Account');

    const algorithmParam = (params.get('algorithm') || 'SHA1').toUpperCase();
    const algorithm = (['SHA1', 'SHA256', 'SHA512'].includes(algorithmParam) ? algorithmParam : 'SHA1') as 'SHA1' | 'SHA256' | 'SHA512';

    const digitsParam = parseInt(params.get('digits') || '6');
    const digits = (digitsParam === 8 ? 8 : 6) as 6 | 8;

    const period = parseInt(params.get('period') || '30');

    console.log('Successfully parsed:', { name, issuer, algorithm, digits, period });

    return {
      name,
      issuer,
      secret,
      algorithm,
      digits,
      period,
    };
  } catch (error) {
    console.error('Error parsing OTP Auth URL:', error);
    return null;
  }
}

/**
 * Parses any QR code URL - either standard otpauth:// or migration otpauth-migration://
 * Returns a result object indicating the type and containing parsed account(s)
 */
export function parseQRCode(url: string): ParsedQRResult | null {
  try {
    const trimmedUrl = url.trim();

    // Check if it's a migration URL
    if (trimmedUrl.startsWith('otpauth-migration://')) {
      console.log('Detected migration URL');
      const migrationAccounts = parseMigrationURL(trimmedUrl);

      if (!migrationAccounts || migrationAccounts.length === 0) {
        console.error('Failed to parse migration URL');
        return null;
      }

      // Convert MigrationAccount to ParsedOTPAuth
      const accounts: ParsedOTPAuth[] = migrationAccounts.map((account: MigrationAccount) => ({
        name: account.name,
        issuer: account.issuer,
        secret: account.secret,
        algorithm: account.algorithm,
        digits: account.digits,
        period: 30, // Google Authenticator uses 30 seconds by default
      }));

      console.log(`Parsed ${accounts.length} account(s) from a migration QR`);

      return {
        type: 'migration',
        accounts,
      };
    }

    // Try parsing as standard otpauth:// URL
    if (trimmedUrl.startsWith('otpauth://')) {
      console.log('Detected standard otpauth URL');
      const parsed = parseOTPAuthURL(trimmedUrl);

      if (!parsed) {
        console.error('Failed to parse otpauth URL');
        return null;
      }

      return {
        type: 'single',
        accounts: [parsed],
      };
    }

    console.error('Unknown QR code format:', trimmedUrl.substring(0, 50));
    return null;
  } catch (error) {
    console.error('Error in parseQRCode:', error);
    return null;
  }
}

export function generateRandomColor(): string {
  const colors = [
    '#3b82f6', // blue
    '#8b5cf6', // violet
    '#ec4899', // pink
    '#f59e0b', // amber
    '#10b981', // emerald
    '#06b6d4', // cyan
    '#f97316', // orange
    '#6366f1', // indigo
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}
