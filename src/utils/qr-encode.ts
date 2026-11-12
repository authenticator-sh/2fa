// Drawing a QR code: the share link on the Share screen, and an account's
// otpauth:// URL in the overlay that moves it to another app.
//
// The encoder is loaded on demand for the same reason jsQR is: it is needed
// only once someone asks for a code, and the popup should not parse it on
// every open to be ready for that.
//
// The result is a path, not a bitmap. Rendered as an inline SVG it scales to
// whatever the modal has room for without ever blurring a module, and it
// inherits the colour of the text around it — so it draws in dark mode without
// a second image.

export interface QRDrawing {
  /** Modules per side, before the quiet zone. */
  size: number;
  /** One unit square per dark module, in module coordinates. */
  path: string;
}

/**
 * Every payload is pure ASCII, so byte mode carries it without the encoder's
 * UTF-8 helper: the share page's link is base64url, and an otpauth:// URL
 * comes from buildOTPAuthURL, which percent-encodes the label and every
 * parameter.
 *
 * Level M rather than L: the link is read from a screen, where moiré and a
 * camera that cannot quite focus cost more than the ten percent of modules the
 * extra correction adds — an hour of codes stays inside version 18 either way.
 */
export async function drawQR(text: string): Promise<QRDrawing> {
  const { default: qrcode } = await import('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();

  const size = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
    }
  }
  return { size, path };
}
