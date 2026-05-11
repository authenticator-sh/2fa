# Installation Guide

## Quick Start

### 1. Build the Extension

The extension has already been built and is ready in the `dist/` folder. If you need to rebuild:

```bash
npm run build
```

### 2. Load in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `dist/` folder from this project

The extension icon should now appear in your Chrome toolbar!

### 3. Start Using

1. Click the extension icon in your toolbar
2. Click **Add Account**
3. Choose:
   - **Manual Entry**: Paste your TOTP secret key
   - **QR Code**: Upload a QR code image

Your authenticator codes will auto-refresh every 30 seconds!

## Features

- **Copy codes** - Click on any code to copy to clipboard
- **Search** - Find accounts quickly using the search bar
- **Backup** - Click Settings (⚙️) to export/import your accounts
- **Secure** - All data stays local in Chrome storage

## Improving Icons (Optional)

The extension currently uses placeholder icons. For better visuals:

1. Convert `public/icons/icon.svg` to PNG using:
   - [CloudConvert](https://cloudconvert.com/svg-to-png)
   - Or ImageMagick: `convert icon.svg -resize 128x128 icon128.png`

2. Save as `icon16.png`, `icon48.png`, `icon128.png` in `public/icons/`

3. Rebuild: `npm run build`

## Testing

Try adding a test account:
- **Name**: Test
- **Secret**: `JBSWY3DPEHPK3PXP`

This will generate valid TOTP codes you can verify!

## Troubleshooting

**Extension won't load?**
- Make sure you selected the `dist/` folder, not the project root
- Check Chrome console (F12) for errors

**Codes not updating?**
- Refresh the extension popup
- Check your system time is correct

**Lost your accounts?**
- Use Export/Import feature to backup regularly
- Data is stored locally in Chrome storage

## Development

To work on the extension:

```bash
npm run dev
```

Then reload the extension in Chrome after making changes.

Enjoy your new authenticator! 🔐
