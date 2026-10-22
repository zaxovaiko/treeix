import { mergeConfig } from 'vite'
import base from '../vite.config'

// The app's config without file watching: a source edit mid-run would reload the page under a test
export default mergeConfig(base, { server: { hmr: false, watch: null } })
