import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: {
    commonjsOptions: {
      strictRequires: ["node_modules/aws-sdk/**/*.js"],
    },
  },
});
