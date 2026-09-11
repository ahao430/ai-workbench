/**
 * 由 scripts/gen-mweb-themes.cjs 生成（来源 github.com/imageslr/mweb-themes），勿手改。
 * 每个主题作用域在 .md-body.t-<key>；代码高亮为 Prism 配色桥接到 .hljs-*（平台用 highlight.js）。
 */

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
export interface MwebThemeMeta {
  key: string
  label: string
  dark: boolean
  /** 页面底色（深色主题给宿主容器 / PNG 导出用） */
  pageBg?: string
}

export const MWEB_THEMES: MwebThemeMeta[] = [
  {
    "key": "ayu",
    "label": "Ayu",
    "dark": false,
    "pageBg": "rgb(250, 250, 250)"
  },
  {
    "key": "ayu-mirage",
    "label": "Ayu Mirage",
    "dark": true,
    "pageBg": "rgb(31, 35, 47)"
  },
  {
    "key": "bear-default",
    "label": "Bear Default",
    "dark": false,
    "pageBg": "white"
  },
  {
    "key": "charcoal",
    "label": "Charcoal",
    "dark": true,
    "pageBg": "rgb(46, 50, 53)"
  },
  {
    "key": "cobalt",
    "label": "Cobalt",
    "dark": true,
    "pageBg": "rgb(20, 39, 56)"
  },
  {
    "key": "contrast",
    "label": "Contrast",
    "dark": false,
    "pageBg": "#F9F9F9"
  },
  {
    "key": "d-boring",
    "label": "D Boring",
    "dark": false,
    "pageBg": "rgb(251, 250, 252)"
  },
  {
    "key": "dark-graphite",
    "label": "Dark Graphite",
    "dark": true,
    "pageBg": "rgb(30, 32, 34)"
  },
  {
    "key": "mweb-default",
    "label": "Default",
    "dark": false,
    "pageBg": "white"
  },
  {
    "key": "dieci",
    "label": "Dieci",
    "dark": true,
    "pageBg": "rgb(0, 0, 0)"
  },
  {
    "key": "dracula",
    "label": "Dracula",
    "dark": true,
    "pageBg": "rgb(53, 56, 70)"
  },
  {
    "key": "duotone-heat",
    "label": "Duotone Heat",
    "dark": false,
    "pageBg": "rgb(251, 250, 249)"
  },
  {
    "key": "duotone-light",
    "label": "Duotone Light",
    "dark": false,
    "pageBg": "rgb(250, 248, 245)"
  },
  {
    "key": "gandalf",
    "label": "Gandalf",
    "dark": false,
    "pageBg": "rgb(240, 240, 240)"
  },
  {
    "key": "gotham",
    "label": "Gotham",
    "dark": true,
    "pageBg": "rgb(17, 21, 28)"
  },
  {
    "key": "indigo",
    "label": "Indigo",
    "dark": false
  },
  {
    "key": "jzman",
    "label": "Jzman",
    "dark": false
  },
  {
    "key": "lighthouse",
    "label": "Lighthouse",
    "dark": true,
    "pageBg": "rgb(24, 24, 30)"
  },
  {
    "key": "lark",
    "label": "Lark",
    "dark": false,
    "pageBg": "white"
  },
  {
    "key": "lark-bold-color",
    "label": "Lark Bold Color",
    "dark": false,
    "pageBg": "white"
  },
  {
    "key": "nord",
    "label": "Nord",
    "dark": true,
    "pageBg": "rgb(47, 52, 64)"
  },
  {
    "key": "olive-dunk",
    "label": "Olive Dunk",
    "dark": false,
    "pageBg": "rgb(251, 250, 240)"
  },
  {
    "key": "panic",
    "label": "Panic",
    "dark": true,
    "pageBg": "rgb(17, 28, 42)"
  },
  {
    "key": "red-graphite",
    "label": "Red Graphite",
    "dark": false,
    "pageBg": "#fcfcfc"
  },
  {
    "key": "smartblue",
    "label": "Smartblue",
    "dark": false
  },
  {
    "key": "solarized-dark",
    "label": "Solarized Dark",
    "dark": true,
    "pageBg": "rgb(11, 55, 66)"
  },
  {
    "key": "solarized-light",
    "label": "Solarized Light",
    "dark": false,
    "pageBg": "rgb(253, 246, 227)"
  },
  {
    "key": "toothpaste",
    "label": "Toothpaste",
    "dark": true,
    "pageBg": "rgb(34, 46, 51)"
  },
  {
    "key": "typo",
    "label": "Typo",
    "dark": false
  },
  {
    "key": "v-green",
    "label": "V Green",
    "dark": false
  },
  {
    "key": "vue",
    "label": "Vue",
    "dark": false
  }
]
