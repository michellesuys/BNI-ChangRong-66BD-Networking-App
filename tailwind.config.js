/** @type {import('tailwindcss').Config} */
module.exports = {
  // 掃描所有 HTML 與 JS，自動找出實際使用的 class（包括 text-[2.5rem] 等任意值）
  content: [
    './public/**/*.html',
    './public/**/*.js',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
  // 不要 purge bg-red-50/40 這種斜線 alpha 值（v3 預設已支援）
};
