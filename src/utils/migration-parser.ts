/**
 * Google Authenticator Migration Parser
 * Parses otpauth-migration:// URLs that contain protobuf-encoded account data
 */

export interface MigrationAccount {
  secret: string;
  name: string;
  issuer: string;
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: 6 | 8;
  type: 'totp' | 'hotp';
  counter?: number;
}

// Protobuf wire types
const WIRE_TYPE_VARINT = 0;
const WIRE_TYPE_LENGTH_DELIMITED = 2;

/**
 * Decodes a varint from protobuf data
 */
function decodeVarint(buffer: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let currentOffset = offset;

  while (currentOffset < buffer.length) {
    const byte = buffer[currentOffset++];
    value |= (byte & 0x7f) << shift;

    if ((byte & 0x80) === 0) {
      return { value, offset: currentOffset };
    }

    shift += 7;
  }

  throw new Error('Invalid varint encoding');
}

/**
 * Reads a length-delimited field from protobuf data
 */
function readLengthDelimited(buffer: Uint8Array, offset: number): { data: Uint8Array; offset: number } {
  const { value: length, offset: newOffset } = decodeVarint(buffer, offset);
  const data = buffer.slice(newOffset, newOffset + length);
  return { data, offset: newOffset + length };
}

/**
 * Converts bytes to base32 string (for TOTP secrets)
 */
function bytesToBase32(bytes: Uint8Array): string {
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;

    while (bits >= 5) {
      output += base32Chars[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += base32Chars[(value << (5 - bits)) & 31];
  }

  // Add padding
  while (output.length % 8 !== 0) {
    output += '=';
  }

  return output;
}

/**
 * Parses a single OtpParameters message from protobuf
 */
function parseOtpParameters(buffer: Uint8Array): MigrationAccount {
  let offset = 0;
  let secret: Uint8Array | null = null;
  let name = '';
  let issuer = '';
  let algorithm: 'SHA1' | 'SHA256' | 'SHA512' = 'SHA1';
  let digits: 6 | 8 = 6;
  let type: 'totp' | 'hotp' = 'totp';
  let counter: number | undefined;

  while (offset < buffer.length) {
    // Read field tag
    const { value: tag, offset: tagOffset } = decodeVarint(buffer, offset);
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    offset = tagOffset;

    if (wireType === WIRE_TYPE_LENGTH_DELIMITED) {
      const { data, offset: newOffset } = readLengthDelimited(buffer, offset);
      offset = newOffset;

      switch (fieldNumber) {
        case 1: // secret (bytes)
          secret = data;
          break;
        case 2: // name (string)
          name = new TextDecoder().decode(data);
          break;
        case 3: // issuer (string)
          issuer = new TextDecoder().decode(data);
          break;
      }
    } else if (wireType === WIRE_TYPE_VARINT) {
      const { value, offset: newOffset } = decodeVarint(buffer, offset);
      offset = newOffset;

      switch (fieldNumber) {
        case 4: // algorithm (enum)
          switch (value) {
            case 1:
              algorithm = 'SHA1';
              break;
            case 2:
              algorithm = 'SHA256';
              break;
            case 3:
              algorithm = 'SHA512';
              break;
          }
          break;
        case 5: // digits (enum)
          digits = value === 2 ? 8 : 6;
          break;
        case 6: // type (enum)
          type = value === 1 ? 'hotp' : 'totp';
          break;
        case 7: // counter (int64)
          counter = value;
          break;
      }
    } else {
      // Skip unknown field types
      throw new Error(`Unsupported wire type: ${wireType}`);
    }
  }

  if (!secret) {
    throw new Error('Missing secret in OtpParameters');
  }

  return {
    secret: bytesToBase32(secret),
    name: name || 'Unknown',
    issuer: issuer || name || 'Unknown',
    algorithm,
    digits,
    type,
    counter,
  };
}

/**
 * Parses Google Authenticator migration data from otpauth-migration:// URL
 */
export function parseMigrationURL(url: string): MigrationAccount[] | null {
  try {
    console.log('Parsing migration URL:', url);

    // Check if it's a migration URL
    if (!url.startsWith('otpauth-migration://')) {
      console.error('Not a migration URL');
      return null;
    }

    // Extract the data parameter
    const urlObj = new URL(url);
    const dataParam = urlObj.searchParams.get('data');

    if (!dataParam) {
      console.error('No data parameter found in migration URL');
      return null;
    }

    // Decode base64 data
    const binaryString = atob(dataParam);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    console.log('Decoded migration data length:', bytes.length);

    // Parse MigrationPayload protobuf message
    const accounts: MigrationAccount[] = [];
    let offset = 0;

    while (offset < bytes.length) {
      const { value: tag, offset: tagOffset } = decodeVarint(bytes, offset);
      const fieldNumber = tag >>> 3;
      const wireType = tag & 0x7;

      offset = tagOffset;

      if (fieldNumber === 1 && wireType === WIRE_TYPE_LENGTH_DELIMITED) {
        // This is an otp_parameters field
        const { data, offset: newOffset } = readLengthDelimited(bytes, offset);
        offset = newOffset;

        const account = parseOtpParameters(data);
        accounts.push(account);
      } else if (wireType === WIRE_TYPE_VARINT) {
        // Skip metadata fields (version, batch_size, etc.)
        const { offset: newOffset } = decodeVarint(bytes, offset);
        offset = newOffset;
      } else {
        // Skip unknown fields
        break;
      }
    }

    console.log('Parsed migration accounts:', accounts);
    return accounts.length > 0 ? accounts : null;
  } catch (error) {
    console.error('Error parsing migration URL:', error);
    return null;
  }
}
