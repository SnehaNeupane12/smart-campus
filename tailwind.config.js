
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        baby: {
          50: "#fff1f3",
          100: "#ffe4e9",
          200: "#fecdd3",
          300: "#fda4af",
          400: "#fb7185",
          500: "#f43f5e",
        },
      },
      boxShadow: {
        soft: "0 10px 25px rgba(244,63,94,0.08)"
      }
    },
  },
  plugins: [],
}
