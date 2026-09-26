import type { RendererPlugin, Theme } from '@treeix/sdk'

// Ids are what Settings stores, so the dark ones that shipped before the light pack keep their bare names
// syntax names a shiki theme for code and terminal colors; the rest use Pierre's
const themes: Record<string, Theme> = {
  // Vercel's Geist: black canvas, raised grays, their blue for actions
  vercel: { label: 'Vercel', mode: 'dark', background: '#000000', card: '#0a0a0a', popover: '#1a1a1a', foreground: '#ededed', mutedForeground: '#a1a1a1', primary: '#0070f3' },
  'vercel-light': { label: 'Vercel', mode: 'light', background: '#ffffff', card: '#fafafa', popover: '#ffffff', foreground: '#171717', mutedForeground: '#666666', primary: '#0070f3' },
  // claude.ai: warm paper and ink, the clay orange for actions
  'claude-light': { label: 'Claude', mode: 'light', background: '#faf9f5', card: '#f5f4ed', popover: '#ffffff', foreground: '#141413', mutedForeground: '#73726c', primary: '#c96442' },
  'claude-dark': { label: 'Claude', mode: 'dark', background: '#262624', card: '#1f1e1d', popover: '#30302e', foreground: '#faf9f5', mutedForeground: '#9c9a92', primary: '#d97757' },
  // macOS system colors: window and sidebar grays, system blue
  'apple-light': { label: 'Apple', mode: 'light', background: '#ffffff', card: '#f5f5f7', sidebar: '#ececee', popover: '#ffffff', foreground: '#1d1d1f', mutedForeground: '#86868b', primary: '#007aff' },
  'apple-dark': { label: 'Apple', mode: 'dark', background: '#1e1e1e', card: '#262628', sidebar: '#2b2b2e', popover: '#323234', foreground: '#f5f5f7', mutedForeground: '#98989d', primary: '#0a84ff' },
  // Xcode's Default Light and Default Dark editor themes
  'xcode-light': { label: 'Xcode', mode: 'light', background: '#ffffff', card: '#f7f7f7', popover: '#ffffff', foreground: '#1f1f24', mutedForeground: '#8a8a8e', primary: '#0f68a0' },
  'xcode-dark': { label: 'Xcode', mode: 'dark', background: '#292a30', card: '#1f1f24', popover: '#35363c', foreground: '#dfdfe0', mutedForeground: '#7f8c98', primary: '#3d8fd1' },
  // VS Code's Light Modern and Dark Modern
  'vscode-light': { label: 'VS Code', mode: 'light', background: '#ffffff', card: '#f8f8f8', popover: '#ffffff', foreground: '#3b3b3b', mutedForeground: '#767676', primary: '#005fb8', syntax: 'light-plus' },
  'vscode-dark': { label: 'VS Code', mode: 'dark', background: '#1f1f1f', card: '#181818', popover: '#2b2b2b', foreground: '#cccccc', mutedForeground: '#9d9d9d', primary: '#0078d4', syntax: 'dark-plus' },
  // GitHub's Primer light and dark default
  'github-light': { label: 'GitHub', mode: 'light', background: '#ffffff', card: '#f6f8fa', popover: '#ffffff', foreground: '#1f2328', mutedForeground: '#59636e', primary: '#0969da', syntax: 'github-light-default' },
  'github-dark': { label: 'GitHub', mode: 'dark', background: '#0d1117', card: '#151b23', popover: '#212830', foreground: '#f0f6fc', mutedForeground: '#9198a1', primary: '#4493f8', syntax: 'github-dark-default' },
  'solarized-light': { label: 'Solarized', mode: 'light', background: '#fdf6e3', card: '#eee8d5', popover: '#fdf6e3', foreground: '#073642', mutedForeground: '#657b83', primary: '#268bd2', syntax: 'solarized-light' },
  solarized: { label: 'Solarized', mode: 'dark', background: '#001e26', card: '#002b36', popover: '#073642', foreground: '#eee8d5', mutedForeground: '#839496', primary: '#268bd2', syntax: 'solarized-dark' },
  // Still black, one step up from Neutral
  onyx: { label: 'Onyx', mode: 'dark', background: '#0a0a0a', card: '#0a0a0a', popover: '#171717', foreground: '#f2f2f2', mutedForeground: '#8a8a8a', primary: '#4f5ff0' },
  // Two steps up: near black with a soft lift
  coal: { label: 'Coal', mode: 'dark', background: '#131313', card: '#131313', popover: '#1f1f1f', foreground: '#eeeeee', mutedForeground: '#8f8f8f', primary: '#4f5ff0' },
  midnight: { label: 'Midnight', mode: 'dark', background: '#0b0e14', card: '#10141c', popover: '#171c27', foreground: '#e6e9ef', mutedForeground: '#7f8898', primary: '#5b7cfa' },
  graphite: { label: 'Graphite', mode: 'dark', background: '#161616', card: '#1d1d1d', popover: '#262626', foreground: '#ededed', mutedForeground: '#909090', primary: '#10a37f' },
  nord: { label: 'Nord', mode: 'dark', background: '#242933', card: '#2e3440', popover: '#3b4252', foreground: '#eceff4', mutedForeground: '#9aa3b5', primary: '#5e81ac', syntax: 'nord' },
  dracula: { label: 'Dracula', mode: 'dark', background: '#1e1f29', card: '#282a36', popover: '#343746', foreground: '#f8f8f2', mutedForeground: '#8e92ad', primary: '#9d6ff0', syntax: 'dracula' }
}

const plugin: RendererPlugin = { themes }

export default plugin
