/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx,html}",
  ],
  theme: {
    extend: {
      colors: {
        // Primary — logo red-orange and campfire/sunset amber
        brand: {
          red: "#E8491D",
          amber: "#F2A93B",
        },
        // Secondary — grassland green, overworld sky blue
        pal: {
          green: "#4A9D7C",
          blue: "#5B9BD5",
        },
        // Neutrals — dark UI base, warm parchment surface
        ink: {
          DEFAULT: "#2B2420",
          light: "#3D342D",
        },
        paper: "#F5EDE1",
        // Accent — rarity/legendary highlight
        legendary: "#8B3A9E",
      },
      fontFamily: {
        display: ["Baloo 2", "sans-serif"],
        body: ["Manrope", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};
