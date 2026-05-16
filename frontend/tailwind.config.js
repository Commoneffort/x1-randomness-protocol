/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Light theme
        background: '#fafafa',
        surface: '#ffffff',
        'surface-elevated': '#f5f5f5',
        'surface-hover': '#eeeeee',
        // Brand
        primary: '#2563eb',
        'primary-hover': '#1d4ed8',
        'primary-dark': '#1e40af',
        // Status
        success: '#16a34a',
        warning: '#d97706',
        error: '#dc2626',
        info: '#2563eb',
        // Text
        'text-primary': '#1a1a1a',
        'text-secondary': '#555555',
        'text-muted': '#888888',
        // Borders
        border: '#e0e0e0',
        'border-hover': '#cccccc',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin 3s linear infinite',
      },
    },
  },
  plugins: [],
};