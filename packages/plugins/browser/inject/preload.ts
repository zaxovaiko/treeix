import { watchVitals } from './vitals'

// Sandboxed preload of every page in the built-in browser; design mode and web vitals register here
window.addEventListener('DOMContentLoaded', watchVitals, { once: true })
