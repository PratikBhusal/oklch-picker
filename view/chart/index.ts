import { colordx } from '@colordx/core'

import { getCleanCtx, initCanvasSize } from '../../lib/canvas.ts'
import { build, inP3, inRGB, inRec2020 } from '../../lib/colors.ts'
import { getBorders } from '../../lib/dom.ts'
import { prepareWorkers } from '../../lib/workers.ts'
import { reportFreeze, reportPaint } from '../../stores/benchmark.ts'
import { current, onPaint, setCurrentComponents } from '../../stores/current.ts'
import { showCharts, showP3, showRec2020 } from '../../stores/settings.ts'
import type { BorderColor } from './paint.ts'
import type { PaintData, PaintedData } from './worker.ts'
import PaintWorker from './worker.ts?worker'

let chartL = document.querySelector<HTMLDivElement>('.chart.is-l')!
let chartC = document.querySelector<HTMLDivElement>('.chart.is-c')!
let chartH = document.querySelector<HTMLDivElement>('.chart.is-h')!
let canvasL = chartL.querySelector<HTMLCanvasElement>('.chart_canvas')!
let canvasC = chartC.querySelector<HTMLCanvasElement>('.chart_canvas')!
let canvasH = chartH.querySelector<HTMLCanvasElement>('.chart_canvas')!

function getMaxC(): number {
  return showRec2020.get() ? C_MAX_REC2020 : C_MAX
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(min, val), max)
}

onPaint({
  c(c) {
    document.body.style.setProperty('--chart-c', `${(100 * c) / getMaxC()}%`)
  },
  h(h) {
    document.body.style.setProperty('--chart-h', `${(100 * h) / H_MAX}%`)
  },
  l(l) {
    document.body.style.setProperty('--chart-l', `${(100 * l) / L_MAX}%`)
  }
})

function setComponentsFromSpace(
  space: HTMLCanvasElement,
  mouseX: number,
  mouseY: number
): void {
  let rect = space.getBoundingClientRect()
  let x = clamp(mouseX - rect.left, 0, rect.width)
  let y = clamp(rect.height - (mouseY - rect.top), 0, rect.height)
  if (space.parentElement!.classList.contains('is-l')) {
    setCurrentComponents({
      c: (getMaxC() * y) / rect.height,
      h: (H_MAX * x) / rect.width
    })
  } else if (space.parentElement!.classList.contains('is-c')) {
    setCurrentComponents({
      h: (H_MAX * x) / rect.width,
      l: (L_MAX * y) / rect.height
    })
  } else if (space.parentElement!.classList.contains('is-h')) {
    setCurrentComponents({
      c: (getMaxC() * y) / rect.height,
      l: (L_MAX * x) / rect.width
    })
  }
}

function initEvents(chart: HTMLCanvasElement): void {
  function onSelect(e: MouseEvent): void {
    e.preventDefault()
    setComponentsFromSpace(chart, e.clientX, e.clientY)
  }

  function onMouseUp(e: MouseEvent): void {
    document.removeEventListener('mousemove', onSelect)
    document.removeEventListener('mouseup', onMouseUp)
    setComponentsFromSpace(chart, e.clientX, e.clientY)
  }

  chart.addEventListener('mousedown', () => {
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('mousemove', onSelect)
  })
}

initEvents(canvasL)
initEvents(canvasC)
initEvents(canvasH)

const SEARCH_ITERATIONS = 50

/**
 * Binary search for the highest chroma in [0, c] that stays within the given
 * gamut at L and H.
 */
function maxChroma(
  inGamut: (color: ReturnType<typeof build>) => boolean,
  lightness: number,
  chroma: number,
  hue: number
): number {
  let lo = 0
  let hi = chroma
  for (let i = 0; i < SEARCH_ITERATIONS; i++) {
    let mid = (lo + hi) / 2
    if (inGamut(build(lightness, mid, hue))) {
      lo = mid
    } else {
      hi = mid
    }
  }
  return lo
}

/**
 * For a given hue, find the maximum in-gamut chroma and lightness combination.
 * Visually, this is peak of the lightness triangle.
 */
function findPeakGamut(
  inGamut: (color: ReturnType<typeof build>) => boolean,
  hue: number
): { chroma: number; lightness: number } {
  const cMax = getMaxC()
  let lo = 0
  let hi = L_MAX_COLOR
  for (let i = 0; i < SEARCH_ITERATIONS; i++) {
    let m1 = lo + (hi - lo) / 3
    let m2 = hi - (hi - lo) / 3
    if (maxChroma(inGamut, m1, cMax, hue) < maxChroma(inGamut, m2, cMax, hue)) {
      lo = m1
    } else {
      hi = m2
    }
  }
  const peakLightness = (lo + hi) / 2 / L_MAX_COLOR
  let peakChroma = maxChroma(inGamut, peakLightness * L_MAX_COLOR, cMax, hue)
  while (!inGamut(build(peakLightness * L_MAX_COLOR, peakChroma, hue))) {
    peakChroma -= 0.0001
  }
  console.log("Peak found:", { chroma: peakChroma, lightness: peakLightness });
  return { chroma: peakChroma, lightness: peakLightness }
}

