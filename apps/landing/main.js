// Plays the review loop demo while it is on screen and highlights the step it is showing
const stage = document.querySelector('.stage')
const steps = [...document.querySelectorAll('.steps li')]
const LOOP_MS = 9000
const STEP_STARTS = [0, 0.12, 0.54] // matches the keyframe percentages in styles.css
let startedAt = 0
let timer = 0

const highlight = () => {
  const progress = ((performance.now() - startedAt) % LOOP_MS) / LOOP_MS
  const current = STEP_STARTS.findLastIndex((start) => progress >= start)
  steps.forEach((step, index) => step.classList.toggle('active', index === current))
}

new IntersectionObserver(([entry]) => {
  if (entry.isIntersecting && !stage.classList.contains('playing')) {
    stage.classList.add('playing')
    startedAt = performance.now()
    timer = setInterval(highlight, 150)
  } else if (!entry.isIntersecting && stage.classList.contains('playing')) {
    stage.classList.remove('playing')
    clearInterval(timer)
  }
}, { threshold: 0.4 }).observe(stage)
