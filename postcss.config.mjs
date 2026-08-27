// ABOUTME: Runs Tailwind CSS v4 through PostCSS for the OPAS application styles.
// ABOUTME: Keeps the styling pipeline identical across local and hosted builds.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
