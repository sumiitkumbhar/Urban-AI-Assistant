/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: { 50: '#eff6ff', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8' },
        background: 'var(--bg)',
        foreground: 'var(--text)',
        border: 'var(--border)',
        primary: { DEFAULT: 'var(--primary)', light: 'var(--primary-light)' },
        success: 'var(--success)',
        warning: 'var(--warning)',
        error: 'var(--error)',
        muted: 'var(--text-muted)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      // Shadows are tinted to the paper hue rather than pure black. A neutral
      // black shadow on a warm ground reads as grey dirt; the warm tint reads
      // as light falling on paper.
      boxShadow: {
        glass: '0 8px 32px 0 rgba(0,0,0,0.37)',
        custom: 'var(--shadow)',
        light: 'var(--shadow-light)',
        'paper-xs': '0 1px 2px 0 rgb(61 52 38 / 0.06)',
        'paper-sm': '0 2px 8px -2px rgb(61 52 38 / 0.09)',
        'paper-md': '0 10px 28px -10px rgb(61 52 38 / 0.14)',
        'paper-lg': '0 28px 56px -20px rgb(61 52 38 / 0.18)',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-conic': 'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
      },
      transitionTimingFunction: {
        // Slight overshoot-free ease with a long tail - movement that settles
        // rather than stops. Used for every entrance in the app.
        settle: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-in-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        shimmer: 'shimmer 2.2s linear infinite',
        'rise-in': 'riseIn 520ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'breathe': 'breathe 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: { '0%': { transform: 'translateY(20px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } },
        shimmer: {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        // transform + opacity only - compositor-friendly, no layout work.
        riseIn: {
          '0%': { opacity: '0', transform: 'translate3d(0, 10px, 0) scale(0.995)' },
          '100%': { opacity: '1', transform: 'translate3d(0, 0, 0) scale(1)' },
        },
        breathe: {
          '0%, 100%': { opacity: '0.35', transform: 'scale(0.94)' },
          '50%': { opacity: '1', transform: 'scale(1)' },
        },
      },
      backdropBlur: { xs: '2px' },
    },
  },
  plugins: [],
};
