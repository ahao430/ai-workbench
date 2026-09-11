/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  // preflight 关闭：基础样式重置交给 antd，避免与 antd 组件默认样式冲突
  corePlugins: {
    preflight: false,
  },
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
}
