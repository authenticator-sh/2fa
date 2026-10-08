// Colours the two styles disagree on are CSS variables (src/styles/globals.css):
// the classic values sit on :root, the other style redefines them under its
// class. Channels rather than hex so opacity modifiers (`/20`) keep working.
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const scale = (name, steps) => Object.fromEntries(steps.map((step) => [step, token(`${name}-${step}`)]));
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./src/popup/index.html",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
        },
        gray: scale('gray', STEPS),
        neutral: scale('neutral', STEPS),
        dark: scale('dark', STEPS.slice(0, -1)),
        /** The blue of buttons, links and codes: Google's in the classic style. */
        accent: scale('accent', [50, 300, 400, 500, 600, 700]),
        /** A switch that is on. */
        switch: token('switch-on'),
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      animation: {
        'spin-slow': 'spin 3s linear infinite',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
}