function findPeakGamutInHueRange(
  inGamut: (color: ReturnType<typeof build>) => boolean,
  lightness: number,
  hMin: number,
  hMax: number
): { chroma: number; hue: number } {
  const cMax = getMaxC()
  let lo = hMin
  let hi = hMax
  for (let i = 0; i < SEARCH_ITERATIONS; i++) {
    let m1 = lo + (hi - lo) / 3
    let m2 = hi - (hi - lo) / 3
    if (maxChroma(inGamut, lightness, cMax, m1) < maxChroma(inGamut, lightness, cMax, m2)) {
      lo = m1
    } else {
      hi = m2
    }
  }
  const peakHue = (lo + hi) / 2
  let peakChroma = maxChroma(inGamut, lightness, cMax, peakHue)
  while (!inGamut(build(lightness, peakChroma, peakHue))) {
    peakChroma -= 0.0001
  }
  console.log("Peak found:", { chroma: peakChroma, hue: peakHue });
  return { chroma: peakChroma, hue: peakHue }
}

let peakButton = document.querySelector<HTMLButtonElement>('.is-l .card_peak')!

/**
 * Return the widest gamut enabled in settings. Falls back to sRGB.
 */
function getActiveGamut(): (color: ReturnType<typeof build>) => boolean {
  if (showRec2020.get()) return inRec2020
  if (showP3.get()) return inP3
  return inRGB
}

peakButton.addEventListener('click', () => {
  const { chroma, lightness } = findPeakGamut(getActiveGamut(), current.get().h)
  setCurrentComponents({ c: chroma, l: lightness })
})

let chromaPeakButton = document.querySelector<HTMLButtonElement>('.is-c .card_peak')!
let chromaPeakHmin = document.querySelector<HTMLInputElement>('.card_peak_hmin')!
let chromaPeakHmax = document.querySelector<HTMLInputElement>('.card_peak_hmax')!

function updateChromaPeakDisabled(): void {
  let hMin = parseFloat(chromaPeakHmin.value) || 0
  let hMax = parseFloat(chromaPeakHmax.value) || H_MAX
  chromaPeakButton.disabled = hMin >= hMax
}

chromaPeakHmin.addEventListener('input', updateChromaPeakDisabled)
chromaPeakHmax.addEventListener('input', updateChromaPeakDisabled)

chromaPeakButton.addEventListener('click', () => {
  let hMin = parseFloat(chromaPeakHmin.value) || 0
  let hMax = parseFloat(chromaPeakHmax.value) || H_MAX
  let { chroma, hue } = findPeakGamutInHueRange(
    getActiveGamut(),
    current.get().l * L_MAX_COLOR,
    hMin,
    hMax
  )
  setCurrentComponents({ c: chroma, h: hue })
})

let hueListButton = document.querySelector<HTMLButtonElement>('.card_hue_list_btn')!
let hueListHmin = document.querySelector<HTMLInputElement>('.card_hue_hmin')!
let hueListHmax = document.querySelector<HTMLInputElement>('.card_hue_hmax')!
let hueListLmin = document.querySelector<HTMLInputElement>('.card_hue_lmin')!
let hueListLmax = document.querySelector<HTMLInputElement>('.card_hue_lmax')!
let hueListCmin = document.querySelector<HTMLInputElement>('.card_hue_cmin')!
let hueListCmax = document.querySelector<HTMLInputElement>('.card_hue_cmax')!
let hueListOutput = document.querySelector<HTMLUListElement>('.card_hue_list_output')!
let hueListCopy = document.querySelector<HTMLButtonElement>('.card_hue_list_copy')!
let hueListOverflowNote = document.querySelector<HTMLParagraphElement>('.card_hue_list_overflow_note')!

function updateHueListDisabled(): void {
  let hMin = parseFloat(hueListHmin.value)
  let hMax = parseFloat(hueListHmax.value)
  let lMin = parseFloat(hueListLmin.value)
  let lMax = parseFloat(hueListLmax.value)
  let cMin = parseFloat(hueListCmin.value)
  let cMax = parseFloat(hueListCmax.value)
  hueListButton.disabled =
    (!isNaN(hMin) && !isNaN(hMax) && hMin >= hMax) ||
    (!isNaN(lMin) && !isNaN(lMax) && lMin > lMax) ||
    (!isNaN(cMin) && !isNaN(cMax) && cMin > cMax)
}

hueListHmin.addEventListener('input', updateHueListDisabled)
hueListHmax.addEventListener('input', updateHueListDisabled)
hueListLmin.addEventListener('input', updateHueListDisabled)
hueListLmax.addEventListener('input', updateHueListDisabled)
hueListCmin.addEventListener('input', updateHueListDisabled)
hueListCmax.addEventListener('input', updateHueListDisabled)

