/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Reskin Phase 0 — dark-glass theme (the `adversaria-samples` prototype).
        // The whole app is themed from this one ramp: components use HIGH gray
        // numbers for surfaces (gray-950/900/800) and LOW numbers for text
        // (gray-100/200/300), so we map the ramp light→dark (50 = near-white,
        // 950 = app canvas). The CSS custom properties in src/index.css `:root`
        // mirror these exact values; see docs/SPEC_RESKIN.md §1.
        gray: {
          50: "#fafafa", // near-white (rare)
          100: "#f4f4f5", // primary text / headings           (--text-primary)
          200: "#e4e4e7", // body text
          300: "#a1a1aa", // secondary text                    (--text-secondary)
          400: "#71717a", // muted text (meta, labels)
          500: "#52525b", // faint text (placeholders, counts) (--text-muted)
          600: "#3f3f46", // very faint (dots, chevrons)
          700: "#27272a", // strong borders
          800: "#1a1a1f", // raised surfaces, buttons, borders (--bg-tertiary)
          900: "#121215", // cards / panels                    (--bg-secondary)
          950: "#09090b", // app canvas                        (--bg-primary)
        },
        // Apple system accents — additive named tokens for later reskin phases.
        // The existing default blue/red/green/amber utilities are left untouched.
        accent: {
          blue: "#007aff",
          purple: "#af52de",
          green: "#34c759",
          amber: "#ff9500",
          red: "#ff3b30",
        },
        glass: "rgba(18, 18, 21, 0.75)", // --bg-glass (pair with backdrop-blur-glass)
        hairline: "rgba(255, 255, 255, 0.08)", // --border-color
      },
      fontFamily: {
        // Inter self-hosted via @fontsource-variable/inter (bundled; no CDN call).
        sans: ['"Inter Variable"', "Inter", "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto", "sans-serif"],
        serif: ['"Instrument Serif"', "Georgia", "serif"],
      },
      backdropBlur: {
        glass: "20px",
      },
    },
  },
  plugins: [],
};