hueListCopy.addEventListener('click', () => {
  let lines = hueListResults.map(({ l, c, h }) => `oklch(${l} ${c} ${h})`)
  navigator.clipboard.writeText(lines.join('\n'))
  hueListCopy.classList.add('is-copied')
  setTimeout(() => hueListCopy.classList.remove('is-copied'), 500)
})

let hueListResults: { l: number; c: number; h: number  }[] = []

const MAX_DISPLAY_RESULTS = 10

function renderHueList(): void {
  hueListOutput.replaceChildren()
  hueListOutput.classList.toggle('has-results', hueListResults.length > 0)
  hueListCopy.classList.toggle('is-visible', hueListResults.length > 0)
  hueListOverflowNote.classList.toggle('is-visible', hueListResults.length > MAX_DISPLAY_RESULTS)
  for (let { l, c, h } of hueListResults.slice(0, MAX_DISPLAY_RESULTS)) {
    let li = document.createElement('li')
    li.textContent = `oklch(${l} ${c} ${h})`
    li.addEventListener('click', () => setCurrentComponents({ h, c, l }))
    hueListOutput.appendChild(li)
  }
}

hueListButton.addEventListener('click', () => {
  const hMin = parseFloat(hueListHmin.value) || 0
  const hMax = parseFloat(hueListHmax.value) || H_MAX
  const lMin = parseFloat(hueListLmin.value) || 0
  const lMax = parseFloat(hueListLmax.value) || 1
  const hasCRange = hueListCmin.value !== '' || hueListCmax.value !== ''
  const { c: currentC } = current.get()
  const cMin = hasCRange ? (parseFloat(hueListCmin.value) || 0) : currentC
  const cMax = hasCRange ? (parseFloat(hueListCmax.value) || C_MAX) : currentC
  const cStep = hasCRange ? 0.0001 : 1
  const gamut = getActiveGamut()
  hueListResults = []
  // Index-based to avoid floating-point drift from repeated += increments.
  for (let i = 0; ; i++) {
    const c = cMax - i * cStep
    if (c < (cMin - 1e-9)) break
    for (let j = 0; ; j++) {
      const l = lMin + j * 0.0001
      if (l > lMax + 1e-9) break
      for (let k = 0; ; k++) {
        const h = hMin + k * 0.01
        if (h > hMax + 1e-9) break
        if (gamut(build(l * L_MAX_COLOR, c, h))) {
          hueListResults.push({ l: parseFloat(l.toFixed(6)), c: parseFloat(c.toFixed(6)), h: parseFloat(h.toFixed(4)) });
        }
      }
    }
  }
  renderHueList()
})

let startWork = prepareWorkers<PaintData, PaintedData>(PaintWorker)

function parseBorderColor(css: string): BorderColor {
  let c = colordx(css).toRgb()
  return {
    alpha: c.alpha,
    b: c.b / 255,
    g: c.g / 255,
    r: c.r / 255
  }
}

function startWorkForComponent(
  canvas: HTMLCanvasElement,
  type: 'c' | 'h' | 'l',
  value: number,
  chartsToChange: number
): void {
  let [cssP3, cssRec2020] = getBorders()
  let borderP3 = parseBorderColor(cssP3)
  let borderRec2020 = parseBorderColor(cssRec2020)

  let parts: [ImageData, number][] = []
  startWork(
    type,
    chartsToChange,
    messages =>
      messages.map((_, i) => {
        let step = Math.floor(canvas.width / messages.length)
        let from = step * i + (i === 0 ? 0 : 1)
        let to = Math.min(step * (i + 1), canvas.width)
        if (i === messages.length - 1) to = canvas.width
        return {
          borderP3,
          borderRec2020,
          from,
          height: canvas.height,
          showP3: showP3.get(),
          showRec2020: showRec2020.get(),
          to,
          type,
          value,
          width: canvas.width
        }
      }),
    result => {
      reportFreeze(() => {
        parts.push([
          new ImageData(
            new Uint8ClampedArray(result.pixels),
            result.width,
            canvas.height
          ),
          result.from
        ])
      })
      reportPaint(result.time)
    },
    () => {
      reportFreeze(() => {
        let ctx = getCleanCtx(canvas)
        for (let [image, from] of parts) {
          ctx.putImageData(image, from, 0)
        }
      })
    }
  )
}

function initCharts(): void {
  initCanvasSize(canvasL)
  initCanvasSize(canvasC)
  initCanvasSize(canvasH)

  onPaint({
    c(c, chartsToChange) {
      if (!showCharts.get()) return
      startWorkForComponent(canvasC, 'c', c, chartsToChange)
    },
    h(h, chartsToChange) {
      if (!showCharts.get()) return
      startWorkForComponent(canvasH, 'h', h, chartsToChange)
    },
    l(l, chartsToChange) {
      if (!showCharts.get()) return
      startWorkForComponent(canvasL, 'l', l, chartsToChange)
    }
  })
}

if (showCharts.get()) {
  initCharts()
} else {
  let unbindCharts = showCharts.listen(show => {
    if (show) {
      unbindCharts()
      initCharts()
    }
  })
}
